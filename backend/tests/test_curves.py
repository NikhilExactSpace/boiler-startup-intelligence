from __future__ import annotations


def test_extraction_transcribes_and_approval_versions(demo):
    created = demo.post(
        "/api/boilers",
        json={"id": "B-200", "name": "Test boiler B-200", "site": "Test bay", "tag_prefix": "B200"},
    )
    assert created.status_code == 201, created.text

    sop = demo.get("/api/demo/sop-text").json()
    extracted = demo.post(
        "/api/design-curves/extract-text",
        json={"boiler_id": "B-200", "text": sop["text"]},
    )
    assert extracted.status_code == 200, extracted.text
    result = extracted.json()

    assert result["boiler_id"] == "B-200"
    assert any("verify the equipment mapping" in warning for warning in result["warnings"])
    assert not any("could not" in warning.lower() for warning in result["warnings"])
    assert result["document"]["document"] == "SOP-202"
    assert result["document"]["revision"] == "3.0"
    assert len(result["extracted"]) >= 20
    assert all(field["source_line"] for field in result["extracted"])
    assert all(0.0 < field["confidence"] <= 1.0 for field in result["extracted"])

    draft = result["draft"]
    assert draft["boiler_id"] == "B-200"
    assert draft["status"] == "draft"
    assert draft["phases"]
    assert draft["signals"]
    assert all(
        limit["source_ref"]
        for signal in draft["signals"]
        for limit in signal["limits"]
    ), "every extracted limit must cite the document"

    first = demo.post(
        "/api/design-curves/approve",
        json={"boiler_id": "B-200", "draft": draft, "approved_by": "review.engineer"},
    )
    assert first.status_code == 201, first.text
    first_curve = first.json()["curve"]
    assert first_curve["version"] == 1
    assert first_curve["approved_by"] == "review.engineer"
    assert first_curve["status"] == "approved"

    second = demo.post(
        "/api/design-curves/approve",
        json={"boiler_id": "B-200", "draft": draft, "approved_by": "review.engineer"},
    )
    assert second.status_code == 201, second.text
    second_curve = second.json()["curve"]
    assert second_curve["version"] == 2
    assert second_curve["id"] != first_curve["id"]

    versions = demo.get("/api/design-curves", params={"boiler_id": "B-200"}).json()
    assert [row["version"] for row in versions] == [2, 1]

    # Existing B-101 startups keep the curve they were recorded against.
    startup = demo.get("/api/startups/S-1042").json()["startup"]
    assert startup["curve_id"] == "b101-sop202-r3"


def test_boiler_onboarding_rejects_bad_ids_and_duplicates(demo):
    response = demo.post("/api/boilers", json={"id": "bad id!", "name": "Nope"})
    assert response.status_code == 400

    first = demo.post("/api/boilers", json={"id": "B-201", "name": "Boiler B-201"})
    assert first.status_code == 201
    duplicate = demo.post("/api/boilers", json={"id": "B-201", "name": "Boiler B-201 again"})
    assert duplicate.status_code >= 400


def test_curve_approval_rejects_wrong_boiler(demo):
    sop = demo.get("/api/demo/sop-text").json()
    draft = demo.post(
        "/api/design-curves/extract-text",
        json={"boiler_id": "B-101", "text": sop["text"]},
    ).json()["draft"]

    response = demo.post(
        "/api/design-curves/approve",
        json={"boiler_id": "B-999", "draft": draft, "approved_by": "review.engineer"},
    )
    assert response.status_code == 400


def test_extract_rejects_short_text(demo):
    response = demo.post(
        "/api/design-curves/extract-text",
        json={"boiler_id": "B-101", "text": "too short"},
    )
    assert response.status_code == 422
