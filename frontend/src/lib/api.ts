import type {
  ApproveResponse,
  BoilerSummary,
  ComparePayload,
  CurveDetail,
  CurveSummary,
  ExtractionResult,
  Health,
  InsightResponse,
  LiveSnapshot,
  SopText,
  StartupDetail,
  StartupSummary,
} from "./types";

const BASE = "/api";

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(`${BASE}${path}`, { ...init, headers });
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const payload = await response.json();
      if (typeof payload?.detail === "string") message = payload.detail;
      else if (Array.isArray(payload?.detail)) message = payload.detail[0]?.msg ?? message;
    } catch {
      /* keep the status-based message */
    }
    throw new ApiError(message, response.status);
  }
  return (await response.json()) as T;
}

export const api = {
  health: () => request<Health>("/health"),

  boilers: () => request<BoilerSummary[]>("/boilers"),
  createBoiler: (payload: {
    id: string;
    name: string;
    site?: string;
    tag_prefix?: string;
    tag_map?: Record<string, string>;
    startup_types?: Record<string, { enabled: boolean; design_duration_min: number }>;
    type_thresholds?: { hot_max_hours?: number; warm_max_hours?: number };
  }) =>
    request<{ ok: boolean; id: string; next: string }>("/boilers", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  updateBoiler: (
    boilerId: string,
    payload: {
      name?: string;
      startup_types?: Record<string, { enabled: boolean; design_duration_min: number }>;
      type_thresholds?: { hot_max_hours?: number; warm_max_hours?: number };
    },
  ) =>
    request<{ ok: boolean; id: string }>(`/boilers/${encodeURIComponent(boilerId)}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    }),
  deleteBoiler: (boilerId: string) =>
    request<{ ok: boolean; id: string }>(`/boilers/${encodeURIComponent(boilerId)}`, {
      method: "DELETE",
    }),
  saveBoilerParameter: (
    boilerId: string,
    key: string,
    payload: {
      key: string;
      label: string;
      unit: string;
      tag: string;
      alarm_low: number | null;
      alarm_high: number | null;
    },
  ) =>
    request<{ ok: boolean; parameter: unknown }>(
      `/boilers/${encodeURIComponent(boilerId)}/parameters/${encodeURIComponent(key)}`,
      { method: "PUT", body: JSON.stringify(payload) },
    ),
  deleteBoilerParameter: (boilerId: string, key: string) =>
    request<{ ok: boolean; key: string }>(
      `/boilers/${encodeURIComponent(boilerId)}/parameters/${encodeURIComponent(key)}`,
      { method: "DELETE" },
    ),

  startups: (boilerId: string, status?: string) => {
    const query = new URLSearchParams({ boiler_id: boilerId });
    if (status) query.set("status", status);
    return request<StartupSummary[]>(`/startups?${query.toString()}`);
  },
  startup: (startupId: string) => request<StartupDetail>(`/startups/${encodeURIComponent(startupId)}`),
  compare: (startupId: string) =>
    request<ComparePayload>(`/startups/${encodeURIComponent(startupId)}/compare`),

  insight: (startupId: string) =>
    request<InsightResponse>(`/startups/${encodeURIComponent(startupId)}/insight`),
  generateInsight: (startupId: string) =>
    request<InsightResponse>(`/startups/${encodeURIComponent(startupId)}/insight?force=true`, {
      method: "POST",
    }),

  curves: (boilerId: string) =>
    request<CurveSummary[]>(`/design-curves?boiler_id=${encodeURIComponent(boilerId)}`),
  curve: (curveId: string) =>
    request<CurveDetail>(`/design-curves/${encodeURIComponent(curveId)}/json`),
  approveCurve: (payload: {
    boiler_id: string;
    draft: unknown;
    approved_by: string;
    startup_type?: string;
    tag_map?: Record<string, string>;
  }) =>
    request<ApproveResponse>("/design-curves/approve", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  deleteCurve: (curveId: string) =>
    request<{ ok: boolean; id: string }>(`/design-curves/${encodeURIComponent(curveId)}`, {
      method: "DELETE",
    }),
  curveSourceUrl: (curveId: string) =>
    `${BASE}/design-curves/${encodeURIComponent(curveId)}/source`,
  extractText: (boilerId: string, text: string) =>
    request<ExtractionResult>("/design-curves/extract-text", {
      method: "POST",
      body: JSON.stringify({ boiler_id: boilerId, text }),
    }),
  extractFile: (boilerId: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    form.append("boiler_id", boilerId);
    return request<ExtractionResult>("/design-curves/extract", { method: "POST", body: form });
  },
  extractCurve: (boilerId: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    form.append("boiler_id", boilerId);
    return request<ExtractionResult>("/design-curves/extract-curve", {
      method: "POST",
      body: form,
    });
  },
  sopText: () => request<SopText>("/demo/sop-text"),

  live: (boilerId: string, startupType = "auto") =>
    request<LiveSnapshot>(
      `/live/${encodeURIComponent(boilerId)}?startup_type=${encodeURIComponent(startupType)}`,
    ),
  restartLive: (boilerId: string, startupType = "auto") =>
    request<{ ok: boolean; snapshot: LiveSnapshot }>(
      `/live/${encodeURIComponent(boilerId)}/simulate?startup_type=${encodeURIComponent(startupType)}`,
      { method: "POST" },
    ),
  liveStreamUrl: (boilerId: string, startupType = "auto") =>
    `${BASE}/live/${encodeURIComponent(boilerId)}/stream?startup_type=${encodeURIComponent(startupType)}`,
  resetDemo: () => request<Record<string, unknown>>("/demo/reset", { method: "POST" }),
};

export const docintelApi = {
  documents: (boilerId: string) =>
    request<import("./types").BoilerDocument[]>(`/documents?boiler_id=${encodeURIComponent(boilerId)}`),
  upload: (boilerId: string, file: File, title: string, docType: string) => {
    const form = new FormData();
    form.append("file", file);
    form.append("boiler_id", boilerId);
    form.append("title", title);
    form.append("doc_type", docType);
    return request<import("./types").BoilerDocument>("/documents", { method: "POST", body: form });
  },
  remove: (id: string) =>
    request<{ ok: boolean }>(`/documents/${encodeURIComponent(id)}`, { method: "DELETE" }),
  sourceUrl: (id: string) => `${BASE}/documents/${encodeURIComponent(id)}/source`,
  sessions: (boilerId: string) =>
    request<import("./types").DocChatSession[]>(
      `/chat/sessions?boiler_id=${encodeURIComponent(boilerId)}`,
    ),
  createSession: (boilerId: string, title = "New conversation") =>
    request<import("./types").DocChatSession>("/chat/sessions", {
      method: "POST",
      body: JSON.stringify({ boiler_id: boilerId, title }),
    }),
  messages: (sessionId: string) =>
    request<import("./types").DocChatMessage[]>(
      `/chat/sessions/${encodeURIComponent(sessionId)}/messages`,
    ),
};
