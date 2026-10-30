from __future__ import annotations

import pytest


def test_seed_runs_are_deterministic_and_classified(demo):
    rows = demo.get("/api/startups", params={"boiler_id": "B-101"}).json()
    scores = {row["id"]: row for row in rows}

    assert set(scores) == {"S-1039", "S-1040", "S-1041", "S-1042", "S-1043"}
    assert scores["S-1039"]["score"] == pytest.approx(96.8, abs=0.2)
    assert scores["S-1039"]["score_status"] == "nominal"
    assert scores["S-1040"]["score"] == pytest.approx(89.3, abs=0.2)
    assert scores["S-1040"]["score_status"] == "nominal"
    assert scores["S-1041"]["score_status"] == "watch"
    assert scores["S-1042"]["score"] == pytest.approx(67.8, abs=0.2)
    assert scores["S-1042"]["score_status"] == "watch"
    assert scores["S-1043"]["score"] == pytest.approx(45.0, abs=0.2)
    assert scores["S-1043"]["score_status"] == "attention"
    assert scores["S-1043"]["status"] == "aborted"

    # A second load of the same seeded rows must not drift.
    again = demo.get("/api/startups", params={"boiler_id": "B-101"}).json()
    assert [row["score"] for row in again] == [row["score"] for row in rows]


def test_hero_startup_evidence_is_stable(demo):
    payload = demo.get("/api/startups/S-1042").json()
    analysis = payload["analysis"]

    assert analysis["startup"]["id"] == "S-1042"
    assert analysis["curve"]["document"] == "SOP-202"
    assert analysis["curve"]["revision"] == "3.0"

    # Duration and tracking lag are the numbers the demo narrative quotes.
    assert analysis["duration"]["design_min"] == pytest.approx(107.0, abs=0.01)
    assert analysis["duration"]["actual_min"] == pytest.approx(119.99, abs=0.05)
    assert analysis["duration"]["delta_min"] == pytest.approx(12.99, abs=0.05)
    assert analysis["lag"]["minutes"] == pytest.approx(8.0, abs=0.1)

    # Three pressure milestones arrive late; M3 is the worst.
    milestones = {row["id"]: row for row in analysis["milestones"]}
    assert milestones["M1"]["delta_min"] == pytest.approx(4.0, abs=0.1)
    assert milestones["M2"]["delta_min"] == pytest.approx(10.8, abs=0.1)
    assert milestones["M3"]["delta_min"] == pytest.approx(12.8, abs=0.1)
    assert milestones["M3"]["status"] == "late"

    # Two documented watch deviations, each pinned to the procedure.
    violations = {row["id"]: row for row in analysis["violations"]}
    assert set(violations) == {"V1", "V2"}
    assert violations["V2"]["signal"] == "drum_level"
    assert violations["V2"]["severity"] == "watch"
    assert violations["V2"]["worst"] == pytest.approx(37.3, abs=0.1)
    assert violations["V2"]["worst_at"] == pytest.approx(26.75, abs=0.05)
    assert violations["V2"]["source_ref"] == "SOP-202 §4"
    assert violations["V1"]["signal"] == "nox"
    assert violations["V1"]["worst"] == pytest.approx(60.0, abs=0.1)
    assert violations["V1"]["worst_at"] == pytest.approx(10.5, abs=0.05)

    # The false flame-loss abort must not come back. Only manual criteria remain.
    assert analysis["abort_flags"], "manual criteria must still be reported"
    assert all(
        flag["type"] == "manual_criterion" for flag in analysis["abort_flags"]
    ), "no observed abort threshold should be flagged for S-1042"

    # The score is performance-only, transparent and capped.
    score = analysis["score"]
    assert score["value"] == pytest.approx(67.8, abs=0.2)
    assert score["status"] == "watch"
    assert score["weights"] == {
        "tracking": 0.4,
        "bands": 0.3,
        "timing": 0.2,
        "stability": 0.1,
    }
    assert "not a safety assessment" in score["note"]

    # Every chart series is aligned and every evidence id resolves.
    chart = payload["chart"]
    assert len(chart["grid"]) == len(chart["signals"]["drum_pressure"]["actual"])
    assert analysis["evidence_ids"] == sorted(set(analysis["evidence_ids"]))
    assert {"V1", "V2", "M1", "M2", "M3", "L1", "Q1"} <= set(analysis["evidence_ids"])


def test_compare_payload_aligns_runs_and_envelope(demo):
    comparison = demo.get("/api/startups/S-1042/compare").json()

    assert comparison["target_id"] == "S-1042"
    assert comparison["peer_count"] == 4
    assert comparison["start_min"] == pytest.approx(-15.0)
    assert comparison["end_min"] == pytest.approx(119.99, abs=0.05)
    assert len(comparison["grid"]) == len(comparison["envelope"]["drum_pressure"]["median"])
    assert len(comparison["runs"]) == 5
    assert len(comparison["table"]) == 5
    assert comparison["table"][0]["id"] == "S-1042"

    target = next(run for run in comparison["runs"] if run["id"] == "S-1042")
    assert len(target["signals"]["drum_pressure"]) == len(comparison["grid"])
    assert max(comparison["envelope"]["drum_pressure"]["count"]) >= 1

    # Peer envelope is descriptive, so the median must sit inside the IQR.
    for index, median in enumerate(comparison["envelope"]["drum_pressure"]["median"]):
        if median is None:
            continue
        low = comparison["envelope"]["drum_pressure"]["p25"][index]
        high = comparison["envelope"]["drum_pressure"]["p75"][index]
        assert low is not None and high is not None
        assert low <= median <= high
