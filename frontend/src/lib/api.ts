import { useAuth } from "./auth";

export class ApiError extends Error {
  status: number;
  detail: unknown;
  constructor(status: number, detail: unknown) {
    super(typeof detail === "string" ? detail : (detail as { message?: string })?.message ?? `Request failed (${status})`);
    this.status = status;
    this.detail = detail;
  }
  get issues(): { message: string; field?: string; level?: string; sample?: string }[] {
    const d = this.detail as { issues?: [] };
    return (d && Array.isArray(d.issues) ? d.issues : []) as never;
  }
}

async function request<T>(method: string, path: string, body?: unknown, opts: { raw?: boolean } = {}): Promise<T> {
  const token = useAuth.getState().token;
  const res = await fetch(path, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && !path.endsWith("/login")) {
    useAuth.getState().logout();
  }
  if (!res.ok) {
    let detail: unknown = res.statusText;
    try {
      const j = await res.json();
      detail = j.detail ?? j;
      if (Array.isArray(detail)) detail = detail.map((d: { msg?: string; loc?: string[] }) => `${(d.loc ?? []).slice(1).join(".")}: ${d.msg}`).join("; ");
    } catch { /* not json */ }
    throw new ApiError(res.status, detail);
  }
  if (opts.raw) return res as unknown as T;
  const ct = res.headers.get("content-type") ?? "";
  return (ct.includes("application/json") ? res.json() : res.text()) as Promise<T>;
}

export const api = {
  get: <T>(p: string) => request<T>("GET", p),
  post: <T>(p: string, b?: unknown) => request<T>("POST", p, b ?? {}),
  put: <T>(p: string, b?: unknown) => request<T>("PUT", p, b ?? {}),
  patch: <T>(p: string, b?: unknown) => request<T>("PATCH", p, b ?? {}),
  del: <T>(p: string) => request<T>("DELETE", p),
  raw: (method: string, p: string, b?: unknown) => request<Response>(method, p, b, { raw: true }),
};

export const qs = (o: Record<string, string | number | boolean | undefined | null>) => {
  const s = new URLSearchParams();
  Object.entries(o).forEach(([k, v]) => v !== undefined && v !== null && v !== "" && s.set(k, String(v)));
  const r = s.toString();
  return r ? `?${r}` : "";
};

/** URL usable in <a>/<iframe>/EventSource, which cannot send Authorization headers. */
export const authed = (path: string) => {
  const t = useAuth.getState().token;
  return `${path}${path.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(t ?? "")}`;
};

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
