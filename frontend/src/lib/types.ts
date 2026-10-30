/**
 * Payload shapes returned by the FastAPI backend.
 *
 * These are intentionally hand-written: the demo has no codegen step, so keeping the
 * contract in one place makes it obvious which numbers the UI is allowed to render.
 * The UI never derives limits or safety conclusions; it only displays backend values.
 */

export type Severity = "watch" | "abort" | "manual" | "info";
export type StartupStatus = "complete" | "aborted" | "in_progress";
export type StartupType = "cold" | "warm" | "hot";

export interface StartupTypeConfig {
  enabled: boolean;
  design_duration_min: number;
}

export interface Health {
  status: string;
  version: string;
  kairos_mode: string;
  kairos_configured: boolean;
  llm_configured: boolean;
  insight_provider: string;
  gemini_model: string;
  ai_extraction_configured: boolean;
  extraction_provider: string;
  gemini_extraction_model: string;
  prompt_version: string;
  demo_boiler_id: string;
  live_time_scale: number;
  boilers: number;
  principle: string;
}

export interface BoilerCurveInfo {
  id: string;
  name: string;
  version: number;
  document: string;
  revision: string;
  design_duration_min: number;
  signals: number;
  phases: number;
  approved_by: string;
  approved_at: string;
}

export interface BoilerParameter {
  key: string;
  label: string;
  unit: string;
  tag: string;
  alarm_low: number | null;
  alarm_high: number | null;
  created_at?: string;
}

export interface BoilerSummary {
  id: string;
  name: string;
  site: string;
  tag_prefix: string;
  kairos_mode: string;
  tag_map: Record<string, string>;
  startup_types: Record<StartupType, StartupTypeConfig>;
  type_thresholds?: { hot_max_hours?: number; warm_max_hours?: number };
  parameters?: BoilerParameter[];
  created_at: string;
  curve: BoilerCurveInfo | null;
  startups: number;
}

export interface StartupSummary {
  id: string;
  boiler_id: string;
  curve_id: string;
  label: string;
  detected_start: string;
  detected_end: string | null;
  status: StartupStatus | string;
  source: string;
  startup_type: StartupType | string;
  duration_min: number | null;
  design_duration_min: number | null;
  score: number | null;
  score_status: string;
  lag_minutes: number | null;
  violations: number;
  abort_observations: number;
  top_deviation: string | null;
  live: boolean;
  meta?: Record<string, unknown>;
}

export interface Violation {
  id: string;
  signal: string;
  signal_label: string;
  unit: string;
  severity: "watch" | "abort";
  op: string;
  limit_key: string;
  limit_label: string | null;
  threshold: { value: number | null; min: number | null; max: number | null };
  from_min: number;
  to_min: number;
  duration_min: number;
  worst: number;
  worst_at: number;
  source_ref: string;
  statement: string;
}

export interface Milestone {
  id: string;
  signal: string;
  label: string;
  value: number;
  unit: string;
  design_at_min: number | null;
  actual_at_min: number | null;
  delta_min: number | null;
  status: "on_time" | "late" | "early" | "unknown" | string;
  source_ref: string | null;
}

export interface PhaseRow {
  id: string;
  key: string;
  label: string;
  design_start_min: number;
  design_end_min: number;
  actual_start_min: number | null;
  actual_end_min: number | null;
  delta_min: number | null;
  status: "on_plan" | "late" | "early" | "unknown" | string;
  source_ref: string;
}

export interface Tracking {
  signal: string;
  label: string;
  samples: number;
  rmse: number;
  mae: number;
  mean_bias: number;
  max_abs: number;
  max_abs_at_min: number;
  max_abs_expected: number;
  max_abs_actual: number;
  tolerance: number | null;
  max_bandwidths: number;
  mean_bandwidths: number;
  within_tolerance_pct: number;
}

export interface RateFinding {
  track_phase: string;
  allowed_per_min: number;
  observed_max_per_min: number;
  observed_at_min: number;
  exceeded: boolean;
  over_rate_minutes: number;
  samples: number;
  source_ref: string | null;
  signal: string;
  label: string;
}

export interface Prerequisite {
  id: string;
  key: string;
  label: string;
  mode: "auto" | "manual" | string;
  window_min: number;
  source_ref: string;
  status: "pass" | "fail" | "unknown" | "manual" | string;
  observed: { min: number; max: number; samples: number } | null;
  detail: string;
}

export interface AbortFlag {
  id: string;
  type: "observed_threshold" | "manual_criterion" | string;
  severity: "abort" | "manual" | string;
  signal: string | null;
  signal_label: string;
  at_min: number | null;
  statement: string;
  evidence_ref: string | null;
  source_ref: string;
  requires_operator_confirmation: boolean;
}

export interface Score {
  value: number | null;
  status: string;
  components: Record<string, number>;
  weights: Record<string, number>;
  note: string;
}

export interface DataQuality {
  id: string;
  coverage_pct: number;
  by_signal: Record<string, number>;
  gaps: number;
  samples_expected: number;
  span_min: number;
  status: "ok" | "degraded" | "insufficient" | string;
  detail: string;
}

export interface Lag {
  minutes: number | null;
  method: string;
  rmse_at_best: number | null;
  window: [number, number] | null;
  interpretation?: string;
}

export interface AnalysisEvent {
  t_min: number | null;
  type: string;
  severity: Severity | string;
  title: string;
  detail: string;
  evidence_id: string | null;
}

export interface SignalReport {
  key: string;
  label: string;
  unit: string;
  kind: "analog" | "state" | string;
  tracking: Tracking | null;
  samples: number;
  limits: {
    key: string;
    op: string;
    severity: Severity | string;
    value: number | null;
    min: number | null;
    max: number | null;
    label: string | null;
    source_ref: string;
    violation_count: number;
    violation_minutes: number;
  }[];
}

export interface Analysis {
  startup: {
    id: string;
    label: string;
    boiler_id: string;
    detected_start: string;
    detected_end: string | null;
    status: string;
    source: string;
  };
  curve: {
    id: string;
    name: string;
    document: string;
    revision: string;
    approved_by: string;
    approved_at: string;
    design_duration_min: number;
  };
  duration: {
    design_min: number;
    actual_min: number;
    delta_min: number;
    end_reason: string;
  };
  data_quality: DataQuality;
  phases: PhaseRow[];
  tracking: Tracking[];
  signals: SignalReport[];
  rates: RateFinding[];
  violations: Violation[];
  milestones: Milestone[];
  lag: Lag;
  prerequisites: Prerequisite[];
  abort_flags: AbortFlag[];
  score: Score;
  events: AnalysisEvent[];
  evidence_ids: string[];
  progress_pct?: number;
}

export interface ChartZone {
  from_min: number;
  to_min: number;
  lo: number;
  hi: number;
  severity: string;
  label: string;
  source_ref: string;
}

export interface ChartLimitLine {
  value: number;
  label: string;
  severity: string;
  source_ref: string;
}

export interface ChartSignal {
  key: string;
  label: string;
  unit: string;
  kind: "analog" | "state" | string;
  decimals: number;
  chart_order: number;
  actual: (number | null)[];
  expected: (number | null)[];
  lo: (number | null)[];
  hi: (number | null)[];
  zones: ChartZone[];
  lines: ChartLimitLine[];
}

export interface ChartPhase {
  key: string;
  label: string;
  start_min: number;
  end_min: number;
}

export interface ChartPayload {
  start_min: number;
  end_min: number;
  step_min: number;
  now_min?: number;
  grid: number[];
  phases: ChartPhase[];
  signals: Record<string, ChartSignal>;
  violations?: Violation[];
  milestones?: Milestone[];
}

export interface CurveLiveHighlight {
  t_min: number;
  title: string;
  detail: string;
  kind: string;
  importance: string;
}

export interface CurveMeta {
  id: string;
  name: string;
  version: number;
  document: string;
  revision: string;
  approved_by: string;
  approved_at: string;
  design_duration_min: number;
  sha256: string;
  events?: { name?: string; t_min?: number; source?: string }[];
  mill_cut_in?: { mill?: string; t_min?: number }[];
  live_highlights?: CurveLiveHighlight[];
}

export interface InsightTimelineItem {
  t_min: number | null;
  event: string;
  evidence_ids: string[];
}

export interface InsightDeviation {
  signal: string;
  what: string;
  when_min: number | null;
  severity: "watch" | "abort" | "info";
  source_ref: string | null;
  evidence_ids: string[];
}

export interface InsightFactor {
  hypothesis: string;
  confidence: "low" | "medium" | "high";
  support: string[];
  contradicting: string[];
  evidence_ids: string[];
}

export interface InsightPayload {
  summary: string;
  timeline: InsightTimelineItem[];
  deviations: InsightDeviation[];
  contributing_factors: InsightFactor[];
  data_gaps: string[];
  recommended_checks: string[];
  disclaimer: string;
}

export interface InsightMeta {
  provider: string;
  model: string;
  prompt_version: string;
  evidence_hash: string;
  generated_at: string;
  latency_s: number;
  validation: { status: string; notes: string[] };
  authoritative: boolean;
  disclaimer: string;
}

export interface InsightRecord {
  insight: InsightPayload;
  meta: InsightMeta;
}

export interface StartupDetail {
  startup: StartupSummary;
  curve: CurveMeta;
  chart: ChartPayload;
  analysis: Analysis;
  insight: InsightRecord | null;
  insight_available: boolean;
  evidence_hash: string;
  llm_configured: boolean;
}

export interface InsightResponse {
  available: boolean;
  stale?: boolean;
  record: InsightRecord | null;
  evidence_hash: string;
  llm_configured: boolean;
  provider?: string;
  model?: string;
  prompt_version?: string;
}

export interface CompareRun {
  id: string;
  label: string;
  status: string;
  detected_start: string;
  score: number | null;
  duration_min: number | null;
  signals: Record<string, (number | null)[]>;
}

export interface CompareEnvelope {
  median: (number | null)[];
  p25: (number | null)[];
  p75: (number | null)[];
  count: number[];
}

export interface ComparePayload {
  start_min: number;
  end_min: number;
  step_min: number;
  grid: number[];
  envelope: Record<string, CompareEnvelope>;
  runs: CompareRun[];
  target_id: string;
  peer_count: number;
  table: StartupSummary[];
}

export interface LiveDetection {
  detected: boolean;
  at_min: number | null;
  latency_min: number | null;
  rule: string;
  samples_required: number;
}

export interface LiveSignalValue {
  label: string;
  unit: string;
  kind?: "analog" | "state" | string;
  decimals?: number;
  value: number | null;
  expected?: number | null;
  delta?: number | null;
  tolerance?: number | null;
  lo?: number | null;
  hi?: number | null;
  in_band?: boolean | null;
  t_min?: number | null;
}

export interface LiveSnapshot {
  mode: string;
  simulated?: boolean;
  time_scale?: number;
  state: "watching" | "starting" | "complete" | "unavailable";
  sim_minutes?: number;
  now_min?: number;
  progress_pct?: number;
  design_duration_min?: number;
  actual_duration_min?: number;
  startup_type?: StartupType | string;
  classification?: {
    startup_type?: StartupType | string;
    hours_since_shutdown?: number | null;
    hot_max_hours?: number;
    warm_max_hours?: number;
    last_shutdown?: string | null;
  };
  detection?: LiveDetection;
  startup?: {
    id: string;
    label: string;
    detected_start: string;
    detected_end: string | null;
    status: string;
    source: string;
    startup_type?: StartupType | string;
    stored: boolean;
    row: StartupSummary | null;
  } | null;
  curve?: {
    id: string;
    name: string;
    document: string;
    revision: string;
    design_duration_min: number;
    events?: { name?: string; t_min?: number; source?: string }[];
    mill_cut_in?: { mill?: string; t_min?: number }[];
    live_highlights?: CurveLiveHighlight[];
  };
  chart?: ChartPayload;
  analysis?: Analysis | null;
  events?: AnalysisEvent[];
  last_values?: Record<string, LiveSignalValue>;
  llm_configured?: boolean;
  note?: string;
}

export interface CurveSummary {
  id: string;
  boiler_id: string;
  name: string;
  version: number;
  status: string;
  startup_type?: string;
  document: string;
  revision: string;
  sha256: string;
  approved_by: string;
  approved_at: string;
  created_at: string;
  design_duration_min: number;
  phases: number;
  signals: number;
  limits: number;
  analytics_tolerances: number;
}

export interface TrackDoc {
  phase: string;
  points: { t: number; value: number }[];
  tolerance: number | null;
  tolerance_provenance: string;
  max_rate_per_min: number | null;
  rate_direction?: string;
  source_ref: string | null;
}

export interface LimitDoc {
  key: string;
  op: string;
  value: number | null;
  min: number | null;
  max: number | null;
  severity: "watch" | "abort";
  label: string | null;
  active_from_min: number | null;
  active_to_min: number | null;
  active_from_event?: string | null;
  hold_seconds: number;
  min_duration_min: number;
  source_ref: string;
}

export interface SignalDoc {
  key: string;
  label: string;
  unit: string;
  kind: "analog" | "state";
  decimals: number;
  required: boolean;
  chart_order: number;
  kairos: { metric: string; tags: Record<string, string> };
  design: TrackDoc[];
  limits: LimitDoc[];
  milestones: { key: string; label: string; value: number; source_ref: string | null }[];
}

export interface PhaseDoc {
  key: string;
  label: string;
  order: number;
  start_min: number;
  end_min: number;
  source_ref: string;
  note: string;
}

export interface CurveDoc {
  schema_version: string;
  curve_id: string;
  boiler_id: string;
  name: string;
  status: string;
  startup_type?: string;
  extras?: {
    source_file?: string;
    digitization?: {
      events?: { name?: string; t_min?: number; source?: string }[];
      mill_cut_in?: { mill?: string; t_min?: number }[];
      live_highlights?: CurveLiveHighlight[];
      rated_values_printed?: { name?: string; value?: number; unit?: string; as_printed?: string }[];
    };
  };
  source: {
    document: string;
    revision: string;
    file_name: string;
    sha256: string;
    uploaded_by: string;
    approved_by: string;
    approved_at: string;
    notes: string;
  };
  phases: PhaseDoc[];
  signals: SignalDoc[];
  prerequisites: {
    key: string;
    label: string;
    mode: string;
    source_ref: string;
    op?: string;
    value?: number | null;
    min?: number | null;
    max?: number | null;
    signal_key?: string | null;
  }[];
  manual_criteria: { key: string; label: string; detail: string; source_ref: string }[];
  notes: string[];
}

export interface CurveDetail {
  id: string;
  sha256: string;
  curve: CurveDoc;
}

export interface ExtractedField {
  field: string;
  value: string;
  source_line: string;
  confidence: number;
}

export interface ExtractionAiMeta {
  engine: string;
  model?: string;
  validation: string;
  file_name?: string;
  mime_type?: string;
  attempts?: number;
  latency_s?: number;
  fact_counts?: { proposed: number; applied: number; rejected: number };
  usage?: Record<string, number>;
  notes?: string[];
}

export interface ExtractionResult {
  draft: CurveDoc;
  extracted: ExtractedField[];
  warnings: string[];
  unknowns: string[];
  document: {
    document: string;
    revision: string;
    sha256: string;
    text_sha256: string;
    characters: number;
    equipment: string | null;
    file_name: string;
    engine: "deterministic" | "ai-gemini" | string;
  };
  ai?: ExtractionAiMeta;
  boiler_id: string;
}

export interface SopText {
  document: string;
  revision: string;
  equipment: string;
  characters: number;
  text: string;
  note: string;
}

export interface ApproveResponse {
  ok: boolean;
  curve: CurveSummary;
  message: string;
}

export interface BoilerDocument {
  id: string;
  boiler_id: string;
  title: string;
  doc_type: string;
  source_file: string;
  mime_type: string;
  sha256: string;
  pages: number;
  status: string;
  error: string;
  chunks: number;
  created_at: string;
}

export interface DocCitation {
  n: number;
  document_id: string;
  title: string;
  page: number;
  snippet: string;
}

export interface DocChatMessage {
  id?: string;
  role: "user" | "assistant" | string;
  content: string;
  citations: DocCitation[];
}

export interface DocChatSession {
  id: string;
  boiler_id: string;
  title: string;
  created_at: string;
  updated_at: string;
}
