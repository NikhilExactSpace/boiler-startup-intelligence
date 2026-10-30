# Boiler Startup Intelligence + BoilerIQ

Compare what a boiler startup **did** with what the approved procedure says it **should
have done**, then explain the difference without letting an LLM invent limits or make a
safety call.

```
DCS / Kairos historian  →  what happened
Approved design curve   →  what should have happened
Deterministic analytics →  where and when they diverged
Gemini (optional)       →  explanations and document-grounded answers only
```

> **Advisory only.** The platform quantifies deviations from the approved curve and
> answers questions from indexed documents. It does not determine whether a boiler is safe
> to operate, does not write to the DCS, and does not replace the shift engineer.

---

## What is in the box

| Area | What it does |
| --- | --- |
| **Live startup** | Accelerated replay over SSE with actual-vs-design charts, signal switching, event/mill markers, recommendations, raw data drawer and AI insights. |
| **Startup history** | Every run pinned to the curve version active at its start, with type filters, scores, lag, deviations and evidence. |
| **Startup detail** | Dense dashboard: KPIs, score, curve vs actual, recommendations, curve events, detailed evidence tabs and raw JSON. |
| **Design curves** | Boiler onboarding, SOP/document extraction, curve drawing vision digitization, cold/warm/hot curves, parameter tags, alarm values and approval workflow. |
| **BoilerIQ** | Document intelligence: upload manuals/SOPs/reports, index them per boiler, ask contextual questions with streamed answers and source citations. |
| **AI insights** | Gemini explains deterministic evidence; every number is grounded, every citation resolves, and safety verdict language is rejected. |
| **Compare** | Peer comparison of stored runs against a selected startup. |

The UI is a light, dense dashboard with a compact sidebar and a top bar containing the
current page, compact status indicators and a **BoilerIQ** shortcut.

---

## BoilerIQ

BoilerIQ is a per-boiler document assistant.

- upload PDF, text, markdown, CSV, Word or image files
- original files stored under `backend/data/documents`
- page-aware, table-aware chunking
- SQLite FTS5 keyword retrieval with local reranking
- contextual chat with recent-turn memory
- streamed SSE answers
- citations that open the indexed source document
- delete documents, start a new chat

See [docs/boileriq.md](docs/boileriq.md) for the full pipeline.

---

## Startup types

Startups are classified from the time since the previous recorded shutdown:

| Type | Default rule |
| --- | --- |
| **Hot** | within 4 hours |
| **Warm** | up to 96 hours |
| **Cold** | beyond 96 hours |

Thresholds, total durations and enabled types are configurable per boiler. Each type has
its own curve, expected trajectory, duration and timing. Live supports `Auto`, `Cold`,
`Warm` and `Hot` selection.

Demo values for B-101:

- cold: 107 min
- warm: 80 min
- hot: 55 min

---

## Quick start

Requirements: Python 3.10+, Node 18+, and optional Gemini API key for AI features.
Poppler (`pdftotext`, `pdftoppm`) and Tesseract are used for local PDF/OCR fallback.

```bash
cd boiler-startup-intelligence

# Backend
python3 -m venv .venv
.venv/bin/pip install -r backend/requirements.txt
cp .env.example .env
cd backend
../.venv/bin/uvicorn app.main:app --port 8000
```

```bash
# Frontend (second terminal)
cd boiler-startup-intelligence/frontend
npm install
npm run dev
```

Open `http://127.0.0.1:5173`.

The database is created and seeded automatically on first start at
`backend/data/bsi.db`. The seed creates boiler **B-101**, cold/warm/hot curves and demo
startups. `POST /api/demo/reset` wipes and re-seeds.

---

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `KAIROS_MODE` | `mock` | `mock`, `replay` or `live` historian mode. |
| `DC_QUERY_URL` | empty | KairosDB query endpoint. |
| `KAIROS_USERNAME` / `KAIROS_PASSWORD` | empty | Read-only historian credentials. |
| `GEMINI_API_KEY` | empty | Enables AI extraction, insights, OCR and BoilerIQ. |
| `GEMINI_MODEL` | `gemini-2.5-flash` | Insight/chat model. |
| `GEMINI_EXTRACTION_MODEL` | same as `GEMINI_MODEL` | PDF/image and curve drawing vision model. |
| `INSIGHT_PROVIDER` | `gemini` if key set | `gemini` or `deterministic`. |
| `EXTRACTION_PROVIDER` | `gemini` if key set | `gemini` or `deterministic`. |
| `DEMO_BOILER_ID` | `B-101` | Demo boiler. |
| `DATABASE_PATH` | `backend/data/bsi.db` | SQLite database for boiler curves, startups and insights. |
| `RAG_DATABASE_URL` | `postgresql://localhost:5432/boileriq` | BoilerIQ Postgres + pgvector store. |
| `LIVE_TIME_SCALE` | `120` | Replay speed. |

**No key?** Text extraction, analytics, curves, history, live replay and BoilerIQ
keyword retrieval still work. AI/vision features return a clear configuration error.

---

## Databases

BoilerIQ uses a separate Postgres store for document RAG:

```bash
createdb boileriq
psql -d boileriq -c "create extension if not exists vector;"
psql -d boileriq -c "create extension if not exists pg_trgm;"
```

Boiler startup data continues to use SQLite at `backend/data/bsi.db`.

## Demo in 60 seconds

1. Open **Live startup**. The replay is already running against the active curve.
2. Switch signal, drag/scroll to zoom, click a recommendation to focus the chart.
3. When complete, open the stored run from **Startup history**.
4. Review KPI strip, score, recommendation cards, curve events and detailed evidence.
5. Open **Design curves** and upload a curve drawing or SOP; review parameters, assign
   tags, choose cold/warm/hot and approve.
6. Open **BoilerIQ**, upload a manual or SOP, ask a question and click a citation to open
   the source document.

Seeded B-101 scores:

| Startup | What it shows | Score |
| --- | --- | --- |
| `S-1039` clean reference | on-curve run | **96.8** nominal |
| `S-1040` slow second ramp | small ramp deviation | **89.3** nominal |
| `S-1041` NOx / SH temp | watch-limit excursions | **77.5** watch |
| `S-1042` long purge, slow 10–30 ramp | 120 min vs 107 min design | **67.8** watch |
| `S-1043` fuel-gas pressure loss | abort-level observation | **45.0** attention |

---

## Design curve workflow

1. **Add boiler** — ID, name, cold/warm/hot durations and classification thresholds.
2. **Upload procedure or drawing**
   - SOP text/PDF → deterministic or Gemini extraction
   - curve drawing image/PDF → Gemini 2.5 Pro vision digitization with pixel-level axis
     calibration, breakpoints, events, mill cut-in and live highlights
3. **Review parameters** — extracted signals, units and source references.
4. **Assign historian tags** — required parameters must have a tag.
5. **Choose startup type** — cold, warm or hot.
6. **Approve** — creates a versioned curve. Existing startups keep their pinned version.

Boiler settings allow:

- update name and type durations
- update hot/warm thresholds
- add parameters with tag, unit and alarm low/high
- delete parameter or boiler

---

## AI guardrails

- **Extraction is transcription, not design.** Facts must carry a verbatim source quote.
- **Vision is a draft.** Axis calibration, review flags and human approval are required.
- **Insights only explain evidence.** Numbers must exist in the bundle; evidence IDs must
  resolve; safety verdicts are rejected.
- **BoilerIQ answers only from retrieved documents.** It must say when the answer is not
  present and cite sources.
- **Read-only historian.** No DCS write-back.
- **Tolerances are not limits.** `analytics_default` bands drive reporting only.

---

## API overview

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Health and configured providers. |
| `GET/POST` | `/api/boilers` | List/create boilers. |
| `PUT/DELETE` | `/api/boilers/{id}` | Update/delete boiler. |
| `PUT/DELETE` | `/api/boilers/{id}/parameters/{key}` | Parameter tag and alarm values. |
| `GET/POST` | `/api/design-curves`, `/api/design-curves/approve` | Curves and approval. |
| `POST` | `/api/design-curves/extract` | SOP/document extraction. |
| `POST` | `/api/design-curves/extract-curve` | Vision curve digitization. |
| `GET` | `/api/design-curves/{id}/source` | Original uploaded source. |
| `GET` | `/api/startups` | Startup history. |
| `GET` | `/api/startups/{id}` | Full startup comparison and evidence. |
| `GET` | `/api/live/{boiler}` | Live snapshot. |
| `GET` | `/api/live/{boiler}/stream` | Live SSE stream. |
| `POST` | `/api/live/{boiler}/simulate` | Restart replay. |
| `GET/POST` | `/api/documents` | List/upload BoilerIQ documents. |
| `DELETE` | `/api/documents/{id}` | Delete document and index. |
| `GET` | `/api/documents/{id}/source` | Original document. |
| `GET/POST` | `/api/chat/sessions` | Chat sessions. |
| `POST` | `/api/chat/stream` | Streamed BoilerIQ answer. |

Full request/response examples: [docs/api.md](docs/api.md).

---

## Tests and build

```bash
cd backend && ../.venv/bin/python -m pytest -q
cd frontend && npm run build
./scripts/smoke.sh
```

The test suite forces deterministic providers and removes `GEMINI_API_KEY`, so it never
calls the network.

---

## Repository layout

```text
backend/
  app/
    api/            health, boilers, curves, startups, insights, live, demo, documents
    services/
      analytics.py  deviations, tracking, phases, rates, scoring, chart payloads
      curve_vision.py  vision digitization of start-up curve drawings
      docintel.py   BoilerIQ ingestion, chunking, SQLite FTS retrieval, chat
      extraction.py SOP/PDF/image extraction
      gemini.py     Gemini generate + embeddings client
      insights.py   grounded insight generation and validation
      kairos.py     read-only historian adapter
      live.py       accelerated replay, classification, detection, SSE snapshots
      mockgen.py    deterministic demo startup generator
      store.py      SQLite repositories
      docintel_pg.py Postgres + pgvector BoilerIQ storage/retrieval
    seed/           SOP curve, SOP text, sample PDF/scan
    schemas.py      strict design-curve schema
    db.py           SQLite schema, migrations and helpers
  data/
    bsi.db          SQLite database
    documents/      BoilerIQ source files
    uploads/        curve source files
  tests/            deterministic API, analytics, extraction, insight tests
frontend/
  src/pages/        Live, History, StartupDetail, Compare, Curves, DocIQ
  src/components/   Layout, SignalChart, InsightCard, RawDataDrawer, shared UI
  src/lib/          API client, types, theme, live SSE hook
docs/
  architecture.md
  api.md
  boileriq.md
  curve-schema.md
  demo-script.md
scripts/
  smoke.sh
```

---

## Documentation

- [Architecture](docs/architecture.md)
- [API](docs/api.md)
- [Curve schema](docs/curve-schema.md)
- [BoilerIQ pipeline](docs/boileriq.md)
- [Demo script](docs/demo-script.md)
