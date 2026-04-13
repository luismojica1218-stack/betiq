from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from services.loss_analyzer import LossAnalyzer

router = APIRouter()

class AnalyzeRequest(BaseModel):
    bet_id: str

@router.post("/loss")
def analyze_loss(payload: AnalyzeRequest):
    try:
        analyzer = LossAnalyzer()
        result = analyzer.analyze_loss(payload.bet_id)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/patterns/{user_id}")
def get_user_patterns(user_id: str):
    try:
        analyzer = LossAnalyzer()
        patterns = analyzer.get_patterns(user_id)
        return {"patterns": patterns}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
