"""BoilerIQ storage on Postgres + pgvector + HNSW + tsvector."""

from __future__ import annotations

import hashlib
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import psycopg
from psycopg.rows import dict_row

from ..config import settings
from . import gemini
from . import docintel as base

SCHEMA = """
CREATE TABLE IF NOT EXISTS rag_documents (
    id TEXT PRIMARY KEY,
    boiler_id TEXT NOT NULL,
    title TEXT NOT NULL,
    doc_type TEXT NOT NULL DEFAULT 'other',
    source_file TEXT NOT NULL DEFAULT '',
    mime_type TEXT NOT NULL DEFAULT '',
    sha256 TEXT NOT NULL DEFAULT '',
    pages INTEGER NOT NULL DEFAULT 0,
    summary TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'ready',
    error TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rag_chunks (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES rag_documents(id) ON DELETE CASCADE,
    boiler_id TEXT NOT NULL,
    page INTEGER NOT NULL DEFAULT 0,
    chunk_index INTEGER NOT NULL,
    text TEXT NOT NULL,
    chunk_type TEXT NOT NULL DEFAULT 'prose',
    context_text TEXT NOT NULL DEFAULT '',
    keywords JSONB NOT NULL DEFAULT '[]'::jsonb,
    embedding halfvec(3072),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    search tsvector GENERATED ALWAYS AS (
        to_tsvector('english',
            coalesce(text, '') || ' ' ||
            coalesce(context_text, '') || ' ' ||
            coalesce(keywords::text, ''))
    ) STORED
);

CREATE INDEX IF NOT EXISTS idx_rag_chunks_boiler ON rag_chunks(boiler_id);
CREATE INDEX IF NOT EXISTS idx_rag_chunks_fts ON rag_chunks USING GIN(search);
CREATE INDEX IF NOT EXISTS idx_rag_chunks_vector ON rag_chunks
    USING hnsw (embedding halfvec_cosine_ops);

CREATE TABLE IF NOT EXISTS rag_sessions (
    id TEXT PRIMARY KEY,
    boiler_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT 'New conversation',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rag_messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES rag_sessions(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    citations JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
"""

_ready = False


def _connect():
    return psycopg.connect(settings.rag_database_url, row_factory=dict_row)


def ensure() -> None:
    global _ready
    if _ready:
        return
    with _connect() as conn:
        conn.execute(SCHEMA)
    _ready = True


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _vector(values: list[float]) -> str:
    return "[" + ",".join(f"{value:.6f}" for value in values) + "]"


def ingest_document(
    *,
    boiler_id: str,
    title: str,
    doc_type: str,
    file_name: str,
    mime: str,
    raw: bytes,
) -> dict[str, Any]:
    ensure()
    doc_id = f"DOC-{uuid.uuid4().hex[:10]}"
    sha = hashlib.sha256(raw).hexdigest()
    suffix = Path(file_name).suffix.lower() or ".bin"
    folder = settings.database_path.parent / "documents"
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / f"{doc_id}{suffix}"
    target.write_bytes(raw)
    text = base._extract_text(target, mime)
    status = "ready" if text.strip() else "failed"
    error = "" if status == "ready" else "No text could be extracted from this document"
    summary = base._document_summary(text, title or file_name) if text.strip() else ""
    chunks = base._enrich_chunks(base._chunk_document(text, title or file_name), title or file_name)
    embeddings: list[list[float]] = []
    if chunks:
        try:
            embeddings = gemini.embed([base._embed_text(row, title or file_name) for row in chunks])
        except Exception:
            embeddings = []

    with _connect() as conn:
        conn.execute(
            """INSERT INTO rag_documents
               (id, boiler_id, title, doc_type, source_file, mime_type, sha256,
                pages, summary, status, error)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
            (
                doc_id,
                boiler_id,
                title or file_name,
                doc_type,
                str(target),
                mime,
                sha,
                max((row["page"] for row in chunks), default=0),
                summary,
                status,
                error,
            ),
        )
        for index, row in enumerate(chunks):
            vector = embeddings[index] if index < len(embeddings) else None
            conn.execute(
                """INSERT INTO rag_chunks
                   (id, document_id, boiler_id, page, chunk_index, text,
                    chunk_type, context_text, keywords, embedding)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s::halfvec)""",
                (
                    f"{doc_id}-C{index}",
                    doc_id,
                    boiler_id,
                    row["page"],
                    index,
                    row["text"],
                    row["type"],
                    row.get("context", ""),
                    __import__("json").dumps(row.get("keywords", [])),
                    _vector(vector) if vector else None,
                ),
            )
    return {
        "id": doc_id,
        "title": title or file_name,
        "doc_type": doc_type,
        "status": status,
        "error": error,
        "chunks": len(chunks),
        "pages": max((row["page"] for row in chunks), default=0),
        "source_file": str(target),
    }


def list_documents(boiler_id: str) -> list[dict[str, Any]]:
    ensure()
    with _connect() as conn:
        rows = conn.execute(
            """SELECT d.*, (SELECT count(*) FROM rag_chunks c WHERE c.document_id=d.id) AS chunks
               FROM rag_documents d WHERE boiler_id=%s ORDER BY created_at DESC""",
            (boiler_id,),
        ).fetchall()
    for row in rows:
        if row.get("created_at"):
            row["created_at"] = row["created_at"].isoformat()
    return rows


def get_document(document_id: str) -> dict[str, Any] | None:
    ensure()
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM rag_documents WHERE id=%s", (document_id,)
        ).fetchone()
    return row


def delete_document(document_id: str) -> bool:
    ensure()
    with _connect() as conn:
        row = conn.execute(
            "SELECT source_file FROM rag_documents WHERE id=%s", (document_id,)
        ).fetchone()
        if not row:
            return False
        conn.execute("DELETE FROM rag_documents WHERE id=%s", (document_id,))
    try:
        Path(row["source_file"]).unlink(missing_ok=True)
    except OSError:
        pass
    return True


def retrieve(boiler_id: str, question: str, limit: int = 4) -> list[dict[str, Any]]:
    ensure()
    analysis = base._analyse_query(question)
    search_text = analysis["rewritten"] + " " + " ".join(analysis["keywords"])
    lexical: list[dict[str, Any]] = []
    semantic: list[dict[str, Any]] = []
    with _connect() as conn:
        try:
            lexical = conn.execute(
                """SELECT c.*, d.title, d.doc_type, d.source_file, d.mime_type
                   FROM rag_chunks c JOIN rag_documents d ON d.id=c.document_id
                   WHERE c.boiler_id=%s AND c.search @@ websearch_to_tsquery('english', %s)
                   ORDER BY ts_rank(c.search, websearch_to_tsquery('english', %s)) DESC
                   LIMIT 20""",
                (boiler_id, search_text, search_text),
            ).fetchall()
        except Exception:
            lexical = []
        try:
            vector = gemini.embed([search_text])[0]
            semantic = conn.execute(
                """SELECT c.*, d.title, d.doc_type, d.source_file, d.mime_type
                   FROM rag_chunks c JOIN rag_documents d ON d.id=c.document_id
                   WHERE c.boiler_id=%s AND c.embedding IS NOT NULL
                   ORDER BY c.embedding <=> %s::halfvec LIMIT 20""",
                (boiler_id, _vector(vector)),
            ).fetchall()
        except Exception:
            semantic = []

    merged: dict[str, float] = {}
    rows: dict[str, dict[str, Any]] = {}
    for items in (semantic, lexical):
        for index, row in enumerate(items):
            rows[row["id"]] = row
            merged[row["id"]] = merged.get(row["id"], 0.0) + 1.0 / (60 + index)
    query_terms = {w.lower() for w in re.findall(r"[A-Za-z0-9]+", question) if len(w) > 2}
    numbers = set(re.findall(r"\d+(?:\.\d+)?", question))

    def score(chunk_id: str) -> float:
        row = rows[chunk_id]
        haystack = " ".join(
            [row.get("text", ""), row.get("context_text", ""), str(row.get("keywords", ""))]
        ).lower()
        overlap = sum(1 for term in query_terms if term in haystack)
        numeric = sum(1 for number in numbers if number in haystack)
        table_boost = 0.2 if analysis["intent"] == "numeric" and row.get("chunk_type") == "table" else 0
        return merged[chunk_id] + 0.01 * overlap + 0.15 * numeric + table_boost

    ordered = [rows[key] for key in sorted(merged, key=score, reverse=True)]
    seen: dict[str, int] = {}
    output = []
    for row in ordered:
        count = seen.get(row["document_id"], 0)
        if count >= 2:
            continue
        seen[row["document_id"]] = count + 1
        output.append(row)
    return output[:limit]


def create_session(boiler_id: str, title: str = "New conversation") -> dict[str, Any]:
    ensure()
    session_id = f"CHAT-{uuid.uuid4().hex[:10]}"
    with _connect() as conn:
        conn.execute(
            "INSERT INTO rag_sessions (id, boiler_id, title) VALUES (%s,%s,%s)",
            (session_id, boiler_id, title),
        )
    return {"id": session_id, "boiler_id": boiler_id, "title": title}


def list_sessions(boiler_id: str) -> list[dict[str, Any]]:
    ensure()
    with _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM rag_sessions WHERE boiler_id=%s ORDER BY updated_at DESC",
            (boiler_id,),
        ).fetchall()
    for row in rows:
        for key in ("created_at", "updated_at"):
            if row.get(key):
                row[key] = row[key].isoformat()
    return rows


def messages(session_id: str) -> list[dict[str, Any]]:
    ensure()
    with _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM rag_messages WHERE session_id=%s ORDER BY created_at",
            (session_id,),
        ).fetchall()
    for row in rows:
        if row.get("created_at"):
            row["created_at"] = row["created_at"].isoformat()
    return rows


def add_message(session_id: str, role: str, content: str, citations: list | None = None) -> None:
    ensure()
    import json

    with _connect() as conn:
        conn.execute(
            "INSERT INTO rag_messages (id, session_id, role, content, citations) VALUES (%s,%s,%s,%s,%s::jsonb)",
            (f"MSG-{uuid.uuid4().hex[:10]}", session_id, role, content, json.dumps(citations or [])),
        )
        conn.execute("UPDATE rag_sessions SET updated_at=now() WHERE id=%s", (session_id,))


def _history(session_id: str, limit: int = 8) -> list[dict[str, str]]:
    ensure()
    with _connect() as conn:
        rows = conn.execute(
            "SELECT role, content FROM rag_messages WHERE session_id=%s ORDER BY created_at DESC LIMIT %s",
            (session_id, limit),
        ).fetchall()
    return list(reversed(rows))


def answer(boiler_id: str, session_id: str, question: str) -> dict[str, Any]:
    chunks = retrieve(boiler_id, question)
    context = "\n\n".join(
        f"[{i + 1}] {row['title']} (page {row['page']})\n{row['text']}"
        for i, row in enumerate(chunks)
    )
    if not chunks:
        content = (
            "I could not find this in the indexed documents for this boiler. "
            "Upload or index the relevant manual, SOP or report first."
        )
        add_message(session_id, "assistant", content, [])
        return {"content": content, "citations": []}
    prior = "\n".join(f"{row['role']}: {row['content']}" for row in _history(session_id))
    prompt = f"""You are BoilerIQ, a boiler document assistant. Answer only from the retrieved
documents. Be direct, quote exact values/times/limits, cite each factual sentence with [n],
use only relevant sources, and say when the answer is not present. Advisory only.

BOILER: {boiler_id}
RECENT CONVERSATION:
{prior or "(none)"}

RETRIEVED DOCUMENTS:
{context}

QUESTION: {question}"""
    try:
        text, _ = gemini.generate_content(
            [{"text": prompt}],
            model=settings.gemini_model,
            temperature=0.15,
            max_output_tokens=4096,
            timeout=90,
        )
        content = text.strip()
    except Exception as exc:
        content = f"BoilerIQ is unavailable: {exc}"
    citations = [
        {
            "n": i + 1,
            "document_id": row["document_id"],
            "title": row["title"],
            "page": row["page"],
            "snippet": row["text"][:240],
        }
        for i, row in enumerate(chunks)
    ]
    used = {int(value) for value in re.findall(r"\[(\d+)\]", content)}
    if used:
        citations = [citation for citation in citations if citation["n"] in used]
    else:
        citations = citations[:2]
    add_message(session_id, "assistant", content, citations)
    return {"content": content, "citations": citations}
