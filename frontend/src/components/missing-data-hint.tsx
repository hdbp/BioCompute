import { Link } from "react-router-dom";
import { can, useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";

/** Where to go when the data you want is not in any data folder. */
export function MissingDataHint({ className, onNavigate }: { className?: string; onNavigate?: () => void }) {
  const admin = can(useAuth((s) => s.user), "admin");
  return (
    <p className={cn("text-[12px] text-muted", className)}>
      Data not listed?{" "}
      {admin ? <Link to="/settings?tab=system" onClick={onNavigate} className="text-accent hover:underline">Add its folder in Settings</Link>
        : "Ask an administrator to add its folder in Settings."}
    </p>
  );
}
