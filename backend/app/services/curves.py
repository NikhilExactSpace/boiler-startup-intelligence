"""Curve loading, hashing and approval helpers."""

from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path

from ..schemas import DesignCurve

SEED_DIR = Path(__file__).resolve().parent.parent / "seed"
SEED_CURVE = SEED_DIR / "curve_b101_sop202.json"
SOP_TEXT = SEED_DIR / "sop202.txt"


def load_seed_text() -> str:
    return SOP_TEXT.read_text(encoding="utf-8")


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def sha256_bytes(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def load_seed_curve() -> DesignCurve:
    payload = json.loads(SEED_CURVE.read_text(encoding="utf-8"))
    text = load_seed_text()
    payload["source"]["sha256"] = sha256_text(text)
    payload["source"]["approved_at"] = payload["source"].get(
        "approved_at", datetime.now(timezone.utc).isoformat()
    )
    return DesignCurve.model_validate(payload)


def canonical_json(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def curve_hash(curve: DesignCurve) -> str:
    return sha256_text(canonical_json(curve.model_dump(mode="json")))


def slugify(value: str) -> str:
    lowered = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return lowered or "curve"


def scaled_curve(
    curve: DesignCurve, *, startup_type: str, duration_min: float
) -> DesignCurve:
    """Return a type-specific copy of an approved curve with scaled time axes."""
    base_duration = curve.duration_min
    if base_duration <= 0 or duration_min <= 0:
        return curve.model_copy(deep=True)
    factor = duration_min / base_duration
    payload = curve.model_dump(mode="json")
    payload["curve_id"] = f"{curve.curve_id}-{startup_type}"
    payload["name"] = f"{curve.name} · {startup_type.title()}"
    payload["startup_type"] = startup_type
    for phase in payload["phases"]:
        phase["start_min"] = round(phase["start_min"] * factor, 4)
        phase["end_min"] = round(phase["end_min"] * factor, 4)
    for signal in payload["signals"]:
        for track in signal.get("design", []):
            for point in track.get("points", []):
                point["t"] = round(point["t"] * factor, 4)
        for limit in signal.get("limits", []):
            if limit.get("active_from_min") is not None:
                limit["active_from_min"] = round(limit["active_from_min"] * factor, 4)
            if limit.get("active_to_min") is not None:
                limit["active_to_min"] = round(limit["active_to_min"] * factor, 4)
    return DesignCurve.model_validate(payload)


def approved_curve(
    curve: DesignCurve, *, approved_by: str, version: int, base_id: str | None = None
) -> DesignCurve:
    payload = curve.model_dump(mode="json")
    stamp = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    base = base_id or payload["curve_id"]
    base = re.sub(r"[^a-zA-Z0-9._-]+", "-", str(base)).strip("-").lower() or "curve"
    payload["curve_id"] = base if version <= 1 else f"{base}-v{version}"
    payload["status"] = "approved"
    payload["source"]["approved_by"] = approved_by
    payload["source"]["approved_at"] = stamp
    return DesignCurve.model_validate(payload)
