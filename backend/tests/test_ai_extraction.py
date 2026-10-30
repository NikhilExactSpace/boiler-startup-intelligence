from __future__ import annotations

import pytest

from app.services import extraction
from app.services.curves import load_seed_curve


def _facts(**overrides):
    payload = {
        "document": {
            "document": "SOP-202",
            "revision": "3.0",
            "title": "Boiler Startup Procedure - SOP-202",
            "equipment": "B-101",
            "source_quote": "Boiler Startup Procedure - SOP-202\nEquipment: Boiler B-101 | Document: SOP-202 | Rev: 3.0",
        },
        "phases": [
            {
                "key": "purge",
                "duration_min": 5,
                "source_quote": "Run forced draft fan F-101 for 5 minutes at 30% speed.",
                "confidence": 0.98,
            }
        ],
        "ramps": [
            {
                "from_barg": 0,
                "to_barg": 10,
                "rate_bar_per_min": 0.5,
                "source_quote": "0-10 barg: 0.5 bar/min",
                "confidence": 0.98,
            },
            {
                "from_barg": 10,
                "to_barg": 30,
                "rate_bar_per_min": 1.0,
                "source_quote": "10-30 barg: 1.0 bar/min",
                "confidence": 0.98,
            },
            {
                "from_barg": 30,
                "to_barg": 50,
                "rate_bar_per_min": 0.75,
                "source_quote": "30-50 barg: 0.75 bar/min",
                "confidence": 0.98,
            },
        ],
        "limits": [
            {
                "signal": "drum_level",
                "limit": "drum_level_band",
                "value": None,
                "min": 40,
                "max": 70,
                "source_quote": "Drum Level must remain between 40-70% throughout startup",
                "source_ref": "SOP-202 §4",
                "confidence": 0.99,
            },
            {
                "signal": "drum_level",
                "limit": "drum_level_abort",
                "value": 25,
                "min": None,
                "max": None,
                "source_quote": "Drum level drops below 25%",
                "source_ref": "SOP-202 §5",
                "confidence": 0.99,
            },
            {
                "signal": "superheater_outlet_temp",
                "limit": "sh_temp_max",
                "value": 450,
                "min": None,
                "max": None,
                "source_quote": "Superheater outlet temperature should not exceed 450 C",
                "source_ref": "SOP-202 §4",
                "confidence": 0.99,
            },
        ],
        "prerequisites": [
            {
                "key": "fg_pressure_ready",
                "value": None,
                "min": 3.5,
                "max": 4.5,
                "source_quote": "Verify fuel gas pressure between 3.5-4.5 barg at header FG-001",
                "source_ref": "SOP-202 §2",
                "confidence": 0.97,
            }
        ],
        "unknowns": ["No distinct pilot duration is printed."],
    }
    payload.update(overrides)
    return extraction.AiFacts.model_validate(payload)


def _apply(facts):
    return extraction.apply_facts(
        facts,
        boiler_id="B-101",
        base=load_seed_curve(),
        source_sha256="0" * 64,
        text_sha256="1" * 64,
        character_count=1234,
    )


def test_grounded_facts_rebuild_the_curve_and_keep_provenance():
    result = _apply(_facts())
    draft = result["draft"]

    assert draft["status"] == "draft"
    assert draft["source"]["document"] == "SOP-202"
    assert draft["source"]["revision"] == "3.0"
    assert draft["source"]["sha256"] == "0" * 64
    assert draft["extras"]["extraction"]["mode"] == "gemini"

    phases = {phase["key"]: phase for phase in draft["phases"]}
    assert phases["purge"]["end_min"] == 5
    assert phases["ramp_0_10"]["end_min"] == pytest.approx(26)
    assert phases["ramp_10_30"]["end_min"] == pytest.approx(46)
    assert phases["stabilize"]["end_min"] == pytest.approx(107, abs=0.01)

    limits = {
        (signal["key"], limit["key"]): limit
        for signal in draft["signals"]
        for limit in signal["limits"]
    }
    assert (limits[("drum_level", "drum_level_band")]["min"], limits[("drum_level", "drum_level_band")]["max"]) == (40, 70)
    assert limits[("drum_level", "drum_level_abort")]["value"] == 25
    assert limits[("superheater_outlet_temp", "sh_temp_max")]["value"] == 450
    assert limits[("drum_level", "drum_level_band")]["source_ref"] == "SOP-202 §4"

    prereq = next(item for item in draft["prerequisites"] if item["key"] == "fg_pressure_ready")
    assert (prereq["min"], prereq["max"]) == (3.5, 4.5)

    assert result["ai"]["fact_counts"]["rejected"] == 0
    assert result["ai"]["fact_counts"]["applied"] == len(result["extracted"])
    assert all(field["source_line"] for field in result["extracted"])
    assert result["unknowns"] == ["No distinct pilot duration is printed."]
    assert result["document"]["engine"] == "ai-gemini"


def test_ungrounded_number_is_rejected_instead_of_applied():
    facts = _facts(
        limits=[
            {
                "signal": "nox",
                "limit": "nox_max",
                "value": 999,
                "min": None,
                "max": None,
                "source_quote": "NOx emissions must stay below 50 ppm",
                "source_ref": "SOP-202 §4",
                "confidence": 0.99,
            }
        ]
    )
    # Only the limit is replaced, so the document quote alone cannot keep the draft alive.
    result = _apply(facts)
    nox = next(
        limit
        for signal in result["draft"]["signals"]
        if signal["key"] == "nox"
        for limit in signal["limits"]
        if limit["key"] == "nox_max"
    )
    assert nox["value"] == 50
    assert result["ai"]["fact_counts"]["rejected"] == 1
    assert any("not in its quoted source" in warning for warning in result["warnings"])


def test_upper_bound_in_max_slot_is_folded_into_the_operators_value():
    facts = _facts(
        limits=[
            {
                "signal": "superheater_outlet_temp",
                "limit": "sh_temp_max",
                "value": None,
                "min": None,
                "max": 450,
                "source_quote": "Superheater outlet temperature should not exceed 450 C",
                "source_ref": "SOP-202 §4",
                "confidence": 0.99,
            }
        ]
    )
    result = _apply(facts)
    limit = next(
        item
        for signal in result["draft"]["signals"]
        if signal["key"] == "superheater_outlet_temp"
        for item in signal["limits"]
        if item["key"] == "sh_temp_max"
    )
    assert limit["op"] == "lte"
    assert limit["value"] == 450


def test_flame_failure_seconds_stay_a_hold_time():
    facts = _facts(
        limits=[
            {
                "signal": "flame_detected",
                "limit": "flame_loss_abort",
                "value": 4,
                "min": None,
                "max": None,
                "source_quote": "Flame failure detected for more than 4 seconds",
                "source_ref": "SOP-202 §5",
                "confidence": 0.99,
            }
        ]
    )
    result = _apply(facts)
    limit = next(
        item
        for signal in result["draft"]["signals"]
        if signal["key"] == "flame_detected"
        for item in signal["limits"]
        if item["key"] == "flame_loss_abort"
    )
    assert limit["value"] == 1
    assert limit["hold_seconds"] == 4


def test_unreadable_document_is_an_explicit_error():
    empty = _facts(document={}, phases=[], ramps=[], limits=[], prerequisites=[], unknowns=[])
    with pytest.raises(extraction.ExtractionError, match="no grounded facts"):
        _apply(empty)


def test_mime_detection_prefers_magic_bytes_over_extension():
    assert extraction.detect_mime(b"%PDF-1.7\n", "scan.dat") == "application/pdf"
    assert extraction.detect_mime(b"\x89PNG\r\n\x1a\nrest", "page.txt") == "image/png"
    assert extraction.detect_mime(b"\xff\xd8\xff\xe0rest", "photo") == "image/jpeg"
    assert extraction.detect_mime(b"RIFF0000WEBPVP8 ", "x.bin") == "image/webp"
    assert extraction.detect_mime(b"plain procedure text", "sop.txt") == "text/plain"


def test_image_upload_without_ai_is_a_clear_422(demo):
    response = demo.post(
        "/api/design-curves/extract",
        files={"file": ("scan.png", b"\x89PNG\r\n\x1a\nnot-really-a-png", "image/png")},
        data={"boiler_id": "B-101"},
    )
    assert response.status_code == 422
    assert "AI extraction is not configured" in response.json()["detail"]


def test_text_upload_stays_deterministic(demo):
    sop = demo.get("/api/demo/sop-text").json()
    response = demo.post(
        "/api/design-curves/extract",
        files={"file": ("sop202.txt", sop["text"].encode(), "text/plain")},
        data={"boiler_id": "B-101"},
    )
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["document"]["engine"] == "deterministic"
    assert "ai" not in result
