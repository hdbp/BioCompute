import * as React from "react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { cn } from "@/lib/utils";

export const DropdownMenu = Menu.Root;
export const DropdownMenuTrigger = Menu.Trigger;
export function DropdownMenuContent({ className, ...props }: React.ComponentPropsWithoutRef<typeof Menu.Content>) {
  return (
    <Menu.Portal>
      <Menu.Content sideOffset={6} align="end" className={cn("z-50 min-w-44 rounded-lg border border-line bg-surface p-1 shadow-xl shadow-black/30", className)} {...props} />
    </Menu.Portal>
  );
}
export function DropdownMenuItem({ className, danger, ...props }: React.ComponentPropsWithoutRef<typeof Menu.Item> & { danger?: boolean }) {
  return <Menu.Item className={cn("flex cursor-pointer select-none items-center gap-2 rounded-md px-2 py-1.5 text-[13px] outline-none data-[highlighted]:bg-raised data-[disabled]:opacity-40 [&_svg]:size-4 [&_svg]:text-muted", danger && "text-bad [&_svg]:text-bad", className)} {...props} />;
}
export const DropdownMenuSeparator = () => <Menu.Separator className="my-1 h-px bg-line" />;
export function DropdownMenuLabel({ children }: { children: React.ReactNode }) {
  return <Menu.Label className="px-2 py-1 text-xs text-muted">{children}</Menu.Label>;
}
