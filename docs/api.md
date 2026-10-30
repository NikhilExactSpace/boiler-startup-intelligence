# API reference

Base URL: `http://localhost:8000/api` (the Vite dev server proxies `/api` to it).

Interactive docs are served at `http://localhost:8000/docs`.

## Conventions

* **Read-only historian.** No endpoint writes to the DCS or KairosDB. The only writes are
  to the local SQLite demo database (boilers, curves, startups, cached insights).
* **JSON in, JSON out**, except the two multipart extraction endpoints and the SSE stream.
* **Timestamps** are ISO-8601 with an offset, e.g. `2026-10-25T17:11:46+00:00`.
* **Times inside a curve or analysis** are minutes from detected startup (`t = 0`).
* **Errors** use FastAPI's shape:

  ```json
  { "detail": "Startup not found" }
  ```

  Common codes: `400` bad request, `404` not found, `409` conflict (duplicate id, no
  approved curve), `413` file too large (> 5 MB), `422` validation/extraction failure.

The demo boiler id is `B-101`; most GETs default to it when `boiler_id` is omitted.

---

## Health

### `GET /health`

Runtime configuration, useful for the UI banner and for smoke tests.

```bash
curl -s localhost:8000/api/health | jq
```

```json
{
  "status": "ok",
  "version": "0.1.0",
  "kairos_mode": "mock",
  "kairos_configured": false,
  "llm_configured": true,
  "insight_provider": "gemini",
  "gemini_model": "gemini-2.5-flash",
  "ai_extraction_configured": true,
  "extraction_provider": "gemini",
  "gemini_extraction_model": "gemini-2.5-flash",
  "prompt_version": "bsi-insight-v1",
  "demo_boiler_id": "B-101",
  "live_time_scale": 120.0,
  "boilers": 1,
  "principle": "Historians say what happened, the approved curve says what should have happened, analytics quantify the difference, the LLM only explains the evidence."
}
```

`llm_configured` and `ai_extraction_configured` are `false` when no `GEMINI_API_KEY` is
loaded. The UI uses them to explain which fallback is active.

---

## Boilers

### `GET /boilers`

```bash
curl -s localhost:8000/api/boilers | jq
```

```json
[
  {
    "id": "B-101",
    "name": "Boiler B-101",
    "site": "Demo plant",
    "tag_prefix": "B101",
    "kairos_mode": "mock",
    "tag_map": { "drum_pressure": "B101.DRUM_PRESS" },
    "created_at": "2026-10-26T18:41:44+00:00",
    "curve": {
      "id": "b101-sop202-r3",
      "name": "Cold start to 50 barg - SOP-202 Rev 3.0",
      "version": 1,
      "document": "SOP-202",
      "revision": "3.0",
      "design_duration_min": 107.0,
      "signals": 11,
      "phases": 7,
      "approved_by": "shift.engineer",
      "approved_at": "2026-10-24T09:15:00+05:30"
    },
    "startups": 5
  }
]
```

`curve` is `null` until a design curve is approved.

### `POST /boilers`

Registers a boiler. `id` accepts letters, digits, `-` and `_`, 2–24 chars.

```bash
curl -s -X POST localhost:8000/api/boilers \
  -H 'content-type: application/json' \
  -d '{"id":"B-102","name":"Boiler B-102","site":"Demo plant","tag_prefix":"B102"}'
```

```json
{ "ok": true, "id": "B-102", "next": "Approve a design curve for this boiler." }
```

Returns `409` if the id already exists.

---

## Design curves

A curve is stored as versioned JSON. `GET /design-curves/{id}` returns a summary plus the
full `curve` object; `GET /design-curves/{id}/json` returns just the versioned JSON and
its SHA-256.

### `GET /design-curves?boiler_id=B-101`

```bash
curl -s "localhost:8000/api/design-curves?boiler_id=B-101" | jq
```

```json
[
  {
    "id": "b101-sop202-r3",
    "boiler_id": "B-101",
    "name": "Cold start to 50 barg - SOP-202 Rev 3.0",
    "version": 1,
    "status": "approved",
    "document": "SOP-202",
    "revision": "3.0",
    "sha256": "635b4a0c8ced607360a4ae30ae7b82af9180e1d7f62c87945b2ae6a8785e11d6",
    "approved_by": "shift.engineer",
    "approved_at": "2026-10-24T09:15:00+05:30",
    "created_at": "2026-10-26T18:41:44+00:00",
    "design_duration_min": 107.0,
    "phases": 7,
    "signals": 11,
    "limits": 7,
    "analytics_tolerances": 12
  }
]
```

### `GET /design-curves/{curve_id}`

Same summary plus `"curve": { ...design-curve/v1... }`. See
[curve-schema.md](curve-schema.md) for the object itself.

### `GET /design-curves/{curve_id}/json`

```json
{ "id": "b101-sop202-r3", "sha256": "635b…11d6", "curve": { "schema_version": "1.0" } }
```

### `POST /design-curves/extract` (multipart)

Upload a procedure. PDF and image files go to Gemini when configured; text files stay on
the deterministic parser.

```bash
curl -s -X POST localhost:8000/api/design-curves/extract \
  -F 'boiler_id=B-101' \
  -F 'file=@backend/app/seed/examples/SOP-202_B-101_Rev3.pdf'
```

Sample documents live in `backend/app/seed/examples/`:
`SOP-202_B-101_Rev3.pdf` and a scanned `SOP-202_B-101_Rev3_scan.png`.

| Field | Type | Notes |
| --- | --- | --- |
| `file` | file | PDF, PNG/JPG/WebP, or plain text. Max 5 MB. |
| `boiler_id` | string | Defaults to `B-101`. The latest approved curve is used as the template. |

Response (trimmed):

```json
{
  "draft": { "schema_version": "1.0", "status": "draft", "curve_id": "b101-sop202-r30" },
  "extracted": [
    {
      "field": "source.document",
      "value": "SOP-202",
      "source_line": "Boiler Startup Procedure SOP-202 Equipment: Boiler B-101 | Document: SOP-202 | Rev: 3.0",
      "confidence": 1.0
    }
  ],
  "warnings": [
    "AI did not transcribe a printed section for 6 limit(s); the template's source references were kept. Verify them against the document.",
    "2 prerequisite(s) are operator-verified (permit/interlock) and have no numeric condition; they were not changed."
  ],
  "unknowns": [],
  "document": {
    "document": "SOP-202",
    "revision": "3.0",
    "sha256": "0065…e8ca",
    "text_sha256": "61bd…87b1",
    "characters": 1953,
    "equipment": "Boiler B-101",
    "engine": "ai-gemini",
    "file_name": "sop202.pdf"
  },
  "ai": {
    "engine": "gemini",
    "model": "gemini-2.5-flash",
    "fact_counts": { "proposed": 21, "applied": 19, "rejected": 0 },
    "validation": "grounded",
    "file_name": "sop202.pdf",
    "mime_type": "application/pdf",
    "attempts": 1,
    "latency_s": 11.54,
    "usage": { "promptTokenCount": 1420, "candidatesTokenCount": 1167, "thoughtsTokenCount": 898, "totalTokenCount": 3485 },
    "notes": []
  },
  "boiler_id": "B-101"
}
```

Notes:

* `document.engine` is `ai-gemini` for PDF/image AI transcription, `deterministic` for the
  local parser.
* `ai` is present only for AI transcription. `fact_counts.applied` is the number of facts
  accepted after the verbatim-quote check.
* `unknowns` lists fields the document did not contain; the template value was kept.
* Scanned PDFs have no text layer and are sent straight to Gemini. A text PDF is parsed
  locally **and** sent to Gemini when a key exists.
* Image upload without a key returns `422` with a clear message.
* All drafts remain `status: "draft"`. Nothing is stored by this endpoint.

### `POST /design-curves/extract-text`

JSON variant for pasted text. Deterministic only.

```bash
curl -s -X POST localhost:8000/api/design-curves/extract-text \
  -H 'content-type: application/json' \
  -d "$(curl -s localhost:8000/api/demo/sop-text | jq -c '{boiler_id:"B-101", text:.text}')"
```

`text` must be at least 20 characters. Response shape matches the multipart endpoint but
has no `ai` block and `document.engine` is `deterministic`.

### `POST /design-curves/approve`

Validates the draft with the production schema, stamps approver/time, marks it approved,
and inserts a **new version**.

```bash
curl -s -X POST localhost:8000/api/design-curves/approve \
  -H 'content-type: application/json' \
  -d '{"boiler_id":"B-101","approved_by":"shift.engineer","draft":{ ... }}'
```

```json
{
  "ok": true,
  "curve": { "id": "b101-sop202-r3", "version": 1, "status": "approved" },
  "message": "Curve approved and stored as versioned JSON. Existing startups keep the curve version they were recorded against."
}
```

`201 Created`. Errors: `400` if the draft belongs to another boiler or `approved_by` is
blank; `422` if the draft fails schema validation. The server decides the version number
(`MAX(version) + 1`) and renames the id to `<curve_id>-v<n>` for versions above 1.

---

## Startups

### `GET /startups?boiler_id=B-101&status=&limit=50`

`status` is optional (`complete`, `aborted`). `limit` is 1–200.

```json
[
  {
    "id": "S-1042",
    "boiler_id": "B-101",
    "curve_id": "b101-sop202-r3",
    "label": "S-1042 - long purge, slow 10-30 ramp",
    "detected_start": "2026-10-25T17:11:46+00:00",
    "detected_end": "2026-10-25T19:11:45.160000+00:00",
    "status": "complete",
    "source": "mock",
    "duration_min": 119.99,
    "design_duration_min": 107.0,
    "score": 68.1,
    "score_status": "watch",
    "lag_minutes": 7.5,
    "violations": 2,
    "abort_observations": 0,
    "top_deviation": "Drum level reached 37.3 % at t=26.8 min, outside the required 40.0-70.0 % (SOP-202 §4).",
    "live": false
  }
]
```

`duration_min` comes from the recorded run; `design_duration_min` is a property of the
pinned curve. `score` is a performance indicator, not a safety score.

### `GET /startups/{startup_id}`

Everything the detail page needs: summary, pinned curve, chart payload, full analysis and
any cached insight whose evidence hash is still current.

```json
{
  "startup": { "id": "S-1042", "status": "complete", "meta": { "...": "..." } },
  "curve": { "id": "b101-sop202-r3", "version": 1, "design_duration_min": 107.0 },
  "chart": { "start_min": -15.0, "end_min": 119.99, "step_min": 0.5, "signals": {} },
  "analysis": {
    "duration": { "design_min": 107.0, "actual_min": 119.99, "delta_min": 12.99 },
    "score": {
      "value": 68.1,
      "status": "watch",
      "components": { "tracking": 54.9, "bands": 70.0, "timing": 77.5, "stability": 96.8 },
      "weights": { "tracking": 0.4, "bands": 0.3, "timing": 0.2, "stability": 0.1 }
    },
    "lag": { "minutes": 7.5, "rmse_at_best": 1.99, "interpretation": "behind the design curve" },
    "violations": [
      {
        "id": "V2",
        "signal": "drum_level",
        "severity": "watch",
        "op": "between",
        "threshold": { "min": 40.0, "max": 70.0 },
        "from_min": 25.75,
        "to_min": 28.25,
        "worst": 37.3,
        "worst_at": 26.75,
        "source_ref": "SOP-202 §4",
        "statement": "Drum level reached 37.3 % at t=26.8 min, outside the required 40.0-70.0 % (SOP-202 §4)."
      }
    ],
    "milestones": [
      {
        "id": "M3",
        "label": "50 barg reached",
        "design_at_min": 72.7,
        "actual_at_min": 85.5,
        "delta_min": 12.8,
        "status": "late",
        "source_ref": "SOP-202 §3 Step 7"
      }
    ],
    "evidence_ids": ["PH1", "V1", "V2", "M1", "M2", "M3", "L1", "Q1"],
    "evidence_hash": "ad0e…5036"
  },
  "insight": null,
  "insight_available": false,
  "llm_configured": true
}
```

### `GET /startups/{startup_id}/analysis`

The `analysis` object above, plus `evidence_hash`. Use it when you do not need the chart.

### `GET /startups/{startup_id}/chart?step_min=0.5`

Chart-ready arrays on a shared grid.

```json
{
  "start_min": -15.0,
  "end_min": 119.99,
  "step_min": 0.5,
  "grid": [-15.0, -14.5, "..."],
  "phases": [{ "key": "purge", "label": "Furnace purge", "start_min": 0.0, "end_min": 5.0 }],
  "signals": {
    "drum_pressure": {
      "key": "drum_pressure",
      "label": "Drum pressure",
      "unit": "barg",
      "kind": "analog",
      "decimals": 2,
      "chart_order": 1,
      "actual": [0.23, 0.2, "..."],
      "expected": [0.0, 0.0, "..."],
      "lo": [-0.5, -0.5, "..."],
      "hi": [0.5, 0.5, "..."],
      "zones": [],
      "lines": []
    }
  },
  "violations": [],
  "milestones": []
}
```

`actual`, `expected`, `lo` and `hi` are aligned to `grid`. `lo`/`hi` are the reporting
tolerance band (`analytics_default`), not safety limits. `lines` carries SOP limits and
`zones` carries state/phase decorations.

`step_min` is 0.2–2.0 minutes.

### `GET /startups/{startup_id}/compare?signals=drum_pressure,nox`

One startup against the approved design and the P25–P75 peer envelope of earlier runs.
`signals` is an optional comma-separated subset. Each run's `signals` map holds aligned
**actual** values only; the design series is in `GET /startups/{id}/chart` (`expected`,
`lo`, `hi`) and the envelope arrays are aligned to `grid`.

```json
{
  "start_min": -15.0,
  "end_min": 119.99,
  "step_min": 0.5,
  "grid": [-15.0, "..."],
  "envelope": {
    "drum_pressure": { "median": [0.21, "..."], "p25": [0.18, "..."], "p75": [0.24, "..."], "count": 9 }
  },
  "runs": [
    {
      "id": "S-1042",
      "label": "S-1042 - long purge, slow 10-30 ramp",
      "status": "complete",
      "score": 68.1,
      "duration_min": 119.99,
      "signals": { "drum_pressure": [0.23, 0.2, "..."] }
    }
  ],
  "target_id": "S-1042",
  "peer_count": 9,
  "table": [{ "id": "S-1042", "score": 68.1, "top_deviation": "..." }]
}
```

---

## Insights

The insight layer receives the deterministic analysis only. It cannot add limits or make a
safety determination. Responses are cached against the evidence hash.

### `GET /startups/{startup_id}/insight`

```bash
curl -s localhost:8000/api/startups/S-1042/insight | jq
```

```json
{
  "available": true,
  "stale": false,
  "record": {
    "insight": {
      "summary": "Boiler startup S-1042 was completed in 119.99 minutes, which is 12.99 minutes longer than the design duration of 107.0 minutes (PH7, M3)…",
      "timeline": [
        {
          "t_min": 10.5,
          "event": "NOx emissions reached 60 ppm, exceeding the 50.0 ppm limit (SOP-202 §4).",
          "evidence_ids": ["V1"]
        }
      ],
      "deviations": [
        {
          "signal": "NOx emissions",
          "what": "NOx emissions reached 60 ppm at t=10.5 min, exceeding the 50.0 ppm limit (SOP-202 §4). This lasted for 1.25 minutes.",
          "when_min": 10.5,
          "severity": "watch",
          "source_ref": "SOP-202 §4",
          "evidence_ids": ["V1"]
        }
      ],
      "contributing_factors": [],
      "data_gaps": [],
      "recommended_checks": [],
      "disclaimer": "Advisory only. This explanation is generated from the evidence above and does not determine whether the boiler is safe to operate…"
    },
    "meta": {
      "provider": "gemini",
      "model": "gemini-2.5-flash",
      "prompt_version": "bsi-insight-v1",
      "evidence_hash": "ad0e…5036",
      "generated_at": "2026-10-27T02:39:22+00:00",
      "latency_s": 14.69,
      "validation": { "status": "validated", "notes": [] },
      "authoritative": false,
      "disclaimer": "Advisory only…"
    }
  },
  "evidence_hash": "ad0e…5036",
  "llm_configured": true,
  "provider": "gemini",
  "model": "gemini-2.5-flash",
  "prompt_version": "bsi-insight-v1"
}
```

* `available: false` means nothing is cached yet; use `POST` or the UI button.
* `stale: true` means a cache exists for older evidence and will be regenerated.
* `meta.provider` is `gemini`, `gemini-fallback`, or `deterministic`.
* `meta.validation.status` is `validated` or `fallback`.

### `POST /startups/{startup_id}/insight?force=true`

Generates (or regenerates when `force=true`) the explanation.

```bash
curl -s -X POST 'localhost:8000/api/startups/S-1042/insight?force=true' | jq
```

```json
{
  "available": true,
  "record": { "insight": { "...": "..." }, "meta": { "provider": "gemini", "validation": { "status": "validated" } } },
  "evidence_hash": "ad0e…5036",
  "llm_configured": true
}
```

A live Gemini call takes roughly 10–20 s. If validation fails three times, the response is
still `200` with `provider: "gemini-fallback"` and a validated deterministic template.

---

## Live monitoring

Only available when `KAIROS_MODE=mock` (the default). In other modes the snapshot endpoint
returns `{ "mode": "...", "state": "unavailable", "note": "..." }`.

### `GET /live/{boiler_id}`

Accelerated replay snapshot. `LIVE_TIME_SCALE=120` means 120 plant-minutes per real minute.

```json
{
  "mode": "mock",
  "simulated": true,
  "time_scale": 120.0,
  "state": "running",
  "sim_minutes": 43.5,
  "progress_pct": 36.3,
  "design_duration_min": 107.0,
  "actual_duration_min": null,
  "detection": {
    "detected": true,
    "at_min": 1.0,
    "latency_min": 1.0,
    "rule": "FDF speed >= 25% sustained for 3 samples while drum pressure < 5 barg",
    "samples_required": 3
  },
  "startup": { "id": "S-1049", "status": "running", "source": "simulated-live" },
  "curve": { "id": "b101-sop202-r3", "version": 1 },
  "chart": { "...": "..." },
  "analysis": { "...": "..." },
  "events": [],
  "last_values": { "drum_pressure": 12.4 },
  "llm_configured": true,
  "note": "Accelerated replay of a generated startup. Not live plant data."
}
```

On completion the simulator stores the run as a normal startup and marks
`startup.stored: true`.

### `POST /live/{boiler_id}/simulate`

Restarts the replay from the beginning and returns the first snapshot.

```json
{ "ok": true, "snapshot": { "state": "starting", "sim_minutes": -15.0 } }
```

Returns `409` when `KAIROS_MODE` is not `mock`.

### `GET /live/{boiler_id}/stream` (SSE)

Server-sent events, one JSON snapshot per event, every `LIVE_POLL_SECONDS` (default 0.5 s).

```
data: {"state":"running","sim_minutes":43.5,...}

data: {"state":"running","sim_minutes":44.0,...}
```

An `event: error` frame is sent if the simulator fails. The frontend falls back to polling
`GET /live/{boiler_id}`.

---

## Demo

### `POST /demo/reset`

Wipes demo startups, curves, boilers and insights, then re-seeds the approved SOP-202
curve plus the five demo runs. Returns a seeding summary.

```bash
curl -s -X POST localhost:8000/api/demo/reset | jq
```

### `GET /demo/sop-text`

The bundled SOP-202 text, useful for pasted-text extraction demos.

```json
{
  "document": "SOP-202",
  "revision": "3.0",
  "equipment": "Boiler B-101",
  "characters": 1954,
  "text": "Boiler Startup Procedure SOP-202 …",
  "note": "Example procedure bundled with the demo. Upload your own PDF or paste text."
}
```

---

## Quick smoke test

```bash
curl -s localhost:8000/api/health | jq '{status,llm_configured,ai_extraction_configured}'
curl -s localhost:8000/api/startups | jq '.[] | {id,score,score_status}'
curl -s localhost:8000/api/startups/S-1042/analysis | jq '.violations[] | {id,severity,worst,source_ref}'
curl -s -X POST 'localhost:8000/api/startups/S-1042/insight?force=true' \
  | jq '.record.meta | {provider,model,validation,latency_s}'
```
