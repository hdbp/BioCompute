import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Sparkles } from "lucide-react";
import { api, errMsg } from "@/lib/api";
import type { AssistantMeta, AssistantStatus } from "@/lib/types";
import { Badge, Panel } from "@/components/ui/misc";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/input";

const PROVIDER_HELP: Record<string, string> = {
  anthropic: "Claude models through the Anthropic API. Needs an API key from console.anthropic.com (billed per use).",
  openai: "ChatGPT models through the OpenAI API. Needs an API key from platform.openai.com (billed per use).",
  "claude-cli": "Claude Code installed and signed in on the controller, for the account that runs BioCompute. Uses that subscription or key; no key is stored here.",
};

export function AssistantSettings({ admin }: { admin: boolean }) {
  const qc = useQueryClient();
  const st = useQuery({ queryKey: ["assistant-status"], queryFn: () => api.get<AssistantStatus>("/api/assistant/status") });
  const [form, setForm] = useState<{ provider: string; model: string; effort: string; api_key: string } | null>(null);
  const d = st.data;
  const f = form ?? (d ? { provider: d.provider, model: d.model, effort: d.effort, api_key: "" } : null);
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.put<AssistantStatus>("/api/assistant/config", body),
    onSuccess: (r) => { qc.setQueryData(["assistant-status"], r); setForm(null); toast.success("Saved"); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const test = useMutation({
    mutationFn: () => api.post<{ ok: boolean; meta: AssistantMeta }>("/api/assistant/test"),
    onSuccess: (r) => toast.success(`Connected: ${r.meta.model}${r.meta.cost_usd != null ? ` ($${r.meta.cost_usd.toFixed(3)})` : ""}`),
    onError: (e) => toast.error(errMsg(e)),
  });
  if (!d || !f) return null;
  const p = d.providers[f.provider];
  const keyed = f.provider === "anthropic" || f.provider === "openai";
  const keyHint = p?.configured
    ? `Configured (${p.source}${p.hint ? `, ending ${p.hint.slice(1)}` : ""}). Enter a new key to replace it.`
    : "Stored on the controller only (state directory, readable by the service account). Never shown again.";
  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_380px]">
      <Panel className="space-y-4 p-4">
        <div className="flex items-center gap-2">
          <Sparkles className="size-4 text-accent" /><p className="font-semibold">Pipeline assistant</p>
          {d.enabled ? <Badge tone="ok">on</Badge> : <Badge>off</Badge>}
        </div>
        <p className="text-[13px] text-muted">
          In Pipeline Studio the assistant builds pipelines from a description, reviews a pipeline's logic, answers questions and drafts
          modules for installed software. It only proposes: results open in the editor and nothing is saved or run without you.
        </p>
        <Field label="Provider">
          <Select disabled={!admin} value={f.provider} onChange={(e) => setForm({ ...f, provider: e.target.value, model: "", api_key: "" })}>
            <option value="off">Off</option>
            {Object.entries(d.providers).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </Select>
        </Field>
        {f.provider !== "off" && p && (
          <>
            <p className="text-[12.5px] text-muted">{PROVIDER_HELP[f.provider]}</p>
            <Field label="Model" hint={p.default_model ? `Leave empty for ${p.default_model}` : "Leave empty for Claude Code's default model"}>
              <Input disabled={!admin} className="font-mono" value={f.model} placeholder={p.default_model || "default"} onChange={(e) => setForm({ ...f, model: e.target.value })} />
            </Field>
            {f.provider === "anthropic" && (
              <Field label="Effort" hint="Higher effort reasons more thoroughly and takes longer">
                <Select disabled={!admin} value={f.effort} onChange={(e) => setForm({ ...f, effort: e.target.value })}>
                  {["low", "medium", "high", "xhigh", "max"].map((x) => <option key={x}>{x}</option>)}
                </Select>
              </Field>
            )}
            {keyed && (
              <Field label="API key" hint={keyHint}>
                <Input disabled={!admin} type="password" autoComplete="off" value={f.api_key} placeholder={p.configured ? "••••••••" : "paste key"}
                  onChange={(e) => setForm({ ...f, api_key: e.target.value })} />
              </Field>
            )}
            {p.note && <p className="text-[12.5px] text-wait">{p.note}</p>}
            {f.provider === "claude-cli" && !p.configured && <p className="text-[12.5px] text-bad">The claude command was not found on the controller.</p>}
          </>
        )}
        {admin ? (
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" loading={save.isPending}
              onClick={() => save.mutate({ provider: f.provider, model: f.model, effort: f.effort, api_key: f.api_key || null })}>Save</Button>
            {d.enabled && <Button variant="secondary" loading={test.isPending} onClick={() => test.mutate()} disabled={!!form}>Test connection</Button>}
            {keyed && p?.source === "saved in BioCompute" && (
              <Button variant="ghost" onClick={() => save.mutate({ provider: f.provider, model: f.model, effort: f.effort, clear_key: true })}>Remove saved key</Button>
            )}
          </div>
        ) : <p className="text-[12.5px] text-muted">Only administrators can change these settings.</p>}
      </Panel>
      <Panel className="space-y-2 p-4 text-[13px]">
        <p className="font-semibold">What is sent</p>
        <p className="text-muted">{d.privacy}</p>
        <p className="text-muted">
          Requests go from the controller to the provider you choose. Every request is recorded in the audit log with the user,
          provider, model and (for Claude Code) its cost.
        </p>
        {d.provider === "anthropic" && (
          <p className="text-muted">
            For Claude models that support it, server-side fallback is on: if the primary model's safety classifier declines a request,
            the API retries it on a fallback model.
          </p>
        )}
      </Panel>
    </div>
  );
}
