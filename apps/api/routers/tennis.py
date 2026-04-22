"""
BetIQ — FastAPI Router: Tennis
Endpoints: scrape rankings/schedules/odds per tour, train, predict, matches
"""
import asyncio
import json
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, HTTPException, Query
from fastapi.responses import StreamingResponse

from scrapers.tennis_scraper import run_tennis_stats_scrape, run_tennis_odds_scrape
from models.tennis_model import get_tennis_predictor
from services.supabase_client import get_supabase
from constants import TENNIS_TOURNAMENTS

router = APIRouter()
_queues: dict[str, asyncio.Queue] = {}
VALID_TOURS = ["ATP", "WTA"]


async def _sse(queue: asyncio.Queue, session_id: str):
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
        _queues.pop(session_id, None)


def _sse_headers() -> dict:
    return {"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"}


# ---- Stats scraping ----------------------------------------------------------

async def _run_stats_bg(session_id: str, tour: str):
    queue = _queues.get(session_id)
    if not queue:
        return
    try:
        result   = await run_tennis_stats_scrape(tour, queue)
        supabase = get_supabase()
        matches  = result.get("matches", [])
        saved    = 0
        for m in matches:
            try:
                player1 = m.get("player1", "")
                player2 = m.get("player2", "")
                match_date = m.get("match_date")
                if not (player1 and player2 and match_date):
                    continue
                for pname in [player1, player2]:
                    supabase.table("teams").upsert(
                        {"name": pname, "sport": "tennis", "league": m.get("tour", tour)},
                        on_conflict="name,sport"
                    ).execute()
                p1r = supabase.table("teams").select("id").eq("name", player1).eq("sport","tennis").execute()
                p2r = supabase.table("teams").select("id").eq("name", player2).eq("sport","tennis").execute()
                if p1r.data and p2r.data:
                    existing = supabase.table("matches").select("id").eq("home_team_id", p1r.data[0]["id"]).eq("away_team_id", p2r.data[0]["id"]).eq("match_date", match_date).execute()
                    if not existing.data:
                        # Use insert after checking to avoid duplicate key errors on repeated scrapes
                        supabase.table("matches").insert({
                            "sport":        "tennis",
                            "league":       m.get("tour", tour),
                            "season":       "2026",
                            "round":        m.get("round", ""),
                            "home_team_id": p1r.data[0]["id"],
                            "away_team_id": p2r.data[0]["id"],
                            "match_date":   match_date,
                            "status":       "scheduled",
                            "scraped_at":   datetime.now(timezone.utc).isoformat(),
                        }).execute()
                        saved += 1
            except Exception as exc:
                logger.warning(f"Tennis match save error: {exc}")

        await queue.put({
            "type": "done",
            "message": f"✅ {tour}: {saved} partidos guardados, {len(result.get('rankings', []))} players en ranking",
            "result": {"matches_count": saved, "rankings_count": len(result.get("rankings", []))},
        })
    except Exception as e:
        if queue:
            await queue.put({"type": "error", "message": str(e)})
            await queue.put({"type": "done",  "message": "Error finalizado"})


@router.post("/scrape/stats")
async def scrape_tennis_stats(
    tour: str = Query("ATP", enum=VALID_TOURS),
    background_tasks: BackgroundTasks = BackgroundTasks(),
):
    sid   = str(uuid.uuid4())
    queue: asyncio.Queue = asyncio.Queue()
    _queues[sid] = queue
    background_tasks.add_task(_run_stats_bg, sid, tour)
    return {"session_id": sid, "tour": tour, "message": "Tennis stats scraping iniciado"}


@router.get("/scrape/stats/stream/{session_id}")
async def stream_tennis_stats(session_id: str):
    q = _queues.get(session_id)
    if not q:
        raise HTTPException(404, "Session not found")
    return StreamingResponse(_sse(q, session_id), media_type="text/event-stream", headers=_sse_headers())


# ---- Odds ----------------------------------------------------------------

async def _run_odds_bg(session_id: str, source: str):
    queue = _queues.get(session_id)
    if not queue:
        return
    try:
        result = await run_tennis_odds_scrape(source, queue)
        odds = result.get("odds", [])
        supabase = get_supabase()
        saved = 0
        scraped_at = datetime.now(timezone.utc).isoformat()
        
        from datetime import timedelta

        for odd in odds:
            try:
                p1_name = odd.get("player1", "")
                p2_name = odd.get("player2", "")
                if not (p1_name and p2_name):
                    continue

                for pname in [p1_name, p2_name]:
                    supabase.table("teams").upsert(
                        {"name": pname, "sport": "tennis"},
                        on_conflict="name,sport"
                    ).execute()

                p1r = supabase.table("teams").select("id").eq("name", p1_name).eq("sport", "tennis").execute()
                p2r = supabase.table("teams").select("id").eq("name", p2_name).eq("sport", "tennis").execute()
                if not (p1r.data and p2r.data):
                    continue

                p1_id = p1r.data[0]["id"]
                p2_id = p2r.data[0]["id"]

                # Find or create match
                match_r = supabase.table("matches").select("id").eq("home_team_id", p1_id).eq("away_team_id", p2_id).eq("sport", "tennis").gte("match_date", datetime.now(timezone.utc).isoformat()).limit(1).execute()
                if match_r.data:
                    match_id = match_r.data[0]["id"]
                else:
                    new_match = supabase.table("matches").insert({
                        "sport":        "tennis",
                        "league":       "ATP",
                        "home_team_id": p1_id,
                        "away_team_id": p2_id,
                        "match_date":   (datetime.now(timezone.utc) + timedelta(days=2)).isoformat(),
                        "status":       "scheduled",
                        "scraped_at":   scraped_at,
                    }).execute()
                    if not new_match.data:
                        continue
                    match_id = new_match.data[0]["id"]

                # Map Kambi keys (ml_home/ml_away) and Playwright keys (p1_odd/p2_odd)
                markets = [
                    ("moneyline", "home", odd.get("ml_home") or odd.get("p1_odd")),
                    ("moneyline", "away", odd.get("ml_away") or odd.get("p2_odd")),
                ]
                for market, selection, odd_val in markets:
                    if odd_val is not None:
                        try:
                            # Delete stale before inserting fresh
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
                logging.getLogger(__name__).warning(f"Tennis odds save error: {exc}")

        await queue.put({"type": "done", "message": f"✅ {saved} partidos de tenis con cuotas guardados ({source})", "result": {"count": saved}})
    except Exception as e:
        if queue:
            await queue.put({"type": "error", "message": str(e)})
            await queue.put({"type": "done",  "message": "Error"})


@router.post("/scrape/odds")
async def scrape_tennis_odds(
    source: str = Query("rushbet", enum=["rushbet", "betplay"]),
    background_tasks: BackgroundTasks = BackgroundTasks(),
):
    sid   = str(uuid.uuid4())
    queue: asyncio.Queue = asyncio.Queue()
    _queues[sid] = queue
    background_tasks.add_task(_run_odds_bg, sid, source)
    return {"session_id": sid, "source": source}


@router.get("/scrape/odds/stream/{session_id}")
async def stream_tennis_odds(session_id: str):
    q = _queues.get(session_id)
    if not q:
        raise HTTPException(404, "Session not found")
    return StreamingResponse(_sse(q, session_id), media_type="text/event-stream", headers=_sse_headers())


# ---- Data ----------------------------------------------------------------

@router.get("/matches")
async def get_tennis_matches(
    tour:       Optional[str] = None,
    surface:    Optional[str] = None,
    tournament: Optional[str] = None,
    days_ahead: int = Query(10, ge=1, le=30),
):
    from datetime import timedelta
    supabase = get_supabase()
    now_str  = datetime.now(timezone.utc).isoformat()
    end_str  = (datetime.now(timezone.utc) + timedelta(days=days_ahead)).isoformat()

    q = supabase.table("matches").select(
        "*, player1:teams!home_team_id(name), player2:teams!away_team_id(name)"
    ).eq("sport", "tennis").gte("match_date", now_str).lte("match_date", end_str).order("match_date")

    if tour:
        q = q.eq("league", tour)

    res = q.execute()
    matches = res.data or []

    for m in matches:
        # Latest per selection (dedup)
        odds_r   = supabase.table("odds").select("*").eq(
            "match_id", m["id"]
        ).order("scraped_at", desc=True).execute()
        all_odds = odds_r.data or []
        seen_s: set = set()
        latest_odds: list = []
        for o in all_odds:
            key = (o.get("market", ""), o.get("selection", ""))
            if key not in seen_s:
                seen_s.add(key)
                latest_odds.append(o)
        m["odds"] = latest_odds

        pred_r    = supabase.table("predictions").select("*").eq("match_id", m["id"]).order("created_at", desc=True).limit(1).execute()
        m["prediction"] = pred_r.data[0] if pred_r.data else None

    return {"matches": matches, "count": len(matches)}


@router.get("/tournaments")
async def get_tournaments():
    return {"tournaments": TENNIS_TOURNAMENTS}


# ---- Train & Predict ---------------------------------------------------------

@router.post("/train")
async def train_tennis_model(background_tasks: BackgroundTasks):
    sid   = str(uuid.uuid4())
    queue: asyncio.Queue = asyncio.Queue()
    _queues[sid] = queue

    async def _train():
        predictor = get_tennis_predictor()
        result    = await predictor.bootstrap_training(queue)
        await queue.put({"type": "done", "message": "Tennis training completado", "result": result})

    background_tasks.add_task(_train)
    return {"session_id": sid, "message": "Tennis bootstrap training iniciado"}


@router.get("/train/stream/{session_id}")
async def stream_tennis_training(session_id: str):
    q = _queues.get(session_id)
    if not q:
        raise HTTPException(404, "Session not found")
    return StreamingResponse(_sse(q, session_id), media_type="text/event-stream", headers=_sse_headers())


@router.post("/predict/{match_id}")
async def predict_tennis_match(match_id: str, budget_cop: int = Query(200_000)):
    supabase = get_supabase()
    mr = supabase.table("matches").select(
        "*, player1:teams!home_team_id(*), player2:teams!away_team_id(*)"
    ).eq("id", match_id).execute()

    if not mr.data:
        raise HTTPException(404, "Match not found")

    match = mr.data[0]
    orr  = supabase.table("odds").select("*").eq(
        "match_id", match_id
    ).order("scraped_at", desc=True).execute()
    odds = orr.data or []

    # Deduplicate: latest per market+selection
    seen_k: set = set()
    latest: list = []
    for o in odds:
        key = (o.get("market", ""), o.get("selection", ""))
        if key not in seen_k:
            seen_k.add(key)
            latest.append(o)

    def find_odd(hint: str) -> float:
        for o in latest:
            sel = (o.get("selection") or "").lower()
            mkt = (o.get("market") or "").lower()
            if hint.lower() in sel or hint.lower() in mkt:
                return float(o["odd_value"])
        return 1.90

    md = {
        "player1": match.get("player1", {}).get("name", "P1"),
        "player2": match.get("player2", {}).get("name", "P2"),
        "surface":      "hard",
        "tour":         match.get("league", "ATP"),
        "is_grand_slam": False,
        "p1_odd":       find_odd("p1") or find_odd("home") or 2.0,
        "p2_odd":       find_odd("p2") or find_odd("away") or 2.0,
    }

    predictor = get_tennis_predictor()
    pred      = predictor.predict(md, budget_cop=budget_cop)

    supabase.table("predictions").insert({
        "match_id":             match_id,
        "model_version":        pred["model_version"],
        "predicted_outcome":    pred["best_market"],
        "confidence":           pred["best_prob"],
        "expected_value":       pred["expected_value"],
        "recommended_market":   pred["best_market"],
        "bet_type":             pred["bet_type"],
        "suggested_amount_cop": pred["suggested_amount_cop"],
        "features_used":        md,
        "created_at":           datetime.now(timezone.utc).isoformat(),
    }).execute()

    return {"match_id": match_id, "prediction": pred}
