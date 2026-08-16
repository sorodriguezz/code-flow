import { Bot, Cpu, Gem, HardDrive, Sparkles, SquareTerminal, Zap, type LucideIcon } from "lucide-react";
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
   * engine's `default_binary()` on the Rust side. For an HTTP provider this is the endpoint. */
  defaultBinary?: string;
  /** Whether this provider can run an agentic tool loop (edit/write files, read a skill). A bare
   * completion endpoint can't, so the "fix with AI" buttons and tool settings key off this.
   * Absent → treated as `true` (every CLI engine is agentic, local models included — Cline drives
   * them rather than just completing text). */
  agentic?: boolean;
  /** Authenticates with an API key (stored in the OS keyring) rather than a CLI login, so Settings
   * shows a key field for it. */
  needsApiKey?: boolean;
  /** The CLI accepts a tool allow-list (Claude Code's `--allowedTools`), so configuring one
   * actually changes what it may do. The other agentic CLIs have no such flag — their access is
   * governed by a permission/sandbox mode the app sets per operation — so offering the field there
   * would be a control that does nothing. */
  usesToolAllowlist?: boolean;
  /** True when `defaultBinary` is an HTTP endpoint rather than an executable — Settings then labels
   * the field accordingly and drops the "browse for a file" button. */
  isEndpoint?: boolean;
  /** Where to go to get this provider working. Shown in its Settings row, and surfaced up front
   * when the provider isn't detected — so "Not found" always comes with a way out. */
  setup?: {
    /** Official install / setup page. */
    url: string;
    /** Canonical one-line install command, when the provider has one. */
    command?: string;
    /** Command to run once installed, e.g. signing in. */
    postCommand?: string;
  };
}

// Every entry here is selectable. `available: false` is still honoured by the UI (it renders a
// "coming soon" badge) for when a future engine is stubbed in, but nothing is stubbed today.
export const AI_PROVIDERS: AiProviderOption[] = [
  {
    id: "claude",
    label: "Claude Code",
    icon: Bot,
    available: true,
    defaultBinary: "claude",
    usesToolAllowlist: true,
    setup: {
      url: "https://docs.claude.com/en/docs/claude-code/setup",
      command: "npm install -g @anthropic-ai/claude-code",
    },
  },
  // Gemini now runs through Google's Antigravity CLI (`agy`), the successor to the retired
  // `gemini` CLI, against a Google-account login. Headless via `agy -p`. See `gemini.rs`.
  {
    id: "gemini",
    label: "Gemini",
    icon: Gem,
    available: true,
    defaultBinary: "agy",
    setup: { url: "https://antigravity.google" },
  },
  // OpenAI's CLI, logged in with a **ChatGPT subscription** (`codex login`) rather than metered
  // API credits — that's what separates it from the `openai` entry below. Headless via
  // `codex exec`. See `codex.rs`.
  {
    id: "codex",
    label: "Codex",
    icon: Cpu,
    available: true,
    defaultBinary: "codex",
    setup: {
      url: "https://developers.openai.com/codex/",
      command: "winget install OpenAI.Codex",
      postCommand: "codex login",
    },
  },
  // xAI's Grok Build CLI, driven headlessly (`grok -p` / `--prompt-file`, `--output-format json`)
  // against a `grok login` session. It is the only engine here that gives a headless caller a real
  // conversation id back, so chat resumes the exact conversation rather than "the last one". See
  // `grok.rs` — every flag there was verified against the binary.
  {
    id: "grok",
    label: "Grok",
    icon: Zap,
    available: true,
    defaultBinary: "grok",
    setup: {
      url: "https://x.ai/cli",
      command: "curl -fsSL https://x.ai/cli/install.sh | bash",
      postCommand: "grok login",
    },
  },
  // opencode is provider-agnostic: it drives whatever model providers the user configured inside
  // it, addressed as `provider/model`. Its own first-party services are addressed explicitly —
  // `opencode/…` for Zen (pay-as-you-go) and `opencode-go/…` for Go (subscription) — so both can
  // be used side by side by pointing different tasks at different prefixes. Headless via
  // `opencode run`. See `opencode.rs`.
  {
    id: "opencode",
    label: "Open Code",
    icon: SquareTerminal,
    available: true,
    defaultBinary: "opencode",
    setup: { url: "https://opencode.ai/docs/" },
  },
  // Cline is the local-model slot, and it replaced talking to Ollama directly. The reason is
  // capability: Ollama's HTTP API only completes text, so a local model could draft a commit
  // message but never open a file or apply a fix. Cline is an agent that *drives* a model, so
  // `cline auth ollama` gets the same local model the whole feature set — and its other providers
  // work the same way. Models are addressed as `provider/model`. See `cline.rs`.
  {
    id: "cline",
    label: "Cline",
    icon: HardDrive,
    available: true,
    defaultBinary: "cline",
    setup: {
      url: "https://cline.bot",
      command: "npm install -g cline",
      postCommand: "cline auth ollama",
    },
  },
  // Any endpoint speaking OpenAI's `/v1/chat/completions` — OpenAI itself by default, but the URL
  // is editable, so Azure OpenAI / OpenRouter / Groq / DeepSeek / vLLM all work here. Authenticated
  // with an API key from the OS keyring; non-agentic (no tool loop). See `openai.rs`.
  {
    id: "openai",
    label: "OpenAI",
    icon: Sparkles,
    available: true,
    defaultBinary: "https://api.openai.com/v1",
    agentic: false,
    needsApiKey: true,
    isEndpoint: true,
    setup: { url: "https://platform.openai.com/api-keys" },
  },
];

export const DEFAULT_AI_PROVIDER = "claude";

/** Whether a provider can run agentic write/tool flows. Unknown or unset → `true` (the CLI
 * engines all are); only a provider explicitly marked `agentic: false` (a bare completion
 * endpoint) gates off. */
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
  // Fallback only — the real list is read from the catalog Codex caches at
  // `~/.codex/models_cache.json`, which the CLI keeps current on its own. These are only shown
  // before Codex has ever run (no cache file yet).
  codex: [
    { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
    { id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
    { id: "gpt-5.5", label: "GPT-5.5" },
  ],
  // Fallback only — the real list comes from `grok models`, which reports what the signed-in
  // account can actually reach. Which ids those are depends on the plan, so this is deliberately
  // just the one every account has.
  grok: [{ id: "grok-4.5", label: "Grok 4.5" }],
  // opencode addresses models as `provider/model`, and which are available depends entirely on the
  // providers configured inside it — so these are just format examples, including one of each of
  // its own services (Zen pay-as-you-go vs Go subscription). The live list from `opencode models`
  // is what's normally shown; "Custom" covers the rest.
  opencode: [
    { id: "anthropic/claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
    { id: "openai/gpt-5", label: "GPT-5" },
    { id: "opencode-go/kimi-k3", label: "Kimi K3 (opencode Go)" },
  ],
  // Fallback only — the real list comes live from `GET /v1/models` once a key is set, and depends
  // entirely on which endpoint the provider points at.
  openai: [
    { id: "gpt-5", label: "GPT-5" },
    { id: "gpt-5-mini", label: "GPT-5 mini" },
    { id: "o3", label: "o3" },
  ],
  // **Deliberately absent.** Cline's list is real — the providers `cline auth` configured, each
  // asked what it currently serves — so there is nothing here to fall back to. A curated list would
  // only ever appear when that came back empty, which is exactly the moment it does most harm: it
  // named three models the machine did not have while hiding the one it did. When there is nothing
  // to offer the picker shows "CLI default" and "Custom", and the field's own hint teaches the
  // `provider/model` shape.
};

/** Display name for a provider id — its own label, its translated one, or the raw id for a
 * provider this build doesn't know (which is what a stored id from a newer version looks like). */
export function providerDisplayLabel(providerId: string, t: (key: TranslationKey) => string): string {
  const provider = AI_PROVIDERS.find((p) => p.id === providerId);
  if (!provider) return providerId;
  return provider.label ?? (provider.labelKey ? t(provider.labelKey) : providerId);
}

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
