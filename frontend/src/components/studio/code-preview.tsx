import { useMemo, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const ORDER = ["main.nf", "nextflow.config", "nextflow_schema.json", "bcflow.json", "assets/schema_input.json"];

export function CodePreview({ open, onOpenChange, files }: { open: boolean; onOpenChange: (o: boolean) => void; files: Record<string, string> | null }) {
  const names = useMemo(() => {
    const all = Object.keys(files ?? {});
    return [...ORDER.filter((n) => all.includes(n)), ...all.filter((n) => !ORDER.includes(n)).sort()];
  }, [files]);
  const [active, setActive] = useState("main.nf");
  const [copied, setCopied] = useState(false);
  const cur = files?.[active] !== undefined ? active : names[0];
  const content = (cur && files?.[cur]) || "";

  async function copy() {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard unavailable */ }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent wide className="max-w-5xl" title="Generated pipeline"
        description="Nextflow DSL2 for the supported graph subset, its parameter schema, and the equivalent native-engine manifest. Read-only: edit the graph and regenerate.">
        <div className="flex min-h-[60vh] gap-3">
          <nav className="w-52 shrink-0 space-y-0.5" aria-label="Generated files">
            {names.map((n) => (
              <button key={n} onClick={() => setActive(n)}
                className={cn("block w-full truncate rounded-md px-2 py-1.5 text-left font-mono text-[12px] hover:bg-raised", n === cur ? "bg-raised text-text" : "text-muted")}>
                {n}
              </button>
            ))}
          </nav>
          <div className="relative min-w-0 flex-1 rounded-md border border-line bg-ink">
            <Button size="sm" variant="secondary" className="absolute right-2 top-2 z-10" onClick={copy}>
              {copied ? <Check /> : <Copy />}{copied ? "Copied" : "Copy"}
            </Button>
            <pre className="h-[62vh] overflow-auto p-4 font-mono text-[12px] leading-relaxed text-text"><code>{content}</code></pre>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
