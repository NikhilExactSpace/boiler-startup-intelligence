# Design curve schema (`design-curve/v1`)

A design curve is the versioned JSON answer to **what should have happened**. It is
validated by `backend/app/schemas.py` before it can be approved, and the analytics engine
consumes exactly the same object.

The schema deliberately separates **expected trajectory + reporting tolerance** from
**document-sourced limits**. A tolerance is not a safety limit, and the UI says so.

## Top level

| Field | Type | Notes |
| --- | --- | --- |
| `schema_version` | `"1.0"` | Literal version of this schema. |
| `curve_id` | string | Stable id, e.g. `b101-sop202-r3`. |
| `boiler_id` | string | Owning boiler. |
| `name` | string | Human label. |
| `status` | `draft` \| `approved` | Only approved curves are used for analysis. |
| `source` | object | Document id, revision, hashes, uploader, approver, notes. |
| `time_origin` | object | `startup_detected` or `operator_mark`; `t=0` convention. |
| `phases` | array | Contiguous windows starting at `t=0`. |
| `signals` | array | Historian bindings, design tracks, limits, milestones. |
| `prerequisites` | array | Automatic signal checks or manual operator checks. |
| `manual_criteria` | array | Human-judgement criteria quoted from the procedure. |
| `notes` | string[] | Reviewer-facing notes. |
| `extras` | object | AI provenance, generator metadata, anything non-executable. |

Validation rules include: at least one phase and signal, unique phase/signal/limit keys,
phases contiguous from `0`, and every design track referencing a real phase.

## Phases

```json
{
  "key": "ramp_0_10",
  "label": "Ramp 0-10 barg",
  "order": 3,
  "start_min": 6,
  "end_min": 26,
  "source_ref": "SOP-202 §3 Step 6",
  "note": "Open FDF damper, raise firing rate at no more than 0.5 barg/min"
}
```

Phases must be contiguous: `phases[n].end_min == phases[n+1].start_min`. The last phase
end is the design duration (`107` minutes for SOP-202).

## Signals

```json
{
  "key": "drum_level",
  "label": "Drum level",
  "unit": "%",
  "kind": "analog",
  "decimals": 0,
  "required": true,
  "chart_order": 2,
  "kairos": { "metric": "B101.DRUM_LEVEL", "tags": {} },
  "design": [
    {
      "phase": "ramp_0_10",
      "points": [{ "t": 6, "value": 50 }, { "t": 26, "value": 50 }],
      "tolerance": 6,
      "tolerance_provenance": "analytics_default",
      "source_ref": "SOP-202 §4"
    }
  ],
  "limits": [
    {
      "key": "drum_level_band",
      "op": "between",
      "min": 40,
      "max": 70,
      "severity": "watch",
      "label": "Keep drum level 40-70%",
      "min_duration_min": 0.5,
      "source_ref": "SOP-202 §4"
    },
    {
      "key": "drum_level_abort",
      "op": "gte",
      "value": 25,
      "severity": "abort",
      "label": "Abort if drum level drops below 25%",
      "active_from_event": "signal_first_truthy",
      "source_ref": "SOP-202 §5"
    }
  ],
  "milestones": []
}
```

### `kind`

* `analog` — continuous numeric signal; tracked against the design trajectory.
* `state` — 0/1 signal (for example `flame_detected`); plotted as a step.

### `design` tracks

| Field | Meaning |
| --- | --- |
| `phase` | Phase this segment belongs to. |
| `points` | At least two `{t, value}` points, sorted by time. |
| `tolerance` | Reporting band around the expected value. May be `null`. |
| `tolerance_provenance` | `analytics_default` or `document`. Only `document` may cite a procedure. |
| `max_rate_per_min` | Optional ramp-rate cap for narrative/checks. |
| `rate_direction` | `up`, `down`, or `abs`. |
| `source_ref` | Where the expectation came from. |

`analytics_default` tolerances are reporting bands only. They never appear as safety
limits and are never cited as SOP requirements.

### `limits`

A limit stores the condition that **must hold**. A violation is the negation of that
condition. This keeps the analytics code simple and prevents the LLM from reinterpreting
abort wording.

| `op` | Condition that must hold | Violation example |
| --- | --- | --- |
| `gt` | `value > threshold` | `value <= threshold` |
| `gte` | `value >= threshold` | `value < threshold` |
| `lt` | `value < threshold` | `value >= threshold` |
| `lte` | `value <= threshold` | `value > threshold` |
| `between` | `min <= value <= max` | outside `[min, max]` |
| `eq` | `value == threshold` | not equal (state signals) |

Other fields:

* `severity` — `watch` (control band) or `abort` (stop criterion). Abort observations cap
  the performance score at 45.
* `active_from_min` / `active_to_min` — restrict the limit to a time window.
* `active_from_event: "signal_first_truthy"` — start checking after the signal first
  becomes true (for example, after flame is established).
* `hold_seconds` — the condition must persist this long before it counts. This is where a
  procedure's "flame failure for 4 s" belongs; it is **not** the boolean flame value.
* `min_duration_min` — minimum excursion duration for an analog limit.
* `source_ref` — **required**, non-empty. Every limit must cite the procedure.

### `milestones`

```json
{ "key": "reached_10_barg", "label": "10 barg reached", "value": 10, "source_ref": "SOP-202 §3" }
```

Milestones are used for timing comparison; they never create pass/fail logic.

## Prerequisites and manual criteria

Automatic prerequisites check a signal over a window:

```json
{
  "key": "fg_pressure_ready",
  "label": "Fuel gas pressure 3.5-4.5 barg",
  "signal_key": "fuel_gas_pressure",
  "op": "between",
  "min": 3.5,
  "max": 4.5,
  "mode": "auto",
  "window_min": 15,
  "must_hold_all_samples": true,
  "source_ref": "SOP-202 §2"
}
```

Manual prerequisites (`mode: "manual"`) carry no numeric condition; they remain operator
checks and are never assigned a fabricated value by AI extraction. Free-form human
criteria live separately in `manual_criteria`:

```json
{ "key": "drum_visual", "label": "Drum level gauge checked", "detail": "...", "source_ref": "SOP-202 §2" }
```

## Versioning and approval

* Extraction produces `status: "draft"` and may set `extras.extraction` with model,
  file hash, fact counts and the raw fact sheet.
* Approval validates the draft and inserts a **new curve version** with a new SHA-256.
  Existing versions are immutable.
* A startup records the `curve_id` active at its detected start, so later approvals never
  rewrite historical comparisons.

## Extraction contract

The AI is a transcription engine, not a curve generator:

1. The template supplies the allowed phase/signal/limit/prerequisite keys.
2. The model returns facts with a verbatim `source_quote`.
3. A fact is applied only if its number appears in that quote.
4. Unknown keys, ungrounded numbers and invalid bounds are rejected with warnings.
5. Missing printed sections keep the template reference and raise a review warning.
6. Manual prerequisites are skipped (kept as operator checks), not given fake numbers.
7. Flame-failure seconds are mapped to `hold_seconds`.
8. The draft must pass the same Pydantic validation as any hand-written curve.

AI extraction can add facts to an existing approved template, but it cannot add a new
signal, invent a limit, change an operator, or bypass human approval. If no grounded
facts are produced, the endpoint returns `422` rather than a partial curve.

## Example: minimal valid curve

```json
{
  "schema_version": "1.0",
  "curve_id": "b101-demo-r1",
  "boiler_id": "B-101",
  "name": "Cold start - demo",
  "status": "draft",
  "source": { "document": "SOP-999", "revision": "1.0", "source_ref": "demo" },
  "time_origin": {
    "type": "startup_detected",
    "tag": "B101.FDF_SPEED",
    "description": "t = 0 when the startup is detected"
  },
  "phases": [
    { "key": "purge", "label": "Purge", "order": 1, "start_min": 0, "end_min": 5 }
  ],
  "signals": [
    {
      "key": "drum_pressure",
      "label": "Drum pressure",
      "unit": "barg",
      "kind": "analog",
      "kairos": { "metric": "B101.DRUM_PRESS", "tags": {} },
      "design": [
        {
          "phase": "purge",
          "points": [{ "t": 0, "value": 0 }, { "t": 5, "value": 0 }],
          "tolerance": 0.5,
          "tolerance_provenance": "analytics_default"
        }
      ],
      "limits": []
    }
  ]
}
```

The `source` object in the real schema requires `document` and `revision`; a hand-written
demo must still provide them. Run `POST /api/design-curves/approve` to validate it through
the production schema.
