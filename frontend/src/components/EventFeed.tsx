import { fmt } from "../lib/format";
import { severityTone } from "../lib/theme";
import type { AnalysisEvent } from "../lib/types";
import { cn, EmptyState } from "./ui";
import { ActivityIcon } from "./icons";

export function EventFeed({
  events,
  emptyLabel = "No events yet.",
  className,
}: {
  events: AnalysisEvent[];
  emptyLabel?: string;
  className?: string;
}) {
  if (!events.length) {
    return (
      <EmptyState
        icon={<ActivityIcon className="h-4 w-4" />}
        title="Nothing detected yet"
        description={emptyLabel}
      />
    );
  }
  return (
    <ol className={cn("space-y-0", className)}>
      {events.map((event, index) => {
        const tone = severityTone(event.severity);
        return (
          <li key={`${event.title}-${event.t_min}-${index}`} className="relative flex gap-3 pb-3.5 last:pb-0">
            <div className="flex flex-col items-center">
              <span className={cn("mt-1 h-2 w-2 shrink-0 rounded-full", tone.dot)} />
              {index < events.length - 1 && <span className="mt-1 w-px flex-1 bg-slate-200" />}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                <p className="text-[12px] font-medium text-slate-700">{event.title}</p>
                <span className="mono shrink-0 text-slate-500">
                  {event.t_min === null ? "—" : `${fmt(event.t_min, 1)} min`}
                </span>
              </div>
              <p className="mt-0.5 text-[11px] leading-relaxed text-slate-500">{event.detail}</p>
              {event.evidence_id && (
                <span className="mono mt-1 inline-block rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[9px] text-slate-500">
                  {event.evidence_id}
                </span>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
