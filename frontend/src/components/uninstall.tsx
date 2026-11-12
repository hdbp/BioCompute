import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errMsg } from "@/lib/api";
import type { Pipeline } from "@/lib/types";
import { bytes } from "@/lib/utils";
import { confirmDialog } from "@/components/ui/confirm";

type P = Pick<Pipeline, "id" | "name" | "run_count">;
interface Result { result: "deleted" | "archived"; freed: number; kept_versions: number; removed_versions: number }

/** Uninstall and restore a pipeline. Without runs it is deleted; with runs it is hidden and keeps the versions they used. */
export function usePipelineUninstall(onUninstalled?: (p: P, r: Result) => void) {
  const qc = useQueryClient();
  const refresh = (id: string) => {
    for (const k of [["pipelines"], ["pipelines-archived"], ["pipeline", id], ["storage"]]) qc.invalidateQueries({ queryKey: k });
  };
  const uninstall = useMutation({
    mutationFn: (p: P) => api.del<Result>(`/api/pipelines/${p.id}`),
    onSuccess: (r, p) => {
      toast.success(r.result === "deleted"
        ? `Uninstalled ${p.name}${r.freed ? ` (${bytes(r.freed)} freed)` : ""}`
        : `Uninstalled ${p.name}. The ${r.kept_versions === 1 ? "version" : `${r.kept_versions} versions`} its runs used ${r.kept_versions === 1 ? "is" : "are"} kept; restore it under Pipelines, Uninstalled.`);
      refresh(p.id);
      onUninstalled?.(p, r);
    },
    onError: (e) => toast.error(`The pipeline was not uninstalled: ${errMsg(e)}`),
  });
  const restore = useMutation({
    mutationFn: (p: P) => api.post(`/api/pipelines/${p.id}/restore`),
    onSuccess: (_r, p) => { toast.success(`${p.name} is installed again`); refresh(p.id); },
    onError: (e) => toast.error(`The pipeline was not restored: ${errMsg(e)}`),
  });
  const ask = async (p: P) => {
    const ran = p.run_count > 0;
    if (await confirmDialog({
      title: `Uninstall ${p.name}?`,
      body: ran
        ? <>It has {p.run_count} run{p.run_count === 1 ? "" : "s"}, so its record and the versions those runs used are kept: the runs stay traceable and can still be resumed. Everything else goes: the pipeline leaves the lists and the launch form, and its other versions are deleted. You can restore it later (Pipelines, Uninstalled).</>
        : "It has never been run: the pipeline, its versions and its parameter presets are deleted. Files in a folder you imported it from are not touched.",
      confirmLabel: "Uninstall", danger: true,
    })) uninstall.mutate(p);
  };
  return { ask, uninstall, restore };
}
