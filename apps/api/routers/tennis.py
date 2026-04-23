"""
StatIQ — FastAPI Router: Tennis
Endpoints: scrape/stats, matches, tournaments, train, predict, predictions
Betting/odds endpoints removed — pure statistical insights platform.
"""
import asyncio
import json
import logging
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, HTTPException, Query
from fastapi.responses import StreamingResponse

from scrapers.tennis_scraper import run_tennis_stats_scrape
from models.tennis_model import get_tennis_predictor
from services.supabase_client import get_supabase
from constants import TENNIS_TOURNAMENTS

logger = logging.getLogger(__name__)

router = APIRouter()
_queues: dict = {}
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
                player1    = m.get("player1", "")
                player2    = m.get("player2", "")
                match_date = m.get("match_date")
                if not (player1 and player2 and match_date):
                    continue
                for pname in [player1, player2]:
                    supabase.table("teams").upsert(
                        {"name": pname, "sport": "tennis", "league": m.get("tour", tour)},
                        on_conflict="name,sport"
                    ).execute()
                p1r = supabase.table("teams").select("id").eq("name", player1).eq("sport", "tennis").execute()
                p2r = supabase.table("teams").select("id").eq("name", player2).eq("sport", "tennis").execute()
                if p1r.data and p2r.data:
                    existing = supabase.table("matches").select("id").eq(
                        "home_team_id", p1r.data[0]["id"]
                    ).eq("away_team_id", p2r.data[0]["id"]).eq("match_date", match_date).execute()
                    if not existing.data:
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
            "type":    "done",
            "message": f"{tour}: {saved} partidos guardados, {len(result.get('rankings', []))} players en ranking",
            "result":  {"matches_count": saved, "rankings_count": len(result.get("rankings", []))},
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

    res     = q.execute()
    matches = res.data or []

    for m in matches:
        pred_r = supabase.table("predictions").select("*").eq(
            "match_id", m["id"]
        ).order("created_at", desc=True).limit(1).execute()
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
async def predict_tennis_match(match_id: str):
    """Generate statistical prediction for a tennis match — no odds required."""
    supabase = get_supabase()
    mr       = supabase.table("matches").select(
        "*, player1:teams!home_team_id(*), player2:teams!away_team_id(*)"
    ).eq("id", match_id).execute()

    if not mr.data:
        raise HTTPException(404, "Match not found")

    match = mr.data[0]

    # Fetch player stats if available
    def get_player_stats(team_id: str) -> dict:
        res = supabase.table("team_stats").select("stats_json").eq(
            "team_id", team_id
        ).order("scraped_at", desc=True).limit(1).execute()
        if res.data and res.data[0].get("stats_json"):
            return res.data[0]["stats_json"]
        return {}

    p1_stats = get_player_stats(match["home_team_id"])
    p2_stats = get_player_stats(match["away_team_id"])

    md = {
        "player1":      match.get("player1", {}).get("name", "P1"),
        "player2":      match.get("player2", {}).get("name", "P2"),
        "surface":      match.get("surface", "hard"),
        "tour":         match.get("league", "ATP"),
        "is_grand_slam": False,
        "p1_stats":     p1_stats,
        "p2_stats":     p2_stats,
        "h2h":          {},
    }

    predictor = get_tennis_predictor()
    pred      = predictor.predict(md)

    # Save prediction to DB — no odds/EV/Kelly fields
    supabase.table("predictions").insert({
        "match_id":          match_id,
        "model_version":     pred["model_version"],
        "predicted_outcome": pred["predicted_winner"],
        "confidence":        max(pred["p1_win_prob"], pred["p2_win_prob"]),
        "features_used":     md,
        "created_at":        datetime.now(timezone.utc).isoformat(),
    }).execute()

    return {"match_id": match_id, "prediction": pred}


@router.get("/predictions")
async def get_tennis_predictions(tour: Optional[str] = None):
    """Return all tennis predictions for today."""
    supabase = get_supabase()
    today    = datetime.now(timezone.utc).date().isoformat()
    res      = supabase.table("predictions").select(
        "*, match:matches(sport, league, player1:teams!home_team_id(name), player2:teams!away_team_id(name))"
    ).gte("created_at", f"{today}T00:00:00").execute()
    preds = res.data or []
    if tour:
        preds = [p for p in preds if p.get("match", {}).get("league") == tour]
    return {"predictions": preds, "count": len(preds)}
