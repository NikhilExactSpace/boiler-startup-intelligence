"""Document intelligence: ingest boiler documents and answer grounded questions.

This is a compact, SQLite-native adaptation of the Contextual-RAG pipeline:
source-preserving extraction -> overlapping chunks -> lexical retrieval ->
grounded answer -> citations. It stays local so the demo has no Postgres dependency.
"""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import subprocess
import tempfile
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from PIL import Image, ImageFilter, ImageOps

from ..config import settings
from ..db import dumps, execute, loads, query, query_one
from . import gemini
from . import docling_bridge

DOC_TYPES = {"manual", "sop", "curve", "report", "other"}
_QUERY_VECTOR_CACHE: dict[str, list[float]] = {}


def _now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _doc_dir() -> Path:
    folder = settings.database_path.parent / "documents"
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def _extract_text(path: Path, mime: str) -> str:
    if mime.startswith("text/") or path.suffix.lower() in {".txt", ".md", ".csv"}:
        return path.read_text(encoding="utf-8", errors="replace")
    if mime == "application/pdf" or path.suffix.lower() == ".pdf" or mime.startswith("image/"):
        docling = docling_bridge.convert(path)
        if docling and str(docling.get("markdown", "")).strip():
            return str(docling["markdown"])
    if path.suffix.lower() in {".docx", ".doc"}:
        try:
            import docx

            document = docx.Document(str(path))
            parts = [paragraph.text for paragraph in document.paragraphs if paragraph.text.strip()]
            for table in document.tables:
                for row in table.rows:
                    parts.append(" | ".join(cell.text.strip() for cell in row.cells))
            return "\n".join(parts)
        except Exception:
            return ""
    if mime == "application/pdf" or path.suffix.lower() == ".pdf":
        binary = shutil.which("pdftotext")
        if binary:
            completed = subprocess.run(
                [binary, "-layout", str(path), "-"],
                check=False,
                capture_output=True,
                text=True,
                timeout=60,
            )
            if completed.stdout.strip():
                return completed.stdout
        # Scanned PDF: render first pages and OCR.
        render = shutil.which("pdftoppm")
        ocr = shutil.which("tesseract")
        if render and ocr:
            with tempfile.TemporaryDirectory() as folder:
                prefix = Path(folder) / "page"
                subprocess.run(
                    [render, "-png", "-r", "200", "-f", "1", "-l", "10", str(path), str(prefix)],
                    check=False,
                    capture_output=True,
                    timeout=120,
                )
                return "\n".join(_ocr(p) for p in sorted(Path(folder).glob("page*.png")))
        return ""
    if mime.startswith("image/"):
        return _ocr(path)
    return ""


def _ocr(path: Path) -> str:
    binary = shutil.which("tesseract")
    if not binary:
        return ""
    best = ""
    with tempfile.TemporaryDirectory() as folder:
        try:
            image = Image.open(path).convert("L")
            image = ImageOps.autocontrast(image, cutoff=1)
            image = image.filter(ImageFilter.UnsharpMask(radius=1.2, percent=140, threshold=3))
            prepared = Path(folder) / "prepared.png"
            image.save(prepared)
            for psm in ("4", "6", "3"):
                completed = subprocess.run(
                    [binary, str(prepared), "stdout", "--oem", "3", "--psm", psm],
                    check=False,
                    capture_output=True,
                    text=True,
                    timeout=120,
                )
                text = completed.stdout.strip()
                if len(text) > len(best):
                    best = text
        except (OSError, ValueError, subprocess.SubprocessError):
            return best
    return best


def _extract_tables(text: str) -> list[str]:
    lines = text.splitlines()
    tables: list[str] = []
    block: list[str] = []
    for line in lines:
        if line.count("|") >= 2 or "\t" in line:
            block.append(line)
        elif block:
            if len(block) >= 2:
                tables.append("\n".join(block))
            block = []
    if len(block) >= 2:
        tables.append("\n".join(block))
    return tables


def _table_summary(table: str) -> str:
    rows = [line for line in table.splitlines() if line.strip()]
    if len(rows) < 2:
        return table
    headers = [cell.strip() for cell in rows[0].split("|") if cell.strip()]
    parts = []
    for row in rows[1:]:
        cells = [cell.strip() for cell in row.split("|") if cell.strip()]
        if len(cells) == len(headers):
            parts.append(
                f"{headers[0]} {cells[0]}: "
                + ", ".join(f"{header} {value}" for header, value in zip(headers[1:], cells[1:]))
            )
    return "Table: " + " | ".join(parts) if parts else table


def _chunk_document(text: str, title: str) -> list[dict[str, Any]]:
    """Table-aware chunks with type-aware embedding text."""
    pages = [page for page in text.split("\f") if page.strip()] or ([text] if text.strip() else [])
    output: list[dict[str, Any]] = []
    for page_number, page_text in enumerate(pages, start=1):
        tables = _extract_tables(page_text)
        prose = page_text
        for table in tables:
            prose = prose.replace(table, "")
        for chunk in _chunks(prose):
            output.append(
                {
                    "page": page_number,
                    "type": "prose",
                    "text": chunk,
                    "embed_text": (
                        f"A passage from {title} (page {page_number}):\n{chunk}"
                    ),
                }
            )
        for table in tables:
            summary = _table_summary(table)
            output.append(
                {
                    "page": page_number,
                    "type": "table",
                    "text": table,
                    "embed_text": (
                        f"A data table from {title} (page {page_number}):\n{summary}\n{table}"
                    ),
                }
            )
    return output


def _chunks(text: str, size: int = 1800, overlap: int = 250) -> list[str]:
    cleaned = re.sub(r"[ \t]+", " ", text)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned).strip()
    if not cleaned:
        return []
    chunks: list[str] = []
    start = 0
    while start < len(cleaned):
        end = min(len(cleaned), start + size)
        if end < len(cleaned):
            boundary = max(cleaned.rfind("\n", start, end), cleaned.rfind(". ", start, end))
            if boundary > start + size * 0.5:
                end = boundary + 1
        chunks.append(cleaned[start:end].strip())
        if end >= len(cleaned):
            break
        start = max(start + 1, end - overlap)
    return [chunk for chunk in chunks if len(chunk) > 30]


def _document_summary(text: str, title: str) -> str:
    # Local summary only: ingestion must stay fast and deterministic.
    return " ".join(text.split()[:120])


def _contextualize(chunk: dict[str, Any], title: str, window: str) -> tuple[str, list[str]]:
    if chunk["type"] == "table":
        return f"Table from {title}: {_table_summary(chunk['text'])[:300]}", []
    # Local context only. No model call on the ingestion path.
    return f"{title}: {' '.join(chunk['text'].split()[:60])}", []


def _enrich_chunks(chunks: list[dict[str, Any]], title: str) -> list[dict[str, Any]]:
    if not chunks:
        return chunks
    use_ai = bool(settings.gemini_api_key) and len(chunks) <= 40

    def enrich(index: int) -> tuple[int, str, list[str]]:
        chunk = chunks[index]
        if not use_ai:
            return index, f"This chunk discusses: {' '.join(chunk['text'].split()[:20])}", []
        window = "\n\n".join(
            f"[{'PREV' if j < index else 'NEXT'}] {chunks[j]['text'][:300]}"
            for j in range(max(0, index - 2), min(len(chunks), index + 3))
            if j != index
        )
        context, keywords = _contextualize(chunk, title, window)
        return index, context, keywords

    with ThreadPoolExecutor(max_workers=4) as pool:
        for index, context, keywords in pool.map(enrich, range(len(chunks))):
            chunks[index]["context"] = context
            chunks[index]["keywords"] = keywords
    return chunks


def _embed_text(chunk: dict[str, Any], title: str) -> str:
    marker = "A data table (rows/columns):" if chunk["type"] == "table" else "A passage from a document:"
    parts = [marker, f"{title} (page {chunk['page']})"]
    if chunk.get("context"):
        parts.append(chunk["context"])
    if chunk.get("keywords"):
        parts.append("Keywords: " + " ".join(chunk["keywords"]))
    parts.append(chunk["text"])
    return "\n".join(parts)


def create_document(
    *,
    boiler_id: str,
    title: str,
    doc_type: str,
    file_name: str,
    mime: str,
    raw: bytes,
) -> dict[str, Any]:
    """Persist the upload immediately and return before extraction starts."""
    doc_id = f"DOC-{uuid.uuid4().hex[:10]}"
    sha = hashlib.sha256(raw).hexdigest()
    suffix = Path(file_name).suffix.lower() or ".bin"
    target = _doc_dir() / f"{doc_id}{suffix}"
    target.write_bytes(raw)
    execute(
        """INSERT INTO documents
           (id, boiler_id, title, doc_type, source_file, mime_type, sha256, pages,
            summary, status, error, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            doc_id,
            boiler_id,
            title or file_name,
            doc_type if doc_type in DOC_TYPES else "other",
            str(target),
            mime,
            sha,
            0,
            "",
            "indexing",
            "",
            _now(),
        ),
    )
    return {
        "id": doc_id,
        "title": title or file_name,
        "doc_type": doc_type,
        "status": "indexing",
        "error": "",
        "chunks": 0,
        "pages": 0,
        "source_file": str(target),
    }


def process_document(document_id: str) -> None:
    row = query_one("SELECT * FROM documents WHERE id = ?", (document_id,))
    if not row:
        return
    path = Path(row["source_file"])
    try:
        execute("DELETE FROM document_chunks_fts WHERE document_id = ?", (document_id,))
        execute("DELETE FROM document_chunks WHERE document_id = ?", (document_id,))
        text = _extract_text(path, row["mime_type"])
        if not text.strip():
            execute(
                "UPDATE documents SET status = ?, error = ? WHERE id = ?",
                ("failed", "No text could be extracted from this document", document_id),
            )
            return
        chunk_rows = _chunk_document(text, row["title"])
        chunk_rows = _enrich_chunks(chunk_rows, row["title"])
        for index, chunk in enumerate(chunk_rows):
            chunk_id = f"{document_id}-C{index}"
            execute(
                """INSERT INTO document_chunks
                   (id, document_id, boiler_id, page, chunk_index, text, chunk_type,
                    context_text, keywords, embedding, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    chunk_id,
                    document_id,
                    row["boiler_id"],
                    chunk["page"],
                    index,
                    chunk["text"],
                    chunk["type"],
                    chunk.get("context", ""),
                    dumps(chunk.get("keywords", []), compact=True),
                    "[]",
                    _now(),
                ),
            )
            execute(
                "INSERT INTO document_chunks_fts (text, chunk_id, document_id, boiler_id) VALUES (?, ?, ?, ?)",
                (
                    " ".join(
                        [
                            chunk["text"],
                            chunk.get("context", ""),
                            " ".join(chunk.get("keywords", [])),
                        ]
                    ),
                    chunk_id,
                    document_id,
                    row["boiler_id"],
                ),
            )
        pages = max((chunk["page"] for chunk in chunk_rows), default=0)
        execute(
            "UPDATE documents SET status = ?, pages = ?, summary = ?, error = '' WHERE id = ?",
            ("ready", pages, _document_summary(text, row["title"]), document_id),
        )
    except Exception as exc:
        execute(
            "UPDATE documents SET status = ?, error = ? WHERE id = ?",
            ("failed", str(exc), document_id),
        )


def ingest_document(
    *,
    boiler_id: str,
    title: str,
    doc_type: str,
    file_name: str,
    mime: str,
    raw: bytes,
) -> dict[str, Any]:
    created = create_document(
        boiler_id=boiler_id,
        title=title,
        doc_type=doc_type,
        file_name=file_name,
        mime=mime,
        raw=raw,
    )
    process_document(created["id"])
    row = query_one("SELECT * FROM documents WHERE id = ?", (created["id"],))
    return {**(row or created), "chunks": (row or {}).get("pages", 0)}


def list_documents(boiler_id: str) -> list[dict[str, Any]]:
    rows = query(
        """SELECT d.*, (SELECT COUNT(*) FROM document_chunks c WHERE c.document_id = d.id) AS chunks
           FROM documents d WHERE d.boiler_id = ? ORDER BY d.created_at DESC""",
        (boiler_id,),
    )
    return rows


def delete_document(document_id: str) -> bool:
    row = query_one("SELECT * FROM documents WHERE id = ?", (document_id,))
    if not row:
        return False
    chunk_ids = [
        item["id"]
        for item in query("SELECT id FROM document_chunks WHERE document_id = ?", (document_id,))
    ]
    for chunk_id in chunk_ids:
        execute("DELETE FROM document_chunks_fts WHERE chunk_id = ?", (chunk_id,))
    execute("DELETE FROM document_chunks WHERE document_id = ?", (document_id,))
    execute("DELETE FROM documents WHERE id = ?", (document_id,))
    try:
        Path(row["source_file"]).unlink(missing_ok=True)
    except OSError:
        pass
    return True


def _fts_query(text: str) -> str:
    words = [word for word in re.findall(r"[A-Za-z0-9_]+", text) if len(word) > 2][:12]
    return " OR ".join(f"{word}*" for word in words) if words else '""'


def _analyse_query(question: str) -> dict[str, Any]:
    # Local query analysis only for low latency. Retrieval is SQL/FTS based.
    fallback_keywords = [w for w in re.findall(r"[A-Za-z0-9]+", question) if len(w) > 2][:8]
    return {
        "rewritten": question,
        "intent": "numeric" if re.search(r"\d|time|limit|pressure|temperature|flow", question, re.I) else "general",
        "keywords": fallback_keywords,
    }


def _cosine(left: list[float], right: list[float]) -> float:
    if not left or not right or len(left) != len(right):
        return 0.0
    dot = sum(a * b for a, b in zip(left, right))
    left_norm = sum(a * a for a in left) ** 0.5
    right_norm = sum(b * b for b in right) ** 0.5
    if not left_norm or not right_norm:
        return 0.0
    return dot / (left_norm * right_norm)


def retrieve(boiler_id: str, question: str, limit: int = 4) -> list[dict[str, Any]]:
    analysis = _analyse_query(question)
    search_text = analysis["rewritten"] + " " + " ".join(analysis["keywords"])
    match = _fts_query(search_text)
    lexical: list[dict[str, Any]] = []
    try:
        lexical = query(
            """SELECT c.*, d.title, d.doc_type, d.source_file, d.mime_type
               FROM document_chunks_fts
               JOIN document_chunks c ON c.id = document_chunks_fts.chunk_id
               JOIN documents d ON d.id = c.document_id
               WHERE document_chunks_fts.boiler_id = ? AND document_chunks_fts MATCH ?
               ORDER BY rank LIMIT 20""",
            (boiler_id, match),
        )
    except Exception:
        lexical = []

    # SQL/FTS-only retrieval. Semantic embedding calls were adding latency on upload
    # and on every weak query; the FTS path is fast and deterministic.
    semantic: list[dict[str, Any]] = []
    merged: dict[str, float] = {}
    rows_by_id: dict[str, dict[str, Any]] = {}
    for items in (semantic, lexical):
        for index, row in enumerate(items):
            rows_by_id[row["id"]] = row
            merged[row["id"]] = merged.get(row["id"], 0.0) + 1.0 / (60 + index)
    if not merged:
        rows = query(
            """SELECT c.*, d.title, d.doc_type, d.source_file, d.mime_type
               FROM document_chunks c JOIN documents d ON d.id = c.document_id
               WHERE c.boiler_id = ? AND c.text LIKE ?
               ORDER BY c.chunk_index LIMIT ?""",
            (boiler_id, f"%{question[:60]}%", limit),
        )
    else:
        query_terms = {word.lower() for word in re.findall(r"[A-Za-z0-9]+", question) if len(word) > 2}
        query_numbers = set(re.findall(r"\d+(?:\.\d+)?", question))

        def rerank_score(chunk_id: str) -> float:
            row = rows_by_id[chunk_id]
            text = (
                (row.get("text") or "")
                + " "
                + (row.get("context_text") or "")
                + " "
                + (row.get("keywords") or "")
            ).lower()
            overlap = sum(1 for term in query_terms if term in text)
            numeric = sum(1 for number in query_numbers if number in text)
            boost = 0.2 if analysis["intent"] == "numeric" and row.get("chunk_type") == "table" else 0.0
            return merged[chunk_id] + 0.01 * overlap + 0.15 * numeric + boost

        rows = [
            rows_by_id[chunk_id]
            for chunk_id in sorted(merged, key=rerank_score, reverse=True)
        ]

    seen: dict[str, int] = {}
    deduped: list[dict[str, Any]] = []
    for row in rows:
        count = seen.get(row["document_id"], 0)
        if count >= 2:
            continue
        seen[row["document_id"]] = count + 1
        deduped.append(row)
    return deduped[:limit]


def _history(session_id: str, limit: int = 8) -> list[dict[str, str]]:
    rows = query(
        "SELECT role, content FROM chat_messages WHERE session_id = ? ORDER BY created_at DESC LIMIT ?",
        (session_id, limit),
    )
    return list(reversed(rows))


def create_session(boiler_id: str, title: str = "New conversation") -> dict[str, Any]:
    session_id = f"CHAT-{uuid.uuid4().hex[:10]}"
    execute(
        "INSERT INTO chat_sessions (id, boiler_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        (session_id, boiler_id, title, _now(), _now()),
    )
    return {"id": session_id, "boiler_id": boiler_id, "title": title}


def list_sessions(boiler_id: str) -> list[dict[str, Any]]:
    return query(
        "SELECT * FROM chat_sessions WHERE boiler_id = ? ORDER BY updated_at DESC",
        (boiler_id,),
    )


def messages(session_id: str) -> list[dict[str, Any]]:
    rows = query(
        "SELECT * FROM chat_messages WHERE session_id = ? ORDER BY created_at",
        (session_id,),
    )
    for row in rows:
        row["citations"] = loads(row.get("citations"), [])
    return rows


def add_message(session_id: str, role: str, content: str, citations: list | None = None) -> None:
    execute(
        "INSERT INTO chat_messages (id, session_id, role, content, citations, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        (f"MSG-{uuid.uuid4().hex[:10]}", session_id, role, content, dumps(citations or [], compact=True), _now()),
    )
    execute("UPDATE chat_sessions SET updated_at = ? WHERE id = ?", (_now(), session_id))


def prepare_answer(boiler_id: str, session_id: str, question: str) -> dict[str, Any]:
    chunks = retrieve(boiler_id, question)
    context = "\n\n".join(
        f"[{index + 1}] {row['title']} (page {row['page']})\n{row['text']}"
        for index, row in enumerate(chunks)
    )
    history = _history(session_id)
    prior = "\n".join(f"{item['role']}: {item['content']}" for item in history[-6:])
    if not chunks:
        return {
            "prompt": None,
            "content": (
                "I could not find this in the indexed documents for this boiler. "
                "Upload or index the relevant manual, SOP or report first."
            ),
            "citations": [],
        }
    prompt = f"""You are BoilerIQ, a boiler document assistant. Answer ONLY from the retrieved documents.
Be direct and specific. Quote exact values/times/limits. Cite each factual sentence with [n].
Prefer one or two sources. If the answer is absent, say so. Never invent limits or safety
decisions. Keep the answer under 200 words.

BOILER: {boiler_id}
RECENT CONVERSATION:
{prior or "(none)"}

RETRIEVED DOCUMENTS:
{context}

QUESTION: {question}"""
    citations = [
        {
            "n": index + 1,
            "document_id": row["document_id"],
            "title": row["title"],
            "page": row["page"],
            "snippet": row["text"][:240],
        }
        for index, row in enumerate(chunks)
    ]
    return {"prompt": prompt, "content": "", "citations": citations}


def finalize_answer(session_id: str, content: str, citations: list[dict[str, Any]]) -> list[dict[str, Any]]:
    used = {int(value) for value in re.findall(r"\[(\d+)\]", content)}
    if used:
        citations = [citation for citation in citations if citation["n"] in used]
    else:
        citations = citations[:2]
    add_message(session_id, "assistant", content, citations)
    return citations


def answer(boiler_id: str, session_id: str, question: str) -> dict[str, Any]:
    chunks = retrieve(boiler_id, question)
    context = "\n\n".join(
        f"[{index + 1}] {row['title']} (page {row['page']})\n{row['text']}"
        for index, row in enumerate(chunks)
    )
    history = _history(session_id)
    prior = "\n".join(f"{item['role']}: {item['content']}" for item in history[-6:])
    if not chunks:
        content = (
            "I could not find this in the indexed documents for this boiler. "
            "Upload or index the relevant manual, SOP or report first."
        )
        add_message(session_id, "assistant", content, [])
        return {"content": content, "citations": []}

    prompt = f"""You are DocIQ, a boiler document assistant. Answer the question using ONLY the retrieved
documents. Be direct and specific. Quote the exact value/time/limit when present.
- Prefer one or two sources. Do not list unrelated documents.
- Cite each factual sentence with [n].
- If the documents do not contain the answer, say so clearly.
- Do not invent limits or make safety decisions. Advisory only.
- Keep the answer under 250 words unless the user asks for detail.

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
        content = f"Document assistant is unavailable: {exc}"
    citations = [
        {
            "n": index + 1,
            "document_id": row["document_id"],
            "title": row["title"],
            "page": row["page"],
            "snippet": row["text"][:240],
        }
        for index, row in enumerate(chunks)
    ]
    used = {int(value) for value in re.findall(r"\[(\d+)\]", content)}
    if used:
        citations = [citation for citation in citations if citation["n"] in used]
    else:
        citations = citations[:2]
    add_message(session_id, "assistant", content, citations)
    return {"content": content, "citations": citations}
