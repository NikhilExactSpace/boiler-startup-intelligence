"""LLM explanation layer.

Contract
--------
1. The model receives a *pre-computed evidence bundle*, never raw sensor streams.
2. It may only explain, cite and prioritise. It may not invent limits, compute new
   numbers, or state that the boiler is safe/unsafe to operate.
3. Every returned payload is validated (numeric grounding, evidence references,
   source citations, verdict phrase blocklist). Failures retry once, then fall back to
   a deterministic template.
4. Cached by evidence hash + model + prompt version.
"""

from __future__ import annotations

import json
import re
import time
from datetime import datetime, timezone
from typing import Any, Literal

from pydantic import BaseModel, Field, ValidationError

from ..config import settings
from ..schemas import DesignCurve
from . import gemini
from .curves import canonical_json, sha256_text

DISCLAIMER = (
    "Advisory only. This explanation is generated from the evidence above and does not "
    "determine whether the boiler is safe to operate. The shift engineer remains "
    "responsible for every operating decision."
)

VERDICT_PATTERNS = [
    r"safe\s+to\s+(operate|start|run|proceed|restart|continue)",
    r"cleared\s+for\s+(operation|startup|service)",
    r"approved\s+for\s+operation",
    r"guarantee(d|s)?\s+(safe|operation)",
    r"no\s+risk",
    r"confirms?\s+(that\s+)?(it\s+is\s+)?safe",
]


class TimelineItem(BaseModel):
    t_min: float | None = None
    event: str
    evidence_ids: list[str] = Field(default_factory=list)


class DeviationItem(BaseModel):
    signal: str
    what: str
    when_min: float | None = None
    severity: Literal["watch", "abort", "info"] = "info"
    source_ref: str | None = None
    evidence_ids: list[str] = Field(default_factory=list)


class Factor(BaseModel):
    hypothesis: str
    confidence: Literal["low", "medium", "high"]
    support: list[str] = Field(default_factory=list)
    contradicting: list[str] = Field(default_factory=list)
    evidence_ids: list[str] = Field(default_factory=list)


class InsightPayload(BaseModel):
    summary: str
    timeline: list[TimelineItem] = Field(default_factory=list)
    deviations: list[DeviationItem] = Field(default_factory=list)
    contributing_factors: list[Factor] = Field(default_factory=list)
    data_gaps: list[str] = Field(default_factory=list)
    recommended_checks: list[str] = Field(default_factory=list)
    disclaimer: str = DISCLAIMER


class InsightValidationError(ValueError):
    pass


PROMPT = """You are a boiler startup performance analyst explaining historian evidence to
a shift engineer.

You receive an EVIDENCE bundle produced by deterministic analytics that compared an
approved startup curve with actual DCS data.

HARD RULES
- Explain only what the evidence supports. If something is not in the evidence, say it
  is unknown.
- NEVER state or imply that the boiler is safe or unsafe to operate, start or continue.
- NEVER invent, compute or derive a limit, threshold or safety margin. If you mention a
  limit, copy its value AND its source_ref exactly from the evidence.
- NEVER invent timestamps, sensor values, causal mechanisms or maintenance history.
- Do not compute new numbers. Reuse numbers that already appear in the evidence.
- A correlation is a possible contributor, not a proven cause. Use "possible",
  "consistent with", "may".
- Prefer data gaps and verification actions over speculation.
- Reference evidence by id (e.g. V1, M2, L1, Q1) for every claim.

EVIDENCE
{evidence}

VALID EVIDENCE IDS — use only these exact strings, never a JSON field path:
{evidence_ids}

CITATION KEY — pick the id for the topic, and cite at least one on every item:
{citation_key}

Return ONLY a JSON object with this shape:
{{
  "summary": "3-5 sentences for the shift engineer",
  "timeline": [{{"t_min": 27.0, "event": "...", "evidence_ids": ["V1"]}}],
  "deviations": [{{"signal": "Drum level", "what": "...", "when_min": 27.0,
                   "severity": "watch|abort|info",
                   "source_ref": "SOP-202 §4 or null",
                   "evidence_ids": ["V1"]}}],
  "contributing_factors": [{{"hypothesis": "...", "confidence": "low|medium|high",
                             "support": ["..."], "contradicting": ["..."],
                             "evidence_ids": ["L1", "V1"]}}],
  "data_gaps": ["..."],
  "recommended_checks": ["..."],
  "disclaimer": "Advisory only."
}}
"""

# Response schema is only a shape guard. Grounding, evidence ids, source refs and
# verdict language are all re-checked by `validate_insight` after generation.
INSIGHT_SCHEMA: dict[str, Any] = {
    "type": "OBJECT",
    "properties": {
        "summary": {"type": "STRING"},
        "timeline": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "t_min": {"type": "NUMBER", "nullable": True},
                    "event": {"type": "STRING"},
                    "evidence_ids": {
                        "type": "ARRAY",
                        "items": {"type": "STRING"},
                        "minItems": 1,
                    },
                },
                "required": ["t_min", "event", "evidence_ids"],
            },
        },
        "deviations": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "signal": {"type": "STRING"},
                    "what": {"type": "STRING"},
                    "when_min": {"type": "NUMBER", "nullable": True},
                    "severity": {"type": "STRING", "enum": ["watch", "abort", "info"]},
                    "source_ref": {"type": "STRING", "nullable": True},
                    "evidence_ids": {
                        "type": "ARRAY",
                        "items": {"type": "STRING"},
                        "minItems": 1,
                    },
                },
                "required": [
                    "signal",
                    "what",
                    "when_min",
                    "severity",
                    "source_ref",
                    "evidence_ids",
                ],
            },
        },
        "contributing_factors": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "hypothesis": {"type": "STRING"},
                    "confidence": {"type": "STRING", "enum": ["low", "medium", "high"]},
                    "support": {"type": "ARRAY", "items": {"type": "STRING"}},
                    "contradicting": {"type": "ARRAY", "items": {"type": "STRING"}},
                    "evidence_ids": {
                        "type": "ARRAY",
                        "items": {"type": "STRING"},
                        "minItems": 1,
                    },
                },
                "required": [
                    "hypothesis",
                    "confidence",
                    "support",
                    "contradicting",
                    "evidence_ids",
                ],
            },
        },
        "data_gaps": {"type": "ARRAY", "items": {"type": "STRING"}},
        "recommended_checks": {"type": "ARRAY", "items": {"type": "STRING"}},
        "disclaimer": {"type": "STRING"},
    },
    "required": [
        "summary",
        "timeline",
        "deviations",
        "contributing_factors",
        "data_gaps",
        "recommended_checks",
        "disclaimer",
    ],
}


def evidence_hash(analysis: dict[str, Any]) -> str:
    return sha256_text(canonical_json(analysis))


# --------------------------------------------------------------------------------------
# evidence corpus
# --------------------------------------------------------------------------------------
def _walk_numbers(value: Any, out: set[float]) -> None:
    if isinstance(value, bool) or value is None:
        return
    if isinstance(value, (int, float)):
        out.add(round(float(value), 3))
        return
    if isinstance(value, str):
        for match in re.findall(r"-?\d+(?:\.\d+)?", value):
            try:
                out.add(round(float(match), 3))
            except ValueError:
                continue
        return
    if isinstance(value, dict):
        for item in value.values():
            _walk_numbers(item, out)
        return
    if isinstance(value, (list, tuple)):
        for item in value:
            _walk_numbers(item, out)


def _evidence_corpus(analysis: dict[str, Any], curve: DesignCurve) -> set[float]:
    numbers: set[float] = set()
    _walk_numbers(analysis, numbers)
    numbers |= {float(len(analysis.get("violations") or [])), float(len(analysis.get("milestones") or []))}
    numbers |= {float(len(analysis.get("prerequisites") or [])), float(len(analysis.get("abort_flags") or []))}
    for phase in curve.phases:
        numbers |= {round(phase.start_min, 3), round(phase.end_min, 3)}
    for signal in curve.signals:
        for limit in signal.limits:
            for value in (limit.value, limit.min, limit.max):
                if value is not None:
                    numbers.add(round(float(value), 3))
    return numbers


def _text_fields(payload: InsightPayload) -> list[str]:
    texts = [payload.summary]
    texts += [item.event for item in payload.timeline]
    texts += [item.what for item in payload.deviations]
    for factor in payload.contributing_factors:
        texts.append(factor.hypothesis)
        texts += factor.support
        texts += factor.contradicting
    texts += payload.data_gaps
    texts += payload.recommended_checks
    return texts


def validate_insight(
    payload: InsightPayload, analysis: dict[str, Any], curve: DesignCurve
) -> list[str]:
    """Raise InsightValidationError on a contract breach; return soft notes otherwise."""
    notes: list[str] = []
    allowed_ids = set(analysis.get("evidence_ids") or [])
    corpus = _evidence_corpus(analysis, curve)
    for value in (
        list((analysis.get("curve") or {}).values())
        + list((analysis.get("startup") or {}).values())
        + [curve.source.document, curve.source.revision, curve.name, curve.curve_id]
    ):
        if isinstance(value, str):
            for match in re.findall(r"-?\d+(?:\.\d+)?", value):
                corpus.add(round(float(match), 3))
    for signal in curve.signals:
        for limit in signal.limits:
            for value in (limit.hold_seconds, limit.active_from_min, limit.active_to_min):
                if value:
                    corpus.add(round(float(value), 3))
        for milestone in signal.milestones:
            corpus.add(round(float(milestone.value), 3))
        for track in signal.design:
            if track.tolerance:
                corpus.add(round(float(track.tolerance), 3))
    source_refs = set()
    for signal in curve.signals:
        source_refs |= {limit.source_ref for limit in signal.limits}
    source_refs |= {phase.source_ref for phase in curve.phases if phase.source_ref}
    source_refs |= {prereq.source_ref for prereq in curve.prerequisites}
    source_refs |= {criterion.source_ref for criterion in curve.manual_criteria}
    normalized_refs = {re.sub(r"\s+", "", ref) for ref in source_refs}

    referenced: set[str] = set()
    for item in payload.timeline:
        if not item.evidence_ids:
            raise InsightValidationError("timeline item has no evidence_ids")
        referenced |= set(item.evidence_ids)
    for item in payload.deviations:
        if not item.evidence_ids:
            raise InsightValidationError("deviation has no evidence_ids")
        referenced |= set(item.evidence_ids)
        if item.severity in ("watch", "abort") and not item.source_ref:
            raise InsightValidationError("a limit deviation must carry a source_ref")
        if item.source_ref and re.sub(r"\s+", "", item.source_ref) not in normalized_refs:
            raise InsightValidationError(f"unknown source_ref: {item.source_ref}")
    for factor in payload.contributing_factors:
        if not factor.evidence_ids:
            raise InsightValidationError("contributing factor has no evidence_ids")
        referenced |= set(factor.evidence_ids)

    unknown = referenced - allowed_ids
    if unknown:
        raise InsightValidationError(f"unknown evidence ids: {sorted(unknown)}")

    for text in _text_fields(payload):
        for pattern in VERDICT_PATTERNS:
            if re.search(pattern, text, re.IGNORECASE):
                raise InsightValidationError(f"safety verdict language is not allowed: {pattern}")
        for match in re.findall(r"-?\d+(?:\.\d+)?", text):
            number = float(match)
            if not any(
                abs(number - candidate) <= max(0.11, abs(candidate) * 0.012)
                for candidate in corpus
            ):
                raise InsightValidationError(f"number {match} is not grounded in the evidence")

    if not payload.summary.strip():
        raise InsightValidationError("empty summary")
    if not payload.contributing_factors:
        notes.append("No contributing factors were proposed.")
    if not payload.data_gaps:
        notes.append("No data gaps reported.")
    return notes


# --------------------------------------------------------------------------------------
# providers
# --------------------------------------------------------------------------------------
def _call_gemini(
    prompt: str,
    *,
    model: str,
    correction: str | None = None,
    schema: dict[str, Any] | None = None,
) -> str:
    text, _usage = gemini.generate_content(
        [
            {
                "text": prompt
                + (
                    f"\n\nCORRECTION FROM PREVIOUS ATTEMPT:\n{correction}"
                    if correction
                    else ""
                )
            }
        ],
        model=model,
        temperature=0.2,
        max_output_tokens=8192,
        json_mode=True,
        response_schema=schema,
        thinking_budget=1024,
        timeout=120,
    )
    return text


def _parse_json(text: str) -> dict[str, Any]:
    return gemini.parse_json(text)


def _citation_key(analysis: dict[str, Any]) -> str:
    def pairs(name: str, label: str) -> str | None:
        rows = analysis.get(name) or []
        items = [
            f"{row.get('id')}={row.get(label)}"
            for row in rows
            if row.get("id") and row.get(label) is not None
        ]
        return ", ".join(items) if items else None

    lines: list[str] = []
    for name, label, topic in (
        ("phases", "key", "phase timing"),
        ("milestones", "label", "milestone timing"),
        ("violations", "signal_label", "limit deviation"),
        ("prerequisites", "label", "prerequisite status"),
        ("abort_flags", "signal_label", "abort/manual criterion"),
    ):
        rendered = pairs(name, label)
        if rendered:
            lines.append(f"- {topic}: {rendered}")
    tracking = [
        f"{row.get('signal')} tracking" for row in analysis.get("tracking") or []
    ]
    tracking_ids = [
        f"T{index + 1}" for index in range(len([t for t in tracking if t]))
    ]
    if tracking_ids:
        lines.append(f"- signal tracking: {', '.join(tracking_ids)}")
    lines.append("- design tracking lag: L1")
    lines.append("- data quality/coverage: Q1")
    lines.append(
        "- total startup duration has no dedicated id; cite the final phase (PH*) or a "
        "milestone (M*). Never cite a JSON field name such as `duration` or `lag`."
    )
    return "\n".join(lines)


def _fallback(analysis: dict[str, Any], curve: DesignCurve, reason: str) -> InsightPayload:
    violations = analysis.get("violations") or []
    aborts = [flag for flag in analysis.get("abort_flags") or [] if flag.get("type") == "observed_threshold"]
    lag = analysis.get("lag") or {}
    quality = analysis.get("data_quality") or {}
    score = analysis.get("score") or {}
    milestones = analysis.get("milestones") or []

    watch = [item for item in violations if item["severity"] == "watch"]
    late = [m for m in milestones if (m.get("delta_min") or 0) > 2]
    summary_parts = [
        f"{analysis['startup'].get('label') or 'Startup'} was compared against "
        f"{curve.source.document} Rev {curve.source.revision}."
    ]
    if lag.get("minutes") is not None:
        summary_parts.append(
            f"Drum pressure tracked {abs(lag['minutes']):.1f} min "
            f"{'behind' if lag['minutes'] > 0 else 'ahead of'} the design ramp."
        )
    summary_parts.append(
        f"{len(watch)} control-band deviation{'s' if len(watch) != 1 else ''} and "
        f"{len(aborts)} abort-level observation{'s' if len(aborts) != 1 else ''} were found."
    )
    if late:
        summary_parts.append(
            f"{len(late)} milestone{'s' if len(late) != 1 else ''} were reached more than 2 min late."
        )
    if score.get("value") is not None:
        summary_parts.append(f"Performance score {score['value']} ({score.get('status')}).")
    if quality.get("status") != "ok":
        summary_parts.append(f"Telemetry coverage is {quality.get('coverage_pct')}%.")
    summary_parts.append("This is a deterministic template summary, not an LLM explanation.")

    timeline = [
        {
            "t_min": item["worst_at"],
            "event": item["statement"],
            "evidence_ids": [item["id"]],
        }
        for item in sorted(violations, key=lambda v: v["worst_at"])[:6]
    ]
    for flag in aborts[:3]:
        timeline.append(
            {
                "t_min": flag.get("at_min"),
                "event": flag["statement"],
                "evidence_ids": [flag["evidence_ref"]] if flag.get("evidence_ref") else ["Q1"],
            }
        )
    if lag.get("minutes") is not None and timeline:
        timeline.append(
            {
                "t_min": None,
                "event": f"Design tracking lag estimate: {lag['minutes']:+.1f} min.",
                "evidence_ids": ["L1"],
            }
        )

    deviations = [
        {
            "signal": item["signal_label"],
            "what": item["statement"],
            "when_min": item["worst_at"],
            "severity": item["severity"],
            "source_ref": item["source_ref"],
            "evidence_ids": [item["id"]],
        }
        for item in sorted(violations, key=lambda v: v["worst_at"])[:8]
    ]

    factors: list[dict[str, Any]] = []
    if lag.get("minutes") is not None and abs(lag["minutes"]) > 2:
        factors.append(
            {
                "hypothesis": (
                    "The startup ran behind the approved ramp envelope. The data is "
                    "consistent with ramp rates below the approved maximum, but the cause "
                    "is not established by the available signals."
                ),
                "confidence": "medium",
                "support": [
                    f"Lag estimate is {lag['minutes']:+.1f} min against the design ramp.",
                    f"{len(late)} milestone(s) were reached late.",
                ],
                "contradicting": [],
                "evidence_ids": ["L1"] + [m["id"] for m in late[:2]],
            }
        )
    level = [v for v in violations if v["signal"] == "drum_level"]
    if level:
        factors.append(
            {
                "hypothesis": (
                    "Drum level left the approved control band; level control tuning and "
                    "feedwater response during the ramp should be reviewed. No root cause "
                    "is asserted."
                ),
                "confidence": "low",
                "support": [level[0]["statement"]],
                "contradicting": [],
                "evidence_ids": [level[0]["id"]],
            }
        )
    nox = [v for v in violations if v["signal"] == "nox"]
    if nox:
        factors.append(
            {
                "hypothesis": (
                    "NOx exceeded the approved value during light-off; combustion tuning "
                    "or excess-air behaviour near ignition may be relevant."
                ),
                "confidence": "low",
                "support": [nox[0]["statement"]],
                "contradicting": [],
                "evidence_ids": [nox[0]["id"]],
            }
        )
    if not factors:
        factors.append(
            {
                "hypothesis": (
                    "No band or tracking deviation was large enough to propose a "
                    "contributing factor from this evidence bundle."
                ),
                "confidence": "low",
                "support": ["All evaluated limits held in the available telemetry."],
                "contradicting": [],
                "evidence_ids": ["Q1"],
            }
        )

    checks: list[str] = []
    for item in violations[:4]:
        checks.append(
            f"Review {item['signal_label']} around t={item['worst_at']:.1f} min with the "
            f"console engineer ({item['source_ref']})."
        )
    for item in analysis.get("prerequisites") or []:
        if item["status"] in ("fail", "unknown", "manual"):
            checks.append(f"Confirm prerequisite: {item['label']} ({item['source_ref']}).")
    if quality.get("status") != "ok":
        checks.append("Restore missing telemetry before relying on this comparison.")

    gaps = [quality.get("detail", "")] if quality.get("detail") else []
    gaps += [
        f"Prerequisite not verifiable from DCS: {item['label']}."
        for item in analysis.get("prerequisites") or []
        if item["status"] != "pass"
    ]
    gaps += [
        f"Manual criterion: {flag['signal_label']}."
        for flag in analysis.get("abort_flags") or []
        if flag.get("type") == "manual_criterion"
    ]

    return InsightPayload(
        summary=" ".join(summary_parts),
        timeline=[TimelineItem.model_validate(item) for item in timeline],
        deviations=[DeviationItem.model_validate(item) for item in deviations],
        contributing_factors=[Factor.model_validate(item) for item in factors],
        data_gaps=[gap for gap in gaps if gap],
        recommended_checks=checks[:6],
        disclaimer=DISCLAIMER + f" (fallback reason: {reason})",
    )


def _payload_from_raw(raw: dict[str, Any]) -> InsightPayload:
    raw.setdefault("disclaimer", DISCLAIMER)
    payload = InsightPayload.model_validate(raw)
    payload.disclaimer = DISCLAIMER
    return payload


def generate(
    analysis: dict[str, Any],
    curve: DesignCurve,
    *,
    force: bool = False,
) -> dict[str, Any]:
    """Generate (or reuse) an explanation. Never raises for provider problems."""
    from . import store

    digest = evidence_hash(analysis)
    model = settings.gemini_model if settings.llm_configured else "deterministic-template"
    prompt_version = settings.prompt_version
    provider = "gemini" if settings.llm_configured else "deterministic"

    if not force:
        cached = store.get_insight(
            analysis["startup"]["id"], digest, model, prompt_version  # type: ignore[index]
        )
        if cached:
            return cached

    notes: list[str] = []
    validation_status = "validated"
    payload: InsightPayload
    started_at = time.time()

    if settings.llm_configured:
        allowed_ids = ", ".join(str(item) for item in analysis.get("evidence_ids") or [])
        prompt = PROMPT.format(
            evidence=json.dumps(analysis, indent=1, default=str),
            evidence_ids=allowed_ids or "(none)",
            citation_key=_citation_key(analysis),
        )
        correction = None
        payload = None  # type: ignore[assignment]
        for attempt in range(3):
            try:
                raw_text = _call_gemini(
                    prompt,
                    model=model,
                    correction=correction,
                    schema=INSIGHT_SCHEMA,
                )
                payload = _payload_from_raw(_parse_json(raw_text))
                notes = validate_insight(payload, analysis, curve)
                payload.disclaimer = DISCLAIMER
                validation_status = "validated"
                break
            except (
                InsightValidationError,
                ValidationError,
                json.JSONDecodeError,
                ValueError,
                gemini.GeminiError,
            ) as exc:
                notes.append(f"attempt {attempt + 1}: {exc}")
                correction = (
                    f"The previous answer was rejected: {exc}. Every timeline item, "
                    "deviation and contributing factor MUST include at least one id from "
                    f"this exact list: {allowed_ids}. Reuse only evidence numbers and never "
                    "make a safety statement."
                )
                payload = None  # type: ignore[assignment]
        if payload is None:
            reason = notes[-1] if notes else "LLM unavailable"
            payload = _fallback(analysis, curve, reason)
            provider = "deterministic"
            model = "deterministic-template"
            validation_status = "fallback"
            if settings.llm_configured:
                provider = "gemini-fallback"
    else:
        payload = _fallback(analysis, curve, "no LLM configured")
        validation_status = "deterministic"
        notes = ["GEMINI_API_KEY is not configured; a deterministic summary was produced."]

    record = {
        "insight": payload.model_dump(mode="json"),
        "meta": {
            "provider": provider,
            "model": model,
            "prompt_version": prompt_version,
            "evidence_hash": digest,
            "generated_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
            "latency_s": round(time.time() - started_at, 2),
            "validation": {"status": validation_status, "notes": notes},
            "authoritative": False,
            "disclaimer": DISCLAIMER,
        },
    }
    return store.save_insight(
        startup_id=analysis["startup"]["id"],  # type: ignore[index]
        evidence_hash=digest,
        model=model,
        prompt_version=prompt_version,
        provider=provider,
        payload=record,
    )
