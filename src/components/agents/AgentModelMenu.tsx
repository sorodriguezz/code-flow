import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Loader2, Lock, Settings2 } from "lucide-react";
import { modelOptionsFor } from "../settings/modelPicker";
import { modelDisplayLabel, providerDisplayLabel } from "../../lib/aiProviders";
import { ProviderGlyph } from "../ai/ProviderGlyph";
import { useAgentsStore } from "../../state/agentsStore";
import { useAiModelsStore } from "../../state/aiModelsStore";
import { useUiStore } from "../../state/uiStore";
import { useT } from "../../state/languageStore";

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
    // spawn, so it is paid for on demand rather than on mount.
    if (provider) void ensureModels([provider]);
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
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (open ? setOpen(false) : openMenu())}
        title={t("agents.agentLocked")}
        className="flex min-w-0 max-w-[60%] items-center gap-1 rounded-md border border-transparent px-1.5 py-0.5 text-[10.5px] text-[var(--cf-text-muted)] hover:border-[var(--cf-border)] hover:bg-black/[0.03] dark:hover:bg-white/[0.05]"
      >
        {provider && <ProviderGlyph providerId={provider} size={11} />}
        <span className="shrink-0">{task.agent_name || t("settings.sddNewAgent")}</span>
        <span className="text-[var(--cf-text-muted)]/50">·</span>
        <span className="truncate font-medium text-[var(--cf-text)]/70">
          {modelDisplayLabel(provider, task.model, t)}
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
            <p className="flex shrink-0 items-center gap-1.5 px-2.5 py-1.5 text-[10px] font-medium uppercase tracking-wide text-[var(--cf-text-muted)]">
              <Lock size={10} className="shrink-0" />
              <span className="truncate">
                {task.agent_name || t("settings.sddNewAgent")}
                {provider ? ` · ${providerDisplayLabel(provider, t)}` : ""}
              </span>
            </p>

            <div className="min-h-0 flex-1 overflow-auto p-1 pt-0">
              {models === undefined ? (
                <p className="flex items-center gap-1.5 px-2 py-2 text-[11px] text-[var(--cf-text-muted)]">
                  <Loader2 size={11} className="animate-spin" />
                  {t("chat.loadingModels")}
                </p>
              ) : models.length === 0 ? (
                <p className="px-2 py-2 text-[11px] leading-snug text-[var(--cf-text-muted)]">{t("chat.noModels")}</p>
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

            <button
              type="button"
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

function ModelItem({ label, selected, onClick }: { label: string; selected: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[12px] ${
        selected
          ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
          : "text-[var(--cf-text)] hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
      }`}
    >
      {/* Kept in the layout when unselected so picking a model doesn't shift every label. */}
      <Check size={11} className={`shrink-0 ${selected ? "" : "opacity-0"}`} />
      <span className="truncate">{label}</span>
    </button>
  );
}
