# Demo script (8 minutes)

A walkthrough you can run live. All numbers below are from a freshly seeded database.

## Before you start

```bash
# terminal 1
cd boiler-startup-intelligence/backend
../.venv/bin/uvicorn app.main:app --port 8000

# terminal 2
cd boiler-startup-intelligence/frontend
npm run dev            # http://127.0.0.1:5173
```

1. Open `http://127.0.0.1:5173`.
2. Press **Reset** in the sidebar (or `POST /api/demo/reset`) so you start from the seed.
3. Check the sidebar footer: historian mode **mock**, replay **120×**, AI **gemini**. If the
   key is missing it will say deterministic — the demo still works, but skip the ~15 s AI
   pauses and describe them instead.

What to say up front:

> The historian tells us what happened, the approved curve tells us what should have
> happened, deterministic analytics quantify the difference, and the language model only
> explains that evidence. It never invents a limit and never decides whether the boiler is
> safe to operate.

---

## 0:00–1:00 — The live run

Open **Live startup**.

* A replay is already running at 120×; a 107-minute design startup finishes in about a
  minute.
* Point at the **detection rule**: FDF speed ≥ 25% for 3 samples while drum pressure is
  below 5 barg. That is how `t = 0` is found without an operator timestamp.
* Point at the top cards: current phase, design vs actual time, live score, data quality.
* The phase strip advances through purge → pilot → ramp 0–10 → 10–30 → 30–50 → main steam
  line switch → stabilise.

If it has already finished, press **Restart replay** and keep talking for a minute.

Talking point: the same `analytics.analyze` function runs here and on historical runs, so
there is no separate "demo scoring" path.

---

## 1:00–2:30 — History and the spread of runs

Open **Startup history**.

| Startup | What it shows | Score |
| --- | --- | --- |
| `S-1039` clean reference | on-curve run | **96.8** nominal |
| `S-1040` slow second ramp | 3 min late, still in band | **90.3** nominal |
| `S-1041` NOx / SH temp | watch-limit excursions | **81.0** watch |
| `S-1042` long purge, slow 10–30 ramp | 120 min vs 107 min design, 8.0 min lag | **67.8** watch |
| `S-1043` fuel-gas pressure loss | abort-level observation, run stopped early | **45.0** attention |

Say: the score is a **performance indicator** built from tracking (40%), bands (30%),
timing (20%) and stability (10%). It is not a safety score. Abort-level observations cap
it at 45 and set the status to attention; below 80% telemetry coverage it is suppressed.

Open `S-1043` for one sentence: the run was aborted at 43.5 minutes, and the score is
capped rather than being allowed to look "good" or "bad" on partial data.

---

## 2:30–4:30 — The hero run: S-1042

Open `S-1042`. This is the run to spend time on.

1. **Header** — 119.99 min actual vs 107 min design (+12.99), lag **8.0 min** behind,
   status **watch**, score **67.8**.
2. **Score breakdown** — tracking 54.9, bands 70.0, timing 77.5, stability 96.8.
3. **Charts** — the cyan line is actual, the dashed line is the approved design, the
   shaded ribbon is the reporting tolerance. Phase shading shows where the schedule
   slipped.
4. **Two watch deviations**, both citing SOP-202 §4:
   * NOx reached **60 ppm** at **t = 10.5 min**, above the 50 ppm limit, for 1.25 min.
   * Drum level fell to **37.3%** at **t = 26.75 min**, outside the required 40–70%
     band, for 2.75 min.
5. **Milestones** — 10 barg at +4.0 min, 30 barg at +10.8 min, 50 barg at +12.8 min. The
   delay compounds through the ramp.
6. **Phases** — purge took 9.5 min instead of 5; everything after it inherits the slip.

Important distinction to make out loud: the shaded tolerance band is an
**`analytics_default` reporting band**. The 50 ppm and 40–70% values are **document
limits** with a `source_ref`. Only the latter can produce a deviation.

---

## 4:30–6:00 — The explanation layer

Still on `S-1042`, press **Generate explanation**.

* With a key: roughly **10–20 s**, provider **gemini**, validation **validated**, model
  `gemini-2.5-flash`.
* The card shows the summary, a timeline with evidence chips, the two deviations and their
  SOP references, contributing factors, data gaps and recommended checks. Every chip is a
  deterministic evidence id (`PH2`, `V1`, `V2`, `M3`, `L1`, `Q1`, …).
* Read the disclaimer: advisory only, no safety determination, shift engineer remains
  responsible.

If the key is not configured, press it anyway: you get a deterministic template with
provider **deterministic** and the same structure. Either way the numbers come from
analytics, not the model.

Optional, if someone asks "what if the model hallucinates?":

> Validation rejects any number that is not in the evidence bundle, any evidence id that
> does not resolve, any limit deviation without a `source_ref`, and any safety-verdict
> language. It retries three times, then falls back. There is no prompt that can add a
> limit — the model is not on the scoring path at all.

---

## 6:00–7:30 — Curve onboarding from a document

Open **Design curves**. The approved SOP-202 Rev 3.0 curve shows 7 phases, 11 signals,
7 document limits, 12 analytics tolerances and design duration 107.0 min.

In **Extract a curve from the approved document**:

* **Paste text** — use **Load bundled SOP-202** → **Extract**. This is the deterministic
  parser: fast, no network, `document.engine = deterministic`.
* **Upload PDF / image** — select `backend/app/seed/examples/SOP-202_B-101_Rev3.pdf` (or
  the `_scan.png`). With a key this goes to Gemini: 19 of 21 proposed facts are accepted,
  0 rejected, and it takes around 10–13 s. Point out:
  * the **AI transcription** badge and the model/latency/fact counts;
  * every accepted fact is anchored to a verbatim `source_quote`;
  * unresolved fields are listed under **Not found in the document**, with the template
    value kept;
  * warnings: printed sections were missing for 6 limits (template source references
    kept), and 2 manual prerequisites (permit/interlock) were left as operator checks —
    they are never given a fabricated number.

Then the approval checklist. Approval is a human action and creates a **new curve
version**. Old startups keep the curve version they were recorded against, so history is
never rewritten. Finish by saying: extraction proposes, a person approves, analytics only
consumes approved curves.

> Scanned PDFs and images need the Gemini key. Without it the API returns a clear `422`
> and the UI explains that text/PDF-text extraction still works.

---

## 7:30–8:00 — Close

Return to **History**, then open **Compare** on `S-1042`.

* Cyan is this run, dashed amber is the design, violet is the peer median and the shaded
  ribbon is the P25–P75 envelope of earlier runs.
* `S-1042` sits behind the envelope through the middle ramp and lands late at 50 barg —
  the same story the numbers told, now visual.

Close with the boundary:

> This is a read-only comparison tool. It cannot write to the DCS, it cannot change a
> limit, and it will not tell you a boiler is safe. It shows where the run diverged, cites
> the procedure, and leaves the operating decision with the shift engineer.

---

## Fallbacks and failure modes to mention

| Situation | What the audience sees |
| --- | --- |
| No Gemini key | Insights use a validated deterministic template; PDF text/paste extraction works; image upload returns `422`. |
| Gemini validation fails 3× | Insight card shows **gemini-fallback** with the validation notes; content is still grounded in evidence. |
| No `pdftotext` | Text PDFs still go to Gemini; pasted text always works. |
| Historian not configured | Replay mode still works; the sidebar shows **mock** and **read-only**. |
| Low telemetry coverage | Score is suppressed (`insufficient_data`) instead of being guessed. |
| Duplicate boiler id | `409`; the UI asks you to select the existing boiler. |

## Reset between demos

```bash
curl -s -X POST localhost:8000/api/demo/reset | jq
```

or press **Reset** in the sidebar. This removes live runs and generated insights and
re-seeds `S-1039`–`S-1043` with the scores above.
