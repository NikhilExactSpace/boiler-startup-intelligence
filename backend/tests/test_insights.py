from __future__ import annotations

import pytest

from app.schemas import DesignCurve
from app.services import insights, store


def _context(demo):
    detail = demo.get("/api/startups/S-1042").json()
    curve_row = store.latest_curve("B-101")
    assert curve_row is not None
    curve = DesignCurve.model_validate(curve_row["curve"])
    return detail["analysis"], curve


def _base_payload(demo):
    analysis, curve = _context(demo)
    record = demo.post("/api/startups/S-1042/insight").json()["record"]
    payload = insights.InsightPayload.model_validate(record["insight"])
    return analysis, curve, payload


def test_deterministic_fallback_is_validated_and_advisory(demo):
    response = demo.post("/api/startups/S-1042/insight")
    assert response.status_code == 200

    record = response.json()["record"]
    meta = record["meta"]
    assert meta["provider"] == "deterministic"
    assert meta["model"] == "deterministic-template"
    assert meta["validation"]["status"] == "deterministic"
    assert meta["authoritative"] is False
    assert "does not determine whether the boiler is safe" in meta["disclaimer"]
    assert record["insight"]["disclaimer"]

    analysis, curve = _context(demo)
    payload = insights.InsightPayload.model_validate(record["insight"])
    notes = insights.validate_insight(payload, analysis, curve)
    assert isinstance(notes, list)
    assert payload.summary
    assert payload.deviations or payload.timeline


def test_validator_rejects_invented_number(demo):
    analysis, curve, payload = _base_payload(demo)
    payload.summary = f"{payload.summary} Drum pressure reached 999.9 barg."

    with pytest.raises(insights.InsightValidationError, match="not grounded"):
        insights.validate_insight(payload, analysis, curve)


def test_validator_rejects_unknown_evidence_id(demo):
    analysis, curve, payload = _base_payload(demo)
    assert payload.timeline
    payload.timeline[0].evidence_ids = ["Z9"]

    with pytest.raises(insights.InsightValidationError, match="unknown evidence ids"):
        insights.validate_insight(payload, analysis, curve)


def test_validator_rejects_safety_verdict_language(demo):
    analysis, curve, payload = _base_payload(demo)
    payload.summary = f"{payload.summary} The boiler is safe to operate."

    with pytest.raises(insights.InsightValidationError, match="safety verdict"):
        insights.validate_insight(payload, analysis, curve)


def test_validator_rejects_limit_deviation_without_source(demo):
    analysis, curve, payload = _base_payload(demo)
    payload.deviations.append(
        insights.DeviationItem(
            signal="Drum pressure",
            what="Pressure moved away from the design ramp.",
            when_min=12.0,
            severity="watch",
            source_ref=None,
            evidence_ids=["V1"],
        )
    )

    with pytest.raises(insights.InsightValidationError, match="must carry a source_ref"):
        insights.validate_insight(payload, analysis, curve)


def test_validator_rejects_unknown_source_ref(demo):
    analysis, curve, payload = _base_payload(demo)
    payload.deviations.append(
        insights.DeviationItem(
            signal="Drum pressure",
            what="Pressure moved away from the design ramp.",
            when_min=12.0,
            severity="watch",
            source_ref="SOP-999 §12",
            evidence_ids=["V1"],
        )
    )

    with pytest.raises(insights.InsightValidationError, match="unknown source_ref"):
        insights.validate_insight(payload, analysis, curve)


def test_validator_rejects_uncited_timeline_item(demo):
    analysis, curve, payload = _base_payload(demo)
    payload.timeline.append(
        insights.TimelineItem(t_min=5.0, event="Operator adjusted the damper.", evidence_ids=[])
    )

    with pytest.raises(insights.InsightValidationError, match="no evidence_ids"):
        insights.validate_insight(payload, analysis, curve)


def test_evidence_hash_is_stable_and_sensitive(demo):
    analysis, _ = _context(demo)
    first = insights.evidence_hash(analysis)
    second = insights.evidence_hash(analysis)
    assert first == second

    analysis["duration"]["actual_min"] = analysis["duration"]["actual_min"] + 0.1
    assert insights.evidence_hash(analysis) != first
