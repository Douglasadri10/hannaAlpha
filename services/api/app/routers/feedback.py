from fastapi import APIRouter
from pydantic import BaseModel
from typing import Optional

router = APIRouter()

class Feedback(BaseModel):
    rating: int  # 1..5
    latency_ms: Optional[int] = None
    transcript: Optional[str] = None
    response: Optional[str] = None
    tool_trace: Optional[dict] = None

@router.post("/feedback")
def save_feedback(body: Feedback):
    # MVP: salva em arquivo local (depois trocar por Postgres)
    with open("feedback.log", "a", encoding="utf-8") as f:
        f.write(body.model_dump_json() + "\n")
    return {"ok": True}
