import { create } from "zustand";
import { AI_PROVIDERS, PROVIDER_MODELS, type AiProviderOption } from "../lib/aiProviders";
import { rpc } from "./transport";
import { t } from "./i18n";
import type { ActivityLogEntry } from "../types/domain";

/**
 * Which engine the phone's chat answers on — the chip over its composer and the sheet it opens
 * (user, 2026-10-14: "en chat no se puede elegir modelo").
 *
 * It works the way the desk's repository chat does (`engineFor` in `state/chatStore.ts`): a
 * conversation runs on the engine picked for it, else on the one its last answer ran on — a
 * conversation stays on its engine whatever the routing does — else on the workspace's chat routing,
 * which is what a brand-new conversation shows until something is picked. The pick is per
 * conversation and lives here, outside the screen, because the chat screen is remounted on every
 * tab change.
 *
 * # The catalogue is the desk's
 *
 * Imported from `lib/aiProviders` rather than copied: this client otherwise shares only the domain
 * types with the desktop, but a second list of models would fall behind the first on the next
 * release, and this one is plain data (plus one icon per provider). What each CLI reports it can
 * run is asked of the backend (`list_ai_models`) and merged in as the desk merges it.
 */

export interface ChatEngine {
  provider: string;
  /** Empty for the CLI's own default — no `--model` at all. */
  model: string;
}

export interface ModelOption {
  id: string;
  label: string;
  legacy: boolean;
}

/** The engines a phone may name — the backend's `PHONE_ENGINES` — in the desk's own order. */
const PHONE_ENGINES = new Set(["claude", "gemini", "codex", "grok", "opencode", "cline", "codeflow"]);

export const PHONE_PROVIDERS: AiProviderOption[] = AI_PROVIDERS.filter((provider) => PHONE_ENGINES.has(provider.id));

/** Providers whose CLI cannot list its models: the catalogue is the whole truth and is always shown
 *  (`CURATED_MODEL_PROVIDERS` in the desk's model picker). */
const CURATED = new Set(["claude"]);

/** The models to offer for a provider: the CLI's own list when it gave one, else the catalogue —
 *  and for Claude Code the catalogue always, with anything else it reported after it. */
export function modelOptions(provider: string, live: string[] | undefined): ModelOption[] {
  const curated = (PROVIDER_MODELS[provider] ?? []).map((m) => ({ id: m.id, label: m.label ?? m.id, legacy: m.legacy ?? false }));
  const plain = (id: string) => ({ id, label: id, legacy: false });
  if (CURATED.has(provider)) {
    const known = new Set(curated.map((m) => m.id));
    return [...curated, ...(live ?? []).filter((id) => !known.has(id)).map(plain)];
  }
  return live && live.length > 0 ? live.map(plain) : curated;
}

export function providerLabel(provider: string): string {
  return AI_PROVIDERS.find((p) => p.id === provider)?.label ?? provider;
}

/** A model's short name: the catalogue's, a dated id read as its family's (`claude-opus-4-8-2026…`),
 *  or the id itself — its last segment, for a `provider/model` one. Empty is the CLI's default. */
export function modelLabel(provider: string, model: string): string {
  const id = model.trim();
  if (!id) return t("engine.default");
  const base = id.split("[")[0];
  const known = (PROVIDER_MODELS[provider] ?? []).find((m) => m.id === base || base.startsWith(`${m.id}-`));
  return known?.label ?? id.split("/").pop() ?? id;
}

/** The engine a conversation's last answer ran on, or `null` for one with no answer naming it. */
export function lastEngine(entries: ActivityLogEntry[]): ChatEngine | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const provider = entries[i].provider;
    if (provider) return { provider, model: entries[i].model ?? "" };
  }
  return null;
}

interface ChatEngineState {
  /** Picked in the sheet, by conversation id. */
  picked: Record<string, ChatEngine>;
  /** The workspace's chat routing, by project id; absent until read, `null` if it could not be. */
  routing: Record<string, ChatEngine | null>;
  /** What each CLI said it can run; absent until asked, `[]` when it could not say. */
  live: Record<string, string[]>;
  loading: Record<string, boolean>;
  /** A conversation to start on an engine — picked in the sheet for a provider the open
   *  conversation cannot move to. The chat screen takes it and clears it. */
  fresh: { projectId: string; engine: ChatEngine } | null;
  pick: (conversationId: string, engine: ChatEngine) => void;
  startFresh: (projectId: string, engine: ChatEngine) => void;
  takeFresh: () => void;
  loadRouting: (projectId: string) => Promise<void>;
  loadModels: (provider: string) => Promise<void>;
}

export const useChatEngine = create<ChatEngineState>((set, get) => ({
  picked: {},
  routing: {},
  live: {},
  loading: {},
  fresh: null,

  pick: (conversationId, engine) => set((s) => ({ picked: { ...s.picked, [conversationId]: engine } })),
  startFresh: (projectId, engine) => set({ fresh: { projectId, engine } }),
  takeFresh: () => set({ fresh: null }),

  loadRouting: async (projectId) => {
    try {
      const routed = await rpc<ChatEngine>("chat_routing", { projectId });
      set((s) => ({ routing: { ...s.routing, [projectId]: { provider: routed.provider, model: routed.model ?? "" } } }));
    } catch {
      set((s) => ({ routing: { ...s.routing, [projectId]: null } }));
    }
  },

  loadModels: async (provider) => {
    // Once per page: a CLI's list changes when something is installed or signed into, not while a
    // sheet is open.
    if (get().live[provider] || get().loading[provider]) return;
    set((s) => ({ loading: { ...s.loading, [provider]: true } }));
    const live = await rpc<string[]>("list_ai_models", { provider }).catch(() => [] as string[]);
    set((s) => ({ live: { ...s.live, [provider]: live }, loading: { ...s.loading, [provider]: false } }));
  },
}));
