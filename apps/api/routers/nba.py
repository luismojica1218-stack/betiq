"""
BetIQ — FastAPI Router: NBA
Endpoints: scrape/stats, scrape/odds, matches, team stats, form, train, predict, predictions
Uses Server-Sent Events (SSE) for real-time scraping logs.
"""
import asyncio
import json
import logging
import uuid
from datetime import datetime, timezone
from typing import AsyncGenerator

logger = logging.getLogger(__name__)

from fastapi import APIRouter, BackgroundTasks, HTTPException, Query
from fastapi.responses import StreamingResponse

from scrapers.nba_scraper import run_nba_stats_scrape, run_nba_odds_scrape, NBAStatsScraper
from models.nba_model import get_predictor
from services.supabase_client import get_supabase

router = APIRouter()

# ---- Active scraping queues (session_id -> asyncio.Queue) ------------------
_scraping_queues: dict[str, asyncio.Queue] = {}


async def _sse_generator(queue: asyncio.Queue, session_id: str) -> AsyncGenerator[str, None]:
    """Consume log messages from a queue and yield SSE events."""
    yield f"data: {json.dumps({'type': 'connected', 'session_id': session_id})}\n\n"
    try:
        while True:
            try:
                item = await asyncio.wait_for(queue.get(), timeout=60.0)
                yield f"data: {json.dumps(item)}\n\n"
                if item.get("type") == "done":
                    break
            except asyncio.TimeoutError:
                # Send heartbeat
                yield f"data: {json.dumps({'type': 'heartbeat'})}\n\n"
    finally:
        _scraping_queues.pop(session_id, None)


# ---- Stats Scraping ---------------------------------------------------------

async def _run_stats_background(session_id: str):
    queue = _scraping_queues.get(session_id)
    if not queue:
        return
    try:
        result = await run_nba_stats_scrape(queue)
        # Persist games to Supabase
        supabase = get_supabase()
        games = result.get("games", [])
        if games:
            await queue.put({"type": "log", "message": f"💾 Guardando {len(games)} partidos en Supabase..."})
            # Upsert teams and matches
            for game in games:
                home_name = game.get("home_team", "")
                away_name = game.get("away_team", "")
                if home_name and away_name:
                    # Upsert teams
                    for name, sport in [(home_name, "nba"), (away_name, "nba")]:
                        supabase.table("teams").upsert(
                            {"name": name, "sport": "nba", "league": "NBA"},
                            on_conflict="name,sport"
                        ).execute()
                    # Get team ids
                    home_res = supabase.table("teams").select("id").eq("name", home_name).eq("sport", "nba").execute()
                    away_res = supabase.table("teams").select("id").eq("name", away_name).eq("sport", "nba").execute()
                    home_id = home_res.data[0]["id"] if home_res.data else None
                    away_id = away_res.data[0]["id"] if away_res.data else None
                    if home_id and away_id:
                        existing = supabase.table("matches").select("id").eq("home_team_id", home_id).eq("away_team_id", away_id).eq("match_date", game.get("match_date")).execute()
                        if not existing.data:
                            supabase.table("matches").insert({
                                "sport": "nba",
                                "league": "NBA",
                                "season": game.get("season", "2025-26"),
                                "home_team_id": home_id,
                                "away_team_id": away_id,
                                "match_date": game.get("match_date"),
                                "status": "scheduled",
                                "scraped_at": datetime.now(timezone.utc).isoformat(),
                            }).execute()

        team_stats = result.get("team_stats", {})
        stats_saved = 0
        if team_stats:
            await queue.put({"type": "log", "message": f"📊 Guardando stats de {len(team_stats)} equipos NBA (SofaScore)..."})
            scraped_ts = datetime.now(timezone.utc).isoformat()
            for team_name, ts in team_stats.items():
                try:
                    supabase.table("teams").upsert(
                        {"name": team_name, "sport": "nba", "league": "NBA"},
                        on_conflict="name,sport"
                    ).execute()
                    team_res = supabase.table("teams").select("id").eq("name", team_name).eq("sport", "nba").execute()
                    if team_res.data:
                        supabase.table("team_stats").insert({
                            "team_id":    team_res.data[0]["id"],
                            "stats_json": ts,
                            "source_url": "sofascore",
                            "scraped_at": scraped_ts,
                        }).execute()
                        stats_saved += 1
                except Exception:
                    pass

        await queue.put({
            "type": "done",
            "message": f"✅ Scraping NBA: {len(games)} partidos, {stats_saved} equipos con stats (SofaScore)",
            "result": {"games_count": len(games), "teams_count": stats_saved},
        })
    except Exception as e:
        if queue:
            await queue.put({"type": "error", "message": f"❌ Error: {str(e)}"})
            await queue.put({"type": "done", "message": "Proceso terminado con errores"})


@router.post("/scrape/stats")
async def scrape_nba_stats(background_tasks: BackgroundTasks):
    """Trigger NBA stats scraping. Returns session_id for SSE connection."""
    session_id = str(uuid.uuid4())
    queue: asyncio.Queue = asyncio.Queue()
    _scraping_queues[session_id] = queue
    background_tasks.add_task(_run_stats_background, session_id)
    return {"session_id": session_id, "message": "Stats scraping iniciado"}


@router.get("/scrape/stats/stream/{session_id}")
async def stream_stats_scraping(session_id: str):
    """SSE stream endpoint for stats scraping logs."""
    queue = _scraping_queues.get(session_id)
    if not queue:
        raise HTTPException(status_code=404, detail="Session not found")
    return StreamingResponse(
        _sse_generator(queue, session_id),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection":    "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# ---- Odds Scraping ----------------------------------------------------------

async def _run_odds_background(session_id: str):
    queue = _scraping_queues.get(session_id)
    if not queue:
        return
    try:
        result = await run_nba_odds_scrape(queue)
        odds_data = result.get("odds", [])

        supabase = get_supabase()
        saved = 0
        today = datetime.now(timezone.utc).date().isoformat()

        for odd in odds_data:
            try:
                home_name = odd.get("home_team", "")
                away_name = odd.get("away_team", "")
                match_id = None

                if home_name and away_name:
                    # Upsert teams (unique constraint now exists on name+sport)
                    for name in [home_name, away_name]:
                        supabase.table("teams").upsert(
                            {"name": name, "sport": "nba", "league": "NBA"},
                            on_conflict="name,sport"
                        ).execute()

                    # Get team IDs
                    home_res = supabase.table("teams").select("id").eq("name", home_name).eq("sport", "nba").execute()
                    away_res = supabase.table("teams").select("id").eq("name", away_name).eq("sport", "nba").execute()

                    if home_res.data and away_res.data:
                        home_id = home_res.data[0]["id"]
                        away_id = away_res.data[0]["id"]

                        # Find existing match
                        match_res = supabase.table("matches").select("id").eq(
                            "home_team_id", home_id
                        ).eq("away_team_id", away_id).eq("sport", "nba").gte(
                            "match_date", today
                        ).execute()

                        if match_res.data:
                            match_id = match_res.data[0]["id"]
                        else:
                            # Create match from odds data (no stats scraped yet)
                            ins = supabase.table("matches").insert({
                                "sport": "nba",
                                "league": "NBA",
                                "season": "2025-26",
                                "home_team_id": home_id,
                                "away_team_id": away_id,
                                "match_date": datetime.now(timezone.utc).isoformat(),
                                "status": "scheduled",
                                "scraped_at": datetime.now(timezone.utc).isoformat(),
                            }).execute()
                            if ins.data:
                                match_id = ins.data[0]["id"]

                # Save home & away odds linked to match
                scraped_at = datetime.now(timezone.utc).isoformat()
                for selection, odd_key in [("home", "ml_home"), ("away", "ml_away")]:
                    odd_val = odd.get(odd_key)
                    if odd_val:
                        supabase.table("odds").insert({
                            "match_id":  match_id,
                            "bookmaker": odd.get("bookmaker", "rushbet"),
                            "market":    "moneyline",
                            "selection": selection,
                            "odd_value": float(odd_val),
                            "scraped_at": scraped_at,
                        }).execute()
                saved += 1
            except Exception as e:
                logger.error(f"Error saving odds for {odd.get('home_team')}: {e}")

        await queue.put({
            "type": "done",
            "message": f"✅ Cuotas guardadas: {saved}/{len(odds_data)}",
            "result": {"odds_count": len(odds_data)},
        })
    except Exception as e:
        if queue:
            await queue.put({"type": "error", "message": f"❌ Error: {str(e)}"})
            await queue.put({"type": "done", "message": "Proceso terminado con errores"})


@router.post("/scrape/odds")
async def scrape_nba_odds(background_tasks: BackgroundTasks):
    """Trigger Rushbet odds scraping for NBA."""
    session_id = str(uuid.uuid4())
    queue: asyncio.Queue = asyncio.Queue()
    _scraping_queues[session_id] = queue
    background_tasks.add_task(_run_odds_background, session_id)
    return {"session_id": session_id, "message": "Odds scraping iniciado"}


@router.get("/scrape/odds/stream/{session_id}")
async def stream_odds_scraping(session_id: str):
    queue = _scraping_queues.get(session_id)
    if not queue:
        raise HTTPException(status_code=404, detail="Session not found")
    return StreamingResponse(
        _sse_generator(queue, session_id),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"},
    )


# ---- Data Endpoints ---------------------------------------------------------

@router.get("/matches")
async def get_nba_matches(days_ahead: int = Query(7, ge=1, le=30)):
    """Return upcoming NBA matches with their odds and predictions."""
    supabase = get_supabase()
    from datetime import timedelta

    now_str  = datetime.now(timezone.utc).isoformat()
    end_str  = (datetime.now(timezone.utc) + timedelta(days=days_ahead)).isoformat()

    matches_res = supabase.table("matches").select(
        "*, home_team:teams!home_team_id(name, logo_url), away_team:teams!away_team_id(name, logo_url)"
    ).eq("sport", "nba").gte("match_date", now_str).lte("match_date", end_str).order("match_date").execute()

    matches = matches_res.data or []

    # Enrich with odds and predictions
    for match in matches:
        odds_res = supabase.table("odds").select("*").eq("match_id", match["id"]).execute()
        match["odds"] = odds_res.data or []
        pred_res = supabase.table("predictions").select("*").eq("match_id", match["id"]).order("created_at", desc=True).limit(1).execute()
        match["prediction"] = pred_res.data[0] if pred_res.data else None

    return {"matches": matches, "count": len(matches)}


@router.get("/teams/stats")
async def get_team_stats():
    """Return cached season stats for all NBA teams."""
    supabase = get_supabase()
    res = supabase.table("team_stats").select("*, team:teams(name, sport)").execute()
    return {"stats": res.data or [], "count": len(res.data or [])}


@router.get("/form/{team_id}")
async def get_team_form(team_id: str, last_n: int = Query(10, ge=5, le=20)):
    """Return recent form for a team by scraping on demand."""
    supabase = get_supabase()
    team_res = supabase.table("teams").select("*").eq("id", team_id).execute()
    if not team_res.data:
        raise HTTPException(status_code=404, detail="Team not found")
    team = team_res.data[0]
    external_id = team.get("external_id", "")
    if not external_id:
        return {"team": team["name"], "form": [], "message": "No external_id set for this team"}

    scraper = NBAStatsScraper()
    form = await scraper.scrape_recent_form(external_id, last_n=last_n)
    return {"team": team["name"], "form": form}


# ---- ML Endpoints -----------------------------------------------------------

@router.post("/train")
async def train_nba_model(background_tasks: BackgroundTasks):
    """Trigger bootstrap training for the NBA ML model."""
    session_id = str(uuid.uuid4())
    queue: asyncio.Queue = asyncio.Queue()
    _scraping_queues[session_id] = queue

    async def _train():
        predictor = get_predictor()
        result = await predictor.bootstrap_training(queue)
        await queue.put({"type": "done", "message": "Entrenamiento finalizado", "result": result})

    background_tasks.add_task(_train)
    return {"session_id": session_id, "message": "Bootstrap training iniciado"}


@router.get("/train/stream/{session_id}")
async def stream_training(session_id: str):
    queue = _scraping_queues.get(session_id)
    if not queue:
        raise HTTPException(status_code=404, detail="Session not found")
    return StreamingResponse(
        _sse_generator(queue, session_id),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"},
    )


@router.post("/predict/{match_id}")
async def predict_match(match_id: str):
    """Generate prediction for a specific match."""
    supabase = get_supabase()

    match_res = supabase.table("matches").select(
        "*, home_team:teams!home_team_id(*), away_team:teams!away_team_id(*)"
    ).eq("id", match_id).execute()

    if not match_res.data:
        raise HTTPException(status_code=404, detail="Match not found")

    match = match_res.data[0]

    # Fetch odds
    odds_res = supabase.table("odds").select("*").eq("match_id", match_id).execute()
    odds = odds_res.data or []
    home_odd = next((o["odd_value"] for o in odds if "home" in (o.get("selection") or "").lower()), 2.0)
    away_odd = next((o["odd_value"] for o in odds if "away" in (o.get("selection") or "").lower()), 2.0)

    predictor = get_predictor()
    match_data = {
        "home_stats": {"pts_per_game": 113.0, "opp_pts_per_game": 110.0},
        "away_stats": {"pts_per_game": 111.0, "opp_pts_per_game": 112.0},
        "h2h":        {"h2h_home_win_pct": 0.55},
        "home_odd":   float(home_odd),
        "away_odd":   float(away_odd),
    }
    prediction = predictor.predict(match_data)

    # Save to DB
    supabase.table("predictions").insert({
        "match_id":         match_id,
        "model_version":    prediction["model_version"],
        "predicted_outcome": prediction["predicted_winner"],
        "confidence":       prediction["confidence"],
        "expected_value":   prediction["expected_value"],
        "recommended_market": prediction["recommended_bet"],
        "bet_type":         prediction["bet_type"],
        "suggested_amount_cop": prediction["suggested_amount_cop"],
        "features_used":    match_data,
        "created_at":       datetime.now(timezone.utc).isoformat(),
    }).execute()

    return {"match_id": match_id, "prediction": prediction}


@router.get("/predictions")
async def get_today_predictions():
    """Return all NBA predictions for today."""
    supabase = get_supabase()
    today = datetime.now(timezone.utc).date().isoformat()
    res = supabase.table("predictions").select(
        "*, match:matches(*, home_team:teams!home_team_id(name), away_team:teams!away_team_id(name))"
    ).gte("created_at", f"{today}T00:00:00").execute()
    return {"predictions": res.data or [], "count": len(res.data or [])}
