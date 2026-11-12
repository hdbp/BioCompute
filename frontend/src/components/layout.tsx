import { useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity, Boxes, FlaskConical, FolderOutput, LayoutDashboard, LogOut, Menu, Moon, Network, PanelLeftClose, PanelLeftOpen, Settings, Sun, Telescope, Workflow, ListChecks,
} from "lucide-react";
import { can } from "@/lib/auth";
import type { Run } from "@/lib/types";
import { Breadcrumbs, ErrorBoundary } from "@/components/page";
import { api, authed } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { useTheme } from "@/hooks/theme";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/menu";

// Ordered the way an analysis goes: samples, pipeline, run, results. Cluster and settings come last.
type Role = "viewer" | "scientist" | "admin";
const NAV: { to: string; label: string; icon: typeof Boxes; end?: boolean; also?: string[]; group?: string; role?: Role }[] = [
  { to: "/", label: "Home", icon: LayoutDashboard, end: true },
  { to: "/experiments", label: "Experiments", icon: FlaskConical },
  { to: "/pipelines", label: "Pipelines", icon: Boxes },
  { to: "/studio", label: "Pipeline Studio", icon: Workflow, role: "scientist" },
  { to: "/jobs", label: "Runs", icon: ListChecks, also: ["/runs"] },
  { to: "/results", label: "Results", icon: FolderOutput },
  { to: "/explore", label: "Data Explorer", icon: Telescope },
  { to: "/nodes", label: "Nodes", icon: Network, group: "System" },
  { to: "/settings", label: "Settings", icon: Settings, group: "System" },
];

interface Dash { runs: { active: number; queued: number }; nodes: { online: number }; resources: { cpu_allocatable: number }; engine: { nextflow: { available: boolean } } }

/** Global server-sent events -> invalidate the relevant queries so every page stays live. */
function useLiveUpdates() {
  const qc = useQueryClient();
  const token = useAuth((s) => s.token);
  const me = useAuth((s) => s.user?.username);
  const nav = useNavigate();
  const told = useRef(new Set<string>());
  useEffect(() => {
    if (!token) return;
    const es = new EventSource(authed("/api/events"));
    let t: ReturnType<typeof setTimeout> | null = null;
    const pending = new Set<string>();
    es.onmessage = (m) => {
      try {
        const d = JSON.parse(m.data);
        if (d.topic === "run") {
          pending.add("runs"); pending.add("dashboard"); if (d.run_id) pending.add(`run:${d.run_id}`);
          // tell the person who started it when their run ends (once per run and outcome)
          const key = `${d.run_id}:${d.status}`;
          if (d.run_id && ["completed", "failed", "cancelled", "lost"].includes(d.status) && !told.current.has(key)) {
            told.current.add(key);
            api.get<Run>(`/api/runs/${d.run_id}`).then((r) => {
              if (r.created_by !== me || r.status !== d.status) return;
              const open = { label: "Open", onClick: () => nav(`/runs/${r.id}`) };
              if (r.status === "completed") toast.success(`Run “${r.name}” finished`, { action: open, duration: 10000 });
              else if (r.status === "failed" || r.status === "lost") toast.error(`Run “${r.name}” ${r.status === "lost" ? "was lost" : "failed"}`, { action: open, duration: 20000 });
              else toast.message(`Run “${r.name}” was cancelled`, { action: open });
            }).catch(() => undefined);
          }
        }
        if (d.topic === "nodes") { pending.add("nodes"); pending.add("dashboard"); }
      } catch { /* ignore */ }
      if (!t) t = setTimeout(() => {
        pending.forEach((k) => (k.startsWith("run:") ? qc.invalidateQueries({ queryKey: ["run", k.slice(4)] }) : qc.invalidateQueries({ queryKey: [k] })));
        pending.clear();
        t = null;
      }, 400);
    };
    return () => { es.close(); if (t) clearTimeout(t); };
  }, [token, qc, me, nav]);
}

function useStored(key: string, initial: boolean): [boolean, (v: boolean) => void] {
  const [v, setV] = useState(() => { try { const x = localStorage.getItem(key); return x === null ? initial : x === "1"; } catch { return initial; } });
  return [v, (x) => { setV(x); try { localStorage.setItem(key, x ? "1" : "0"); } catch { /* ignore */ } }];
}

export function Layout() {
  const { user, logout } = useAuth();
  const { theme, toggle } = useTheme();
  const loc = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  useLiveUpdates();
  useEffect(() => setMobileOpen(false), [loc.pathname]);
  // the live event stream refreshes this; the interval is only a fallback
  const dash = useQuery({ queryKey: ["dashboard"], queryFn: () => api.get<Dash>("/api/dashboard"), refetchInterval: 60000 });
  const fullBleed = loc.pathname.startsWith("/studio") || loc.pathname.startsWith("/explore") || /^\/pipelines\/[^/]+\/(map|code)$/.test(loc.pathname);
  // the sidebar can be folded to icons; editors (full-window pages) remember their own choice and start folded on laptops
  const [foldPages, setFoldPages] = useStored("biocompute.nav.fold", false);
  const [foldEditors, setFoldEditors] = useStored("biocompute.nav.fold-editors", typeof window !== "undefined" && window.innerWidth < 1500);
  const folded = fullBleed ? foldEditors : foldPages;
  const setFolded = fullBleed ? setFoldEditors : setFoldPages;
  const [isMobile, setIsMobile] = useState(() => typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const h = () => setIsMobile(mq.matches);
    mq.addEventListener("change", h);
    return () => mq.removeEventListener("change", h);
  }, []);
  const aside = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!mobileOpen) return;
    aside.current?.querySelector<HTMLElement>("a")?.focus();
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") setMobileOpen(false); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [mobileOpen]);
  const mini = folded && !isMobile;

  const items = NAV.filter((n) => !n.role || can(user, n.role));
  const active = (n: (typeof NAV)[number]) => (n.end ? loc.pathname === n.to : [n.to, ...(n.also ?? [])].some((p) => loc.pathname === p || loc.pathname.startsWith(p + "/")));
  const nav = (
    <nav className="flex flex-col gap-0.5 px-2" aria-label="Main">
      {items.map((n, i) => (
        <div key={n.to}>
          {n.group && n.group !== items[i - 1]?.group && (
            mini ? <div className="mx-2 my-2 border-t border-line" /> : <p className="px-2.5 pb-1 pt-4 text-[11px] font-medium uppercase tracking-wide text-muted/80">{n.group}</p>
          )}
          <NavLink to={n.to} end={n.end} title={mini ? n.label : undefined} aria-label={n.label} aria-current={active(n) ? "page" : undefined}
            className={cn("flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13.5px] text-muted hover:text-text hover:bg-raised/70",
              active(n) && "bg-raised text-text [&_svg]:text-accent", mini && "justify-center px-0 py-2")}>
            <span className="relative">
              <n.icon className="size-4" />
              {mini && n.to === "/jobs" && (dash.data?.runs.active ?? 0) > 0 && <span className="absolute -right-1.5 -top-1.5 size-2 rounded-full bg-run" />}
            </span>
            {!mini && n.label}
            {!mini && n.to === "/jobs" && (dash.data?.runs.active ?? 0) > 0 && (
              <span className="ml-auto rounded-full bg-run/15 px-1.5 text-[11px] text-run tabular-nums" title="Runs in progress">{dash.data?.runs.active}</span>
            )}
          </NavLink>
        </div>
      ))}
    </nav>
  );

  return (
    <div className="flex h-full">
      <aside ref={aside} aria-label="Navigation" {...(isMobile && !mobileOpen ? { inert: "" as unknown as undefined, "aria-hidden": true } : {})}
        className={cn("fixed inset-y-0 left-0 z-40 shrink-0 border-r border-line bg-surface flex flex-col transition-[transform,width] md:static md:translate-x-0",
          mini ? "w-14" : "w-56", mobileOpen ? "translate-x-0" : "-translate-x-full")}>
        <div className={cn("flex items-center gap-2.5 h-14", mini ? "justify-center px-0" : "px-4")}>
          <svg viewBox="0 0 32 32" className="size-7 shrink-0" aria-hidden><rect width="32" height="32" rx="7" className="fill-raised" /><g className="fill-accent"><circle cx="10" cy="10" r="3" /><circle cx="22" cy="10" r="3" opacity=".45" /><circle cx="10" cy="22" r="3" opacity=".45" /><circle cx="22" cy="22" r="3" /></g></svg>
          {!mini && (
            <div className="leading-tight">
              <p className="font-semibold text-[15px]">BioCompute</p>
              <p className="text-[11px] text-muted">lab cluster</p>
            </div>
          )}
        </div>
        <div className="flex-1 overflow-y-auto py-2">{nav}</div>
        <div className={cn("border-t border-line text-xs text-muted", mini ? "p-2" : "p-3 space-y-2")}>
          {!mini && (
            <>
              <div className="flex items-center gap-2">
                <Activity className="size-3.5" />
                <span>{dash.data ? `${dash.data.nodes.online} online, ${dash.data.resources.cpu_allocatable} cores available` : dash.isError ? "Controller not reachable" : "Connecting…"}</span>
              </div>
              {dash.data && !dash.data.engine.nextflow.available && <p className="text-wait">Nextflow not found on the controller</p>}
            </>
          )}
          <button onClick={() => setFolded(!folded)} className={cn("hidden md:flex items-center gap-2 rounded-md py-1 text-muted hover:text-text", mini ? "w-full justify-center" : "")}
            aria-label={folded ? "Expand the navigation" : "Fold the navigation to icons"} title={folded ? "Expand the navigation" : "Fold the navigation to icons"}>
            {folded ? <PanelLeftOpen className="size-4" /> : <><PanelLeftClose className="size-4" />Fold</>}
          </button>
        </div>
      </aside>
      {mobileOpen && <div className="fixed inset-0 z-30 bg-black/50 md:hidden" onClick={() => setMobileOpen(false)} />}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-4 md:px-6">
          <button className="md:hidden rounded p-1.5 hover:bg-raised" onClick={() => setMobileOpen(true)} aria-label="Open navigation" aria-expanded={mobileOpen}><Menu className="size-5" /></button>
          <div className="min-w-0 flex-1"><Breadcrumbs /></div>
          <button onClick={toggle} className="rounded-md p-2 text-muted hover:text-text hover:bg-raised" aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}>
            {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-raised">
              <span className="grid size-7 place-items-center rounded-full bg-accent/20 text-accent text-xs font-semibold">{user?.username.slice(0, 2).toUpperCase()}</span>
              <span className="hidden sm:block text-[13px]">{user?.username}</span>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuLabel>Signed in as {user?.username} ({user?.role})</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={logout}><LogOut />Sign out</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </header>
        <main className={cn("flex-1 min-h-0", fullBleed ? "overflow-hidden" : "overflow-y-auto")}>
          <ErrorBoundary resetKey={loc.pathname}>
            {fullBleed ? <Outlet /> : <div className="mx-auto max-w-[1400px] px-4 py-6 md:px-8 md:py-8"><Outlet /></div>}
          </ErrorBoundary>
        </main>
      </div>
    </div>
  );
}
