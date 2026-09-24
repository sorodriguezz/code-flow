import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, ChevronLeft, ChevronRight, Loader2, Lock, Settings2 } from "lucide-react";
import { AI_PROVIDERS, modelDisplayLabel } from "../../lib/aiProviders";
import { ProviderGlyph } from "./ProviderGlyph";
import { modelOptionsFor } from "../settings/modelPicker";
import { MODELS_MAX_AGE_MS, useAiModelsStore } from "../../state/aiModelsStore";
import { useAiProviderStore, useTaskProvider } from "../../state/aiProviderStore";
import { useProviderStatusStore } from "../../state/providerStatusStore";
import { useUiStore } from "../../state/uiStore";
import { useT } from "../../state/languageStore";
import { useAccountName, useAiAccountsStore } from "../../state/aiAccountsStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { SYSTEM_ACCOUNT, resolveAccount, validPreference } from "../../lib/aiAccounts";

const WIDTH = 236;
const GAP = 6;
const EDGE = 8;

/**
 * The chat's "who am I talking to" chip, made interactive. Two steps — pick the provider, then its
 * versions load and you pick one — so opening the menu only ever queries the provider you actually
 * chose (asking a CLI for its models costs a process spawn).
 *
 * The pick is written to the **chat task's** routing (`ai_provider_chat` + `{provider}_chat_model`),
 * the same settings the routing table owns, so it's a real configuration change rather than a
 * per-conversation override. No other task is touched.
 *
 * While a conversation is open (`chatActive`) only the *current* provider's versions can be picked.
 * Switching provider mid-chat can't work: each CLI keeps its own session store, so the turns so far
 * live somewhere the next engine can't read, and its resume token means nothing there. Rather than
 * silently dropping the thread, the other providers are locked behind "new chat".
 *
 * # Bound mode (`bound` + `onPick`)
 *
 * The paragraph above describes the AI panel, where the chip *is* the routing. The chat workspace
 * is the other case: there a conversation carries its own provider and model in its row, and
 * `chat_send` runs on those rather than on the workspace's routing. Reading the global setting
 * there produces a chip that names one engine while the turn goes to another — and worse, applies
 * the "locked" padlock to the one provider the conversation is actually running on, because the
 * lock is computed against the routing rather than against the thread.
 *
 * So a caller that owns the answer passes it in, and takes the write. Both props or neither:
 * `bound` without `onPick` would render a value the menu cannot change.
 *
 * # Accounts
 *
 * The third coordinate, after provider and model, for a CLI with more than one login (see
 * `lib/aiAccounts.ts`). It appears only where there is a choice — a provider with at least one
 * added account — as a row of pills above that provider's versions, and on the chip after the
 * model: "Opus · Trabajo". Unbound, a pill is the chat task's own account pin, and "Automatic"
 * leaves it to the workspace; bound, it is the conversation's account, which is always a concrete
 * one. Moving a thread to another account starts a fresh engine session — that account cannot see
 * the other's — and the chat workspace replays the transcript into it, so it is allowed mid-thread
 * where moving provider is not.
 */
export function ChatModelPicker({
  liveModel,
  chatActive,
  bound,
  onPick,
}: {
  liveModel: string | null;
  chatActive: boolean;
  /** The engine this chip is describing, when it is not the workspace's chat routing. `account` is
   *  the thread's account — `null` for the system one. */
  bound?: { provider: string; model: string; account?: string | null };
  /** Where a selection goes in bound mode. Without it the pick falls through to the routing.
   *  `account` is only passed when one was picked; absent keeps the thread's own. */
  onPick?: (provider: string, model: string, account?: string) => void | Promise<void>;
}) {
  const t = useT();
  const routedProvider = useTaskProvider("chat");
  const routedModel = useAiProviderStore((s) => s.taskModels.chat ?? s.model);
  const providerId = bound?.provider ?? routedProvider;
  const configuredModel = bound?.model ?? routedModel;
  const setTaskRouting = useAiProviderStore((s) => s.setTaskRouting);
  const modelsByProvider = useAiModelsStore((s) => s.byProvider);
  const ensureModels = useAiModelsStore((s) => s.ensure);
  const statuses = useProviderStatusStore((s) => s.byProvider);
  const checkAll = useProviderStatusStore((s) => s.checkAll);
  const openSettings = useUiStore((s) => s.openSettings);
  const accounts = useAiAccountsStore((s) => s.accounts);
  const taskPins = useAiAccountsStore((s) => s.taskPins);
  const workspaceDefaults = useAiAccountsStore((s) => s.workspaceDefaults);
  const providerDefaults = useAiAccountsStore((s) => s.providerDefaults);
  const ensureAccounts = useAiAccountsStore((s) => s.ensure);
  const setTaskPin = useAiAccountsStore((s) => s.setTaskPin);
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const nameOf = useAccountName();
  /** The account picked in the open submenu, before a version is — `null` until a pill is touched. */
  const [accountChoice, setAccountChoice] = useState<string | null>(null);

  useEffect(() => {
    void ensureAccounts();
  }, [ensureAccounts]);

  const [open, setOpen] = useState(false);
  /** `null` = the provider list; otherwise the provider whose versions are being shown. */
  const [browsing, setBrowsing] = useState<string | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const selectable = AI_PROVIDERS.filter((p) => p.available);
  // What the engine reported for the last turn beats the stored setting: with no model configured
  // the CLI picks its own, so only the reply knows which.
  const shownModel = liveModel ?? configuredModel;
  const active = AI_PROVIDERS.find((p) => p.id === providerId) ?? AI_PROVIDERS[0];
  const activeLabel = active.label ?? (active.labelKey ? t(active.labelKey) : active.id);

  const prefs = { accounts, taskPins, workspaceDefaults, providerDefaults };
  const hasAccounts = (id: string) => accounts.some((account) => account.provider === id);
  /** The account a thread (bound) or the next chat (unbound) of `id` runs as — `null` is system. */
  const effectiveAccount = (id: string): string | null =>
    bound && id === bound.provider ? (bound.account ?? null) : resolveAccount(prefs, id, "chat", workspaceId);
  /** Which pill is lit for `id`. Unbound, the pin itself — "" is Automatic. */
  const selectedPill = (id: string): string => {
    if (accountChoice !== null) return accountChoice;
    if (!bound) return validPreference(accounts, id, taskPins.chat);
    return effectiveAccount(id) ?? SYSTEM_ACCOUNT;
  };

  const pickAccount = (id: string, value: string) => {
    setAccountChoice(value);
    if (!bound) {
      void setTaskPin("chat", value);
      return;
    }
    // Bound to the thread it is already on: applied now, keeping the model. On another provider it
    // waits for the version, which is what moves the thread there.
    if (id === providerId && onPick) void onPick(providerId, configuredModel, value);
  };

  const labelOf = (id: string) => {
    const p = AI_PROVIDERS.find((x) => x.id === id);
    return p ? (p.label ?? (p.labelKey ? t(p.labelKey) : id)) : id;
  };

  const openMenu = () => {
    setBrowsing(null);
    setAccountChoice(null);
    setOpen(true);
    if (Object.keys(statuses).length === 0) void checkAll();
  };

  const browse = (id: string) => {
    setBrowsing(id);
    setAccountChoice(null);
    // Only now do we ask this one provider for its list — and with an age, because opening this
    // submenu *is* the question "what can I pick". Cached for the whole session it answered with
    // whatever was installed when the app booted: a model pulled ten minutes ago was missing from
    // the list, and one deleted an hour ago was still here and still selectable.
    void ensureModels([id], MODELS_MAX_AGE_MS);
  };

  // Re-measured on every stage change, since the two steps have different heights.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (!trigger || !menu) return;
    const rect = trigger.getBoundingClientRect();
    const { height } = menu.getBoundingClientRect();
    // Opens upward by default — the chip lives at the bottom of the panel.
    const above = rect.top - height - GAP;
    const top = above >= EDGE ? above : Math.min(rect.bottom + GAP, window.innerHeight - height - EDGE);
    const left = Math.max(EDGE, Math.min(rect.left, window.innerWidth - WIDTH - EDGE));
    setPos({ top, left });
  }, [open, browsing, modelsByProvider]);

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    // A fixed menu doesn't follow its anchor, so an *outside* scroll would strand it — but
    // scrolling the menu's own list must not dismiss it.
    const onScroll = (e: Event) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onResize = () => setOpen(false);
    window.addEventListener("mousedown", onClickOutside);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("mousedown", onClickOutside);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  const pick = async (nextProvider: string, model: string) => {
    setOpen(false);
    // In bound mode the selection belongs to the conversation, and writing it to the workspace
    // routing as well would change what every *future* chat starts on because someone re-pointed
    // one thread. The two are deliberately not kept in step.
    if (onPick) {
      await onPick(nextProvider, model, accountChoice ?? undefined);
      return;
    }
    await setTaskRouting("chat", nextProvider, model);
  };

  /** Live list when the CLI gave us one, else the curated fallback — via `modelOptionsFor`, which
   * for hand-maintained providers (Claude Code) always keeps the full catalog. `undefined` = still
   * loading. */
  const versionsFor = (id: string): string[] | undefined => {
    const live = modelsByProvider[id];
    if (live === undefined) return undefined;
    return modelOptionsFor(id, live).map((o) => o.id);
  };

  const versions = browsing ? versionsFor(browsing) : undefined;

  return (
    <>
      <button
        ref={triggerRef}
        onClick={() => (open ? setOpen(false) : openMenu())}
        title={t("chat.changeModelTitle")}
        className="flex max-w-full items-center gap-1 rounded-md border border-transparent px-1.5 py-0.5 text-[10.5px] text-[var(--cf-text-muted)] hover:border-[var(--cf-border)] hover:bg-black/[0.03] dark:hover:bg-white/[0.05]"
      >
        <ProviderGlyph providerId={active.id} size={11} />
        {activeLabel}
        <span className="text-[var(--cf-text-muted)]/50">·</span>
        <span className="truncate font-medium text-[var(--cf-text)]/70">
          {modelDisplayLabel(providerId, shownModel, t)}
          {hasAccounts(providerId) && ` · ${nameOf(providerId, effectiveAccount(providerId))}`}
        </span>
        <ChevronDown size={10} className={`shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open &&
        createPortal(
          <div
            ref={menuRef}
            style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, width: WIDTH, visibility: pos ? "visible" : "hidden" }}
            className="fixed z-[9999] flex max-h-[60vh] flex-col rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] shadow-[var(--cf-shadow)]"
          >
            {browsing === null ? (
              <>
                <p className="shrink-0 px-2.5 py-1.5 text-[10px] font-medium uppercase tracking-wide text-[var(--cf-text-muted)]">
                  {t("chat.modelForChat")}
                </p>
                <div className="min-h-0 flex-1 overflow-auto p-1 pt-0">
                  {selectable.map((p) => {
                    const unavailable = statuses[p.id]?.available === false;
                    const locked = chatActive && p.id !== providerId;
                    return (
                      <button
                        key={p.id}
                        onClick={() => browse(p.id)}
                        disabled={unavailable || locked}
                        title={locked ? t("chat.providerLocked") : undefined}
                        className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[12px] disabled:opacity-40 ${
                          p.id === providerId
                            ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
                            : "text-[var(--cf-text)] hover:bg-black/[0.04] disabled:hover:bg-transparent dark:hover:bg-white/[0.06]"
                        }`}
                      >
                        <ProviderGlyph providerId={p.id} size={12} />
                        <span className="min-w-0 flex-1 truncate">{p.label ?? labelOf(p.id)}</span>
                        {unavailable ? (
                          <span className="shrink-0 text-[10px] text-[var(--cf-warning)]">
                            {t("settings.providerMissing")}
                          </span>
                        ) : locked ? (
                          <Lock size={11} className="shrink-0 opacity-60" />
                        ) : (
                          <ChevronRight size={12} className="shrink-0 opacity-60" />
                        )}
                      </button>
                    );
                  })}
                </div>
                {/* No standing explanation under the list. The padlock already says the row cannot
                    be chosen, and the reason it cannot — each CLI keeps its own sessions, so an
                    open chat cannot move between them — is on the row's own tooltip, which is where
                    someone who wants the reason will look for it. A paragraph pinned to the bottom
                    of a menu is read once and then occupies the menu forever. */}
              </>

            ) : (
              <>
                <button
                  onClick={() => setBrowsing(null)}
                  className="flex shrink-0 items-center gap-1 border-b border-[var(--cf-border)] px-2 py-1.5 text-[11px] font-medium text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
                >
                  <ChevronLeft size={12} />
                  {labelOf(browsing)}
                </button>
                {hasAccounts(browsing) && (
                  <div
                    role="radiogroup"
                    aria-label={t("accounts.pickerLabel")}
                    className="flex shrink-0 flex-wrap gap-1 border-b border-[var(--cf-border)] px-2 py-1.5"
                  >
                    {[
                      ...(bound ? [] : [{ value: "", label: t("accounts.automatic") }]),
                      { value: SYSTEM_ACCOUNT, label: nameOf(browsing, null) },
                      ...accounts
                        .filter((account) => account.provider === browsing)
                        .map((account) => ({ value: account.id, label: account.label })),
                    ].map((option) => {
                      const on = selectedPill(browsing) === option.value;
                      return (
                        <button
                          key={option.value || "auto"}
                          type="button"
                          role="radio"
                          aria-checked={on}
                          onClick={() => pickAccount(browsing, option.value)}
                          className={`max-w-full truncate rounded-full border px-2 py-0.5 text-[10.5px] ${
                            on
                              ? "border-[var(--cf-accent)] bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
                              : "border-[var(--cf-border)] text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
                          }`}
                        >
                          {option.label}
                        </button>
                      );
                    })}
                  </div>
                )}
                <div className="min-h-0 flex-1 overflow-auto p-1">
                  {versions === undefined ? (
                    <p className="flex items-center gap-1.5 px-2 py-2 text-[11px] text-[var(--cf-text-muted)]">
                      <Loader2 size={11} className="animate-spin" />
                      {t("chat.loadingModels")}
                    </p>
                  ) : (
                    <>
                      {/* No explicit model — let the engine pick its own default. */}
                      <VersionItem
                        label={t("settings.modelDefault")}
                        selected={browsing === providerId && !configuredModel}
                        onClick={() => void pick(browsing, "")}
                      />
                      {versions.map((id) => (
                        <VersionItem
                          key={id}
                          label={modelDisplayLabel(browsing, id, t)}
                          selected={browsing === providerId && configuredModel === id}
                          onClick={() => void pick(browsing, id)}
                        />
                      ))}
                      {versions.length === 0 && (
                        <p className="px-2 py-2 text-[11px] leading-snug text-[var(--cf-text-muted)]">
                          {t("chat.noModels")}
                        </p>
                      )}
                    </>
                  )}
                </div>
              </>
            )}

            <button
              onClick={() => {
                setOpen(false);
                openSettings("claude");
              }}
              className="flex shrink-0 items-center gap-1.5 border-t border-[var(--cf-border)] px-2.5 py-1.5 text-[11px] text-[var(--cf-text-muted)] hover:text-[var(--cf-accent)]"
            >
              <Settings2 size={11} />
              {t("chat.configureModels")}
            </button>
          </div>,
          document.body,
        )}
    </>
  );
}

function VersionItem({ label, selected, onClick }: { label: string; selected: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[12px] ${
        selected
          ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
          : "text-[var(--cf-text)] hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
      }`}
    >
      <Check size={11} className={`shrink-0 ${selected ? "" : "opacity-0"}`} />
      <span className="truncate">{label}</span>
    </button>
  );
}
