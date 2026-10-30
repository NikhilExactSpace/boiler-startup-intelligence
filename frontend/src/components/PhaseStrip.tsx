import { cn } from "./ui";
import { statusTone } from "../lib/theme";
import type { ChartPhase, PhaseRow } from "../lib/types";

export function PhaseStrip({
  phases,
  designEndMin,
  analysisPhases,
}: {
  phases: ChartPhase[];
  designEndMin: number;
  analysisPhases?: PhaseRow[];
}) {
  const total = designEndMin || phases.at(-1)?.end_min || 1;
  return (
    <div>
      <div className="flex h-8 w-full overflow-hidden rounded-lg border border-slate-200">
        {phases.map((phase, index) => {
          const actual = analysisPhases?.find((row) => row.key === phase.key);
          const tone = statusTone(actual?.status ?? "on_plan");
          const width = Math.max(
            0,
            ((Math.min(phase.end_min, total) - Math.min(phase.start_min, total)) / total) * 100,
          );
          const showLabel = width > 7;
          return (
            <div
              key={phase.key}
              style={{ width: `${width}%` }}
              className={cn(
                "relative flex min-w-0 items-center justify-center border-r border-slate-200 bg-slate-50 px-1 last:border-r-0",
                index % 2 === 0 ? "bg-white" : "bg-slate-50",
              )}
              title={
                actual
                  ? `${phase.label}: design ${phase.start_min.toFixed(1)}–${phase.end_min.toFixed(
                      1,
                    )} min · actual start ${actual.actual_start_min?.toFixed(1) ?? "—"} min (${
                      actual.delta_min === null ? "—" : `${actual.delta_min > 0 ? "+" : ""}${actual.delta_min.toFixed(1)}`
                    })`
                  : `${phase.label}: ${phase.start_min.toFixed(1)}–${phase.end_min.toFixed(1)} min`
              }
            >
              {showLabel && (
                <span className="truncate text-[9px] font-medium uppercase tracking-wide text-slate-500">
                  {phase.label}
                </span>
              )}
              <span className={cn("absolute inset-x-0 bottom-0 h-[3px]", tone.bar)} />
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-slate-500">
        <span>t = 0 · detected start</span>
        <span>design {total.toFixed(0)} min</span>
      </div>
    </div>
  );
}
