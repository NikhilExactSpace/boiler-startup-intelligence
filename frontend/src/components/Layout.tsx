import { useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import clsx from "clsx";

import { api } from "../lib/api";
import { useBoiler } from "../lib/boiler";
import { useHealth } from "../lib/useHealth";
import {
  ActivityIcon,
  BoltIcon,
  DatabaseIcon,
  HistoryIcon,
  LayersIcon,
  MenuIcon,
  RefreshIcon,
  ShieldIcon,
  SparklesIcon,
  XIcon,
} from "./icons";
import { AdvisoryNotice, cn, Pill } from "./ui";

const NAV = [
  { to: "/live", label: "Live startup", icon: BoltIcon, hint: "Accelerated replay" },
  { to: "/history", label: "Startup history", icon: HistoryIcon, hint: "Past runs" },
  { to: "/curves", label: "Design curves", icon: LayersIcon, hint: "Approved JSON" },
  { to: "/dociq", label: "BoilerIQ", icon: SparklesIcon, hint: "Docs AI" },
];

function pageTitle(pathname: string): string {
  if (pathname.startsWith("/startups/")) return "Startup detail";
  if (pathname.startsWith("/live")) return "Live startup";
  if (pathname.startsWith("/history")) return "Startup history";
  if (pathname.startsWith("/curves")) return "Design curves";
  if (pathname.startsWith("/dociq")) return "BoilerIQ";
  return "Workspace";
}

function Brand() {
  return (
    <div className="flex items-center gap-2.5">
      <div className="relative flex h-8 w-8 items-center justify-center rounded-lg border border-cyan-200 bg-gradient-to-br from-cyan-100 to-white text-cyan-700 shadow-[0_6px_16px_-8px_rgba(8,145,178,0.35)]">
        <BoltIcon className="h-4 w-4" />
      </div>
      <div className="min-w-0">
        <p className="truncate text-[12px] font-semibold tracking-tight text-slate-900">
          Boiler Startup
        </p>
        <p className="truncate text-[9px] font-medium uppercase tracking-[0.18em] text-slate-500">
          Intelligence
        </p>
      </div>
    </div>
  );
}

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const { boiler, boilerId, boilers, setBoilerId, refresh } = useBoiler();
  const { health } = useHealth();
  const [resetting, setResetting] = useState(false);

  async function resetDemo() {
    if (!window.confirm("Reset the demo? All demo startups, live runs and generated insights will be re-seeded.")) {
      return;
    }
    setResetting(true);
    try {
      await api.resetDemo();
      await refresh();
      window.location.assign("/live");
    } catch (caught) {
      window.alert(caught instanceof Error ? caught.message : "Reset failed");
      setResetting(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="px-4 pb-3 pt-4">
        <Brand />
      </div>

      <div className="px-2.5">
        <label className="label px-2">Boiler</label>
        <select
          className="input !py-1.5 text-[12px]"
          value={boilerId}
          onChange={(event) => {
            setBoilerId(event.target.value);
            onNavigate?.();
          }}
        >
          {boilers.map((row) => (
            <option key={row.id} value={row.id}>
              {row.id} · {row.name}
            </option>
          ))}
          {!boilers.length && <option value={boilerId}>{boilerId}</option>}
        </select>
        {boiler?.curve && (
          <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[9px] uppercase tracking-[0.14em] text-slate-500">
                Active curve
              </span>
              <span className="mono text-[10px] text-cyan-700">v{boiler.curve.version}</span>
            </div>
            <p className="mt-0.5 truncate text-[11px] text-slate-700">{boiler.curve.name}</p>
            <p className="mt-0.5 text-[9px] text-slate-500">
              {boiler.curve.document} Rev {boiler.curve.revision} ·{" "}
              {boiler.curve.design_duration_min.toFixed(0)} min
            </p>
          </div>
        )}
      </div>

      <nav className="mt-4 space-y-0.5 px-2.5">
        <p className="label px-2">Workspace</p>
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            onClick={onNavigate}
            className={({ isActive }) =>
              cn(
                "group flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-[12px] transition-colors",
                isActive
                  ? "bg-cyan-50 text-cyan-800 ring-1 ring-inset ring-cyan-200"
                  : "text-slate-600 hover:bg-slate-100 hover:text-slate-800",
              )
            }
          >
            {({ isActive }) => (
              <>
                <item.icon
                  className={clsx(
                    "h-3.5 w-3.5 shrink-0",
                    isActive ? "text-cyan-700" : "text-slate-500 group-hover:text-slate-700",
                  )}
                />
                <span className="flex-1">{item.label}</span>
              </>
            )}
          </NavLink>
        ))}
      </nav>

      <div className="mt-4 space-y-2 px-2.5">
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-[9px] font-semibold uppercase tracking-[0.14em] text-slate-500">
              <DatabaseIcon className="h-3 w-3" />
              Historian
            </span>
            <Pill status="ok" className="!px-1.5 !py-0 !text-[8px]">
              read-only
            </Pill>
          </div>
          <dl className="mt-1.5 space-y-0.5 text-[10px]">
            <div className="flex justify-between gap-2">
              <dt className="text-slate-500">Mode</dt>
              <dd className="font-mono text-slate-700">{health?.kairos_mode ?? "—"}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-slate-500">Replay</dt>
              <dd className="font-mono text-slate-700">
                {health ? `${health.live_time_scale}×` : "—"}
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-slate-500">Insight</dt>
              <dd className="font-mono text-slate-700">
                {health?.llm_configured ? "gemini" : "deterministic"}
              </dd>
            </div>
          </dl>
        </div>
      </div>

      <div className="mt-auto flex items-center justify-between gap-2 px-4 py-3">
        <div className="text-[9px] leading-tight text-slate-500">
          <p>v{health?.version ?? "0.1.0"} · demo</p>
          <p>{health ? `${health.boilers} boiler(s)` : "connecting…"}</p>
        </div>
        <button
          type="button"
          onClick={() => void resetDemo()}
          disabled={resetting}
          className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-1.5 py-0.5 text-[9px] text-slate-500 transition-colors hover:border-slate-300 hover:text-slate-700 disabled:opacity-50"
          title="Wipe and re-seed the demo database"
        >
          <RefreshIcon className={cn("h-3 w-3", resetting && "animate-spin")} />
          Reset
        </button>
      </div>
    </div>
  );
}

export function Layout() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const { boiler, boilerId, boilers, setBoilerId, error } = useBoiler();
  const { health } = useHealth();
  const location = useLocation();

  return (
    <div className="flex h-screen overflow-hidden">
      <aside className="hidden w-[224px] shrink-0 border-r border-slate-200 bg-white/80 backdrop-blur-xl lg:block">
        <SidebarContent />
      </aside>

      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div
            className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
            onClick={() => setMobileOpen(false)}
          />
          <aside className="relative h-full w-[280px] border-r border-slate-200 bg-white">
            <button
              type="button"
              onClick={() => setMobileOpen(false)}
              className="absolute right-3 top-3 z-10 rounded-md p-1.5 text-slate-500 hover:bg-slate-200 hover:text-slate-800"
              aria-label="Close navigation"
            >
              <XIcon className="h-4 w-4" />
            </button>
            <SidebarContent onNavigate={() => setMobileOpen(false)} />
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-slate-200 bg-white/85 px-4 backdrop-blur-xl sm:px-6">
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            className="rounded-md p-1.5 text-slate-600 hover:bg-slate-200 hover:text-slate-800 lg:hidden"
            aria-label="Open navigation"
          >
            <MenuIcon className="h-5 w-5" />
          </button>

          <div className="min-w-0">
            <p className="truncate text-[11px] font-medium text-slate-800">
              {pageTitle(location.pathname)}
            </p>
            <p className="truncate text-[9px] uppercase tracking-[0.16em] text-slate-500">
              Workspace
            </p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Link
              to="/dociq"
              className="inline-flex items-center gap-1.5 rounded-lg border border-violet-200 bg-gradient-to-r from-violet-50 to-cyan-50 px-2.5 py-1 text-[10px] font-semibold text-violet-800 shadow-sm transition-colors hover:border-violet-300"
              title="Document Intelligence — ask manuals, SOPs and reports"
            >
              <SparklesIcon className="h-3.5 w-3.5" />
              BoilerIQ
            </Link>
            <span
              className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-slate-200 bg-white"
              title={health?.llm_configured ? "Gemini insights enabled" : "Deterministic insights"}
            >
              <span
                className={cn(
                  "h-1.5 w-1.5 rounded-full",
                  health?.llm_configured ? "bg-violet-500" : "bg-slate-400",
                )}
              />
            </span>
            <span
              className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-amber-200 bg-amber-50"
              title="Advisory only. The platform never determines whether the boiler is safe to operate."
            >
              <ShieldIcon className="h-3 w-3 text-amber-600" />
            </span>
          </div>
        </header>

        <main key={location.pathname + boilerId} className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[1500px] px-4 py-5 sm:px-6 lg:px-8 lg:py-7">
            {!location.pathname.startsWith("/dociq") && (
              <div className="mb-4 lg:hidden">
                <AdvisoryNotice compact />
              </div>
            )}
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
