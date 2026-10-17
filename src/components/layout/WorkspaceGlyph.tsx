import {
  Briefcase,
  Building2,
  Cloud,
  Code2,
  Database,
  FlaskConical,
  Gamepad2,
  Globe,
  GraduationCap,
  Heart,
  House,
  Layers,
  Package,
  Palette,
  Rocket,
  Server,
  Shield,
  Star,
  Terminal,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { monogram, monogramStyle } from "../../lib/monogram";

/** The workspace's icon when it shows its initials — the default for a new one. */
export const INITIALS_ICON = "initials";

/**
 * What a workspace can be drawn as, besides its initials. Stored by key in `workspaces.icon`; a
 * key this list does not know (a future one, a hand-edited row) draws as initials rather than as
 * nothing. `briefcase` is first because every workspace made before this picker carries it.
 */
export const WORKSPACE_ICONS: Record<string, LucideIcon> = {
  briefcase: Briefcase,
  "building-2": Building2,
  rocket: Rocket,
  "code-2": Code2,
  terminal: Terminal,
  server: Server,
  database: Database,
  cloud: Cloud,
  globe: Globe,
  layers: Layers,
  package: Package,
  "flask-conical": FlaskConical,
  shield: Shield,
  zap: Zap,
  star: Star,
  heart: Heart,
  house: House,
  palette: Palette,
  "graduation-cap": GraduationCap,
  "gamepad-2": Gamepad2,
};

/**
 * A workspace's tile: its colour wash, holding either its two-letter monogram — the same rule the
 * repositories under it use, so a rail of both reads as one kind of thing — or the icon picked for
 * it in its menu.
 */
export function WorkspaceGlyph({
  name,
  icon,
  color,
  size = 28,
}: {
  name: string;
  icon: string;
  color: string;
  size?: number;
}) {
  const Icon = WORKSPACE_ICONS[icon];
  return (
    <span
      aria-hidden
      className="flex shrink-0 items-center justify-center font-bold tracking-[0.02em]"
      style={{
        ...monogramStyle(color),
        width: size,
        height: size,
        borderRadius: Math.round(size / 4),
        fontSize: Math.round(size * 0.4),
      }}
    >
      {Icon ? <Icon size={Math.round(size / 2)} /> : monogram(name)}
    </span>
  );
}
