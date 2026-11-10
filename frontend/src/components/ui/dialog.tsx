import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export function DialogContent({ className, children, title, description, wide, ...props }:
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { title: string; description?: React.ReactNode; wide?: boolean }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/55 backdrop-blur-[2px] data-[state=open]:animate-in" />
      <DialogPrimitive.Content
        className={cn("fixed left-1/2 top-1/2 z-50 w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-line bg-surface shadow-2xl shadow-black/40 max-h-[88vh] flex flex-col", wide ? "max-w-3xl" : "max-w-lg", className)}
        {...props}>
        <div className="flex items-start justify-between gap-4 px-5 pt-4 pb-3 border-b border-line">
          <div>
            <DialogPrimitive.Title className="text-[15px] font-semibold">{title}</DialogPrimitive.Title>
            {description ? <DialogPrimitive.Description className="text-[13px] text-muted mt-0.5">{description}</DialogPrimitive.Description>
              : <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>}
          </div>
          <DialogPrimitive.Close className="rounded p-1 text-muted hover:text-text hover:bg-raised" aria-label="Close"><X className="size-4" /></DialogPrimitive.Close>
        </div>
        <div className="overflow-y-auto px-5 py-4">{children}</div>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogFooter({ children }: { children: React.ReactNode }) {
  return <div className="flex justify-end gap-2 pt-4 mt-2 border-t border-line -mx-5 px-5">{children}</div>;
}

/** Right-hand drawer built on the dialog primitive. */
export function Sheet({ open, onOpenChange, title, description, children, width = "max-w-xl" }: {
  open: boolean; onOpenChange: (o: boolean) => void; title: React.ReactNode; description?: React.ReactNode; children: React.ReactNode; width?: string;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <DialogPrimitive.Content className={cn("fixed right-0 top-0 z-50 h-full w-full border-l border-line bg-surface shadow-2xl flex flex-col transition-transform", width)}>
          <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-line">
            <div className="min-w-0">
              <DialogPrimitive.Title className="text-[15px] font-semibold truncate">{title}</DialogPrimitive.Title>
              <DialogPrimitive.Description className={description ? "text-[13px] text-muted mt-0.5" : "sr-only"}>{description ?? "Details"}</DialogPrimitive.Description>
            </div>
            <DialogPrimitive.Close className="rounded p-1 text-muted hover:text-text hover:bg-raised" aria-label="Close"><X className="size-4" /></DialogPrimitive.Close>
          </div>
          <div className="flex-1 overflow-y-auto">{children}</div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
