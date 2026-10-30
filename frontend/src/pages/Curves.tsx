import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import {
  AlertIcon,
  ArrowUpRightIcon,
  BoltIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  DatabaseIcon,
  FileTextIcon,
  InfoIcon,
  LayersIcon,
  RefreshIcon,
  ShieldIcon,
  UploadIcon,
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
import { useBoiler } from "../lib/boiler";
import { fmt, fmtDate, shortHash } from "../lib/format";
import { severityTone } from "../lib/theme";
import type {
  ApproveResponse,
  BoilerParameter,
  BoilerSummary,
  CurveDetail,
  CurveDoc,
  CurveSummary,
  ExtractionResult,
  LimitDoc,
  SignalDoc,
} from "../lib/types";


function blankBoilerForm() {
  return {
    id: "",
    name: "",
    startup_types: {
      cold: { enabled: true, design_duration_min: 480 },
      warm: { enabled: true, design_duration_min: 240 },
      hot: { enabled: true, design_duration_min: 120 },
    },
    type_thresholds: { hot_max_hours: 4, warm_max_hours: 96 },
  };
}

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

function signalRange(signal: SignalDoc): { first: number | null; last: number | null } {
  const points = signal.design.flatMap((track) => track.points);
  if (!points.length) return { first: null, last: null };
  const ordered = points.slice().sort((a, b) => a.t - b.t);
  return { first: ordered[0].value, last: ordered[ordered.length - 1].value };
}

function CurveSignalDetail({ signal }: { signal: SignalDoc }) {
  const range = signalRange(signal);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="mono rounded border border-slate-200 bg-slate-50 px-2 py-1 text-slate-600">
          {signal.unit || "state"}
        </span>
        <span className="mono rounded border border-slate-200 bg-slate-50 px-2 py-1 text-slate-500">
          {signal.kairos.metric}
        </span>
        <span className="text-[11px] text-slate-500">
          {signal.design.length} design track(s) · {signal.limits.length} limit(s) ·{" "}
          {signal.milestones.length} milestone(s)
        </span>
        {range.first !== null && range.last !== null && (
          <span className="ml-auto text-[11px] text-slate-500">
            {fmt(range.first, signal.decimals)} → {fmt(range.last, signal.decimals)} {signal.unit}
          </span>
        )}
      </div>

      <div className="overflow-hidden rounded-lg border border-slate-200">
        <table className="data-table">
          <thead>
            <tr>
              <th>Design track</th>
              <th>Window</th>
              <th>Expected shape</th>
              <th>Tolerance</th>
              <th>Rate</th>
              <th>Source</th>
            </tr>
          </thead>
          <tbody>
            {signal.design.map((track, index) => {
              const ordered = track.points.slice().sort((a, b) => a.t - b.t);
              const from = ordered[0];
              const to = ordered[ordered.length - 1];
              return (
                <tr key={`${track.phase}-${index}`}>
                  <td className="capitalize text-slate-700">{track.phase.replace(/_/g, " ")}</td>
                  <td className="mono whitespace-nowrap text-slate-500">
                    {from ? `${fmt(from.t, 1)} – ${fmt(to.t, 1)} min` : "—"}
                  </td>
                  <td className="mono whitespace-nowrap text-slate-700">
                    {from && to
                      ? `${fmt(from.value, signal.decimals)} → ${fmt(to.value, signal.decimals)} ${signal.unit}`
                      : "—"}
                  </td>
                  <td>
                    {track.tolerance === null ? (
                      <span className="text-[10px] text-slate-500">none</span>
                    ) : (
                      <>
                        <span className="mono text-slate-700">±{fmt(track.tolerance, signal.decimals)}</span>
                        <p className="text-[9px] uppercase tracking-wider text-slate-500">
                          {track.tolerance_provenance === "analytics_default"
                            ? "analytics default"
                            : track.tolerance_provenance}
                        </p>
                      </>
                    )}
                  </td>
                  <td className="mono whitespace-nowrap text-slate-600">
                    {track.max_rate_per_min === null
                      ? "—"
                      : `${fmt(track.max_rate_per_min, 2)} / min ${track.rate_direction ?? ""}`}
                  </td>
                  <td className="mono whitespace-nowrap text-slate-500">{track.source_ref ?? "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div>
        <div className="mb-1.5 flex items-center gap-2">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
            Time / value breakpoints
          </p>
          <span className="text-[10px] text-slate-500">
            {signal.design.reduce((sum, track) => sum + track.points.length, 0)} point(s)
          </span>
        </div>
        {signal.design.length ? (
          <div className="max-h-[260px] overflow-auto rounded-lg border border-slate-200">
            <table className="data-table min-w-[420px]">
              <thead className="sticky top-0 bg-white/95 backdrop-blur">
                <tr>
                  <th>Phase</th>
                  <th>Time</th>
                  <th>Value</th>
                </tr>
              </thead>
              <tbody>
                {signal.design.flatMap((track) =>
                  track.points
                    .slice()
                    .sort((a, b) => a.t - b.t)
                    .map((point, index) => (
                      <tr key={`${track.phase}-${point.t}-${index}`}>
                        <td className="capitalize text-slate-600">
                          {track.phase.replace(/_/g, " ")}
                        </td>
                        <td className="mono whitespace-nowrap text-slate-700">
                          {fmt(point.t, 2)} min
                        </td>
                        <td className="mono whitespace-nowrap text-slate-700">
                          {fmt(point.value, signal.decimals)} {signal.unit}
                        </td>
                      </tr>
                    )),
                )}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-[11px] text-slate-500">
            No design points for this signal.
          </p>
        )}
      </div>

      <div>
        <div className="mb-1.5 flex items-center gap-2">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
            Document-sourced limits
          </p>
          <span className="text-[10px] text-slate-500">
            {signal.limits.length ? "each row cites the procedure" : "no limits defined"}
          </span>
        </div>
        {signal.limits.length ? (
          <div className="overflow-hidden rounded-lg border border-slate-200">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Condition</th>
                  <th>Severity</th>
                  <th>Active window</th>
                  <th>Hold</th>
                  <th>Source</th>
                </tr>
              </thead>
              <tbody>
                {signal.limits.map((limit) => {
                  const tone = severityTone(limit.severity);
                  return (
                    <tr key={limit.key}>
                      <td>
                        <p className="mono text-slate-800">{condition(limit, signal.unit)}</p>
                        <p className="mt-0.5 text-[10px] text-slate-500">
                          {limit.label ?? limit.key}
                        </p>
                      </td>
                      <td>
                        <span className={cn("chip", tone.bg, tone.border, tone.text)}>
                          {limit.severity}
                        </span>
                      </td>
                      <td className="mono whitespace-nowrap text-slate-500">
                        {limit.active_from_min === null && limit.active_to_min === null
                          ? "whole startup"
                          : `${limit.active_from_min ?? 0} – ${limit.active_to_min ?? "end"} min`}
                        {limit.active_from_event && (
                          <p className="text-[9px] text-slate-500">from {limit.active_from_event}</p>
                        )}
                      </td>
                      <td className="mono whitespace-nowrap text-slate-500">
                        {limit.min_duration_min > 0 ? `${limit.min_duration_min} min` : "—"}
                      </td>
                      <td className="mono whitespace-nowrap text-slate-500">{limit.source_ref}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-[11px] text-slate-500">
            This signal has no document-sourced limits. The reporting tolerance above is an analytics
            default and is not a safety limit.
          </p>
        )}
      </div>

      {signal.milestones.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {signal.milestones.map((milestone) => (
            <span
              key={milestone.key}
              className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-[10px] text-slate-600"
            >
              <span className="mono text-slate-700">{milestone.label}</span>
              <span className="ml-1.5 text-slate-500">
                {milestone.value} {signal.unit}
              </span>
              {milestone.source_ref && (
                <span className="ml-1.5 text-slate-500">· {milestone.source_ref}</span>
              )}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function CurveDetailPanel({
  detail,
  activeCurveId,
  deleting,
  onDelete,
}: {
  detail: CurveDetail;
  activeCurveId: string | null | undefined;
  deleting?: boolean;
  onDelete?: () => void;
}) {
  const curve: CurveDoc = detail.curve;
  const [signalKey, setSignalKey] = useState(curve.signals[0]?.key ?? "");
  const [showJson, setShowJson] = useState(false);

  useEffect(() => {
    setSignalKey(curve.signals[0]?.key ?? "");
  }, [curve.curve_id, curve.signals]);

  const signal = curve.signals.find((row) => row.key === signalKey) ?? curve.signals[0];
  const limits = curve.signals.reduce((sum, row) => sum + row.limits.length, 0);
  const tolerances = curve.signals.reduce(
    (sum, row) => sum + row.design.filter((track) => track.tolerance !== null).length,
    0,
  );

  return (
    <Panel className="min-w-0 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="section-title">Approved curve</p>
            <Pill status={curve.status} dot>
              {curve.status}
            </Pill>
            <span className="chip border-slate-300 bg-slate-100 capitalize text-slate-600">
              {curve.startup_type ?? "cold"} curve
            </span>
            {curve.curve_id === activeCurveId && (
              <span className="chip border-cyan-200 bg-cyan-50 text-cyan-700">active</span>
            )}
          </div>
          <h2 className="mt-1 text-base font-semibold tracking-tight text-slate-900">
            {curve.name}
          </h2>
          <p className="mt-0.5 text-xs text-slate-500">
            {curve.source.document} Rev {curve.source.revision} · {curve.source.file_name} ·{" "}
            {curve.boiler_id}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {curve.extras?.source_file && (
            <a
              href={api.curveSourceUrl(detail.id)}
              target="_blank"
              rel="noreferrer"
              className="btn-ghost !py-1.5 text-[11px]"
            >
              <FileTextIcon className="h-3.5 w-3.5" />
              View source
            </a>
          )}
          {onDelete && (
            <button
              type="button"
              className="btn-ghost !py-1.5 !text-[11px] !text-rose-700 hover:!text-rose-800"
              onClick={onDelete}
              disabled={deleting}
            >
              <AlertIcon className="h-3.5 w-3.5" />
              {deleting ? "Deleting…" : "Delete curve"}
            </button>
          )}
          <button
            type="button"
            className="btn-ghost !py-1.5 text-xs"
            onClick={() => setShowJson((value) => !value)}
          >
            <FileTextIcon className="h-3.5 w-3.5" />
            {showJson ? "Hide JSON" : "View JSON"}
          </button>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 text-[11px] sm:grid-cols-4">
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2">
          <p className="text-[9px] uppercase tracking-wider text-slate-500">Design duration</p>
          <p className="mono mt-0.5 text-slate-700">{fmt(curve.phases.at(-1)?.end_min, 1)} min</p>
        </div>
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2">
          <p className="text-[9px] uppercase tracking-wider text-slate-500">Signals / phases</p>
          <p className="mono mt-0.5 text-slate-700">
            {curve.signals.length} / {curve.phases.length}
          </p>
        </div>
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2">
          <p className="text-[9px] uppercase tracking-wider text-slate-500">Limits / tolerances</p>
          <p className="mono mt-0.5 text-slate-700">
            {limits} / {tolerances}
          </p>
        </div>
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2">
          <p className="text-[9px] uppercase tracking-wider text-slate-500">Approved</p>
          <p className="mt-0.5 truncate text-slate-700">
            {curve.source.approved_by || "—"}{" "}
            <span className="text-slate-500">· {fmtDate(curve.source.approved_at)}</span>
          </p>
        </div>
      </div>

      {((curve.extras?.digitization?.events?.length ?? 0) > 0 ||
        (curve.extras?.digitization?.mill_cut_in?.length ?? 0) > 0) && (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-2.5">
            <p className="section-title mb-1">Events from drawing</p>
            <div className="space-y-1">
              {(curve.extras?.digitization?.events ?? []).map((event, index) => (
                <div key={`${event.name}-${index}`} className="flex items-center justify-between gap-2 text-[10px]">
                  <span className="truncate text-slate-700">{event.name ?? "event"}</span>
                  <span className="mono shrink-0 text-slate-500">
                    {event.t_min === undefined ? "—" : `${fmt(event.t_min, 1)} min`}
                  </span>
                </div>
              ))}
              {!curve.extras?.digitization?.events?.length && (
                <p className="text-[10px] text-slate-500">No events recorded.</p>
              )}
            </div>
          </div>
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-2.5">
            <p className="section-title mb-1">Mill cut-in</p>
            <div className="space-y-1">
              {(curve.extras?.digitization?.mill_cut_in ?? []).map((mill, index) => (
                <div key={`${mill.mill}-${index}`} className="flex items-center justify-between gap-2 text-[10px]">
                  <span className="text-slate-700">Mill {mill.mill ?? "—"}</span>
                  <span className="mono text-slate-500">
                    {mill.t_min === undefined ? "—" : `${fmt(mill.t_min, 1)} min`}
                  </span>
                </div>
              ))}
              {!curve.extras?.digitization?.mill_cut_in?.length && (
                <p className="text-[10px] text-slate-500">No mill schedule recorded.</p>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-slate-500">
        <span className="flex items-center gap-1.5">
          <ShieldIcon className="h-3 w-3 text-cyan-600" />
          curve {shortHash(detail.id, 22)}
        </span>
        <span className="text-slate-300">·</span>
        <span className="mono">sha256 {shortHash(detail.sha256, 18)}</span>
        <span className="text-slate-300">·</span>
        <span className="mono">source sha256 {shortHash(curve.source.sha256, 18)}</span>
      </div>

      {showJson && (
        <pre className="mt-3 max-h-[420px] overflow-auto rounded-lg border border-slate-200 bg-slate-50 p-3 font-mono text-[10px] leading-relaxed text-slate-600">
          {JSON.stringify(curve, null, 2)}
        </pre>
      )}

      <div className="mt-4">
        <p className="section-title mb-1.5">Phases</p>
        <div className="overflow-hidden rounded-lg border border-slate-200">
          <table className="data-table">
            <thead>
              <tr>
                <th>Phase</th>
                <th>Window</th>
                <th>Note</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {curve.phases.map((phase) => (
                <tr key={phase.key}>
                  <td>
                    <p className="text-[12px] text-slate-700">{phase.label}</p>
                    <p className="mono text-slate-500">{phase.key}</p>
                  </td>
                  <td className="mono whitespace-nowrap text-slate-600">
                    {fmt(phase.start_min, 1)} – {fmt(phase.end_min, 1)} min
                  </td>
                  <td className="max-w-[300px] text-[11px] leading-relaxed text-slate-500">
                    {phase.note}
                  </td>
                  <td className="mono whitespace-nowrap text-slate-500">{phase.source_ref}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="mt-4">
        <div className="mb-2 flex flex-wrap gap-1.5">
          {curve.signals.map((row) => {
            const active = row.key === signal?.key;
            return (
              <button
                key={row.key}
                type="button"
                onClick={() => setSignalKey(row.key)}
                className={cn(
                  "rounded-md border px-2 py-1 text-[11px] transition-colors",
                  active
                    ? "border-cyan-300 bg-cyan-50 text-cyan-800"
                    : "border-slate-200 bg-slate-50 text-slate-500 hover:border-slate-300 hover:text-slate-700",
                )}
              >
                {row.label}
                {row.limits.length > 0 && (
                  <span className="ml-1.5 text-[9px] text-slate-500">{row.limits.length}</span>
                )}
              </button>
            );
          })}
        </div>
        {signal && <CurveSignalDetail signal={signal} />}
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <div>
          <p className="section-title mb-1.5">Prerequisites</p>
          <div className="space-y-1.5">
            {curve.prerequisites.map((prereq) => (
              <div
                key={prereq.key}
                className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2"
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="text-[11px] text-slate-700">{prereq.label}</p>
                  <span className="chip border-slate-300 bg-slate-100 !px-1.5 !py-0 !text-[9px] text-slate-600">
                    {prereq.mode}
                  </span>
                </div>
                <p className="mono mt-0.5 text-slate-500">{prereq.source_ref}</p>
              </div>
            ))}
          </div>
        </div>
        <div>
          <p className="section-title mb-1.5">Manual criteria</p>
          <div className="space-y-1.5">
            {curve.manual_criteria.length ? (
              curve.manual_criteria.map((criterion) => (
                <div
                  key={criterion.key}
                  className="rounded-lg border border-violet-200 bg-violet-50 px-3 py-2"
                >
                  <p className="text-[11px] text-violet-800">{criterion.label}</p>
                  <p className="mt-0.5 text-[10px] leading-relaxed text-slate-500">{criterion.detail}</p>
                  <p className="mono mt-0.5 text-slate-500">{criterion.source_ref}</p>
                </div>
              ))
            ) : (
              <p className="text-[11px] text-slate-500">No manual criteria are defined.</p>
            )}
          </div>
        </div>
      </div>

      {curve.notes.length > 0 && (
        <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3">
          <p className="section-title mb-1.5">Curve notes</p>
          <ul className="space-y-1">
            {curve.notes.map((note, index) => (
              <li key={index} className="text-[11px] leading-relaxed text-slate-500">
                · {note}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-3">
        <InfoLine>
          Tolerances tagged <span className="mono">analytics_default</span> only drive deviation
          reporting. They are not safety limits. Limits above are transcribed from the approved
          document and cite their source.
        </InfoLine>
      </div>
    </Panel>
  );
}

function blankParameter(): BoilerParameter {
  return { key: "", label: "", unit: "", tag: "", alarm_low: null, alarm_high: null };
}

function BoilerSettingsPanel({
  boiler,
  onSaved,
  onDeleted,
}: {
  boiler: BoilerSummary;
  onSaved: () => void;
  onDeleted: () => void;
}) {
  const [name, setName] = useState(boiler.name);
  const [types, setTypes] = useState(boiler.startup_types);
  const [thresholds, setThresholds] = useState(
    boiler.type_thresholds ?? { hot_max_hours: 4, warm_max_hours: 96 },
  );
  const [parameters, setParameters] = useState<BoilerParameter[]>(
    boiler.parameters ?? [],
  );
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    setName(boiler.name);
    setTypes(boiler.startup_types);
    setThresholds(boiler.type_thresholds ?? { hot_max_hours: 4, warm_max_hours: 96 });
    setParameters(boiler.parameters ?? []);
  }, [boiler]);

  async function save() {
    setSaving(true);
    setMessage(null);
    try {
      await api.updateBoiler(boiler.id, {
        name,
        startup_types: types,
        type_thresholds: thresholds,
      });
      for (const row of parameters) {
        if (!row.key.trim()) continue;
        await api.saveBoilerParameter(boiler.id, row.key.trim(), {
          key: row.key.trim(),
          label: row.label,
          unit: row.unit,
          tag: row.tag,
          alarm_low: row.alarm_low,
          alarm_high: row.alarm_high,
        });
      }
      onSaved();
      setMessage("Boiler settings saved.");
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "Could not save settings");
    } finally {
      setSaving(false);
    }
  }

  async function removeParameter(key: string) {
    try {
      await api.deleteBoilerParameter(boiler.id, key);
      setParameters((rows) => rows.filter((row) => row.key !== key));
      onSaved();
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "Could not delete parameter");
    }
  }

  async function removeBoiler() {
    if (
      !window.confirm(
        `Delete ${boiler.id} and all of its curves, startups and parameters? This cannot be undone.`,
      )
    ) {
      return;
    }
    try {
      await api.deleteBoiler(boiler.id);
      onDeleted();
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "Could not delete boiler");
    }
  }

  return (
    <Panel className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="section-title mb-0.5">Boiler settings</p>
          <p className="text-[11px] text-slate-500">
            {boiler.id} · update durations, thresholds, parameter tags and alarm values.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" className="btn-primary !py-1.5 text-xs" onClick={() => void save()} disabled={saving}>
            {saving ? "Saving…" : "Save settings"}
          </button>
          <button
            type="button"
            className="btn-ghost !py-1.5 !text-rose-700 text-xs"
            onClick={() => void removeBoiler()}
          >
            Delete boiler
          </button>
        </div>
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <label className="label">Name</label>
          <input className="input !py-1.5 text-[12px]" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        {(["cold", "warm", "hot"] as const).map((type) => (
          <div key={type}>
            <label className="label capitalize">{type} duration (min)</label>
            <input
              className="input !py-1.5 text-[12px]"
              type="number"
              value={types[type]?.design_duration_min ?? 0}
              onChange={(e) =>
                setTypes({
                  ...types,
                  [type]: {
                    enabled: types[type]?.enabled ?? true,
                    design_duration_min: Number(e.target.value),
                  },
                })
              }
            />
          </div>
        ))}
      </div>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <div>
          <label className="label">Hot if shut down within (hours)</label>
          <input
            className="input !py-1.5 text-[12px]"
            type="number"
            value={thresholds.hot_max_hours ?? 4}
            onChange={(e) => setThresholds({ ...thresholds, hot_max_hours: Number(e.target.value) })}
          />
        </div>
        <div>
          <label className="label">Warm up to (hours)</label>
          <input
            className="input !py-1.5 text-[12px]"
            type="number"
            value={thresholds.warm_max_hours ?? 96}
            onChange={(e) => setThresholds({ ...thresholds, warm_max_hours: Number(e.target.value) })}
          />
        </div>
      </div>

      <div className="mt-4">
        <div className="mb-2 flex items-center justify-between gap-2">
          <p className="section-title">Parameters, tags and alarm values</p>
          <button
            type="button"
            className="btn-ghost !py-1 !text-[10px]"
            onClick={() => setParameters((rows) => [...rows, blankParameter()])}
          >
            + Add parameter
          </button>
        </div>
        <div className="overflow-x-auto rounded-lg border border-slate-200">
          <table className="data-table min-w-[760px]">
            <thead>
              <tr>
                <th>Key</th>
                <th>Label</th>
                <th>Unit</th>
                <th>Historian tag</th>
                <th>Alarm low</th>
                <th>Alarm high</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {parameters.map((row, index) => (
                <tr key={`${row.key}-${index}`}>
                  <td>
                    <input
                      className="input !py-1 text-[11px]"
                      value={row.key}
                      onChange={(e) =>
                        setParameters((rows) =>
                          rows.map((item, i) => (i === index ? { ...item, key: e.target.value } : item)),
                        )
                      }
                      placeholder="main_steam_pressure"
                    />
                  </td>
                  <td>
                    <input
                      className="input !py-1 text-[11px]"
                      value={row.label}
                      onChange={(e) =>
                        setParameters((rows) =>
                          rows.map((item, i) => (i === index ? { ...item, label: e.target.value } : item)),
                        )
                      }
                    />
                  </td>
                  <td>
                    <input
                      className="input !py-1 text-[11px]"
                      value={row.unit}
                      onChange={(e) =>
                        setParameters((rows) =>
                          rows.map((item, i) => (i === index ? { ...item, unit: e.target.value } : item)),
                        )
                      }
                    />
                  </td>
                  <td>
                    <input
                      className="input !py-1 text-[11px]"
                      value={row.tag}
                      onChange={(e) =>
                        setParameters((rows) =>
                          rows.map((item, i) => (i === index ? { ...item, tag: e.target.value } : item)),
                        )
                      }
                    />
                  </td>
                  <td>
                    <input
                      className="input !py-1 text-[11px]"
                      type="number"
                      value={row.alarm_low ?? ""}
                      onChange={(e) =>
                        setParameters((rows) =>
                          rows.map((item, i) =>
                            i === index
                              ? { ...item, alarm_low: e.target.value === "" ? null : Number(e.target.value) }
                              : item,
                          ),
                        )
                      }
                    />
                  </td>
                  <td>
                    <input
                      className="input !py-1 text-[11px]"
                      type="number"
                      value={row.alarm_high ?? ""}
                      onChange={(e) =>
                        setParameters((rows) =>
                          rows.map((item, i) =>
                            i === index
                              ? { ...item, alarm_high: e.target.value === "" ? null : Number(e.target.value) }
                              : item,
                          ),
                        )
                      }
                    />
                  </td>
                  <td>
                    {row.key && (
                      <button
                        type="button"
                        className="text-[10px] text-rose-600 hover:text-rose-800"
                        onClick={() => void removeParameter(row.key)}
                      >
                        Remove
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {message && <p className="mt-2 text-[10px] text-slate-500">{message}</p>}
    </Panel>
  );
}

export function CurvesPage() {
  const { boilerId, boiler, boilers, setBoilerId, refresh } = useBoiler();
  const [curves, setCurves] = useState<CurveSummary[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CurveDetail | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [listToken, setListToken] = useState(0);

  const [sourceMode, setSourceMode] = useState<"paste" | "file" | "drawing">("paste");
  const [sourcePreview, setSourcePreview] = useState<{ url: string; name: string; kind: string } | null>(null);
  const [sopText, setSopText] = useState("");
  const [sopLoading, setSopLoading] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [extraction, setExtraction] = useState<ExtractionResult | null>(null);
  const [extractError, setExtractError] = useState<string | null>(null);
  const [showDraft, setShowDraft] = useState(false);

  const [approvedBy, setApprovedBy] = useState("shift.engineer");
  const [approveType, setApproveType] = useState<"cold" | "warm" | "hot">("cold");
  const [parameterTags, setParameterTags] = useState<Record<string, string>>({});
  const [checks, setChecks] = useState({ transcription: false, limits: false, advisory: false });
  const [approving, setApproving] = useState(false);
  const [approveError, setApproveError] = useState<string | null>(null);
  const [approveResult, setApproveResult] = useState<ApproveResponse | null>(null);
  const [deletingCurve, setDeletingCurve] = useState(false);

  const [showBoilerForm, setShowBoilerForm] = useState(false);
  const [boilerForm, setBoilerForm] = useState(blankBoilerForm);
  const [creatingBoiler, setCreatingBoiler] = useState(false);
  const [boilerError, setBoilerError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setCurves(null);
    setListError(null);
    setExtraction(null);
    setApproveResult(null);
    setSelectedId(null);
    setDetail(null);
    api
      .curves(boilerId)
      .then((rows) => {
        if (cancelled) return;
        setCurves(rows);
        setSelectedId((current) =>
          current && rows.some((row) => row.id === current) ? current : rows[0]?.id ?? null,
        );
      })
      .catch((caught) => {
        if (!cancelled) {
          setListError(caught instanceof Error ? caught.message : "Could not load design curves");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [boilerId, listToken]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetail(null);
    setDetailError(null);
    api
      .curve(selectedId)
      .then((payload) => {
        if (!cancelled) setDetail(payload);
      })
      .catch((caught) => {
        if (!cancelled) {
          const message = caught instanceof Error ? caught.message : "Could not load the curve JSON";
          if (message.toLowerCase().includes("not found")) {
            setSelectedId(null);
            setListToken((token) => token + 1);
          } else {
            setDetailError(message);
          }
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  const activeCurveId = boiler?.curve?.id ?? null;
  const tagsReady =
    !extraction ||
    extraction.draft.signals.every(
      (signal) => !signal.required || Boolean((parameterTags[signal.key] ?? "").trim()),
    );
  const canApprove =
    Boolean(extraction) &&
    approvedBy.trim().length > 0 &&
    tagsReady &&
    checks.transcription &&
    checks.limits &&
    checks.advisory &&
    !approving;

  const signalCount = useMemo(
    () => (extraction ? extraction.draft.signals.length : 0),
    [extraction],
  );

  async function loadDemoText() {
    setSopLoading(true);
    setExtractError(null);
    try {
      const payload = await api.sopText();
      setSopText(payload.text);
      setSourceMode("paste");
    } catch (caught) {
      setExtractError(caught instanceof Error ? caught.message : "Could not load the bundled procedure");
    } finally {
      setSopLoading(false);
    }
  }

  async function extractFromText() {
    if (sopText.trim().length < 20) {
      setExtractError("Paste at least a few lines of the procedure before extracting.");
      return;
    }
    setExtracting(true);
    setExtractError(null);
    setApproveResult(null);
    try {
      const payload = await api.extractText(boilerId, sopText);
      applyExtraction(payload);
    } catch (caught) {
      setExtractError(caught instanceof Error ? caught.message : "Extraction failed");
    } finally {
      setExtracting(false);
    }
  }

  async function extractFromFile(file: File) {
    setSourcePreview({ url: URL.createObjectURL(file), name: file.name, kind: file.type });
    setExtracting(true);
    setExtractError(null);
    setApproveResult(null);
    try {
      const payload = await api.extractFile(boilerId, file);
      applyExtraction(payload);
    } catch (caught) {
      setExtractError(caught instanceof Error ? caught.message : "Extraction failed");
    } finally {
      setExtracting(false);
    }
  }

  async function extractFromCurve(file: File) {
    setSourcePreview({ url: URL.createObjectURL(file), name: file.name, kind: file.type });
    setExtracting(true);
    setExtractError(null);
    setApproveResult(null);
    try {
      const payload = await api.extractCurve(boilerId, file);
      applyExtraction(payload);
    } catch (caught) {
      setExtractError(caught instanceof Error ? caught.message : "Curve digitization failed");
    } finally {
      setExtracting(false);
    }
  }

  useEffect(() => {
    if (sourceMode !== "drawing") return;
    const onPaste = (event: ClipboardEvent) => {
      if (extracting) return;
      const item = Array.from(event.clipboardData?.items ?? []).find((entry) =>
        entry.type.startsWith("image/"),
      );
      const file = item?.getAsFile();
      if (!file) return;
      event.preventDefault();
      void extractFromCurve(file);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [sourceMode, extracting, boilerId]);

  function applyExtraction(payload: ExtractionResult) {
    setExtraction(payload);
    setChecks({ transcription: false, limits: false, advisory: false });
    setApproveResult(null);
    setApprovedBy(payload.draft.source.approved_by || "shift.engineer");
    setParameterTags(
      Object.fromEntries(
        payload.draft.signals.map((signal) => [signal.key, signal.kairos?.metric ?? ""]),
      ),
    );
  }

  async function approve() {
    if (!extraction) return;
    setApproving(true);
    setApproveError(null);
    setApproveResult(null);
    try {
      const response = await api.approveCurve({
        boiler_id: boilerId,
        draft: extraction.draft,
        approved_by: approvedBy.trim(),
        startup_type: approveType,
        tag_map: Object.fromEntries(
          Object.entries(parameterTags)
            .map(([key, value]) => [key, value.trim()])
            .filter(([, value]) => value),
        ),
      });
      setApproveResult(response);
      setListToken((token) => token + 1);
      setSelectedId(response.curve.id);
      await refresh();
    } catch (caught) {
      setApproveError(caught instanceof Error ? caught.message : "Approval failed");
    } finally {
      setApproving(false);
    }
  }

  async function deleteSelectedCurve() {
    if (!selectedId) return;
    if (
      !window.confirm(
        "Hide this curve from the selector? Stored startups keep their pinned version.",
      )
    ) {
      return;
    }
    setDeletingCurve(true);
    setDetailError(null);
    try {
      await api.deleteCurve(selectedId);
      setSelectedId(null);
      setDetail(null);
      setListToken((token) => token + 1);
      await refresh();
    } catch (caught) {
      setDetailError(caught instanceof Error ? caught.message : "Could not delete the curve");
    } finally {
      setDeletingCurve(false);
    }
  }

  async function createBoiler() {
    setCreatingBoiler(true);
    setBoilerError(null);
    try {
      await api.createBoiler({
        id: boilerForm.id.trim(),
        name: boilerForm.name.trim(),
        startup_types: boilerForm.startup_types,
        type_thresholds: boilerForm.type_thresholds,
      });
      await refresh();
      setBoilerId(boilerForm.id.trim());
      setBoilerForm(blankBoilerForm());
      setShowBoilerForm(false);
      setListToken((token) => token + 1);
    } catch (caught) {
      setBoilerError(caught instanceof Error ? caught.message : "Could not create the boiler");
    } finally {
      setCreatingBoiler(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="section-title mb-1.5">Curve management</p>
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">Design curves</h1>
          <p className="mt-1 max-w-3xl text-sm text-slate-600">
            Each boiler runs against its own versioned JSON curves. A curve is extracted from that
            boiler's approved procedure, checked by a person, then approved. Re-approval creates a
            new version; recorded startups keep the version active at their start.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn-ghost"
            onClick={() => setListToken((token) => token + 1)}
          >
            <RefreshIcon className="h-4 w-4" /> Refresh
          </button>
          <button
            type="button"
            className="btn-ghost"
            onClick={() => setShowBoilerForm((value) => !value)}
          >
            <DatabaseIcon className="h-4 w-4" /> {showBoilerForm ? "Close boiler form" : "Add boiler"}
          </button>
          <Link to="/live" className="btn-primary">
            <BoltIcon className="h-4 w-4" /> Live startup
          </Link>
        </div>
      </div>

      {showBoilerForm && (
        <Panel className="p-4">
          <SectionHeading
            eyebrow="Onboarding"
            title="Add a boiler"
            description="Add the boiler and its type thresholds. The parameters to watch and their sensor tags come from the approved design document during curve extraction."
          />
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <label className="label">Boiler id</label>
              <input
                className="input"
                value={boilerForm.id}
                onChange={(event) => setBoilerForm({ ...boilerForm, id: event.target.value })}
                placeholder="B-102"
              />
            </div>
            <div>
              <label className="label">Name</label>
              <input
                className="input"
                value={boilerForm.name}
                onChange={(event) => setBoilerForm({ ...boilerForm, name: event.target.value })}
                placeholder="Utility boiler B-102"
              />
            </div>
          </div>

          <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
            <p className="section-title mb-0.5">Startup type durations</p>
            <p className="mb-2 text-[10px] text-slate-500">
              Total expected duration for each startup type. Cold must be the longest.
            </p>
            <div className="grid gap-2 sm:grid-cols-3">
              {(["cold", "warm", "hot"] as const).map((type) => (
                <div
                  key={type}
                  className="rounded-md border border-slate-200 bg-white px-2.5 py-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-medium capitalize text-slate-700">
                      {type} startup
                    </span>
                    <label className="flex items-center gap-1 text-[9px] text-slate-500">
                      <input
                        type="checkbox"
                        checked={boilerForm.startup_types[type].enabled}
                        onChange={(event) =>
                          setBoilerForm({
                            ...boilerForm,
                            startup_types: {
                              ...boilerForm.startup_types,
                              [type]: {
                                ...boilerForm.startup_types[type],
                                enabled: event.target.checked,
                              },
                            },
                          })
                        }
                      />
                      enabled
                    </label>
                  </div>
                  <div className="mt-1.5 flex items-center gap-1.5">
                    <input
                      className="input !py-1 text-[12px]"
                      type="number"
                      min={1}
                      max={1440}
                      value={boilerForm.startup_types[type].design_duration_min}
                      onChange={(event) =>
                        setBoilerForm({
                          ...boilerForm,
                          startup_types: {
                            ...boilerForm.startup_types,
                            [type]: {
                              ...boilerForm.startup_types[type],
                              design_duration_min: Number(event.target.value),
                            },
                          },
                        })
                      }
                    />
                    <span className="text-[10px] text-slate-500">min</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
            <p className="section-title mb-0.5">Classification thresholds</p>
            <p className="mb-2 text-[10px] text-slate-500">
              Uses the time since the previous recorded shutdown. Override per boiler if needed.
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              <div>
                <label className="label">Hot startup if shut down within (hours)</label>
                <input
                  className="input !py-1.5 text-[12px]"
                  type="number"
                  min={0}
                  max={168}
                  value={boilerForm.type_thresholds.hot_max_hours}
                  onChange={(event) =>
                    setBoilerForm({
                      ...boilerForm,
                      type_thresholds: {
                        ...boilerForm.type_thresholds,
                        hot_max_hours: Number(event.target.value),
                      },
                    })
                  }
                />
              </div>
              <div>
                <label className="label">Warm startup up to (hours)</label>
                <input
                  className="input !py-1.5 text-[12px]"
                  type="number"
                  min={1}
                  max={720}
                  value={boilerForm.type_thresholds.warm_max_hours}
                  onChange={(event) =>
                    setBoilerForm({
                      ...boilerForm,
                      type_thresholds: {
                        ...boilerForm.type_thresholds,
                        warm_max_hours: Number(event.target.value),
                      },
                    })
                  }
                />
              </div>
            </div>
          </div>

          {boilerError && <ErrorNotice message={boilerError} className="mt-3" />}
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              className="btn-primary"
              disabled={creatingBoiler || !boilerForm.id.trim() || !boilerForm.name.trim()}
              onClick={() => void createBoiler()}
            >
              {creatingBoiler ? "Adding…" : "Add boiler"}
            </button>
            <span className="text-[10px] text-slate-500">
              {boilers.length} boiler(s) configured · historian access is read-only
            </span>
          </div>
        </Panel>
      )}

      {!showBoilerForm && (
        <>
      {boiler && (
        <BoilerSettingsPanel
          boiler={boiler}
          onSaved={() => {
            setListToken((token) => token + 1);
            void refresh();
          }}
          onDeleted={() => {
            const next = boilers.find((row) => row.id !== boiler.id);
            void refresh();
            if (next) setBoilerId(next.id);
          }}
        />
      )}
      {listError && <ErrorNotice message={listError} onRetry={() => setListToken((token) => token + 1)} />}

      <div className="grid gap-4 xl:grid-cols-3">
        <Panel className="h-fit overflow-hidden">
          <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-4 py-3">
            <div>
              <p className="section-title">Versions</p>
              <p className="mt-0.5 text-[11px] text-slate-500">
                {curves ? `${curves.length} approved curve version(s)` : "loading"}
              </p>
            </div>
            <LayersIcon className="h-4 w-4 text-slate-500" />
          </div>
          {!curves ? (
            <Loading label="Loading curves" />
          ) : curves.length === 0 ? (
            <EmptyState
              icon={<LayersIcon className="h-4 w-4" />}
              title="No approved curve for this boiler"
              description="Extract a procedure below and approve the first version. Startups cannot be scored without an approved curve."
            />
          ) : (
            <ul className="divide-y divide-slate-200/70">
              {curves.map((curve) => {
                const selected = curve.id === selectedId;
                return (
                  <li key={curve.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(curve.id)}
                      className={cn(
                        "w-full px-4 py-3 text-left transition-colors",
                        selected ? "bg-cyan-50" : "hover:bg-slate-50",
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span
                            className={cn(
                              "rounded border px-1.5 py-0.5 font-mono text-[10px]",
                              selected
                                ? "border-cyan-200 bg-cyan-50 text-cyan-700"
                                : "border-slate-300 bg-slate-100 text-slate-600",
                            )}
                          >
                            v{curve.version}
                          </span>
                          <Pill status={curve.status} dot>
                            {curve.status}
                          </Pill>
                          <span
                            className={cn(
                              "chip !px-1.5 !py-0 !text-[9px] capitalize",
                              curve.startup_type === "cold"
                                ? "border-sky-200 bg-sky-50 text-sky-700"
                                : curve.startup_type === "warm"
                                  ? "border-amber-200 bg-amber-50 text-amber-700"
                                  : "border-rose-200 bg-rose-50 text-rose-700",
                            )}
                          >
                            {curve.startup_type ?? "cold"}
                          </span>
                          {curve.id === activeCurveId && (
                            <span className="chip border-cyan-200 bg-cyan-50 !px-1.5 !py-0 !text-[9px] text-cyan-700">
                              active
                            </span>
                          )}
                        </div>
                        <ChevronRightIcon
                          className={cn(
                            "h-4 w-4 shrink-0 transition-colors",
                            selected ? "text-cyan-700" : "text-slate-500",
                          )}
                        />
                      </div>
                      <p className="mt-1 truncate text-[12px] text-slate-700">{curve.name}</p>
                      <p className="mt-0.5 text-[10px] text-slate-500">
                        {curve.document} Rev {curve.revision} · {curve.design_duration_min.toFixed(0)} min
                      </p>
                      <div className="mt-1 flex items-center justify-between gap-2 text-[9px] text-slate-500">
                        <span>{fmtDate(curve.approved_at)}</span>
                        <span className="mono">sha {shortHash(curve.sha256, 10)}</span>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="border-t border-slate-200 px-4 py-3">
            <InfoLine>Approving a new extraction adds a version. It never edits an older curve.</InfoLine>
          </div>
        </Panel>

        {detailError ? (
          <div className="xl:col-span-2">
            <ErrorNotice message={detailError} />
          </div>
        ) : detail ? (
          <div className="min-w-0 xl:col-span-2">
            <CurveDetailPanel
              detail={detail}
              activeCurveId={activeCurveId}
              deleting={deletingCurve}
              onDelete={() => void deleteSelectedCurve()}
            />
          </div>
        ) : selectedId ? (
          <div className="xl:col-span-2">
            <Loading label="Loading the approved curve JSON" />
          </div>
        ) : curves && curves.length > 0 ? (
          <div className="xl:col-span-2">
            <EmptyState title="Select a curve version" description="Pick a version on the left to inspect its JSON." />
          </div>
        ) : (
          <Panel className="p-5 xl:col-span-2">
            <EmptyState
              icon={<LayersIcon className="h-4 w-4" />}
              title="Nothing approved yet"
              description="Use the procedure onboarding panel below to extract the first curve for this boiler."
            />
          </Panel>
        )}
      </div>

      <Panel className="overflow-hidden">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 px-4 py-3">
          <SectionHeading
            eyebrow="Procedure onboarding"
            title="Extract a curve from the approved document"
            description="AI reads the PDF or photo and transcribes fields against a fixed template. Every number must appear in a verbatim quote; anything unresolved is flagged. It never invents a limit or a tolerance."
          />
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-[10px] font-medium uppercase tracking-[0.14em] text-slate-500">
              Curve for boiler
            </label>
            <select
              className="rounded-md border border-slate-300 bg-white px-2 py-1 text-[11px] text-slate-700 outline-none focus:border-cyan-400"
              value={boilerId}
              onChange={(event) => setBoilerId(event.target.value)}
            >
              {boilers.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.id} · {row.name}
                </option>
              ))}
              {!boilers.length && <option value={boilerId}>{boilerId}</option>}
            </select>
            <span className="chip border-slate-300 bg-slate-100 text-slate-600">
              {boiler?.curve ? `v${boiler.curve.version} active` : "no approved curve yet"}
            </span>
          </div>
          <span className="chip border-amber-200 bg-amber-50 text-amber-800">
            <ShieldIcon className="h-3 w-3 text-amber-600" /> human approval required
          </span>
        </div>

        <div className="grid gap-0 divide-y divide-slate-200 lg:grid-cols-2 lg:divide-x lg:divide-y-0">
          <div className="p-4">
            <div className="mb-3 flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={() => setSourceMode("paste")}
                className={cn(
                  "rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors",
                  sourceMode === "paste"
                    ? "bg-cyan-50 text-cyan-800 ring-1 ring-inset ring-cyan-200"
                    : "text-slate-500 hover:bg-slate-100 hover:text-slate-700",
                )}
              >
                <FileTextIcon className="mr-1 inline h-3.5 w-3.5" /> Paste text
              </button>
              <button
                type="button"
                onClick={() => setSourceMode("drawing")}
                className={cn(
                  "rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors",
                  sourceMode === "drawing"
                    ? "bg-violet-50 text-violet-800 ring-1 ring-inset ring-violet-200"
                    : "text-slate-500 hover:bg-slate-100 hover:text-slate-700",
                )}
              >
                <LayersIcon className="mr-1 inline h-3.5 w-3.5" /> Curve drawing
              </button>
              <button
                type="button"
                className="ml-auto rounded-md px-2 py-1 text-[10px] text-slate-500 transition-colors hover:text-cyan-700"
                onClick={() => void loadDemoText()}
                disabled={sopLoading}
              >
                {sopLoading ? "Loading…" : "Load bundled SOP-202"}
              </button>
            </div>

            {sourceMode === "drawing" ? (
              <div className="space-y-3">
                <div
                  className="rounded-xl border-2 border-dashed border-violet-200 bg-violet-50/40 px-4 py-6 text-center"
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.preventDefault();
                    const file = event.dataTransfer.files?.[0];
                    if (file) void extractFromCurve(file);
                  }}
                >
                  <LayersIcon className="mx-auto h-6 w-6 text-violet-600" />
                  <p className="mt-2 text-sm font-medium text-slate-800">
                    Paste, drag, or choose a curve drawing
                  </p>
                  <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
                    Press <span className="mono rounded bg-white px-1">Ctrl/Cmd + V</span> to paste
                    a screenshot, drag a PNG/JPG here, or upload a PDF. Gemini reads the axes,
                    event markers, rated labels and breakpoints; every result needs human review.
                  </p>
                  <label className="btn-primary mt-3 inline-flex cursor-pointer">
                    {extracting ? "Digitizing…" : "Select drawing"}
                    <input
                      type="file"
                      accept=".pdf,.png,.jpg,.jpeg,.webp,application/pdf,image/*"
                      className="hidden"
                      disabled={extracting}
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) void extractFromCurve(file);
                        event.target.value = "";
                      }}
                    />
                  </label>
                </div>
                <div className="rounded-lg border border-violet-200 bg-white px-3 py-2.5 text-[10px] leading-relaxed text-slate-600">
                  <p className="font-medium text-violet-800">Vision workflow</p>
                  <p className="mt-1">
                    1. Title block, axes and printed end values are transcribed. 2. Each Y axis is
                    calibrated independently. 3. Breakpoints are extracted and checked against the
                    printed values. 4. Uncertain readings become review flags before approval.
                  </p>
                </div>
              </div>
            ) : sourceMode === "paste" ? (
              <>
                <label className="label">Procedure text</label>
                <textarea
                  className="input min-h-[220px] resize-y font-mono text-[11px] leading-relaxed"
                  value={sopText}
                  onChange={(event) => setSopText(event.target.value)}
                  placeholder="Paste the approved startup procedure here. The extractor recognises document headers, phase durations, ramp rates, control bands, abort limits and prerequisites."
                />
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                  <span className="text-[10px] text-slate-500">
                    {sopText.length.toLocaleString()} characters · boiler {boilerId}
                  </span>
                  <button
                    type="button"
                    className="btn-primary"
                    onClick={() => void extractFromText()}
                    disabled={extracting || sopText.trim().length < 20}
                  >
                    {extracting ? "Extracting…" : "Extract fields"}
                  </button>
                </div>
              </>
            ) : (
              <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center">
                <UploadIcon className="mx-auto h-6 w-6 text-slate-500" />
                <p className="mt-2 text-sm font-medium text-slate-700">Choose a procedure file</p>
                <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
                  PDF, exported text, or a photo/scan (PNG, JPG, WebP), up to 5 MB. PDFs and images
                  are read by Gemini; images need a configured API key. The file hash is stored with
                  the curve so the approved version can be traced back to the document.
                </p>
                <label className="btn-primary mt-3 inline-flex cursor-pointer">
                  {extracting ? "Extracting…" : "Select file"}
                  <input
                    type="file"
                    accept=".pdf,.txt,.md,.png,.jpg,.jpeg,.webp,application/pdf,image/*"
                    className="hidden"
                    disabled={extracting}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) void extractFromFile(file);
                      event.target.value = "";
                    }}
                  />
                </label>
              </div>
            )}

            {sourcePreview && (
              <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-2">
                <div className="mb-1 flex items-center justify-between gap-2 text-[10px] text-slate-500">
                  <span className="truncate">{sourcePreview.name}</span>
                  <a
                    href={sourcePreview.url}
                    target="_blank"
                    rel="noreferrer"
                    className="shrink-0 text-cyan-700 hover:text-cyan-900"
                  >
                    Open
                  </a>
                </div>
                {sourcePreview.kind.startsWith("image/") ? (
                  <img
                    src={sourcePreview.url}
                    alt="Uploaded curve source"
                    className="max-h-64 w-full rounded object-contain"
                  />
                ) : (
                  <p className="text-[10px] text-slate-500">
                    Preview is available in a new tab for PDFs and text files.
                  </p>
                )}
              </div>
            )}

            {extractError && <ErrorNotice message={extractError} className="mt-3" />}
          </div>

          <div className="p-4">
            {!extraction ? (
              <EmptyState
                icon={<FileTextIcon className="h-4 w-4" />}
                title="No extraction yet"
                description="Paste the procedure or upload a file. Extracted values are shown with the exact source line so a reviewer can check each one."
              />
            ) : (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                      Extraction result
                    </p>
                    <p className="mt-0.5 text-[11px] text-slate-600">
                      {extraction.document.document} Rev {extraction.document.revision} ·{" "}
                      {signalCount} signals · {extraction.extracted.length} fields
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span
                      className={cn(
                        "chip",
                        extraction.ai
                          ? "border-violet-200 bg-violet-50 text-violet-700"
                          : "border-slate-200 bg-slate-100 text-slate-600",
                      )}
                      title={
                        extraction.ai
                          ? "Gemini transcribed the document. Every accepted number appears in a verbatim quote; rejected facts are listed below."
                          : "Local deterministic parser. No AI was used for this document."
                      }
                    >
                      {extraction.ai ? "AI transcription" : "Deterministic parser"}
                    </span>
                    <Pill status={extraction.warnings.length ? "watch" : "ok"} dot>
                      {extraction.warnings.length
                        ? `${extraction.warnings.length} warning(s)`
                        : "no warnings"}
                    </Pill>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2 text-[10px] sm:grid-cols-4">
                  <div className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5">
                    <p className="uppercase tracking-wider text-slate-500">File</p>
                    <p className="mt-0.5 truncate text-slate-700">{extraction.document.file_name}</p>
                  </div>
                  <div className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5">
                    <p className="uppercase tracking-wider text-slate-500">Equipment</p>
                    <p className="mt-0.5 text-slate-700">{extraction.document.equipment ?? "—"}</p>
                  </div>
                  <div className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5">
                    <p className="uppercase tracking-wider text-slate-500">Characters</p>
                    <p className="mt-0.5 text-slate-700">
                      {extraction.document.characters.toLocaleString()}
                    </p>
                  </div>
                  <div className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5">
                    <p className="uppercase tracking-wider text-slate-500">Text hash</p>
                    <p className="mono mt-0.5 truncate text-slate-600">
                      {shortHash(extraction.document.text_sha256, 14)}
                    </p>
                  </div>
                </div>

                {extraction.ai && (
                  <div className="rounded-lg border border-violet-200 bg-violet-50/60 px-3 py-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-[11px] font-medium text-violet-800">
                        {extraction.ai.model ?? "Gemini"} · grounded transcription
                      </p>
                      <span className="mono text-[10px] text-violet-700">
                        {extraction.ai.attempts ?? 1} attempt(s)
                        {extraction.ai.latency_s !== undefined
                          ? ` · ${extraction.ai.latency_s.toFixed(1)} s`
                          : ""}
                      </span>
                    </div>
                    <p className="mt-1 text-[10px] leading-relaxed text-violet-700">
                      {extraction.ai.fact_counts
                        ? `${extraction.ai.fact_counts.applied} of ${extraction.ai.fact_counts.proposed} proposed fact(s) were accepted; ${extraction.ai.fact_counts.rejected} were rejected because they could not be verified against the quoted text.`
                        : "Every accepted fact is anchored to a verbatim quote."}{" "}
                      The model does not choose limits or tolerances — the approved template does.
                      A person still has to approve the draft below.
                    </p>
                  </div>
                )}

                <div className="rounded-lg border border-slate-200 bg-white p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                        Parameters to watch
                      </p>
                      <p className="mt-0.5 text-[10px] text-slate-500">
                        Extracted from the document. Assign the real historian tag before approval.
                      </p>
                    </div>
                    <span className="text-[10px] text-slate-500">
                      {extraction.draft.signals.length} parameter(s)
                    </span>
                  </div>
                  <div className="mt-2 space-y-1.5">
                    {extraction.draft.signals.map((signal) => (
                      <div
                        key={signal.key}
                        className="grid gap-2 rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-[11px] font-medium text-slate-700">
                            {signal.label}
                          </p>
                          <p className="mono text-[9px] text-slate-500">
                            {signal.key} · {signal.unit || "state"} · {signal.limits.length} limit(s)
                          </p>
                        </div>
                        <input
                          className="input !py-1 text-[11px]"
                          value={parameterTags[signal.key] ?? ""}
                          onChange={(event) =>
                            setParameterTags({
                              ...parameterTags,
                              [signal.key]: event.target.value,
                            })
                          }
                          placeholder={`Historian tag, e.g. B101.${signal.key.toUpperCase()}`}
                        />
                      </div>
                    ))}
                  </div>
                </div>

                {extraction.unknowns.length > 0 && (
                  <div className="rounded-lg border border-slate-200 bg-white p-3">
                    <p className="flex items-center gap-1.5 text-[11px] font-medium text-slate-700">
                      <InfoIcon className="h-3.5 w-3.5 text-slate-500" /> Not found in the document
                    </p>
                    <ul className="mt-1.5 space-y-1">
                      {extraction.unknowns.map((item, index) => (
                        <li key={index} className="text-[11px] leading-relaxed text-slate-500">
                          · {item}
                        </li>
                      ))}
                    </ul>
                    <p className="mt-1.5 text-[10px] text-slate-500">
                      The template value was kept for these fields. Confirm each one before approval.
                    </p>
                  </div>
                )}

                {extraction.warnings.length > 0 && (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
                    <p className="flex items-center gap-1.5 text-[11px] font-medium text-amber-800">
                      <AlertIcon className="h-3.5 w-3.5" /> Review before approval
                    </p>
                    <ul className="mt-1.5 space-y-1">
                      {extraction.warnings.map((warning, index) => (
                        <li key={index} className="text-[11px] leading-relaxed text-amber-700">
                          · {warning}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <div className="max-h-[300px] overflow-auto rounded-lg border border-slate-200">
                  <table className="data-table min-w-[520px]">
                    <thead className="sticky top-0 bg-white/95 backdrop-blur">
                      <tr>
                        <th>Field</th>
                        <th>Value</th>
                        <th>Confidence</th>
                        <th>Source line</th>
                      </tr>
                    </thead>
                    <tbody>
                      {extraction.extracted.map((field, index) => (
                        <tr key={`${field.field}-${index}`}>
                          <td className="mono text-slate-600">{field.field}</td>
                          <td className="mono text-slate-800">{field.value}</td>
                          <td>
                            <span
                              className={cn(
                                "mono",
                                field.confidence >= 0.95
                                  ? "text-emerald-700"
                                  : field.confidence >= 0.85
                                    ? "text-amber-700"
                                    : "text-rose-700",
                              )}
                            >
                              {(field.confidence * 100).toFixed(0)}%
                            </span>
                          </td>
                          <td className="max-w-[260px]">
                            <p className="truncate text-[10px] text-slate-500" title={field.source_line}>
                              {field.source_line}
                            </p>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <button
                  type="button"
                  className="flex items-center gap-1.5 text-[10px] text-slate-500 transition-colors hover:text-slate-700"
                  onClick={() => setShowDraft((value) => !value)}
                >
                  <ChevronDownIcon
                    className={cn("h-3 w-3 transition-transform", showDraft && "rotate-180")}
                  />
                  {showDraft ? "Hide draft JSON" : "Show draft JSON"}
                </button>
                {showDraft && (
                  <pre className="max-h-[320px] overflow-auto rounded-lg border border-slate-200 bg-slate-50 p-3 font-mono text-[10px] leading-relaxed text-slate-600">
                    {JSON.stringify(extraction.draft, null, 2)}
                  </pre>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="border-t border-slate-200 bg-white p-4">
          <div className="grid gap-4 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <p className="section-title mb-2">Approval checklist</p>
              <div className="space-y-2">
                {[
                  {
                    key: "transcription" as const,
                    title: "Transcribed values match the signed procedure",
                    detail:
                      "A reviewer has compared the extracted fields and source lines against the controlled document.",
                  },
                  {
                    key: "limits" as const,
                    title: "Every limit cites the procedure and none were inferred",
                    detail:
                      "Limits come from the document. Reporting tolerances are analytics defaults and are not safety limits.",
                  },
                  {
                    key: "advisory" as const,
                    title: "I understand this is advisory, not a control system",
                    detail:
                      "Approval versions the curve for comparison. It does not authorise a startup or certify safe operation.",
                  },
                ].map((item) => (
                  <label
                    key={item.key}
                    className={cn(
                      "flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 transition-colors",
                      checks[item.key]
                        ? "border-emerald-200 bg-emerald-50"
                        : "border-slate-200 bg-slate-50 hover:border-slate-300",
                    )}
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-emerald-500"
                      checked={checks[item.key]}
                      onChange={(event) =>
                        setChecks({ ...checks, [item.key]: event.target.checked })
                      }
                    />
                    <span>
                      <span className="block text-[11px] font-medium text-slate-800">{item.title}</span>
                      <span className="mt-0.5 block text-[10px] leading-relaxed text-slate-500">
                        {item.detail}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </div>

            <div>
              <label className="label">Curve startup type</label>
              <div className="mb-3 flex rounded-md border border-slate-200 bg-slate-50 p-0.5 text-[11px]">
                {(["cold", "warm", "hot"] as const).map((type) => (
                  <button
                    key={type}
                    type="button"
                    onClick={() => setApproveType(type)}
                    className={cn(
                      "flex-1 rounded px-2 py-1 capitalize transition-colors",
                      approveType === type
                        ? "bg-white text-cyan-800 shadow-sm"
                        : "text-slate-500 hover:text-slate-700",
                    )}
                  >
                    {type}
                  </button>
                ))}
              </div>
              <label className="label">Approved by</label>
              <input
                className="input"
                value={approvedBy}
                onChange={(event) => setApprovedBy(event.target.value)}
                placeholder="shift.engineer"
              />
              <button
                type="button"
                className="btn-primary mt-3 w-full"
                disabled={!canApprove}
                onClick={() => void approve()}
              >
                <CheckIcon className="h-4 w-4" />
                {approving ? "Approving…" : "Approve as new version"}
              </button>
              <p className="mt-2 text-[10px] leading-relaxed text-slate-500">
                {extraction
                  ? "The draft is validated by the same schema the analytics engine consumes. Invalid curves are rejected."
                  : "Extract a procedure first."}
              </p>
              {approveError && <ErrorNotice message={approveError} className="mt-3" />}
              {approveResult && (
                <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3">
                  <p className="flex items-center gap-1.5 text-[11px] font-medium text-emerald-800">
                    <CheckIcon className="h-3.5 w-3.5" /> {approveResult.curve.id} approved
                  </p>
                  <p className="mt-1 text-[10px] leading-relaxed text-emerald-700">
                    {approveResult.message}
                  </p>
                  <div className="mt-2 flex items-center gap-2">
                    <span className="mono rounded border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] text-emerald-700">
                      v{approveResult.curve.version}
                    </span>
                    <Link
                      to="/live"
                      className="inline-flex items-center gap-1 text-[10px] text-emerald-700 transition-colors hover:text-emerald-900"
                    >
                      Run against it <ArrowUpRightIcon className="h-3 w-3" />
                    </Link>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </Panel>

      <div className="flex flex-wrap items-center justify-between gap-3 text-[10px] text-slate-500">
        <InfoLine>
          Extraction is source-anchored: AI or the local parser only transcribes, and every number is
          checked against the document. The approval step is human. Nothing on this page writes to the
          DCS or changes a running plant.
        </InfoLine>
        <span className="mono">
          schema {extraction?.draft.schema_version ?? "design-curve/v1"} · {curves?.length ?? 0} version(s)
        </span>
      </div>
        </>
      )}

      <AdvisoryNotice />
    </div>
  );
}
