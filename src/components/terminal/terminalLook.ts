import { Bug, Box, Cloud, Database, Flame, Rocket, Server, TerminalSquare, type LucideIcon } from "lucide-react";
import type { TranslationKey } from "../../lib/i18n/translations";

/**
 * The colours and icons a dock terminal can be given — a tab pointed at production in red with a
 * flame, the one running the API with a server. Stored as tokens, drawn from the theme, so a tab
 * keeps its meaning in light and dark.
 */
export const TERMINAL_COLORS: { id: string; css: string; label: TranslationKey }[] = [
  { id: "red", css: "var(--cf-danger)", label: "terminal.colorRed" },
  { id: "amber", css: "var(--cf-warning)", label: "terminal.colorAmber" },
  { id: "green", css: "var(--cf-success)", label: "terminal.colorGreen" },
  { id: "blue", css: "var(--cf-blue)", label: "terminal.colorBlue" },
  { id: "violet", css: "var(--cf-violet)", label: "terminal.colorViolet" },
  { id: "pink", css: "color-mix(in srgb, var(--cf-danger) 55%, var(--cf-violet))", label: "terminal.colorPink" },
];

export const TERMINAL_ICONS: { id: string; icon: LucideIcon; label: TranslationKey }[] = [
  { id: "terminal", icon: TerminalSquare, label: "terminal.iconDefault" },
  { id: "server", icon: Server, label: "terminal.iconServer" },
  { id: "database", icon: Database, label: "terminal.iconDatabase" },
  { id: "cloud", icon: Cloud, label: "terminal.iconCloud" },
  { id: "bug", icon: Bug, label: "terminal.iconBug" },
  { id: "rocket", icon: Rocket, label: "terminal.iconRocket" },
  { id: "flame", icon: Flame, label: "terminal.iconFlame" },
  { id: "box", icon: Box, label: "terminal.iconBox" },
];

export function colorCss(id: string | undefined): string | null {
  return TERMINAL_COLORS.find((color) => color.id === id)?.css ?? null;
}

export function iconFor(id: string | undefined): LucideIcon {
  return TERMINAL_ICONS.find((icon) => icon.id === id)?.icon ?? TerminalSquare;
}
