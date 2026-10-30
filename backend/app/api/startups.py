from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from ..config import settings
from ..schemas import DesignCurve
from ..services import analytics, insights, store

router = APIRouter(tags=["startups"])

DEFAULT_BOILER = settings.demo_boiler_id


def _context(startup_id: str) -> tuple[dict, dict, DesignCurve, dict]:
    startup = store.get_startup(startup_id)
    if not startup:
        raise HTTPException(404, "Startup not found")
    curve_row = store.get_curve(startup.get("curve_id") or "") or store.latest_curve(
        startup["boiler_id"]
    )
    if not curve_row:
        raise HTTPException(409, "No approved design curve for this boiler")
    curve = DesignCurve.model_validate(curve_row["curve"])
    analysis = analytics.analyze(curve, startup)
    if (
        startup.get("score") != analysis["score"]["value"]
        or (startup.get("meta") or {}).get("score_status") != analysis["score"]["status"]
    ):
        updated = store.update_startup_analysis(
            startup_id,
            score=analysis["score"]["value"],
            meta_patch={
                "score_status": analysis["score"]["status"],
                "violations": len(analysis["violations"]),
                "abort_observations": len(
                    [f for f in analysis["abort_flags"] if f["type"] == "observed_threshold"]
                ),
                "lag_minutes": analysis["lag"]["minutes"],
                "top_deviation": (
                    analysis["violations"][0]["statement"]
                    if analysis["violations"]
                    else None
                ),
            },
        )
        if updated:
            startup = updated
    return startup, curve_row, curve, analysis


def _summary(row: dict) -> dict:
    meta = row.get("meta") or {}
    return {
        "id": row["id"],
        "boiler_id": row["boiler_id"],
        "curve_id": row.get("curve_id"),
        "label": row["label"],
        "detected_start": row["detected_start"],
        "detected_end": row.get("detected_end"),
        "status": row["status"],
        "source": row["source"],
        "startup_type": row.get("startup_type") or meta.get("startup_type") or "cold",
        "duration_min": row.get("duration_min"),
        "design_duration_min": meta.get("design_duration_min"),
        "score": row.get("score"),
        "score_status": meta.get("score_status", "unknown"),
        "lag_minutes": meta.get("lag_minutes"),
        "violations": meta.get("violations", 0),
        "abort_observations": meta.get("abort_observations", 0),
        "top_deviation": meta.get("top_deviation"),
        "live": bool(meta.get("live")),
    }


@router.get("/startups")
def list_startups(
    boiler_id: str = Query(default=DEFAULT_BOILER),
    status: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
) -> list[dict]:
    rows = store.list_startups(boiler_id, status=status)
    return [_summary(row) for row in rows[:limit]]


@router.get("/startups/{startup_id}")
def get_startup(startup_id: str) -> dict:
    startup, curve_row, curve, analysis = _context(startup_id)
    step_min = 0.5
    max_minutes = None
    if startup["status"] == "aborted":
        actual = float((startup.get("meta") or {}).get("actual_duration_min") or 0)
        max_minutes = actual + 8
    chart = analytics.build_chart(curve, startup, step_min=step_min, max_minutes=max_minutes)
    chart["violations"] = analysis["violations"]
    chart["milestones"] = analysis["milestones"]
    cached = store.get_latest_insight(startup_id)
    digest = insights.evidence_hash(analysis)
    insight = None
    if cached and cached["evidence_hash"] == digest:
        insight = cached["payload"]

    return {
        "startup": {
            **_summary(startup),
            "meta": startup.get("meta"),
            "duration_min": (startup.get("meta") or {}).get("actual_duration_min"),
        },
        "curve": {
            "id": curve_row["id"],
            "name": curve.name,
            "version": curve_row["version"],
            "document": curve.source.document,
            "revision": curve.source.revision,
            "approved_by": curve.source.approved_by,
            "approved_at": curve.source.approved_at,
            "design_duration_min": round(curve.duration_min, 2),
            "sha256": curve_row["sha256"],
            "events": (curve.extras or {}).get("digitization", {}).get("events", []),
            "mill_cut_in": (curve.extras or {}).get("digitization", {}).get("mill_cut_in", []),
            "live_highlights": (curve.extras or {}).get("digitization", {}).get("live_highlights", []),
        },
        "chart": chart,
        "analysis": analysis,
        "insight": insight,
        "insight_available": insight is not None,
        "evidence_hash": digest,
        "llm_configured": settings.llm_configured,
    }


@router.get("/startups/{startup_id}/analysis")
def get_analysis(startup_id: str) -> dict:
    _, _, _, analysis = _context(startup_id)
    return {**analysis, "evidence_hash": insights.evidence_hash(analysis)}


@router.get("/startups/{startup_id}/chart")
def get_chart(startup_id: str, step_min: float = Query(default=0.5, ge=0.2, le=2.0)) -> dict:
    startup, _, curve, _ = _context(startup_id)
    return analytics.build_chart(curve, startup, step_min=step_min)


@router.get("/startups/{startup_id}/compare")
def compare(startup_id: str, signals: str | None = Query(default=None)) -> dict:
    target, _, curve, _ = _context(startup_id)
    peers = [
        row
        for row in store.list_startups(target["boiler_id"])
        if row["id"] != startup_id and row["status"] in ("complete", "aborted")
    ]
    keys = [key.strip() for key in signals.split(",")] if signals else None
    comparison = analytics.build_comparison(
        curve,
        [target] + peers,
        step_min=0.5,
        signal_keys=keys,
        envelope_ids=[row["id"] for row in peers],
    )
    comparison["target_id"] = startup_id
    comparison["peer_count"] = len(peers)
    comparison["table"] = [
        _summary(row) for row in [target] + peers
    ]
    return comparison
