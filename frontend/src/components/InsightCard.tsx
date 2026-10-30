import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { api } from "../lib/api";
import { fmt, fmtSigned, shortHash } from "../lib/format";
import { severityTone } from "../lib/theme";
import type { InsightPayload, InsightRecord } from "../lib/types";
import {
  AlertIcon,
  ArrowUpRightIcon,
  CheckIcon,
  ChevronDownIcon,
  FileTextIcon,
  SparklesIcon,
  XIcon,
} from "./icons";
import { cn, ErrorNotice, EvidenceChips, InfoLine, Loading, Panel } from "./ui";

const DISCLAIMER =
  "Advisory only. This explanation is generated from the evidence above and does not determine whether the boiler is safe to operate. The shift engineer remains responsible for every operating decision.";

const BRAND = (
  <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-violet-200 bg-violet-50 text-violet-700">
    <SparklesIcon className="h-4 w-4" />
  </span>
);

function ProviderBadge({ record }: { record: InsightRecord }) {
  const provider = record.meta.provider;
  const tone =
    provider === "gemini"
      ? "border-violet-200 bg-violet-50 text-violet-700"
      : provider === "gemini-fallback"
        ? "border-amber-200 bg-amber-50 text-amber-700"
        : "border-slate-300 bg-slate-100 text-slate-600";
  const label =
    provider === "gemini"
      ? "Gemini"
      : provider === "gemini-fallback"
        ? "Gemini → fallback"
        : "Deterministic template";
  return <span className={cn("chip", tone)}>{label}</span>;
}

function ValidationBadge({ status }: { status: string }) {
  if (status === "validated") {
    return (
      <span className="chip border-emerald-200 bg-emerald-50 text-emerald-700">
        <CheckIcon className="h-3 w-3" /> validated
      </span>
    );
  }
  if (status === "fallback") {
    return (
      <span className="chip border-amber-200 bg-amber-50 text-amber-700">
        <AlertIcon className="h-3 w-3" /> fallback
      </span>
    );
  }
  return (
    <span className="chip border-slate-300 bg-slate-100 text-slate-600">deterministic</span>
  );
}

function FallbackWarning({ record }: { record: InsightRecord }) {
  if (record.meta.validation.status !== "fallback") return null;
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-700">
      <span className="font-medium text-amber-800">Deterministic fallback.</span>{" "}
      {record.meta.validation.notes[record.meta.validation.notes.length - 1] ??
        "The model response failed validation."}
    </div>
  );
}

function TimelineSection({ insight }: { insight: InsightPayload }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 p-3.5">
      <p className="section-title mb-2.5">Timeline</p>
      {insight.timeline.length ? (
        <ol className="space-y-2.5">
          {insight.timeline.map((item, index) => (
            <li key={`${item.event}-${index}`} className="relative border-l border-slate-200 pl-3">
              <span className="absolute -left-[3px] top-1.5 h-1.5 w-1.5 rounded-full bg-sky-500" />
              <p className="mono text-slate-500">
                {item.t_min === null ? "—" : `${fmt(item.t_min, 1)} min`}
              </p>
              <p className="mt-0.5 text-[11px] leading-relaxed text-slate-600">{item.event}</p>
              <div className="mt-1">
                <EvidenceChips ids={item.evidence_ids} />
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-xs text-slate-500">No timeline events were cited.</p>
      )}
    </div>
  );
}

function DeviationsSection({
  insight,
  limit,
}: {
  insight: InsightPayload;
  limit?: number;
}) {
  const rows = limit ? insight.deviations.slice(0, limit) : insight.deviations;
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 p-3.5">
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <p className="section-title">Deviations</p>
        {limit && insight.deviations.length > limit && (
          <span className="text-[10px] text-slate-500">+{insight.deviations.length - limit} more</span>
        )}
      </div>
      {rows.length ? (
        <div className="space-y-2">
          {rows.map((item, index) => {
            const tone = severityTone(item.severity);
            return (
              <div
                key={`${item.signal}-${index}`}
                className={cn("rounded-lg border px-3 py-2", tone.border, tone.bg)}
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[11px] font-medium text-slate-800">{item.signal}</p>
                  <span className={cn("text-[9px] uppercase tracking-wider", tone.text)}>
                    {item.severity}
                  </span>
                </div>
                <p className="mt-1 text-[11px] leading-relaxed text-slate-600">{item.what}</p>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  {item.when_min !== null && (
                    <span className="mono text-slate-500">t={fmt(item.when_min, 1)}</span>
                  )}
                  {item.source_ref && (
                    <span className="mono rounded bg-white px-1.5 py-0.5 text-slate-500">
                      {item.source_ref}
                    </span>
                  )}
                  <EvidenceChips ids={item.evidence_ids} />
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="text-xs text-slate-500">No deviations were cited.</p>
      )}
    </div>
  );
}

function FactorsSection({ insight }: { insight: InsightPayload }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 p-3.5">
      <p className="section-title mb-2.5">Contributing factors</p>
      {insight.contributing_factors.length ? (
        <div className="space-y-2.5">
          {insight.contributing_factors.map((factor, index) => (
            <div key={index} className="rounded-lg border border-slate-200 bg-slate-50 p-2.5">
              <div className="flex items-start justify-between gap-2">
                <p className="text-[11px] leading-relaxed text-slate-700">{factor.hypothesis}</p>
                <span
                  className={cn(
                    "chip shrink-0 !px-1.5 !py-0 !text-[9px]",
                    factor.confidence === "high"
                      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                      : factor.confidence === "medium"
                        ? "border-amber-200 bg-amber-50 text-amber-700"
                        : "border-slate-300 bg-slate-100 text-slate-600",
                  )}
                >
                  {factor.confidence}
                </span>
              </div>
              {factor.support.length > 0 && (
                <ul className="mt-1.5 space-y-0.5">
                  {factor.support.map((line, supportIndex) => (
                    <li
                      key={supportIndex}
                      className="flex gap-1.5 text-[10px] leading-relaxed text-slate-500"
                    >
                      <span className="text-slate-500">+</span>
                      {line}
                    </li>
                  ))}
                </ul>
              )}
              {factor.contradicting.length > 0 && (
                <ul className="mt-1 space-y-0.5">
                  {factor.contradicting.map((line, contradictIndex) => (
                    <li
                      key={contradictIndex}
                      className="flex gap-1.5 text-[10px] leading-relaxed text-slate-500"
                    >
                      <span className="text-rose-600">−</span>
                      {line}
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-1.5">
                <EvidenceChips ids={factor.evidence_ids} />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-slate-500">No contributing factors were proposed.</p>
      )}
    </div>
  );
}

function GapsChecksSection({ insight }: { insight: InsightPayload }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="rounded-xl border border-slate-200 bg-slate-50 p-3.5">
        <p className="section-title mb-2">Data gaps &amp; unknowns</p>
        {insight.data_gaps.length ? (
          <ul className="space-y-1.5">
            {insight.data_gaps.map((gap, index) => (
              <li key={index} className="flex gap-2 text-[11px] leading-relaxed text-slate-600">
                <AlertIcon className="mt-0.5 h-3 w-3 shrink-0 text-amber-600" />
                {gap}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-slate-500">No data gaps were reported.</p>
        )}
      </div>
      <div className="rounded-xl border border-slate-200 bg-slate-50 p-3.5">
        <p className="section-title mb-2">Recommended checks</p>
        {insight.recommended_checks.length ? (
          <ul className="space-y-1.5">
            {insight.recommended_checks.map((check, index) => (
              <li key={index} className="flex gap-2 text-[11px] leading-relaxed text-slate-600">
                <CheckIcon className="mt-0.5 h-3 w-3 shrink-0 text-cyan-600" />
                {check}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-slate-500">No follow-up checks were proposed.</p>
        )}
      </div>
    </div>
  );
}

function MetaSection({ record }: { record: InsightRecord }) {
  const { meta } = record;
  return (
    <div className="grid gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3.5 text-[11px] text-slate-500 sm:grid-cols-2 lg:grid-cols-4">
      <div>
        <p className="text-[9px] uppercase tracking-wider text-slate-500">Evidence hash</p>
        <p className="mono mt-0.5 text-slate-600">{shortHash(meta.evidence_hash, 16)}</p>
      </div>
      <div>
        <p className="text-[9px] uppercase tracking-wider text-slate-500">Prompt version</p>
        <p className="mono mt-0.5 text-slate-600">{meta.prompt_version}</p>
      </div>
      <div>
        <p className="text-[9px] uppercase tracking-wider text-slate-500">Generated</p>
        <p className="mt-0.5 text-slate-600">{fmt(meta.latency_s, 2)} s latency</p>
      </div>
      <div>
        <p className="text-[9px] uppercase tracking-wider text-slate-500">Authority</p>
        <p className="mt-0.5 text-slate-600">advisory, never authoritative</p>
      </div>
      {meta.validation.notes.length > 0 && (
        <div className="sm:col-span-2 lg:col-span-4">
          <p className="text-[9px] uppercase tracking-wider text-slate-500">Validation notes</p>
          <ul className="mt-1 space-y-0.5">
            {meta.validation.notes.map((note, index) => (
              <li key={index} className="leading-relaxed">
                · {note}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function MissingInsight({
  compact,
  loading,
  error,
  llmConfigured,
  onGenerate,
}: {
  compact: boolean;
  loading: boolean;
  error: string | null;
  llmConfigured: boolean;
  onGenerate: () => void;
}) {
  const button = (
    <button
      type="button"
      className={cn("btn-primary", compact && "!py-1.5 text-xs")}
      onClick={onGenerate}
      disabled={loading}
    >
      <SparklesIcon className={compact ? "h-3.5 w-3.5" : "h-4 w-4"} />
      {loading ? "Generating…" : compact ? "Generate" : "Generate explanation"}
    </button>
  );

  if (compact) {
    return (
      <Panel className="p-4">
        <div className="flex items-center gap-2.5">
          {BRAND}
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-slate-900">AI explanation</h2>
            <p className="text-[10px] text-slate-500">grounded in the evidence bundle</p>
          </div>
          {button}
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-slate-600">
          Explains the deviations and priorities already produced by deterministic analytics. It
          cannot add limits or decide whether the boiler is safe to operate.
        </p>
        {error && <ErrorNotice message={error} className="mt-2 !px-3 !py-2 text-xs" />}
        {loading && <Loading label="Grounding the explanation" />}
        <p className="mt-2 text-[10px] leading-relaxed text-slate-500">
          {llmConfigured
            ? "Gemini is configured; an invalid response falls back to a validated template."
            : "Gemini is not configured here, so a deterministic validated template is used."}
        </p>
      </Panel>
    );
  }

  return (
    <Panel className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-violet-200 bg-violet-50 text-violet-700">
            <SparklesIcon className="h-4 w-4" />
          </span>
          <div>
            <h2 className="text-sm font-semibold text-slate-900">AI explanation</h2>
            <p className="mt-0.5 max-w-xl text-xs leading-relaxed text-slate-500">
              The model receives the deterministic evidence bundle only. It explains and
              prioritises; it cannot add limits, calculate safety margins or decide whether the
              boiler is safe to operate.
            </p>
          </div>
        </div>
        {button}
      </div>

      {error && <ErrorNotice message={error} className="mt-4" />}
      {loading && <Loading label="Grounding the explanation in the evidence bundle" />}

      {!loading && (
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
              Input
            </p>
            <p className="mt-1 text-[11px] leading-relaxed text-slate-600">
              Deviation statements, limit source references, milestones and data quality. No raw
              historian streams.
            </p>
          </div>
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
              Validation
            </p>
            <p className="mt-1 text-[11px] leading-relaxed text-slate-600">
              Every number must exist in the evidence corpus, every evidence id must resolve, and
              safety verdict language is rejected.
            </p>
          </div>
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
              Fallback
            </p>
            <p className="mt-1 text-[11px] leading-relaxed text-slate-600">
              {llmConfigured
                ? "Gemini is configured. If a response fails validation three times, a deterministic template is used instead."
                : "Gemini is not configured in this environment. A deterministic, validated template is used instead."}
            </p>
          </div>
        </div>
      )}

      <div className="mt-4">
        <InfoLine>
          The explanation is cached by evidence hash, model and prompt version, so it is only
          regenerated when the underlying startup evidence changes.
        </InfoLine>
      </div>
    </Panel>
  );
}

function InsightDrawer({
  open,
  onClose,
  record,
  onGenerate,
  loading,
  error,
}: {
  open: boolean;
  onClose: () => void;
  record: InsightRecord;
  onGenerate: () => void;
  loading: boolean;
  error: string | null;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (!open) return null;
  const { insight, meta } = record;

  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end">
      <button
        type="button"
        aria-label="Close AI explanation"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-slate-900/20 backdrop-blur-[1px]"
      />
      <aside className="relative flex h-full w-full max-w-xl flex-col border-l border-slate-200 bg-white shadow-[-24px_0_60px_-30px_rgba(15,23,42,0.4)]">
        <header className="flex items-start gap-2.5 border-b border-slate-200 px-5 py-4">
          {BRAND}
          <div className="min-w-0 flex-1">
            <p className="section-title mb-0.5">AI explanation</p>
            <h2 className="text-sm font-semibold text-slate-900">Full evidence</h2>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <ProviderBadge record={record} />
              <ValidationBadge status={meta.validation.status} />
              <span className="mono rounded border border-slate-200 bg-white px-1.5 py-0.5 text-slate-500">
                {meta.model}
              </span>
            </div>
          </div>
          <button
            type="button"
            className="rounded-lg border border-slate-200 bg-white p-1.5 text-slate-500 transition-colors hover:border-slate-300 hover:text-slate-800"
            onClick={onGenerate}
            disabled={loading}
            title="Regenerate explanation"
            aria-label="Regenerate explanation"
          >
            <SparklesIcon className={cn("h-4 w-4", loading && "animate-pulse")} />
          </button>
          <button
            type="button"
            className="rounded-lg border border-slate-200 bg-white p-1.5 text-slate-500 transition-colors hover:border-slate-300 hover:text-slate-800"
            onClick={onClose}
            aria-label="Close"
          >
            <XIcon className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4 scrollbar-thin">
          {error && <ErrorNotice message={error} />}
          <FallbackWarning record={record} />
          <p className="text-[13px] leading-relaxed text-slate-700">{insight.summary}</p>
          <TimelineSection insight={insight} />
          <DeviationsSection insight={insight} />
          <FactorsSection insight={insight} />
          <GapsChecksSection insight={insight} />
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-[11px] leading-relaxed text-amber-700">
            {insight.disclaimer || DISCLAIMER}
          </div>
          <MetaSection record={record} />
        </div>
      </aside>
    </div>,
    document.body,
  );
}

function CompactInsight({
  record,
  loading,
  error,
  onGenerate,
}: {
  record: InsightRecord;
  loading: boolean;
  error: string | null;
  onGenerate: () => void;
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { insight, meta } = record;

  return (
    <Panel className="overflow-hidden">
      <div className="flex items-start gap-2.5 border-b border-slate-200 px-4 py-3">
        {BRAND}
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-slate-900">AI explanation</h2>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <ProviderBadge record={record} />
            <ValidationBadge status={meta.validation.status} />
          </div>
        </div>
        <button
          type="button"
          className="rounded-md border border-slate-200 bg-white p-1.5 text-slate-500 transition-colors hover:border-slate-300 hover:text-slate-800"
          onClick={onGenerate}
          disabled={loading}
          title="Regenerate explanation"
          aria-label="Regenerate explanation"
        >
          <SparklesIcon className={cn("h-3.5 w-3.5", loading && "animate-pulse")} />
        </button>
      </div>

      <div className="space-y-3 px-4 py-3">
        {error && <ErrorNotice message={error} className="!px-3 !py-2 text-xs" />}
        <FallbackWarning record={record} />
        <p className="text-[12px] leading-relaxed text-slate-700">{insight.summary}</p>

        <DeviationsSection insight={insight} limit={2} />

        {insight.recommended_checks.length > 0 && (
          <div className="rounded-lg border border-cyan-200 bg-cyan-50/60 px-3 py-2">
            <p className="mb-1 text-[9px] font-semibold uppercase tracking-[0.14em] text-cyan-800">
              Recommended checks
            </p>
            <ul className="space-y-1">
              {insight.recommended_checks.slice(0, 3).map((check, index) => (
                <li key={index} className="flex gap-1.5 text-[11px] leading-relaxed text-slate-600">
                  <CheckIcon className="mt-0.5 h-3 w-3 shrink-0 text-cyan-600" />
                  {check}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[10px] leading-relaxed text-amber-700">
          {insight.disclaimer || DISCLAIMER}
        </div>

        <button
          type="button"
          className="flex w-full items-center justify-between gap-2 rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-[10px] text-slate-500 transition-colors hover:border-slate-300 hover:text-slate-700"
          onClick={() => setDrawerOpen(true)}
        >
          <span className="flex items-center gap-1.5">
            <FileTextIcon className="h-3 w-3" />
            View full evidence
          </span>
          <ArrowUpRightIcon className="h-3 w-3" />
        </button>

        <div className="flex flex-wrap items-center gap-2 text-[9px] text-slate-500">
          <span className="mono">sha {shortHash(meta.evidence_hash, 16)}</span>
          <span className="text-slate-300">·</span>
          <span className="mono">{meta.model}</span>
          <span className="text-slate-300">·</span>
          <span className="mono">{fmt(meta.latency_s, 2)} s</span>
          <span className="text-slate-300">·</span>
          <span>advisory, never authoritative</span>
        </div>
      </div>

      <InsightDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        record={record}
        onGenerate={onGenerate}
        loading={loading}
        error={error}
      />
    </Panel>
  );
}

function SummaryInsight({
  record,
  loading,
  error,
  onGenerate,
}: {
  record: InsightRecord;
  loading: boolean;
  error: string | null;
  onGenerate: () => void;
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { insight, meta } = record;

  return (
    <Panel className="overflow-hidden">
      <div className="flex items-start gap-2.5 px-3.5 py-2.5">
        {BRAND}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <h2 className="text-[12px] font-semibold text-slate-900">AI explanation</h2>
            <ProviderBadge record={record} />
            <ValidationBadge status={meta.validation.status} />
          </div>
          <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-slate-600">
            {insight.summary}
          </p>
          <p className="mt-1 text-[9px] text-slate-500">
            Advisory only · {insight.deviations.length} deviation(s) cited · never a safety
            determination
          </p>
        </div>
        <button
          type="button"
          className="btn-ghost !py-1 !text-[10px] shrink-0"
          onClick={() => setDrawerOpen(true)}
        >
          <FileTextIcon className="h-3 w-3" /> AI details
        </button>
      </div>
      {error && <ErrorNotice message={error} className="mx-3.5 mb-2 !px-3 !py-2 text-xs" />}
      <InsightDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        record={record}
        onGenerate={onGenerate}
        loading={loading}
        error={error}
      />
    </Panel>
  );
}

export function InsightCard({
  startupId,
  initial,
  llmConfigured,
  variant = "full",
}: {
  startupId: string;
  initial: InsightRecord | null;
  llmConfigured: boolean;
  variant?: "full" | "compact" | "summary";
}) {
  const [record, setRecord] = useState<InsightRecord | null>(initial);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showMeta, setShowMeta] = useState(false);
  const compact = variant === "compact";

  useEffect(() => {
    setRecord(initial);
    setError(null);
  }, [initial, startupId]);

  async function generate() {
    setLoading(true);
    setError(null);
    try {
      const response = await api.generateInsight(startupId);
      setRecord(response.record);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not generate the explanation");
    } finally {
      setLoading(false);
    }
  }

  if (!record) {
    return (
      <MissingInsight
        compact={compact}
        loading={loading}
        error={error}
        llmConfigured={llmConfigured}
        onGenerate={() => void generate()}
      />
    );
  }

  if (variant === "summary") {
    return (
      <SummaryInsight
        record={record}
        loading={loading}
        error={error}
        onGenerate={() => void generate()}
      />
    );
  }

  if (compact) {
    return (
      <CompactInsight
        record={record}
        loading={loading}
        error={error}
        onGenerate={() => void generate()}
      />
    );
  }

  const { insight, meta } = record;

  return (
    <Panel className="overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-violet-200 bg-violet-50 text-violet-700">
            <SparklesIcon className="h-4 w-4" />
          </span>
          <div>
            <h2 className="text-sm font-semibold text-slate-900">AI explanation</h2>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <ProviderBadge record={record} />
              <ValidationBadge status={meta.validation.status} />
              <span className="mono rounded border border-slate-200 bg-white px-1.5 py-0.5 text-slate-500">
                {meta.model}
              </span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="btn-ghost !py-1.5 text-xs"
            onClick={() => void generate()}
            disabled={loading}
          >
            <SparklesIcon className="h-3.5 w-3.5" />
            {loading ? "Regenerating…" : "Regenerate"}
          </button>
        </div>
      </div>

      <div className="space-y-5 px-5 py-5">
        {error && <ErrorNotice message={error} />}
        <FallbackWarning record={record} />

        <p className="max-w-4xl text-[13px] leading-relaxed text-slate-700">{insight.summary}</p>

        <div className="grid gap-4 xl:grid-cols-3">
          <TimelineSection insight={insight} />
          <DeviationsSection insight={insight} />
          <FactorsSection insight={insight} />
        </div>

        <GapsChecksSection insight={insight} />

        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-[11px] leading-relaxed text-amber-700">
          {insight.disclaimer || DISCLAIMER}
        </div>

        <button
          type="button"
          className="flex items-center gap-1.5 text-[10px] text-slate-500 transition-colors hover:text-slate-700"
          onClick={() => setShowMeta((value) => !value)}
        >
          <FileTextIcon className="h-3 w-3" />
          How this was produced
          <ChevronDownIcon className={cn("h-3 w-3 transition-transform", showMeta && "rotate-180")} />
        </button>
        {showMeta && <MetaSection record={record} />}
      </div>
    </Panel>
  );
}
