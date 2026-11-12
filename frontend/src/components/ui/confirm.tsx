import { useEffect, useState } from "react";
import { create } from "zustand";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/input";

interface Base { title: string; body?: React.ReactNode; confirmLabel?: string; cancelLabel?: string; danger?: boolean }
interface PromptOpts extends Base { label?: string; defaultValue?: string; placeholder?: string; hint?: string }
type Req = ({ kind: "confirm" } & Base | { kind: "prompt" } & PromptOpts) & { resolve: (v: boolean | string | null) => void };

const useStore = create<{ req: Req | null; set: (r: Req | null) => void }>((set) => ({ req: null, set: (req) => set({ req }) }));

/** In-app replacement for window.confirm: `if (!(await confirmDialog({ title, body, danger: true }))) return;` */
export function confirmDialog(opts: Base): Promise<boolean> {
  return new Promise((resolve) => useStore.getState().set({ kind: "confirm", ...opts, resolve: (v) => resolve(v === true) }));
}

/** In-app replacement for window.prompt; resolves to the text, or null when cancelled. */
export function promptDialog(opts: PromptOpts): Promise<string | null> {
  return new Promise((resolve) => useStore.getState().set({ kind: "prompt", ...opts, resolve: (v) => resolve(typeof v === "string" ? v : null) }));
}

/** Mounted once (main.tsx); renders the dialog asked for by confirmDialog / promptDialog. */
export function ConfirmHost() {
  const { req, set } = useStore();
  const [text, setText] = useState("");
  useEffect(() => { if (req?.kind === "prompt") setText(req.defaultValue ?? ""); }, [req]);
  if (!req) return null;
  const done = (v: boolean | string | null) => { req.resolve(v); set(null); };
  const ok = () => done(req.kind === "prompt" ? text.trim() || null : true);
  return (
    <Dialog open onOpenChange={(o) => { if (!o) done(req.kind === "prompt" ? null : false); }}>
      <DialogContent title={req.title} description={req.kind === "confirm" ? undefined : req.body}>
        {req.kind === "confirm" && req.body && <div className="text-[13.5px] leading-relaxed text-text/90">{req.body}</div>}
        {req.kind === "prompt" && (
          <Field label={req.label ?? "Name"} hint={req.hint}>
            <Input autoFocus value={text} placeholder={req.placeholder} onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && text.trim()) ok(); }} />
          </Field>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => done(req.kind === "prompt" ? null : false)}>{req.cancelLabel ?? "Cancel"}</Button>
          <Button variant={req.danger ? "danger" : "primary"} autoFocus={req.kind === "confirm"} disabled={req.kind === "prompt" && !text.trim()} onClick={ok}>
            {req.confirmLabel ?? (req.danger ? "Delete" : "OK")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
