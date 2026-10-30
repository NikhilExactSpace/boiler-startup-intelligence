from __future__ import annotations

import shutil
import subprocess
import tempfile
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from ..config import settings
from ..schemas import DesignCurve
from ..services import extraction, store
from ..services import curve_vision
from ..services.curves import approved_curve, load_seed_curve, scaled_curve

router = APIRouter(tags=["design curves"])


class TextExtractIn(BaseModel):
    boiler_id: str = Field(default=settings.demo_boiler_id)
    text: str = Field(min_length=20)


class ApproveIn(BaseModel):
    boiler_id: str
    draft: dict
    approved_by: str = "shift.engineer"
    startup_type: str = "cold"
    tag_map: dict[str, str] = Field(default_factory=dict)


def _base_curve(boiler_id: str) -> DesignCurve:
    row = store.latest_curve(boiler_id)
    if row:
        return DesignCurve.model_validate(row["curve"])
    seed = load_seed_curve()
    seed.boiler_id = boiler_id
    return seed


def _summarise(row: dict) -> dict:
    curve = DesignCurve.model_validate(row["curve"])
    return {
        "id": row["id"],
        "boiler_id": row["boiler_id"],
        "name": row["name"],
        "version": row["version"],
        "status": row["status"],
        "startup_type": row.get("startup_type") or curve.startup_type,
        "document": row["source_document"],
        "revision": row["source_revision"],
        "sha256": row["sha256"],
        "approved_by": row["approved_by"],
        "approved_at": row["approved_at"],
        "created_at": row["created_at"],
        "design_duration_min": round(curve.duration_min, 2),
        "phases": len(curve.phases),
        "signals": len(curve.signals),
        "limits": sum(len(signal.limits) for signal in curve.signals),
        "analytics_tolerances": sum(
            1
            for signal in curve.signals
            for track in signal.design
            if track.tolerance is not None
        ),
    }


@router.get("/design-curves")
def list_curves(boiler_id: str = settings.demo_boiler_id) -> list[dict]:
    return [_summarise(row) for row in store.list_curves(boiler_id)]


@router.get("/design-curves/{curve_id}")
def get_curve(curve_id: str) -> dict:
    row = store.get_curve(curve_id)
    if not row:
        raise HTTPException(404, "Design curve not found")
    return {**_summarise(row), "curve": row["curve"]}


@router.post("/design-curves/extract")
async def extract_file(
    file: UploadFile = File(...),
    boiler_id: str = Form(default=settings.demo_boiler_id),
) -> dict:
    raw = await file.read()
    if not raw:
        raise HTTPException(422, "The uploaded file is empty")
    if len(raw) > 5 * 1024 * 1024:
        raise HTTPException(413, "Document is larger than 5 MB")
    file_name = file.filename or "uploaded-procedure"
    mime_type = extraction.detect_mime(raw, file_name)

    if mime_type == "text/plain":
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            text = raw.decode("latin-1", errors="replace")
        return _extract(text, boiler_id, file_name)

    pdf_text = None
    if mime_type == "application/pdf":
        try:
            pdf_text = _pdf_text(raw)
        except HTTPException:
            # A scanned PDF has no text layer; Gemini can still read the page images.
            pdf_text = None

    try:
        result = extraction.extract_document(
            raw,
            mime_type=mime_type,
            file_name=file_name,
            boiler_id=boiler_id,
            base=_base_curve(boiler_id),
            pdf_text=pdf_text,
        )
    except extraction.ExtractionError as exc:
        raise HTTPException(422, str(exc)) from exc
    result["draft"].setdefault("extras", {})["source_file"] = _save_source(
        raw, file_name, extraction.sha256_bytes(raw)
    )
    return _finalise(result, boiler_id, file_name)


@router.post("/design-curves/extract-curve")
async def extract_curve_drawing(
    file: UploadFile = File(...),
    boiler_id: str = Form(default=settings.demo_boiler_id),
) -> dict:
    raw = await file.read()
    if not raw:
        raise HTTPException(422, "The uploaded drawing is empty")
    if len(raw) > 8 * 1024 * 1024:
        raise HTTPException(413, "Drawing is larger than 8 MB")
    file_name = file.filename or "uploaded-drawing"
    mime_type = extraction.detect_mime(raw, file_name)
    if mime_type not in {"application/pdf", "image/png", "image/jpeg", "image/webp"}:
        raise HTTPException(422, "Upload a PDF or a PNG/JPG/WebP image of the curve drawing")
    try:
        result = curve_vision.digitize_curve(
            raw,
            mime_type=mime_type,
            file_name=file_name,
            boiler_id=boiler_id,
            base=_base_curve(boiler_id),
        )
    except curve_vision.CurveVisionError as exc:
        raise HTTPException(422, str(exc)) from exc
    result["draft"].setdefault("extras", {})["source_file"] = _save_source(
        raw, file_name, extraction.sha256_bytes(raw)
    )
    return _finalise(result, boiler_id, file_name)


@router.post("/design-curves/extract-text")
def extract_text(payload: TextExtractIn) -> dict:
    return _extract(payload.text, payload.boiler_id, "pasted-procedure.txt")


def _save_source(raw: bytes, file_name: str, sha: str) -> str:
    suffix = Path(file_name).suffix.lower() or ".bin"
    folder = settings.database_path.parent / "uploads"
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / f"{sha}{suffix}"
    if not target.exists():
        target.write_bytes(raw)
    return str(target)


def _extract(text: str, boiler_id: str, file_name: str) -> dict:
    try:
        result = extraction.extract(text, boiler_id=boiler_id, base=_base_curve(boiler_id))
    except extraction.ExtractionError as exc:
        raise HTTPException(422, str(exc)) from exc
    raw = text.encode("utf-8")
    result["draft"].setdefault("extras", {})["source_file"] = _save_source(
        raw, file_name, extraction.sha256_bytes(raw)
    )
    return _finalise(result, boiler_id, file_name)


def _finalise(result: dict, boiler_id: str, file_name: str) -> dict:
    result["document"]["file_name"] = file_name
    result["boiler_id"] = boiler_id
    result["draft"]["source"]["file_name"] = file_name
    result["draft"]["boiler_id"] = boiler_id
    result["draft"]["curve_id"] = (
        f"{boiler_id.lower()}-{result['document']['document'].lower()}-"
        f"r{result['document']['revision'].replace('.', '')}"
    )
    result["draft"]["status"] = "draft"
    return result


@router.post("/design-curves/approve", status_code=201)
def approve(payload: ApproveIn) -> dict:
    try:
        curve = DesignCurve.model_validate(payload.draft)
    except Exception as exc:
        raise HTTPException(422, f"Draft curve failed validation: {exc}") from exc
    if curve.boiler_id != payload.boiler_id:
        raise HTTPException(400, "Draft curve belongs to a different boiler")
    if not payload.approved_by.strip():
        raise HTTPException(400, "approved_by is required")
    if payload.startup_type not in {"cold", "warm", "hot"}:
        raise HTTPException(400, "startup_type must be cold, warm, or hot")

    curve.startup_type = payload.startup_type
    for signal in curve.signals:
        tag = payload.tag_map.get(signal.key)
        if tag:
            signal.kairos.metric = tag.strip()

    boiler = store.get_boiler(payload.boiler_id) or {}
    type_config = (boiler.get("startup_types") or {}).get(payload.startup_type) or {}
    type_duration = type_config.get("design_duration_min")
    base_duration = curve.duration_min
    if type_duration:
        curve = scaled_curve(
            curve,
            startup_type=payload.startup_type,
            duration_min=float(type_duration),
        )
        for signal in curve.signals:
            tag = payload.tag_map.get(signal.key)
            if tag:
                signal.kairos.metric = tag.strip()

    approved = approved_curve(curve, approved_by=payload.approved_by, version=1)
    tag_map = {
        signal.key: signal.kairos.metric
        for signal in approved.signals
        if signal.kairos.metric
    }
    row = store.insert_curve(approved, tag_map=tag_map)
    return {
        "ok": True,
        "curve": _summarise(row),
        "message": (
            f"{payload.startup_type.title()} curve approved and stored as versioned JSON "
            f"({base_duration:.0f} → {approved.duration_min:.0f} min). Existing startups keep "
            "the curve version they were recorded against."
        ),
    }


@router.delete("/design-curves/{curve_id}")
def delete_curve(curve_id: str) -> dict:
    row = store.get_curve(curve_id)
    if not row:
        raise HTTPException(404, "Design curve not found")
    store.delete_curve(curve_id)
    return {
        "ok": True,
        "id": curve_id,
        "message": "Curve hidden from the selector. Stored startups keep their pinned version.",
    }


@router.get("/design-curves/{curve_id}/source")
def curve_source(curve_id: str) -> FileResponse:
    row = store.get_curve(curve_id)
    if not row:
        raise HTTPException(404, "Design curve not found")
    curve = row["curve"] or {}
    path = (curve.get("extras") or {}).get("source_file")
    if not path or not Path(path).exists():
        raise HTTPException(404, "The uploaded source file is not stored for this curve")
    return FileResponse(path)


@router.get("/design-curves/{curve_id}/json")
def curve_json(curve_id: str) -> dict:
    row = store.get_curve(curve_id)
    if not row:
        raise HTTPException(404, "Design curve not found")
    return {
        "id": row["id"],
        "sha256": row["sha256"],
        "curve": row["curve"],
    }


def _pdf_text(raw: bytes) -> str:
    binary = shutil.which("pdftotext")
    if not binary:
        raise HTTPException(
            422,
            "PDF text extraction needs the 'pdftotext' (poppler) binary. "
            "Install poppler or paste the procedure text instead.",
        )
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=True) as handle:
        handle.write(raw)
        handle.flush()
        try:
            result = subprocess.run(
                [binary, handle.name, "-"],
                capture_output=True,
                check=True,
                timeout=30,
            )
        except subprocess.SubprocessError as exc:
            raise HTTPException(422, f"Could not read the PDF: {exc}") from exc
    return result.stdout.decode("utf-8", errors="replace")
