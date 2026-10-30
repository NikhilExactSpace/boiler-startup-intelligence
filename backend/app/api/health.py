from __future__ import annotations

from fastapi import APIRouter

from ..config import settings
from ..db import query_one

router = APIRouter(tags=["health"])


@router.get("/health")
def health() -> dict:
    booleans = query_one("SELECT COUNT(*) AS boilers FROM boilers") or {}
    return {
        "status": "ok",
        "version": settings.version,
        "kairos_mode": settings.kairos_mode,
        "kairos_configured": settings.kairos_configured,
        "llm_configured": settings.llm_configured,
        "insight_provider": settings.insight_provider,
        "gemini_model": settings.gemini_model,
        "ai_extraction_configured": settings.extraction_ai_configured,
        "extraction_provider": settings.extraction_provider,
        "gemini_extraction_model": settings.gemini_extraction_model,
        "prompt_version": settings.prompt_version,
        "demo_boiler_id": settings.demo_boiler_id,
        "live_time_scale": settings.live_time_scale,
        "boilers": booleans.get("boilers", 0),
        "principle": (
            "Historians say what happened, the approved curve says what should have "
            "happened, analytics quantify the difference, the LLM only explains the evidence."
        ),
    }
