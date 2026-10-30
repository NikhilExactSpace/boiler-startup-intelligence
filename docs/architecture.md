# Architecture

## One-sentence model

The historian says **what happened**, the approved curve says **what should have
happened**, deterministic analytics quantify the difference, and the LLM only explains
that evidence.

This split is enforced in code, not just in prompt text.

```
┌──────────────────┐     ┌──────────────────────┐     ┌──────────────────────┐
│ KairosDB / mock  │────▶│ Startup recording    │────▶│ analytics.py         │
│ historian        │     │ (series + metadata)  │     │ deterministic metrics│
└──────────────────┘     └──────────┬───────────┘     └──────────┬───────────┘
                                    │                            │
┌──────────────────┐                │                 ┌──────────▼───────────┐
│ SOP upload       │                │                 │ evidence bundle      │
│ PDF / image/text │                │                 │ + charts + score     │
└────────┬─────────┘                │                 └──────────┬───────────┘
         │ extraction               │                            │
┌────────▼─────────┐     ┌──────────▼───────────┐     ┌──────────▼───────────┐
│ draft curve      │────▶│ approved curve       │     │ insights.py          │
│ human approval   │     │ versioned JSON (DB)  │     │ Gemini or fallback   │
└──────────────────┘     └──────────────────────┘     └──────────────────────┘
```

The AI never feeds the analytics engine. The only path into scoring is an **approved**
curve from the database.

## Components

### Backend (`backend/app`)

| Module | Responsibility |
| --- | --- |
| `main.py` | FastAPI app, CORS, lifespan (DB init + demo seed), `/api` prefix. |
| `config.py` | Env-driven settings; finds `.env` in the project or backend directory. No secrets committed. |
| `db.py` | SQLite schema and connection helpers (`boilers`, `design_curves`, `startups`, `insights`, `live_runs`). |
| `schemas.py` | Strict Pydantic models for the design curve. Validation catches duplicate keys, non-contiguous phases, unknown phase references, malformed limits and missing source refs. |
| `services/store.py` | Persistence for boilers, curves, startups and cached insights. Startup rows pin the curve version used at scoring time. |
| `services/analytics.py` | Interpolation, design tracking, control bands, SOP limits, milestones, phase timing, data quality, score, chart payloads, evidence ids. |
| `services/extraction.py` | Local deterministic SOP parser **and** Gemini transcription. Both produce a `DesignCurve` draft plus warnings/unknowns. |
| `services/gemini.py` | Thin Gemini client: API key check, inline PDF/image data, response schema, thinking budget, retries. |
| `services/insights.py` | Evidence bundle → Gemini explanation → strict validation → cache or deterministic fallback. |
| `services/kairos.py` | Read-only KairosDB query adapter (basic auth, chunked metric batches, optional downsampling). |
| `services/mockgen.py` | Seeded startup generator and the five demo profiles. |
| `services/live.py` | Accelerated simulator, detection rule, SSE snapshots, persistence of completed runs. |
| `services/demo.py` | Reproducible demo seeding and the SOP text endpoint. |
| `api/*.py` | HTTP routers; no business logic beyond orchestration. |

### Frontend (`frontend/src`)

| Module | Responsibility |
| --- | --- |
| `pages/Live.tsx` | Accelerated replay; SSE with polling fallback; live score, phases and events. |
| `pages/History.tsx` | Filterable startup list with score, duration, lag, violations, abort observations. |
| `pages/StartupDetail.tsx` | Score breakdown, phase strip, signal charts, deviations, milestones, insight card. |
| `pages/Compare.tsx` | One startup vs the approved design and the P25–P75 peer envelope. |
| `pages/Curves.tsx` | Curve versions, schema viewer, SOP onboarding (text/PDF/image), extraction provenance, approval checklist, boiler onboarding. |
| `components/SignalChart.tsx` | Recharts chart with design band, phase shading, limit lines, violation and milestone markers. |
| `components/InsightCard.tsx` | Generate/regenerate an explanation; provider, validation, evidence and metadata. |
| `lib/types.ts` | Canonical API contract, including AI extraction metadata. |
| `lib/theme.ts` | Semantic tones and chart colours for the light theme. |

## Data model

```
boilers(id, name, site, tag_prefix, kairos_mode, tag_map, created_at)

design_curves(id, boiler_id, version, status, curve_json, sha256, approved_by, approved_at)

startups(id, boiler_id, curve_id, label, detected_start, detected_end, status, source,
         duration_min, score, series_json, meta_json, created_at)

insights(id, startup_id, evidence_hash, model, prompt_version, provider, payload_json,
         created_at)
```

Important properties:

* A startup stores `curve_id`, so re-approving a curve never retroactively changes the
  comparison for old runs.
* An insight is cached with an `evidence_hash`. If the underlying startup changes, the
  cached insight is treated as stale and regenerated.
* Curve JSON is versioned; approval inserts a new version rather than mutating an old one.
* The historian adapter is query-only. There is no write path to the DCS.

## Analytics

### Time origin

`t = 0` is the detected startup start. All design tracks, phases, limits and milestones
use minutes from that origin. The live simulator includes a short pre-roll so the chart
shows data before ignition.

### Tracking and bands

For each design track, the engine interpolates the expected value onto the historian
grid and reports:

* the signed deviation (`actual - expected`) and its absolute value;
* a reporting band from the track's tolerance;
* the fraction of samples inside the band;
* a mean bandwidth in tolerance units (used by the score).

`analytics_default` tolerances are **reporting bands only**. They are never presented as
safety limits and never cited as a procedure requirement.

### Limits

Every limit is document-sourced, carries `source_ref`, and stores the condition that must
hold (`op`). A violation is the negation of that condition. Severity is `watch` or
`abort`; `hold_seconds` and `min_duration_min` prevent a single noisy sample from creating
a deviation. Limits can be scoped to a phase window or to the first truthy sample of a
state signal (for example, flame detection).

### Score

The score is a **performance indicator**, not a safety assessment.

| Component | Weight | Calculation |
| --- | --- | --- |
| Tracking | 40% | `100 − 25 × mean band-widths` |
| Bands | 30% | `100 − 12 × watch violations − 1.5 × watch minutes` |
| Timing | 20% | `100 − 3 × |design lag|` |
| Stability | 10% | `100 − 40 × stdev(drum pressure in final 10 min) / 0.8` |

Rules:

* abort-level observations cap the score at **45** and set status `attention`;
* otherwise watch violations set `watch`, otherwise nominal/reduced confidence;
* below **80% telemetry coverage** no score is produced (`insufficient_data`);
* stability is skipped when the run ends before the stabilize phase has 5 minutes.

The UI always labels the number as a performance score and carries an advisory banner.

### Evidence

The analysis returns stable evidence ids such as `PH3` (phase), `M2` (milestone), `V1`
(limit violation), `P2` (prerequisite), `T1` (tracking), `Q1` (data quality), `L1`
(design lag), `A1` (abort observation). The insight prompt receives these ids and a
citation key mapping topics to ids; validation rejects any id that does not resolve.

## Live pipeline

`GET /api/live/{boiler}/stream` is an SSE stream. The simulator replays a full generated
startup at `LIVE_TIME_SCALE` (default 120×), so a 120-minute startup completes in about a
minute. Each tick:

1. slices the generated series to simulated wall time;
2. runs the same `analytics.analyze` used for historical runs;
3. applies the detection rule
   `FDF speed >= 25% sustained for 3 samples while drum pressure < 5 barg`;
4. emits phases, deviations, milestones, score and data quality;
5. on completion, stores the run as a normal startup and records the result.

The frontend falls back to `GET /api/live/{boiler}` polling if SSE is unavailable.

## AI extraction contract

The model is a **transcription engine**, not a curve generator.

1. The template (approved curve or the bundled SOP-202 seed) supplies the only allowed
   phase, signal, limit and prerequisite keys.
2. Gemini receives the original PDF/image bytes (inline data) or PDF text and returns a
   narrow fact sheet: document/phase/ramp/limit/prerequisite facts.
3. Every fact carries a verbatim `source_quote`. A number is applied only if it appears in
   that quote; otherwise the fact is rejected.
4. Unknown keys are ignored with a warning. Missing source sections keep the template
   reference and raise a review warning. Manual prerequisites (permits, interlock tests)
   are kept as checks and never assigned a fabricated number.
5. Flame-failure seconds are transcribed as `hold_seconds`, not as the boolean flame
   `value`. Upper/lower bounds are folded into the operator's `value` slot.
6. The result is validated by the same Pydantic schema used by analytics, then returned
   as a `draft`. Only a human approval turns it into an executable curve version.

There is no AI path that can silently change a limit, add a signal, or bypass approval.

## Insight contract

The evidence bundle contains only deterministic outputs. The prompt receives:

* the full analysis JSON (tracking, bands, limits, milestones, timing, quality, score);
* the list of valid evidence ids;
* a citation key mapping topics to ids;
* the advisory disclaimer.

Validation re-checks the generated JSON:

* every number appears in the evidence corpus;
* every evidence id resolves;
* every limit deviation carries a `source_ref`;
* no safety verdict or permission language;
* required fields and shapes.

A response is attempted up to three times with a correction hint. If all fail, a
deterministic template is stored with `validation.status = "fallback"` and the reason. The
UI shows the provider and validation status, never presenting the result as a safety
determination.

## Failure modes and fallbacks

| Failure | Behaviour |
| --- | --- |
| No `GEMINI_API_KEY` | Pasted/plain-text extraction and deterministic insights work; image upload returns a clear `422`. |
| AI extraction has no grounded facts | `422` with an explanation; no partial curve is returned. |
| Gemini insight fails validation three times | Deterministic template, marked as fallback in the UI. |
| Historian unavailable | Demo mock/replay still works; the sidebar shows the configured mode and read-only status. |
| Missing telemetry | Score suppressed below 80% coverage; gaps are listed in the evidence. |
| Duplicate boiler id | `409`, no silent overwrite. |
| Duplicate startup evidence | Insight reused when the evidence hash is unchanged. |

## Security and safety boundaries

* Historian credentials are server-side environment variables; the browser never sees
  them.
* The API exposes no DCS write endpoint.
* The AI key is server-side only; the frontend calls the backend, never Gemini directly.
* CORS is restricted to the configured UI origins.
* `.env` is git-ignored; `.env.example` documents the contract without secrets.
* All AI output is advisory; approval and operating decisions remain human.
