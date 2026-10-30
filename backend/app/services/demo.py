"""Demo seeding.

Called once on startup so the dashboard is populated before anyone clicks anything.
Every demo startup is generated from the approved curve and then scored by the same
analytics used for live data.
"""

from __future__ import annotations

from typing import Any

from ..config import settings
from ..db import execute, init_db, query_one
from ..schemas import DesignCurve
from . import analytics, store
from .curves import load_seed_curve, scaled_curve
from .mockgen import DEMO_STARTUPS, generate_startup


def seed_demo(*, reset: bool = False) -> dict[str, Any]:
    init_db()
    existing = query_one(
        "SELECT id FROM boilers WHERE id = ?", (settings.demo_boiler_id,)
    )
    if existing and not reset:
        return {"seeded": False, "boiler_id": settings.demo_boiler_id}

    if reset:
        execute("DELETE FROM insights")
        execute("DELETE FROM startups")
        execute("DELETE FROM design_curves")
        execute("DELETE FROM boilers")

    curve = load_seed_curve()
    store.create_boiler(
        curve.boiler_id,
        "Boiler B-101",
        site="Main Processing Unit",
        tag_prefix="B101.",
        kairos_mode=settings.kairos_mode,
        tag_map={signal.key: signal.kairos.metric for signal in curve.signals},
        startup_types={
            "cold": {"enabled": True, "design_duration_min": 107},
            "warm": {"enabled": True, "design_duration_min": 80},
            "hot": {"enabled": True, "design_duration_min": 55},
        },
        type_thresholds={"hot_max_hours": 4, "warm_max_hours": 96},
    )
    saved_curve = store.insert_curve(curve)
    curve_id = saved_curve["id"]
    type_curves = {"cold": (curve, curve_id)}
    for startup_type, duration in (("warm", 80.0), ("hot", 55.0)):
        variant = scaled_curve(curve, startup_type=startup_type, duration_min=duration)
        row = store.insert_curve(variant)
        type_curves[startup_type] = (variant, row["id"])

    created = []
    for spec in DEMO_STARTUPS:
        startup_type = spec.get("startup_type", "cold")
        active_curve, active_curve_id = type_curves[startup_type]
        startup = generate_startup(
            active_curve,
            startup_id=spec["id"],
            label=spec["label"],
            days_ago=float(spec["days_ago"]),
            profile=spec["profile"],
            startup_type=startup_type,
            type_duration_min=spec.get("type_duration_min"),
            seed=sum(ord(char) for char in spec["id"]),
        )
        startup["curve_id"] = active_curve_id
        analysis = analytics.analyze(active_curve, startup)
        startup["meta"] = {
            **startup["meta"],
            "curve_id": active_curve_id,
            "design_duration_min": spec.get("type_duration_min", active_curve.duration_min),
            "score_status": analysis["score"]["status"],
            "violations": len(analysis["violations"]),
            "abort_observations": len(
                [f for f in analysis["abort_flags"] if f["type"] == "observed_threshold"]
            ),
            "lag_minutes": analysis["lag"]["minutes"],
            "top_deviation": (
                analysis["violations"][0]["statement"] if analysis["violations"] else None
            ),
        }
        store.save_startup(
            startup,
            score=analysis["score"]["value"],
            curve_id=active_curve_id,
        )
        created.append(spec["id"])

    return {
        "seeded": True,
        "boiler_id": curve.boiler_id,
        "curve_id": curve_id,
        "startups": created,
    }


def curve_for_startup(startup: dict[str, Any]) -> tuple[dict[str, Any], DesignCurve]:
    row = store.get_curve(startup.get("curve_id") or "")
    if row is None:
        row = store.latest_curve(startup["boiler_id"])
    if row is None:
        raise RuntimeError("No approved design curve is available for this boiler")
    return row, DesignCurve.model_validate(row["curve"])
