"""
StatIQ — FastAPI Router: NBA
Endpoints: scrape/stats, matches, team stats, form, train, predict, predictions
Betting/odds endpoints removed — pure statistical insights platform.
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

from scrapers.nba_scraper import run_nba_stats_scrape, NBAStatsScraper
from scrapers.news_scraper import NewsScraper
from scrapers.injury_scraper import InjuryScraper
from models.nba_model import get_predictor
from services.supabase_client import get_supabase

router = APIRouter()

# ---- Active scraping queues (session_id -> asyncio.Queue) ------------------
_scraping_queues: dict = {}


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
                yield f"data: {json.dumps({'type': 'heartbeat'})}\n\n"
    finally:
        _scraping_queues.pop(session_id, None)


# ---- Stats Scraping ---------------------------------------------------------

async def _run_stats_background(session_id: str):
    queue = _scraping_queues.get(session_id)
    if not queue:
        return
    try:
        result   = await run_nba_stats_scrape(queue)
        supabase = get_supabase()
        games    = result.get("games", [])

        if games:
            await queue.put({"type": "log", "message": f"Guardando {len(games)} partidos en Supabase..."})
            for game in games:
                home_name = game.get("home_team", "")
                away_name = game.get("away_team", "")
                if home_name and away_name:
                    for name in [home_name, away_name]:
                        supabase.table("teams").upsert(
                            {"name": name, "sport": "nba", "league": "NBA"},
                            on_conflict="name,sport"
                        ).execute()
                    home_res = supabase.table("teams").select("id").eq("name", home_name).eq("sport", "nba").execute()
                    away_res = supabase.table("teams").select("id").eq("name", away_name).eq("sport", "nba").execute()
                    home_id  = home_res.data[0]["id"] if home_res.data else None
                    away_id  = away_res.data[0]["id"] if away_res.data else None
                    if home_id and away_id:
                        try:
                            supabase.table("matches").insert({
                                "sport":        "nba",
                                "league":       "NBA",
                                "season":       game.get("season", "2025-26"),
                                "home_team_id": home_id,
                                "away_team_id": away_id,
                                "match_date":   game.get("match_date"),
                                "status":       "scheduled",
                                "scraped_at":   datetime.now(timezone.utc).isoformat(),
                            }).execute()
                        except Exception:
                            pass  # Duplicate — unique index rejects it

        team_stats  = result.get("team_stats", {})
        stats_saved = 0
        if team_stats:
            await queue.put({"type": "log", "message": f"Guardando stats de {len(team_stats)} equipos NBA..."})
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
            "type":    "done",
            "message": f"Scraping NBA: {len(games)} partidos, {stats_saved} equipos con stats",
            "result":  {"games_count": len(games), "teams_count": stats_saved},
        })
    except Exception as e:
        if queue:
            await queue.put({"type": "error", "message": f"Error: {str(e)}"})
            await queue.put({"type": "done",  "message": "Proceso terminado con errores"})


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
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"},
    )


# ---- Data Endpoints ---------------------------------------------------------

@router.get("/matches")
async def get_nba_matches(days_ahead: int = Query(7, ge=1, le=30)):
    """Return upcoming NBA matches with their statistical predictions."""
    from datetime import timedelta
    supabase = get_supabase()

    now_str = datetime.now(timezone.utc).isoformat()
    end_str = (datetime.now(timezone.utc) + timedelta(days=days_ahead)).isoformat()

    matches_res = supabase.table("matches").select(
        "*, home_team:teams!home_team_id(name, logo_url), away_team:teams!away_team_id(name, logo_url)"
    ).eq("sport", "nba").gte("match_date", now_str).lte("match_date", end_str).order("match_date").execute()

    matches = matches_res.data or []

    for match in matches:
        pred_res = supabase.table("predictions").select("*").eq(
            "match_id", match["id"]
        ).order("created_at", desc=True).limit(1).execute()
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
    team        = team_res.data[0]
    external_id = team.get("external_id", "")
    if not external_id:
        return {"team": team["name"], "form": [], "message": "No external_id set for this team"}

    scraper = NBAStatsScraper()
    form    = await scraper.scrape_recent_form(external_id, last_n=last_n)
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
    """Generate statistical prediction for a specific match using scraped team stats."""
    supabase = get_supabase()

    match_res = supabase.table("matches").select(
        "*, home_team:teams!home_team_id(*), away_team:teams!away_team_id(*)"
    ).eq("id", match_id).execute()

    if not match_res.data:
        raise HTTPException(status_code=404, detail="Match not found")

    match        = match_res.data[0]
    home_team_id = match["home_team_id"]
    away_team_id = match["away_team_id"]

    # Fetch most recent team stats
    def get_team_stats(team_id: str) -> dict:
        res = supabase.table("team_stats").select("stats_json").eq(
            "team_id", team_id
        ).order("scraped_at", desc=True).limit(1).execute()
        if res.data and res.data[0].get("stats_json"):
            return res.data[0]["stats_json"]
        # Neutral fallback — model handles missing features gracefully
        return {"pts_per_game": 112.0, "opp_pts_per_game": 112.0}

    home_stats = get_team_stats(home_team_id)
    away_stats = get_team_stats(away_team_id)
    
    # Fetch news sentiment and injuries
    news_scraper = NewsScraper()
    injury_scraper = InjuryScraper()
    
    home_news = await news_scraper.get_team_news_sentiment(match["home_team"]["name"])
    away_news = await news_scraper.get_team_news_sentiment(match["away_team"]["name"])
    
    home_injuries = await injury_scraper.get_team_injuries(match["home_team"]["name"], "nba")
    away_injuries = await injury_scraper.get_team_injuries(match["away_team"]["name"], "nba")

    predictor  = get_predictor()
    match_data = {
        "home_stats": home_stats,
        "away_stats": away_stats,
        "home_news":  home_news,
        "away_news":  away_news,
        "home_injuries": home_injuries,
        "away_injuries": away_injuries,
        "h2h":        {"h2h_home_win_pct": 0.55},
    }
    prediction = predictor.predict(match_data)

    # Save to DB — no odds/EV/Kelly fields
    supabase.table("predictions").delete().eq("match_id", match_id).execute()
    supabase.table("predictions").insert({
        "match_id":          match_id,
        "model_version":     prediction["model_version"],
        "predicted_outcome": prediction["predicted_winner"],
        "confidence":        max(prediction["home_win_prob"], prediction["away_win_prob"]),
        "features_used":     match_data,
        "created_at":        datetime.now(timezone.utc).isoformat(),
    }).execute()

    return {"match_id": match_id, "prediction": prediction}


@router.post("/predict-all")
async def predict_all_matches(days_ahead: int = Query(14, ge=1, le=30)):
    """Regenerate statistical predictions for all upcoming matches."""
    from datetime import timedelta
    supabase  = get_supabase()
    predictor = get_predictor()

    now_str = datetime.now(timezone.utc).isoformat()
    end_str = (datetime.now(timezone.utc) + timedelta(days=days_ahead)).isoformat()

    matches_res = supabase.table("matches").select(
        "*, home_team:teams!home_team_id(*), away_team:teams!away_team_id(*)"
    ).eq("sport", "nba").gte("match_date", now_str).lte("match_date", end_str).order("match_date").execute()

    matches            = matches_res.data or []
    predicted, skipped = 0, 0

    def get_team_stats(team_id: str) -> dict:
        res = supabase.table("team_stats").select("stats_json").eq(
            "team_id", team_id
        ).order("scraped_at", desc=True).limit(1).execute()
        if res.data and res.data[0].get("stats_json"):
            return res.data[0]["stats_json"]
        return {"pts_per_game": 112.0, "opp_pts_per_game": 112.0}

    for match in matches:
        match_id = match["id"]
        try:
            home_stats = get_team_stats(match["home_team_id"])
            away_stats = get_team_stats(match["away_team_id"])
            
            news_scraper = NewsScraper()
            injury_scraper = InjuryScraper()
            
            home_news = await news_scraper.get_team_news_sentiment(match["home_team"]["name"])
            away_news = await news_scraper.get_team_news_sentiment(match["away_team"]["name"])
            
            home_injuries = await injury_scraper.get_team_injuries(match["home_team"]["name"], "nba")
            away_injuries = await injury_scraper.get_team_injuries(match["away_team"]["name"], "nba")

            match_data = {
                "home_stats": home_stats,
                "away_stats": away_stats,
                "home_news":  home_news,
                "away_news":  away_news,
                "home_injuries": home_injuries,
                "away_injuries": away_injuries,
                "h2h":        {"h2h_home_win_pct": 0.55},
            }
            prediction = predictor.predict(match_data)

            supabase.table("predictions").delete().eq("match_id", match_id).execute()
            supabase.table("predictions").insert({
                "match_id":          match_id,
                "model_version":     prediction["model_version"],
                "predicted_outcome": prediction["predicted_winner"],
                "confidence":        max(prediction["home_win_prob"], prediction["away_win_prob"]),
                "features_used":     match_data,
                "created_at":        datetime.now(timezone.utc).isoformat(),
            }).execute()
            predicted += 1
        except Exception as e:
            logger.error(f"Error predicting match {match_id}: {e}")
            skipped += 1

    return {
        "predicted": predicted,
        "skipped":   skipped,
        "total":     len(matches),
        "message":   f"{predicted} predicciones regeneradas, {skipped} omitidas",
    }


@router.get("/predictions")
async def get_today_predictions():
    """Return all NBA predictions for today."""
    supabase = get_supabase()
    today    = datetime.now(timezone.utc).date().isoformat()
    res      = supabase.table("predictions").select(
        "*, match:matches(*, home_team:teams!home_team_id(name), away_team:teams!away_team_id(name))"
    ).gte("created_at", f"{today}T00:00:00").execute()
    return {"predictions": res.data or [], "count": len(res.data or [])}
