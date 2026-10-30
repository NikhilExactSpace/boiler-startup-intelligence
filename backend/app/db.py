"""SQLite persistence.

Design curves are stored as *versioned JSON documents*; startups keep a pointer to the
curve version that was active when they happened, so re-approving a procedure never
rewrites history.
"""

from __future__ import annotations

import json
import re
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from .config import settings

SCHEMA = """
CREATE TABLE IF NOT EXISTS boilers (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    site          TEXT NOT NULL DEFAULT '',
    tag_prefix    TEXT NOT NULL DEFAULT '',
    kairos_mode   TEXT NOT NULL DEFAULT 'mock',
    tag_map       TEXT NOT NULL DEFAULT '{}',
    startup_types TEXT NOT NULL DEFAULT '{}',
    type_thresholds TEXT NOT NULL DEFAULT '{}',
    created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS design_curves (
    id              TEXT PRIMARY KEY,
    boiler_id       TEXT NOT NULL,
    name            TEXT NOT NULL,
    version         INTEGER NOT NULL,
    status          TEXT NOT NULL,
    startup_type    TEXT NOT NULL DEFAULT 'cold',
    curve           TEXT NOT NULL,
    source_document TEXT NOT NULL DEFAULT '',
    source_revision TEXT NOT NULL DEFAULT '',
    sha256          TEXT NOT NULL DEFAULT '',
    approved_by     TEXT NOT NULL DEFAULT '',
    approved_at     TEXT NOT NULL DEFAULT '',
    created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_curves_boiler ON design_curves(boiler_id, version DESC);

CREATE TABLE IF NOT EXISTS boiler_parameters (
    boiler_id       TEXT NOT NULL,
    key             TEXT NOT NULL,
    label           TEXT NOT NULL DEFAULT '',
    unit            TEXT NOT NULL DEFAULT '',
    tag             TEXT NOT NULL DEFAULT '',
    alarm_low       REAL,
    alarm_high      REAL,
    created_at      TEXT NOT NULL,
    PRIMARY KEY (boiler_id, key)
);

CREATE TABLE IF NOT EXISTS startups (
    id              TEXT PRIMARY KEY,
    boiler_id       TEXT NOT NULL,
    curve_id        TEXT NOT NULL,
    label           TEXT NOT NULL,
    detected_start  TEXT NOT NULL,
    detected_end    TEXT,
    status          TEXT NOT NULL,
    source          TEXT NOT NULL DEFAULT 'mock',
    startup_type    TEXT NOT NULL DEFAULT 'cold',
    duration_min    REAL,
    score           REAL,
    series          TEXT NOT NULL,
    meta            TEXT NOT NULL DEFAULT '{}',
    created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_startups_boiler ON startups(boiler_id, detected_start DESC);

CREATE TABLE IF NOT EXISTS documents (
    id              TEXT PRIMARY KEY,
    boiler_id       TEXT NOT NULL,
    title           TEXT NOT NULL,
    doc_type        TEXT NOT NULL DEFAULT 'other',
    source_file     TEXT NOT NULL DEFAULT '',
    mime_type       TEXT NOT NULL DEFAULT '',
    sha256          TEXT NOT NULL DEFAULT '',
    pages           INTEGER NOT NULL DEFAULT 0,
    summary         TEXT NOT NULL DEFAULT '',
    status          TEXT NOT NULL DEFAULT 'ready',
    error           TEXT NOT NULL DEFAULT '',
    created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_documents_boiler ON documents(boiler_id, created_at DESC);

CREATE TABLE IF NOT EXISTS document_chunks (
    id              TEXT PRIMARY KEY,
    document_id     TEXT NOT NULL,
    boiler_id       TEXT NOT NULL,
    page            INTEGER NOT NULL DEFAULT 0,
    chunk_index     INTEGER NOT NULL,
    text            TEXT NOT NULL,
    chunk_type      TEXT NOT NULL DEFAULT 'prose',
    context_text    TEXT NOT NULL DEFAULT '',
    keywords        TEXT NOT NULL DEFAULT '[]',
    embedding       TEXT NOT NULL DEFAULT '[]',
    created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunks_document ON document_chunks(document_id, chunk_index);
CREATE VIRTUAL TABLE IF NOT EXISTS document_chunks_fts USING fts5(
    text, chunk_id UNINDEXED, document_id UNINDEXED, boiler_id UNINDEXED
);

CREATE TABLE IF NOT EXISTS chat_sessions (
    id              TEXT PRIMARY KEY,
    boiler_id       TEXT NOT NULL,
    title           TEXT NOT NULL DEFAULT 'New conversation',
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_messages (
    id              TEXT PRIMARY KEY,
    session_id      TEXT NOT NULL,
    role            TEXT NOT NULL,
    content         TEXT NOT NULL,
    citations       TEXT NOT NULL DEFAULT '[]',
    created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON chat_messages(session_id, created_at);

CREATE TABLE IF NOT EXISTS insights (
    id              TEXT PRIMARY KEY,
    startup_id      TEXT NOT NULL,
    evidence_hash   TEXT NOT NULL,
    model           TEXT NOT NULL,
    prompt_version  TEXT NOT NULL,
    provider        TEXT NOT NULL,
    payload         TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    UNIQUE(startup_id, evidence_hash, model, prompt_version)
);
"""


def init_db(path: Path | None = None) -> None:
    target = path or settings.database_path
    target.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(target) as conn:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.executescript(SCHEMA)
        _ensure_column(conn, "boilers", "startup_types", "TEXT NOT NULL DEFAULT '{}'")
        _ensure_column(conn, "boilers", "type_thresholds", "TEXT NOT NULL DEFAULT '{}'")
        _ensure_column(conn, "startups", "startup_type", "TEXT NOT NULL DEFAULT 'cold'")
        _ensure_column(conn, "design_curves", "startup_type", "TEXT NOT NULL DEFAULT 'cold'")
        _ensure_column(conn, "document_chunks", "embedding", "TEXT NOT NULL DEFAULT '[]'")
        _ensure_column(conn, "document_chunks", "chunk_type", "TEXT NOT NULL DEFAULT 'prose'")
        _ensure_column(conn, "document_chunks", "context_text", "TEXT NOT NULL DEFAULT ''")
        _ensure_column(conn, "document_chunks", "keywords", "TEXT NOT NULL DEFAULT '[]'")
        _ensure_column(conn, "documents", "summary", "TEXT NOT NULL DEFAULT ''")
        _normalise_curve_ids(conn)


def _normalise_curve_ids(conn: sqlite3.Connection) -> None:
    rows = conn.execute("SELECT id, curve FROM design_curves").fetchall()
    for old_id, raw in rows:
        new_id = re.sub(r"[^a-zA-Z0-9._-]+", "-", str(old_id)).strip("-").lower()
        if not new_id or new_id == old_id:
            continue
        taken = conn.execute(
            "SELECT 1 FROM design_curves WHERE id = ?", (new_id,)
        ).fetchone()
        if taken:
            new_id = f"{new_id}-legacy"
        conn.execute("UPDATE design_curves SET id = ? WHERE id = ?", (new_id, old_id))
        conn.execute(
            "UPDATE startups SET curve_id = ? WHERE curve_id = ?", (new_id, old_id)
        )
        try:
            payload = json.loads(raw) if isinstance(raw, str) else raw
            payload["curve_id"] = new_id
            conn.execute(
                "UPDATE design_curves SET curve = ? WHERE id = ?",
                (json.dumps(payload), new_id),
            )
        except (TypeError, ValueError):
            pass


def _ensure_column(
    conn: sqlite3.Connection, table: str, column: str, definition: str
) -> None:
    columns = {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}
    if column not in columns:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    conn = sqlite3.connect(settings.database_path, timeout=30)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def query(sql: str, params: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
    with connect() as conn:
        return [dict(row) for row in conn.execute(sql, params).fetchall()]


def query_one(sql: str, params: tuple[Any, ...] = ()) -> dict[str, Any] | None:
    rows = query(sql, params)
    return rows[0] if rows else None


def execute(sql: str, params: tuple[Any, ...] = ()) -> None:
    with connect() as conn:
        conn.execute(sql, params)


def dumps(value: Any, *, compact: bool = False) -> str:
    if compact:
        return json.dumps(value, separators=(",", ":"), sort_keys=False, default=_json_default)
    return json.dumps(value, indent=2, default=_json_default)


def loads(value: str | None, default: Any = None) -> Any:
    if not value:
        return default
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return default


def _json_default(obj: Any) -> Any:
    if hasattr(obj, "model_dump"):
        return obj.model_dump()
    if hasattr(obj, "isoformat"):
        return obj.isoformat()
    raise TypeError(f"Object of type {type(obj)} is not JSON serialisable")
