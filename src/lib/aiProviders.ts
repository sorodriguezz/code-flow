import { Bot, Cpu, Gem, HardDrive, SquareTerminal, Waves, type LucideIcon } from "lucide-react";
import type { TranslationKey } from "./i18n/translations";

export interface AiProviderOption {
  id: string;
  label?: string;
  labelKey?: TranslationKey;
  icon: LucideIcon;
  /** Claude Code and Gemini invoke a real CLI subprocess; the rest are shown disabled with a
   * "coming soon" badge so the picker reads as real infrastructure, not a placeholder. */
  available: boolean;
  /** Default binary name shown in Settings when the user hasn't set a path — mirrors each
   * engine's `default_binary()` on the Rust side. */
  defaultBinary?: string;
}

export const AI_PROVIDERS: AiProviderOption[] = [
  { id: "claude", label: "Claude Code", icon: Bot, available: true, defaultBinary: "claude" },
  { id: "codex", label: "Codex", icon: Cpu, available: false },
  // Gemini runs against a Google-account OAuth login (Google AI Pro / Ultra subscription, or the
  // free Code Assist tier) — the CLI's own login, same model as Claude's. See `gemini.rs`.
  { id: "gemini", label: "Gemini", icon: Gem, available: true, defaultBinary: "gemini" },
  // opencode is provider-agnostic: it drives whatever model providers the user configured inside
  // it, addressed as `provider/model`. Headless via `opencode run`. See `opencode.rs`.
  { id: "opencode", label: "opencode", icon: SquareTerminal, available: true, defaultBinary: "opencode" },
  { id: "deepseek", label: "DeepSeek", icon: Waves, available: false },
  { id: "local", labelKey: "settings.localModel", icon: HardDrive, available: false },
];

export const DEFAULT_AI_PROVIDER = "claude";

export interface AiModelOption {
  /** Exactly what gets passed to the CLI's `--model`. */
  id: string;
  label?: string;
  labelKey?: TranslationKey;
}

/** Which models each provider offers, keyed by provider id — the settings dropdown and the
 * chat's "what am I talking to" chip both read from here, so wiring up Codex/Gemini later is
 * one more entry rather than a second list to keep in sync. Providers that aren't invokable
 * yet have no entry; `modelDisplayLabel` degrades to showing the raw id for them. */
export const PROVIDER_MODELS: Record<string, AiModelOption[]> = {
  claude: [
    { id: "claude-sonnet-5", label: "Sonnet 5" },
    { id: "claude-opus-4-8", label: "Opus 4.8" },
    { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
    { id: "claude-fable-5", label: "Fable 5" },
  ],
  // Gemini model ids move fast; these are the common ones. The "custom" option in Settings lets
  // the user type whatever their subscription/CLI actually exposes if these drift.
  gemini: [
    { id: "gemini-3-pro", label: "Gemini 3 Pro" },
    { id: "gemini-2.5-pro", label: "2.5 Pro" },
    { id: "gemini-2.5-flash", label: "2.5 Flash" },
  ],
  // opencode addresses models as `provider/model`, and which are available depends entirely on the
  // providers the user configured inside opencode — so these are just format examples. The
  // "custom" field in Settings (and leaving it on "default") is the real path.
  opencode: [
    { id: "anthropic/claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
    { id: "openai/gpt-5", label: "GPT-5" },
    { id: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  ],
};

/** Short, human-readable name for the model a provider is currently pointed at.
 *
 * `modelId` is the raw stored setting, which has three shapes: empty means no `--model` flag
 * is passed at all and the CLI picks for itself (so the honest answer is "whatever it
 * defaults to", not a specific version), a known id maps to its short label, and anything
 * else is a custom id the user typed, shown verbatim. */
export function modelDisplayLabel(
  providerId: string,
  modelId: string,
  t: (key: TranslationKey) => string,
): string {
  const trimmed = modelId.trim();
  if (!trimmed) return t("ai.modelDefault");
  const models = PROVIDER_MODELS[providerId] ?? [];
  const known = models.find((m) => m.id === trimmed) ?? models.find((m) => sameModelFamily(m.id, trimmed));
  if (!known) return trimmed;
  return known.label ?? (known.labelKey ? t(known.labelKey) : trimmed);
}

/** Whether two model ids name the same model at different levels of precision, e.g. the
 * catalog's `claude-opus-4-8` and the dated `claude-opus-4-8-20260101` a run actually reports.
 * The separator is required so `claude-opus-4-8` can't swallow a hypothetical
 * `claude-opus-4-80`. */
function sameModelFamily(a: string, b: string): boolean {
  const [longer, shorter] = a.length >= b.length ? [a, b] : [b, a];
  return longer.startsWith(`${shorter}-`);
}
