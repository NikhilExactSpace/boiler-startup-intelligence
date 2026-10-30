import { useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { CheckIcon, DownloadIcon, FileTextIcon, XIcon } from "./icons";
import { cn } from "./ui";

export interface RawJsonTab {
  key: string;
  label: string;
  kind: "json";
  data: unknown;
  note?: string;
}

export interface RawTableColumn {
  key: string;
  label: string;
  align?: "left" | "right";
  mono?: boolean;
}

export interface RawTableTab {
  key: string;
  label: string;
  kind: "table";
  columns: RawTableColumn[];
  rows: Record<string, ReactNode>[];
  note?: string;
}

export type RawTab = RawJsonTab | RawTableTab;

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function RawDataDrawer({
  open,
  onClose,
  title,
  subtitle,
  tabs,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  tabs: RawTab[];
}) {
  const [active, setActive] = useState(tabs[0]?.key ?? "");
  const [copied, setCopied] = useState(false);
  const tabKeys = tabs.map((tab) => tab.key).join("|");

  useEffect(() => {
    if (!open) return;
    setCopied(false);
    setActive((current) =>
      current && tabs.some((tab) => tab.key === current) ? current : tabs[0]?.key ?? "",
    );
    // Content refreshes on the live feed; only reset when the tab set changes.
  }, [open, tabKeys]);

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

  const current = tabs.find((tab) => tab.key === active) ?? tabs[0];
  const text = useMemo(
    () => (current?.kind === "json" ? JSON.stringify(current.data, null, 2) : ""),
    [current],
  );

  if (!open || !current) return null;

  async function copy() {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard may be unavailable outside a secure context */
    }
  }

  function download() {
    if (!text) return;
    const blob = new Blob([text], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${slug(`${title}-${current.label}`)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end">
      <button
        type="button"
        aria-label="Close raw data"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-slate-900/20 backdrop-blur-[1px]"
      />
      <aside className="relative flex h-full w-full max-w-2xl flex-col border-l border-slate-200 bg-white shadow-[-24px_0_60px_-30px_rgba(15,23,42,0.4)]">
        <header className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
          <div className="min-w-0">
            <p className="section-title mb-1">Raw data</p>
            <h2 className="truncate text-sm font-semibold text-slate-900">{title}</h2>
            {subtitle && <p className="mt-0.5 text-[11px] text-slate-500">{subtitle}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-200 bg-white p-1.5 text-slate-500 transition-colors hover:border-slate-300 hover:text-slate-800"
            aria-label="Close"
          >
            <XIcon className="h-4 w-4" />
          </button>
        </header>

        <div className="flex flex-wrap gap-1.5 border-b border-slate-200 px-5 py-2.5">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActive(tab.key)}
              className={cn(
                "rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors",
                tab.key === current.key
                  ? "border-cyan-300 bg-cyan-50 text-cyan-800"
                  : "border-slate-200 bg-white text-slate-500 hover:border-slate-300 hover:text-slate-700",
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-5 py-2">
          <p className="text-[10px] leading-relaxed text-slate-500">
            {current.note ??
              "Exactly what the API returned for this view. Nothing is recomputed in the browser."}
          </p>
          {current.kind === "json" && (
            <div className="flex items-center gap-1.5">
              <button type="button" className="btn-ghost !px-2 !py-1 text-[10px]" onClick={() => void copy()}>
                {copied ? <CheckIcon className="h-3 w-3" /> : <FileTextIcon className="h-3 w-3" />}
                {copied ? "Copied" : "Copy"}
              </button>
              <button type="button" className="btn-ghost !px-2 !py-1 text-[10px]" onClick={download}>
                <DownloadIcon className="h-3 w-3" /> Download
              </button>
            </div>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-auto scrollbar-thin">
          {current.kind === "json" ? (
            <pre className="min-w-full whitespace-pre px-5 py-4 font-mono text-[10.5px] leading-relaxed text-slate-700">
              {text}
            </pre>
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table min-w-full">
                <thead className="sticky top-0 bg-white">
                  <tr>
                    {current.columns.map((column) => (
                      <th
                        key={column.key}
                        className={column.align === "right" ? "text-right" : undefined}
                      >
                        {column.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {current.rows.map((row, index) => (
                    <tr key={index}>
                      {current.columns.map((column) => (
                        <td
                          key={column.key}
                          className={cn(
                            "whitespace-nowrap text-[11px]",
                            column.align === "right" && "text-right",
                            column.mono && "font-mono tabular-nums",
                          )}
                        >
                          {row[column.key] ?? "—"}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <footer className="border-t border-slate-200 bg-amber-50 px-5 py-2 text-[10px] leading-relaxed text-amber-700">
          Advisory only. Raw values are shown for inspection and are not a safety determination.
        </footer>
      </aside>
    </div>,
    document.body,
  );
}
