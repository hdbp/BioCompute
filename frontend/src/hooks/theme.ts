import { useEffect } from "react";
import { create } from "zustand";

type Theme = "dark" | "light";
const KEY = "biocompute.theme";
const initial = (): Theme => {
  try { return (localStorage.getItem(KEY) as Theme) || "dark"; } catch { return "dark"; }
};
const store = create<{ theme: Theme; set: (t: Theme) => void }>((set) => ({ theme: initial(), set: (theme) => set({ theme }) }));

export function useTheme() {
  const { theme, set } = store();
  useEffect(() => {
    const el = document.documentElement;
    el.classList.toggle("dark", theme === "dark");
    el.classList.toggle("light", theme === "light");
    try { localStorage.setItem(KEY, theme); } catch { /* ignore */ }
  }, [theme]);
  return { theme, toggle: () => set(theme === "dark" ? "light" : "dark") };
}
