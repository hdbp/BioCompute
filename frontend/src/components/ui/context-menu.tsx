import * as React from "react";
import * as Ctx from "@radix-ui/react-context-menu";
import { cn } from "@/lib/utils";

/** Right-click (or long-press, or the context-menu key) menu; styled like DropdownMenu. */
export const ContextMenu = Ctx.Root;
export const ContextMenuTrigger = Ctx.Trigger;
export function ContextMenuContent({ className, ...props }: React.ComponentPropsWithoutRef<typeof Ctx.Content>) {
  return (
    <Ctx.Portal>
      <Ctx.Content className={cn("z-50 min-w-52 rounded-lg border border-line bg-surface p-1 shadow-xl shadow-black/30", className)} {...props} />
    </Ctx.Portal>
  );
}
export function ContextMenuItem({ className, danger, ...props }: React.ComponentPropsWithoutRef<typeof Ctx.Item> & { danger?: boolean }) {
  return <Ctx.Item className={cn("flex cursor-pointer select-none items-center gap-2 rounded-md px-2 py-1.5 text-[13px] outline-none data-[highlighted]:bg-raised data-[disabled]:opacity-40 [&_svg]:size-4 [&_svg]:text-muted", danger && "text-bad [&_svg]:text-bad", className)} {...props} />;
}
export const ContextMenuSeparator = () => <Ctx.Separator className="my-1 h-px bg-line" />;
export function ContextMenuLabel({ children }: { children: React.ReactNode }) {
  return <Ctx.Label className="truncate px-2 py-1 text-xs text-muted">{children}</Ctx.Label>;
}
