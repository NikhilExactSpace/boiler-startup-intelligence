"""Vision digitization of boiler-turbine start-up curve drawings.

This path is deliberately separate from the SOP text extractor: a drawing needs axis
calibration and breakpoint digitization, not text-fact transcription. The model may only
report what it can read; every result is marked as a draft and requires human approval.
"""

from __future__ import annotations

import base64
import hashlib
import io
import json
import re
import shutil
import subprocess
import tempfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any

from PIL import Image, ImageFilter, ImageOps
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from ..config import settings
from ..schemas import DesignCurve, Signal, Track, TrackPoint
from . import gemini

PARAMETER_KEYS = {
    "main_steam_temp",
    "reheat_steam_temp",
    "main_steam_pressure",
    "reheat_pressure",
    "main_steam_flow",
    "reheat_steam_flow",
    "turbine_speed",
    "turbine_flow",
    "load_mw",
}

ALIASES = {
    "sh steam temperature": "main_steam_temp",
    "ms steam temperature": "main_steam_temp",
    "main steam temperature": "main_steam_temp",
    "main steam temp": "main_steam_temp",
    "ms steam temp": "main_steam_temp",
    "sh steam temp": "main_steam_temp",
    "rh steam temperature": "reheat_steam_temp",
    "reheat steam temperature": "reheat_steam_temp",
    "rh steam temp": "reheat_steam_temp",
    "reheat steam temp": "reheat_steam_temp",
    "ms pressure": "main_steam_pressure",
    "main steam pressure": "main_steam_pressure",
    "rh pressure": "reheat_pressure",
    "reheat pressure": "reheat_pressure",
    "ms steam flow": "main_steam_flow",
    "main steam flow": "main_steam_flow",
    "rh steam flow": "reheat_steam_flow",
    "reheat steam flow": "reheat_steam_flow",
    "turbine speed": "turbine_speed",
    "turbine flow": "turbine_flow",
    "load": "load_mw",
    "load mw": "load_mw",
    "generator load": "load_mw",
}


class VisionPoint(BaseModel):
    t_min: float
    value: float
    confidence: str = "medium"


class VisionCurve(BaseModel):
    parameter: str
    printed_label: str = ""
    unit: str = ""
    points: list[VisionPoint] = Field(default_factory=list)
    segment_rates: list[dict[str, Any]] = Field(default_factory=list)
    lower_bound: float | None = None
    upper_bound: float | None = None
    notes: str = ""

    @model_validator(mode="after")
    def _sorted(self) -> "VisionCurve":
        self.points.sort(key=lambda point: point.t_min)
        return self


class VisionDocument(BaseModel):
    model_config = ConfigDict(extra="ignore")
    title: str = ""
    customer: str = ""
    plant: str = ""
    vendor: str = ""
    drawing_no: str = ""
    revision: str = ""
    start_type: str = "cold"
    unit_size_mw: float = 0
    date: str = ""


class VisionResult(BaseModel):
    model_config = ConfigDict(extra="ignore")
    document: VisionDocument = Field(default_factory=VisionDocument)
    time_axis: dict[str, Any] = Field(default_factory=dict)
    axis_calibration: list[dict[str, Any]] = Field(default_factory=list)
    rated_values_printed: list[dict[str, Any]] = Field(default_factory=list)
    events: list[dict[str, Any]] = Field(default_factory=list)
    mill_cut_in: list[dict[str, Any]] = Field(default_factory=list)
    live_highlights: list[dict[str, Any]] = Field(default_factory=list)
    curves: list[VisionCurve] = Field(default_factory=list)
    derived_limits: list[dict[str, Any]] = Field(default_factory=list)
    review_flags: list[dict[str, Any]] = Field(default_factory=list)
    overall_confidence: str = "low"


VISION_SCHEMA: dict[str, Any] = {
    "type": "OBJECT",
    "properties": {
        "document": {
            "type": "OBJECT",
            "properties": {
                "title": {"type": "STRING"},
                "customer": {"type": "STRING"},
                "plant": {"type": "STRING"},
                "vendor": {"type": "STRING"},
                "drawing_no": {"type": "STRING"},
                "revision": {"type": "STRING"},
                "start_type": {"type": "STRING"},
                "unit_size_mw": {"type": "NUMBER"},
                "date": {"type": "STRING"},
            },
            "required": [
                "title", "customer", "plant", "vendor", "drawing_no",
                "revision", "start_type", "unit_size_mw", "date",
            ],
        },
        "time_axis": {
            "type": "OBJECT",
            "properties": {
                "min_min": {"type": "NUMBER"},
                "max_min": {"type": "NUMBER"},
                "unit": {"type": "STRING"},
                "as_printed": {"type": "STRING"},
            },
            "required": ["min_min", "max_min", "unit", "as_printed"],
        },
        "axis_calibration": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "axis": {"type": "STRING"},
                    "unit": {"type": "STRING"},
                    "axis_min": {"type": "NUMBER"},
                    "axis_max": {"type": "NUMBER"},
                    "scale_factor_vs_grid": {"type": "NUMBER"},
                    "reference_points_used": {"type": "ARRAY", "items": {"type": "STRING"}},
                    "check_against_printed_value": {"type": "STRING"},
                },
            },
        },
        "rated_values_printed": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "name": {"type": "STRING"},
                    "value": {"type": "NUMBER"},
                    "unit": {"type": "STRING"},
                    "as_printed": {"type": "STRING"},
                },
            },
        },
        "events": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "name": {"type": "STRING"},
                    "t_min": {"type": "NUMBER"},
                    "source": {"type": "STRING"},
                },
            },
        },
        "mill_cut_in": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "mill": {"type": "STRING"},
                    "t_min": {"type": "NUMBER"},
                },
            },
        },
        "live_highlights": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "t_min": {"type": "NUMBER"},
                    "title": {"type": "STRING"},
                    "detail": {"type": "STRING"},
                    "kind": {"type": "STRING"},
                    "importance": {"type": "STRING"},
                },
                "required": ["t_min", "title", "detail", "kind", "importance"],
            },
        },
        "curves": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "parameter": {"type": "STRING"},
                    "printed_label": {"type": "STRING"},
                    "unit": {"type": "STRING"},
                    "points": {
                        "type": "ARRAY",
                        "items": {
                            "type": "OBJECT",
                            "properties": {
                                "t_min": {"type": "NUMBER"},
                                "value": {"type": "NUMBER"},
                                "confidence": {"type": "STRING"},
                            },
                            "required": ["t_min", "value", "confidence"],
                        },
                    },
                    "segment_rates": {"type": "ARRAY", "items": {"type": "OBJECT"}},
                    "lower_bound": {"type": "NUMBER", "nullable": True},
                    "upper_bound": {"type": "NUMBER", "nullable": True},
                    "notes": {"type": "STRING"},
                },
                "required": [
                    "parameter", "printed_label", "unit", "points",
                    "segment_rates", "lower_bound", "upper_bound", "notes",
                ],
            },
        },
        "derived_limits": {"type": "ARRAY", "items": {"type": "OBJECT"}},
        "review_flags": {"type": "ARRAY", "items": {"type": "OBJECT"}},
        "overall_confidence": {"type": "STRING"},
    },
    "required": [
        "document", "time_axis", "axis_calibration", "rated_values_printed",
        "events", "mill_cut_in", "live_highlights", "curves", "derived_limits",
        "review_flags", "overall_confidence",
    ],
}

PROMPT = """You are an expert engineering data digitization system specializing in complex
multi-axis plots, industrial trend charts, and technical curves.

Analyze the supplied curve/chart image, understand its layout, calibrate its axes, trace each
parameter, verify values against the visual scales, and return all data as validated JSON.

EXECUTION WORKFLOW
Follow these phases in order. Perform explicit verification before producing the final table.

PHASE 1 - LAYOUT AND AXIS DISCOVERY
1. Identify the independent X-axis: For power plant startup curves, this is ALWAYS Time (in minutes).
   Record variable name, unit, min, max, major grid intervals, and minor divisions.
2. Identify every dependent Y-axis:
   Start-up drawings have MULTIPLE distinct Y-axes sharing the same grid.
   For each Y-axis, record: label, unit, min bound, max bound, and value increment per major grid line.
   Standard parameters to identify and calibrate:
   - "LOAD" (MW, e.g. 0 to 600 MW)
   - "TURBINE SPEED" (RPM, e.g. 0 to 3000 RPM)
   - "STEAM TEMPERATURE" / "SH STEAM TEMP" / "MS STEAM TEMP" / "RH STEAM TEMP" (deg C, e.g. 0 to 550 C)
   - "MS PRESSURE" / "RH PRESSURE" (Kg/sqcm(g), e.g. 0 to 180 Kg/sqcm)
   - "STEAM FLOW" / "MS STEAM FLOW" / "RH STEAM FLOW" (TPH, e.g. 0 to 2200 TPH)
   - "TURBINE FLOW" (TPH or %)
3. Read the legend before tracing:
   - Record every legend entry: printed label, colour, line style, marker and the Y-axis it belongs to.
   - Match each drawn line to a legend entry using colour, dash pattern, marker and end label.
   - If several lines overlap, use the legend and end labels to separate them; never assume a
     line belongs to a parameter just because it is nearest to that axis.
   - If the legend is missing or unreadable, use the right-hand end labels and note the ambiguity.
4. Read title block (Plant name, unit capacity, drawing number, revision, date).
5. Transcribe auxiliary tables:
   - "MILL CUT IN TIME": Mill No. (1st, 2nd, etc.) vs Time (min).
   - Top milestone event flags (e.g. BOILER LIGHTUP, BYPASS CUT IN, ROLLING, SYNCHRONISATION,
     BYPASS CLOSED, HP HEATERS CUT-IN, REACHES FULL LOAD, REACHES RATED PARAMETER).

PHASE 2 - VERIFICATION AND CROSS-CHECKING
- ZERO BASELINE: Confirm where each curve begins at t=0 or startup initiation.
- INDEPENDENT SCALES: Curves physically cross each other because they share the grid area.
  DO NOT assign crossing curves the same value. Always map each curve strictly to its OWN Y-axis scale.
- PLATEAU / RATED LIMITS:
  Verify flat/saturation sections against the printed rated value annotations on the right:
  * Turbine speed plateaus at rated speed (e.g. 3000 RPM).
  * Load reaches rated capacity (e.g. 600 MW).
  * Main steam and reheat steam temperatures reach rated temperature (e.g. 537 deg C).
  * Main steam and reheat pressures reach rated pressures (e.g. 170 and 40 Kg/sqcm).
  * Steam flows peak near full load and stabilize to rated TPH.

PHASE 3 - SAMPLING AND DIGITIZATION
- Sample breakpoints at all key operational points (start of ramp, knee points, synchronization, full load reached).
- Also sample uniformly across the entire timeline (e.g. every 25 or 50 minutes).
- Return between 20 and 50 clean, chronologically ascending points per active curve.
- Ensure all t_min values lie strictly within the printed X-axis timeline.

PHASE 4 - FINAL SELF-CHECK BEFORE OUTPUT
- Select the operationally important live events: 4-12 entries chosen from the drawing events,
  mill cut-in table and major curve inflections. For each give t_min, title, detail, kind
  (event, mill, parameter, milestone) and importance (high/medium/low). Do not invent events.
- Re-read every curve start, end, knee and plateau from the image.
- Confirm each final value against its printed rated label and axis scale.
- Confirm each plateau matches the printed value at that grid line.
- Confirm every curve is assigned to the correct Y axis and unit.
- Confirm time is strictly increasing except intentional vertical jumps.
- Confirm no curve point lies outside the printed X-axis range.
- If any check fails, correct the point or add a review flag. Do not output unresolved errors.

OUTPUT
Return ONLY valid JSON matching the requested schema. Use these parameter keys:
main_steam_temp, reheat_steam_temp, main_steam_pressure, reheat_pressure,
main_steam_flow, reheat_steam_flow, turbine_speed, turbine_flow, load_mw.

Include document metadata, time_axis, axis_calibration, rated_values_printed, events,
mill_cut_in, live_highlights, curves with points {t_min,value,confidence}, segment_rates,
derived_limits, review_flags and overall_confidence. Round numbers to two decimals, notes under 12 words. No markdown or commentary."""


class CurveVisionError(RuntimeError):
    pass


def _render_pdf(raw: bytes) -> bytes:
    binary = shutil.which("pdftoppm")
    if not binary:
        raise CurveVisionError("pdftoppm is required to render PDF drawings")
    with tempfile.TemporaryDirectory() as folder:
        source = Path(folder) / "drawing.pdf"
        source.write_bytes(raw)
        prefix = Path(folder) / "page"
        subprocess.run(
            [binary, "-png", "-r", "300", "-f", "1", "-singlefile", str(source), str(prefix)],
            check=True,
            capture_output=True,
            timeout=60,
        )
        output = Path(f"{prefix}.png")
        if not output.exists():
            raise CurveVisionError("Could not render the first PDF page")
        return output.read_bytes()


def _normalise_parameter(value: str) -> str:
    """Robust normalizer that handles numbers, units, and label suffixes from drawings."""
    raw = (value or "").strip().lower().replace("_", " ").replace("-", " ")
    cleaned = re.sub(r"[^a-z0-9\s]", " ", raw)
    normalized = " ".join(cleaned.split())

    if normalized in ALIASES:
        return ALIASES[normalized]
    if normalized.replace(" ", "_") in PARAMETER_KEYS:
        return normalized.replace(" ", "_")

    # Substring / keyword priority matching (most specific patterns first)
    patterns = [
        (["sh steam temp", "ms steam temp", "main steam temp", "sh steam temperature", "ms steam temperature"], "main_steam_temp"),
        (["rh steam temp", "reheat steam temp", "rh steam temperature", "reheat steam temperature"], "reheat_steam_temp"),
        (["ms pressure", "main steam pressure"], "main_steam_pressure"),
        (["rh pressure", "reheat pressure"], "reheat_pressure"),
        (["ms steam flow", "main steam flow", "ms flow"], "main_steam_flow"),
        (["rh steam flow", "reheat steam flow", "rh flow"], "reheat_steam_flow"),
        (["turbine speed", "speed rpm"], "turbine_speed"),
        (["turbine flow"], "turbine_flow"),
        (["load mw", "generator load", "load"], "load_mw"),
        (["steam temp", "steam temperature"], "main_steam_temp"),
    ]
    for search_keys, target_key in patterns:
        for sk in search_keys:
            if sk in normalized:
                return target_key

    return ""


def _split_tracks(curve: DesignCurve, points: list[VisionPoint], source_ref: str) -> list[Track]:
    ordered = sorted(points, key=lambda point: point.t_min)
    buckets: dict[str, list[VisionPoint]] = {}
    for point in ordered:
        phase = next(
            (
                phase
                for phase in sorted(curve.phases, key=lambda p: p.order)
                if phase.start_min <= point.t_min <= phase.end_min
            ),
            curve.phases[-1],
        )
        buckets.setdefault(phase.key, []).append(point)
    tracks: list[Track] = []
    for phase_key, phase_points in buckets.items():
        if len(phase_points) < 2:
            continue
        normalised: list[TrackPoint] = []
        for index, point in enumerate(phase_points):
            t = round(point.t_min, 3)
            if normalised and t <= normalised[-1].t:
                t = round(normalised[-1].t + 0.001, 3)
            normalised.append(TrackPoint(t=t, value=round(point.value, 4)))
        tracks.append(
            Track(
                phase=phase_key,
                points=normalised,
                tolerance=None,
                tolerance_provenance="analytics_default",
                source_ref=source_ref,
            )
        )
    return tracks


def _apply_to_curve(
    base: DesignCurve,
    result: VisionResult,
    *,
    boiler_id: str,
    file_name: str,
    sha256: str,
) -> tuple[DesignCurve, list[str]]:
    curve = base.model_copy(deep=True)
    curve.boiler_id = boiler_id
    curve.status = "draft"
    curve.name = result.document.title or f"{boiler_id} start-up curve"
    curve.startup_type = (
        result.document.start_type.lower()
        if result.document.start_type.lower() in {"cold", "warm", "hot"}
        else "cold"
    )
    curve.curve_id = re.sub(
        r"[^a-zA-Z0-9._-]+",
        "-",
        f"{boiler_id.lower()}-{result.document.drawing_no or 'drawing'}-r{result.document.revision or '00'}",
    ).strip("-").lower() or "curve"
    curve.source.document = result.document.drawing_no or result.document.title or "drawing"
    curve.source.revision = result.document.revision or "00"
    curve.source.file_name = file_name
    curve.source.sha256 = sha256
    drawing_ref = f"{curve.source.document} Rev {curve.source.revision}"

    # The drawing timeline is authoritative. The boiler's previous curve may have a
    # different duration (107 min vs a 500 min drawing), so scale the phases to the
    # printed X-axis before breakpoints are assigned.
    drawing_end = float(result.time_axis.get("max_min") or 0)
    base_end = max((phase.end_min for phase in curve.phases), default=0)
    if drawing_end > 0 and base_end > 0 and abs(drawing_end - base_end) > 0.01:
        factor = drawing_end / base_end
        for phase in curve.phases:
            phase.start_min = round(phase.start_min * factor, 4)
            phase.end_min = round(phase.end_min * factor, 4)

    curve.prerequisites = []
    curve.manual_criteria = []
    curve.notes = ["Digitized from an uploaded start-up curve drawing."]
    for phase in curve.phases:
        phase.source_ref = drawing_ref
    for signal in curve.signals:
        signal.design = []
        signal.limits = []
        signal.milestones = []

    curve.extras = {
        "digitization": result.model_dump(mode="json"),
        "drawing_no": result.document.drawing_no,
        "overall_confidence": result.overall_confidence,
    }

    warnings: list[str] = []
    applied: dict[str, int] = {}
    by_key = curve.signal_map
    time_min = float(result.time_axis.get("min_min", 0) or 0)
    time_max = float(result.time_axis.get("max_min", 600) or 600)
    for vision_curve in result.curves:
        key = _normalise_parameter(vision_curve.parameter) or _normalise_parameter(
            vision_curve.printed_label
        )
        if not key:
            warnings.append(f"Unmapped drawing curve: {vision_curve.printed_label or vision_curve.parameter}")
            continue
        outside = [
            point
            for point in vision_curve.points
            if point.t_min < time_min - 1 or point.t_min > time_max + 1
        ]
        if outside:
            warnings.append(
                f"{key}: skipped because time points fall outside the printed X axis "
                f"({time_min:g}-{time_max:g} min); X axis may have been misread"
            )
            continue
        signal = by_key.get(key)
        if signal is None:
            warnings.append(f"No design signal for drawing curve {key}; skipped")
            continue
        if len(vision_curve.points) < 2:
            warnings.append(f"{key}: fewer than two breakpoints")
            continue
        tracks = _split_tracks(curve, vision_curve.points, f"{curve.source.document} {result.document.drawing_no}")
        if not tracks:
            warnings.append(f"{key}: breakpoints did not align with any phase")
            continue
        for track in tracks:
            values = [point.value for point in track.points]
            span = max(values) - min(values) if values else 0.0
            # Reporting tolerance only. The drawing has no tolerance bands; this lets the
            # analytics report deviation without inventing a safety limit.
            track.tolerance = round(max(span * 0.05, abs(max(values, default=0.0)) * 0.01, 0.05), 4)
            track.tolerance_provenance = "analytics_default"
        signal.design = tracks
        signal.required = True
        applied[key] = len(vision_curve.points)

    for flag in result.review_flags:
        severity = str(flag.get("severity", "medium")).lower()
        if severity in {"high", "medium"}:
            warnings.append(
                f"{flag.get('item', 'Review')}: {flag.get('reason', 'uncertain reading')}"
            )

    if not applied:
        warnings.append("No curves could be mapped to the design signal set")
    else:
        curve.signals = [signal for signal in curve.signals if signal.key in applied]
    return curve, warnings


def _enhance(image: Image.Image, *, max_width: int = 3200) -> Image.Image:
    image = image.convert("RGB")
    if image.width < max_width:
        ratio = max_width / max(1, image.width)
        image = image.resize(
            (max_width, max(1, int(image.height * ratio))), Image.Resampling.LANCZOS
        )
    image = ImageOps.autocontrast(image, cutoff=1)
    image = image.filter(ImageFilter.UnsharpMask(radius=1.2, percent=140, threshold=3))
    return image


def _png_bytes(image: Image.Image) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=True)
    return buffer.getvalue()


def _drawing_passes(image_bytes: bytes) -> list[tuple[str, bytes]]:
    """Full drawing plus calibrated zoom passes that retain the left Y-axes to prevent hallucinations."""
    image = Image.open(io.BytesIO(image_bytes))
    full = _enhance(image)
    passes: list[tuple[str, bytes]] = [
        (
            "FULL DRAWING (AUTHORITATIVE). Read the title block, all axes, curves, milestone flags, and tables.",
            _png_bytes(full),
        )
    ]
    width, height = image.size
    # If the image is large, provide a zoom of the dense startup region (0 to ~250 min),
    # ensuring it always starts from x=0 so the left Y-axes remain visible for calibration.
    if width > 1200:
        left_crop = image.crop((0, 0, int(width * 0.62), height))
        passes.append(
            (
                "LEFT ZOOM PASS (0-250 min). Includes left Y-axes and startup region (rolling, synchronization).",
                _png_bytes(_enhance(left_crop, max_width=2400)),
            )
        )
    return passes


def _ocr_text(image_bytes: bytes) -> str:
    binary = shutil.which("tesseract")
    if not binary:
        return ""
    with tempfile.TemporaryDirectory() as folder:
        path = Path(folder) / "drawing.png"
        try:
            image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
            image = ImageOps.autocontrast(image)
            image.save(path, format="PNG")
            completed = subprocess.run(
                [binary, str(path), "stdout", "--psm", "6"],
                check=False,
                capture_output=True,
                timeout=45,
                text=True,
            )
            return " ".join(completed.stdout.split())[:6000]
        except (OSError, ValueError, subprocess.SubprocessError):
            return ""


def _call_vision(image: bytes, hint: str, *, ocr: str = "", attempt: int = 0) -> VisionResult:
    inline = {
        "inlineData": {
            "mimeType": "image/png",
            "data": base64.b64encode(image).decode("ascii"),
        }
    }
    parts: list[dict[str, Any]] = [{"text": PROMPT}, {"text": hint}, inline]
    if ocr:
        parts.append(
            {
                "text": (
                    "OCR TEXT (use only as a reading aid; the image is authoritative). "
                    "Use it to identify axis titles, printed tick values, event names and the "
                    "title block. Do not invent numbers that are not visible in the image.\n"
                    + ocr
                )
            }
        )
    if attempt:
        parts.append(
            {
                "text": (
                    "Your previous response had parsing or validation issues. Return COMPACT valid "
                    "JSON matching the schema strictly. Keep at most 40 breakpoints per curve, "
                    "round numbers to two decimals, and ensure parameter keys match the schema."
                )
            }
        )
    text, usage = gemini.generate_content(
        parts,
        model=settings.gemini_extraction_model,
        temperature=0.0,  # Deterministic coordinate reading
        max_output_tokens=32768,
        response_schema=VISION_SCHEMA,
        thinking_budget=8192,  # Deep multi-axis calibration and line-crossing verification
        timeout=180,
    )
    return VisionResult.model_validate(gemini.parse_json(text))


def _merge_results(results: list[VisionResult]) -> VisionResult:
    base = results[0]
    if len(results) == 1:
        return base

    merged: dict[str, VisionCurve] = {}
    for curve in base.curves:
        key = _normalise_parameter(curve.parameter) or _normalise_parameter(curve.printed_label)
        if key:
            merged[key] = curve.model_copy(deep=True)
            merged[key].parameter = key

    for result in results[1:]:
        for curve in result.curves:
            key = _normalise_parameter(curve.parameter) or _normalise_parameter(curve.printed_label)
            if not key:
                continue
            target = merged.get(key)
            if target is None:
                merged[key] = curve.model_copy(deep=True)
                merged[key].parameter = key
                continue
            by_time: dict[float, VisionPoint] = {round(p.t_min, 2): p for p in target.points}
            for point in curve.points:
                slot = round(point.t_min, 2)
                existing = by_time.get(slot)
                if existing is None or _confidence_rank(point.confidence) > _confidence_rank(existing.confidence):
                    by_time[slot] = point
            target.points = sorted(by_time.values(), key=lambda p: p.t_min)[:80]

    base.curves = list(merged.values())
    flags = list(base.review_flags)
    flags.append(
        {
            "item": "multi-pass merge",
            "reason": f"merged {len(results)} calibrated image passes",
            "severity": "low",
        }
    )
    base.review_flags = flags
    return base


def _confidence_rank(value: str) -> int:
    lowered = (value or "").lower()
    return 3 if lowered == "high" else 2 if lowered == "medium" else 1


def _validate_result(result: VisionResult) -> None:
    time_min = float(result.time_axis.get("min_min", 0) or 0)
    time_max = float(result.time_axis.get("max_min", 600) or 600)
    for curve in result.curves:
        key = _normalise_parameter(curve.parameter)
        times = [point.t_min for point in curve.points]
        if any(b < a - 1e-6 for a, b in zip(times, times[1:])):
            result.review_flags.append(
                {"item": key, "reason": "time values are not ascending", "severity": "high"}
            )
        if any(t < time_min - 1 or t > time_max + 1 for t in times):
            result.review_flags.append(
                {
                    "item": key,
                    "reason": (
                        f"time point outside printed X axis {time_min:g}-{time_max:g} min; "
                        "check that X is time and not a pixel/value axis"
                    ),
                    "severity": "high",
                }
            )

    has_time_axis = any(
        "time" in str(item.get("axis", "")).lower()
        or str(item.get("unit", "")).lower() in {"min", "minute", "minutes"}
        for item in result.axis_calibration
    )
    if result.curves and not has_time_axis:
        result.review_flags.append(
            {
                "item": "X axis",
                "reason": "time-axis calibration was not reported; verify X is time in minutes",
                "severity": "high",
            }
        )

    rated = {
        _normalise_parameter(str(item.get("name", ""))): float(item.get("value") or 0)
        for item in result.rated_values_printed
        if _normalise_parameter(str(item.get("name", "")))
    }
    for curve in result.curves:
        key = _normalise_parameter(curve.parameter)
        if not key or not curve.points:
            continue
        if key in rated and rated[key]:
            expected_val = rated[key]
            final = curve.points[-1].value
            allowed_tol = max(5.0, abs(expected_val) * 0.035)  # Adaptive tolerance (3.5% or 5 units)
            if abs(final - expected_val) > allowed_tol:
                result.review_flags.append(
                    {
                        "item": key,
                        "reason": f"final value {final:g} differs from printed rated {expected_val:g} (tol: ±{allowed_tol:g})",
                        "severity": "medium",
                    }
                )


def digitize_curve(
    raw: bytes,
    *,
    mime_type: str,
    file_name: str,
    boiler_id: str,
    base: DesignCurve,
) -> dict[str, Any]:
    if not settings.extraction_ai_configured:
        raise CurveVisionError(
            "Vision extraction is not configured. Set GEMINI_API_KEY to digitize curve drawings."
        )

    image = _render_pdf(raw) if mime_type == "application/pdf" else raw
    if not image:
        raise CurveVisionError("The drawing is empty")

    passes = _drawing_passes(image)
    ocr = _ocr_text(image)
    results: list[VisionResult] = []
    usage: dict[str, Any] = {}
    errors: list[str] = []

    def run_pass(index: int, hint: str, image_bytes: bytes) -> tuple[int, VisionResult | None, str | None]:
        last_error: Exception | None = None
        for attempt in range(2):  # Enabled real retry on error
            try:
                return index, _call_vision(image_bytes, hint, ocr=ocr, attempt=attempt), None
            except (ValidationError, ValueError, KeyError, gemini.GeminiError) as exc:
                last_error = exc
        return index, None, f"{hint.split('.')[0]}: {last_error}"

    with ThreadPoolExecutor(max_workers=min(2, len(passes))) as pool:
        futures = [
            pool.submit(run_pass, index, hint, image_bytes)
            for index, (hint, image_bytes) in enumerate(passes)
        ]
        ordered: dict[int, VisionResult] = {}
        for future in as_completed(futures):
            index, result_item, error = future.result()
            if result_item is not None:
                ordered[index] = result_item
            if error:
                errors.append(error)
        results = [ordered[index] for index in sorted(ordered)]

    if not results:
        raise CurveVisionError(
            "Could not digitize the drawing: " + ("; ".join(errors[-2:]) or "vision model failed")
        )
    result = _merge_results(results)
    _validate_result(result)
    for error in errors:
        result.review_flags.append(
            {"item": "vision pass failed", "reason": error, "severity": "medium"}
        )

    sha = hashlib.sha256(raw).hexdigest()
    curve, warnings = _apply_to_curve(
        base,
        result,
        boiler_id=boiler_id,
        file_name=file_name,
        sha256=sha,
    )

    extracted = []
    for vision_curve in result.curves:
        extracted.append(
            {
                "field": f"curve.{vision_curve.parameter}",
                "value": f"{len(vision_curve.points)} breakpoints · {vision_curve.unit}",
                "confidence": (
                    0.95
                    if vision_curve.points
                    and all(point.confidence == "high" for point in vision_curve.points)
                    else 0.8
                ),
                "source_line": vision_curve.notes or vision_curve.printed_label,
            }
        )
    for event in result.events:
        extracted.append(
            {
                "field": f"event.{event.get('name', '')}",
                "value": f"t={event.get('t_min', 0)} min",
                "confidence": 0.9,
                "source_line": "drawing event marker",
            }
        )
    for mill in result.mill_cut_in:
        extracted.append(
            {
                "field": f"mill.{mill.get('mill', '')}",
                "value": f"t={mill.get('t_min', 0)} min",
                "confidence": 0.95,
                "source_line": "mill cut in schedule table",
            }
        )

    return {
        "draft": curve.model_dump(mode="json"),
        "extracted": extracted,
        "warnings": warnings,
        "unknowns": [
            flag.get("item", "")
            for flag in result.review_flags
            if flag.get("severity") == "high"
        ],
        "document": {
            "document": result.document.drawing_no or result.document.title or "drawing",
            "revision": result.document.revision or "00",
            "sha256": sha,
            "text_sha256": sha,
            "characters": 0,
            "equipment": result.document.plant or result.document.customer or None,
            "file_name": file_name,
            "engine": "ai-gemini-vision",
        },
        "boiler_id": boiler_id,
        "ai": {
            "engine": "gemini-vision",
            "model": settings.gemini_extraction_model,
            "attempts": 1,
            "validation": "draft",
            "fact_counts": {
                "applied": len(extracted),
                "proposed": len(extracted),
                "rejected": len(warnings),
            },
            "notes": warnings,
            "usage": usage,
        },
    }