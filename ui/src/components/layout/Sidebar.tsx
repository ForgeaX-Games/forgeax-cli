import { NavLink } from "react-router";
import {
  LayoutDashboard,
  Server,
  Radio,
  Package,
  Sparkles,
  Puzzle,
  LayoutTemplate,
  KeyRound,
  Settings,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/provider";
import type { Messages } from "@/lib/i18n";

const navItems: { to: string; icon: typeof LayoutDashboard; labelKey: keyof Messages; end?: boolean }[] = [
  { to: "/admin", icon: LayoutDashboard, labelKey: "navDashboard", end: true },
  { to: "/admin/instances", icon: Server, labelKey: "navInstances" },
  { to: "/admin/channels", icon: Radio, labelKey: "navChannels" },
  { to: "/admin/packs", icon: Package, labelKey: "navPacks" },
  { to: "/admin/skills", icon: Sparkles, labelKey: "navSkills" },
  { to: "/admin/capabilities", icon: Puzzle, labelKey: "navCapabilities" },
  { to: "/admin/templates", icon: LayoutTemplate, labelKey: "navTemplates" },
  { to: "/admin/keys", icon: KeyRound, labelKey: "navKeys" },
  { to: "/admin/settings", icon: Settings, labelKey: "navSettings" },
];

export function Sidebar() {
  const t = useT();
  return (
    <aside className="flex h-full w-56 flex-col border-r bg-card">
      <div className="flex h-14 items-center border-b px-4">
        <span className="text-lg font-bold tracking-tight">AgenTeam</span>
        <span className="ml-1.5 text-xs text-muted-foreground font-medium">Admin</span>
      </div>
      <nav className="flex-1 space-y-1 p-3">
        {navItems.map(({ to, icon: Icon, labelKey, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                isActive
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              )
            }
          >
            <Icon className="h-4 w-4" />
            {t[labelKey]}
          </NavLink>
        ))}
      </nav>
    </aside>
  );
}
