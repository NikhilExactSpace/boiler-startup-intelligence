#!/usr/bin/env bash
# Quick end-to-end smoke test against a running backend.
# Usage: scripts/smoke.sh [base_url]
# Exit code 0 = all checks passed.

set -euo pipefail

BASE="${1:-http://127.0.0.1:8000}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="$ROOT/.venv/bin/python"
if [[ ! -x "$PY" ]]; then
  PY="$(command -v python3)"
fi

pass() { printf '  ok   %s\n' "$1"; }
fail() { printf '  FAIL %s\n' "$1" >&2; exit 1; }

get() { curl -fsS "$BASE$1"; }

printf 'Boiler Startup Intelligence smoke test\n'
printf '  base %s\n\n' "$BASE"

health="$(get /api/health)"
"$PY" - "$health" <<'PY' || fail "health payload"
import json, sys
d = json.loads(sys.argv[1])
assert d["status"] == "ok", d
print(f'  ok   health {d["version"]} | kairos={d["kairos_mode"]} | insight={d["insight_provider"]} | extraction={d["extraction_provider"]}')
PY

curves="$(get /api/design-curves?boiler_id=B-101)"
"$PY" - "$curves" <<'PY' || fail "design curve"
import json, sys
rows = json.loads(sys.argv[1])
assert rows, "no curves"
c = rows[0]
assert c["status"] == "approved", c
assert c["limits"] > 0 and c["analytics_tolerances"] > 0, c
print(f'  ok   curve {c["id"]} v{c["version"]} | {c["signals"]} signals | {c["limits"]} limits | {c["design_duration_min"]} min')
PY

startups="$(get /api/startups?boiler_id=B-101)"
"$PY" - "$startups" <<'PY' || fail "startup list"
import json, sys
rows = json.loads(sys.argv[1])
by_id = {r["id"]: r for r in rows}
expected = {"S-1039": 96.8, "S-1040": 89.3, "S-1041": 81.0, "S-1042": 67.8, "S-1043": 45.0}
missing = [k for k in expected if k not in by_id]
assert not missing, f"missing seeded startups: {missing} (run POST /api/demo/reset)"
for sid, score in expected.items():
    got = by_id[sid]["score"]
    assert got is not None and abs(got - score) < 0.2, (sid, got, score)
assert by_id["S-1043"]["status"] == "aborted", by_id["S-1043"]
print("  ok   seeded startups S-1039..S-1043 with expected scores")
PY

analysis="$(get /api/startups/S-1042/analysis)"
"$PY" - "$analysis" <<'PY' || fail "analysis"
import json, sys
d = json.loads(sys.argv[1])
assert d["score"]["value"] is not None, d["score"]
assert d["violations"], "no violations"
for v in d["violations"]:
    assert v["source_ref"], v
assert d["lag"]["minutes"] is not None
assert d["milestones"] and all(m["source_ref"] for m in d["milestones"])
print(f'  ok   S-1042 score {d["score"]["value"]} ({d["score"]["status"]}) | {len(d["violations"])} deviations | lag {d["lag"]["minutes"]} min')
PY

chart="$(get /api/startups/S-1042/chart)"
"$PY" - "$chart" <<'PY' || fail "chart"
import json, sys
d = json.loads(sys.argv[1])
n = len(d["grid"])
assert n > 100, n
for key, sig in d["signals"].items():
    for field in ("actual", "expected", "lo", "hi"):
        assert len(sig[field]) == n, (key, field, len(sig[field]), n)
print(f'  ok   chart {n} points | {len(d["signals"])} signals aligned')
PY

insight="$(get /api/startups/S-1042/insight)"
"$PY" - "$insight" <<'PY' || fail "insight cache"
import json, sys
d = json.loads(sys.argv[1])
for key in ("available", "stale", "record", "evidence_hash", "llm_configured"):
    assert key in d, key
print(f'  ok   insight cache available={d["available"]} stale={d["stale"]}')
PY

live="$(get /api/live/B-101)"
"$PY" - "$live" <<'PY' || fail "live snapshot"
import json, sys
d = json.loads(sys.argv[1])
assert d.get("mode") == "mock", d
assert d.get("state") in ("watching", "starting", "running", "complete"), d.get("state")
assert d.get("simulated") is True
print(f'  ok   live replay {d["state"]} at {d["time_scale"]}x ({d["progress_pct"]}%)')
PY

printf '\nAll checks passed.\n'
