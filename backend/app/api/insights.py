from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from ..config import settings
from ..services import insights, store
from .startups import _context

router = APIRouter(tags=["insights"])


@router.get("/startups/{startup_id}/insight")
def get_insight(startup_id: str) -> dict:
    _, _, _, analysis = _context(startup_id)
    digest = insights.evidence_hash(analysis)
    cached = store.get_latest_insight(startup_id)
    valid = bool(cached and cached["evidence_hash"] == digest)
    return {
        "available": valid,
        "stale": bool(cached and not valid),
        "record": cached["payload"] if valid else None,
        "evidence_hash": digest,
        "llm_configured": settings.llm_configured,
        "provider": settings.insight_provider,
        "model": settings.gemini_model if settings.llm_configured else "deterministic-template",
        "prompt_version": settings.prompt_version,
    }


@router.post("/startups/{startup_id}/insight")
def generate_insight(
    startup_id: str,
    force: bool = Query(default=False),
) -> dict:
    startup, _, curve, analysis = _context(startup_id)
    if not startup:
        raise HTTPException(404, "Startup not found")
    try:
        record = insights.generate(analysis, curve, force=force)
    except Exception as exc:  # the provider layer is defensive; this is a final guard
        raise HTTPException(500, f"Insight generation failed: {exc}") from exc
    return {
        "available": True,
        "record": record["payload"],
        "evidence_hash": record["evidence_hash"],
        "llm_configured": settings.llm_configured,
    }
