"""Deterministic startup analytics.

This module is the numeric authority of the feature. It compares the approved design
curve with what the historian says actually happened and produces an *evidence bundle*.
The LLM only ever sees the output of this module; it never sees raw sensor streams and
never computes a limit.

Conventions
-----------
* time is minutes relative to the detected startup start (t = 0).
* a limit's ``op`` is the condition that MUST hold; a violation is its negation.
* ``analytics_default`` tolerances are not safety limits. They are reporting bands.
"""

from __future__ import annotations

import bisect
import math
import statistics
from typing import Any, Iterable

from ..schemas import DesignCurve, Limit, Signal, Track

EPS = 1e-9


# --------------------------------------------------------------------------------------
# series helpers
# --------------------------------------------------------------------------------------
def series_map(startup: dict[str, Any]) -> dict[str, list[tuple[float, float | None]]]:
    """Expand the compact stored series into ``{signal: [(t_min, value), ...]}``."""
    series = startup.get("series") or {}
    step_min = float(series.get("step_s") or 15) / 60.0
    start_min = float(series.get("start_min") or 0.0)
    out: dict[str, list[tuple[float, float | None]]] = {}
    for key, values in (series.get("signals") or {}).items():
        out[key] = [
            (round(start_min + i * step_min, 6), value if value is not None else None)
            for i, value in enumerate(values)
        ]
    return out


def _times(points: list[tuple[float, float | None]]) -> list[float]:
    return [p[0] for p in points]


def value_at(
    points: list[tuple[float, float | None]],
    t: float,
    *,
    max_gap_min: float = 2.0,
    interpolate: bool = True,
) -> float | None:
    """Interpolated (or nearest) value at ``t``. Returns None across data gaps."""
    if not points:
        return None
    times = _times(points)
    if t < times[0] - EPS or t > times[-1] + EPS:
        return None
    i = bisect.bisect_left(times, t)
    if i < len(points) and abs(times[i] - t) <= EPS:
        return points[i][1]
    left = i - 1
    if left < 0 or i >= len(points):
        return None
    t0, v0 = points[left]
    t1, v1 = points[i]
    if v0 is None or v1 is None or t1 - t0 > max_gap_min or t1 - t0 <= EPS:
        return None
    if not interpolate:
        return v0
    ratio = (t - t0) / (t1 - t0)
    return v0 + (v1 - v0) * ratio


# --------------------------------------------------------------------------------------
# design evaluation
# --------------------------------------------------------------------------------------
def expected_at(signal: Signal, t: float) -> tuple[float | None, Track | None]:
    """Design expectation at time ``t`` (piecewise linear, last matching track wins)."""
    for track in reversed(signal.design):
        first, last = track.points[0], track.points[-1]
        if first.t - EPS <= t <= last.t + EPS:
            return _interp_track(track, t), track
    return None, None


def _interp_track(track: Track, t: float) -> float:
    points = track.points
    for left, right in zip(points, points[1:]):
        if left.t - EPS <= t <= right.t + EPS:
            if abs(right.t - left.t) <= EPS:
                return right.value
            ratio = (t - left.t) / (right.t - left.t)
            return left.value + (right.value - left.value) * ratio
    return points[-1].value


def expected_crossing(signal: Signal, value: float) -> float | None:
    """First design time at which the expectation reaches ``value`` (ramp curves only)."""
    if not signal.design:
        return None
    end = max(track.points[-1].t for track in signal.design)
    start = min(track.points[0].t for track in signal.design)
    step = 0.1
    t = start
    previous, _ = expected_at(signal, t)
    while t <= end:
        current, _ = expected_at(signal, t)
        if previous is not None and current is not None:
            if previous < value <= current:
                return round(t, 2)
        previous = current
        t += step
    return None


def _holds(op: str, observed: float, limit: Limit) -> bool:
    if limit.op == "between":
        return (limit.min or 0) - EPS <= observed <= (limit.max or 0) + EPS
    value = limit.value if limit.value is not None else 0.0
    return {
        "gt": observed > value + EPS,
        "gte": observed >= value - EPS,
        "lt": observed < value - EPS,
        "lte": observed <= value + EPS,
        "eq": abs(observed - value) <= 1e-6,
    }[op]


def _distance(limit: Limit, observed: float) -> float:
    if limit.op == "between":
        lo = limit.min or 0.0
        hi = limit.max or 0.0
        if observed < lo:
            return lo - observed
        if observed > hi:
            return observed - hi
        return 0.0
    value = limit.value or 0.0
    if limit.op in ("lte", "lt"):
        return max(0.0, observed - value)
    if limit.op in ("gte", "gt"):
        return max(0.0, value - observed)
    if limit.op == "eq":
        return abs(observed - value)
    return 0.0


def _active(limit: Limit, t: float, activation_at: float | None = None) -> bool:
    if limit.active_from_event:
        if activation_at is None or t < activation_at - EPS:
            return False
    if limit.active_from_min is not None and t < limit.active_from_min - EPS:
        return False
    if limit.active_to_min is not None and t > limit.active_to_min + EPS:
        return False
    return True


def _describe(limit: Limit, signal: Signal, observed: float, t: float) -> str:
    unit = f" {signal.unit}" if signal.unit else ""
    label = limit.label or limit.key.replace("_", " ")
    if limit.op == "between":
        return (
            f"{signal.label} reached {observed:.{signal.decimals}f}{unit} at t={t:.1f} min, "
            f"outside the required {limit.min}-{limit.max}{unit} ({limit.source_ref})."
        )
    if limit.op in ("lte", "lt"):
        return (
            f"{signal.label} reached {observed:.{signal.decimals}f}{unit} at t={t:.1f} min, "
            f"above the {limit.value}{unit} limit ({limit.source_ref})."
        )
    if limit.op in ("gte", "gt"):
        return (
            f"{signal.label} dropped to {observed:.{signal.decimals}f}{unit} at t={t:.1f} min, "
            f"below the {limit.value}{unit} limit ({limit.source_ref})."
        )
    return (
        f"{signal.label} was {observed:.{signal.decimals}f}{unit} at t={t:.1f} min, "
        f"expected {limit.value} ({limit.source_ref})."
    )


# --------------------------------------------------------------------------------------
# limit compliance
# --------------------------------------------------------------------------------------
def _violation_segments(
    points: list[tuple[float, float | None]],
    signal: Signal,
    limit: Limit,
    step_min: float,
    activation_at: float | None = None,
) -> list[dict[str, Any]]:
    min_duration = max(limit.min_duration_min, limit.hold_seconds / 60.0)
    segments: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None

    for t, value in points:
        if value is None or not _active(limit, t, activation_at):
            if current:
                segments.append(current)
                current = None
            continue
        if _holds(limit.op, value, limit):
            if current:
                segments.append(current)
                current = None
            continue
        if current is None:
            current = {"from_min": t, "to_min": t, "worst": value, "worst_at": t}
        else:
            current["to_min"] = t
            if _distance(limit, value) > _distance(limit, current["worst"]):
                current["worst"] = value
                current["worst_at"] = t

    if current:
        segments.append(current)

    out = []
    for seg in segments:
        duration = seg["to_min"] - seg["from_min"] + step_min
        if duration < min_duration - EPS:
            continue
        seg["duration_min"] = round(duration, 2)
        seg["from_min"] = round(seg["from_min"], 2)
        seg["to_min"] = round(seg["to_min"], 2)
        seg["worst"] = round(seg["worst"], 3)
        seg["worst_at"] = round(seg["worst_at"], 2)
        out.append(seg)
    return out


# --------------------------------------------------------------------------------------
# tracking / rate / milestones
# --------------------------------------------------------------------------------------
def _tracking(signal: Signal, points: list[tuple[float, float | None]], step_min: float) -> dict[str, Any] | None:
    if signal.kind != "analog" or not signal.design:
        return None
    residuals: list[float] = []
    normalized: list[float] = []
    worst = {"abs": 0.0, "at": 0.0, "expected": 0.0, "actual": 0.0, "tolerance": None}

    for track in signal.design:
        start, end = track.points[0].t, track.points[-1].t
        for t, actual in points:
            if t < start - EPS or t > end + EPS or actual is None:
                continue
            expected = _interp_track(track, t)
            tolerance = track.tolerance
            if tolerance is None:
                tolerance = max(abs(expected) * 0.02, 0.05)
            residual = actual - expected
            residuals.append(residual)
            normalized.append(abs(residual) / tolerance if tolerance else 0.0)
            if abs(residual) > worst["abs"]:
                worst = {
                    "abs": abs(residual),
                    "at": round(t, 2),
                    "expected": round(expected, 3),
                    "actual": round(actual, 3),
                    "tolerance": tolerance,
                }

    if not residuals:
        return None
    rmse = math.sqrt(sum(r * r for r in residuals) / len(residuals))
    mae = sum(abs(r) for r in residuals) / len(residuals)
    return {
        "samples": len(residuals),
        "rmse": round(rmse, 3),
        "mae": round(mae, 3),
        "mean_bias": round(sum(residuals) / len(residuals), 3),
        "max_abs": round(worst["abs"], 3),
        "max_abs_at_min": worst["at"],
        "max_abs_expected": worst["expected"],
        "max_abs_actual": worst["actual"],
        "tolerance": worst["tolerance"],
        "max_bandwidths": round(
            max(normalized) if normalized else 0.0, 2
        ),
        "mean_bandwidths": round(
            sum(normalized) / len(normalized) if normalized else 0.0, 2
        ),
        "within_tolerance_pct": round(
            100.0 * sum(1 for n in normalized if n <= 1.0) / len(normalized), 1
        ),
    }


def _rate_check(signal: Signal, points: list[tuple[float, float | None]], step_min: float) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    if not signal.design:
        return findings
    window = 5.0
    for track in signal.design:
        allowed = track.max_rate_per_min
        if allowed is None:
            continue
        start, end = track.points[0].t, track.points[-1].t
        if end - start <= window:
            continue
        worst = {"rate": 0.0, "at": 0.0}
        over_samples = 0
        total = 0
        t = start + window
        while t <= end + EPS:
            left = value_at(points, t - window)
            right = value_at(points, t)
            if left is not None and right is not None:
                rate = (right - left) / window
                total += 1
                if rate > allowed * 1.05:
                    over_samples += 1
                if rate > worst["rate"]:
                    worst = {"rate": rate, "at": round(t, 2)}
            t += step_min
        if worst["rate"] <= 0:
            continue
        findings.append(
            {
                "track_phase": track.phase,
                "allowed_per_min": allowed,
                "observed_max_per_min": round(worst["rate"], 3),
                "observed_at_min": worst["at"],
                "exceeded": worst["rate"] > allowed * 1.05,
                "over_rate_minutes": round(over_samples * step_min, 1),
                "samples": total,
                "source_ref": track.source_ref,
            }
        )
    return findings


def _actual_crossing(
    points: list[tuple[float, float | None]], value: float, *, hold: int = 3
) -> float | None:
    run = 0
    for t, observed in points:
        if observed is not None and observed >= value - EPS:
            run += 1
            if run >= hold:
                return round(t, 2)
        else:
            run = 0
    return None


def _actual_flame(points: list[tuple[float, float | None]]) -> float | None:
    run = 0
    for t, observed in points:
        if observed is not None and observed >= 0.5:
            run += 1
            if run >= 2:
                return round(t, 2)
        else:
            run = 0
    return None


# --------------------------------------------------------------------------------------
# main entry point
# --------------------------------------------------------------------------------------
def analyze(
    curve: DesignCurve,
    startup: dict[str, Any],
    *,
    step_min: float = 0.25,
) -> dict[str, Any]:
    series = series_map(startup)
    step_s = float((startup.get("series") or {}).get("step_s") or 15)
    step_min = step_s / 60.0
    duration = curve.duration_min
    meta = startup.get("meta") or {}
    if meta.get("design_duration_min"):
        duration = float(meta["design_duration_min"])
    end_min = duration
    if startup.get("meta", {}).get("actual_duration_min"):
        end_min = float(startup["meta"]["actual_duration_min"])
    else:
        pressure_points = series.get("drum_pressure") or []
        if pressure_points:
            end_min = min(duration, pressure_points[-1][0])

    signals = sorted(curve.signals, key=lambda s: s.chart_order)
    violations: list[dict[str, Any]] = []
    tracking: dict[str, dict[str, Any]] = {}
    rate_findings: list[dict[str, Any]] = []
    milestone_rows: list[dict[str, Any]] = []
    signal_reports: list[dict[str, Any]] = []

    for signal in signals:
        points = series.get(signal.key) or []
        signal_tracking = _tracking(signal, points, step_min)
        if signal_tracking:
            tracking[signal.key] = signal_tracking

        rates = _rate_check(signal, points, step_min)
        rate_findings.extend({**finding, "signal": signal.key, "label": signal.label} for finding in rates)

        signal_limits = []
        activations = {
            limit.key: next(
                (
                    t
                    for t, value in points
                    if value is not None and t >= -EPS and _holds(limit.op, value, limit)
                ),
                None,
            )
            for limit in signal.limits
            if limit.active_from_event
        }
        for limit in signal.limits:
            segments = _violation_segments(
                points, signal, limit, step_min, activations.get(limit.key)
            )
            for segment in segments:
                violation = {
                    "id": "",
                    "signal": signal.key,
                    "signal_label": signal.label,
                    "unit": signal.unit,
                    "severity": limit.severity,
                    "op": limit.op,
                    "limit_key": limit.key,
                    "limit_label": limit.label,
                    "threshold": {
                        "value": limit.value,
                        "min": limit.min,
                        "max": limit.max,
                    },
                    **segment,
                    "source_ref": limit.source_ref,
                    "statement": _describe(limit, signal, segment["worst"], segment["worst_at"]),
                }
                violations.append(violation)

            signal_limits.append(
                {
                    "key": limit.key,
                    "op": limit.op,
                    "severity": limit.severity,
                    "value": limit.value,
                    "min": limit.min,
                    "max": limit.max,
                    "label": limit.label,
                    "source_ref": limit.source_ref,
                    "violation_count": len(segments),
                    "violation_minutes": round(sum(s["duration_min"] for s in segments), 1),
                }
            )

        if signal.kind == "state" and signal.design:
            expected_on = any(
                point.value >= 0.5
                for track in signal.design
                for point in track.points
            )
            seen_on = any(value is not None and value >= 0.5 for _, value in points)
            if expected_on and not seen_on:
                last_t = round(points[-1][0], 2) if points else 0.0
                source = next(
                    (
                        track.source_ref
                        for track in signal.design
                        if any(point.value >= 0.5 for point in track.points)
                        and track.source_ref
                    ),
                    "",
                )
                violations.append(
                    {
                        "id": "",
                        "signal": signal.key,
                        "signal_label": signal.label,
                        "unit": signal.unit,
                        "severity": "watch",
                        "op": "eq",
                        "limit_key": "expected_state",
                        "limit_label": "Expected state not achieved",
                        "threshold": {"value": 1, "min": None, "max": None},
                        "from_min": last_t,
                        "to_min": last_t,
                        "duration_min": 0,
                        "worst": 0,
                        "worst_at": last_t,
                        "source_ref": source,
                        "statement": (
                            f"{signal.label} never reached the expected state in the "
                            f"available telemetry ({source})."
                        ),
                    }
                )

        for milestone in signal.milestones:
            design_at = expected_crossing(signal, milestone.value)
            actual_at = _actual_crossing(points, milestone.value)
            delta = round(actual_at - design_at, 1) if actual_at is not None and design_at is not None else None
            milestone_rows.append(
                {
                    "id": "",
                    "signal": signal.key,
                    "label": milestone.label,
                    "value": milestone.value,
                    "unit": signal.unit,
                    "design_at_min": design_at,
                    "actual_at_min": actual_at,
                    "delta_min": delta,
                    "status": (
                        "unknown" if delta is None
                        else "on_time" if abs(delta) <= 2
                        else "late" if delta > 0
                        else "early"
                    ),
                    "source_ref": milestone.source_ref,
                }
            )

        signal_reports.append(
            {
                "key": signal.key,
                "label": signal.label,
                "unit": signal.unit,
                "kind": signal.kind,
                "tracking": signal_tracking,
                "limits": signal_limits,
                "samples": len([v for _, v in points if v is not None]),
            }
        )

    for index, violation in enumerate(
        sorted(violations, key=lambda v: (v["from_min"], v["severity"])), start=1
    ):
        violation["id"] = f"V{index}"

    for index, row in enumerate(
        sorted(milestone_rows, key=lambda m: (m["actual_at_min"] is None, m["actual_at_min"] or 0)), start=1
    ):
        row["id"] = f"M{index}"

    # ---- lag estimate (how far behind the design curve the ramp is) -----------------
    lag_signal = curve.signal_map.get("drum_pressure") or next(
        (signal for signal in curve.signals if signal.design and series.get(signal.key)),
        None,
    )
    lag = _lag_estimate(
        curve,
        series.get(lag_signal.key) if lag_signal else [],
        lag_signal,
    )

    # ---- phase alignment ------------------------------------------------------------
    phase_rows = _phase_alignment(curve, startup, series, end_min)

    # ---- prerequisites --------------------------------------------------------------
    prerequisites = _prerequisites(curve, series)

    # ---- abort evidence -------------------------------------------------------------
    abort_flags: list[dict[str, Any]] = []
    for violation in [v for v in violations if v["severity"] == "abort"]:
        abort_flags.append(
            {
                "id": "",
                "type": "observed_threshold",
                "severity": "abort",
                "signal": violation["signal"],
                "signal_label": violation["signal_label"],
                "at_min": violation["from_min"],
                "statement": violation["statement"],
                "evidence_ref": violation["id"],
                "source_ref": violation["source_ref"],
                "requires_operator_confirmation": True,
            }
        )
    for criterion in curve.manual_criteria:
        abort_flags.append(
            {
                "id": "",
                "type": "manual_criterion",
                "severity": "manual",
                "signal": None,
                "signal_label": criterion.label,
                "at_min": None,
                "statement": (
                    f"{criterion.label} cannot be established from DCS data alone. "
                    f"Operator confirmation required ({criterion.source_ref})."
                ),
                "evidence_ref": None,
                "source_ref": criterion.source_ref,
                "requires_operator_confirmation": True,
            }
        )
    for index, flag in enumerate(abort_flags, start=1):
        flag["id"] = f"A{index}"

    # ---- data quality ---------------------------------------------------------------
    quality = _data_quality(curve, series, startup)

    # ---- scoring --------------------------------------------------------------------
    score = _score(
        curve=curve,
        tracking=tracking,
        violations=violations,
        lag=lag,
        quality=quality,
        series=series,
        end_min=end_min,
        abort_flags=[f for f in abort_flags if f["type"] == "observed_threshold"],
    )

    # ---- merged event feed ----------------------------------------------------------
    events: list[dict[str, Any]] = []
    for phase in phase_rows:
        if phase["actual_start_min"] is not None:
            events.append(
                {
                    "t_min": phase["actual_start_min"],
                    "type": "phase",
                    "severity": "info",
                    "title": phase["label"],
                    "detail": (
                        f"Actual start {phase['actual_start_min']:.1f} min vs design "
                        f"{phase['design_start_min']:.1f} min "
                        f"({phase['delta_min']:+.1f} min)."
                    ),
                    "evidence_id": phase["id"],
                }
            )
    for violation in violations:
        events.append(
            {
                "t_min": violation["worst_at"],
                "type": "violation",
                "severity": violation["severity"],
                "title": f"{violation['signal_label']} {violation['severity']} limit",
                "detail": violation["statement"],
                "evidence_id": violation["id"],
            }
        )
    for milestone in milestone_rows:
        if milestone["actual_at_min"] is not None:
            events.append(
                {
                    "t_min": milestone["actual_at_min"],
                    "type": "milestone",
                    "severity": "info",
                    "title": milestone["label"],
                    "detail": (
                        f"Reached at {milestone['actual_at_min']:.1f} min vs design "
                        f"{milestone['design_at_min']:.1f} min."
                        if milestone["design_at_min"] is not None
                        else f"Reached at {milestone['actual_at_min']:.1f} min."
                    ),
                    "evidence_id": milestone["id"],
                }
            )
    for item in prerequisites:
        if item["status"] in ("fail", "unknown"):
            events.append(
                {
                    "t_min": -15 if item["window_min"] else 0,
                    "type": "prerequisite",
                    "severity": "watch",
                    "title": f"Prerequisite {item['status']}: {item['label']}",
                    "detail": item["detail"],
                    "evidence_id": item["id"],
                }
            )
    events.sort(key=lambda event: event["t_min"])

    return {
        "startup": {
            "id": startup.get("id"),
            "label": startup.get("label"),
            "boiler_id": startup.get("boiler_id"),
            "detected_start": startup.get("detected_start"),
            "detected_end": startup.get("detected_end"),
            "status": startup.get("status"),
            "source": startup.get("source"),
            "startup_type": startup.get("startup_type")
            or (startup.get("meta") or {}).get("startup_type")
            or "cold",
        },
        "curve": {
            "id": curve.curve_id,
            "name": curve.name,
            "document": curve.source.document,
            "revision": curve.source.revision,
            "approved_by": curve.source.approved_by,
            "approved_at": curve.source.approved_at,
            "design_duration_min": round(duration, 2),
        },
        "duration": {
            "design_min": round(duration, 2),
            "actual_min": round(end_min, 2),
            "delta_min": round(end_min - duration, 2),
            "end_reason": startup.get("status"),
        },
        "data_quality": quality,
        "phases": phase_rows,
        "tracking": [
            {"signal": key, "label": curve.signal_map[key].label, **value}
            for key, value in tracking.items()
        ],
        "signals": signal_reports,
        "rates": rate_findings,
        "violations": violations,
        "milestones": milestone_rows,
        "lag": lag,
        "prerequisites": prerequisites,
        "abort_flags": abort_flags,
        "score": score,
        "events": events,
        "evidence_ids": sorted(
            {row["id"] for row in violations}
            | {row["id"] for row in milestone_rows}
            | {row["id"] for row in prerequisites}
            | {row["id"] for row in abort_flags}
            | {row["id"] for row in phase_rows}
            | ({"L1"} if lag["minutes"] is not None else set())
            | {"Q1"}
            | {f"T{i}" for i, _ in enumerate(tracking, start=1)}
        ),
    }


def _lag_estimate(
    curve: DesignCurve,
    points: list[tuple[float, float | None]],
    signal: Signal | None = None,
) -> dict[str, Any]:
    pressure = signal or curve.signal_map.get("drum_pressure")
    if not pressure or not points:
        return {"minutes": None, "method": "none", "rmse_at_best": None, "window": None}
    window_start = 6.0
    window_end = min(max(10.0, pressure.design[-1].points[-1].t if pressure.design else 72.67), curve.duration_min)
    candidates = [t for t, v in points if v is not None and window_start <= t <= window_end]
    if len(candidates) < 10:
        return {"minutes": None, "method": "insufficient_samples", "rmse_at_best": None, "window": None}

    best = {"lag": 0.0, "rmse": float("inf")}
    lag = -20.0
    while lag <= 20.0 + EPS:
        squared: list[float] = []
        for t in candidates:
            expected, _ = expected_at(pressure, t - lag)
            actual = value_at(points, t)
            if expected is not None and actual is not None:
                squared.append((actual - expected) ** 2)
        if len(squared) >= 20:
            rmse = math.sqrt(sum(squared) / len(squared))
            if rmse < best["rmse"]:
                best = {"lag": lag, "rmse": rmse}
        lag += 0.5

    if best["rmse"] == float("inf"):
        return {"minutes": None, "method": "insufficient_overlap", "rmse_at_best": None, "window": None}
    return {
        "minutes": round(best["lag"], 1),
        "method": (
            f"cross-correlation of {pressure.label} against the design ramp "
            "(-20..+20 min)"
        ),
        "rmse_at_best": round(best["rmse"], 3),
        "window": [window_start, window_end],
        "interpretation": (
            "on the design curve"
            if abs(best["lag"]) < 1
            else "behind the design curve"
            if best["lag"] > 0
            else "ahead of the design curve"
        ),
    }


def _phase_alignment(
    curve: DesignCurve,
    startup: dict[str, Any],
    series: dict[str, list[tuple[float, float | None]]],
    end_min: float,
) -> list[dict[str, Any]]:
    pressure = series.get("drum_pressure") or []
    flame = series.get("flame_detected") or []
    pilot_start = _actual_flame(flame)
    p10 = _actual_crossing(pressure, 10)
    p30 = _actual_crossing(pressure, 30)
    p50 = _actual_crossing(pressure, 50)

    anchors = {
        "purge": (0.0, pilot_start),
        "pilot": (pilot_start, p10),
        "ramp_0_10": (pilot_start, p10) if p10 else (None, None),
        "ramp_10_30": (p10, p30) if p10 and p30 else (None, None),
        "ramp_30_50": (p30, p50) if p30 and p50 else (None, None),
    }
    if p50 is not None:
        line_end = min(round(p50 + (curve.phase_map["line_switch"].end_min - curve.phase_map["line_switch"].start_min), 2), end_min)
        anchors["line_switch"] = (p50, line_end)
        anchors["stabilize"] = (line_end, end_min)
    else:
        anchors["line_switch"] = (None, None)
        anchors["stabilize"] = (None, None)

    # purge starts at t=0 by definition of the time origin; keep its actual start explicit.
    anchors["purge"] = (0.0, pilot_start if pilot_start is not None else None)

    rows = []
    for index, phase in enumerate(sorted(curve.phases, key=lambda p: p.order), start=1):
        actual_start, actual_end = anchors.get(phase.key, (None, None))
        delta = (
            round(actual_start - phase.start_min, 1)
            if actual_start is not None
            else None
        )
        rows.append(
            {
                "id": f"PH{index}",
                "key": phase.key,
                "label": phase.label,
                "design_start_min": phase.start_min,
                "design_end_min": phase.end_min,
                "actual_start_min": actual_start,
                "actual_end_min": actual_end,
                "delta_min": delta,
                "status": (
                    "unknown" if delta is None
                    else "on_plan" if abs(delta) <= 2
                    else "late" if delta > 0
                    else "early"
                ),
                "source_ref": phase.source_ref,
            }
        )
    return rows


def _prerequisites(
    curve: DesignCurve, series: dict[str, list[tuple[float, float | None]]]
) -> list[dict[str, Any]]:
    rows = []
    for index, prereq in enumerate(curve.prerequisites, start=1):
        row = {
            "id": f"P{index}",
            "key": prereq.key,
            "label": prereq.label,
            "mode": prereq.mode,
            "window_min": prereq.window_min,
            "source_ref": prereq.source_ref,
            "status": "manual",
            "observed": None,
            "detail": "Manual attestation required; not inferable from DCS data.",
        }
        if prereq.mode == "auto" and prereq.signal_key:
            points = [
                (t, v)
                for t, v in (series.get(prereq.signal_key) or [])
                if v is not None and -prereq.window_min <= t < 0
            ]
            if not points:
                row["status"] = "unknown"
                row["detail"] = (
                    f"No data for {prereq.signal_key} in the {prereq.window_min:g} min "
                    "before startup; cannot verify."
                )
            else:
                values = [v for _, v in points]
                observed_min = round(min(values), 3)
                observed_max = round(max(values), 3)
                row["observed"] = {"min": observed_min, "max": observed_max, "samples": len(values)}
                limit = Limit(
                    key=prereq.key,
                    op=prereq.op,
                    value=prereq.value,
                    min=prereq.min,
                    max=prereq.max,
                    severity="watch",
                    source_ref=prereq.source_ref,
                )
                checks = [_holds(prereq.op, v, limit) for v in values]
                passed = all(checks) if prereq.must_hold_all_samples else checks[-1]
                row["status"] = "pass" if passed else "fail"
                signature = f"{prereq.min}-{prereq.max}" if prereq.op == "between" else f"{prereq.op} {prereq.value}"
                row["detail"] = (
                    f"Observed {observed_min}..{observed_max} over the {prereq.window_min:g} min "
                    f"before startup; required {signature} ({prereq.source_ref})."
                )
        rows.append(row)
    return rows


def _data_quality(
    curve: DesignCurve, series: dict[str, list[tuple[float, float | None]]], startup: dict[str, Any]
) -> dict[str, Any]:
    step_s = float((startup.get("series") or {}).get("step_s") or 15)
    step_min = step_s / 60.0
    span = 0.0
    for points in series.values():
        if points:
            span = max(span, points[-1][0] - points[0][0])
    expected = max(1, int(round(span / step_min)) + 1) if span else 1

    selected = [signal for signal in curve.signals if signal.required]
    if not selected:
        # Drawing-derived curves may mark every signal optional. Coverage must still be
        # computed from the signals that were actually digitized.
        selected = [signal for signal in curve.signals if series.get(signal.key)]

    coverage: dict[str, float] = {}
    for signal in selected:
        signal_points = series.get(signal.key) or []
        present = len([v for _, v in signal_points if v is not None])
        coverage[signal.key] = round(100.0 * present / expected, 1) if expected else 0.0

    overall = round(min(coverage.values()), 1) if coverage else 0.0
    gaps = 0
    for signal in selected:
        if signal.kind != "analog":
            continue
        run = 0
        for _, value in series.get(signal.key) or []:
            if value is None:
                run += 1
                if run == 5:
                    gaps += 1
            else:
                run = 0

    status = "ok" if overall >= 95 else "degraded" if overall >= 80 else "insufficient"
    return {
        "id": "Q1",
        "coverage_pct": overall,
        "by_signal": coverage,
        "gaps": gaps,
        "samples_expected": expected,
        "span_min": round(span, 2),
        "status": status,
        "detail": (
            f"Telemetry coverage {overall}% across required signals; "
            f"{gaps} gap{'s' if gaps != 1 else ''} longer than 1 minute."
        ),
    }


def _score(
    *,
    curve: DesignCurve,
    tracking: dict[str, dict[str, Any]],
    violations: list[dict[str, Any]],
    lag: dict[str, Any],
    quality: dict[str, Any],
    series: dict[str, list[tuple[float, float | None]]],
    end_min: float,
    abort_flags: list[dict[str, Any]],
) -> dict[str, Any]:
    if not tracking:
        return {
            "value": None,
            "status": "insufficient_data",
            "components": {},
            "weights": {"tracking": 0.4, "bands": 0.3, "timing": 0.2, "stability": 0.1},
            "note": "No design-tracked signals were available for scoring.",
        }

    mean_bandwidths = sum(t["mean_bandwidths"] for t in tracking.values()) / len(tracking)
    tracking_score = max(0.0, min(100.0, 100.0 - 25.0 * mean_bandwidths))

    watch = [v for v in violations if v["severity"] == "watch"]
    watch_minutes = sum(v["duration_min"] for v in watch)
    bands_score = max(0.0, min(100.0, 100.0 - 12.0 * len(watch) - 1.5 * watch_minutes))

    lag_minutes = abs(lag.get("minutes") or 0.0)
    timing_score = max(0.0, min(100.0, 100.0 - 3.0 * lag_minutes))

    pressure = series.get("drum_pressure") or []
    tail = [v for t, v in pressure if v is not None and end_min - 10 <= t <= end_min]
    tolerance = 0.8
    stabilize = curve.phase_map.get("stabilize")
    stability_applicable = bool(stabilize) and end_min >= stabilize.start_min + 5
    stability_score = 100.0
    if stability_applicable and len(tail) >= 3:
        std = statistics.pstdev(tail)
        stability_score = max(0.0, min(100.0, 100.0 - 40.0 * std / tolerance))

    weights = {"tracking": 0.4, "bands": 0.3, "timing": 0.2, "stability": 0.1}
    raw = (
        tracking_score * weights["tracking"]
        + bands_score * weights["bands"]
        + timing_score * weights["timing"]
        + stability_score * weights["stability"]
    )

    status = "nominal"
    if abort_flags:
        status = "attention"
        raw = min(raw, 45.0)
    elif watch:
        status = "watch"
    elif quality["status"] != "ok":
        status = "reduced_confidence"

    value: float | None = round(raw, 1)
    note = (
        "Composite of tracking error, control-band compliance, timing and stability. "
        "It is a performance indicator, not a safety assessment."
    )
    if not stability_applicable:
        note += " Stability was not evaluated because the startup ended before steady state."
    if quality["status"] == "insufficient":
        value = None
        status = "insufficient_data"
        note = (
            f"Telemetry coverage is {quality['coverage_pct']}% "
            f"({quality['status']}); no score is produced below 80%."
        )

    return {
        "value": value,
        "status": status,
        "components": {
            "tracking": round(tracking_score, 1),
            "bands": round(bands_score, 1),
            "timing": round(timing_score, 1),
            "stability": round(stability_score, 1),
        },
        "weights": weights,
        "note": note,
    }


# --------------------------------------------------------------------------------------
# chart payloads
# --------------------------------------------------------------------------------------
def _grid(start_min: float, end_min: float, step_min: float) -> list[float]:
    grid = []
    t = start_min
    while t < end_min + EPS:
        grid.append(round(t, 3))
        t += step_min
    if not grid or grid[-1] < end_min - 0.5 * step_min:
        grid.append(round(end_min, 3))
    return grid


def build_chart(
    curve: DesignCurve,
    startup: dict[str, Any],
    *,
    step_min: float = 0.5,
    max_minutes: float | None = None,
) -> dict[str, Any]:
    series = series_map(startup)
    start_min = min((p[0] for points in series.values() for p in points), default=0.0)
    data_end = max((p[0] for points in series.values() for p in points), default=curve.duration_min)
    end_min = curve.duration_min
    if startup.get("status") in ("in_progress", "aborted", "complete"):
        end_min = max(curve.duration_min, data_end)
    if max_minutes is not None:
        end_min = max(start_min + step_min, min(max_minutes, data_end))
    grid = _grid(start_min, end_min, step_min)

    signals: dict[str, Any] = {}
    for signal in curve.signals:
        points = series.get(signal.key) or []
        actual = []
        expected = []
        lo = []
        hi = []
        for t in grid:
            actual.append(_round_opt(value_at(points, t, max_gap_min=1.5), signal.decimals))
            exp, track = expected_at(signal, t)
            expected.append(_round_opt(exp, signal.decimals))
            if exp is not None and track and track.tolerance is not None:
                lo.append(_round_opt(exp - track.tolerance, signal.decimals))
                hi.append(_round_opt(exp + track.tolerance, signal.decimals))
            else:
                lo.append(None)
                hi.append(None)

        zones = []
        for limit in signal.limits:
            if limit.op == "between" and limit.min is not None and limit.max is not None:
                zones.append(
                    {
                        "from_min": limit.active_from_min if limit.active_from_min is not None else start_min,
                        "to_min": limit.active_to_min if limit.active_to_min is not None else end_min,
                        "lo": limit.min,
                        "hi": limit.max,
                        "severity": limit.severity,
                        "label": limit.label or limit.key,
                        "source_ref": limit.source_ref,
                    }
                )
        lines = []
        for limit in signal.limits:
            if limit.op == "between" or limit.op == "eq":
                continue
            if limit.value is None:
                continue
            lines.append(
                {
                    "value": limit.value,
                    "label": limit.label or limit.key,
                    "severity": limit.severity,
                    "source_ref": limit.source_ref,
                }
            )

        signals[signal.key] = {
            "key": signal.key,
            "label": signal.label,
            "unit": signal.unit,
            "kind": signal.kind,
            "decimals": signal.decimals,
            "chart_order": signal.chart_order,
            "actual": actual,
            "expected": expected,
            "lo": lo,
            "hi": hi,
            "zones": zones,
            "lines": lines,
        }

    return {
        "start_min": start_min,
        "end_min": round(end_min, 2),
        "step_min": step_min,
        "grid": grid,
        "phases": [
            {
                "key": phase.key,
                "label": phase.label,
                "start_min": phase.start_min,
                "end_min": phase.end_min,
            }
            for phase in sorted(curve.phases, key=lambda p: p.order)
        ],
        "signals": signals,
        "violations": [],
        "milestones": [],
    }


def _round_opt(value: float | None, decimals: int) -> float | None:
    return None if value is None else round(value, decimals)


def resample(
    points: list[tuple[float, float | None]], grid: Iterable[float]
) -> list[float | None]:
    return [value_at(points, t) for t in grid]


def build_comparison(
    curve: DesignCurve,
    runs: list[dict[str, Any]],
    *,
    step_min: float = 1.0,
    signal_keys: list[str] | None = None,
    envelope_ids: list[str] | None = None,
) -> dict[str, Any]:
    """Median / IQR envelope across historical startups, aligned on t = 0."""
    keys = signal_keys or [
        signal.key for signal in sorted(curve.signals, key=lambda s: s.chart_order)
    ]
    envelope_runs = (
        [run for run in runs if run.get("id") in envelope_ids]
        if envelope_ids is not None
        else runs
    ) or runs
    start_min = -15.0
    end_min = max(
        [curve.duration_min]
        + [
            float((run.get("meta") or {}).get("actual_duration_min") or curve.duration_min)
            for run in runs
        ]
    )
    grid = _grid(start_min, end_min, step_min)

    envelope: dict[str, Any] = {}
    for key in keys:
        columns: list[list[float]] = []
        for run in envelope_runs:
            points = series_map(run).get(key) or []
            values = resample(points, grid)
            columns.append(values)
        median, p25, p75, count = [], [], [], []
        for index in range(len(grid)):
            values = sorted(
                column[index]
                for column in columns
                if column[index] is not None
            )
            if values:
                median.append(round(statistics.median(values), 3))
                p25.append(round(statistics.quantiles(values, n=4)[0], 3) if len(values) > 1 else round(values[0], 3))
                p75.append(round(statistics.quantiles(values, n=4)[2], 3) if len(values) > 1 else round(values[0], 3))
                count.append(len(values))
            else:
                median.append(None)
                p25.append(None)
                p75.append(None)
                count.append(0)
        envelope[key] = {
            "median": median,
            "p25": p25,
            "p75": p75,
            "count": count,
        }

    run_payloads = []
    for run in runs:
        series = series_map(run)
        run_payloads.append(
            {
                "id": run.get("id"),
                "label": run.get("label"),
                "status": run.get("status"),
                "detected_start": run.get("detected_start"),
                "score": run.get("score"),
                "duration_min": (run.get("meta") or {}).get("actual_duration_min"),
                "signals": {
                    key: [round(v, 3) if v is not None else None for v in resample(series.get(key) or [], grid)]
                    for key in keys
                },
            }
        )

    return {
        "start_min": start_min,
        "end_min": round(end_min, 2),
        "step_min": step_min,
        "grid": grid,
        "envelope": envelope,
        "runs": run_payloads,
    }
