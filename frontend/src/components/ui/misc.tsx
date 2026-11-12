import * as React from "react";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import * as SliderPrimitive from "@radix-ui/react-slider";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

export const Panel = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("rounded-lg border border-line bg-surface", className)} {...props} />
));
Panel.displayName = "Panel";

export function PanelHeader({ title, description, actions, className }: { title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-start justify-between gap-4 px-4 pt-3.5 pb-3 border-b border-line", className)}>
      <div className="min-w-0">
        <h3 className="text-sm font-semibold">{title}</h3>
        {description && <p className="text-xs text-muted mt-0.5">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}

const BADGE_TONES = {
  neutral: "bg-raised text-muted border-line",
  accent: "bg-accent/12 text-accent border-accent/30",
  ok: "bg-ok/12 text-ok border-ok/30",
  bad: "bg-bad/12 text-bad border-bad/30",
  run: "bg-run/12 text-run border-run/30",
  wait: "bg-wait/12 text-wait border-wait/30",
};
// forwards its ref: badges are tooltip triggers (Tip), which need the element to attach to and to position against
export const Badge = React.forwardRef<HTMLSpanElement, React.HTMLAttributes<HTMLSpanElement> & { tone?: keyof typeof BADGE_TONES }>(
  ({ className, tone = "neutral", ...props }, ref) => (
    <span ref={ref} className={cn("inline-flex items-center gap-1 rounded border px-1.5 py-px text-[11.5px] font-medium whitespace-nowrap", BADGE_TONES[tone], className)} {...props} />
  ));
Badge.displayName = "Badge";

export const Switch = React.forwardRef<React.ElementRef<typeof SwitchPrimitive.Root>, React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>>(
  ({ className, ...props }, ref) => (
    <SwitchPrimitive.Root ref={ref} className={cn("peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-line bg-raised transition-colors data-[state=checked]:bg-accent data-[state=checked]:border-accent disabled:opacity-50", className)} {...props}>
      <SwitchPrimitive.Thumb className="block size-3.5 rounded-full bg-text shadow transition-transform translate-x-0.5 data-[state=checked]:translate-x-[18px] data-[state=checked]:bg-accent-ink" />
    </SwitchPrimitive.Root>
  ),
);
Switch.displayName = "Switch";

export const Checkbox = React.forwardRef<React.ElementRef<typeof CheckboxPrimitive.Root>, React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>>(
  ({ className, ...props }, ref) => (
    <CheckboxPrimitive.Root ref={ref} className={cn("size-4 shrink-0 rounded-[4px] border border-line bg-ink/60 data-[state=checked]:bg-accent data-[state=checked]:border-accent", className)} {...props}>
      <CheckboxPrimitive.Indicator className="flex items-center justify-center text-accent-ink"><Check className="size-3" strokeWidth={3} /></CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  ),
);
Checkbox.displayName = "Checkbox";

export function Slider({ className, ...props }: React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root>) {
  return (
    <SliderPrimitive.Root className={cn("relative flex w-full touch-none select-none items-center h-5", className)} {...props}>
      <SliderPrimitive.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-raised">
        <SliderPrimitive.Range className="absolute h-full bg-accent" />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb className="block size-4 rounded-full border-2 border-accent bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40" />
    </SliderPrimitive.Root>
  );
}

export const Tabs = TabsPrimitive.Root;
export function TabsList({ className, ...props }: React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>) {
  return <TabsPrimitive.List className={cn("flex items-center gap-1 border-b border-line", className)} {...props} />;
}
export function TabsTrigger({ className, ...props }: React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>) {
  return <TabsPrimitive.Trigger className={cn("relative px-3 py-2 text-[13px] text-muted hover:text-text data-[state=active]:text-text after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full data-[state=active]:after:bg-accent", className)} {...props} />;
}
export const TabsContent = TabsPrimitive.Content;

export function Tip({ content, children, side = "top" }: { content: React.ReactNode; children: React.ReactNode; side?: "top" | "bottom" | "left" | "right" }) {
  return (
    <TooltipPrimitive.Root delayDuration={250}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content side={side} sideOffset={6} className="z-50 max-w-72 rounded-md border border-line bg-raised px-2.5 py-1.5 text-xs text-text shadow-lg">
          {content}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
export const TooltipProvider = TooltipPrimitive.Provider;

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export function PopoverContent({ className, ...props }: React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content sideOffset={6} className={cn("z-50 rounded-lg border border-line bg-surface p-3 shadow-xl shadow-black/30", className)} {...props} />
    </PopoverPrimitive.Portal>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-md bg-raised", className)} />;
}

export function Empty({ icon, title, children, action, className }: { icon?: React.ReactNode; title: string; children?: React.ReactNode; action?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center justify-center text-center px-6 py-14", className)}>
      {icon && <div className="mb-3 text-muted [&_svg]:size-7">{icon}</div>}
      <p className="font-medium">{title}</p>
      {children && <div className="mt-1 max-w-md text-[13px] text-muted">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Meter({ value, max = 100, tone = "accent", className }: { value: number; max?: number; tone?: "accent" | "ok" | "bad" | "run" | "wait"; className?: string }) {
  const pct = Math.max(0, Math.min(100, (value / (max || 1)) * 100));
  const bg = { accent: "bg-accent", ok: "bg-ok", bad: "bg-bad", run: "bg-run", wait: "bg-wait" }[tone];
  return (
    <div className={cn("h-1.5 w-full rounded-full bg-raised overflow-hidden", className)} role="meter" aria-valuenow={value} aria-valuemax={max}>
      <div className={cn("h-full rounded-full transition-[width] duration-500", bg)} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="rounded border border-line bg-raised px-1 text-[11px] text-muted font-sans">{children}</kbd>;
}
