import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import {
  ArrowLeftIcon,
  ArrowUpRightIcon,
  ChartIcon,
  GaugeIcon,
  LayersIcon,
  ShieldIcon,
} from "../components/icons";
import {
  AdvisoryNotice,
  cn,
  EmptyState,
  ErrorNotice,
  InfoLine,
  Kpi,
  Loading,
  Panel,
  Pill,
  SectionHeading,
} from "../components/ui";
import { api } from "../lib/api";
import { fmt, fmtSigned, fmtDuration, shortHash } from "../lib/format";
import { CHART, scoreTone } from "../lib/theme";
import type {
  ChartSignal,
  ComparePayload,
  StartupDetail,
  StartupSummary,
} from "../lib/types";

interface CompareRow {
  t: number;
  target: number | null;
  design: number | null;
  median: number | null;
  p25: number | null;
  p75: number | null;
  range: number | null;
}

function sampleSeries(grid: number[], values: (number | null)[], t: number): number | null {
  if (!grid.length) return null;
  let bestIndex = -1;
  let bestDistance = Infinity;
  for (let index = 0; index < grid.length; index += 1) {
    const distance = Math.abs(grid[index] - t);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
    if (grid[index] > t && distance > bestDistance) break;
  }
  if (bestIndex < 0 || bestDistance > 1.01) return null;
  return values[bestIndex] ?? null;
}

function CompareTooltip({
  active,
  payload,
  signal,
}: {
  active?: boolean;
  payload?: { payload: CompareRow }[];
  signal: ChartSignal;
}) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  const unit = signal.unit ? ` ${signal.unit}` : "";
  const lines: { label: string; value: number | null; color: string }[] = [
    { label: "This startup", value: row.target, color: CHART.actual },
    { label: "Approved design", value: row.design, color: "#fbbf24" },
    { label: "Peer median", value: row.median, color: "#a78bfa" },
  ];
  return (
    <div className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-[11px] shadow-xl">
      <p className="mb-1 font-mono text-slate-600">t = {row.t.toFixed(1)} min</p>
      <div className="space-y-0.5">
        {lines.map((line) => (
          <p key={line.label} className="flex items-center justify-between gap-4">
            <span className="flex items-center gap-1.5 text-slate-600">
              <span className="h-0.5 w-3 rounded" style={{ background: line.color }} />
              {line.label}
            </span>
            <span className="font-mono text-slate-800">
              {fmt(line.value, signal.decimals)}
              {unit}
            </span>
          </p>
        ))}
        {row.p25 !== null && row.p75 !== null && (
          <p className="flex items-center justify-between gap-4 text-slate-500">
            <span>Peer P25 – P75</span>
            <span className="font-mono">
              {fmt(row.p25, signal.decimals)} – {fmt(row.p75, signal.decimals)}
            </span>
          </p>
        )}
      </div>
    </div>
  );
}

export function ComparePage() {
  const { startupId = "" } = useParams();
  const [detail, setDetail] = useState<StartupDetail | null>(null);
  const [comparison, setComparison] = useState<ComparePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [signalKey, setSignalKey] = useState("drum_pressure");

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setComparison(null);
    setError(null);
    Promise.all([api.startup(startupId), api.compare(startupId)])
      .then(([detailPayload, comparePayload]) => {
        if (cancelled) return;
        setDetail(detailPayload);
        setComparison(comparePayload);
        setSignalKey(
          detailPayload.chart.signals.drum_pressure
            ? "drum_pressure"
            : Object.keys(detailPayload.chart.signals)[0],
        );
      })
      .catch((caught) => {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : "Could not load the comparison");
        }
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

  const selected = detail?.chart.signals[signalKey] ?? signals[0];

  const rows = useMemo<CompareRow[]>(() => {
    if (!comparison || !detail || !selected) return [];
    const envelope = comparison.envelope[selected.key];
    const targetRun = comparison.runs.find((run) => run.id === comparison.target_id);
    const targetSeries = targetRun?.signals[selected.key] ?? [];
    const designGrid = detail.chart.grid;
    const designValues = detail.chart.signals[selected.key]?.expected ?? [];
    return comparison.grid.map((t, index) => {
      const p25 = envelope?.p25[index] ?? null;
      const p75 = envelope?.p75[index] ?? null;
      return {
        t,
        target: targetSeries[index] ?? null,
        design: sampleSeries(designGrid, designValues, t),
        median: envelope?.median[index] ?? null,
        p25,
        p75,
        range: p25 !== null && p75 !== null ? p75 - p25 : null,
      };
    });
  }, [comparison, detail, selected]);

  const peers = useMemo(() => {
    if (!comparison) return [];
    return comparison.table.filter((row) => row.id !== comparison.target_id);
  }, [comparison]);

  const stats = useMemo(() => {
    if (!comparison) return null;
    const targetRow = comparison.table.find((row) => row.id === comparison.target_id) ?? null;
    const peerDurations = peers
      .map((row) => row.duration_min)
      .filter((value): value is number => value !== null);
    const peerScores = peers.map((row) => row.score).filter((value): value is number => value !== null);
    const median = (values: number[]) => {
      if (!values.length) return null;
      const sorted = values.slice().sort((a, b) => a - b);
      const middle = Math.floor(sorted.length / 2);
      return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
    };
    const ranked = comparison.table
      .filter((row) => row.score !== null)
      .slice()
      .sort((a, b) => (b.score as number) - (a.score as number));
    const rank = targetRow?.score === null ? null : ranked.findIndex((row) => row.id === comparison.target_id) + 1;
    return {
      targetRow,
      peers: peers.length,
      peerMedianDuration: median(peerDurations),
      peerMedianScore: median(peerScores),
      rank: rank && rank > 0 ? rank : null,
      rankedCount: ranked.length,
    };
  }, [comparison, peers]);

  if (error) {
    return (
      <div className="space-y-4">
        <Link
          to={`/startups/${startupId}`}
          className="inline-flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-700"
        >
          <ArrowLeftIcon className="h-3.5 w-3.5" /> Startup detail
        </Link>
        <ErrorNotice message={error} onRetry={() => setReloadToken((token) => token + 1)} />
      </div>
    );
  }

  if (!detail || !comparison || !stats) return <Loading label="Building the historical comparison" />;

  const { startup, curve } = detail;
  const watchCount = startup.violations ?? 0;
  const durationDelta =
    startup.duration_min !== null && stats.peerMedianDuration !== null
      ? startup.duration_min - stats.peerMedianDuration
      : null;

  return (
    <div className="space-y-4">
      <div>
        <Link
          to={`/startups/${startup.id}`}
          className="inline-flex items-center gap-1.5 text-xs text-slate-500 transition-colors hover:text-slate-700"
        >
          <ArrowLeftIcon className="h-3.5 w-3.5" /> {startup.id} detail
        </Link>
      </div>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="section-title mb-1.5">Historical comparison</p>
          <h1 className="flex flex-wrap items-baseline gap-2 text-xl font-semibold tracking-tight text-slate-900">
            {startup.id}
            <span className="text-sm font-normal text-slate-500">against {stats.peers} peer startup(s)</span>
          </h1>
          <p className="mt-1 max-w-3xl text-sm text-slate-600">
            This run is aligned on its detected start and overlaid with the approved design and the
            median trajectory of earlier runs. The envelope is a distribution of past behaviour, not
            an operating limit.
          </p>
        </div>
        <Link to={`/startups/${startup.id}`} className="btn-ghost">
          <ArrowUpRightIcon className="h-4 w-4" /> Full comparison
        </Link>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi
          label="Peer startups"
          value={fmt(stats.peers, 0)}
          hint={`${curve.document} Rev ${curve.revision}`}
          icon={<LayersIcon className="h-4 w-4" />}
        />
        <Kpi
          label="Duration vs peers"
          value={durationDelta === null ? "—" : `${fmtSigned(durationDelta, 1)} min`}
          hint={`this run ${fmtDuration(startup.duration_min)} · peer median ${fmtDuration(
            stats.peerMedianDuration,
          )}`}
          tone={durationDelta !== null && durationDelta > 2 ? scoreTone(70) : undefined}
          icon={<GaugeIcon className="h-4 w-4" />}
        />
        <Kpi
          label="Score vs peers"
          value={startup.score === null ? "—" : startup.score.toFixed(1)}
          hint={
            stats.peerMedianScore === null
              ? "no peer scores available"
              : `peer median ${stats.peerMedianScore.toFixed(1)} · ${
                  stats.rank ? `rank ${stats.rank} of ${stats.rankedCount}` : "not ranked"
                }`
          }
          tone={scoreTone(startup.score, startup.score_status)}
          icon={<ChartIcon className="h-4 w-4" />}
        />
        <Kpi
          label="Observations"
          value={fmt(watchCount, 0)}
          hint={`${startup.abort_observations} abort-level observation(s)`}
          tone={watchCount ? scoreTone(null, "attention") : undefined}
          icon={<ShieldIcon className="h-4 w-4" />}
        />
      </div>

      <Panel className="p-4">
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="section-title mb-1">{selected?.label ?? "Signal"} · peer envelope</p>
            <p className="text-xs text-slate-500">
              Solid cyan is this startup, dashed amber is the approved design, violet is the peer
              median and the shaded ribbon is the P25–P75 range from{" "}
              {comparison.peer_count === 1 ? "1 earlier run" : `${comparison.peer_count} earlier runs`}.
            </p>
          </div>
          <span className="mono rounded border border-slate-200 bg-white px-2 py-1 text-slate-600">
            {selected?.unit || "state"}
          </span>
        </div>

        <div className="mb-3 flex flex-wrap gap-1.5">
          {signals.map((signal) => {
            const active = signal.key === selected?.key;
            return (
              <button
                key={signal.key}
                type="button"
                onClick={() => setSignalKey(signal.key)}
                className={cn(
                  "rounded-md border px-2 py-1 text-[11px] transition-colors",
                  active
                    ? "border-cyan-300 bg-cyan-50 text-cyan-800"
                    : "border-slate-200 bg-slate-50 text-slate-500 hover:border-slate-300 hover:text-slate-700",
                )}
              >
                {signal.label}
              </button>
            );
          })}
        </div>

        {selected ? (
          <div className="h-[380px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={rows} margin={{ top: 12, right: 18, bottom: 2, left: -6 }}>
                <CartesianGrid stroke={CHART.grid} strokeDasharray="2 4" vertical={false} />
                {detail.chart.phases.map((phase, index) => (
                  <ReferenceArea
                    key={phase.key}
                    x1={Math.max(phase.start_min, comparison.start_min)}
                    x2={Math.min(phase.end_min, comparison.end_min)}
                    fill={index % 2 === 0 ? "#0ea5e9" : "#8b5cf6"}
                    fillOpacity={0.05}
                    stroke="none"
                  />
                ))}
                <Area
                  dataKey="p25"
                  stackId="envelope"
                  stroke="none"
                  fill="transparent"
                  isAnimationActive={false}
                  connectNulls={false}
                />
                <Area
                  dataKey="range"
                  stackId="envelope"
                  stroke="none"
                  fill="#8b5cf6"
                  fillOpacity={0.12}
                  isAnimationActive={false}
                  connectNulls={false}
                />
                <XAxis
                  dataKey="t"
                  type="number"
                  domain={[comparison.start_min, comparison.end_min]}
                  tickCount={9}
                  tick={{ fill: CHART.axis, fontSize: 10 }}
                  axisLine={{ stroke: CHART.grid }}
                  tickLine={{ stroke: CHART.grid }}
                  tickFormatter={(value: number) => `${Math.round(value)}`}
                  minTickGap={18}
                />
                <YAxis
                  domain={selected.kind === "state" ? [0, 1] : ["auto", "auto"]}
                  ticks={selected.kind === "state" ? [0, 1] : undefined}
                  tick={{ fill: CHART.axis, fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                  width={44}
                  tickFormatter={(value: number) =>
                    selected.kind === "state" ? (value >= 0.5 ? "on" : "off") : `${Number(value.toFixed(1))}`
                  }
                />
                <Tooltip
                  content={<CompareTooltip signal={selected} />}
                  cursor={{ stroke: "#94a3b8", strokeDasharray: "3 3" }}
                  wrapperStyle={{ outline: "none" }}
                />
                <Line
                  type="monotone"
                  dataKey="median"
                  stroke="#8b5cf6"
                  strokeWidth={1.2}
                  strokeDasharray="2 3"
                  dot={false}
                  isAnimationActive={false}
                  connectNulls={false}
                />
                <Line
                  type="monotone"
                  dataKey="design"
                  stroke="#d97706"
                  strokeWidth={1.4}
                  strokeDasharray="6 4"
                  dot={false}
                  isAnimationActive={false}
                  connectNulls
                />
                <Line
                  type={selected.kind === "state" ? "stepAfter" : "monotone"}
                  dataKey="target"
                  stroke={CHART.actual}
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                  connectNulls={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <EmptyState title="No comparable signal" description="The curve defines no signals." />
        )}

        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[10px] text-slate-500">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-0.5 w-4 rounded" style={{ background: CHART.actual }} />
            This startup
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-0.5 w-4 rounded border-t border-dashed border-amber-400" />
            Approved design
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-0.5 w-4 rounded" style={{ background: "#a78bfa" }} />
            Peer median
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-4 rounded-sm" style={{ background: "#a78bfa24" }} />
            Peer P25–P75
          </span>
          <span className="text-slate-500">x-axis: minutes from detected start</span>
        </div>
      </Panel>

      <Panel className="overflow-hidden">
        <div className="border-b border-slate-200 px-4 py-3">
          <SectionHeading
            eyebrow="Runs"
            title="Startup table"
            description="The comparison aligns each run on its detected start. A lower score means more deviation from the approved curve that run, not a lower safety level."
            action={
              <span className="text-[10px] text-slate-500">
                {comparison.table.length} run(s) · pinned curve versions
              </span>
            }
          />
        </div>
        <div className="overflow-x-auto">
          <table className="data-table min-w-[880px]">
            <thead>
              <tr>
                <th>Startup</th>
                <th>Status</th>
                <th>Duration</th>
                <th>Score</th>
                <th>Design lag</th>
                <th>Observations</th>
                <th>Top deviation</th>
                <th aria-label="Open" />
              </tr>
            </thead>
            <tbody>
              {comparison.table.map((run) => (
                <RunRow key={run.id} run={run} isTarget={run.id === comparison.target_id} />
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <div className="grid gap-4 md:grid-cols-2">
        <Panel className="p-4">
          <p className="section-title mb-2">How to read this comparison</p>
          <ul className="space-y-1.5 text-[11px] leading-relaxed text-slate-600">
            <li>· The peer envelope summarises how earlier runs behaved. It is descriptive, not a limit.</li>
            <li>· The approved design is the dashed amber line from the pinned curve version.</li>
            <li>· Diverging from the peer median is not itself a deviation from the approved procedure.</li>
            <li>· Analytics quantify differences; they do not assess whether the plant was safe.</li>
          </ul>
        </Panel>
        <Panel className="p-4">
          <p className="section-title mb-2">Provenance</p>
          <dl className="space-y-1.5 text-[11px] text-slate-600">
            <div className="flex justify-between gap-3">
              <dt className="text-slate-500">Curve pinned to this run</dt>
              <dd className="mono text-right">{shortHash(curve.id, 22)}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-slate-500">Document / revision</dt>
              <dd className="text-right">
                {curve.document} Rev {curve.revision}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-slate-500">Approved by</dt>
              <dd className="text-right">{curve.approved_by || "—"}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-slate-500">Curve hash</dt>
              <dd className="mono text-right">{shortHash(curve.sha256, 16)}</dd>
            </div>
          </dl>
          <div className="mt-3">
            <InfoLine>
              Re-approving the procedure creates a new curve version. This run keeps the version it
              was recorded against.
            </InfoLine>
          </div>
        </Panel>
      </div>

      <AdvisoryNotice />
    </div>
  );
}

function RunRow({ run, isTarget }: { run: StartupSummary; isTarget: boolean }) {
  const tone = scoreTone(run.score, run.score_status);
  return (
    <tr className={cn(isTarget && "bg-cyan-50")}>
      <td>
        <Link to={`/startups/${run.id}`} className="group block">
          <div className="flex items-center gap-2">
            <span className="font-medium text-slate-800 group-hover:text-cyan-800">{run.id}</span>
            {isTarget && (
              <span className="chip border-cyan-200 bg-cyan-50 !px-1.5 !py-0 !text-[9px] text-cyan-700">
                this run
              </span>
            )}
          </div>
          <p className="mt-0.5 max-w-[220px] truncate text-[11px] text-slate-500">{run.label}</p>
        </Link>
      </td>
      <td>
        <Pill status={run.status} dot />
      </td>
      <td>
        <p className="text-[12px] tabular-nums text-slate-700">{fmt(run.duration_min, 1)} min</p>
        <p className="text-[10px] text-slate-500">design {fmt(run.design_duration_min, 0)} min</p>
      </td>
      <td>
        <span className={cn("text-sm font-semibold tabular-nums", tone.text)}>
          {run.score === null ? "—" : run.score.toFixed(1)}
        </span>
        <p className="text-[9px] uppercase tracking-wider text-slate-500">
          {run.score_status?.replace(/_/g, " ")}
        </p>
      </td>
      <td className="mono whitespace-nowrap text-slate-600">{fmtSigned(run.lag_minutes, 1)} min</td>
      <td>
        <div className="flex flex-wrap gap-1">
          <span className="chip border-amber-200 bg-amber-50 !px-1.5 !py-0 !text-[9px] text-amber-700">
            {run.violations} watch
          </span>
          {run.abort_observations > 0 && (
            <span className="chip border-rose-200 bg-rose-50 !px-1.5 !py-0 !text-[9px] text-rose-700">
              {run.abort_observations} abort
            </span>
          )}
        </div>
      </td>
      <td className="max-w-[240px]">
        <p className="truncate text-[10px] text-slate-500" title={run.top_deviation ?? undefined}>
          {run.top_deviation ?? "—"}
        </p>
      </td>
      <td className="text-right">
        <Link
          to={`/startups/${run.id}`}
          className="inline-flex rounded-md p-1 text-slate-500 transition-colors hover:text-cyan-700"
          aria-label={`Open ${run.id}`}
        >
          <ArrowUpRightIcon className="h-4 w-4" />
        </Link>
      </td>
    </tr>
  );
}
