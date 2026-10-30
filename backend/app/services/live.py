"""Accelerated live-startup simulator.

Mock mode replays a full startup at ``LIVE_TIME_SCALE`` (default 120x) so a live demo
finishes in under a minute. Detection runs on the simulated historian samples with a
hysteresis rule, and the completed run is stored like any other startup.

When ``KAIROS_MODE=live`` the same detection rule is intended to run against polls of
KairosDB; this demo build exposes the adapter but keeps live plant polling disabled.
"""

from __future__ import annotations

import threading
from datetime import datetime, timedelta, timezone
from typing import Any

from ..config import settings
from ..db import query_one
from ..schemas import DesignCurve
from . import analytics, store
from .mockgen import DEMO_STARTUPS, PRE_ROLL_MIN, generate_startup

_lock = threading.Lock()
_simulators: dict[str, "Simulator"] = {}

DETECTION_RULE = (
    "FDF speed >= 25% sustained for 3 samples while drum pressure < 5 barg"
)


class Simulator:
    def __init__(self, boiler_id: str, startup_type: str = "cold") -> None:
        row = store.latest_curve(boiler_id, startup_type=startup_type)
        if row is None:
            row = store.latest_curve(boiler_id)
        if row is None:
            raise RuntimeError("No approved design curve is available for this boiler")
        self.boiler_id = boiler_id
        self.curve_row = row
        self.curve = DesignCurve.model_validate(row["curve"])
        boiler = store.get_boiler(boiler_id) or {}
        config = (boiler.get("startup_types") or {}).get(startup_type) or {}
        self.startup_type = startup_type
        self.type_duration_min = float(
            config.get("design_duration_min") or self.curve.duration_min
        )
        self.startup_id = _next_startup_id()
        profile = next(
            spec["profile"] for spec in DEMO_STARTUPS if spec["id"] == "S-1042"
        )
        self.full = generate_startup(
            self.curve,
            startup_id=self.startup_id,
            label=f"{self.startup_id} - {startup_type} live startup (simulated)",
            days_ago=0,
            profile=profile,
            startup_type=startup_type,
            type_duration_min=self.type_duration_min,
            source="simulated-live",
            seed=int(datetime.now(timezone.utc).timestamp()) % 10_000,
        )
        self.duration_min = float(self.full["meta"]["actual_duration_min"])
        self.started_wall = datetime.now(timezone.utc).replace(microsecond=0)
        self.t0_wall = self.started_wall + timedelta(
            minutes=PRE_ROLL_MIN / max(1.0, settings.live_time_scale)
        )
        self.stored = False

    # ----------------------------------------------------------------------------------
    def sim_minutes(self) -> float:
        elapsed_s = (datetime.now(timezone.utc) - self.started_wall).total_seconds()
        return -PRE_ROLL_MIN + elapsed_s * settings.live_time_scale / 60.0

    def slice_until(self, minutes: float) -> dict[str, Any]:
        series = self.full["series"]
        step_min = series["step_s"] / 60.0
        start = series["start_min"]
        count = max(1, int((minutes - start) / step_min) + 1)
        sliced = {
            "step_s": series["step_s"],
            "start_min": start,
            "signals": {
                key: values[:count] for key, values in series["signals"].items()
            },
        }
        startup = {
            **self.full,
            "series": sliced,
            "detected_start": self.t0_wall.isoformat(),
            "detected_end": None,
            "status": "in_progress",
            "meta": {
                **self.full["meta"],
                "actual_duration_min": round(max(0.05, min(minutes, self.duration_min)), 2),
                "live": True,
            },
        }
        return startup

    def detection(self, startup: dict[str, Any]) -> dict[str, Any]:
        series = startup["series"]
        step_min = series["step_s"] / 60.0
        start = series["start_min"]
        fdf = series["signals"].get("fdf_speed") or []
        pressure = series["signals"].get("drum_pressure") or []
        if not fdf:
            # Image-derived curves may omit FDF speed. Fall back to drum pressure, then
            # to the first stable samples so a valid curve can still run.
            if pressure:
                run = 0
                for index, value in enumerate(pressure):
                    t = start + index * step_min
                    if value is not None and value >= 0.5:
                        run += 1
                        if run >= 3:
                            return {
                                "detected": True,
                                "at_min": round(t, 2),
                                "latency_min": round(t, 2),
                                "rule": "drum pressure >= 0.5 barg for 3 samples (FDF fallback)",
                                "samples_required": 3,
                            }
                    else:
                        run = 0
            count = sum(1 for value in (pressure or next(iter(series["signals"].values()), [])) if value is not None)
            if count >= 3:
                t = start + min(2, count - 1) * step_min
                return {
                    "detected": True,
                    "at_min": round(t, 2),
                    "latency_min": round(t, 2),
                    "rule": "first stable samples (curve has no FDF or pressure signal)",
                    "samples_required": 3,
                }
            return {
                "detected": False,
                "at_min": None,
                "latency_min": None,
                "rule": DETECTION_RULE,
                "samples_required": 3,
            }
        run = 0
        for index, value in enumerate(fdf):
            t = start + index * step_min
            p = pressure[index] if index < len(pressure) else None
            if value is not None and value >= 25 and (p is None or p < 5):
                run += 1
                if run >= 3:
                    return {
                        "detected": True,
                        "at_min": round(t, 2),
                        "latency_min": round(t, 2),
                        "rule": DETECTION_RULE,
                        "samples_required": 3,
                    }
            else:
                run = 0
        return {
            "detected": False,
            "at_min": None,
            "latency_min": None,
            "rule": DETECTION_RULE,
            "samples_required": 3,
        }

    def snapshot(self) -> dict[str, Any]:
        minutes = self.sim_minutes()
        clipped = min(minutes, self.duration_min)
        startup = self.slice_until(clipped)
        detection = self.detection(startup)

        if not detection["detected"]:
            state = "watching"
        elif minutes < self.duration_min:
            state = "starting"
        else:
            state = "complete"

        # Keep the full approved design trajectory on the chart. Only the actual
        # series is clipped to the replay clock, so the operator can compare live
        # telemetry against the complete design curve instead of a truncated view.
        chart = analytics.build_chart(self.curve, startup, step_min=0.5)
        now_min = max(0.0, min(clipped, self.duration_min))
        chart["now_min"] = round(now_min, 2)

        analysis: dict[str, Any] | None = None
        events: list[dict[str, Any]] = []
        if state != "watching":
            analysis = analytics.analyze(self.curve, startup)
            progress = max(0.0, min(1.0, clipped / self.duration_min))
            analysis["progress_pct"] = round(progress * 100, 1)
            if progress < 0.25 and state != "complete":
                analysis["score"] = {
                    **analysis["score"],
                    "value": None,
                    "status": "not_available",
                    "note": "Score is withheld until 25% of the startup has elapsed.",
                }
            events = list(analysis["events"])
            events.append(
                {
                    "t_min": detection["at_min"],
                    "type": "detection",
                    "severity": "info",
                    "title": "Startup detected",
                    "detail": f"Rule: {DETECTION_RULE}.",
                    "evidence_id": None,
                }
            )
            events.sort(key=lambda event: event["t_min"] if event["t_min"] is not None else 0)

        last_values = {}
        series = startup["series"]
        step_min = series["step_s"] / 60.0
        series_start = series["start_min"]
        for signal in self.curve.signals:
            column = series["signals"].get(signal.key) or []
            value = column[-1] if column else None
            t_last = series_start + (len(column) - 1) * step_min if column else None
            expected = None
            track = None
            if t_last is not None:
                expected, track = analytics.expected_at(signal, t_last)
            tolerance = track.tolerance if track is not None else None
            delta = (
                value - expected
                if value is not None and expected is not None
                else None
            )
            last_values[signal.key] = {
                "label": signal.label,
                "unit": signal.unit,
                "kind": signal.kind,
                "decimals": signal.decimals,
                "value": value,
                "expected": (
                    round(expected, signal.decimals) if expected is not None else None
                ),
                "delta": round(delta, signal.decimals) if delta is not None else None,
                "tolerance": (
                    round(tolerance, signal.decimals) if tolerance is not None else None
                ),
                "lo": (
                    round(expected - tolerance, signal.decimals)
                    if expected is not None and tolerance is not None
                    else None
                ),
                "hi": (
                    round(expected + tolerance, signal.decimals)
                    if expected is not None and tolerance is not None
                    else None
                ),
                "in_band": (
                    abs(delta) <= tolerance + 1e-9
                    if delta is not None and tolerance is not None
                    else None
                ),
                "t_min": round(t_last, 2) if t_last is not None else None,
            }

        if state == "complete" and not self.stored:
            self._store(startup, analysis)
            startup = {**startup, "status": "complete", "detected_end": self.full["detected_end"]}
            analysis = analytics.analyze(self.curve, {**self.full, "detected_start": self.t0_wall.isoformat()})
            analysis["progress_pct"] = 100.0
            events = list(analysis["events"])

        row = store.get_startup(self.startup_id) if self.stored else None

        return {
            "mode": settings.kairos_mode,
            "simulated": settings.kairos_mode == "mock",
            "classification": classify_startup_type(self.boiler_id),
            "time_scale": settings.live_time_scale,
            "state": state,
            "sim_minutes": round(minutes, 2),
            "now_min": round(max(0.0, min(clipped, self.duration_min)), 2),
            "progress_pct": (
                100.0
                if state == "complete"
                else round(max(0.0, min(100.0, clipped / self.duration_min * 100)), 1)
            ),
            "design_duration_min": round(self.type_duration_min, 2),
            "actual_duration_min": self.duration_min,
            "startup_type": self.startup_type,
            "detection": detection,
            "startup": (
                {
                    "id": self.startup_id,
                    "label": self.full["label"],
                    "detected_start": self.t0_wall.isoformat(),
                    "detected_end": self.full["detected_end"] if state == "complete" else None,
                    "status": state,
                    "source": "simulated-live",
                    "startup_type": self.startup_type,
                    "stored": self.stored,
                    "row": row,
                }
                if state != "watching"
                else None
            ),
            "curve": {
                "id": self.curve.curve_id,
                "name": self.curve.name,
                "document": self.curve.source.document,
                "revision": self.curve.source.revision,
                "design_duration_min": round(self.curve.duration_min, 2),
                "events": (self.curve.extras or {}).get("digitization", {}).get("events", []),
                "mill_cut_in": (self.curve.extras or {}).get("digitization", {}).get("mill_cut_in", []),
                "live_highlights": (self.curve.extras or {}).get("digitization", {}).get("live_highlights", []),
            },
            "chart": chart,
            "analysis": analysis,
            "events": events[-10:],
            "last_values": last_values,
            "llm_configured": settings.llm_configured,
            "note": (
                f"Simulated historian at {settings.live_time_scale:g}x. "
                "Not a real plant feed."
                if settings.kairos_mode == "mock"
                else "Live Kairos polling is not enabled in this build."
            ),
        }

    def _store(self, startup: dict[str, Any], analysis: dict[str, Any] | None) -> None:
        final = {
            **self.full,
            "detected_start": self.t0_wall.isoformat(),
            "detected_end": (
                self.t0_wall + timedelta(minutes=self.duration_min)
            ).isoformat(),
            "status": "complete",
            "source": "simulated-live",
            "curve_id": self.curve_row["id"],
        }
        final_analysis = analytics.analyze(self.curve, final)
        final["meta"] = {
            **final["meta"],
            "curve_id": self.curve_row["id"],
            "score_status": final_analysis["score"]["status"],
            "violations": len(final_analysis["violations"]),
            "abort_observations": len(
                [f for f in final_analysis["abort_flags"] if f["type"] == "observed_threshold"]
            ),
            "lag_minutes": final_analysis["lag"]["minutes"],
            "top_deviation": (
                final_analysis["violations"][0]["statement"]
                if final_analysis["violations"]
                else None
            ),
            "live": True,
        }
        store.save_startup(final, score=final_analysis["score"]["value"], curve_id=self.curve_row["id"])
        self.stored = True


def _next_startup_id() -> str:
    row = query_one(
        "SELECT MAX(CAST(SUBSTR(id, 3) AS INTEGER)) AS n FROM startups WHERE id LIKE 'S-%'"
    )
    n = int((row or {}).get("n") or 1000) + 1
    return f"S-{n:04d}"


def classify_startup_type(boiler_id: str) -> dict[str, Any]:
    boiler = store.get_boiler(boiler_id) or {}
    thresholds = boiler.get("type_thresholds") or {}
    hot_max = float(thresholds.get("hot_max_hours", 4))
    warm_max = float(thresholds.get("warm_max_hours", 96))
    rows = store.list_startups(boiler_id)
    last = next((row for row in rows if row.get("detected_end")), None)
    if not last:
        return {
            "startup_type": "cold",
            "hours_since_shutdown": None,
            "hot_max_hours": hot_max,
            "warm_max_hours": warm_max,
            "last_shutdown": None,
        }
    shutdown = datetime.fromisoformat(str(last["detected_end"]).replace("Z", "+00:00"))
    hours = max(0.0, (datetime.now(timezone.utc) - shutdown).total_seconds() / 3600.0)
    if hours <= hot_max:
        startup_type = "hot"
    elif hours <= warm_max:
        startup_type = "warm"
    else:
        startup_type = "cold"
    return {
        "startup_type": startup_type,
        "hours_since_shutdown": round(hours, 2),
        "hot_max_hours": hot_max,
        "warm_max_hours": warm_max,
        "last_shutdown": last["detected_end"],
    }


def get_simulator(boiler_id: str, startup_type: str = "cold") -> Simulator:
    with _lock:
        simulator = _simulators.get(boiler_id)
        if simulator is None or simulator.startup_type != startup_type:
            simulator = Simulator(boiler_id, startup_type)
            _simulators[boiler_id] = simulator
        return simulator


def restart(boiler_id: str, startup_type: str = "cold") -> Simulator:
    with _lock:
        simulator = Simulator(boiler_id, startup_type)
        _simulators[boiler_id] = simulator
        return simulator
