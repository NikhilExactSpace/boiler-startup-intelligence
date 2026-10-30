export interface Tone {
  label: string;
  text: string;
  bg: string;
  border: string;
  dot: string;
  bar: string;
  hex: string;
}

export const TONES: Record<string, Tone> = {
  emerald: {
    label: "Nominal",
    text: "text-emerald-700",
    bg: "bg-emerald-50",
    border: "border-emerald-200",
    dot: "bg-emerald-500",
    bar: "bg-emerald-500",
    hex: "#059669",
  },
  lime: {
    label: "Good",
    text: "text-lime-700",
    bg: "bg-lime-50",
    border: "border-lime-200",
    dot: "bg-lime-500",
    bar: "bg-lime-500",
    hex: "#65a30d",
  },
  amber: {
    label: "Watch",
    text: "text-amber-700",
    bg: "bg-amber-50",
    border: "border-amber-200",
    dot: "bg-amber-500",
    bar: "bg-amber-500",
    hex: "#d97706",
  },
  orange: {
    label: "Reduced confidence",
    text: "text-orange-700",
    bg: "bg-orange-50",
    border: "border-orange-200",
    dot: "bg-orange-500",
    bar: "bg-orange-500",
    hex: "#ea580c",
  },
  rose: {
    label: "Attention",
    text: "text-rose-700",
    bg: "bg-rose-50",
    border: "border-rose-200",
    dot: "bg-rose-500",
    bar: "bg-rose-500",
    hex: "#e11d48",
  },
  cyan: {
    label: "Active",
    text: "text-cyan-700",
    bg: "bg-cyan-50",
    border: "border-cyan-200",
    dot: "bg-cyan-500",
    bar: "bg-cyan-500",
    hex: "#0891b2",
  },
  sky: {
    label: "Info",
    text: "text-sky-700",
    bg: "bg-sky-50",
    border: "border-sky-200",
    dot: "bg-sky-500",
    bar: "bg-sky-500",
    hex: "#0284c7",
  },
  violet: {
    label: "Manual",
    text: "text-violet-700",
    bg: "bg-violet-50",
    border: "border-violet-200",
    dot: "bg-violet-500",
    bar: "bg-violet-500",
    hex: "#7c3aed",
  },
  slate: {
    label: "Unknown",
    text: "text-slate-600",
    bg: "bg-slate-100",
    border: "border-slate-200",
    dot: "bg-slate-500",
    bar: "bg-slate-500",
    hex: "#64748b",
  },
};

export function scoreTone(value: number | null, status?: string | null): Tone {
  if (status === "attention") return TONES.rose;
  if (status === "reduced_confidence") return TONES.orange;
  if (status === "insufficient_data" || status === "not_available" || value === null) {
    return TONES.slate;
  }
  if (value >= 90) return TONES.emerald;
  if (value >= 80) return TONES.lime;
  if (value >= 60) return TONES.amber;
  return TONES.rose;
}

export function statusTone(status: string | null | undefined): Tone {
  switch ((status ?? "").toLowerCase()) {
    case "nominal":
    case "pass":
    case "complete":
    case "on_plan":
    case "on_time":
    case "ok":
    case "approved":
      return TONES.emerald;
    case "draft":
    case "watch":
    case "late":
    case "degraded":
      return TONES.amber;
    case "attention":
    case "abort":
    case "fail":
    case "aborted":
    case "insufficient":
      return TONES.rose;
    case "reduced_confidence":
      return TONES.orange;
    case "manual":
      return TONES.violet;
    case "in_progress":
    case "starting":
    case "watching":
    case "early":
      return TONES.cyan;
    case "info":
      return TONES.sky;
    default:
      return TONES.slate;
  }
}

export function severityTone(severity: string | null | undefined): Tone {
  switch ((severity ?? "").toLowerCase()) {
    case "abort":
      return TONES.rose;
    case "watch":
      return TONES.amber;
    case "manual":
      return TONES.violet;
    default:
      return TONES.sky;
  }
}

export function scoreLabel(value: number | null, status?: string | null): string {
  if (status === "attention") return "Attention";
  if (status === "reduced_confidence") return "Reduced confidence";
  if (status === "insufficient_data") return "Insufficient data";
  if (status === "not_available") return "Not yet scored";
  if (value === null) return "Not scored";
  return scoreTone(value, status).label;
}

export const CHART = {
  actual: "#0891b2",
  expected: "#94a3b8",
  band: "#0891b2",
  grid: "#e2e8f0",
  axis: "#64748b",
  watch: "#d97706",
  abort: "#e11d48",
  info: "#0284c7",
  neutral: "#64748b",
  tooltipBg: "#ffffff",
};
