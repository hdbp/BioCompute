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
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    // the browser got no HTTP response at all ("Failed to fetch" / "Load failed" / NetworkError)
    throw new ApiError(0, `No response from the BioCompute server at ${window.location.host} (${method} ${path.split("?")[0]}). `
      + "The server stopped or restarted, or the connection was cut. Check the terminal or service log where BioCompute runs, then try again.");
  }
  if (res.status === 401 && !path.endsWith("/login")) {
    useAuth.getState().logout();
  }
  if (!res.ok) {
    let detail: unknown = res.statusText;
    try {
      const j = await res.json();
      detail = j.detail ?? j;
      if (Array.isArray(detail)) detail = detail.map((d: { msg?: string; loc?: string[] }) => `${(d.loc ?? []).slice(1).join(".")}: ${d.msg}`).join("; ");
    } catch {
      // not JSON: a proxy (Vite dev server, nginx) answered because the backend did not
      if (res.status >= 500) detail = `The BioCompute backend did not answer (HTTP ${res.status} from the proxy in front of it). Is it still running?`;
    }
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

/**
 * URL for <a>/<iframe>/<img>/EventSource, which cannot send an Authorization header. The login token is never put
 * in a URL: these requests carry the HttpOnly file cookie set by ensureMediaCookie() (GET/HEAD only).
 */
export const authed = (path: string) => path;

let cookieFor: string | null = null;
/** Ask the server for the file cookie once per login (also after a page reload with a stored session). */
export async function ensureMediaCookie(force = false): Promise<void> {
  const t = useAuth.getState().token;
  if (!t || (!force && cookieFor === t)) return;
  cookieFor = t;
  try {
    await fetch("/api/auth/media-cookie", { method: "POST", headers: { Authorization: `Bearer ${t}` }, credentials: "same-origin" });
  } catch { cookieFor = null; /* retried on the next call */ }
}

export function clearMediaCookie() {
  cookieFor = null;
  fetch("/api/auth/media-cookie", { method: "DELETE", credentials: "same-origin" }).catch(() => undefined);
}

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
