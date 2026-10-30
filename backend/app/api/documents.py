from __future__ import annotations

import json
import time

from fastapi import APIRouter, BackgroundTasks, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel

from ..config import settings
from ..db import query_one
from ..services import docintel, extraction, gemini

router = APIRouter(tags=["document intelligence"])


class ChatIn(BaseModel):
    boiler_id: str = settings.demo_boiler_id
    session_id: str
    question: str


class SessionIn(BaseModel):
    boiler_id: str = settings.demo_boiler_id
    title: str = "New conversation"


@router.get("/documents")
def list_documents(boiler_id: str = settings.demo_boiler_id) -> list[dict]:
    return docintel.list_documents(boiler_id)


@router.post("/documents", status_code=201)
async def upload_document(
    background: BackgroundTasks,
    file: UploadFile = File(...),
    boiler_id: str = Form(default=settings.demo_boiler_id),
    title: str = Form(default=""),
    doc_type: str = Form(default="other"),
) -> dict:
    raw = await file.read()
    if not raw:
        raise HTTPException(422, "The uploaded document is empty")
    if len(raw) > 20 * 1024 * 1024:
        raise HTTPException(413, "Document is larger than 20 MB")
    file_name = file.filename or "uploaded-document"
    mime = extraction.detect_mime(raw, file_name)
    created = docintel.create_document(
        boiler_id=boiler_id,
        title=title or file_name,
        doc_type=doc_type,
        file_name=file_name,
        mime=mime,
        raw=raw,
    )
    background.add_task(docintel.process_document, created["id"])
    return created


@router.get("/documents/{document_id}/source")
def document_source(document_id: str) -> FileResponse:
    row = query_one("SELECT * FROM documents WHERE id = ?", (document_id,))
    if not row:
        raise HTTPException(404, "Document not found")
    path = row.get("source_file")
    if not path or not __import__("pathlib").Path(path).exists():
        raise HTTPException(404, "Source file is not stored")
    return FileResponse(path)


@router.delete("/documents/{document_id}")
def delete_document(document_id: str) -> dict:
    if not docintel.delete_document(document_id):
        raise HTTPException(404, "Document not found")
    return {"ok": True, "id": document_id}


@router.get("/chat/sessions")
def list_sessions(boiler_id: str = settings.demo_boiler_id) -> list[dict]:
    return docintel.list_sessions(boiler_id)


@router.post("/chat/sessions", status_code=201)
def create_session(payload: SessionIn) -> dict:
    return docintel.create_session(payload.boiler_id, payload.title)


@router.get("/chat/sessions/{session_id}/messages")
def session_messages(session_id: str) -> list[dict]:
    return docintel.messages(session_id)


@router.post("/chat/stream")
def chat_stream(payload: ChatIn) -> StreamingResponse:
    docintel.add_message(payload.session_id, "user", payload.question)
    prepared = docintel.prepare_answer(payload.boiler_id, payload.session_id, payload.question)

    def events():
        yield "event: meta\ndata: " + json.dumps(
            {"session_id": payload.session_id, "citations": prepared["citations"]}
        ) + "\n\n"

        answer = prepared["content"]
        if prepared["prompt"]:
            try:
                for token in gemini.generate_content_stream(
                    [{"text": prepared["prompt"]}],
                    model=settings.gemini_model,
                    temperature=0.15,
                    max_output_tokens=1200,
                    timeout=60,
                ):
                    answer += token
                    yield "event: token\ndata: " + json.dumps({"token": token}) + "\n\n"
            except Exception as exc:
                answer = answer or f"Document assistant is unavailable: {exc}"
                yield "event: token\ndata: " + json.dumps({"token": answer}) + "\n\n"
        else:
            yield "event: token\ndata: " + json.dumps({"token": answer}) + "\n\n"

        citations = docintel.finalize_answer(
            payload.session_id, answer, prepared["citations"]
        )
        yield "event: citations\ndata: " + json.dumps(citations) + "\n\n"
        yield "event: done\ndata: {}\n\n"

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
