// Mirrors backend/app/schemas.py
export type Role = "admin" | "scientist" | "viewer";
export interface User { id: string; username: string; role: Role; is_active: boolean }

export interface PipelineVersion {
  id: string; version: string; git_commit: string | null; git_ref: string | null; path: string | null;
  pinned: boolean; engines: string[]; software: string[]; outputs: { name: string; path?: string; description?: string }[];
  created_at: string;
}
export interface Pipeline {
  id: string; slug: string; name: string; description: string; category: string;
  kind: "installed" | "template" | "studio"; source_type: string; source_url: string | null; engine: string;
  favorite: boolean; tags: string[]; studio_workflow_id: string | null; created_at: string; updated_at: string;
  owner: string | null; visibility: "private" | "lab"; can_edit: boolean;
  latest_version: PipelineVersion | null; has_schema: boolean; run_count: number; last_run_status: string | null; preset_count: number;
}
export interface InputColumn {
  name: string; required: boolean; types: string[]; format: string | null; pattern: string | null; enum: string[] | null;
  is_file: boolean; description: string; meta: string[] | null; dependent_required: string[] | null;
}
export interface PipelineDetail extends Pipeline {
  versions: PipelineVersion[]; readme: string | null; manifest: Record<string, unknown>;
  input_columns: InputColumn[]; runnable: { engine: string; available: boolean; detail?: string }[];
}
export interface FormField {
  name: string; type: string; widget: "text" | "number" | "select" | "toggle" | "file" | "directory" | "textarea";
  format: string | null; description: string; help: string; default: unknown; enum: (string | number)[] | null;
  minimum: number | null; maximum: number | null; pattern: string | null; required: boolean; hidden: boolean; icon: string | null;
  schema: string | null; mimetype: string | null;
}
export interface FormGroup { id: string; title: string; description: string; icon: string | null; fields: FormField[]; advanced: boolean }
export interface FormSchema {
  pipeline_id: string; version_id: string;
  form: { title: string | null; description: string | null; groups: FormGroup[]; has_schema: boolean };
  defaults: Record<string, unknown>; input_columns: InputColumn[]; raw: unknown; profiles: string[];
}
export interface Preset { id: string; pipeline_id: string; name: string; description: string; params: Record<string, unknown>; created_by: string | null; created_at: string }
export interface Issue { level: "error" | "warning" | "info"; message: string; field?: string | null; sample?: string | null; node?: string | null; edge?: string | null; row?: number }

export interface Sample {
  id?: string; position?: number; sample_id: string; condition: string | null; replicate: number | null;
  technical_replicate: number | null; batch: string | null; is_control: boolean; control_id: string | null;
  files: Record<string, unknown>; attributes: Record<string, unknown>;
}
export interface Experiment {
  id: string; name: string; description: string; assay: string; genome?: string | null; custom_columns: string[];
  visibility?: "private" | "lab"; can_edit?: boolean;
  conditions: { name: string; color?: string; description?: string }[];
  contrasts: { id?: string; name: string; treatment: string; reference: string }[];
  created_by: string | null; created_at: string; updated_at: string; sample_count: number;
}
export interface ExperimentDetail extends Experiment { samples: Sample[] }

export interface FsEntry { name: string; path: string; type: "dir" | "file"; kind: string; size: number | null; mtime: string }
export interface DataRoot { name: string; restricted: boolean; writable: boolean; description: string; exists: boolean }
export interface Listing { root: DataRoot; path: string; parent: string | null; entries: FsEntry[]; truncated: boolean }

export interface ProcessProgress { submitted: number; completed: number; cached: number; failed: number; running: number }
export interface Task { hash: string; process: string; tag: string | null; status: string; exit?: string; duration?: string; realtime?: string; cpu?: string; peak_rss?: string; workdir?: string }
export interface Run {
  id: string; name: string; pipeline_id: string; pipeline_version_id: string; experiment_id: string | null; engine: string;
  status: RunStatus; params: Record<string, unknown>; resources: Record<string, unknown>; placement: Record<string, unknown>;
  output_dir: string; run_dir: string; work_dir: string | null; exit_code: number | null; error: string | null;
  progress: { processes?: Record<string, ProcessProgress>; tasks?: Task[]; total?: number; done?: number; failed?: number };
  started_at: string | null; finished_at: string | null; created_at: string; attempt: number; created_by: string | null;
  can_edit?: boolean;
  pipeline_name: string | null; pipeline_version: string | null; experiment_name: string | null; output_vpath: string | null;
}
export type RunStatus = "pending" | "preflight" | "queued" | "running" | "completed" | "failed" | "cancelling" | "cancelled" | "lost";
export interface RunEvent { id: number; ts: string; kind: string; message: string; data: Record<string, unknown> }
export interface RunDetail extends Run { provenance: Record<string, unknown>; events: RunEvent[] }

export interface Allocation {
  enabled: boolean; max_cpus: number; max_memory_gb: number; gpus_allowed: number; scratch_limit_gb: number;
  max_concurrent_jobs: number; priority: number; idle_only: boolean; allowed_hours: string | null; require_ac_power: boolean;
  data_policy: "local-only" | "approved-staging" | "any"; preferred_workloads: string[]; draining: boolean; preset: string;
}
export interface ClusterNode {
  id: string; hostname: string; display_name: string | null; state: NodeState; is_controller: boolean; site: string | null;
  os: string | null; os_version: string | null; arch: string | null; cpu_model: string | null; cpu_physical: number | null;
  cpu_logical: number | null; mem_total: number | null; mem_available: number | null;
  gpus: { vendor?: string; name?: string; memory_mb?: number; cores?: number }[];
  disks: { path: string; total: number; free: number }[]; addresses: string[]; discovery_sources: string[];
  software: Record<string, string>; htcondor: Record<string, unknown>; agent_installed: boolean; agent_version: string | null;
  utilization: { cpu_percent?: number; mem_percent?: number; load?: number[]; power?: { has_battery?: boolean; on_ac?: boolean; percent?: number }; user_idle_seconds?: number };
  last_seen: string | null; notes: string; allocation: Allocation | null; eligibility: { eligible: boolean; reasons: string[] }; created_at: string;
  network: { tailscale?: { online?: boolean; dns_name?: string | null; ips?: string[]; os?: string; seen_at?: string } };
  tailnet: { member: boolean; via: string | null; online: boolean | null; dns_name: string | null; ips: string[] };
  capacity: NodeCapacity;
}
export interface NodeCapacity {
  cpus_allocated: number; cpus_free: number; cpus_total: number; mem_allocated_gb: number; mem_free_gb: number;
  disk_free_gb: number | null; scratch_path: string | null; gpus_allocated: number; gpus_total: number; gpu_names: string[];
  link: { down_mbps: number | null; up_mbps: number | null; rtt_ms: number | null; measured_at: string | null; basis: string };
}
export type NodeState = "discovered" | "candidate" | "enrolled" | "active" | "draining" | "disabled" | "offline";

export interface StudioModule {
  id: string; kind: "source" | "sink" | "module"; name: string; category: string; description: string; scope?: "per_sample" | "aggregate";
  inputs: { name: string; type: string; multiple?: boolean }[]; outputs: { name: string; type: string; pattern?: string }[];
  params: { name: string; type: string; default?: unknown; enum?: unknown[]; minimum?: number; maximum?: number; description?: string; widget?: "path"; path_mode?: "file" | "dir" | "auto" }[];
  tools?: string[]; cpus?: number; memory_gb?: number; language?: string; script?: string; conda?: string; container?: string; custom?: boolean; user?: boolean;
  owner?: string | null; visibility?: "private" | "lab"; can_edit?: boolean;
}
export interface StudioWorkflow { id: string; name: string; description: string; graph: { nodes: unknown[]; edges: unknown[]; meta?: Record<string, unknown> }; created_by: string | null; visibility: "private" | "lab"; can_edit: boolean; created_at: string; updated_at: string }

/** A user-defined Pipeline Studio module (same shape the API stores and exports). */
export interface ModuleDef {
  id: string; name: string; category: string; description: string; scope: "per_sample" | "aggregate"; language: "bash" | "python" | "r";
  inputs: { name: string; type: string; multiple: boolean }[];
  outputs: { name: string; type: string; pattern: string }[];
  params: { name: string; type: "string" | "integer" | "number" | "boolean"; default: string | number | boolean | null; enum: (string | number)[] | null; description: string }[];
  tools: string[]; conda: string; container: string; cpus: number; memory_gb: number; script: string;
}
export interface ModuleIssue { level: "error" | "warning" | "info"; field?: string; message: string }
export interface ModuleCheck { valid: boolean; issues: ModuleIssue[]; module: ModuleDef | null }
export interface InstalledTool { exe: string; name: string; category: string; template: string | null; path: string; version: string | null }

export interface AssistantMeta {
  provider: string; model: string; task?: string; calls?: number;
  /** what was charged for this answer (API key or cloud provider); null with a Claude subscription */
  cost_usd?: number | null;
  /** Claude Code with a subscription: the API-price figure it reports, not a charge */
  api_equivalent_usd?: number | null;
  billing?: "subscription" | "api" | "cloud" | "unknown";
  input_tokens?: number | null; output_tokens?: number | null;
}
export interface AssistantStatus {
  provider: "off" | "anthropic" | "openai" | "claude-cli"; model: string; effort: string; enabled: boolean; ready: boolean; privacy: string;
  providers: Record<string, { label: string; default_model: string; configured: boolean; source: string | null; hint: string | null; note?: string;
    auth?: { logged_in: boolean; billing: "subscription" | "api" | "cloud" | "unknown"; method: string | null } }>;
}

export interface Project {
  id: string; name: string; description: string; owner: string | null; visibility: "private" | "lab"; home: string | null;
  item_count: number; can_edit: boolean; created_at: string; updated_at: string;
}
export interface ProjectItem {
  id: string; kind: "folder" | "file" | "run"; ref: string; label: string; added_by: string; added_at: string; exists: boolean;
  run_name?: string; status?: string; output?: string | null;
}
export interface ProjectDetail extends Project { items: ProjectItem[]; folders: { data: string | null; results: string | null; analyses: string | null } }
