import { useEffect } from "react";
import { useBlocker } from "react-router-dom";
import { confirmDialog } from "@/components/ui/confirm";

/**
 * Warn before unsaved work is lost: on in-app navigation to another page (a dialog), and on closing or
 * reloading the tab (the browser's own prompt). Changing only the query string of the same page is not blocked,
 * unless `sameRoute` is set.
 */
export function useUnsavedGuard(dirty: boolean, what = "changes", opts: { sameRoute?: boolean } = {}) {
  const blocker = useBlocker(({ currentLocation, nextLocation }) =>
    dirty && (currentLocation.pathname !== nextLocation.pathname || (!!opts.sameRoute && currentLocation.search !== nextLocation.search)));
  useEffect(() => {
    if (blocker.state !== "blocked") return;
    let live = true;
    confirmDialog({
      title: "Leave without saving?", body: `Your unsaved ${what} will be lost.`,
      confirmLabel: "Leave without saving", cancelLabel: "Stay", danger: true,
    }).then((leave) => { if (!live) return; if (leave) blocker.proceed(); else blocker.reset(); });
    return () => { live = false; };
  }, [blocker, what]);
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);
}
