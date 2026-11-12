import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity, Boxes, FlaskConical, FolderOutput, LayoutDashboard, LogOut, Menu, Moon, Network, Settings, Sun, Telescope, Workflow, ListChecks,
} from "lucide-react";
import { api, authed } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { useTheme } from "@/hooks/theme";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/menu";

const NAV = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/nodes", label: "Nodes", icon: Network },
  { to: "/pipelines", label: "Pipelines", icon: Boxes },
  { to: "/studio", label: "Pipeline Studio", icon: Workflow },
  { to: "/experiments", label: "Experiments", icon: FlaskConical },
  { to: "/jobs", label: "Jobs", icon: ListChecks },
  { to: "/results", label: "Results", icon: FolderOutput },
  { to: "/explore", label: "Data Explorer", icon: Telescope },
  { to: "/settings", label: "Settings", icon: Settings },
];

interface Dash { runs: { active: number; queued: number }; nodes: { online: number }; resources: { cpu_allocatable: number }; engine: { nextflow: { available: boolean } } }

/** Global server-sent events -> invalidate the relevant queries so every page stays live. */
function useLiveUpdates() {
  const qc = useQueryClient();
  const token = useAuth((s) => s.token);
  useEffect(() => {
    if (!token) return;
    const es = new EventSource(authed("/api/events"));
    let t: ReturnType<typeof setTimeout> | null = null;
    const pending = new Set<string>();
    es.onmessage = (m) => {
      try {
        const d = JSON.parse(m.data);
        if (d.topic === "run") { pending.add("runs"); pending.add("dashboard"); if (d.run_id) pending.add(`run:${d.run_id}`); }
        if (d.topic === "nodes") { pending.add("nodes"); pending.add("dashboard"); }
      } catch { /* ignore */ }
      if (!t) t = setTimeout(() => {
        pending.forEach((k) => (k.startsWith("run:") ? qc.invalidateQueries({ queryKey: ["run", k.slice(4)] }) : qc.invalidateQueries({ queryKey: [k] })));
        pending.clear();
        t = null;
      }, 400);
    };
    return () => { es.close(); if (t) clearTimeout(t); };
  }, [token, qc]);
}

export function Layout() {
  const { user, logout } = useAuth();
  const { theme, toggle } = useTheme();
  const loc = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  useLiveUpdates();
  useEffect(() => setMobileOpen(false), [loc.pathname]);
  const dash = useQuery({ queryKey: ["dashboard"], queryFn: () => api.get<Dash>("/api/dashboard"), refetchInterval: 15000 });
  const fullBleed = loc.pathname.startsWith("/studio") || loc.pathname.startsWith("/explore") || /^\/pipelines\/[^/]+\/map$/.test(loc.pathname);

  const nav = (
    <nav className="flex flex-col gap-0.5 px-2" aria-label="Main">
      {NAV.map((n) => (
        <NavLink key={n.to} to={n.to} end={n.end}
          className={({ isActive }) => cn("flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13.5px] text-muted hover:text-text hover:bg-raised/70",
            isActive && "bg-raised text-text [&_svg]:text-accent")}>
          <n.icon className="size-4" />
          {n.label}
          {n.to === "/jobs" && (dash.data?.runs.active ?? 0) > 0 && (
            <span className="ml-auto rounded-full bg-run/15 px-1.5 text-[11px] text-run tabular-nums">{dash.data?.runs.active}</span>
          )}
        </NavLink>
      ))}
    </nav>
  );

  return (
    <div className="flex h-full">
      <aside className={cn("fixed inset-y-0 left-0 z-40 w-56 shrink-0 border-r border-line bg-surface flex flex-col transition-transform md:static md:translate-x-0",
        mobileOpen ? "translate-x-0" : "-translate-x-full")}>
        <div className="flex items-center gap-2.5 px-4 h-14">
          <svg viewBox="0 0 32 32" className="size-7" aria-hidden><rect width="32" height="32" rx="7" className="fill-raised" /><g className="fill-accent"><circle cx="10" cy="10" r="3" /><circle cx="22" cy="10" r="3" opacity=".45" /><circle cx="10" cy="22" r="3" opacity=".45" /><circle cx="22" cy="22" r="3" /></g></svg>
          <div className="leading-tight">
            <p className="font-semibold text-[15px]">BioCompute</p>
            <p className="text-[11px] text-muted">lab cluster</p>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto py-2">{nav}</div>
        <div className="border-t border-line p-3 space-y-2 text-xs text-muted">
          <div className="flex items-center gap-2">
            <Activity className="size-3.5" />
            <span>{dash.data ? `${dash.data.nodes.online} online, ${dash.data.resources.cpu_allocatable} cores allocatable` : "Connecting…"}</span>
          </div>
          {dash.data && !dash.data.engine.nextflow.available && (
            <p className="text-wait">Nextflow not found on controller</p>
          )}
        </div>
      </aside>
      {mobileOpen && <div className="fixed inset-0 z-30 bg-black/50 md:hidden" onClick={() => setMobileOpen(false)} />}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-4 md:px-6">
          <button className="md:hidden rounded p-1.5 hover:bg-raised" onClick={() => setMobileOpen(true)} aria-label="Open navigation"><Menu className="size-5" /></button>
          <div className="flex-1" />
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
          {fullBleed ? <Outlet /> : <div className="mx-auto max-w-[1400px] px-4 py-6 md:px-8 md:py-8"><Outlet /></div>}
        </main>
      </div>
    </div>
  );
}
