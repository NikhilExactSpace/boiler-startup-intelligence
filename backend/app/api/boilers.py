from __future__ import annotations

import json
import re

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..config import settings
from ..schemas import DesignCurve, StartupTypeConfig
from ..services import store

router = APIRouter(tags=["boilers"])

DEFAULT_STARTUP_TYPES = {
    "cold": {"enabled": True, "design_duration_min": 480},
    "warm": {"enabled": True, "design_duration_min": 240},
    "hot": {"enabled": True, "design_duration_min": 120},
}


class BoilerIn(BaseModel):
    id: str = Field(min_length=2, max_length=24)
    name: str = Field(min_length=2, max_length=80)
    site: str = ""
    tag_prefix: str = ""
    kairos_mode: str | None = None
    tag_map: dict[str, str] = Field(default_factory=dict)
    startup_types: dict[str, StartupTypeConfig] = Field(default_factory=dict)
    type_thresholds: dict[str, float] = Field(default_factory=dict)


class BoilerUpdateIn(BaseModel):
    name: str | None = None
    startup_types: dict[str, StartupTypeConfig] | None = None
    type_thresholds: dict[str, float] | None = None


class BoilerParameterIn(BaseModel):
    key: str = Field(min_length=1, max_length=64)
    label: str = ""
    unit: str = ""
    tag: str = ""
    alarm_low: float | None = None
    alarm_high: float | None = None


def _startup_types(value: dict | None) -> dict:
    merged = {key: dict(cfg) for key, cfg in DEFAULT_STARTUP_TYPES.items()}
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            value = {}
    for key, cfg in (value or {}).items():
        if key not in merged:
            continue
        merged[key] = {
            "enabled": bool(cfg.get("enabled", True)),
            "design_duration_min": float(cfg.get("design_duration_min", merged[key]["design_duration_min"])),
        }
    return merged


@router.put("/boilers/{boiler_id}")
def update_boiler(boiler_id: str, payload: BoilerUpdateIn) -> dict:
    boiler = store.get_boiler(boiler_id)
    if not boiler:
        raise HTTPException(404, "Boiler not found")
    startup_types = (
        _startup_types({key: cfg.model_dump() for key, cfg in payload.startup_types.items()})
        if payload.startup_types is not None
        else boiler.get("startup_types") or {}
    )
    type_thresholds = (
        payload.type_thresholds
        if payload.type_thresholds is not None
        else boiler.get("type_thresholds") or {}
    )
    hot = float(type_thresholds.get("hot_max_hours", 4))
    warm = float(type_thresholds.get("warm_max_hours", 96))
    if not (0 < hot < warm):
        raise HTTPException(400, "Hot threshold must be below the warm threshold.")
    store.create_boiler(
        boiler_id,
        payload.name or boiler["name"],
        boiler.get("site") or "",
        boiler.get("tag_prefix") or "",
        kairos_mode=boiler.get("kairos_mode") or settings.kairos_mode,
        tag_map=boiler.get("tag_map") or {},
        startup_types=startup_types,
        type_thresholds=type_thresholds,
    )
    return {"ok": True, "id": boiler_id}


@router.delete("/boilers/{boiler_id}")
def delete_boiler(boiler_id: str) -> dict:
    if not store.get_boiler(boiler_id):
        raise HTTPException(404, "Boiler not found")
    store.delete_boiler(boiler_id)
    return {"ok": True, "id": boiler_id}


@router.put("/boilers/{boiler_id}/parameters/{key}")
def upsert_parameter(
    boiler_id: str, key: str, payload: BoilerParameterIn
) -> dict:
    if not store.get_boiler(boiler_id):
        raise HTTPException(404, "Boiler not found")
    if payload.alarm_low is not None and payload.alarm_high is not None:
        if payload.alarm_low >= payload.alarm_high:
            raise HTTPException(400, "Alarm low must be below alarm high.")
    row = store.upsert_boiler_parameter(
        boiler_id,
        key,
        label=payload.label,
        unit=payload.unit,
        tag=payload.tag,
        alarm_low=payload.alarm_low,
        alarm_high=payload.alarm_high,
    )
    return {"ok": True, "parameter": row}


@router.delete("/boilers/{boiler_id}/parameters/{key}")
def delete_parameter(boiler_id: str, key: str) -> dict:
    store.delete_boiler_parameter(boiler_id, key)
    return {"ok": True, "key": key}
@router.get("/boilers")
def list_boilers() -> list[dict]:
    boilers = store.list_boilers()
    out = []
    for boiler in boilers:
        curve_row = store.latest_curve(boiler["id"])
        curve = DesignCurve.model_validate(curve_row["curve"]) if curve_row else None
        out.append(
            {
                "id": boiler["id"],
                "name": boiler["name"],
                "site": boiler["site"],
                "tag_prefix": boiler["tag_prefix"],
                "kairos_mode": boiler["kairos_mode"],
                "tag_map": boiler["tag_map"],
                "startup_types": _startup_types(boiler.get("startup_types")),
                "type_thresholds": boiler.get("type_thresholds") or {},
                "parameters": store.list_boiler_parameters(boiler["id"]),
                "created_at": boiler["created_at"],
                "curve": (
                    {
                        "id": curve_row["id"],
                        "name": curve.name,
                        "version": curve_row["version"],
                        "document": curve.source.document,
                        "revision": curve.source.revision,
                        "design_duration_min": round(curve.duration_min, 2),
                        "signals": len(curve.signals),
                        "phases": len(curve.phases),
                        "approved_by": curve.source.approved_by,
                        "approved_at": curve.source.approved_at,
                    }
                    if curve
                    else None
                ),
                "startups": len(store.list_startups(boiler["id"])),
            }
        )
    return out


@router.post("/boilers", status_code=201)
def create_boiler(payload: BoilerIn) -> dict:
    if not re.fullmatch(r"[A-Za-z0-9_-]{2,24}", payload.id):
        raise HTTPException(400, "Boiler id may only contain letters, numbers, '-' and '_'.")
    if store.get_boiler(payload.id):
        raise HTTPException(409, "A boiler with this id already exists. Select it instead of re-adding.")
    startup_types = _startup_types(
        {key: cfg.model_dump() for key, cfg in payload.startup_types.items()}
    )
    durations = {
        key: value["design_duration_min"]
        for key, value in startup_types.items()
        if value["enabled"]
    }
    if "cold" in durations and "warm" in durations and durations["cold"] < durations["warm"]:
        raise HTTPException(400, "Cold startup duration must be greater than or equal to warm.")
    if "warm" in durations and "hot" in durations and durations["warm"] < durations["hot"]:
        raise HTTPException(400, "Warm startup duration must be greater than or equal to hot.")
    if payload.type_thresholds:
        hot = float(payload.type_thresholds.get("hot_max_hours", 4))
        warm = float(payload.type_thresholds.get("warm_max_hours", 96))
        if not (0 < hot < warm):
            raise HTTPException(400, "Hot threshold must be greater than 0 and less than the warm threshold.")
    store.create_boiler(
        payload.id,
        payload.name,
        payload.site,
        payload.tag_prefix,
        kairos_mode=payload.kairos_mode or settings.kairos_mode,
        tag_map=payload.tag_map,
        startup_types=startup_types,
        type_thresholds=payload.type_thresholds,
    )
    return {"ok": True, "id": payload.id, "next": "Approve a design curve for this boiler."}
