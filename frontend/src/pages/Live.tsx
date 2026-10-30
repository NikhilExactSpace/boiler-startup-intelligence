import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";

import { EventFeed } from "../components/EventFeed";
import { InsightCard } from "../components/InsightCard";
import { PhaseStrip } from "../components/PhaseStrip";
import { RawDataDrawer, type RawTab } from "../components/RawDataDrawer";
import { ChartLegend, SignalChart } from "../components/SignalChart";
import {
  ActivityIcon,
  ArrowUpRightIcon,
  BoltIcon,
  CheckIcon,
  ClockIcon,
  DatabaseIcon,
  GaugeIcon,
  PlayIcon,
  RefreshIcon,
  ShieldIcon,
  SparklesIcon,
  XIcon,
} from "../components/icons";
import {
  AdvisoryNotice,
  cn,
  EmptyState,
  ErrorNotice,
  Kpi,
  Loading,
  Meter,
  Panel,
  Pill,
  ProgressBar,
  ScoreRing,
} from "../components/ui";
import { api } from "../lib/api";
import { useBoiler } from "../lib/boiler";
import { fmt, fmtSigned } from "../lib/format";
import { scoreTone, statusTone } from "../lib/theme";
import type { InsightRecord } from "../lib/types";
import { useLive } from "../lib/useLive";

const STATE_LABEL: Record<string, string> = {
  watching: "Watching for detection",
  starting: "Startup detected",
  complete: "Startup complete",
  unavailable: "Unavailable",
};

function comparisonTone(inBand: boolean | null | undefined) {
  if (inBand === true) return statusTone("ok");
  if (inBand === false) return statusTone("watch");
  return statusTone("unknown");
}

export function LivePage() {
  const { boilerId, boiler } = useBoiler();
  const [rawOpen, setRawOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [insight, setInsight] = useState<InsightRecord | null>(null);
  const [signalKey, setSignalKey] = useState("drum_pressure");
  const [startupType, setStartupType] = useState("auto");
  const [focusMin, setFocusMin] = useState<number | null>(null);
  const { snapshot, error, connected, restarting, restart, retry } = useLive(
    boilerId,
    startupType,
  );

  const startupId = snapshot?.startup?.id ?? null;
  const stored = Boolean(snapshot?.startup?.stored);

  useEffect(() => {
    if (!startupId || !stored) {
      setInsight(null);
      return;
    }
    let cancelled = false;
    api
      .insight(startupId)
      .then((response) => {
        if (!cancelled) setInsight(response.record);
      })
      .catch(() => {
        if (!cancelled) setInsight(null);
      });
    return () => {
      cancelled = true;
    };
  }, [startupId, stored]);

  if (error && !snapshot) {
    return (
      <div className="space-y-4">
        <div>
          <p className="section-title mb-1.5">Live comparison</p>
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">Live startup</h1>
        </div>
        <ErrorNotice
          message={`${error}. The backend may still be starting; retry in a moment.`}
          onRetry={retry}
        />
      </div>
    );
  }

  if (!snapshot) {
    return <Loading label="Connecting to the live startup feed" />;
  }

  if (snapshot.state === "unavailable") {
    return (
      <div className="space-y-4">
        <div>
          <p className="section-title mb-1.5">Live comparison</p>
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">Live startup</h1>
        </div>
        <Panel className="p-5">
          <EmptyState
            icon={<BoltIcon className="h-4 w-4" />}
            title="Live polling is not enabled"
            description={snapshot.note ?? "Set KAIROS_MODE=mock for the accelerated demo."}
          />
        </Panel>
      </div>
    );
  }

  const analysis = snapshot.analysis;
  const score = analysis?.score;
  const detection = snapshot.detection;
  const chart = snapshot.chart;
  const pressure =
    chart?.signals?.[signalKey] ??
    chart?.signals?.drum_pressure ??
    Object.values(chart?.signals ?? {})[0];
  const startup = snapshot.startup;
  const stateTone = statusTone(snapshot.state);
  const tone = scoreTone(score?.value ?? null, score?.status);
  const progress = snapshot.progress_pct ?? 0;
  const values = snapshot.last_values ?? {};
  const valueEntries = Object.entries(values)
    .filter(([, value]) => value.value !== null)
    .sort(
      ([a], [b]) =>
        (chart?.signals[a]?.chart_order ?? 99) - (chart?.signals[b]?.chart_order ?? 99),
    );

  const lastActualIndex = pressure
    ? pressure.actual.reduce<number>((acc, value, index) => (value !== null ? index : acc), -1)
    : -1;
  const nowMin =
    lastActualIndex >= 0 && chart
      ? chart.grid[lastActualIndex]
      : (snapshot.now_min ?? undefined);
  const nowValue = lastActualIndex >= 0 && pressure ? pressure.actual[lastActualIndex] : null;
  const displayChart = chart;
  const displayPressure = displayChart?.signals?.[pressure?.key ?? signalKey] ?? pressure;

  const rawEventItems = snapshot.curve?.live_highlights?.length
    ? snapshot.curve.live_highlights
    : [
        ...(snapshot.curve?.events ?? []).map((event) => ({
          t_min: event.t_min ?? 0,
          title: event.name ?? "event",
          detail: "Drawing event",
          kind: "event",
          importance: "medium",
        })),
        ...(snapshot.curve?.mill_cut_in ?? []).map((mill) => ({
          t_min: mill.t_min ?? 0,
          title: `Mill ${mill.mill ?? "—"}`,
          detail: "Mill cut-in",
          kind: "mill",
          importance: "medium",
        })),
      ];
  const eventMarkers = (
    rawEventItems.length
      ? rawEventItems
      : (chart?.phases ?? []).map((phase) => ({
          t_min: phase.start_min,
          title: phase.label,
          detail: "Design phase",
          kind: "phase",
          importance: "medium",
        }))
  )
    .filter((item) => Number.isFinite(item.t_min))
    .sort((a, b) => a.t_min - b.t_min)
    .map((item) => ({
      t_min: item.t_min,
      label: item.title,
      detail: item.detail,
      kind: item.kind,
      importance: item.importance,
    }));
  const nextEvent = eventMarkers.find((item) => item.t_min > (nowMin ?? 0));

  const livePressure = values[pressure?.key ?? signalKey];
  const pressureDecimals = pressure?.decimals ?? 1;
  const pressureBand = comparisonTone(livePressure?.in_band);
  const watchCount = analysis?.violations.filter((row) => row.severity === "watch").length ?? 0;
  const abortCount = analysis?.violations.filter((row) => row.severity === "abort").length ?? 0;

  const rawTabs: RawTab[] = [];
  if (valueEntries.length) {
    rawTabs.push({
      key: "signals",
      label: "Signals",
      kind: "table",
      note: "Current sample, the approved design value at the same timestamp, and the delta.",
      columns: [
        { key: "signal", label: "Signal" },
        { key: "actual", label: "Actual", align: "right", mono: true },
        { key: "design", label: "Approved design", align: "right", mono: true },
        { key: "delta", label: "Delta", align: "right", mono: true },
        { key: "band", label: "Reporting band", align: "right" },
        { key: "at", label: "Sample t", align: "right", mono: true },
      ],
      rows: valueEntries.map(([, value]) => {
        const decimals = value.decimals ?? 1;
        return {
          signal: value.label,
          actual: value.value === null ? "—" : `${fmt(value.value, decimals)} ${value.unit}`,
          design:
            value.expected === null || value.expected === undefined
              ? "—"
              : `${fmt(value.expected, decimals)} ${value.unit}`,
          delta:
            value.delta === null || value.delta === undefined
              ? "—"
              : `${fmtSigned(value.delta, decimals)} ${value.unit}`,
          band:
            value.in_band === null || value.in_band === undefined
              ? "—"
              : value.in_band
                ? "in band"
                : "outside",
          at: value.t_min === null || value.t_min === undefined ? "—" : `${fmt(value.t_min, 1)} min`,
        };
      }),
    });
  }
  if (analysis) {
    rawTabs.push({ key: "analysis", label: "Analysis", kind: "json", data: analysis });
  }
  if (chart) {
    rawTabs.push({ key: "chart", label: "Chart", kind: "json", data: chart });
  }
  const {
    chart: _chart,
    analysis: _analysis,
    ...snapshotRest
  } = snapshot;
  rawTabs.push({ key: "snapshot", label: "Snapshot", kind: "json", data: snapshotRest });
  if (insight) {
    rawTabs.push({ key: "insight", label: "Insight", kind: "json", data: insight });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <p className="section-title">Live comparison</p>
            <Pill tone={stateTone} dot>
              {STATE_LABEL[snapshot.state] ?? snapshot.state}
            </Pill>
            <div className="flex rounded-md border border-slate-200 bg-slate-50 p-0.5 text-[10px]">
              {(["auto", "cold", "warm", "hot"] as const).map((type) => {
                const enabled =
                  type === "auto" ? true : (boiler?.startup_types?.[type]?.enabled ?? true);
                return (
                  <button
                    key={type}
                    type="button"
                    disabled={!enabled}
                    onClick={() => setStartupType(type)}
                    className={cn(
                      "rounded px-2 py-0.5 capitalize transition-colors disabled:opacity-40",
                      startupType === type
                        ? "bg-white text-cyan-800 shadow-sm"
                        : "text-slate-500 hover:text-slate-700",
                    )}
                  >
                    {type}
                  </button>
                );
              })}
            </div>
            {connected ? (
              <span className="inline-flex items-center gap-1.5 text-[10px] text-slate-500">
                <span className="relative flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-cyan-500 opacity-60" />
                  <span className="relative h-1.5 w-1.5 rounded-full bg-cyan-500" />
                </span>
                streaming
              </span>
            ) : (
              <span className="text-[10px] text-amber-600">polling fallback</span>
            )}
          </div>
          <h1 className="mt-1 flex flex-wrap items-baseline gap-2 text-xl font-semibold tracking-tight text-slate-900">
            Live startup
            <span className="text-sm font-normal text-slate-500">
              {boiler?.name ?? boilerId} · {snapshot.curve?.document} Rev{" "}
              {snapshot.curve?.revision} · v{boiler?.curve?.version ?? "—"}
            </span>
            {snapshot.classification && (
              <span className="text-[10px] text-slate-500">
                {snapshot.classification.hours_since_shutdown === null ||
                snapshot.classification.hours_since_shutdown === undefined
                  ? "no previous shutdown recorded"
                  : `${fmt(snapshot.classification.hours_since_shutdown, 1)}h since last shutdown`}
              </span>
            )}
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="btn-ghost !py-1.5 text-xs"
            onClick={() => setDetailsOpen(true)}
          >
            <ArrowUpRightIcon className="h-3.5 w-3.5" /> Details
          </button>
          <button type="button" className="btn-ghost !py-1.5 text-xs" onClick={() => setRawOpen(true)}>
            <DatabaseIcon className="h-3.5 w-3.5" /> Raw data
          </button>
          <button
            type="button"
            className="btn-ghost !py-1.5 text-xs"
            onClick={() => void restart()}
            disabled={restarting}
          >
            <RefreshIcon className={cn("h-3.5 w-3.5", restarting && "animate-spin")} />
            {restarting ? "Restarting…" : "Restart replay"}
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-cyan-200 bg-cyan-50 px-3 py-1.5 text-[10.5px] text-cyan-700">
        <BoltIcon className="h-3.5 w-3.5 shrink-0 text-cyan-600" />
        <span className="min-w-0">{snapshot.note}</span>
        <span className="mono rounded border border-cyan-200 bg-white/60 px-1.5 py-0.5 text-[10px]">
          {snapshot.time_scale}× replay
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>
            detected{" "}
            <span className="mono text-cyan-800">
              {detection?.at_min === null || detection?.at_min === undefined
                ? "—"
                : `t=${fmt(detection.at_min, 1)}`}
            </span>
          </span>
          <span>
            latency{" "}
            <span className="mono text-cyan-800">
              {detection?.latency_min === null || detection?.latency_min === undefined
                ? "—"
                : `${fmt(detection.latency_min, 1)} min`}
            </span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-1 w-16 overflow-hidden rounded-full bg-cyan-200">
              <span
                className="block h-full rounded-full bg-cyan-600 transition-[width] duration-500"
                style={{ width: `${Math.max(0, Math.min(100, progress))}%` }}
              />
            </span>
            <span className="mono text-cyan-800">{fmt(progress, 0)}%</span>
          </span>
        </div>
      </div>

      {snapshot.state === "complete" && startup && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3.5 py-2">
          <div className="flex items-center gap-2.5">
            <span className="flex h-7 w-7 items-center justify-center rounded-full border border-emerald-200 bg-white text-emerald-700">
              <CheckIcon className="h-3.5 w-3.5" />
            </span>
            <div>
              <p className="text-xs font-medium text-emerald-800">
                {startup.id} stored against curve v{boiler?.curve?.version ?? "—"}
              </p>
              <p className="text-[10px] text-emerald-700">
                Analytics finished. The stored run keeps the curve that was active when it started.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Link to={`/startups/${startup.id}`} className="btn-primary !py-1.5 text-xs">
              Open startup detail <ArrowUpRightIcon className="h-3.5 w-3.5" />
            </Link>
            <button
              type="button"
              className="btn-ghost !py-1.5 text-xs"
              onClick={() => void restart()}
              disabled={restarting}
            >
              <PlayIcon className="h-3.5 w-3.5" /> Run another
            </button>
          </div>
        </div>
      )}

      {error && <ErrorNotice message={error} onRetry={retry} />}

      <div className="space-y-3">
        <div className="min-w-0 space-y-3">
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
            <Kpi
              dense
              label="Startup"
              value={startup?.id ?? "—"}
              hint={
                startup
                  ? `${startup.startup_type ?? snapshot.startup_type ?? startupType} · ${stored ? "stored" : "in progress"}`
                  : "detection arms the run"
              }
              icon={<BoltIcon className="h-3.5 w-3.5" />}
            />
            <Kpi
              dense
              label="Replay"
              value={`${fmt(progress, 0)}%`}
              hint={`${fmt(snapshot.sim_minutes, 1)} / ${fmt(snapshot.actual_duration_min, 1)} min`}
              icon={<ClockIcon className="h-3.5 w-3.5" />}
            />
            <Kpi
              dense
              label="Performance"
              value={
                score?.value === null || score?.value === undefined
                  ? "—"
                  : score.value.toFixed(1)
              }
              hint={score?.value === null ? score?.note ?? "withheld until detection" : scoreLabel(score?.status)}
              tone={tone}
              icon={<GaugeIcon className="h-3.5 w-3.5" />}
            />
            <Kpi
              dense
              label="Design lag"
              value={
                analysis?.lag.minutes === null || analysis?.lag.minutes === undefined
                  ? "—"
                  : `${fmtSigned(analysis.lag.minutes, 1)} min`
              }
              hint={analysis?.lag.interpretation ?? "insufficient overlap"}
              icon={<ActivityIcon className="h-3.5 w-3.5" />}
            />
            <Kpi
              dense
              label="Deviations"
              value={`${watchCount} watch`}
              hint={`${abortCount} abort-level observation(s)`}
              tone={watchCount || abortCount ? statusTone(watchCount ? "watch" : "abort") : undefined}
              icon={<ShieldIcon className="h-3.5 w-3.5" />}
            />
          </div>

          <Panel className="min-w-0 p-4">
            <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className="section-title mb-0.5">
                  {pressure?.label ?? "Signal"} vs approved design
                </p>
                <p className="text-[11px] text-slate-500">
                  Actual telemetry (solid) against the full approved design (dashed). The shaded
                  band is the analytics tolerance.
                </p>
              </div>
              <span className="mono rounded border border-slate-200 bg-white px-2 py-1 text-slate-600">
                {pressure?.unit ?? "barg"}
              </span>
            </div>

            {displayChart && displayPressure ? (
              <>
                <div className="mb-2 flex flex-wrap gap-1.5">
                  {Object.values(displayChart.signals)
                    .sort((a, b) => a.chart_order - b.chart_order)
                    .map((option) => {
                      const active = option.key === pressure?.key;
                      const hasViolation =
                        analysis?.violations.some((row) => row.signal === option.key) ?? false;
                      return (
                        <button
                          key={option.key}
                          type="button"
                          onClick={() => setSignalKey(option.key)}
                          className={cn(
                            "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[10px] transition-colors",
                            active
                              ? "border-cyan-300 bg-cyan-50 text-cyan-800"
                              : "border-slate-200 bg-slate-50 text-slate-500 hover:border-slate-300 hover:text-slate-700",
                          )}
                        >
                          {option.label}
                          {hasViolation && (
                            <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                          )}
                        </button>
                      );
                    })}
                </div>

                <div className="mb-3 grid grid-cols-3 gap-2">
                  <div className="rounded-lg border border-cyan-200 bg-cyan-50 px-2.5 py-1.5">
                    <p className="text-[9px] font-semibold uppercase tracking-[0.14em] text-cyan-700">
                      Actual now
                    </p>
                    <p className="mono mt-0.5 text-sm text-cyan-900">
                      {fmt(livePressure?.value ?? nowValue, pressureDecimals)}{" "}
                      <span className="text-[10px] text-cyan-700">{displayPressure?.unit ?? "barg"}</span>
                    </p>
                  </div>
                  <div className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5">
                    <p className="text-[9px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                      Approved design
                    </p>
                    <p className="mono mt-0.5 text-sm text-slate-700">
                      {fmt(livePressure?.expected, pressureDecimals)}{" "}
                      <span className="text-[10px] text-slate-500">{displayPressure?.unit ?? "barg"}</span>
                    </p>
                  </div>
                  <div className={cn("rounded-lg border px-2.5 py-1.5", pressureBand.border, pressureBand.bg)}>
                    <p className={cn("text-[9px] font-semibold uppercase tracking-[0.14em]", pressureBand.text)}>
                      Delta
                    </p>
                    <p className={cn("mono mt-0.5 text-sm", pressureBand.text)}>
                      {fmtSigned(livePressure?.delta, pressureDecimals)}{" "}
                      <span className="text-[10px]">
                        {livePressure?.in_band === null || livePressure?.in_band === undefined
                          ? "no tolerance"
                          : livePressure.in_band
                            ? "in band"
                            : "outside band"}
                      </span>
                    </p>
                  </div>
                </div>

                {eventMarkers.length > 0 && (
                  <div className="mb-2">
                    {nextEvent ? (
                      <div className="mb-1.5 flex flex-wrap items-center gap-2 rounded-md border border-cyan-200 bg-cyan-50 px-2 py-1 text-[10px] text-cyan-800">
                        <span className="font-semibold uppercase tracking-[0.12em]">
                          Next recommendation
                        </span>
                        <span className="font-medium">{nextEvent.label}</span>
                        <span className="mono">
                          t={fmt(nextEvent.t_min, 1)} min · in{" "}
                          {fmt(Math.max(0, nextEvent.t_min - (nowMin ?? 0)), 1)} min
                        </span>
                      </div>
                    ) : (
                      <div className="mb-1.5 rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-[10px] text-slate-500">
                        All drawing events have passed.
                      </div>
                    )}
                  </div>
                )}

                <SignalChart
                  chart={displayChart}
                  signal={displayPressure}
                  height={180}
                  showMarkers
                  showActualDots
                  nowMin={nowMin}
                  nowValue={nowValue}
                  eventMarkers={eventMarkers}
                  focusMin={focusMin}
                />
                <div className="mt-2">
                  <ChartLegend signal={displayPressure} />
                </div>
                <div className="mt-3">
                  <PhaseStrip
                    phases={displayChart?.phases ?? chart?.phases ?? []}
                    designEndMin={
                      snapshot.curve?.design_duration_min ??
                      displayChart?.phases?.at(-1)?.end_min ??
                      0
                    }
                    analysisPhases={analysis?.phases}
                  />
                </div>
              </>
            ) : (
              <EmptyState
                icon={<ActivityIcon className="h-4 w-4" />}
                title="Waiting for the historian"
                description="The chart appears as soon as the replay produces samples."
              />
            )}
          </Panel>

          {eventMarkers.length > 0 && (
            <Panel className="p-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="section-title mb-0.5">Recommendations from the design</p>
                  <p className="text-[10px] text-slate-500">
                    Events and mill cut-ins in drawing order · current position{" "}
                    {fmt(nowMin ?? 0, 1)} min
                  </p>
                </div>
                <span className="text-[10px] text-slate-500">
                  {eventMarkers.filter((item) => item.t_min <= (nowMin ?? 0)).length} done ·{" "}
                  {eventMarkers.filter((item) => item.t_min > (nowMin ?? 0)).length} upcoming
                </span>
              </div>
              <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
                {eventMarkers.map((item, index) => {
                  const done = item.t_min <= (nowMin ?? 0);
                  const isNext = item === nextEvent;
                  return (
                    <button
                      key={`rec-${item.label}-${index}`}
                      type="button"
                      onClick={() => setFocusMin(item.t_min)}
                      className={cn(
                        "rounded-lg border px-2.5 py-2 text-left transition-colors",
                        isNext
                          ? "border-cyan-300 bg-cyan-50"
                          : done
                            ? "border-slate-200 bg-slate-50 opacity-70"
                            : "border-slate-200 bg-white hover:border-slate-300",
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="mono text-[9px] text-slate-500">
                          {index + 1} · {fmt(item.t_min, 1)} min
                        </span>
                        <span
                          className={cn(
                            "rounded px-1 py-0.5 text-[8px] font-medium uppercase tracking-wider",
                            isNext
                              ? "bg-cyan-100 text-cyan-800"
                              : done
                                ? "bg-slate-200 text-slate-600"
                                : "bg-slate-100 text-slate-500",
                          )}
                        >
                          {isNext ? "next" : done ? "done" : "upcoming"}
                        </span>
                      </div>
                      <p
                        className={cn(
                          "mt-1 truncate text-[11px] font-medium",
                          isNext ? "text-cyan-900" : "text-slate-800",
                        )}
                      >
                        {item.label}
                      </p>
                      <p className="mt-0.5 line-clamp-2 text-[9px] leading-relaxed text-slate-500">
                        {item.detail}
                        {item.kind === "mill" ? " · mill cut-in" : ""}
                      </p>
                    </button>
                  );
                })}
              </div>
            </Panel>
          )}

          {stored && startupId ? (
            <InsightCard
              startupId={startupId}
              initial={insight}
              llmConfigured={snapshot.llm_configured ?? false}
              variant="summary"
            />
          ) : (
            <Panel className="p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2.5">
                  <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-violet-200 bg-violet-50 text-violet-700">
                    <SparklesIcon className="h-4 w-4" />
                  </span>
                  <div>
                    <h2 className="text-sm font-semibold text-slate-900">AI explanation</h2>
                    <p className="text-[10px] text-slate-500">locked until the run is stored</p>
                  </div>
                </div>
                <span className="chip border-slate-300 bg-slate-100 text-slate-600">locked</span>
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-slate-600">
                Unlocks when the replay stores the run. It explains the deterministic deviations and
                priorities only — it never decides whether the boiler is safe.
              </p>
            </Panel>
          )}

          <div className="grid gap-3 md:grid-cols-3">
            <Panel className="p-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="section-title mb-0.5">Performance score</p>
                  <p className="text-[10px] text-slate-500">Transparent, performance only.</p>
                  <p className={cn("mt-0.5 text-[9px] font-medium uppercase tracking-wider", tone.text)}>
                    {tone.label}
                  </p>
                </div>
                <ScoreRing
                  value={score?.value ?? null}
                  status={score?.status}
                  size={72}
                  stroke={6}
                  showLabel={false}
                />
              </div>
              {score && Object.keys(score.components).length ? (
                <div className="mt-2.5 space-y-2">
                  {Object.entries(score.components).map(([key, value]) => (
                    <Meter key={key} label={key} value={value} weight={score.weights[key]} />
                  ))}
                </div>
              ) : (
                <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
                  The score appears after detection and is withheld for the first 25% of the run.
                </p>
              )}
              {score?.note && (
                <p className="mt-2 border-t border-slate-200 pt-2 text-[10px] leading-relaxed text-slate-500">
                  {score.note}
                </p>
              )}
            </Panel>

            <Panel className="p-4 md:col-span-2">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div>
                  <p className="section-title mb-0.5">Event feed</p>
                  <p className="text-[10px] text-slate-500">
                    Phase changes, deviations and milestones from deterministic analytics.
                  </p>
                </div>
                {analysis && (
                  <span className="text-[10px] text-slate-500">
                    {analysis.violations.length} dev · {analysis.milestones.length} milestone(s)
                  </span>
                )}
              </div>
              <div className="max-h-[210px] overflow-y-auto pr-1 scrollbar-thin">
                <EventFeed
                  events={snapshot.events ?? []}
                  emptyLabel="The feed starts when the startup is detected."
                />
              </div>
            </Panel>
          </div>
        </div>

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
          <Panel className="p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div>
                <p className="section-title mb-0.5">Actual vs design</p>
                <p className="text-[10px] text-slate-500">Current sample by signal (raw data drawer)</p>
              </div>
              <button
                type="button"
                className="btn-ghost !py-1 !text-[10px]"
                onClick={() => setRawOpen(true)}
              >
                <DatabaseIcon className="h-3 w-3" /> Open
              </button>
            </div>
            <p className="text-[10px] leading-relaxed text-slate-500">
              {valueEntries.length} signals · full table, deltas and bands in Raw data.
            </p>
          </Panel>

          {analysis && analysis.milestones.length > 0 && (
            <Panel className="p-4">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div>
                  <p className="section-title mb-0.5">Design milestones</p>
                  <p className="text-[10px] text-slate-500">Actual crossing vs approved design</p>
                </div>
                <span className="text-[10px] text-slate-500">
                  {analysis.milestones.length}
                </span>
              </div>
              <div className="space-y-1.5">
                {analysis.milestones.map((milestone) => (
                  <div
                    key={milestone.id}
                    className="flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-2 py-1.5"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[11px] text-slate-700">{milestone.label}</p>
                      <p className="mono text-[9px] text-slate-500">
                        {milestone.id} · design {fmt(milestone.design_at_min, 1)} min
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="mono text-[11px] text-slate-800">
                        {milestone.actual_at_min === null
                          ? "not reached"
                          : `${fmt(milestone.actual_at_min, 1)} min`}
                      </p>
                      <p
                        className={cn(
                          "mono text-[9px]",
                          milestone.status === "late"
                            ? "text-amber-700"
                            : milestone.status === "early"
                              ? "text-sky-700"
                              : "text-slate-500",
                        )}
                      >
                        {milestone.actual_at_min === null
                          ? "—"
                          : `${fmtSigned(milestone.delta_min, 1)} min`}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </Panel>
          )}

          {((snapshot.curve?.live_highlights?.length ?? 0) > 0 ||
            (snapshot.curve?.events?.length ?? 0) > 0 ||
            (snapshot.curve?.mill_cut_in?.length ?? 0) > 0) && (
            <Panel className="p-4">
              <div className="mb-2">
                <p className="section-title mb-0.5">What matters now</p>
                <p className="text-[10px] text-slate-500">
                  AI-selected from the pinned drawing · live position
                </p>
              </div>
              <div className="space-y-1.5">
                {(snapshot.curve?.live_highlights?.length
                  ? snapshot.curve.live_highlights
                  : [
                      ...(snapshot.curve?.events ?? []).map((event) => ({
                        t_min: event.t_min ?? 0,
                        title: event.name ?? "event",
                        detail: "Drawing event",
                        kind: "event",
                        importance: "medium",
                      })),
                      ...(snapshot.curve?.mill_cut_in ?? []).map((mill) => ({
                        t_min: mill.t_min ?? 0,
                        title: `Mill ${mill.mill ?? "—"} cut-in`,
                        detail: "Mill schedule",
                        kind: "mill",
                        importance: "medium",
                      })),
                    ]
                )
                  .slice()
                  .sort((a, b) => a.t_min - b.t_min)
                  .map((item, index) => {
                    const t = item.t_min;
                    const next = t >= (nowMin ?? 0);
                    const delta = t - (nowMin ?? 0);
                    return (
                      <div
                        key={`${item.title}-${index}`}
                        className={cn(
                          "flex items-center justify-between gap-2 rounded-md border px-2 py-1 text-[10px]",
                          next
                            ? "border-cyan-200 bg-cyan-50"
                            : "border-slate-200 bg-slate-50 opacity-70",
                        )}
                        title={item.detail}
                      >
                        <div className="flex min-w-0 items-center gap-1.5">
                          <span
                            className={cn(
                              "h-1.5 w-1.5 shrink-0 rounded-full",
                              item.importance === "high"
                                ? "bg-rose-500"
                                : item.importance === "medium"
                                  ? "bg-amber-500"
                                  : "bg-slate-400",
                            )}
                          />
                          <span className="truncate text-slate-700">{item.title}</span>
                        </div>
                        <span className="mono shrink-0 text-slate-500">
                          {next
                            ? `in ${fmt(Math.max(0, delta), 1)} min`
                            : `${fmt(t, 1)} min`}
                        </span>
                      </div>
                    );
                  })}
              </div>
            </Panel>
          )}

          <Panel className="p-4">
            <div className="mb-2 flex items-center justify-between gap-2">
              <p className="section-title">Startup detection</p>
              <Pill status={detection?.detected ? "complete" : "watching"} dot>
                {detection?.detected ? "detected" : "watching"}
              </Pill>
            </div>
            <p className="text-[10px] leading-relaxed text-slate-600">{detection?.rule}</p>
            <div className="mt-2.5 grid grid-cols-2 gap-2 text-[10px]">
              <div className="rounded-md border border-slate-200 bg-slate-50 px-2 py-1.5">
                <p className="text-[9px] uppercase tracking-wider text-slate-500">Detected at</p>
                <p className="mono mt-0.5 text-slate-700">
                  {detection?.at_min === null || detection?.at_min === undefined
                    ? "—"
                    : `t = ${fmt(detection.at_min, 1)} min`}
                </p>
              </div>
              <div className="rounded-md border border-slate-200 bg-slate-50 px-2 py-1.5">
                <p className="text-[9px] uppercase tracking-wider text-slate-500">Latency</p>
                <p className="mono mt-0.5 text-slate-700">
                  {detection?.latency_min === null || detection?.latency_min === undefined
                    ? "—"
                    : `${fmt(detection.latency_min, 1)} min`}
                </p>
              </div>
            </div>
            <div className="mt-2.5">
              <div className="mb-1 flex justify-between text-[9px] text-slate-500">
                <span>startup window</span>
                <span className="mono">{fmt(progress, 0)}%</span>
              </div>
              <ProgressBar value={progress} tone={stateTone} height="h-1" />
            </div>
            <p className="mt-2 border-t border-slate-200 pt-2 text-[9px] leading-relaxed text-slate-500">
              Detection only marks the start of a startup. It never triggers a control action and
              does not write to the DCS.
            </p>
          </Panel>

          <AdvisoryNotice compact />
                </div>
              </aside>
            </div>,
            document.body,
          )}
      </div>

      <RawDataDrawer
        open={rawOpen}
        onClose={() => setRawOpen(false)}
        title={`Live startup · ${boiler?.name ?? boilerId}`}
        subtitle={
          snapshot.state === "complete"
            ? `Completed as ${startup?.id ?? "—"}`
            : `Replay at ${fmt(progress, 0)}% · ${snapshot.state}`
        }
        tabs={rawTabs}
      />
    </div>
  );
}

function scoreLabel(status?: string | null): string {
  switch (status) {
    case "nominal":
      return "nominal performance";
    case "watch":
      return "control-band deviation";
    case "attention":
      return "abort-level observation";
    case "reduced_confidence":
      return "reduced confidence";
    case "not_available":
      return "not yet available";
    default:
      return "performance indicator";
  }
}
