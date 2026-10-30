import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useParams } from "react-router-dom";

import { InsightCard } from "../components/InsightCard";
import { PhaseStrip } from "../components/PhaseStrip";
import { RawDataDrawer, type RawTab } from "../components/RawDataDrawer";
import { ChartLegend, SignalChart } from "../components/SignalChart";
import {
  AlertIcon,
  ArrowLeftIcon,
  ArrowUpRightIcon,
  CheckIcon,
  ChevronRightIcon,
  CompareIcon,
  DatabaseIcon,
  GaugeIcon,
  ShieldIcon,
  XIcon,
} from "../components/icons";
import {
  AdvisoryNotice,
  cn,
  EmptyState,
  ErrorNotice,
  EvidenceChips,
  InfoLine,
  Kpi,
  Loading,
  Meter,
  Panel,
  Pill,
  ProgressBar,
  ScoreRing,
} from "../components/ui";
import { api } from "../lib/api";
import { fmt, fmtSigned, fmtDateShort, shortHash } from "../lib/format";
import { scoreTone, severityTone, statusTone } from "../lib/theme";
import type { LimitDoc, StartupDetail, Violation } from "../lib/types";

function condition(limit: LimitDoc, unit: string): string {
  const suffix = unit ? ` ${unit}` : "";
  switch (limit.op) {
    case "between":
      return `${limit.min} – ${limit.max}${suffix}`;
    case "lte":
      return `≤ ${limit.value}${suffix}`;
    case "lt":
      return `< ${limit.value}${suffix}`;
    case "gte":
      return `≥ ${limit.value}${suffix}`;
    case "gt":
      return `> ${limit.value}${suffix}`;
    case "eq":
      return `= ${limit.value}${suffix}`;
    default:
      return limit.op;
  }
}

function ViolationTable({ violations }: { violations: Violation[] }) {
  if (!violations.length) {
    return (
      <EmptyState
        icon={<CheckIcon className="h-4 w-4" />}
        title="No control-band deviations"
        description="Every evaluated SOP band and limit held in the available telemetry."
      />
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="data-table min-w-[720px]">
        <thead>
          <tr>
            <th>Evidence</th>
            <th>Signal</th>
            <th>Observed</th>
            <th>Statement</th>
            <th>Source</th>
          </tr>
        </thead>
        <tbody>
          {violations.map((violation) => {
            const tone = severityTone(violation.severity);
            return (
              <tr key={violation.id}>
                <td>
                  <span className={cn("chip", tone.bg, tone.border, tone.text)}>
                    {violation.severity}
                  </span>
                  <p className="mono mt-1 text-slate-500">{violation.id}</p>
                </td>
                <td>
                  <p className="text-[12px] text-slate-800">{violation.signal_label}</p>
                  <p className="mono mt-0.5 text-slate-500">
                    {violation.worst} {violation.unit} at {fmt(violation.worst_at, 1)} min
                  </p>
                </td>
                <td className="whitespace-nowrap">
                  <p className="mono text-slate-700">
                    {fmt(violation.from_min, 1)} – {fmt(violation.to_min, 1)} min
                  </p>
                  <p className="text-[10px] text-slate-500">
                    {fmt(violation.duration_min, 1)} min outside
                  </p>
                </td>
                <td className="max-w-[360px]">
                  <p className="text-[11px] leading-relaxed text-slate-600">{violation.statement}</p>
                </td>
                <td className="whitespace-nowrap">
                  <span className="mono text-slate-500">{violation.source_ref}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

type DetailTab =
  | "deviations"
  | "timing"
  | "prerequisites"
  | "telemetry"
  | "abort"
  | "limits"
  | "events";

const STARTUP_TYPE_TONE: Record<string, string> = {
  cold: "border-sky-200 bg-sky-50 text-sky-700",
  warm: "border-amber-200 bg-amber-50 text-amber-700",
  hot: "border-rose-200 bg-rose-50 text-rose-700",
};

function startupTypeLabel(value?: string | null) {
  if (!value) return "Cold startup";
  return `${value.charAt(0).toUpperCase()}${value.slice(1)} startup`;
}

export function StartupDetailPage() {
  const { startupId = "" } = useParams();
  const [detail, setDetail] = useState<StartupDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [signalKey, setSignalKey] = useState("drum_pressure");
  const [tab, setTab] = useState<DetailTab>("deviations");
  const [rawOpen, setRawOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError(null);
    api
      .startup(startupId)
      .then((data) => {
        if (cancelled) return;
        setDetail(data);
        setSignalKey(
          data.chart.signals.drum_pressure ? "drum_pressure" : Object.keys(data.chart.signals)[0],
        );
      })
      .catch((caught) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Could not load startup");
      });
    return () => {
      cancelled = true;
    };
  }, [startupId, reloadToken]);

  const signals = useMemo(
    () =>
      detail
        ? Object.values(detail.chart.signals).sort((a, b) => a.chart_order - b.chart_order)
        : [],
    [detail],
  );

  if (error) {
    return (
      <div className="space-y-4">
        <Link
          to="/history"
          className="inline-flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-700"
        >
          <ArrowLeftIcon className="h-3.5 w-3.5" /> Startup history
        </Link>
        <ErrorNotice message={error} onRetry={() => setReloadToken((token) => token + 1)} />
      </div>
    );
  }

  if (!detail) return <Loading label="Loading startup comparison" />;

  const { startup, curve, chart, analysis, insight } = detail;
  const selected = chart.signals[signalKey] ?? signals[0];
  const selectedReport = analysis.signals.find((row) => row.key === selected?.key);
  const selectedTracking = selectedReport?.tracking ?? null;
  const watchViolations = analysis.violations.filter((row) => row.severity === "watch");
  const abortViolations = analysis.violations.filter((row) => row.severity === "abort");
  const observedAbort = analysis.abort_flags.filter((flag) => flag.type === "observed_threshold");
  const manualAbort = analysis.abort_flags.filter((flag) => flag.type !== "observed_threshold");
  const score = analysis.score;
  const scoreColor = scoreTone(score.value, score.status);
  const latePhases = analysis.phases.filter((phase) => phase.status === "late").length;
  const allLimits = analysis.signals.flatMap((signal) =>
    signal.limits.map((limit) => ({ ...limit, signal: signal.label, unit: signal.unit })),
  );
  const signalLabels = new Map(analysis.signals.map((row) => [row.key, row.label]));
  const coverageTone =
    analysis.data_quality.status === "ok"
      ? statusTone("ok")
      : analysis.data_quality.status === "degraded"
        ? statusTone("watch")
        : statusTone("fail");

  const tabs: { key: DetailTab; label: string; count?: number }[] = [
    { key: "deviations", label: "Deviations", count: analysis.violations.length },
    { key: "timing", label: "Timing", count: analysis.milestones.length },
    { key: "prerequisites", label: "Prerequisites", count: analysis.prerequisites.length },
    { key: "telemetry", label: "Telemetry" },
    { key: "abort", label: "Abort evidence", count: observedAbort.length + manualAbort.length },
    { key: "limits", label: "Limit audit", count: allLimits.length },
    {
      key: "events",
      label: "Curve events",
      count: (curve.events?.length ?? 0) + (curve.mill_cut_in?.length ?? 0),
    },
  ];

  const rawTabs: RawTab[] = [
    {
      key: "signals",
      label: "Signals",
      kind: "table",
      note: "Per-signal tracking against the approved design. Values come straight from the analysis endpoint.",
      columns: [
        { key: "signal", label: "Signal" },
        { key: "samples", label: "Samples", align: "right", mono: true },
        { key: "rmse", label: "RMSE", align: "right", mono: true },
        { key: "mae", label: "MAE", align: "right", mono: true },
        { key: "bias", label: "Mean bias", align: "right", mono: true },
        { key: "within", label: "Within band", align: "right", mono: true },
        { key: "max_abs", label: "Max abs", align: "right", mono: true },
        { key: "limits", label: "Limits", align: "right", mono: true },
      ],
      rows: analysis.signals.map((signal) => ({
        signal: signal.label,
        samples: fmt(signal.samples, 0),
        rmse: signal.tracking ? fmt(signal.tracking.rmse, 2) : "—",
        mae: signal.tracking ? fmt(signal.tracking.mae, 2) : "—",
        bias: signal.tracking ? fmtSigned(signal.tracking.mean_bias, 2) : "—",
        within: signal.tracking ? `${fmt(signal.tracking.within_tolerance_pct, 1)}%` : "—",
        max_abs: signal.tracking ? fmt(signal.tracking.max_abs, 2) : "—",
        limits: signal.limits.length,
      })),
    },
    { key: "analysis", label: "Analysis", kind: "json", data: analysis },
    { key: "chart", label: "Chart", kind: "json", data: chart },
    { key: "curve", label: "Curve", kind: "json", data: curve },
  ];
  if (insight) {
    rawTabs.push({ key: "insight", label: "Insight", kind: "json", data: insight });
  }

  return (
    <div className="space-y-3">
      <Link
        to="/history"
        className="inline-flex items-center gap-1.5 text-xs text-slate-500 transition-colors hover:text-slate-700"
      >
        <ArrowLeftIcon className="h-3.5 w-3.5" /> Startup history
      </Link>

      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="section-title">Startup comparison</p>
            <Pill status={startup.status} dot />
            <span
              className={cn(
                "chip",
                STARTUP_TYPE_TONE[startup.startup_type ?? "cold"] ?? STARTUP_TYPE_TONE.cold,
              )}
            >
              {startupTypeLabel(startup.startup_type)}
            </span>
            {startup.live && (
              <span className="chip border-cyan-200 bg-cyan-50 text-cyan-700">live run</span>
            )}
            <span className="chip border-slate-300 bg-slate-100 text-slate-600">
              pinned to curve v{curve.version}
            </span>
          </div>
          <h1 className="mt-1 flex flex-wrap items-baseline gap-2 text-xl font-semibold tracking-tight text-slate-900">
            {startup.id}
            <span className="text-sm font-normal text-slate-500">{startup.label}</span>
          </h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-500">
            <span>{fmtDateShort(startup.detected_start)}</span>
            <span className="text-slate-300">→</span>
            <span>{fmtDateShort(startup.detected_end)}</span>
            <span className="text-slate-300">·</span>
            <span>{startup.source}</span>
            <span className="text-slate-300">·</span>
            <span className="flex items-center gap-1 text-slate-600">
              <ShieldIcon className="h-3 w-3 text-cyan-600" />
              {curve.document} Rev {curve.revision}
            </span>
            <span className="text-slate-300">·</span>
            <span className="mono">curve {shortHash(curve.id, 22)}</span>
            <span className="text-slate-300">·</span>
            <span>approved by {curve.approved_by || "—"}</span>
            <span className="text-slate-300">·</span>
            <span className="mono">sha256 {shortHash(curve.sha256)}</span>
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
          <div className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2 py-1">
            <ScoreRing
              value={score.value}
              status={score.status}
              size={56}
              stroke={5}
              showLabel={false}
            />
            <div className="max-w-[150px]">
              <p className={cn("text-[8px] font-semibold uppercase tracking-[0.12em]", scoreColor.text)}>
                {scoreColor.label} · performance score
              </p>
              <p className="mt-0.5 text-[8px] leading-tight text-slate-500">
                indicator, not a safety assessment
              </p>
            </div>
          </div>
          <button
            type="button"
            className="btn-ghost !py-1.5 !px-2 text-[11px]"
            onClick={() => setDetailsOpen(true)}
          >
            <ArrowUpRightIcon className="h-3.5 w-3.5" /> Details
          </button>
          <button
            type="button"
            className="btn-ghost !py-1.5 !px-2 text-[11px]"
            onClick={() => setRawOpen(true)}
          >
            <DatabaseIcon className="h-3.5 w-3.5" /> Raw data
          </button>
          <Link
            to={`/startups/${startup.id}/compare`}
            className="btn-primary !py-1.5 !px-2 text-[11px]"
          >
            <CompareIcon className="h-3.5 w-3.5" /> Compare
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
        <Kpi
          dense
          label="Duration"
          value={`${fmt(analysis.duration.actual_min, 1)} min`}
          hint={`${startupTypeLabel(startup.startup_type)} design ${fmt(
            analysis.duration.design_min,
            1,
          )} min · ${fmtSigned(analysis.duration.delta_min, 1)} min`}
          icon={<GaugeIcon className="h-3.5 w-3.5" />}
        />
        <Kpi
          dense
          label="Design lag"
          value={
            analysis.lag.minutes === null ? "—" : `${fmtSigned(analysis.lag.minutes, 1)} min`
          }
          hint={analysis.lag.interpretation ?? "insufficient overlap"}
          tone={
            Math.abs(analysis.lag.minutes ?? 0) > 2
              ? (analysis.lag.minutes ?? 0) > 0
                ? statusTone("watch")
                : statusTone("early")
              : undefined
          }
        />
        <Kpi
          dense
          label="Watch deviations"
          value={fmt(watchViolations.length, 0)}
          hint="control-band or SOP excursions"
          tone={watchViolations.length ? statusTone("watch") : undefined}
        />
        <Kpi
          dense
          label="Abort-level"
          value={fmt(observedAbort.length, 0)}
          hint="observed, not a safety determination"
          tone={observedAbort.length ? statusTone("abort") : undefined}
        />
        <Kpi
          dense
          label="Telemetry"
          value={`${fmt(analysis.data_quality.coverage_pct, 1)}%`}
          hint={`${analysis.data_quality.gaps} gap(s) · ${analysis.data_quality.status}`}
          tone={coverageTone}
        />
      </div>

      <AdvisoryNotice compact />

      <div className="space-y-3">
        <Panel className="min-w-0 p-4">
          <div className="mb-2.5 flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="section-title mb-0.5">Signal vs approved design</p>
              <p className="text-[11px] text-slate-500">
                Dashed is the full approved expectation; the shaded band is the analytics tolerance,
                not a safety limit.
              </p>
            </div>
            <span className="mono rounded border border-slate-200 bg-white px-2 py-1 text-slate-600">
              {selected?.unit || "state"}
            </span>
          </div>

          <div className="mb-2.5 flex flex-wrap gap-1.5">
            {signals.map((signal) => {
              const hasViolation = analysis.violations.some((row) => row.signal === signal.key);
              const active = signal.key === selected?.key;
              return (
                <button
                  key={signal.key}
                  type="button"
                  onClick={() => setSignalKey(signal.key)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] transition-colors",
                    active
                      ? "border-cyan-300 bg-cyan-50 text-cyan-800"
                      : "border-slate-200 bg-slate-50 text-slate-500 hover:border-slate-300 hover:text-slate-700",
                  )}
                >
                  {signal.label}
                  {hasViolation && (
                    <span className="h-1.5 w-1.5 rounded-full bg-amber-500" title="Has an observation" />
                  )}
                </button>
              );
            })}
          </div>

          {selected ? (
            <>
              {selectedTracking && (
                <div className="mb-2.5 grid grid-cols-2 gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 sm:grid-cols-4">
                  <div>
                    <p className="text-[9px] uppercase tracking-wider text-slate-500">Within band</p>
                    <p className="mono mt-0.5 text-[12px] text-slate-800">
                      {fmt(selectedTracking.within_tolerance_pct, 1)}%
                    </p>
                  </div>
                  <div>
                    <p className="text-[9px] uppercase tracking-wider text-slate-500">RMSE</p>
                    <p className="mono mt-0.5 text-[12px] text-slate-800">
                      {fmt(selectedTracking.rmse, 2)}
                    </p>
                  </div>
                  <div>
                    <p className="text-[9px] uppercase tracking-wider text-slate-500">Mean bias</p>
                    <p className="mono mt-0.5 text-[12px] text-slate-800">
                      {fmtSigned(selectedTracking.mean_bias, 2)}
                    </p>
                  </div>
                  <div>
                    <p className="text-[9px] uppercase tracking-wider text-slate-500">Max abs</p>
                    <p className="mono mt-0.5 text-[12px] text-slate-800">
                      {fmt(selectedTracking.max_abs, 2)}
                      <span className="ml-1 text-[9px] text-slate-500">
                        @ {fmt(selectedTracking.max_abs_at_min, 1)} min
                      </span>
                    </p>
                  </div>
                </div>
              )}

              <SignalChart chart={chart} signal={selected} height={180} showMarkers />
              <div className="mt-2">
                <ChartLegend signal={selected} />
              </div>
              <div className="mt-2.5">
                <PhaseStrip
                  phases={chart.phases}
                  designEndMin={curve.design_duration_min}
                  analysisPhases={analysis.phases}
                />
              </div>
            </>
          ) : (
            <EmptyState title="No chart data" description="This startup has no stored series." />
          )}
        </Panel>

        <InsightCard
          startupId={startup.id}
          initial={insight}
          llmConfigured={detail.llm_configured}
          variant="summary"
        />

        {detailsOpen &&
          createPortal(
            <div className="fixed inset-0 z-50 flex justify-end">
              <button
                type="button"
                aria-label="Close details"
                onClick={() => setDetailsOpen(false)}
                className="absolute inset-0 cursor-default bg-slate-900/20 backdrop-blur-[1px]"
              />
              <aside className="relative flex h-full w-full max-w-md flex-col border-l border-slate-200 bg-white shadow-[-24px_0_60px_-30px_rgba(15,23,42,0.4)]">
                <header className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
                  <p className="section-title">Startup details</p>
                  <button
                    type="button"
                    className="rounded-lg border border-slate-200 bg-white p-1.5 text-slate-500 transition-colors hover:border-slate-300 hover:text-slate-800"
                    onClick={() => setDetailsOpen(false)}
                    aria-label="Close"
                  >
                    <XIcon className="h-4 w-4" />
                  </button>
                </header>
                <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3 scrollbar-thin">
                  <Panel className="p-4">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="section-title mb-0.5">Score composition</p>
                <p className="text-[10px] text-slate-500">Transparent weights, performance only.</p>
              </div>
              {score.status === "attention" && (
                <span className="chip border-rose-200 bg-rose-50 text-rose-700">capped at 45</span>
              )}
            </div>
            {Object.keys(score.components).length ? (
              <div className="mt-2.5 space-y-2">
                {Object.entries(score.components).map(([key, value]) => (
                  <Meter key={key} label={key} value={value} weight={score.weights[key]} />
                ))}
              </div>
            ) : (
              <p className="mt-2 text-xs text-slate-500">No components were produced.</p>
            )}
            <p className="mt-2 border-t border-slate-200 pt-2 text-[9px] leading-relaxed text-slate-500">
              {score.note}
            </p>
          </Panel>

          <Panel className="p-4">
            <p className="section-title mb-2">Ramp rates</p>
            {analysis.rates.length ? (
              <div className="space-y-1.5">
                {analysis.rates.map((rate, index) => (
                  <div
                    key={`${rate.track_phase}-${index}`}
                    className="rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1.5"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] capitalize text-slate-700">
                        {rate.track_phase.replace(/_/g, " ")}
                      </span>
                      <span
                        className={cn(
                          "chip !px-1.5 !py-0 !text-[9px]",
                          rate.exceeded
                            ? "border-amber-200 bg-amber-50 text-amber-700"
                            : "border-slate-300 bg-slate-100 text-slate-600",
                        )}
                      >
                        {rate.exceeded ? "over rate" : "within rate"}
                      </span>
                    </div>
                    <div className="mt-0.5 flex items-baseline justify-between gap-2 text-[9px]">
                      <span className="text-slate-500">
                        allowed {fmt(rate.allowed_per_min, 2)} bar/min
                      </span>
                      <span className="mono text-slate-700">
                        {fmt(rate.observed_max_per_min, 2)} @ {fmt(rate.observed_at_min, 1)} min
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-slate-500">No ramp-rate tracks were evaluated.</p>
            )}
          </Panel>
                </div>
              </aside>
            </div>,
            document.body,
          )}
      </div>

      <Panel className="overflow-hidden">
        <button
          type="button"
          className="flex w-full items-center justify-between gap-2 border-b border-slate-200 px-4 py-2.5 text-left"
          onClick={() => setDetailOpen((value) => !value)}
        >
          <div>
            <p className="section-title mb-0.5">Detailed evidence</p>
            <p className="text-[10px] text-slate-500">
              Deviations, timing, prerequisites, telemetry, abort evidence and limit audit.
            </p>
          </div>
          <span className="text-[10px] text-slate-500">
            {detailOpen ? "Hide" : "Show"}
          </span>
        </button>
        {detailOpen && (
          <>
            <div className="flex items-center gap-1 overflow-x-auto border-b border-slate-200 px-2 py-1.5 scrollbar-thin">
              {tabs.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setTab(item.key)}
              className={cn(
                "inline-flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11px] font-medium transition-colors",
                item.key === tab
                  ? "bg-cyan-50 text-cyan-800"
                  : "text-slate-500 hover:bg-slate-50 hover:text-slate-700",
              )}
            >
              {item.label}
              {item.count !== undefined && (
                <span
                  className={cn(
                    "rounded-full px-1.5 py-0 text-[9px]",
                    item.key === tab ? "bg-cyan-100 text-cyan-700" : "bg-slate-100 text-slate-500",
                  )}
                >
                  {item.count}
                </span>
              )}
            </button>
          ))}
          <span className="ml-auto hidden shrink-0 pr-2 text-[9px] text-slate-500 sm:inline">
            detailed evidence behind the summary above
          </span>
        </div>

        {tab === "deviations" && (
          <div>
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-2.5">
              <p className="text-[11px] text-slate-600">
                A violation is the negation of the approved condition. Every row cites the procedure.
              </p>
              <span className="text-[10px] text-slate-500">
                {watchViolations.length} watch · {abortViolations.length} abort
              </span>
            </div>
            <ViolationTable violations={analysis.violations} />
          </div>
        )}

        {tab === "timing" && (
          <div className="grid gap-0 divide-y divide-slate-200 md:grid-cols-2 md:divide-x md:divide-y-0">
            <div>
              <div className="border-b border-slate-200 px-4 py-2.5">
                <p className="section-title mb-0.5">Milestones</p>
                <p className="text-[10px] text-slate-500">
                  Actual crossings use a 3-sample hold to reject noise.
                </p>
              </div>
              {analysis.milestones.length ? (
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Milestone</th>
                      <th>Design</th>
                      <th>Actual</th>
                      <th>Delta</th>
                    </tr>
                  </thead>
                  <tbody>
                    {analysis.milestones.map((milestone) => (
                      <tr key={milestone.id}>
                        <td>
                          <span className="text-[12px] text-slate-700">{milestone.label}</span>
                          <p className="mono text-slate-500">{milestone.id}</p>
                        </td>
                        <td className="mono whitespace-nowrap text-slate-500">
                          {fmt(milestone.design_at_min, 1)} min
                        </td>
                        <td className="mono whitespace-nowrap text-slate-700">
                          {milestone.actual_at_min === null
                            ? "not reached"
                            : `${fmt(milestone.actual_at_min, 1)} min`}
                        </td>
                        <td>
                          <span
                            className={cn(
                              "mono",
                              milestone.status === "late"
                                ? "text-amber-700"
                                : milestone.status === "early"
                                  ? "text-sky-700"
                                  : "text-slate-600",
                            )}
                          >
                            {fmtSigned(milestone.delta_min, 1)} min
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <EmptyState title="No milestones" description="The curve defines no crossing milestones." />
              )}
            </div>
            <div>
              <div className="border-b border-slate-200 px-4 py-2.5">
                <p className="section-title mb-0.5">Phase alignment</p>
                <p className="text-[10px] text-slate-500">
                  {analysis.phases.length} phases · {latePhases ? `${latePhases} late` : "none late"}
                </p>
              </div>
              <div className="overflow-x-auto">
                <table className="data-table min-w-[520px]">
                  <thead>
                    <tr>
                      <th>Phase</th>
                      <th>Design</th>
                      <th>Actual start</th>
                      <th>Delta</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {analysis.phases.map((phase) => (
                      <tr key={phase.id}>
                        <td>
                          <p className="text-[12px] text-slate-700">{phase.label}</p>
                          <p className="mono text-slate-500">{phase.source_ref}</p>
                        </td>
                        <td className="mono whitespace-nowrap text-slate-500">
                          {fmt(phase.design_start_min, 1)} – {fmt(phase.design_end_min, 1)}
                        </td>
                        <td className="mono whitespace-nowrap text-slate-700">
                          {phase.actual_start_min === null
                            ? "—"
                            : `${fmt(phase.actual_start_min, 1)} min`}
                        </td>
                        <td className="mono whitespace-nowrap text-slate-700">
                          {fmtSigned(phase.delta_min, 1)} min
                        </td>
                        <td>
                          <Pill status={phase.status} dot />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {tab === "prerequisites" && (
          <div>
            <div className="border-b border-slate-200 px-4 py-2.5">
              <p className="section-title mb-0.5">Pre-start checks</p>
              <p className="text-[10px] text-slate-500">
                Verified from the 15 minutes before t=0. Manual attestations are never inferred.
              </p>
            </div>
            <div className="grid gap-0 divide-y divide-slate-200/70 md:grid-cols-2 md:divide-x md:divide-y-0">
              {analysis.prerequisites.map((prereq) => (
                <div key={prereq.id} className="px-4 py-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-[12px] text-slate-700">{prereq.label}</p>
                      <p className="mono mt-0.5 text-slate-500">
                        {prereq.id} · {prereq.source_ref}
                      </p>
                    </div>
                    <Pill status={prereq.status} dot />
                  </div>
                  <p className="mt-1 text-[10px] leading-relaxed text-slate-500">{prereq.detail}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === "telemetry" && (
          <div>
            <div className="border-b border-slate-200 px-4 py-2.5">
              <p className="section-title mb-0.5">Evidence quality</p>
              <p className="text-[10px] text-slate-500">
                Scores are suppressed below 80% coverage across required signals.
              </p>
            </div>
            <div className="grid gap-0 divide-y divide-slate-200 md:grid-cols-[260px_minmax(0,1fr)] md:divide-x md:divide-y-0">
              <div className="p-4">
                <div className="flex items-end justify-between gap-3">
                  <div>
                    <p className={cn("text-3xl font-semibold tabular-nums", coverageTone.text)}>
                      {fmt(analysis.data_quality.coverage_pct, 1)}%
                    </p>
                    <p className="mt-0.5 text-[10px] text-slate-500">
                      {analysis.data_quality.samples_expected} expected samples ·{" "}
                      {analysis.data_quality.gaps} gap(s)
                    </p>
                  </div>
                  <Pill status={analysis.data_quality.status} dot />
                </div>
                <p className="mt-2 text-[10px] text-slate-500">
                  span {fmt(analysis.data_quality.span_min, 1)} min
                </p>
                <p className="mt-2 border-t border-slate-200 pt-2 text-[10px] leading-relaxed text-slate-500">
                  {analysis.data_quality.detail}
                </p>
              </div>
              <div className="space-y-2 p-4">
                {Object.entries(analysis.data_quality.by_signal).map(([key, value]) => (
                  <div key={key}>
                    <div className="mb-0.5 flex items-center justify-between gap-2 text-[10px]">
                      <span className="text-slate-500">{signalLabels.get(key) ?? key}</span>
                      <span className="mono text-slate-600">{fmt(value, 1)}%</span>
                    </div>
                    <ProgressBar
                      value={value}
                      height="h-1"
                      tone={
                        value >= 95
                          ? statusTone("ok")
                          : value >= 80
                            ? statusTone("watch")
                            : statusTone("fail")
                      }
                    />
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {tab === "abort" && (
          <div>
            <div className="border-b border-slate-200 px-4 py-2.5">
              <p className="section-title mb-0.5">Abort evidence</p>
              <p className="text-[10px] text-slate-500">
                The platform reports observations against approved abort conditions. It does not
                command an abort and does not decide whether the boiler is safe.
              </p>
            </div>
            <div className="grid gap-0 divide-y divide-slate-200/70 md:grid-cols-2 md:divide-x md:divide-y-0">
              <div className="p-4">
                <div className="mb-2 flex items-center gap-2">
                  <AlertIcon className="h-3.5 w-3.5 text-rose-600" />
                  <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-600">
                    Observed threshold breaches
                  </p>
                </div>
                {observedAbort.length ? (
                  <div className="space-y-2">
                    {observedAbort.map((flag) => (
                      <div
                        key={flag.id}
                        className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2.5"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-[12px] font-medium text-rose-800">{flag.signal_label}</p>
                          <span className="mono text-[10px] text-rose-700">{flag.id}</span>
                        </div>
                        <p className="mt-1 text-[11px] leading-relaxed text-rose-900">
                          {flag.statement}
                        </p>
                        <div className="mt-1.5 flex flex-wrap items-center gap-2">
                          <EvidenceChips ids={flag.evidence_ref ? [flag.evidence_ref] : []} />
                          <span className="mono text-slate-500">{flag.source_ref}</span>
                          <span className="chip border-violet-200 bg-violet-50 !px-1.5 !py-0 !text-[9px] text-violet-700">
                            operator confirmation required
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-3 text-[11px] text-slate-500">
                    <CheckIcon className="h-4 w-4 text-emerald-600" />
                    No approved abort threshold was observed in the available telemetry.
                  </div>
                )}
              </div>
              <div className="p-4">
                <div className="mb-2 flex items-center gap-2">
                  <ShieldIcon className="h-3.5 w-3.5 text-violet-600" />
                  <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-600">
                    Requires operator evidence
                  </p>
                </div>
                <div className="space-y-2">
                  {manualAbort.map((flag) => (
                    <div
                      key={flag.id}
                      className="rounded-lg border border-violet-200 bg-violet-50 px-3 py-2.5"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-[12px] font-medium text-violet-800">{flag.signal_label}</p>
                        <span className="mono text-[10px] text-violet-700">{flag.id}</span>
                      </div>
                      <p className="mt-1 text-[11px] leading-relaxed text-slate-600">{flag.statement}</p>
                      <span className="mono mt-1 inline-block text-slate-500">{flag.source_ref}</span>
                    </div>
                  ))}
                  {!manualAbort.length && (
                    <p className="text-[11px] text-slate-500">
                      No manual criteria are defined for this curve.
                    </p>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {tab === "limits" && (
          <div>
            <div className="border-b border-slate-200 px-4 py-2.5">
              <p className="section-title mb-0.5">Limit audit</p>
              <p className="text-[10px] text-slate-500">
                Every threshold is transcribed from the approved procedure. Reporting tolerances are
                separate and are not limits.
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="data-table min-w-[760px]">
                <thead>
                  <tr>
                    <th>Signal</th>
                    <th>Approved condition</th>
                    <th>Severity</th>
                    <th>Violation window</th>
                    <th>Source</th>
                  </tr>
                </thead>
                <tbody>
                  {allLimits.map((limit) => (
                    <tr key={`${limit.signal}-${limit.key}`}>
                      <td>
                        <p className="text-[12px] text-slate-700">{limit.signal}</p>
                        <p className="mono text-slate-500">{limit.key}</p>
                      </td>
                      <td className="mono whitespace-nowrap text-slate-700">
                        {condition(
                          {
                            key: limit.key,
                            op: limit.op,
                            value: limit.value,
                            min: limit.min,
                            max: limit.max,
                            severity: limit.severity as "watch" | "abort",
                            label: limit.label,
                            active_from_min: null,
                            active_to_min: null,
                            hold_seconds: 0,
                            min_duration_min: 0,
                            source_ref: limit.source_ref,
                          },
                          limit.unit,
                        )}
                      </td>
                      <td>
                        <Pill status={limit.severity} dot />
                      </td>
                      <td className="whitespace-nowrap">
                        {limit.violation_count ? (
                          <span className="mono text-amber-700">
                            {limit.violation_count} · {fmt(limit.violation_minutes, 1)} min
                          </span>
                        ) : (
                          <span className="mono text-slate-500">held</span>
                        )}
                      </td>
                      <td>
                        <span className="mono text-slate-500">{limit.source_ref}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {tab === "events" && (
          <div className="grid gap-0 divide-y divide-slate-200 md:grid-cols-2 md:divide-x md:divide-y-0">
            <div className="p-4">
              <p className="section-title mb-2">Events from the pinned drawing</p>
              <div className="space-y-1.5">
                {(curve.events ?? []).map((event, index) => (
                  <div
                    key={`${event.name}-${index}`}
                    className="flex items-center justify-between gap-2 rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-[11px]"
                  >
                    <span className="truncate text-slate-700">{event.name ?? "event"}</span>
                    <span className="mono shrink-0 text-slate-500">
                      {event.t_min === undefined ? "—" : `${fmt(event.t_min, 1)} min`}
                    </span>
                  </div>
                ))}
                {!curve.events?.length && (
                  <p className="text-[11px] text-slate-500">No drawing events recorded.</p>
                )}
              </div>
            </div>
            <div className="p-4">
              <p className="section-title mb-2">Mill cut-in schedule</p>
              <div className="space-y-1.5">
                {(curve.mill_cut_in ?? []).map((mill, index) => (
                  <div
                    key={`${mill.mill}-${index}`}
                    className="flex items-center justify-between gap-2 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[11px]"
                  >
                    <span className="text-amber-800">Mill {mill.mill ?? "—"}</span>
                    <span className="mono text-amber-700">
                      {mill.t_min === undefined ? "—" : `${fmt(mill.t_min, 1)} min`}
                    </span>
                  </div>
                ))}
                {!curve.mill_cut_in?.length && (
                  <p className="text-[11px] text-slate-500">No mill schedule recorded.</p>
                )}
              </div>
            </div>
          </div>
        )}

        </>
        )}
      </Panel>

      <div className="flex flex-wrap items-center justify-between gap-3 text-[10px] text-slate-500">
        <InfoLine>
          Stored against curve {curve.id} · {curve.document} Rev {curve.revision}. The comparison does
          not rewrite history when a new curve version is approved.
        </InfoLine>
        <Link
          to={`/startups/${startup.id}/compare`}
          className="inline-flex items-center gap-1 text-slate-500 transition-colors hover:text-cyan-700"
        >
          Compare this run with the other startups <ChevronRightIcon className="h-3 w-3" />
        </Link>
      </div>

      <AdvisoryNotice compact />

      <RawDataDrawer
        open={rawOpen}
        onClose={() => setRawOpen(false)}
        title={`${startup.id} · ${startup.label}`}
        subtitle={`${curve.document} Rev ${curve.revision} · curve v${curve.version}`}
        tabs={rawTabs}
      />
    </div>
  );
}
