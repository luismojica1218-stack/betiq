"""
BetIQ — FastAPI Router: Football
Endpoints: scrape fixtures/stats/odds per league, train, predict, matches, predictions
"""
import asyncio
import json
import uuid
from datetime import datetime, timezone
from typing import AsyncGenerator, Optional

from fastapi import APIRouter, BackgroundTasks, HTTPException, Query
from fastapi.responses import StreamingResponse

from scrapers.football_scraper import run_football_stats_scrape, run_football_odds_scrape
from models.football_model import get_football_predictor
from services.supabase_client import get_supabase
from constants import FOOTBALL_LEAGUES

router = APIRouter()

_scraping_queues: dict[str, asyncio.Queue] = {}
VALID_LEAGUES = list(FOOTBALL_LEAGUES.keys())


async def _sse_generator(queue: asyncio.Queue, session_id: str) -> AsyncGenerator[str, None]:
    yield f"data: {json.dumps({'type': 'connected', 'session_id': session_id})}\n\n"
    try:
        while True:
            try:
                item = await asyncio.wait_for(queue.get(), timeout=90.0)
                yield f"data: {json.dumps(item)}\n\n"
                if item.get("type") == "done":
                    break
            except asyncio.TimeoutError:
                yield f"data: {json.dumps({'type': 'heartbeat'})}\n\n"
    finally:
        _scraping_queues.pop(session_id, None)


# ---- Stats scraping ----------------------------------------------------------

async def _run_football_stats_bg(session_id: str, league_key: str):
    queue = _scraping_queues.get(session_id)
    if not queue:
        return
    try:
        result  = await run_football_stats_scrape(league_key, queue)
        supabase = get_supabase()
        fixtures = result.get("fixtures", [])
        saved    = 0

        for fx in fixtures:
            home_name = fx.get("home_team", "")
            away_name = fx.get("away_team", "")
            if not (home_name and away_name):
                continue
            try:
                for name in [home_name, away_name]:
                    supabase.table("teams").upsert(
                        {"name": name, "sport": "football", "league": fx.get("league", "")},
                        on_conflict="name,sport"
                    ).execute()
                home_res = supabase.table("teams").select("id").eq("name", home_name).eq("sport", "football").execute()
                away_res = supabase.table("teams").select("id").eq("name", away_name).eq("sport", "football").execute()
                if home_res.data and away_res.data:
                    try:
                        supabase.table("matches").insert({
                            "sport":        "football",
                            "league":       fx.get("league", ""),
                            "season":       fx.get("season", "2025-26"),
                            "home_team_id": home_res.data[0]["id"],
                            "away_team_id": away_res.data[0]["id"],
                            "match_date":   fx.get("match_date"),
                            "status":       "scheduled",
                            "scraped_at":   datetime.now(timezone.utc).isoformat(),
                        }).execute()
                        saved += 1
                    except Exception:
                        pass  # Duplicate — unique index rejects it
            except Exception:
                pass

        # Save team stats to Supabase (stats_json column) so ML model can use real data
        team_stats = result.get("team_stats", {})
        stats_saved = 0
        scraped_ts = datetime.now(timezone.utc).isoformat()
        for team_name, ts in team_stats.items():
            try:
                supabase.table("teams").upsert(
                    {"name": team_name, "sport": "football", "league": league_key},
                    on_conflict="name,sport"
                ).execute()
                team_res = supabase.table("teams").select("id").eq("name", team_name).eq("sport", "football").execute()
                if team_res.data:
                    clean_ts = {k: v for k, v in ts.items() if not k.startswith("_")}
                    supabase.table("team_stats").insert({
                        "team_id":   team_res.data[0]["id"],
                        "stats_json": clean_ts,
                        "source_url": "sofascore",
                        "scraped_at": scraped_ts,
                    }).execute()
                    stats_saved += 1
            except Exception:
                pass

        await queue.put({
            "type":    "done",
            "message": f"✅ {league_key}: {saved} partidos, {stats_saved} equipos con stats (SofaScore)",
            "result":  {"fixtures_count": saved, "teams_count": stats_saved},
        })
    except Exception as e:
        if queue:
            await queue.put({"type": "error", "message": f"❌ Error: {str(e)}"})
            await queue.put({"type": "done", "message": "Proceso terminado con errores"})


@router.post("/scrape/stats")
async def scrape_football_stats(
    league_key: str = Query("premier-league", enum=VALID_LEAGUES),
    background_tasks: BackgroundTasks = BackgroundTasks(),
):
    session_id = str(uuid.uuid4())
    queue: asyncio.Queue = asyncio.Queue()
    _scraping_queues[session_id] = queue
    background_tasks.add_task(_run_football_stats_bg, session_id, league_key)
    return {"session_id": session_id, "league": league_key, "message": "Football stats scraping iniciado"}


@router.get("/scrape/stats/stream/{session_id}")
async def stream_football_stats(session_id: str):
    queue = _scraping_queues.get(session_id)
    if not queue:
        raise HTTPException(404, "Session not found")
    return StreamingResponse(
        _sse_generator(queue, session_id),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"},
    )


# ---- Odds scraping -----------------------------------------------------------

async def _run_odds_bg(session_id: str, source: str):
    queue = _scraping_queues.get(session_id)
    if not queue:
        return
    try:
        result   = await run_football_odds_scrape(source, queue)
        odds     = result.get("odds", [])
        supabase = get_supabase()
        saved    = 0
        scraped_at = datetime.now(timezone.utc).isoformat()

        for odd in odds:
            try:
                home_name = odd.get("home_team", "")
                away_name = odd.get("away_team", "")
                if not (home_name and away_name):
                    continue

                # Upsert teams
                for name in [home_name, away_name]:
                    supabase.table("teams").upsert(
                        {"name": name, "sport": "football"},
                        on_conflict="name,sport"
                    ).execute()

                # Lookup team IDs
                home_r = supabase.table("teams").select("id").eq("name", home_name).eq("sport", "football").execute()
                away_r = supabase.table("teams").select("id").eq("name", away_name).eq("sport", "football").execute()
                if not (home_r.data and away_r.data):
                    continue

                home_id = home_r.data[0]["id"]
                away_id = away_r.data[0]["id"]

                # Find or create match
                match_r = supabase.table("matches").select("id").eq("home_team_id", home_id).eq("away_team_id", away_id).eq("sport", "football").gte("match_date", datetime.now(timezone.utc).isoformat()).limit(1).execute()
                if match_r.data:
                    match_id = match_r.data[0]["id"]
                else:
                    from datetime import timedelta
                    new_match = supabase.table("matches").insert({
                        "sport":        "football",
                        "home_team_id": home_id,
                        "away_team_id": away_id,
                        "match_date":   (datetime.now(timezone.utc) + timedelta(days=3)).isoformat(),
                        "status":       "scheduled",
                        "scraped_at":   scraped_at,
                    }).execute()
                    if not new_match.data:
                        continue
                    match_id = new_match.data[0]["id"]

                # Save all markets — delete stale before inserting fresh
                markets = [
                    ("1X2", "home", odd.get("ml_home") or odd.get("home_win_odd")),
                    ("1X2", "draw", odd.get("draw_odd")),
                    ("1X2", "away", odd.get("ml_away") or odd.get("away_win_odd")),
                ]
                for market, selection, odd_val in markets:
                    if odd_val is not None:
                        try:
                            # Remove stale odds first
                            supabase.table("odds").delete().eq(
                                "match_id", match_id
                            ).eq("market", market).eq("selection", selection).execute()
                            supabase.table("odds").insert({
                                "match_id":   match_id,
                                "bookmaker":  odd.get("bookmaker", source),
                                "market":     market,
                                "selection":  selection,
                                "odd_value":  float(odd_val),
                                "scraped_at": scraped_at,
                            }).execute()
                        except Exception:
                            pass

                saved += 1
            except Exception as exc:
                import logging
                logging.getLogger(__name__).warning(f"Football odds save error: {exc}")

        await queue.put({"type": "done", "message": f"✅ {saved} partidos de fútbol con cuotas guardados ({source})", "result": {"count": saved}})
    except Exception as e:
        if queue:
            await queue.put({"type": "error", "message": str(e)})
            await queue.put({"type": "done", "message": "Error"})


@router.post("/scrape/odds")
async def scrape_football_odds(
    source: str = Query("betplay", enum=["betplay", "rushbet"]),
    background_tasks: BackgroundTasks = BackgroundTasks(),
):
    session_id = str(uuid.uuid4())
    queue: asyncio.Queue = asyncio.Queue()
    _scraping_queues[session_id] = queue
    background_tasks.add_task(_run_odds_bg, session_id, source)
    return {"session_id": session_id, "source": source, "message": "Football odds scraping iniciado"}


@router.get("/scrape/odds/stream/{session_id}")
async def stream_football_odds(session_id: str):
    queue = _scraping_queues.get(session_id)
    if not queue:
        raise HTTPException(404, "Session not found")
    return StreamingResponse(
        _sse_generator(queue, session_id),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"},
    )


# ---- Data endpoints ----------------------------------------------------------

@router.get("/matches")
async def get_football_matches(
    league: Optional[str] = None,
    days_ahead: int = Query(7, ge=1, le=30),
):
    from datetime import timedelta
    supabase = get_supabase()
    now_str = datetime.now(timezone.utc).isoformat()
    end_str = (datetime.now(timezone.utc) + timedelta(days=days_ahead)).isoformat()

    query = supabase.table("matches").select(
        "*, home_team:teams!home_team_id(name, logo_url), away_team:teams!away_team_id(name, logo_url)"
    ).eq("sport", "football").gte("match_date", now_str).lte("match_date", end_str).order("match_date")

    if league:
        query = query.eq("league", league)

    res = query.execute()
    matches = res.data or []

    for m in matches:
        # Latest odds per selection (deduplication, newest scraped_at first)
        odds_res  = supabase.table("odds").select("*").eq(
            "match_id", m["id"]
        ).order("scraped_at", desc=True).execute()
        all_odds  = odds_res.data or []
        seen: set = set()
        latest: list = []
        for o in all_odds:
            key = (o.get("market", ""), o.get("selection", ""))
            if key not in seen:
                seen.add(key)
                latest.append(o)
        m["odds"] = latest

        pred_res  = supabase.table("predictions").select("*").eq("match_id", m["id"]).order("created_at", desc=True).limit(1).execute()
        m["prediction"] = pred_res.data[0] if pred_res.data else None

    return {"matches": matches, "count": len(matches)}


@router.get("/leagues")
async def get_leagues():
    return {"leagues": [
        {"key": k, "name": v["name"], "country": v.get("country"), "fbref_id": v["fbref_id"]}
        for k, v in FOOTBALL_LEAGUES.items()
    ]}


# ---- ML endpoints ------------------------------------------------------------

@router.post("/train")
async def train_football_model(background_tasks: BackgroundTasks):
    session_id = str(uuid.uuid4())
    queue: asyncio.Queue = asyncio.Queue()
    _scraping_queues[session_id] = queue

    async def _train():
        predictor = get_football_predictor()
        result = await predictor.bootstrap_training(queue)
        await queue.put({"type": "done", "message": "Entrenamiento fútbol finalizado", "result": result})

    background_tasks.add_task(_train)
    return {"session_id": session_id, "message": "Football bootstrap training iniciado"}


@router.get("/train/stream/{session_id}")
async def stream_football_training(session_id: str):
    queue = _scraping_queues.get(session_id)
    if not queue:
        raise HTTPException(404, "Session not found")
    return StreamingResponse(
        _sse_generator(queue, session_id),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"},
    )


@router.post("/predict/{match_id}")
async def predict_football_match(match_id: str, budget_cop: int = Query(200_000)):
    supabase = get_supabase()
    match_res = supabase.table("matches").select(
        "*, home_team:teams!home_team_id(*), away_team:teams!away_team_id(*)"
    ).eq("id", match_id).execute()

    if not match_res.data:
        raise HTTPException(404, "Match not found")

    match = match_res.data[0]
    odds_res = supabase.table("odds").select("*").eq(
        "match_id", match_id
    ).order("scraped_at", desc=True).execute()
    odds = odds_res.data or []

    # Deduplicate: latest per market+selection
    seen_keys: set = set()
    latest_odds = []
    for o in odds:
        key = (o.get("market", ""), o.get("selection", ""))
        if key not in seen_keys:
            seen_keys.add(key)
            latest_odds.append(o)

    def find_odd(selection_hint: str) -> float:
        for o in latest_odds:
            sel = (o.get("selection") or "").lower()
            if selection_hint.lower() in sel:
                return float(o["odd_value"])
        return 2.0

    match_data = {
        "home_stats":       {},
        "away_stats":       {},
        "h2h":              {},
        "home_win_odd":     find_odd("home"),
        "draw_odd":         find_odd("draw") or 3.2,
        "away_win_odd":     find_odd("away"),
        "ou_over_odd":      find_odd("over") or 1.9,
        "ou_under_odd":     find_odd("under") or 1.9,
        "btts_yes_odd":     find_odd("btts") or 1.8,
        "btts_no_odd":      2.0,
        "league_avg_goals": 1.4,
        "league_strength":  0.5,
        "budget_cop":       budget_cop,
    }

    predictor = get_football_predictor()
    pred = predictor.predict(match_data, budget_cop=budget_cop)

    supabase.table("predictions").insert({
        "match_id":              match_id,
        "model_version":         pred["model_version"],
        "predicted_outcome":     pred["best_market"],
        "confidence":            pred["best_prob"],
        "expected_value":        pred["expected_value"],
        "recommended_market":    pred["best_market"],
        "bet_type":              pred["bet_type"],
        "suggested_amount_cop":  pred["suggested_amount_cop"],
        "features_used":         match_data,
        "created_at":            datetime.now(timezone.utc).isoformat(),
    }).execute()

    return {"match_id": match_id, "prediction": pred}


@router.get("/predictions")
async def get_football_predictions(league: Optional[str] = None):
    supabase = get_supabase()
    today = datetime.now(timezone.utc).date().isoformat()
    res = supabase.table("predictions").select(
        "*, match:matches(sport, league, home_team:teams!home_team_id(name), away_team:teams!away_team_id(name))"
    ).gte("created_at", f"{today}T00:00:00").execute()
    preds = res.data or []
    if league:
        preds = [p for p in preds if p.get("match", {}).get("league") == league]
    return {"predictions": preds, "count": len(preds)}
