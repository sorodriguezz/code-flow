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
   * engine's `default_binary()` on the Rust side. For Ollama this is the HTTP endpoint. */
  defaultBinary?: string;
  /** Whether this provider can run an agentic tool loop (edit/write files, MCP). A local
   * completion model (Ollama) can't, so the "fix with AI" buttons, tool settings and MCP notes
   * key off this. Absent → treated as `true` (every CLI engine is agentic). */
  agentic?: boolean;
}

// Ordered so the selectable engines come first and the not-yet-wired ones (shown disabled with a
// "coming soon" badge) sit together at the end — the picker reads as "what you can use" then
// "what's on the way", not an interleaved mix.
export const AI_PROVIDERS: AiProviderOption[] = [
  // ── Available now ──
  { id: "claude", label: "Claude Code", icon: Bot, available: true, defaultBinary: "claude" },
  // Gemini now runs through Google's Antigravity CLI (`agy`), the successor to the retired
  // `gemini` CLI, against a Google-account login. Headless via `agy -p`. See `gemini.rs`.
  { id: "gemini", label: "Gemini", icon: Gem, available: true, defaultBinary: "agy" },
  // opencode is provider-agnostic: it drives whatever model providers the user configured inside
  // it, addressed as `provider/model`. Headless via `opencode run`. See `opencode.rs`.
  { id: "opencode", label: "Open Code", icon: SquareTerminal, available: true, defaultBinary: "opencode" },
  // Local models via Ollama (HTTP, not a CLI). Non-agentic: no tool use / MCP, so those features
  // are hidden when it's active. `defaultBinary` is the endpoint. See `ollama.rs`.
  {
    id: "ollama",
    label: "Ollama",
    icon: HardDrive,
    available: true,
    defaultBinary: "http://localhost:11434",
    agentic: false,
  },
  // ── Coming soon (disabled) ──
  { id: "codex", label: "Codex", icon: Cpu, available: false },
  { id: "deepseek", label: "DeepSeek", icon: Waves, available: false },
];

export const DEFAULT_AI_PROVIDER = "claude";

/** Whether a provider can run agentic write/tool flows. Unknown or unset → `true` (the CLI
 * engines all are); only a provider explicitly marked `agentic: false` (Ollama) gates off. */
export function isAgenticProvider(providerId: string): boolean {
  return AI_PROVIDERS.find((p) => p.id === providerId)?.agentic !== false;
}

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
  // Claude Code has no "list models" command, so unlike the other providers this list can't be
  // populated live — it's maintained by hand. The "Custom" field is the escape hatch for anything
  // newer than the last release.
  claude: [
    { id: "claude-opus-5", label: "Opus 5" },
    { id: "claude-sonnet-5", label: "Sonnet 5" },
    { id: "claude-opus-4-8", label: "Opus 4.8" },
    { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
    { id: "claude-fable-5", label: "Fable 5" },
  ],
  // Fallback only — shown when `agy models` can't be queried (agy not installed / not signed in).
  // When it can, the Settings picker is populated live from the CLI, so these need not stay current.
  gemini: [
    { id: "gemini-3.6-flash-high", label: "Gemini 3.6 Flash (High)" },
    { id: "gemini-3.1-pro-high", label: "Gemini 3.1 Pro (High)" },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  ],
  // opencode addresses models as `provider/model`, and which are available depends entirely on the
  // providers the user configured inside opencode — so these are just format examples. The
  // "custom" field in Settings (and leaving it on "default") is the real path.
  opencode: [
    { id: "anthropic/claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
    { id: "openai/gpt-5", label: "GPT-5" },
    { id: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  ],
  // Fallback only — the real list is fetched live from the local server's `/api/tags`. These are
  // common coding models the user may have pulled; shown when Ollama isn't reachable.
  ollama: [
    { id: "qwen2.5-coder", label: "Qwen2.5 Coder" },
    { id: "llama3.1", label: "Llama 3.1" },
    { id: "deepseek-coder-v2", label: "DeepSeek Coder V2" },
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
