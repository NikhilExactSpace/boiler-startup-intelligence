"""Database repositories."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from ..db import dumps, execute, loads, query, query_one
from ..schemas import DesignCurve
from .curves import curve_hash


def _now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


# --------------------------------------------------------------------------------------
# boilers
# --------------------------------------------------------------------------------------
def list_boilers() -> list[dict[str, Any]]:
    rows = query("SELECT * FROM boilers ORDER BY id")
    for row in rows:
        row["tag_map"] = loads(row.get("tag_map"), {})
        row["startup_types"] = loads(row.get("startup_types"), {})
        row["type_thresholds"] = loads(row.get("type_thresholds"), {})
    return rows


def get_boiler(boiler_id: str) -> dict[str, Any] | None:
    row = query_one("SELECT * FROM boilers WHERE id = ?", (boiler_id,))
    if row:
        row["tag_map"] = loads(row.get("tag_map"), {})
        row["startup_types"] = loads(row.get("startup_types"), {})
        row["type_thresholds"] = loads(row.get("type_thresholds"), {})
    return row


def create_boiler(
    boiler_id: str,
    name: str,
    site: str = "",
    tag_prefix: str = "",
    *,
    kairos_mode: str = "mock",
    tag_map: dict[str, str] | None = None,
    startup_types: dict[str, Any] | None = None,
    type_thresholds: dict[str, Any] | None = None,
) -> dict[str, Any]:
    execute(
        """INSERT OR REPLACE INTO boilers
           (id, name, site, tag_prefix, kairos_mode, tag_map, startup_types, type_thresholds, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            boiler_id,
            name,
            site,
            tag_prefix,
            kairos_mode,
            dumps(tag_map or {}, compact=True),
            dumps(startup_types or {}, compact=True),
            dumps(type_thresholds or {}, compact=True),
            _now(),
        ),
    )
    return get_boiler(boiler_id)  # type: ignore[return-value]


# --------------------------------------------------------------------------------------
# boiler parameters
# --------------------------------------------------------------------------------------
def list_boiler_parameters(boiler_id: str) -> list[dict[str, Any]]:
    return query(
        "SELECT * FROM boiler_parameters WHERE boiler_id = ? ORDER BY label, key",
        (boiler_id,),
    )


def upsert_boiler_parameter(
    boiler_id: str,
    key: str,
    *,
    label: str = "",
    unit: str = "",
    tag: str = "",
    alarm_low: float | None = None,
    alarm_high: float | None = None,
) -> dict[str, Any]:
    execute(
        """INSERT OR REPLACE INTO boiler_parameters
           (boiler_id, key, label, unit, tag, alarm_low, alarm_high, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (boiler_id, key, label, unit, tag, alarm_low, alarm_high, _now()),
    )
    row = query_one(
        "SELECT * FROM boiler_parameters WHERE boiler_id = ? AND key = ?",
        (boiler_id, key),
    )
    return row or {}


def delete_boiler_parameter(boiler_id: str, key: str) -> None:
    execute(
        "DELETE FROM boiler_parameters WHERE boiler_id = ? AND key = ?",
        (boiler_id, key),
    )


def delete_boiler(boiler_id: str) -> None:
    execute(
        """DELETE FROM insights WHERE startup_id IN
           (SELECT id FROM startups WHERE boiler_id = ?)""",
        (boiler_id,),
    )
    execute("DELETE FROM startups WHERE boiler_id = ?", (boiler_id,))
    execute("DELETE FROM design_curves WHERE boiler_id = ?", (boiler_id,))
    execute("DELETE FROM boiler_parameters WHERE boiler_id = ?", (boiler_id,))
    execute("DELETE FROM boilers WHERE id = ?", (boiler_id,))


# --------------------------------------------------------------------------------------
# design curves
# --------------------------------------------------------------------------------------
def _curve_row(row: dict[str, Any]) -> dict[str, Any]:
    row = dict(row)
    row["curve"] = loads(row.get("curve"), {})
    return row


def list_curves(boiler_id: str) -> list[dict[str, Any]]:
    rows = query(
        "SELECT * FROM design_curves WHERE boiler_id = ? AND status != 'archived' "
        "ORDER BY version DESC, created_at DESC",
        (boiler_id,),
    )
    return [_curve_row(row) for row in rows]


def get_curve(curve_id: str) -> dict[str, Any] | None:
    row = query_one("SELECT * FROM design_curves WHERE id = ?", (curve_id,))
    return _curve_row(row) if row else None


def delete_curve(curve_id: str) -> bool:
    """Archive a curve version.

    Curves pinned to stored startups cannot be physically removed without breaking
    history, so deletion hides the version from the selector while keeping it readable
    for the startups that reference it.
    """
    execute("UPDATE design_curves SET status = 'archived' WHERE id = ?", (curve_id,))
    return True


def latest_curve(
    boiler_id: str,
    *,
    startup_type: str | None = None,
    approved_only: bool = True,
) -> dict[str, Any] | None:
    sql = "SELECT * FROM design_curves WHERE boiler_id = ?"
    params: list[Any] = [boiler_id]
    if startup_type:
        sql += " AND startup_type = ?"
        params.append(startup_type)
    if approved_only:
        sql += " AND status = 'approved'"
    sql += " ORDER BY version DESC, created_at DESC LIMIT 1"
    row = query_one(sql, tuple(params))
    return _curve_row(row) if row else None


def insert_curve(curve: DesignCurve, *, tag_map: dict[str, str] | None = None) -> dict[str, Any]:
    existing = query_one(
        "SELECT MAX(version) AS version FROM design_curves WHERE boiler_id = ? AND startup_type = ?",
        (curve.boiler_id, curve.startup_type),
    )
    version = int((existing or {}).get("version") or 0) + 1
    curve_id = curve.curve_id if version == 1 else f"{curve.curve_id}-v{version}"
    model = curve.model_copy(deep=True)
    model.curve_id = curve_id
    execute(
        """INSERT INTO design_curves
           (id, boiler_id, name, version, status, startup_type, curve, source_document, source_revision,
            sha256, approved_by, approved_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            curve_id,
            curve.boiler_id,
            curve.name,
            version,
            curve.status,
            curve.startup_type,
            dumps(model.model_dump(mode="json")),
            curve.source.document,
            curve.source.revision,
            curve_hash(model),
            curve.source.approved_by,
            curve.source.approved_at,
            _now(),
        ),
    )
    if tag_map:
        boiler = get_boiler(curve.boiler_id)
        existing = dict((boiler or {}).get("tag_map") or {})
        merged = {**tag_map, **existing}
        execute(
            "UPDATE boilers SET tag_map = ? WHERE id = ?",
            (dumps(merged, compact=True), curve.boiler_id),
        )
    return get_curve(curve_id)  # type: ignore[return-value]


# --------------------------------------------------------------------------------------
# startups
# --------------------------------------------------------------------------------------
def _startup_row(row: dict[str, Any]) -> dict[str, Any]:
    row = dict(row)
    row["series"] = loads(row.get("series"), {})
    row["meta"] = loads(row.get("meta"), {})
    row["startup_type"] = row.get("startup_type") or row["meta"].get("startup_type") or "cold"
    return row


def list_startups(boiler_id: str, *, status: str | None = None) -> list[dict[str, Any]]:
    sql = "SELECT * FROM startups WHERE boiler_id = ?"
    params: list[Any] = [boiler_id]
    if status:
        sql += " AND status = ?"
        params.append(status)
    sql += " ORDER BY detected_start DESC"
    return [_startup_row(row) for row in query(sql, tuple(params))]


def get_startup(startup_id: str) -> dict[str, Any] | None:
    row = query_one("SELECT * FROM startups WHERE id = ?", (startup_id,))
    return _startup_row(row) if row else None


def save_startup(
    startup: dict[str, Any], *, score: float | None = None, curve_id: str | None = None
) -> dict[str, Any]:
    meta = dict(startup.get("meta") or {})
    execute(
        """INSERT OR REPLACE INTO startups
           (id, boiler_id, curve_id, label, detected_start, detected_end, status, source,
            startup_type, duration_min, score, series, meta, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            startup["id"],
            startup["boiler_id"],
            curve_id or startup.get("curve_id") or "",
            startup["label"],
            startup["detected_start"],
            startup.get("detected_end"),
            startup.get("status", "complete"),
            startup.get("source", "mock"),
            startup.get("startup_type") or meta.get("startup_type") or "cold",
            meta.get("actual_duration_min"),
            score,
            dumps(startup["series"], compact=True),
            dumps(meta, compact=True),
            _now(),
        ),
    )
    return get_startup(startup["id"])  # type: ignore[return-value]


def update_startup_analysis(
    startup_id: str, *, score: float | None, meta_patch: dict[str, Any]
) -> dict[str, Any] | None:
    row = get_startup(startup_id)
    if not row:
        return None
    meta = {**row.get("meta", {}), **meta_patch}
    execute(
        "UPDATE startups SET score = ?, meta = ? WHERE id = ?",
        (score, dumps(meta, compact=True), startup_id),
    )
    return get_startup(startup_id)


# --------------------------------------------------------------------------------------
# insights
# --------------------------------------------------------------------------------------
def get_insight(
    startup_id: str, evidence_hash: str, model: str, prompt_version: str
) -> dict[str, Any] | None:
    row = query_one(
        """SELECT * FROM insights
           WHERE startup_id = ? AND evidence_hash = ? AND model = ? AND prompt_version = ?""",
        (startup_id, evidence_hash, model, prompt_version),
    )
    if not row:
        return None
    row["payload"] = loads(row.get("payload"), {})
    return row


def get_latest_insight(startup_id: str) -> dict[str, Any] | None:
    row = query_one(
        "SELECT * FROM insights WHERE startup_id = ? ORDER BY created_at DESC LIMIT 1",
        (startup_id,),
    )
    if not row:
        return None
    row["payload"] = loads(row.get("payload"), {})
    return row


def save_insight(
    *,
    startup_id: str,
    evidence_hash: str,
    model: str,
    prompt_version: str,
    provider: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    insight_id = f"ins-{uuid.uuid4().hex[:12]}"
    execute(
        """INSERT OR REPLACE INTO insights
           (id, startup_id, evidence_hash, model, prompt_version, provider, payload, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            insight_id,
            startup_id,
            evidence_hash,
            model,
            prompt_version,
            provider,
            dumps(payload),
            _now(),
        ),
    )
    row = query_one("SELECT * FROM insights WHERE id = ?", (insight_id,))
    assert row is not None
    row["payload"] = loads(row.get("payload"), {})
    return row
