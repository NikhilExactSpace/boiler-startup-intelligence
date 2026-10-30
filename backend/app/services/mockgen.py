"""Synthetic startup generator for the demo.

The generator only exists because a demo needs data. It deliberately consumes the
approved curve and injects a small, documented set of deviations, so every rendered
number can be traced back to the curve. When ``KAIROS_MODE=live`` the same downstream
analytics consume real historian data instead.
"""

from __future__ import annotations

import hashlib
import math
import random
from datetime import datetime, timedelta, timezone
from typing import Any

from ..schemas import DesignCurve

STEP_S = 15
PRE_ROLL_MIN = 15.0


def _actual_bounds(
    curve: DesignCurve, profile: dict[str, Any]
) -> tuple[dict[str, tuple[float, float]], float]:
    bounds: dict[str, tuple[float, float]] = {}
    cursor = 0.0
    ramp_scale = profile.get("ramp_scale", {})
    for phase in sorted(curve.phases, key=lambda p: p.order):
        duration = phase.end_min - phase.start_min
        if phase.key == "purge":
            duration += float(profile.get("purge_extra_min", 0.0))
        if phase.key in ramp_scale:
            duration /= float(ramp_scale[phase.key])
        bounds[phase.key] = (cursor, cursor + duration)
        cursor += duration
    if profile.get("abort_at_min") is not None:
        cursor = min(cursor, float(profile["abort_at_min"]))
    return bounds, round(cursor, 3)


def _phase_at(bounds: dict[str, tuple[float, float]], t: float) -> str | None:
    for key, (start, end) in bounds.items():
        if start - 1e-9 <= t < end - 1e-9:
            return key
    if bounds:
        last_key = list(bounds.keys())[-1]
        if t >= bounds[last_key][1] - 1e-9:
            return last_key
        if t < 0:
            return None
    return None


def _design_time(curve: DesignCurve, phase_key: str, t: float, bounds: dict[str, tuple[float, float]]) -> float:
    phase = curve.phase_map[phase_key]
    a0, a1 = bounds[phase_key]
    if a1 - a0 <= 1e-9:
        return phase.start_min
    ratio = min(1.0, max(0.0, (t - a0) / (a1 - a0)))
    return phase.start_min + ratio * (phase.end_min - phase.start_min)


def _ramp_slope(curve: DesignCurve, phase_key: str) -> float:
    signal = curve.signal_map.get("drum_pressure")
    if not signal:
        return 0.0
    for track in signal.design:
        if track.phase != phase_key:
            continue
        delta_t = track.points[-1].t - track.points[0].t
        if delta_t <= 0:
            continue
        return (track.points[-1].value - track.points[0].value) / delta_t
    return 0.0


def _gauss(t: float, centre: float, width: float) -> float:
    if width <= 0:
        return 0.0
    return math.exp(-((t - centre) ** 2) / (2.0 * width**2))


def _value(
    key: str,
    t: float,
    *,
    pressure: float,
    profile: dict[str, Any],
    curve: DesignCurve,
    bounds: dict[str, tuple[float, float]],
    rng: random.Random,
) -> float:
    pilot_start, pilot_end = bounds.get("pilot", (5.0, 6.0))
    ramp_end = bounds.get("ramp_30_50", (72.0, 73.0))[1]
    noise = profile.get("noise", 1.0)
    level_dip = profile.get("level_dip")
    nox_amp = profile.get("nox_amp", 26.0)
    sh_overshoot = profile.get("sh_overshoot")
    furnace_spike = profile.get("furnace_spike")
    fg_drop = profile.get("fg_drop")

    if key == "drum_pressure":
        return pressure
    if key == "drum_level":
        base = 66.0 if t < 0 else 66.0 - 0.22 * min(pressure, 50.0)
        if level_dip:
            base -= float(level_dip["depth"]) * _gauss(
                t, float(level_dip["at"]), float(level_dip.get("width", 3.5))
            )
        return base + rng.gauss(0, 0.55 * noise)
    if key == "superheater_outlet_temp":
        if t < 0:
            base = 95.0
        else:
            base = 110.0 + 6.2 * min(pressure, 50.0)
        if sh_overshoot:
            base += float(sh_overshoot["amplitude"]) * _gauss(
                t, float(sh_overshoot["at"]), float(sh_overshoot.get("width", 5.0))
            )
        return base + rng.gauss(0, 2.4 * noise)
    if key == "nox":
        base = 8.0 + 0.28 * min(pressure, 50.0) if t >= 0 else 8.0
        base += nox_amp * _gauss(t, pilot_start + 1.5, 1.1)
        return max(2.0, base + rng.gauss(0, 1.6 * noise))
    if key == "furnace_pressure":
        base = -0.5 + rng.gauss(0, 0.35 * noise)
        if furnace_spike:
            base += float(furnace_spike["amplitude"]) * _gauss(
                t, float(furnace_spike["at"]), float(furnace_spike.get("width", 0.8))
            )
        return base
    if key == "fuel_gas_pressure":
        base = 3.8 if t < 25 else 3.8 - 0.002 * (t - 25)
        if fg_drop and float(fg_drop["at"]) <= t <= float(fg_drop["at"]) + float(fg_drop.get("hold", 2.5)):
            base = float(fg_drop["to"])
        return base + rng.gauss(0, 0.07 * noise)
    if key == "fdf_speed":
        if t < 0:
            return 0.0
        if t < 0.5:
            return min(30.0, (t / 0.5) * 30.0) + rng.gauss(0, 0.4 * noise)
        if t < pilot_end:
            return 30.0 + rng.gauss(0, 0.4 * noise)
        if t < ramp_end:
            progress = (t - pilot_end) / max(0.1, ramp_end - pilot_end)
            return 32.0 + 23.0 * progress + rng.gauss(0, 0.5 * noise)
        return 55.0 + rng.gauss(0, 0.5 * noise)
    if key == "flame_detected":
        ignition = pilot_start + float(profile.get("flame_delay_s", 2.0)) / 60.0
        if t >= ignition:
            return 1.0
        return 0.0
    if key == "fw_tank_level":
        return 71.0 - 0.02 * max(t, 0.0) + rng.gauss(0, 0.35 * noise)
    if key == "instrument_air_pressure":
        return 6.4 + rng.gauss(0, 0.025 * noise)
    if key == "fuel_gas_header_temp":
        return 28.0 + 0.09 * max(t, 0.0) + rng.gauss(0, 0.3 * noise)
    if key == "main_steam_pressure":
        return max(0.0, pressure * 0.92)
    if key == "main_steam_temp":
        return 160.0 + max(0.0, pressure) * 4.8 + rng.gauss(0, 0.8 * noise)
    if key == "reheat_steam_temp":
        return 150.0 + max(0.0, pressure) * 4.2 + rng.gauss(0, 0.8 * noise)
    if key == "reheat_steam_pressure":
        return max(0.0, pressure * 0.22)
    if key == "main_steam_flow":
        return max(0.0, pressure * 7.8) + rng.gauss(0, 0.6 * noise)
    if key == "turbine_flow":
        return max(0.0, pressure * 8.6) + rng.gauss(0, 0.7 * noise)
    if key == "load_mw":
        return max(0.0, pressure * 11.5) + rng.gauss(0, 1.0 * noise)
    if key == "turbine_speed":
        return max(0.0, min(3000.0, pressure * 62.0)) + rng.gauss(0, 4.0 * noise)
    return 0.0


def generate_startup(
    curve: DesignCurve,
    *,
    startup_id: str,
    label: str,
    days_ago: float,
    profile: dict[str, Any],
    startup_type: str = "cold",
    type_duration_min: float | None = None,
    source: str = "mock",
    seed: int | None = None,
) -> dict[str, Any]:
    rng = random.Random(
        seed
        if seed is not None
        else int(hashlib.sha256(startup_id.encode("utf-8")).hexdigest()[:8], 16)
    )
    bounds, actual_duration = _actual_bounds(curve, profile)
    if type_duration_min and startup_type != "cold" and actual_duration > 0:
        scale = float(type_duration_min) / actual_duration
        bounds = {
            key: (start * scale, end * scale) for key, (start, end) in bounds.items()
        }
        actual_duration = float(type_duration_min)
    end_min = actual_duration
    aborted = profile.get("abort_at_min") is not None

    step_min = STEP_S / 60.0
    t = -PRE_ROLL_MIN
    times: list[float] = []
    while t < end_min - 1e-9:
        times.append(round(t, 4))
        t += step_min
    times.append(round(end_min, 4))

    # drum pressure is integrated so a slower ramp really is slower
    pressure_values: list[float] = []
    ramp_scale = profile.get("ramp_scale", {})
    integrated = 0.22
    for current in times:
        if current < 0:
            pressure_values.append(round(0.22 + rng.gauss(0, 0.012), 4))
            continue
        phase_key = _phase_at(bounds, current) or "purge"
        integrated += _ramp_slope(curve, phase_key) * float(ramp_scale.get(phase_key, 1.0)) * step_min
        integrated = min(integrated, 50.4)
        pressure_values.append(
            round(max(0.0, integrated + rng.gauss(0, 0.05 * profile.get("noise", 1.0))), 4)
        )

    signals: dict[str, list[float]] = {}
    for signal in sorted(curve.signals, key=lambda s: s.chart_order):
        values = []
        for current, pressure in zip(times, pressure_values):
            value = _value(
                signal.key,
                current,
                pressure=pressure,
                profile=profile,
                curve=curve,
                bounds=bounds,
                rng=rng,
            )
            if signal.kind == "state":
                value = 1.0 if value >= 0.5 else 0.0
            values.append(round(value, signal.decimals))
        signals[signal.key] = values

    started = datetime.now(timezone.utc) - timedelta(days=days_ago, hours=1.5)
    started = started.replace(microsecond=0)
    ended = started + timedelta(minutes=end_min)

    meta = {
        "actual_duration_min": round(end_min, 2),
        "design_duration_min": round(float(type_duration_min or curve.duration_min), 2),
        "startup_type": startup_type,
        "generator": "mock",
        "profile": profile.get("name", "custom"),
        "deviations": profile.get("narrative", []),
        "pre_roll_min": PRE_ROLL_MIN,
    }
    return {
        "id": startup_id,
        "boiler_id": curve.boiler_id,
        "label": label,
        "detected_start": started.isoformat(),
        "detected_end": ended.isoformat(),
        "status": "aborted" if aborted else "complete",
        "source": source,
        "startup_type": startup_type,
        "series": {
            "step_s": STEP_S,
            "start_min": -PRE_ROLL_MIN,
            "signals": signals,
        },
        "meta": meta,
    }


DEMO_STARTUPS: list[dict[str, Any]] = [
    {
        "id": "S-1039",
        "label": "S-1039 - clean reference",
        "days_ago": 12,
        "startup_type": "cold",
        "type_duration_min": 107.0,
        "profile": {
            "name": "clean",
            "noise": 0.8,
            "nox_amp": 24.0,
            "flame_delay_s": 2.0,
            "narrative": ["On-curve ramp, all control bands respected."],
        },
    },
    {
        "id": "S-1040",
        "label": "S-1040 - slow second ramp",
        "days_ago": 8,
        "startup_type": "warm",
        "type_duration_min": 80.0,
        "profile": {
            "name": "slow_ramp",
            "noise": 1.0,
            "purge_extra_min": 1.0,
            "ramp_scale": {"ramp_10_30": 0.85, "ramp_30_50": 0.95},
            "nox_amp": 28.0,
            "level_dip": {"at": 52.0, "depth": 5.0, "width": 3.0},
            "narrative": ["Second ramp held at ~0.85 bar/min.", "Minor drum level dip at 52 min."],
        },
    },
    {
        "id": "S-1041",
        "label": "S-1041 - NOx and SH temp excursions",
        "days_ago": 4,
        "startup_type": "warm",
        "type_duration_min": 80.0,
        "profile": {
            "name": "hot_ignition",
            "noise": 1.1,
            "nox_amp": 50.0,
            "sh_overshoot": {"at": 60.0, "amplitude": 110.0, "width": 5.0},
            "furnace_spike": {"at": 7.4, "amplitude": 4.0, "width": 0.8},
            "flame_delay_s": 2.4,
            "narrative": [
                "NOx above 50 ppm around light-off.",
                "Furnace pressure positive excursion at 7.4 min.",
                "Superheater outlet above 450 C around 60 min.",
            ],
        },
    },
    {
        "id": "S-1042",
        "label": "S-1042 - long purge, slow 10-30 ramp",
        "days_ago": 1,
        "startup_type": "cold",
        "type_duration_min": 107.0,
        "profile": {
            "name": "hero",
            "noise": 1.05,
            "purge_extra_min": 4.0,
            "ramp_scale": {"ramp_10_30": 0.75, "ramp_30_50": 0.92},
            "level_dip": {"at": 27.0, "depth": 26.0, "width": 3.5},
            "nox_amp": 50.0,
            "flame_delay_s": 2.6,
            "narrative": [
                "Purge ran 9 min against a 5 min procedure (4 min extra).",
                "10-30 barg ramp held at ~0.75 bar/min against 1.0 bar/min.",
                "Drum level dipped to ~38% at 27 min.",
                "NOx peaked above 50 ppm at light-off.",
            ],
        },
    },
    {
        "id": "S-1043",
        "label": "S-1043 - fuel gas pressure loss",
        "days_ago": 2,
        "startup_type": "hot",
        "type_duration_min": 55.0,
        "profile": {
            "name": "fg_loss",
            "noise": 1.0,
            "nox_amp": 27.0,
            "fg_drop": {"at": 41.0, "to": 2.3, "hold": 2.5},
            "abort_at_min": 43.5,
            "narrative": ["Fuel gas pressure fell to 2.3 barg at 41 min; startup stopped at 43.5 min."],
        },
    },
]
