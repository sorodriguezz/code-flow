import { Bot, Cpu, Gem, HardDrive, Waves, type LucideIcon } from "lucide-react";
import type { TranslationKey } from "./i18n/translations";

export interface AiProviderOption {
  id: string;
  label?: string;
  labelKey?: TranslationKey;
  icon: LucideIcon;
  /** Only Claude Code actually invokes anything today — the rest are shown disabled with a
   * "coming soon" badge so the picker reads as real infrastructure, not a placeholder. */
  available: boolean;
}

export const AI_PROVIDERS: AiProviderOption[] = [
  { id: "claude", label: "Claude Code", icon: Bot, available: true },
  { id: "codex", label: "Codex", icon: Cpu, available: false },
  { id: "gemini", label: "Gemini", icon: Gem, available: false },
  { id: "deepseek", label: "DeepSeek", icon: Waves, available: false },
  { id: "local", labelKey: "settings.localModel", icon: HardDrive, available: false },
];

export const DEFAULT_AI_PROVIDER = "claude";
