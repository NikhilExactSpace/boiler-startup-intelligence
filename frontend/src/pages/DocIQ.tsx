import { useEffect, useRef, useState } from "react";

import {
  ArrowUpRightIcon,
  DatabaseIcon,
  FileTextIcon,
  SparklesIcon,
  UploadIcon,
  XIcon,
} from "../components/icons";
import { cn, EmptyState, ErrorNotice, Loading, Panel } from "../components/ui";
import { docintelApi } from "../lib/api";
import { useBoiler } from "../lib/boiler";
import { fmtDate } from "../lib/format";
import type { BoilerDocument, DocChatMessage, DocChatSession } from "../lib/types";

const SUGGESTIONS = [
  "What are the mill cut-in times for a cold start?",
  "What are the main steam pressure limits?",
  "Summarise the startup prerequisites.",
  "Which drum level band must be maintained?",
];

const DOC_TYPES = ["manual", "sop", "curve", "report", "other"];

const TYPE_TONE: Record<string, string> = {
  manual: "border-sky-200 bg-sky-50 text-sky-700",
  sop: "border-violet-200 bg-violet-50 text-violet-700",
  curve: "border-cyan-200 bg-cyan-50 text-cyan-700",
  report: "border-amber-200 bg-amber-50 text-amber-700",
  other: "border-slate-200 bg-slate-50 text-slate-600",
};

export function DocIQPage() {
  const { boilerId, boiler } = useBoiler();
  const [documents, setDocuments] = useState<BoilerDocument[] | null>(null);
  const [session, setSession] = useState<DocChatSession | null>(null);
  const [messages, setMessages] = useState<DocChatMessage[]>([]);
  const [question, setQuestion] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewer, setViewer] = useState<BoilerDocument | null>(null);
  const [docType, setDocType] = useState("manual");
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadTitle, setUploadTitle] = useState("");
  const [uploading, setUploading] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);

  async function refreshDocuments() {
    setDocuments(await docintelApi.documents(boilerId));
  }

  async function ensureSession() {
    if (session) return session;
    const created = await docintelApi.createSession(boilerId);
    setSession(created);
    return created;
  }

  useEffect(() => {
    let cancelled = false;
    setDocuments(null);
    setSession(null);
    setMessages([]);
    docintelApi
      .documents(boilerId)
      .then((rows) => {
        if (!cancelled) setDocuments(rows);
      })
      .catch((caught) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Could not load documents");
      });
    return () => {
      cancelled = true;
    };
  }, [boilerId]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (!documents?.some((doc) => doc.status === "indexing")) return;
    const timer = window.setInterval(() => {
      docintelApi
        .documents(boilerId)
        .then(setDocuments)
        .catch(() => undefined);
    }, 1500);
    return () => window.clearInterval(timer);
  }, [documents, boilerId]);

  async function upload(file: File) {
    setUploading(true);
    setError(null);
    try {
      await docintelApi.upload(boilerId, file, uploadTitle.trim() || file.name, docType);
      await refreshDocuments();
      setUploadOpen(false);
      setUploadFile(null);
      setUploadTitle("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  function newChat() {
    if (streaming) return;
    setSession(null);
    setMessages([]);
    setQuestion("");
    setError(null);
  }

  async function removeDocument(doc: BoilerDocument) {
    if (!window.confirm(`Delete "${doc.title}" from the index?`)) return;
    try {
      await docintelApi.remove(doc.id);
      if (viewer?.id === doc.id) setViewer(null);
      await refreshDocuments();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not delete document");
    }
  }

  async function ask(text = question) {
    if (!text.trim() || streaming) return;
    const prompt = text.trim();
    setQuestion("");
    setError(null);
    setStreaming(true);
    const active = await ensureSession();
    setMessages((rows) => [
      ...rows,
      { role: "user", content: prompt, citations: [] },
      { role: "assistant", content: "", citations: [] },
    ]);
    let answer = "";
    let citations: DocChatMessage["citations"] = [];
    try {
      const response = await fetch("/api/chat/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          boiler_id: boilerId,
          session_id: active.id,
          question: prompt,
        }),
      });
      if (!response.ok || !response.body) throw new Error(`Chat failed (${response.status})`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const event = frame.match(/^event: (.+)$/m)?.[1];
          const data = frame.match(/^data: (.+)$/m)?.[1];
          if (!data) continue;
          const payload = JSON.parse(data);
          if (event === "token") {
            answer += payload.token ?? "";
            setMessages((rows) =>
              rows.map((row, index) =>
                index === rows.length - 1 ? { ...row, content: answer } : row,
              ),
            );
          } else if (event === "meta") {
            citations = payload.citations ?? [];
          } else if (event === "citations") {
            citations = payload;
          }
        }
      }
      setMessages((rows) =>
        rows.map((row, index) =>
          index === rows.length - 1 ? { ...row, content: answer, citations } : row,
        ),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Chat failed");
    } finally {
      setStreaming(false);
    }
  }

  const hasDocs = (documents?.length ?? 0) > 0;

  return (
    <div className="flex h-[calc(100vh-8rem)] flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <p className="section-title mb-0.5">Boiler document AI</p>
          <h1 className="text-lg font-semibold tracking-tight text-slate-900">BoilerIQ</h1>
          <p className="text-[11px] text-slate-500">
            Ask {boiler?.name ?? boilerId} manuals, SOPs and reports — answers cite their source.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="hidden rounded-full border border-slate-200 bg-white px-2 py-1 text-[9px] text-slate-500 sm:inline">
            {documents?.length ?? 0} docs ·{" "}
            {(documents ?? []).reduce((sum, doc) => sum + doc.chunks, 0)} chunks
          </span>
          <button type="button" className="btn-ghost !py-1.5 text-xs" onClick={newChat} disabled={streaming}>
            New chat
          </button>
          <button type="button" className="btn-primary !py-1.5 text-xs" onClick={() => setUploadOpen(true)}>
            <UploadIcon className="h-3.5 w-3.5" />
            Upload document
          </button>
        </div>
      </div>

      {error && <ErrorNotice message={error} />}

      <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[230px_minmax(0,1fr)]">
        <Panel className="hidden min-h-0 flex-col overflow-hidden lg:flex">
          <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2">
            <p className="section-title">Boiler documents</p>
            <span className="text-[9px] text-slate-500">{documents?.length ?? 0}</span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
            {!documents ? (
              <Loading label="Loading" />
            ) : documents.length === 0 ? (
              <div className="p-4 text-[11px] leading-relaxed text-slate-500">
                No indexed documents. Upload a manual, SOP or drawing to begin.
              </div>
            ) : (
              documents.map((doc) => (
                <div key={doc.id} className="group border-b border-slate-100">
                  <div className="flex items-start gap-1 px-2 py-1.5">
                    <button
                      type="button"
                      onClick={() => setViewer(doc)}
                      className="min-w-0 flex-1 rounded px-1 py-0.5 text-left transition-colors hover:bg-slate-50"
                    >
                      <p className="truncate text-[11px] font-medium text-slate-800">{doc.title}</p>
                      <div className="mt-0.5 flex items-center gap-1">
                        <span
                          className={cn(
                            "rounded border px-1 py-0 text-[8px] uppercase tracking-wider",
                            TYPE_TONE[doc.doc_type] ?? TYPE_TONE.other,
                          )}
                        >
                          {doc.doc_type}
                        </span>
                        <span className="text-[9px] text-slate-500">
                          {doc.pages}p · {doc.chunks} chunks
                        </span>
                      </div>
                      <p className="text-[9px] text-slate-400">{fmtDate(doc.created_at)}</p>
                    </button>
                    <button
                      type="button"
                      className="mt-0.5 rounded p-1 text-[9px] text-slate-400 opacity-0 transition-opacity hover:bg-rose-50 hover:text-rose-600 group-hover:opacity-100"
                      onClick={() => void removeDocument(doc)}
                      title="Delete document"
                      aria-label={`Delete ${doc.title}`}
                    >
                      <XIcon className="h-3 w-3" />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </Panel>

        <Panel className="flex min-h-0 flex-col overflow-hidden">
          <div className="flex items-center gap-2 border-b border-slate-200 px-4 py-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg border border-violet-200 bg-violet-50 text-violet-700">
              <SparklesIcon className="h-3.5 w-3.5" />
            </span>
            <div className="min-w-0">
              <p className="text-xs font-semibold text-slate-800">Ask your documents</p>
              <p className="text-[9px] text-slate-500">
                {hasDocs ? `${documents?.length} document(s) indexed` : "no documents indexed"}
              </p>
            </div>
            <span className="ml-auto flex items-center gap-1.5 text-[9px] text-slate-500">
              <span className={cn("h-1.5 w-1.5 rounded-full", streaming ? "bg-cyan-500 animate-pulse" : "bg-emerald-500")} />
              {streaming ? "streaming" : "ready"}
            </span>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 scrollbar-thin">
            <div className="mx-auto w-full max-w-3xl space-y-4">
              {messages.length === 0 && (
                <div className="flex flex-col items-center justify-center py-10 text-center">
                  <span className="flex h-12 w-12 items-center justify-center rounded-2xl border border-violet-200 bg-gradient-to-br from-violet-50 to-cyan-50 text-violet-700">
                    <SparklesIcon className="h-5 w-5" />
                  </span>
                  <h2 className="mt-3 text-sm font-semibold text-slate-800">
                    Ask your boiler documents
                  </h2>
                  <p className="mt-1 max-w-md text-[11px] leading-relaxed text-slate-500">
                    Answers are grounded in indexed manuals, SOPs, reports and curves. Every answer
                    shows its source.
                  </p>
                  <div className="mt-4 grid w-full gap-1.5 sm:grid-cols-2">
                    {SUGGESTIONS.map((suggestion) => (
                      <button
                        key={suggestion}
                        type="button"
                        onClick={() => void ask(suggestion)}
                        className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-left text-[11px] text-slate-600 transition-colors hover:border-cyan-300 hover:bg-cyan-50"
                      >
                        {suggestion}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {messages.map((message, index) => {
                const isUser = message.role === "user";
                const isLast = index === messages.length - 1;
                return (
                  <div key={index} className={cn("flex gap-2", isUser ? "justify-end" : "justify-start")}>
                    {!isUser && (
                      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-violet-200 bg-violet-50 text-violet-700">
                        <SparklesIcon className="h-3 w-3" />
                      </span>
                    )}
                    <div
                      className={cn(
                        "max-w-[85%] rounded-xl px-3.5 py-2.5 text-[12px] leading-relaxed",
                        isUser
                          ? "bg-cyan-600 text-white"
                          : "border border-slate-200 bg-white text-slate-700",
                      )}
                    >
                      <p className="whitespace-pre-wrap">
                        {message.content}
                        {!isUser && streaming && isLast && (
                          <span className="ml-0.5 inline-block h-3 w-1 animate-pulse bg-slate-500 align-middle" />
                        )}
                      </p>
                      {message.citations.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1 border-t border-slate-200 pt-2">
                          {message.citations.map((citation) => (
                            <button
                              key={`${citation.document_id}-${citation.n}`}
                              type="button"
                              className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[9px] text-slate-600 hover:border-cyan-300"
                              onClick={() => {
                                const doc = documents?.find((row) => row.id === citation.document_id);
                                if (doc) setViewer(doc);
                              }}
                              title={citation.snippet}
                            >
                              [{citation.n}] {citation.title} · p{citation.page}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
              <div ref={bottom} />
            </div>
          </div>

          <div className="border-t border-slate-200 bg-white/80 p-3">
            <div className="mx-auto flex w-full max-w-3xl items-end gap-2">
              <textarea
                className="input min-h-[48px] resize-none text-[12px]"
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void ask();
                  }
                }}
                placeholder="Ask about startup limits, mills, prerequisites…"
                rows={1}
              />
              <button
                type="button"
                className="btn-primary !px-3 !py-2.5"
                onClick={() => void ask()}
                disabled={streaming || !question.trim()}
              >
                {streaming ? "…" : "Ask"}
              </button>
            </div>
            <p className="mx-auto mt-1 max-w-3xl text-[9px] text-slate-400">
              Enter to send · Shift+Enter for a new line
            </p>
          </div>
        </Panel>
      </div>

      {uploadOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <button
            type="button"
            aria-label="Close upload"
            onClick={() => setUploadOpen(false)}
            className="absolute inset-0 bg-slate-900/25 backdrop-blur-[1px]"
          />
          <Panel className="relative w-full max-w-md p-4">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="section-title mb-0.5">Upload &amp; index document</p>
                <p className="text-[10px] text-slate-500">
                  PDF, text, markdown, CSV, PNG, JPG or WebP.
                </p>
              </div>
              <button
                type="button"
                className="rounded border border-slate-200 p-1.5 text-slate-500 hover:text-slate-800"
                onClick={() => setUploadOpen(false)}
                aria-label="Close"
              >
                <XIcon className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="mt-3 space-y-2">
              <div>
                <label className="label">Document name <span className="text-slate-400">(optional)</span></label>
                <input
                  className="input !py-1.5 text-[12px]"
                  value={uploadTitle}
                  onChange={(event) => setUploadTitle(event.target.value)}
                  placeholder={uploadFile?.name ?? "Cold start SOP"}
                />
              </div>
              <div>
                <label className="label">Document type</label>
                <select
                  className="input !py-1.5 text-[12px]"
                  value={docType}
                  onChange={(event) => setDocType(event.target.value)}
                >
                  {DOC_TYPES.map((type) => (
                    <option key={type} value={type}>{type}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label">File</label>
                <label
                  className={cn(
                    "flex w-full cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed px-3 py-3 text-[11px] transition-colors",
                    uploading
                      ? "border-slate-200 bg-slate-50 text-slate-400"
                      : "border-cyan-300 bg-cyan-50/40 text-cyan-800 hover:bg-cyan-50",
                  )}
                >
                  <UploadIcon className="h-4 w-4" />
                  {uploading
                    ? "Uploading and indexing…"
                    : uploadFile
                      ? uploadFile.name
                      : "Choose a file to upload"}
                  <input
                    type="file"
                    accept=".pdf,.txt,.md,.csv,.docx,.doc,.png,.jpg,.jpeg,.webp"
                    className="hidden"
                    disabled={uploading}
                    onChange={(event) => {
                      const file = event.target.files?.[0] ?? null;
                      setUploadFile(file);
                      if (file) void upload(file);
                      event.target.value = "";
                    }}
                  />
                </label>
                <p className="mt-1 text-[9px] text-slate-500">
                  Selecting a file starts upload and indexing automatically.
                </p>
              </div>
              {error && <ErrorNotice message={error} className="!px-3 !py-2 text-xs" />}
            </div>
          </Panel>
        </div>
      )}

      {viewer && (
        <aside className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col border-l border-slate-200 bg-white shadow-2xl">
          <header className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
            <div className="min-w-0">
              <p className="truncate text-xs font-semibold text-slate-800">{viewer.title}</p>
              <p className="text-[9px] text-slate-500">
                {viewer.doc_type} · {viewer.pages} page(s) · {viewer.status}
              </p>
            </div>
            <div className="flex items-center gap-1">
              <a
                className="rounded border border-slate-200 p-1.5 text-slate-500 hover:text-cyan-700"
                href={docintelApi.sourceUrl(viewer.id)}
                target="_blank"
                rel="noreferrer"
                title="Open in new tab"
              >
                <ArrowUpRightIcon className="h-3.5 w-3.5" />
              </a>
              <button
                type="button"
                className="rounded border border-slate-200 p-1.5 text-slate-500 hover:text-rose-600"
                onClick={() => void removeDocument(viewer)}
                title="Delete document"
                aria-label="Delete document"
              >
                <XIcon className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                className="rounded border border-slate-200 p-1.5 text-slate-500 hover:text-slate-800"
                onClick={() => setViewer(null)}
                aria-label="Close document"
              >
                <XIcon className="h-3.5 w-3.5" />
              </button>
            </div>
          </header>
          <div className="min-h-0 flex-1 overflow-auto bg-slate-50 p-3">
            {viewer.mime_type.startsWith("image/") ? (
              <img src={docintelApi.sourceUrl(viewer.id)} alt={viewer.title} className="w-full rounded object-contain" />
            ) : (
              <iframe
                title={viewer.title}
                src={docintelApi.sourceUrl(viewer.id)}
                className="h-full min-h-[600px] w-full rounded border border-slate-200 bg-white"
              />
            )}
          </div>
          <div className="border-t border-slate-200 p-3">
            <p className="mono break-all text-[9px] text-slate-400">sha {viewer.sha256.slice(0, 32)}</p>
          </div>
        </aside>
      )}
    </div>
  );
}
