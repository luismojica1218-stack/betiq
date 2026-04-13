from fastapi import APIRouter, HTTPException, Query
from services.parlay_builder import ParlayOptimizer

router = APIRouter()

@router.get("/suggest")
def suggest_parlays(
    user_id: str,
    budget_parlay_cop: int = Query(50000, ge=5000),
    max_legs: int = Query(4, ge=2, le=5)
):
    try:
        optimizer = ParlayOptimizer()
        suggestions = optimizer.suggest_parlays(user_id, budget_parlay_cop, max_legs)
        return {"suggestions": suggestions}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
