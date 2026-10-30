import { useEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode, type WheelEvent } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { fmt } from "../lib/format";
import { CHART, severityTone } from "../lib/theme";
import type { ChartPayload, ChartSignal, Milestone, Violation } from "../lib/types";

interface Row {
  t: number;
  actual: number | null;
  expected: number | null;
  lo: number | null;
  hi: number | null;
  range: number | null;
}

function ChartTooltip({
  active,
  payload,
  signal,
}: {
  active?: boolean;
  payload?: { payload: Row }[];
  signal: ChartSignal;
}) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  const unit = signal.unit ? ` ${signal.unit}` : "";
  return (
    <div className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-[11px] shadow-xl">
      <p className="mb-1 font-mono text-slate-600">t = {row.t.toFixed(1)} min</p>
      <div className="space-y-0.5">
        <p className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-1.5 text-slate-600">
            <span className="h-0.5 w-3 rounded" style={{ background: CHART.actual }} />
            Actual
          </span>
          <span className="font-mono text-slate-800">
            {fmt(row.actual, signal.decimals)}
            {unit}
          </span>
        </p>
        <p className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-1.5 text-slate-600">
            <span
              className="h-0.5 w-3 rounded border-t border-dashed"
              style={{ borderColor: CHART.expected }}
            />
            Design
          </span>
          <span className="font-mono text-slate-700">
            {fmt(row.expected, signal.decimals)}
            {unit}
          </span>
        </p>
        {row.lo !== null && row.hi !== null && (
          <p className="flex items-center justify-between gap-4 text-slate-500">
            <span>Reporting band</span>
            <span className="font-mono">
              {fmt(row.lo, signal.decimals)} – {fmt(row.hi, signal.decimals)}
            </span>
          </p>
        )}
      </div>
    </div>
  );
}

export function SignalChart({
  chart,
  signal,
  height = 320,
  showPhases = true,
  showMarkers = true,
  showBand = true,
  showActualDots = false,
  nowMin,
  nowValue,
  nowLabel = "now",
  zoomable = true,
  eventMarkers = [],
  focusMin,
}: {
  chart: ChartPayload;
  signal: ChartSignal;
  height?: number;
  showPhases?: boolean;
  showMarkers?: boolean;
  showBand?: boolean;
  showActualDots?: boolean;
  nowMin?: number | null;
  nowValue?: number | null;
  nowLabel?: string;
  zoomable?: boolean;
  eventMarkers?: { t_min: number; label: string; kind?: string; importance?: string }[];
  focusMin?: number | null;
}) {
  const [domain, setDomain] = useState<[number, number] | null>(null);
  const [drag, setDrag] = useState<{ start: number; end: number } | null>(null);
  const chartRef = useRef<HTMLDivElement>(null);
  const dragMeta = useRef({ startX: 0, moved: false });
  const rows = useMemo<Row[]>(
    () =>
      chart.grid.map((t, index) => {
        const lo = signal.lo[index] ?? null;
        const hi = signal.hi[index] ?? null;
        return {
          t,
          actual: signal.actual[index] ?? null,
          expected: signal.expected[index] ?? null,
          lo,
          hi,
          range: lo !== null && hi !== null ? hi - lo : null,
        };
      }),
    [chart.grid, signal],
  );

  const violations: Violation[] = useMemo(
    () =>
      (chart.violations ?? []).filter(
        (violation) => violation.signal === signal.key && violation.worst_at !== null,
      ),
    [chart.violations, signal.key],
  );

  const milestones: Milestone[] = useMemo(
    () =>
      (chart.milestones ?? []).filter(
        (milestone) =>
          milestone.signal === signal.key && milestone.actual_at_min !== null,
      ),
    [chart.milestones, signal.key],
  );

  const isState = signal.kind === "state";
  const fullMin = chart.start_min;
  const fullMax = chart.end_min;
  const [domainMin, domainMax] = domain ?? [fullMin, fullMax];
  const showSelection =
    drag && Math.abs(drag.end - drag.start) > Math.max(0.2, (fullMax - fullMin) * 0.005);

  useEffect(() => {
    setDomain(null);
    setDrag(null);
  }, [chart.start_min, chart.end_min, signal.key]);

  useEffect(() => {
    if (focusMin === undefined || focusMin === null) return;
    const half = Math.max(5, (fullMax - fullMin) * 0.04);
    setDomain([
      Math.max(fullMin, focusMin - half),
      Math.min(fullMax, focusMin + half),
    ]);
  }, [focusMin, fullMin, fullMax]);

  function zoomAround(factor: number, anchor: number) {
    const spanNow = domainMax - domainMin;
    const nextSpan = Math.min(fullMax - fullMin, Math.max(spanNow * factor, 1));
    const ratio = (anchor - domainMin) / Math.max(1e-6, spanNow);
    let nextMin = anchor - ratio * nextSpan;
    let nextMax = nextMin + nextSpan;
    if (nextMin < fullMin) {
      nextMin = fullMin;
      nextMax = fullMin + nextSpan;
    }
    if (nextMax > fullMax) {
      nextMax = fullMax;
      nextMin = fullMax - nextSpan;
    }
    setDomain([nextMin, nextMax]);
  }

  function handleWheel(event: WheelEvent<HTMLDivElement>) {
    if (!zoomable) return;
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    const anchor = domainMin + ratio * (domainMax - domainMin);
    zoomAround(event.deltaY < 0 ? 0.75 : 1.33, anchor);
  }

  const PLOT_LEFT = 52;
  const PLOT_RIGHT = 20;

  function timeAt(clientX: number) {
    const element = chartRef.current;
    if (!element) return domainMin;
    const rect = element.getBoundingClientRect();
    const width = Math.max(40, rect.width - PLOT_LEFT - PLOT_RIGHT);
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left - PLOT_LEFT) / width));
    return domainMin + ratio * (domainMax - domainMin);
  }

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    if (!zoomable || event.button !== 0) return;
    const value = timeAt(event.clientX);
    dragMeta.current = { startX: event.clientX, moved: false };
    setDrag({ start: value, end: value });
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!drag) return;
    if (Math.abs(event.clientX - dragMeta.current.startX) > 4) {
      dragMeta.current.moved = true;
    }
    setDrag({ ...drag, end: timeAt(event.clientX) });
  }

  function handlePointerUp(event: PointerEvent<HTMLDivElement>) {
    if (!drag) return;
    const { start, end } = drag;
    if (dragMeta.current.moved && Math.abs(end - start) > Math.max(0.1, (fullMax - fullMin) * 0.002)) {
      setDomain([Math.min(start, end), Math.max(start, end)]);
    }
    setDrag(null);
  }

  return (
    <div
      ref={chartRef}
      style={{ height }}
      className="relative w-full cursor-crosshair touch-none select-none"
      onWheel={handleWheel}
      onDoubleClick={() => setDomain(null)}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={() => setDrag(null)}
    >
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart
          data={rows}
          margin={{ top: 12, right: 18, bottom: 2, left: -6 }}
        >
          <CartesianGrid stroke={CHART.grid} strokeDasharray="2 4" vertical={false} />

          {showPhases &&
            chart.phases.map((phase, index) => (
              <ReferenceArea
                key={phase.key}
                x1={Math.max(phase.start_min, chart.start_min)}
                x2={Math.min(phase.end_min, chart.end_min)}
                fill={index % 2 === 0 ? "#0ea5e9" : "#8b5cf6"}
                fillOpacity={0.05}
                stroke="none"
              />
            ))}

          {showSelection && drag && (
            <ReferenceArea
              x1={Math.min(drag.start, drag.end)}
              x2={Math.max(drag.start, drag.end)}
              fill="#0891b2"
              fillOpacity={0.12}
              stroke="#0891b2"
              strokeOpacity={0.4}
            />
          )}

          {signal.zones.map((zone) => {
            const tone = severityTone(zone.severity);
            return (
              <ReferenceArea
                key={`${zone.label}-${zone.from_min}`}
                x1={Math.max(zone.from_min, chart.start_min)}
                x2={Math.min(zone.to_min, chart.end_min)}
                y1={zone.lo}
                y2={zone.hi}
                fill={tone.hex}
                fillOpacity={0.06}
                stroke={tone.hex}
                strokeOpacity={0.35}
                strokeDasharray="4 4"
                ifOverflow="hidden"
              />
            );
          })}

          {showBand && (
            <>
              <Area
                dataKey="lo"
                stackId="band"
                stroke="none"
                fill="transparent"
                isAnimationActive={false}
                connectNulls={false}
              />
              <Area
                dataKey="range"
                stackId="band"
                stroke="none"
                fill={CHART.band}
                fillOpacity={0.1}
                isAnimationActive={false}
                connectNulls={false}
              />
            </>
          )}

          <ReferenceLine x={0} stroke="#94a3b8" strokeDasharray="3 4" />

          {nowMin !== undefined && nowMin !== null && nowMin >= chart.start_min && (
            <ReferenceLine
              x={nowMin}
              stroke={CHART.actual}
              strokeDasharray="2 3"
              strokeOpacity={0.55}
              label={{
                value: nowLabel,
                position: "insideTopRight",
                fill: CHART.actual,
                fontSize: 9,
              }}
            />
          )}

          {eventMarkers
            .filter(
              (marker) =>
                marker.t_min >= chart.start_min && marker.t_min <= chart.end_min,
            )
            .slice(0, 10)
            .map((marker, index) => {
              const color =
                marker.kind === "mill"
                  ? "#d97706"
                  : marker.importance === "high"
                    ? "#7c3aed"
                    : "#0284c7";
              return (
                <ReferenceLine
                  key={`event-${marker.label}-${marker.t_min}-${index}`}
                  x={marker.t_min}
                  stroke={color}
                  strokeWidth={1.2}
                  strokeDasharray="3 3"
                  strokeOpacity={0.6}
                  label={{
                    value: `${index + 1}`,
                    position: "insideTop",
                    fill: color,
                    fontSize: 9,
                    fontWeight: 700,
                  }}
                />
              );
            })}

          {signal.lines.map((line) => {
            const tone = severityTone(line.severity);
            return (
              <ReferenceLine
                key={`${line.label}-${line.value}`}
                y={line.value}
                stroke={tone.hex}
                strokeOpacity={0.65}
                strokeDasharray="5 4"
                label={{
                  value: `${line.label}`,
                  position: "insideTopRight",
                  fill: tone.hex,
                  fontSize: 9,
                }}
              />
            );
          })}

          <XAxis
            dataKey="t"
            type="number"
            domain={[domainMin, domainMax]}
            tickCount={9}
            tick={{ fill: CHART.axis, fontSize: 10 }}
            axisLine={{ stroke: CHART.grid }}
            tickLine={{ stroke: CHART.grid }}
            tickFormatter={(value: number) => `${Math.round(value)}`}
            minTickGap={18}
          />
          <YAxis
            domain={isState ? [0, 1] : ["auto", "auto"]}
            ticks={isState ? [0, 1] : undefined}
            tick={{ fill: CHART.axis, fontSize: 10 }}
            axisLine={false}
            tickLine={false}
            width={44}
            tickFormatter={(value: number) =>
              isState ? (value >= 0.5 ? "on" : "off") : `${Number(value.toFixed(1))}`
            }
          />
          <Tooltip
            content={<ChartTooltip signal={signal} />}
            cursor={{ stroke: "#94a3b8", strokeDasharray: "3 3" }}
            wrapperStyle={{ outline: "none" }}
          />

          {showMarkers &&
            milestones.map((milestone) => (
              <ReferenceDot
                key={milestone.id}
                x={milestone.actual_at_min as number}
                y={milestone.value}
                r={3}
                fill="#ffffff"
                stroke={CHART.expected}
                strokeWidth={1.4}
                ifOverflow="hidden"
                label={{
                  value: milestone.id,
                  position: "bottom",
                  fill: CHART.expected,
                  fontSize: 9,
                }}
              />
            ))}

          {showMarkers &&
            violations.map((violation) => {
              const tone = severityTone(violation.severity);
              return (
                <ReferenceDot
                  key={violation.id}
                  x={violation.worst_at}
                  y={violation.worst}
                  r={4}
                  fill={tone.hex}
                  stroke="#ffffff"
                  strokeWidth={1.5}
                  ifOverflow="hidden"
                  label={{
                    value: violation.id,
                    position: "top",
                    fill: tone.hex,
                    fontSize: 9,
                  }}
                />
              );
            })}

          <Line
            type="monotone"
            dataKey="expected"
            stroke={CHART.expected}
            strokeWidth={1.4}
            strokeDasharray="5 4"
            dot={false}
            isAnimationActive={false}
            connectNulls
          />
          <Line
            type={isState ? "stepAfter" : "monotone"}
            dataKey="actual"
            stroke={CHART.actual}
            strokeWidth={showActualDots ? 2.4 : 2}
            dot={showActualDots ? { r: 1.7, fill: CHART.actual, strokeWidth: 0 } : false}
            activeDot={{ r: 3, fill: CHART.actual, stroke: "#ffffff", strokeWidth: 1.4 }}
            isAnimationActive={false}
            connectNulls={false}
          />

          {nowMin !== undefined &&
            nowMin !== null &&
            nowValue !== undefined &&
            nowValue !== null && (
              <ReferenceDot
                x={nowMin}
                y={nowValue}
                r={4}
                fill={CHART.actual}
                stroke="#ffffff"
                strokeWidth={1.6}
                ifOverflow="hidden"
                isFront
              />
            )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

export function ChartLegend({
  signal,
  showBand = true,
  extra,
}: {
  signal: ChartSignal;
  showBand?: boolean;
  extra?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[10px] text-slate-500">
      <span className="inline-flex items-center gap-1.5">
        <span className="h-0.5 w-4 rounded" style={{ background: CHART.actual }} />
        Actual
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span
          className="h-0.5 w-4 rounded border-t border-dashed"
          style={{ borderColor: CHART.expected }}
        />
        Approved design
      </span>
      {showBand && (
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-4 rounded-sm" style={{ background: `${CHART.band}26` }} />
          Analytics tolerance
        </span>
      )}
      {signal.zones.length > 0 && (
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-4 rounded-sm border border-dashed border-slate-300 bg-slate-100" />
          SOP band
        </span>
      )}
      {signal.lines.length > 0 && (
        <span className="inline-flex items-center gap-1.5">
          <span className="h-0.5 w-4 border-t border-dashed border-amber-400" />
          SOP limit
        </span>
      )}
      <span className="text-slate-500">x-axis: minutes from detected start</span>
      {extra}
    </div>
  );
}
