import * as React from "react";
import { cn } from "@/lib/utils";

export const inputClass =
  "h-8.5 w-full rounded-md border border-line bg-ink/60 px-2.5 text-[13px] text-text placeholder:text-muted/70 focus-visible:outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/25 disabled:opacity-50 aria-[invalid=true]:border-bad";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => <input ref={ref} className={cn(inputClass, className)} {...props} />,
);
Input.displayName = "Input";

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => <textarea ref={ref} className={cn(inputClass, "h-auto min-h-20 py-2", className)} {...props} />,
);
Textarea.displayName = "Textarea";

export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, children, ...props }, ref) => (
    <select ref={ref} className={cn(inputClass, "pr-7 appearance-none bg-[length:12px] bg-[right_8px_center] bg-no-repeat", className)}
      style={{ backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%238797AE' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")" }}
      {...props}>
      {children}
    </select>
  ),
);
Select.displayName = "Select";

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn("text-[13px] font-medium text-text", className)} {...props} />;
}

/** Label + control + hint/error. A single input/select/textarea child is linked to the label automatically. */
export function Field({ label, hint, error, children, required, className }: {
  label: React.ReactNode; hint?: React.ReactNode; error?: string | null; children: React.ReactNode; required?: boolean; className?: string;
}) {
  const auto = React.useId();
  const msgId = `${auto}-msg`;
  type CtlProps = { id?: string; "aria-describedby"?: string; "aria-required"?: boolean };
  const el = React.isValidElement<CtlProps>(children) ? children : null;
  // forwardRef controls (Input, Select, Textarea, Switch...), native controls, or anything given an explicit id
  const linkable = !!el && (typeof el.type === "object" || ["input", "select", "textarea"].includes(el.type as string) || !!el.props.id);
  const id = linkable ? el!.props.id ?? auto : undefined;
  const control = linkable
    ? React.cloneElement(el!, { id, ...(error || hint ? { "aria-describedby": msgId } : {}), ...(required ? { "aria-required": true } : {}) })
    : children;
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label htmlFor={id}>{label}{required && <span className="text-bad ml-0.5" aria-hidden>*</span>}</Label>
      {control}
      {error ? <p id={msgId} className="text-xs text-bad">{error}</p> : hint ? <p id={msgId} className="text-xs text-muted">{hint}</p> : null}
    </div>
  );
}
