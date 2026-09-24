import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Loader2, Lock, Settings2 } from "lucide-react";
import { modelOptionsFor } from "../settings/modelPicker";
import { modelDisplayLabel, providerDisplayLabel } from "../../lib/aiProviders";
import { ProviderGlyph } from "../ai/ProviderGlyph";
import { menuItemClass, popoverClass } from "../common/recipes";
import { Tooltip } from "../common/Tooltip";
import { useAgentsStore } from "../../state/agentsStore";
import { MODELS_MAX_AGE_MS, useAiModelsStore } from "../../state/aiModelsStore";
import { useUiStore } from "../../state/uiStore";
import { useT } from "../../state/languageStore";
import { useAccountName, useAiAccountsStore } from "../../state/aiAccountsStore";
import { resolveAccount } from "../../lib/aiAccounts";

const WIDTH = 236;
const GAP = 6;
const EDGE = 8;

/**
 * The composer's "who is answering, on what" chip.
 *
 * Only the **model** is a choice here, and that is the point: the agent is what the task *is* —
 * its instructions are already in the transcript and its engine already holds the session — so
 * swapping it mid-task would silently change who wrote half the thread. The model is a different
 * matter: it is passed per turn, so moving a task onto a stronger one for the hard part costs
 * nothing and loses nothing. That split is exactly the rule JetBrains Air settled on.
 *
 * The pick is written to the **task row**, not to the app's routing table. An agent task's model
 * is task state; changing it must not repoint the AI panel's chat the way the chat's own model
 * chip deliberately does.
 */
export function AgentModelMenu({ taskId }: { taskId: string }) {
  const t = useT();
  const task = useAgentsStore((s) => s.tasks.find((candidate) => candidate.id === taskId) ?? null);
  const modelsByProvider = useAiModelsStore((s) => s.byProvider);
  const ensureModels = useAiModelsStore((s) => s.ensure);
  const openSettings = useUiStore((s) => s.openSettings);
  const activeView = useUiStore((s) => s.activeView);
  const accounts = useAiAccountsStore((s) => s.accounts);
  const taskPins = useAiAccountsStore((s) => s.taskPins);
  const workspaceDefaults = useAiAccountsStore((s) => s.workspaceDefaults);
  const providerDefaults = useAiAccountsStore((s) => s.providerDefaults);
  const ensureAccounts = useAiAccountsStore((s) => s.ensure);
  const nameOf = useAccountName();

  useEffect(() => {
    void ensureAccounts();
  }, [ensureAccounts]);

  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const provider = task?.provider ?? "";

  // Re-measured whenever the list changes height — it arrives asynchronously.
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
    // Opens upward by default — the chip lives at the foot of the pane.
    const above = rect.top - height - GAP;
    const top = above >= EDGE ? above : Math.min(rect.bottom + GAP, window.innerHeight - height - EDGE);
    const left = Math.max(EDGE, Math.min(rect.left, window.innerWidth - WIDTH - EDGE));
    setPos({ top, left });
  }, [open, modelsByProvider]);

  // The view is hidden, never unmounted, and this menu portals to `document.body` — which is
  // outside the hidden container. Switching view from the keyboard would otherwise leave it
  // painting over the Editor or the Graph, still clickable, still writing to a task nobody can see.
  useEffect(() => {
    if (activeView !== "agents") setOpen(false);
  }, [activeView]);

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

  if (!task) return null;


  const openMenu = () => {
    setOpen(true);
    // Only now do we ask this one provider for its list — a CLI's `models` command is a process
    // spawn, so it is paid for on demand rather than on mount. With an age, for the reason
    // `ChatModelPicker` spells out: opening this menu is a question, and a session-old answer to it
    // offers models that are gone and hides ones that arrived.
    if (provider) void ensureModels([provider], MODELS_MAX_AGE_MS);
  };

  /** `undefined` while the fetch is in flight; `modelOptionsFor` keeps the curated catalog for the
   * providers whose CLI can't enumerate models. */
  const models: string[] | undefined =
    provider && modelsByProvider[provider] !== undefined
      ? modelOptionsFor(provider, modelsByProvider[provider]).map((o) => o.id)
      : undefined;

  const pick = (model: string) => {
    setOpen(false);
    void useAgentsStore.getState().setModel(taskId, model);
  };

  return (
    <>
      {/* The engine chip: a pill with a hairline, the shape the chat's composer gives the same
          question, so "who answers, on what" reads alike in both places. */}
      <Tooltip label={t("agents.agentLocked")} disabled={open}>
        <button
          ref={triggerRef}
          type="button"
          onClick={() => (open ? setOpen(false) : openMenu())}
          aria-haspopup="menu"
          aria-expanded={open}
          className={`flex h-[26px] min-w-0 max-w-[60%] items-center gap-1.5 rounded-full px-2.5 text-[12px] shadow-[inset_0_0_0_1px_var(--cf-border-strong)] transition-colors duration-100 ${
            open
              ? "bg-[var(--cf-press)] text-[var(--cf-text)]"
              : "text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]"
          }`}
        >
        {provider && <ProviderGlyph providerId={provider} size={12} />}
        <span className="shrink-0">{task.agent_name || t("settings.sddNewAgent")}</span>
        <span className="text-[var(--cf-text-faint)]">·</span>
        <span className="truncate font-medium text-[var(--cf-text)]">
          {modelDisplayLabel(provider, task.model, t)}
          {/* The account the next turn runs as: the agent's own, else the workspace's — named only
              where the provider has more than one. */}
          {accounts.some((account) => account.provider === provider) &&
            ` · ${nameOf(
              provider,
              resolveAccount(
                { accounts, taskPins, workspaceDefaults, providerDefaults },
                provider,
                "chat",
                task.workspace_id,
                task.account_id,
              ),
            )}`}
        </span>
        <ChevronDown size={12} className={`shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
      </Tooltip>

      {open &&
        createPortal(
          <div
            ref={menuRef}
            style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, width: WIDTH, visibility: pos ? "visible" : "hidden" }}
            className={`${popoverClass} fixed z-[9999] flex max-h-[60vh] flex-col`}
          >
            <p className="flex shrink-0 items-center gap-1.5 px-2.5 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]">
              <Lock size={11} className="shrink-0" />
              <span className="truncate">
                {task.agent_name || t("settings.sddNewAgent")}
                {provider ? ` · ${providerDisplayLabel(provider, t)}` : ""}
              </span>
            </p>

            <div className="min-h-0 flex-1 overflow-auto">
              {models === undefined ? (
                <p className="flex items-center gap-2 px-2.5 py-2 text-[12px] text-[var(--cf-text-muted)]">
                  <Loader2 size={13} className="animate-spin" />
                  {t("chat.loadingModels")}
                </p>
              ) : models.length === 0 ? (
                <p className="px-2.5 py-2 text-[12px] leading-snug text-[var(--cf-text-muted)]">{t("chat.noModels")}</p>
              ) : (
                models.map((id) => (
                  <ModelItem
                    key={id}
                    label={modelDisplayLabel(provider, id, t)}
                    selected={task.model === id}
                    onClick={() => pick(id)}
                  />
                ))
              )}
            </div>

            <div className="my-1 h-px shrink-0 bg-[var(--cf-border)]" />
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                openSettings("claude");
              }}
              className={menuItemClass(false, "shrink-0 text-[var(--cf-text-muted)]")}
            >
              <Settings2 size={15} className="shrink-0 opacity-70" />
              {t("chat.configureModels")}
            </button>
          </div>,
          document.body,
        )}
    </>
  );
}

function ModelItem({ label, selected, onClick }: { label: string; selected: boolean; onClick: () => void }) {
  return (
    <button type="button" role="menuitemradio" aria-checked={selected} onClick={onClick} className={menuItemClass(false)}>
      {/* Kept in the layout when unselected so picking a model doesn't shift every label. */}
      <Check size={15} className={`shrink-0 text-[var(--cf-accent)] ${selected ? "" : "opacity-0"}`} />
      <span className={`truncate ${selected ? "font-medium" : ""}`}>{label}</span>
    </button>
  );
}
