"""
BetIQ — FastAPI Router: Bets
Endpoints: create bet, update result (won/lost), get bets by user/week
"""
from datetime import datetime, timezone, date
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from services.supabase_client import get_supabase

router = APIRouter()


class CreateBetRequest(BaseModel):
    user_id:       str
    match_id:      Optional[str] = None
    prediction_id: Optional[str] = None
    bet_type:      str  # "fixed" | "parlay"
    bookmaker:     str  # "rushbet" | "betplay"
    market:        str  # "moneyline" | "over_under" | "spread"
    selection:     str  # "home" | "away" | "over" | "under"
    odd_at_bet:    float
    amount_cop:    int
    bet_week:      Optional[str] = None  # ISO date YYYY-MM-DD


class UpdateBetResultRequest(BaseModel):
    status:       str   # "won" | "lost" | "void"
    loss_reason:  Optional[str] = None
    loss_description: Optional[str] = None


@router.post("/")
async def create_bet(req: CreateBetRequest):
    """Register a confirmed bet."""
    supabase = get_supabase()

    bet_week = req.bet_week or date.today().isoformat()

    bet_data = {
        "user_id":      req.user_id,
        "bet_type":     req.bet_type,
        "bookmaker":    req.bookmaker,
        "market":       req.market,
        "selection":    req.selection,
        "odd_at_bet":   req.odd_at_bet,
        "amount_cop":   req.amount_cop,
        "status":       "pending",
        "bet_week":     bet_week,
        "created_at":   datetime.now(timezone.utc).isoformat(),
    }
    if req.match_id:
        bet_data["match_id"] = req.match_id
    if req.prediction_id:
        bet_data["prediction_id"] = req.prediction_id

    res = supabase.table("bets").insert(bet_data).execute()
    if not res.data:
        raise HTTPException(status_code=500, detail="Error creating bet")
    return {"bet": res.data[0]}


@router.patch("/{bet_id}/result")
async def update_bet_result(bet_id: str, req: UpdateBetResultRequest):
    """Mark a bet as won or lost. Calculates P&L and optionally creates loss_analysis."""
    supabase = get_supabase()

    if req.status not in ("won", "lost", "void"):
        raise HTTPException(status_code=422, detail="status must be 'won', 'lost' or 'void'")

    # Fetch bet
    bet_res = supabase.table("bets").select("*").eq("id", bet_id).execute()
    if not bet_res.data:
        raise HTTPException(status_code=404, detail="Bet not found")
    bet = bet_res.data[0]

    amount     = bet["amount_cop"]
    potential  = bet.get("potential_win_cop") or int(amount * float(bet.get("odd_at_bet", 2.0)))

    if req.status == "won":
        profit_loss = potential - amount
    elif req.status == "lost":
        profit_loss = -amount
    else:
        profit_loss = 0

    update_data = {
        "status":               req.status,
        "profit_loss_cop":      profit_loss,
        "result_confirmed_at":  datetime.now(timezone.utc).isoformat(),
    }
    if req.loss_reason:
        update_data["loss_reason"] = req.loss_reason

    supabase.table("bets").update(update_data).eq("id", bet_id).execute()

    # Create loss_analysis if lost
    if req.status == "lost" and req.loss_reason:
        VALID_CATEGORIES = {
            "variance", "model_overconfidence",
            "odds_value_poor", "recent_form_ignored", "injury_key_player"
        }
        category = req.loss_reason if req.loss_reason in VALID_CATEGORIES else "variance"
        supabase.table("loss_analysis").insert({
            "bet_id":           bet_id,
            "reason_category":  category,
            "description":      req.loss_description or f"Apuesta perdida — categoría: {category}",
            "weight_adjustment": {},
            "created_at":       datetime.now(timezone.utc).isoformat(),
        }).execute()

    return {
        "bet_id":      bet_id,
        "status":      req.status,
        "profit_loss": profit_loss,
    }


@router.get("/user/{user_id}")
async def get_user_bets(
    user_id: str,
    bet_week: Optional[str] = None,
    status:   Optional[str] = None,
    sport:    Optional[str] = None,
    limit:    int = 50,
    offset:   int = 0,
):
    """Return bets for a user, optionally filtered by week/status."""
    supabase = get_supabase()

    query = supabase.table("bets").select(
        "*, match:matches(sport, league, home_team:teams!home_team_id(name), away_team:teams!away_team_id(name)), "
        "prediction:predictions(confidence, expected_value)"
    ).eq("user_id", user_id)

    if bet_week:
        query = query.eq("bet_week", bet_week)
    if status:
        query = query.eq("status", status)

    res = query.order("created_at", desc=True).range(offset, offset + limit - 1).execute()
    bets = res.data or []

    if sport:
        bets = [b for b in bets if b.get("match", {}) and b["match"].get("sport") == sport]

    return {"bets": bets, "count": len(bets)}


@router.get("/user/{user_id}/weekly-summary")
async def get_weekly_summary(user_id: str, bet_week: Optional[str] = None):
    """
    Aggregated P&L summary for a user's week.
    Uses the weekly_summary_security() function from DB.
    """
    supabase = get_supabase()
    week = bet_week or date.today().isoformat()

    bets_res = supabase.table("bets").select("*").eq("user_id", user_id).eq("bet_week", week).execute()
    bets = bets_res.data or []

    total_apostado = sum(b["amount_cop"] for b in bets)
    total_ganado   = sum((b.get("potential_win_cop") or 0) for b in bets if b["status"] == "won")
    total_perdido  = sum(b["amount_cop"] for b in bets if b["status"] == "lost")
    profit_loss    = sum((b.get("profit_loss_cop") or 0) for b in bets)

    won_count  = sum(1 for b in bets if b["status"] == "won")
    lost_count = sum(1 for b in bets if b["status"] == "lost")
    total_fin  = won_count + lost_count

    roi_pct = round(100 * profit_loss / total_apostado, 2) if total_apostado else 0
    success_pct = round(100 * won_count / total_fin, 1) if total_fin else 0

    return {
        "bet_week":      week,
        "user_id":       user_id,
        "total_apostado": total_apostado,
        "total_ganado":  total_ganado,
        "total_perdido": total_perdido,
        "profit_loss":   profit_loss,
        "roi_pct":       roi_pct,
        "tasa_exito":    success_pct,
        "bets_pending":  sum(1 for b in bets if b["status"] == "pending"),
        "bets_won":      won_count,
        "bets_lost":     lost_count,
    }


@router.get("/{bet_id}")
async def get_bet(bet_id: str):
    supabase = get_supabase()
    res = supabase.table("bets").select("*").eq("id", bet_id).execute()
    if not res.data:
        raise HTTPException(status_code=404, detail="Bet not found")
    return {"bet": res.data[0]}
