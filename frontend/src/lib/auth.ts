import { create } from "zustand";
import type { User } from "./types";

interface AuthState {
  token: string | null;
  user: User | null;
  setSession: (token: string, user: User) => void;
  logout: () => void;
}

const KEY = "biocompute.session";
function load(): { token: string | null; user: User | null } {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* storage unavailable */ }
  return { token: null, user: null };
}

export const useAuth = create<AuthState>((set) => ({
  ...load(),
  setSession: (token, user) => {
    try { localStorage.setItem(KEY, JSON.stringify({ token, user })); } catch { /* ignore */ }
    set({ token, user });
  },
  logout: () => {
    try { localStorage.removeItem(KEY); } catch { /* ignore */ }
    // the file cookie is HttpOnly: only the server can remove it
    fetch("/api/auth/media-cookie", { method: "DELETE", credentials: "same-origin" }).catch(() => undefined);
    set({ token: null, user: null });
  },
}));

export const can = (user: User | null, role: "viewer" | "scientist" | "admin") => {
  const rank = { viewer: 0, scientist: 1, admin: 2 } as const;
  return !!user && rank[user.role] >= rank[role];
};
