import { cn } from "@/lib/utils";

/**
 * Well-plate core lattice: one well per logical CPU core.
 *  - lit (accent):   allocated to BioCompute
 *  - lit + ring:     estimated busy right now (from CPU utilisation)
 *  - dim:            reserved for the machine's owner
 */
export function CoreLattice({ total, allocated, busyPercent, size = "md", className, disabled }: {
  total: number; allocated: number; busyPercent?: number; size?: "sm" | "md" | "lg"; className?: string; disabled?: boolean;
}) {
  const n = Math.max(1, Math.min(total || 1, 256));
  const cols = n <= 8 ? n : n <= 16 ? 8 : n <= 48 ? 12 : 16;
  const busy = Math.round(((busyPercent ?? 0) / 100) * n);
  const px = { sm: 7, md: 10, lg: 13 }[size];
  const gap = { sm: 2, md: 3, lg: 4 }[size];
  return (
    <div className={cn("inline-grid", className)} style={{ gridTemplateColumns: `repeat(${cols}, ${px}px)`, gap }}
      role="img" aria-label={`${allocated} of ${total} cores allocated, about ${busy} busy`}>
      {Array.from({ length: n }, (_, i) => {
        const isAlloc = i < allocated && !disabled;
        const isBusy = i < busy;
        return (
          <span key={i} className={cn("well rounded-full",
            isAlloc ? "bg-accent" : "bg-well-off",
            isBusy && (isAlloc ? "ring-2 ring-run ring-offset-1 ring-offset-surface" : "bg-muted/50"))}
            style={{ width: px, height: px, animationDelay: `${Math.min(i * 12, 600)}ms` }} />
        );
      })}
    </div>
  );
}

export function LatticeLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
      <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-full bg-accent" />Allocated to BioCompute</span>
      <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-full bg-well-off" />Reserved for owner</span>
      <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-full bg-accent ring-2 ring-run ring-offset-1 ring-offset-surface" />Busy now</span>
    </div>
  );
}
