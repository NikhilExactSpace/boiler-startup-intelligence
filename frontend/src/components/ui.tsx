import type { ReactNode } from "react";
import clsx from "clsx";

import { scoreLabel, scoreTone, statusTone, type Tone } from "../lib/theme";
import { AlertIcon, InfoIcon, ShieldIcon } from "./icons";

export function cn(...values: Array<string | false | null | undefined>): string {
  return clsx(values);
}

export function Panel({
  children,
  className,
  as: Tag = "section",
}: {
  children: ReactNode;
  className?: string;
  as?: "section" | "div" | "article";
}) {
  return <Tag className={cn("panel", className)}>{children}</Tag>;
}

export function Pill({
  status,
  children,
  tone,
  dot = false,
  className,
}: {
  status?: string | null;
  children?: ReactNode;
  tone?: Tone;
  dot?: boolean;
  className?: string;
}) {
  const resolved = tone ?? statusTone(status);
  return (
    <span className={cn("chip", resolved.bg, resolved.border, resolved.text, className)}>
      {dot && <span className={cn("h-1.5 w-1.5 rounded-full", resolved.dot)} />}
      {children ?? resolved.label}
    </span>
  );
}

export function SectionHeading({
  eyebrow,
  title,
  description,
  action,
  className,
}: {
  eyebrow?: string;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-start justify-between gap-3", className)}>
      <div>
        {eyebrow && <p className="section-title mb-1.5">{eyebrow}</p>}
        <h2 className="text-base font-semibold tracking-tight text-slate-900">{title}</h2>
        {description && <p className="mt-1 max-w-2xl text-sm text-slate-600">{description}</p>}
      </div>
      {action}
    </div>
  );
}

export function Kpi({
  label,
  value,
  hint,
  tone,
  icon,
  className,
  dense = false,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: Tone;
  icon?: ReactNode;
  className?: string;
  dense?: boolean;
}) {
  return (
    <div className={cn("panel", dense ? "px-3 py-2.5" : "px-4 py-3.5", className)}>
      <div className="flex items-center justify-between gap-2">
        <p
          className={cn(
            "font-semibold uppercase tracking-[0.16em] text-slate-500",
            dense ? "text-[9px]" : "text-[10px]",
          )}
        >
          {label}
        </p>
        {icon && <span className="text-slate-400">{icon}</span>}
      </div>
      <div
        className={cn(
          "font-semibold tabular-nums tracking-tight text-slate-900",
          dense ? "mt-1 text-lg" : "mt-1.5 text-xl",
          tone?.text,
        )}
      >
        {value}
      </div>
      {hint && (
        <div
          className={cn(
            "mt-0.5 leading-snug text-slate-500",
            dense ? "text-[10px]" : "text-xs",
          )}
        >
          {hint}
        </div>
      )}
    </div>
  );
}

export function ScoreRing({
  value,
  status,
  size = 92,
  stroke = 7,
  showLabel = true,
}: {
  value: number | null;
  status?: string | null;
  size?: number;
  stroke?: number;
  showLabel?: boolean;
}) {
  const tone = scoreTone(value, status);
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const pct = value === null ? 0 : Math.max(0, Math.min(100, value));
  const dash = (pct / 100) * circumference;
  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="#e2e8f0"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={tone.hex}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${circumference}`}
          className="transition-[stroke-dasharray] duration-700"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span
          className={cn(
            "font-semibold tabular-nums text-slate-900",
            size < 70 ? "text-sm" : size < 90 ? "text-base" : "text-xl",
          )}
        >
          {value === null ? "—" : value.toFixed(1)}
        </span>
        {showLabel && (
          <span
            className={cn(
              "mt-0.5 font-medium uppercase tracking-wider",
              size < 70 ? "text-[7px]" : "text-[9px]",
              tone.text,
            )}
          >
            {scoreLabel(value, status)}
          </span>
        )}
      </div>
    </div>
  );
}

export function ProgressBar({
  value,
  tone,
  className,
  height = "h-1.5",
}: {
  value: number;
  tone?: Tone;
  className?: string;
  height?: string;
}) {
  return (
    <div className={cn("w-full overflow-hidden rounded-full bg-slate-200", height, className)}>
      <div
        className={cn("h-full rounded-full transition-[width] duration-500", tone?.bar ?? "bg-cyan-500")}
        style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
      />
    </div>
  );
}

export function Meter({
  label,
  value,
  weight,
  tone,
}: {
  label: string;
  value: number;
  weight?: number;
  tone?: Tone;
}) {
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2 text-xs">
        <span className="capitalize text-slate-600">
          {label}
          {weight !== undefined && (
            <span className="ml-1.5 text-[10px] text-slate-500">×{weight}</span>
          )}
        </span>
        <span className="font-medium tabular-nums text-slate-700">{value.toFixed(1)}</span>
      </div>
      <ProgressBar value={value} tone={tone ?? scoreTone(value)} height="h-1" />
    </div>
  );
}

export function AdvisoryNotice({ compact = false }: { compact?: boolean }) {
  if (compact) {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-700">
        <ShieldIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
        <span>
          Advisory only. The platform quantifies deviations from the approved curve; it never
          decides whether the boiler is safe to operate.
        </span>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
      <ShieldIcon className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
      <div className="text-xs leading-relaxed text-amber-700">
        <span className="font-semibold text-amber-800">Advisory only.</span> DCS data says what
        happened, the approved curve says what should have happened, and deterministic analytics
        quantify the difference. The explanation layer never invents limits and never determines
        whether the boiler is safe to operate. The shift engineer remains responsible for every
        operating decision.
      </div>
    </div>
  );
}

export function ErrorNotice({
  message,
  onRetry,
  className,
}: {
  message: string;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-start gap-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800",
        className,
      )}
    >
      <AlertIcon className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">Something went wrong</p>
        <p className="mt-0.5 break-words text-xs text-rose-700">{message}</p>
      </div>
      {onRetry && (
        <button type="button" className="btn-ghost !py-1.5 text-xs" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-14 text-center">
      <div className="mb-1 flex h-10 w-10 items-center justify-center rounded-full border border-slate-300 bg-white text-slate-500">
        {icon ?? <InfoIcon className="h-4 w-4" />}
      </div>
      <p className="text-sm font-medium text-slate-800">{title}</p>
      {description && <p className="max-w-md text-xs leading-relaxed text-slate-500">{description}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <div className="flex items-center gap-2.5 px-2 py-10 text-sm text-slate-500">
      <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-slate-300 border-t-cyan-400" />
      {label}…
    </div>
  );
}

export function EvidenceChips({ ids }: { ids: string[] }) {
  if (!ids?.length) return null;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {ids.map((id) => (
        <span
          key={id}
          className="rounded border border-slate-300 bg-slate-50 px-1.5 py-0.5 font-mono text-[10px] text-slate-600"
        >
          {id}
        </span>
      ))}
    </span>
  );
}

export function InfoLine({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 text-[11px] leading-relaxed text-slate-500">
      <InfoIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>{children}</span>
    </div>
  );
}
