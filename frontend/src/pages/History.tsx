import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import {
  ArrowUpRightIcon,
  BoltIcon,
  ChevronRightIcon,
  ClockIcon,
  GaugeIcon,
  ShieldIcon,
} from "../components/icons";
import {
  AdvisoryNotice,
  cn,
  EmptyState,
  ErrorNotice,
  Kpi,
  Loading,
  Panel,
  Pill,
  SectionHeading,
} from "../components/ui";
import { api } from "../lib/api";
import { useBoiler } from "../lib/boiler";
import { fmt, fmtSigned, fmtDate, relativeTime } from "../lib/format";
import { scoreTone } from "../lib/theme";
import type { StartupSummary } from "../lib/types";

const FILTERS = ["all", "complete", "aborted", "in_progress"] as const;
type Filter = (typeof FILTERS)[number];

function ScoreCell({ run }: { run: StartupSummary }) {
  const tone = scoreTone(run.score, run.score_status);
  return (
    <div className="min-w-[92px]">
      <div className="flex items-baseline gap-2">
        <span className={cn("text-sm font-semibold tabular-nums", tone.text)}>
          {run.score === null ? "—" : run.score.toFixed(1)}
        </span>
        <span className="text-[9px] uppercase tracking-wider text-slate-500">
          {run.score_status?.replace(/_/g, " ")}
        </span>
      </div>
      <div className="mt-1 h-1 w-20 overflow-hidden rounded-full bg-slate-200">
        <div
          className={cn("h-full rounded-full", tone.bar)}
          style={{ width: `${run.score === null ? 0 : Math.max(3, run.score)}%` }}
        />
      </div>
    </div>
  );
}

export function HistoryPage() {
  const { boilerId, boiler } = useBoiler();
  const [runs, setRuns] = useState<StartupSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setRuns(null);
    api
      .startups(boilerId)
      .then((rows) => {
        if (!cancelled) {
          setRuns(rows);
          setError(null);
        }
      })
      .catch((caught) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Could not load startups");
      });
    return () => {
      cancelled = true;
    };
  }, [boilerId, reloadToken]);

  const stats = useMemo(() => {
    const rows = runs ?? [];
    const scored = rows.filter((row) => row.score !== null);
    const mean = scored.length
      ? scored.reduce((sum, row) => sum + (row.score as number), 0) / scored.length
      : null;
    const best = scored.slice().sort((a, b) => (b.score as number) - (a.score as number))[0];
    const attention = rows.filter((row) => row.score_status === "attention").length;
    const lagged = rows.filter((row) => (row.lag_minutes ?? 0) > 2).length;
    return { total: rows.length, mean, best, attention, lagged };
  }, [runs]);

  const filtered = useMemo(() => {
    const rows = runs ?? [];
    return rows.filter((row) => {
      if (filter !== "all" && row.status !== filter) return false;
      if (typeFilter !== "all" && row.startup_type !== typeFilter) return false;
      return true;
    });
  }, [runs, filter, typeFilter]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="section-title mb-1">Historical comparison</p>
          <h1 className="text-lg font-semibold tracking-tight text-slate-900">Startup history</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-600">
            Every run is stored against the approved curve version that was active when it started.
            Re-approving a procedure creates a new version and never rewrites history.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link to="/live" className="btn-primary">
            <BoltIcon className="h-4 w-4" /> Watch a live startup
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi
          label="Stored startups"
          value={fmt(stats.total, 0)}
          hint={boiler ? `${boiler.name} · ${boiler.site || "site not set"}` : undefined}
          icon={<ClockIcon className="h-4 w-4" />}
        />
        <Kpi
          label="Mean score"
          value={stats.mean === null ? "—" : stats.mean.toFixed(1)}
          hint="Performance indicator, not safety"
          tone={stats.mean === null ? undefined : scoreTone(stats.mean)}
          icon={<GaugeIcon className="h-4 w-4" />}
        />
        <Kpi
          label="Best run"
          value={stats.best?.id ?? "—"}
          hint={stats.best?.score === null || stats.best?.score === undefined ? "no scored runs" : `${stats.best.score.toFixed(1)} · ${stats.best.score_status}`}
          icon={<ArrowUpRightIcon className="h-4 w-4" />}
        />
        <Kpi
          label="Needs review"
          value={fmt(stats.attention, 0)}
          hint={`${stats.lagged} run(s) more than 2 min behind the design ramp`}
          tone={stats.attention ? scoreTone(null, "attention") : undefined}
          icon={<ShieldIcon className="h-4 w-4" />}
        />
      </div>

      <Panel className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
          <div className="flex flex-wrap items-center gap-1.5">
            {(["all", "cold", "warm", "hot"] as const).map((option) => (
              <button
                key={`type-${option}`}
                type="button"
                onClick={() => setTypeFilter(option)}
                className={cn(
                  "rounded-md border px-2 py-1 text-[10px] font-medium capitalize transition-colors",
                  typeFilter === option
                    ? "border-cyan-200 bg-cyan-50 text-cyan-800"
                    : "border-slate-200 text-slate-500 hover:bg-slate-100 hover:text-slate-700",
                )}
              >
                {option === "all" ? "All types" : `${option} startups`}
              </button>
            ))}
            <span className="mx-1 h-4 w-px bg-slate-200" />
            {FILTERS.map((option) => {
              const count =
                option === "all"
                  ? runs?.length ?? 0
                  : (runs ?? []).filter((row) => row.status === option).length;
              return (
                <button
                  key={option}
                  type="button"
                  onClick={() => setFilter(option)}
                  className={cn(
                    "rounded-md px-2.5 py-1 text-[11px] font-medium capitalize transition-colors",
                    filter === option
                      ? "bg-cyan-50 text-cyan-800 ring-1 ring-inset ring-cyan-200"
                      : "text-slate-500 hover:bg-slate-100 hover:text-slate-700",
                  )}
                >
                  {option.replace(/_/g, " ")}
                  <span className="ml-1.5 text-[10px] text-slate-500">{count}</span>
                </button>
              );
            })}
          </div>
          <div className="flex items-center gap-2 text-[10px] text-slate-500">
            <span>sorted newest first</span>
            <button
              type="button"
              className="btn-ghost !px-2 !py-1 !text-[10px]"
              onClick={() => setReloadToken((token) => token + 1)}
            >
              Refresh
            </button>
          </div>
        </div>

        {error && <div className="p-4"><ErrorNotice message={error} onRetry={() => setReloadToken((token) => token + 1)} /></div>}
        {!runs && !error && <Loading label="Loading startups" />}

        {runs && filtered.length === 0 && (
          <EmptyState
            icon={<ClockIcon className="h-4 w-4" />}
            title={filter === "all" ? "No startups yet" : `No ${filter.replace(/_/g, " ")} startups`}
            description="Start the accelerated live replay, or reset the demo to restore the bundled runs."
            action={
              <Link to="/live" className="btn-primary !py-1.5 text-xs">
                <BoltIcon className="h-3.5 w-3.5" /> Open live replay
              </Link>
            }
          />
        )}

        {runs && filtered.length > 0 && (
          <div className="overflow-x-auto">
            <table className="data-table min-w-[980px]">
              <thead>
                <tr>
                  <th>Startup</th>
                  <th>Started</th>
                  <th>Type</th>
                  <th>Duration</th>
                  <th>Score</th>
                  <th>Design lag</th>
                  <th>Observations</th>
                  <th>Status</th>
                  <th aria-label="Open" />
                </tr>
              </thead>
              <tbody>
                {filtered.map((run) => (
                  <tr key={run.id} className="group">
                    <td>
                      <Link to={`/startups/${run.id}`} className="block">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-slate-800 group-hover:text-cyan-800">
                            {run.id}
                          </span>
                          {run.live && (
                            <span className="chip border-cyan-200 bg-cyan-50 !px-1.5 !py-0 !text-[9px] text-cyan-700">
                              live
                            </span>
                          )}
                        </div>
                        <p className="mt-0.5 max-w-[260px] truncate text-[11px] text-slate-500">
                          {run.label}
                        </p>
                      </Link>
                    </td>
                    <td>
                      <p className="text-[12px] text-slate-700">{fmtDate(run.detected_start)}</p>
                      <p className="text-[10px] text-slate-500">{relativeTime(run.detected_start)}</p>
                    </td>
                    <td>
                      <span
                        className={cn(
                          "chip !px-1.5 !py-0 !text-[9px] capitalize",
                          run.startup_type === "cold"
                            ? "border-sky-200 bg-sky-50 text-sky-700"
                            : run.startup_type === "warm"
                              ? "border-amber-200 bg-amber-50 text-amber-700"
                              : "border-rose-200 bg-rose-50 text-rose-700",
                        )}
                      >
                        {run.startup_type ?? "cold"}
                      </span>
                    </td>
                    <td>
                      <p className="text-[12px] tabular-nums text-slate-700">
                        {fmt(run.duration_min, 1)} min
                      </p>
                      <p className="text-[10px] text-slate-500">
                        design {fmt(run.design_duration_min ?? 107, 0)} min
                      </p>
                    </td>
                    <td>
                      <ScoreCell run={run} />
                    </td>
                    <td>
                      <span
                        className={cn(
                          "mono",
                          (run.lag_minutes ?? 0) > 2
                            ? "text-amber-700"
                            : (run.lag_minutes ?? 0) < -2
                              ? "text-sky-700"
                              : "text-slate-600",
                        )}
                      >
                        {fmtSigned(run.lag_minutes, 1)} min
                      </span>
                    </td>
                    <td>
                      <div className="flex flex-wrap gap-1">
                        {run.violations > 0 ? (
                          <span className="chip border-amber-200 bg-amber-50 !px-1.5 !py-0 !text-[9px] text-amber-700">
                            {run.violations} watch
                          </span>
                        ) : (
                          <span className="chip border-slate-300 bg-slate-100 !px-1.5 !py-0 !text-[9px] text-slate-500">
                            0 watch
                          </span>
                        )}
                        {run.abort_observations > 0 && (
                          <span className="chip border-rose-200 bg-rose-50 !px-1.5 !py-0 !text-[9px] text-rose-700">
                            {run.abort_observations} abort
                          </span>
                        )}
                      </div>
                      {run.top_deviation && (
                        <p className="mt-1 max-w-[250px] truncate text-[10px] text-slate-500" title={run.top_deviation}>
                          {run.top_deviation}
                        </p>
                      )}
                    </td>
                    <td>
                      <Pill status={run.status} dot />
                    </td>
                    <td className="text-right">
                      <Link
                        to={`/startups/${run.id}`}
                        className="inline-flex rounded-md p-1 text-slate-500 transition-colors group-hover:text-cyan-700"
                        aria-label={`Open ${run.id}`}
                      >
                        <ChevronRightIcon className="h-4 w-4" />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <AdvisoryNotice />
    </div>
  );
}
