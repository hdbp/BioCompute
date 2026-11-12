/** Parameters edited on a pipeline page, handed to the launch form ("Run with these parameters"). */
const KEY = "biocompute.launch.prefill";
export interface LaunchPrefill { pipeline_id: string; version_id?: string | null; params: Record<string, unknown>; from?: string }

export function setLaunchPrefill(p: LaunchPrefill) {
  try { sessionStorage.setItem(KEY, JSON.stringify(p)); } catch { /* storage unavailable: the form just starts with defaults */ }
}

/** Returns the prefill for this pipeline once (it is removed), or null. */
export function takeLaunchPrefill(pipelineId: string): LaunchPrefill | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as LaunchPrefill;
    if (p.pipeline_id !== pipelineId) return null;
    sessionStorage.removeItem(KEY);
    return p;
  } catch { return null; }
}
