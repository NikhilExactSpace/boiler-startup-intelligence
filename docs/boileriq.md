# BoilerIQ — Document Intelligence

BoilerIQ answers questions about a specific boiler using only the documents indexed for
that boiler. It is an advisory assistant: it explains and cites; it does not make safety
decisions.

---

## 1. Product surface

Top bar:

```text
[ ✦ ] BoilerIQ
```

Page layout:

- **Left** — boiler document library, indexed status and document types
- **Centre** — contextual chat with streamed answers and citations
- **Right** — document viewer drawer opened from the library or a citation
- **Header** — New chat, Upload document, document/chunk counts

Upload is a modal:

- document name is optional (falls back to the file name)
- document type: manual, SOP, curve, report, other
- selecting a file starts upload and indexing

---

## 2. Ingestion pipeline

```text
Upload
  → save original under backend/data/documents
  → extract text
      PDF text layer via pdftotext
      scanned PDF pages via pdftoppm + Tesseract
      images via Tesseract
      Word via python-docx
      text/markdown/CSV directly
  → split pages
  → table-aware chunking
  → type-aware chunk text
  → SQLite chunks + FTS5
```

### Chunking

- prose chunks: about 1,800 characters with overlap
- tables: kept atomic
- table summary generated for retrieval
- prose and table chunks receive different type markers

### Indexing

- SQLite FTS5 keyword index
- chunk type stored for retrieval boost
- no external vector database required

---

## 3. Retrieval

```text
Question
  → local query analysis
  → SQLite FTS5 keyword search
  → lexical/numeric rerank
  → max 4 chunks, max 2 per document
```

Retrieval is SQL-only for low latency and deterministic local operation.

---

## 4. Contextual answer

The answer prompt includes:

- active boiler
- recent conversation turns
- retrieved chunks with document title and page
- instruction to answer only from the retrieved documents
- one citation per factual sentence
- no-answer fallback
- advisory-only guardrail
- concise answer length

The assistant returns citations only for sources actually referenced in the answer.

---

## 5. Streaming

```text
POST /api/chat/stream
```

SSE events:

```text
event: meta       → session id + citation list
event: token      → answer token chunk
event: citations  → final citation list
event: done       → completion
```

The UI appends tokens live and shows a caret while streaming.

---

## 6. Database

BoilerIQ uses **Postgres + pgvector**; the rest of the startup app uses SQLite.

```text
rag_documents
  id, boiler_id, title, doc_type, source_file, mime_type, sha256,
  pages, summary, status, error, created_at

rag_chunks
  id, document_id, boiler_id, page, chunk_index, text,
  chunk_type, context_text, keywords JSONB,
  embedding halfvec(3072),
  search tsvector generated,
  created_at

indexes
  HNSW on embedding halfvec_cosine_ops
  GIN on search tsvector
  boiler_id btree

rag_sessions
  id, boiler_id, title, created_at, updated_at

rag_messages
  id, session_id, role, content, citations JSONB, created_at
```

Setup:

```bash
createdb boileriq
psql -d boileriq -c "create extension if not exists vector;"
psql -d boileriq -c "create extension if not exists pg_trgm;"
```

Connection:

```env
RAG_DATABASE_URL=postgresql://localhost:5432/boileriq
```

Retrieval uses:

- pgvector cosine distance (`<=>`) with HNSW
- Postgres `tsvector` / `websearch_to_tsquery`
- reciprocal-rank fusion in Python
- intent-aware table boost and numeric rerank


---

## 7. API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/documents?boiler_id=…` | List indexed documents. |
| `POST` | `/api/documents` | Upload and index a document. |
| `GET` | `/api/documents/{id}/source` | Original source file. |
| `DELETE` | `/api/documents/{id}` | Remove document, chunks, FTS rows and file. |
| `GET` | `/api/chat/sessions?boiler_id=…` | List sessions. |
| `POST` | `/api/chat/sessions` | Create a session. |
| `GET` | `/api/chat/sessions/{id}/messages` | Session messages. |
| `POST` | `/api/chat/stream` | Streamed contextual answer. |

---

## 8. UI states

| State | Behaviour |
| --- | --- |
| No documents | Empty library, suggested questions |
| Indexed documents | Left library with type badges, pages and chunks |
| Streaming | Live tokens + caret, composer disabled |
| Citation click | Opens the source document in the right drawer |
| Upload | Modal shows indexing state and errors |
| New chat | Clears session and messages without deleting documents |
| Delete document | Confirmation, removes source and index |

---

## 9. Guardrails

- Answers are limited to indexed documents for the active boiler.
- Missing evidence returns an explicit “not found” response.
- Citations are required for factual claims.
- No invented limits, no safety verdicts.
- Document ingestion is read-only with respect to the plant.
