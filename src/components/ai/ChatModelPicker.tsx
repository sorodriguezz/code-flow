import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, ChevronLeft, ChevronRight, Loader2, Lock, Settings2 } from "lucide-react";
import { AI_PROVIDERS, modelDisplayLabel } from "../../lib/aiProviders";
import { modelOptionsFor } from "../settings/modelPicker";
import { useAiModelsStore } from "../../state/aiModelsStore";
import { useAiProviderStore, useTaskProvider } from "../../state/aiProviderStore";
import { useProviderStatusStore } from "../../state/providerStatusStore";
import { useUiStore } from "../../state/uiStore";
import { useT } from "../../state/languageStore";

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
 */
export function ChatModelPicker({ liveModel, chatActive }: { liveModel: string | null; chatActive: boolean }) {
  const t = useT();
  const providerId = useTaskProvider("chat");
  const configuredModel = useAiProviderStore((s) => s.taskModels.chat ?? s.model);
  const setTaskRouting = useAiProviderStore((s) => s.setTaskRouting);
  const modelsByProvider = useAiModelsStore((s) => s.byProvider);
  const ensureModels = useAiModelsStore((s) => s.ensure);
  const statuses = useProviderStatusStore((s) => s.byProvider);
  const checkAll = useProviderStatusStore((s) => s.checkAll);
  const openSettings = useUiStore((s) => s.openSettings);

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
  const ActiveIcon = active.icon;

  const labelOf = (id: string) => {
    const p = AI_PROVIDERS.find((x) => x.id === id);
    return p ? (p.label ?? (p.labelKey ? t(p.labelKey) : id)) : id;
  };

  const openMenu = () => {
    setBrowsing(null);
    setOpen(true);
    if (Object.keys(statuses).length === 0) void checkAll();
  };

  const browse = (id: string) => {
    setBrowsing(id);
    // Only now do we ask this one provider for its list.
    void ensureModels([id]);
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
        <ActiveIcon size={11} className="shrink-0" />
        {activeLabel}
        <span className="text-[var(--cf-text-muted)]/50">·</span>
        <span className="truncate font-medium text-[var(--cf-text)]/70">
          {modelDisplayLabel(providerId, shownModel, t)}
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
                        <p.icon size={12} className="shrink-0" />
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
                {chatActive && (
                  <p className="shrink-0 border-t border-[var(--cf-border)] px-2.5 py-1.5 text-[10px] leading-snug text-[var(--cf-text-muted)]">
                    {t("chat.providerLocked")}
                  </p>
                )}
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
