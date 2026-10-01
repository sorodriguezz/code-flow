import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, ChevronLeft, ChevronRight, Forward, Loader2, Lock, Settings2 } from "lucide-react";
import { AI_PROVIDERS, isLegacyModel, modelDisplayLabel } from "../../lib/aiProviders";
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
import { AI_TASKS } from "../../lib/aiTasks";

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
 * `task` names another row of that table for a surface that answers under its own: the database
 * console's assistant is `db_query`, the ✨ by Commit is `commit`. Everything above holds with that
 * key in place of `chat` — the chip reads that row, writes that row and its account pin, and nothing
 * else — and the menu is headed with the row's own "Model for …" (`AiTaskDef.modelForKey`).
 *
 * # Triggers (`variant`)
 *
 * The menu is always the same; what opens it depends on the room. `chip` spells the route out
 * ("Claude Code · Opus · Trabajo") and belongs in a composer. `tag` is `ModelTag`'s pill — the model,
 * and the account where there is a choice ("Haiku 4.5 · Sistema") — for a toolbar or a footer that
 * already had that pill. `icon` is the provider's mark
 * alone, or the ✨ the caller hands in (`children`), at the head of a one-line AI prompt. The two
 * small ones put the whole route in their tooltip, above `title`.
 *
 * `split` *is* the button whose run it routes: one outlined control, the run's own glyph (`action`)
 * on the left and a chevron on the right — the 🛡 that analyzes the changes, the ✨ that writes the
 * commit message. The glyph starts the run, the chevron opens this menu, and both halves name the
 * route in their tooltip (the glyph under the run's name, the chevron above `title`), so the engine
 * is one hover away from either. The menu hangs from the whole control, dropping below it like any
 * header dropdown.
 *
 * While a conversation is open (`chatActive`) only the *current* provider's versions can be picked.
 * Switching provider mid-chat can't work: each CLI keeps its own session store, so the turns so far
 * live somewhere the next engine can't read, and its resume token means nothing there. Rather than
 * silently dropping the thread, the other providers are locked behind "new chat" — or, where the
 * caller can open one (`onLockedPick`, the chat workspace), the lock is that door: the row stays
 * pickable, and its version goes to "continuar en un hilo nuevo" with that engine instead of to
 * this thread.
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
 * model: "Opus · Trabajo". Unbound, a pill is the task's own account pin, and "Automatic"
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
  task = "chat",
  title,
  variant = "chip",
  className = "",
  children,
  action,
  tour,
  onLockedPick,
}: {
  liveModel: string | null;
  chatActive: boolean;
  /** The engine this chip is describing, when it is not the workspace's chat routing. `account` is
   *  the thread's account — `null` for the system one. */
  bound?: { provider: string; model: string; account?: string | null };
  /** Where a selection goes in bound mode. Without it the pick falls through to the routing.
   *  `account` is only passed when one was picked; absent keeps the thread's own. */
  onPick?: (provider: string, model: string, account?: string) => void | Promise<void>;
  /** The routing row this chip reads and, unbound, writes — an `AI_TASKS` key, the same string as
   *  Rust's `AiTask::key()`. */
  task?: string;
  /** The chip's tooltip; on `tag`, `icon` and `split`'s chevron, the line under the route. */
  title?: string;
  variant?: "chip" | "tag" | "icon" | "split";
  /** Added to the trigger's classes (on `split`, the whole control's), for a place that has to put
   *  it somewhere (the ✨ pinned in the commit message's corner). Only for what the variant leaves
   *  unset — two utilities for one property do not stack. */
  className?: string;
  /** `icon` only: the mark to show in place of the provider's — the editor's inline edit keeps the
   *  ✨ it always had, which is the thing its user reaches for. */
  children?: ReactNode;
  /** `split` only: the run the control starts — its glyph, its name (the accessible name and the
   *  tooltip's first line, over the route) and what a click on it does. */
  action?: { icon: ReactNode; label: string; onClick: () => void; disabled?: boolean };
  /** `data-tour` for the guided tour, on the whole control. */
  tour?: string;
  /** With `chatActive`: where a version of a *locked* provider goes — the chat workspace's
   *  "continuar en un hilo nuevo" on that engine. Without it, locked rows cannot be picked. */
  onLockedPick?: (provider: string, model: string, account?: string) => void;
}) {
  const t = useT();
  const routedProvider = useTaskProvider(task);
  const routedModel = useAiProviderStore((s) => s.taskModels[task] ?? s.model);
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
  /** `split`'s whole control, which the menu hangs from rather than from the chevron alone. */
  const splitRef = useRef<HTMLDivElement>(null);
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
    bound && id === bound.provider ? (bound.account ?? null) : resolveAccount(prefs, id, task, workspaceId);
  const modelLabel = modelDisplayLabel(providerId, shownModel, t);
  const accountLabel = hasAccounts(providerId) ? nameOf(providerId, effectiveAccount(providerId)) : null;
  /** The whole route — what the chip spells out and the two small triggers keep in their tooltip. */
  const routeLabel = [activeLabel, modelLabel, accountLabel].filter(Boolean).join(" · ");
  const taskDef = AI_TASKS.find((entry) => entry.key === task);
  /** Which pill is lit for `id`. Unbound, the pin itself — "" is Automatic. */
  const selectedPill = (id: string): string => {
    if (accountChoice !== null) return accountChoice;
    if (!bound) return validPreference(accounts, id, taskPins[task]);
    return effectiveAccount(id) ?? SYSTEM_ACCOUNT;
  };

  const pickAccount = (id: string, value: string) => {
    setAccountChoice(value);
    if (!bound) {
      void setTaskPin(task, value);
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
    const anchor = variant === "split" ? splitRef.current : triggerRef.current;
    const menu = menuRef.current;
    if (!anchor || !menu) return;
    const rect = anchor.getBoundingClientRect();
    const { height } = menu.getBoundingClientRect();
    const above = rect.top - height - GAP;
    const below = rect.bottom + GAP;
    const top =
      variant === "split"
        ? // A header dropdown: below it, unless only the space above can hold it.
          below + height <= window.innerHeight - EDGE || above < EDGE
          ? Math.min(below, window.innerHeight - height - EDGE)
          : above
        : // Opens upward by default — the chip lives at the bottom of the panel.
          above >= EDGE
          ? above
          : Math.min(below, window.innerHeight - height - EDGE);
    const left = Math.max(EDGE, Math.min(rect.left, window.innerWidth - WIDTH - EDGE));
    setPos({ top, left });
  }, [open, browsing, modelsByProvider, variant]);

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
    // A provider this thread cannot move to: the version picked is the engine of a new thread.
    if (chatActive && nextProvider !== providerId && onLockedPick) {
      onLockedPick(nextProvider, model, accountChoice ?? undefined);
      return;
    }
    // In bound mode the selection belongs to the conversation, and writing it to the workspace
    // routing as well would change what every *future* chat starts on because someone re-pointed
    // one thread. The two are deliberately not kept in step.
    if (onPick) {
      await onPick(nextProvider, model, accountChoice ?? undefined);
      return;
    }
    await setTaskRouting(task, nextProvider, model);
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
  const heading = t(taskDef?.modelForKey ?? taskDef?.labelKey ?? "chat.modelForChat");

  /** What every trigger shares: the anchor the menu is placed against, and saying it opens one. */
  const trigger = {
    ref: triggerRef,
    type: "button" as const,
    onClick: () => (open ? setOpen(false) : openMenu()),
    "aria-haspopup": "menu" as const,
    "aria-expanded": open,
  };
  const chevron = (size: number) => (
    <ChevronDown size={size} className={`shrink-0 opacity-70 transition-transform ${open ? "rotate-180" : ""}`} />
  );

  return (
    <>
      {variant === "tag" ? (
        <button
          {...trigger}
          data-tour={tour}
          title={[routeLabel, title].filter(Boolean).join("\n")}
          className={`inline-flex min-w-0 max-w-[16rem] shrink items-center gap-1 rounded-full border bg-[var(--cf-surface)] px-1.5 py-px text-[10.5px] transition-colors ${
            open
              ? "border-[var(--cf-accent)] text-[var(--cf-text)]"
              : "border-[var(--cf-border)] text-[var(--cf-text-muted)] hover:border-[color-mix(in_oklab,var(--cf-accent)_45%,var(--cf-border))] hover:text-[var(--cf-text)]"
          } ${className}`}
        >
          <ProviderGlyph providerId={active.id} size={9} />
          {/* `ModelTag`'s fact — the model's own name, a gateway route's last segment, or the engine
              when none is pinned, where "Default" alone would not say who answers — then whose login
              runs it, as the chip says it, wherever there is more than one to choose from. A long
              model id gives way first: the account is the half that tells two otherwise equal
              routes apart. */}
          <span className="min-w-0 truncate font-mono">
            {shownModel.trim() ? modelLabel.split("/").pop() || modelLabel : activeLabel}
          </span>
          {accountLabel && <span className="max-w-[7rem] shrink-0 truncate font-mono">· {accountLabel}</span>}
          {chevron(9)}
        </button>
      ) : variant === "split" ? (
        // One control, two targets. Each half lights on its own hover inside the shared hairline,
        // and the rule between them is what says there are two; the chevron's half stays lit while
        // its menu is open.
        <div
          ref={splitRef}
          data-tour={tour}
          className={`group/split inline-flex h-[22px] shrink-0 items-stretch rounded-md border transition-colors duration-100 ${
            open ? "border-[var(--cf-border-strong)]" : "border-[var(--cf-border)] hover:border-[var(--cf-border-strong)]"
          } ${className}`}
        >
          <button
            type="button"
            onClick={action?.onClick}
            disabled={action?.disabled}
            title={[action?.label, routeLabel].filter(Boolean).join("\n")}
            aria-label={action?.label}
            className="flex w-[22px] items-center justify-center rounded-l-[5px] text-[var(--cf-text-muted)] transition-colors duration-100 enabled:hover:bg-[var(--cf-hover)] enabled:hover:text-[var(--cf-accent)] disabled:opacity-40"
          >
            {action?.icon}
          </button>
          <button
            {...trigger}
            title={[routeLabel, title].filter(Boolean).join("\n")}
            aria-label={`${heading}: ${routeLabel}`}
            className={`flex w-4 items-center justify-center rounded-r-[5px] border-l transition-colors duration-100 ${
              open
                ? "border-[var(--cf-border-strong)] bg-[var(--cf-hover)] text-[var(--cf-text)]"
                : "border-[var(--cf-border)] text-[var(--cf-text-muted)] group-hover/split:border-[var(--cf-border-strong)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]"
            }`}
          >
            {chevron(10)}
          </button>
        </div>
      ) : variant === "icon" ? (
        <button
          {...trigger}
          data-tour={tour}
          title={[routeLabel, title].filter(Boolean).join("\n")}
          aria-label={routeLabel}
          className={`flex min-h-[22px] shrink-0 items-center justify-center gap-0.5 rounded-md px-1 transition-colors ${
            open
              ? "bg-[var(--cf-hover)] text-[var(--cf-text)]"
              : "text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]"
          } ${className}`}
        >
          {children ?? <ProviderGlyph providerId={active.id} size={12} />}
          {chevron(10)}
        </button>
      ) : (
        <button
          {...trigger}
          data-tour={tour}
          title={title ?? t("chat.changeModelTitle")}
          className={`flex h-[26px] max-w-full items-center gap-1.5 rounded-md px-2 text-[12px] transition-colors hover:bg-[var(--cf-hover)] ${
            open ? "bg-[var(--cf-hover)] text-[var(--cf-text)]" : "text-[var(--cf-text-muted)]"
          } ${className}`}
        >
          <ProviderGlyph providerId={active.id} size={13} />
          {activeLabel}
          <span className="text-[var(--cf-text-muted)]/50">·</span>
          <span className="truncate font-medium text-[var(--cf-text)]/70">
            {modelLabel}
            {accountLabel && ` · ${accountLabel}`}
          </span>
          {chevron(12)}
        </button>
      )}

      {open &&
        createPortal(
          <div
            ref={menuRef}
            // `menu` is also what a dialog underneath asks before taking Escape for itself
            // (`ApiModal`): pressing it here closes this list, not the form the chip sits in.
            role="menu"
            aria-label={heading}
            style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, width: WIDTH, visibility: pos ? "visible" : "hidden" }}
            className="fixed z-[9999] flex max-h-[60vh] flex-col rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] shadow-[var(--cf-shadow)]"
          >
            {browsing === null ? (
              <>
                <p className="shrink-0 px-2.5 py-1.5 text-[10.5px] font-medium uppercase tracking-wide text-[var(--cf-text-muted)]">
                  {heading}
                </p>
                <div className="min-h-0 flex-1 overflow-auto p-1 pt-0">
                  {selectable.map((p) => {
                    const unavailable = statuses[p.id]?.available === false;
                    const locked = chatActive && p.id !== providerId;
                    // Locked with somewhere to go: pickable, and said so on the row.
                    const continues = locked && !!onLockedPick;
                    return (
                      <button
                        key={p.id}
                        onClick={() => browse(p.id)}
                        disabled={unavailable || (locked && !continues)}
                        title={
                          continues
                            ? t("chat.continueWith", { engine: p.label ?? labelOf(p.id) })
                            : locked
                              ? t("chat.providerLocked")
                              : undefined
                        }
                        className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[12px] disabled:opacity-40 ${
                          p.id === providerId
                            ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
                            : "text-[var(--cf-text)] hover:bg-[var(--cf-hover)] disabled:hover:bg-transparent"
                        }`}
                      >
                        <ProviderGlyph providerId={p.id} size={12} />
                        <span className="min-w-0 flex-1 truncate">{p.label ?? labelOf(p.id)}</span>
                        {unavailable ? (
                          <span className="shrink-0 text-[10.5px] text-[var(--cf-warning)]">
                            {t("settings.providerMissing")}
                          </span>
                        ) : continues ? (
                          <Forward size={12} className="shrink-0 opacity-60" />
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
                      // "Automatic" says who it comes to without a pin of its own — the workspace's
                      // default, the provider's, or the system login — or it names no account at all.
                      ...(bound
                        ? []
                        : [
                            {
                              value: "",
                              label: t("accounts.automaticNamed", {
                                account: nameOf(browsing, resolveAccount(prefs, browsing, null, workspaceId)),
                              }),
                            },
                          ]),
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
                      {versions.map((id, index) => (
                        <div key={id}>
                          {/* One divider, above the first earlier-generation model. */}
                          {isLegacyModel(browsing, id) && !isLegacyModel(browsing, versions[index - 1] ?? "") && (
                            <p className="px-2 pb-0.5 pt-2 text-[10px] font-medium uppercase tracking-wide text-[var(--cf-text-muted)]">
                              {t("chat.modelsEarlier")}
                            </p>
                          )}
                          <VersionItem
                            label={modelDisplayLabel(browsing, id, t)}
                            selected={browsing === providerId && configuredModel === id}
                            onClick={() => void pick(browsing, id)}
                          />
                        </div>
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
          : "text-[var(--cf-text)] hover:bg-[var(--cf-hover)]"
      }`}
    >
      <Check size={11} className={`shrink-0 ${selected ? "" : "opacity-0"}`} />
      <span className="truncate">{label}</span>
    </button>
  );
}
