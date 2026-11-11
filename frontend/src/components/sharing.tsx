import { Lock, Users } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { Badge, Tip } from "@/components/ui/misc";
import { Button } from "@/components/ui/button";

export type Visibility = "private" | "lab";

/** "Private" / "Shared with the lab" / "Shared by alice". Items without an owner (catalog, examples) show nothing. */
export function SharingBadge({ owner, visibility }: { owner: string | null | undefined; visibility: Visibility | string | undefined }) {
  const me = useAuth((s) => s.user?.username);
  if (!owner) return null;
  if (visibility === "private") {
    return <Tip content={owner === me ? "Only you (and administrators) can see this." : `Private to ${owner}; you see it as an administrator.`}>
      <Badge className="cursor-help"><Lock className="size-3" />{owner === me ? "Private" : `Private to ${owner}`}</Badge>
    </Tip>;
  }
  return <Badge tone="accent"><Users className="size-3" />{owner === me ? "Shared with the lab" : `Shared by ${owner}`}</Badge>;
}

/** Owner-only switch between private and shared. */
export function ShareButton({ visibility, onChange, loading, size = "sm", compact }: {
  visibility: Visibility | string; onChange: (v: Visibility) => void; loading?: boolean; size?: "sm" | "md"; compact?: boolean;
}) {
  const shared = visibility === "lab";
  return (
    <Tip content={shared ? "Everyone in the lab can see, run and copy it; only you can change it." : "Only you can see it. Share it so the lab can run and copy it."}>
      <Button size={size} variant="ghost" loading={loading} onClick={() => onChange(shared ? "private" : "lab")} aria-label={shared ? "Make private" : "Share with lab"}>
        {shared ? <Lock /> : <Users />}<span className={compact ? "hidden 2xl:inline" : undefined}>{shared ? "Make private" : "Share with lab"}</span>
      </Button>
    </Tip>
  );
}
