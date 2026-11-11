import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, Lightbulb, Sparkles, Wand2, X } from "lucide-react";
import { api, errMsg } from "@/lib/api";
import { can, useAuth } from "@/lib/auth";
import type { AssistantMeta, AssistantStatus, Issue } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { Badge, Checkbox, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/misc";

type RawGraph = { nodes: unknown[]; edges: unknown[] };
interface BuildResult {
  graph: RawGraph; name: string; description: string; explanation: string; assumptions: string[];
  missing_modules: { tool: string; reason: string }[]; valid: boolean; issues: Issue[]; attempts: number; meta: AssistantMeta;
}
interface ReviewResult {
  verdict: "sound" | "needs_changes" | "invalid"; summary: string; recommendations: string[];
  findings: { severity: "error" | "warning" | "suggestion"; node_id: string; title: string; detail: string }[];
  validator: { valid: boolean; issues: Issue[] }; meta: AssistantMeta;
}
interface AskResult { answer: string; suggestions: string[]; meta: AssistantMeta }

const VERDICT = { sound: { tone: "ok", label: "Looks sound" }, needs_changes: { tone: "wait", label: "Needs changes" }, invalid: { tone: "bad", label: "Will not work as is" } } as const;

export function AssistantPanel({ getGraph, hasNodes, onClose, onLoad, onSelectNode, onDraftModule, nodeLabel }: {
  getGraph: () => RawGraph; hasNodes: boolean; onClose: () => void;
  onLoad: (r: { graph: RawGraph; name: string; description: string }) => void;
  onSelectNode: (id: string) => void; onDraftModule: (tool: string, reason: string) => void; nodeLabel: (id: string) => string | null;
}) {
  const user = useAuth((s) => s.user);
  const status = useQuery({ queryKey: ["assistant-status"], queryFn: () => api.get<AssistantStatus>("/api/assistant/status"), staleTime: 60_000 });
  const [busy, setBusy] = useState<null | "build" | "review" | "ask">(null);
  const [prompt, setPrompt] = useState("");
  const [modify, setModify] = useState(false);
  const [build, setBuild] = useState<BuildResult | null>(null);
  const [goal, setGoal] = useState("");
  const [review, setReview] = useState<ReviewResult | null>(null);
  const [question, setQuestion] = useState("");
  const [answers, setAnswers] = useState<{ q: string; a: AskResult }[]>([]);

  const run = async <T,>(kind: "build" | "review" | "ask", fn: () => Promise<T>) => {
    setBusy(kind);
    try { return await fn(); } catch (e) { toast.error(errMsg(e)); return null; } finally { setBusy(null); }
  };

  const doBuild = () => run("build", async () => {
    const r = await api.post<BuildResult>("/api/assistant/build", { description: prompt, graph: modify && hasNodes ? getGraph() : null });
    setBuild(r);
  });
  const doReview = () => run("review", async () => setReview(await api.post<ReviewResult>("/api/assistant/review", { graph: getGraph(), goal })));
  const doAsk = () => run("ask", async () => {
    const r = await api.post<AskResult>("/api/assistant/ask", { question, graph: hasNodes ? getGraph() : null });
    setAnswers((a) => [{ q: question, a: r }, ...a]);
    setQuestion("");
  });

  const st = status.data;
  return (
    <aside className="flex w-[22rem] shrink-0 flex-col border-l border-line bg-surface" aria-label="Pipeline assistant">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
        <Sparkles className="size-4 text-accent" />
        <p className="flex-1 text-sm font-semibold">Assistant</p>
        {st?.enabled && <span className="truncate text-[11.5px] text-muted">{st.providers[st.provider]?.label}{st.model ? ` · ${st.model}` : ""}</span>}
        <button onClick={onClose} className="rounded p-1 text-muted hover:bg-raised hover:text-text" aria-label="Close assistant"><X className="size-4" /></button>
      </div>
      {!st ? null : !st.enabled ? (
        <div className="space-y-2 p-4 text-[13px]">
          <p>The assistant is off.</p>
          <p className="text-muted">It can use Claude (Anthropic API), ChatGPT (OpenAI API) or Claude Code installed on the controller.</p>
          {can(user, "admin") ? <Link to="/settings?tab=assistant" className="text-accent hover:underline">Set it up in Settings</Link>
            : <p className="text-muted">Ask an administrator to enable it in Settings.</p>}
        </div>
      ) : (
        <Tabs defaultValue="build" className="flex min-h-0 flex-1 flex-col">
          <TabsList className="mx-3 mt-3">
            <TabsTrigger value="build">Build</TabsTrigger>
            <TabsTrigger value="review">Review</TabsTrigger>
            <TabsTrigger value="ask">Ask</TabsTrigger>
          </TabsList>
          <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4 pt-3 text-[13px]">
            <TabsContent value="build" className="space-y-3">
              <Textarea rows={5} value={prompt} onChange={(e) => setPrompt(e.target.value)} aria-label="Describe the pipeline"
                placeholder="e.g. ATAC-seq, paired-end, mouse: trimming, Bowtie2, remove chrM and duplicates, call peaks, MultiQC" />
              <label className="flex items-center gap-2 text-[12.5px] text-muted">
                <Checkbox checked={modify && hasNodes} disabled={!hasNodes} onCheckedChange={(c) => setModify(!!c)} />Change the pipeline on the canvas instead of starting over
              </label>
              <Button size="sm" variant="primary" onClick={doBuild} loading={busy === "build"} disabled={prompt.trim().length < 3}><Wand2 />Build pipeline</Button>
              {busy === "build" && <p className="text-xs text-muted">Designing and checking the graph. This usually takes 20 to 60 seconds.</p>}
              {build && (
                <div className="space-y-3 rounded-lg border border-line p-3">
                  <div className="flex items-center gap-2">
                    <p className="flex-1 font-medium">{build.name}</p>
                    {build.valid ? <Badge tone="ok"><CheckCircle2 className="size-3" />valid</Badge> : <Badge tone="bad">{build.issues.filter((i) => i.level === "error").length} errors</Badge>}
                  </div>
                  <p className="whitespace-pre-wrap">{build.explanation}</p>
                  {build.assumptions.length > 0 && <Section title="Assumptions"><ul className="list-disc space-y-1 pl-4">{build.assumptions.map((a, i) => <li key={i}>{a}</li>)}</ul></Section>}
                  {build.missing_modules.length > 0 && (
                    <Section title="Software without a module">
                      <ul className="space-y-2">
                        {build.missing_modules.map((m, i) => (
                          <li key={i} className="rounded-md bg-raised/50 p-2">
                            <p className="font-medium">{m.tool}</p><p className="text-muted">{m.reason}</p>
                            <Button size="sm" variant="ghost" className="mt-1 h-7" onClick={() => onDraftModule(m.tool, m.reason)}><Sparkles />Create a module</Button>
                          </li>
                        ))}
                      </ul>
                    </Section>
                  )}
                  {!build.valid && <Section title="Validator"><Issues issues={build.issues} /></Section>}
                  <div className="flex items-center gap-2 pt-1">
                    <Button size="sm" variant="secondary" onClick={() => onLoad(build)}>Load into editor</Button>
                    <Meta m={build.meta} extra={build.attempts > 1 ? `${build.attempts} rounds` : undefined} />
                  </div>
                </div>
              )}
            </TabsContent>

            <TabsContent value="review" className="space-y-3">
              <p className="text-muted">Checks the pipeline on the canvas: whether it will run, and whether the steps and parameters make sense for the analysis.</p>
              <Textarea rows={2} value={goal} onChange={(e) => setGoal(e.target.value)} aria-label="Goal of the analysis" placeholder="Optional: the goal, e.g. H3K27ac differential binding, 2 conditions × 3 replicates" />
              <Button size="sm" variant="primary" onClick={doReview} loading={busy === "review"} disabled={!hasNodes}><Lightbulb />Review pipeline</Button>
              {review && (
                <div className="space-y-3 rounded-lg border border-line p-3">
                  <Badge tone={VERDICT[review.verdict].tone}>{VERDICT[review.verdict].label}</Badge>
                  <p className="whitespace-pre-wrap">{review.summary}</p>
                  {review.findings.length > 0 && (
                    <ul className="space-y-1.5">
                      {review.findings.map((f, i) => (
                        <li key={i}>
                          <button className="w-full rounded-md p-2 text-left hover:bg-raised disabled:hover:bg-transparent" disabled={!f.node_id || !nodeLabel(f.node_id)} onClick={() => onSelectNode(f.node_id)}>
                            <p className="flex items-center gap-1.5">
                              <span className={cn("size-1.5 shrink-0 rounded-full", f.severity === "error" ? "bg-bad" : f.severity === "warning" ? "bg-wait" : "bg-accent")} />
                              <span className="font-medium">{f.title}</span>
                              {f.node_id && nodeLabel(f.node_id) && <span className="ml-auto text-xs text-muted">{nodeLabel(f.node_id)}</span>}
                            </p>
                            <p className="mt-0.5 text-muted">{f.detail}</p>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  {review.recommendations.length > 0 && <Section title="Recommendations"><ul className="list-disc space-y-1 pl-4">{review.recommendations.map((r, i) => <li key={i}>{r}</li>)}</ul></Section>}
                  <div className="flex items-center gap-2">
                    {review.recommendations.length > 0 && (
                      <Button size="sm" variant="secondary" onClick={() => { setPrompt(`Apply these recommendations:\n- ${review.recommendations.join("\n- ")}`); setModify(true); toast.message("Recommendations copied to the Build tab"); }}>
                        Apply with Build
                      </Button>
                    )}
                    <Meta m={review.meta} />
                  </div>
                </div>
              )}
            </TabsContent>

            <TabsContent value="ask" className="space-y-3">
              <form onSubmit={(e) => { e.preventDefault(); if (question.trim().length > 1) doAsk(); }} className="space-y-2">
                <Textarea rows={3} value={question} onChange={(e) => setQuestion(e.target.value)} aria-label="Question"
                  placeholder="e.g. Should I use MACS3 or SEACR for CUT&Tag with low background?" />
                <Button type="submit" size="sm" variant="primary" loading={busy === "ask"} disabled={question.trim().length < 2}>Ask</Button>
              </form>
              {answers.map(({ q, a }, i) => (
                <div key={i} className="space-y-2 rounded-lg border border-line p-3">
                  <p className="font-medium">{q}</p>
                  <p className="whitespace-pre-wrap">{a.answer}</p>
                  {a.suggestions.length > 0 && <ul className="list-disc space-y-1 pl-4 text-muted">{a.suggestions.map((s, k) => <li key={k}>{s}</li>)}</ul>}
                  <Meta m={a.meta} />
                </div>
              ))}
            </TabsContent>
          </div>
          <p className="border-t border-line px-3 py-2 text-[11.5px] text-muted">{st.privacy} Suggestions are never saved or run without you.</p>
        </Tabs>
      )}
    </aside>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <div><p className="mb-1 text-xs font-medium text-muted">{title}</p>{children}</div>;
}

function Issues({ issues }: { issues: Issue[] }) {
  return (
    <ul className="space-y-1">
      {issues.map((i, k) => (
        <li key={k} className={cn("flex gap-1.5", i.level === "error" ? "text-bad" : "text-wait")}><AlertTriangle className="mt-0.5 size-3.5 shrink-0" />{i.message}</li>
      ))}
    </ul>
  );
}

function Meta({ m, extra }: { m: AssistantMeta; extra?: string }) {
  const parts = [m.model, extra, m.cost_usd != null ? `$${m.cost_usd.toFixed(2)}` : null,
    m.input_tokens != null ? `${(m.input_tokens + (m.output_tokens ?? 0)).toLocaleString()} tokens` : null].filter(Boolean);
  return <span className="ml-auto text-[11px] text-muted">{parts.join(" · ")}</span>;
}
