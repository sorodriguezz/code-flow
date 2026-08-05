import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion, type Variants } from "framer-motion";
import {
  ArrowRight,
  Bot,
  Check,
  ChevronDown,
  ClipboardList,
  Database,
  Layers,
  MonitorSmartphone,
  Send,
  type LucideIcon,
} from "lucide-react";
import { BetaBadge } from "../common/BetaBadge";
import { useUiStore, type ApiWorkspace, type MainView } from "../../state/uiStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useT } from "../../state/languageStore";
import type { TranslationKey } from "../../lib/i18n/translations";

interface WorkspaceTool {
  id: MainView;
  /**
   * Which workspace *inside* that view, for a view that holds more than one.
   *
   * The API tab holds two — requests and databases — because both are workspace-scoped and neither
   * follows the selected repository. They are separate rows here so each is findable by name;
   * `undefined` means the view has only one.
   */
  workspace?: ApiWorkspace;
  icon: LucideIcon;
  labelKey: TranslationKey;
  /** The second line of the row: what the tool holds, so the name doesn't have to carry it. */
  descriptionKey: TranslationKey;
  /** Marks a tool that is still settling, so the row says so before it is opened rather than after
   * something behaves unexpectedly inside it. */
  beta?: boolean;
}

/** Everything that belongs to the workspace rather than to the selected repository. Adding the
 * next one is a single entry here — the menu, its keyboard order and its empty state all follow. */
const TOOLS: WorkspaceTool[] = [
  {
    id: "api",
    workspace: "requests",
    icon: Send,
    labelKey: "tabbar.api",
    descriptionKey: "tabbar.apiDescription",
  },
  {
    id: "api",
    workspace: "database",
    icon: Database,
    labelKey: "tabbar.databases",
    descriptionKey: "tabbar.databasesDescription",
  },
  // No `workspace`: the agent console is a view of its own. It sits here rather than in the tab
  // bar for the same reason the other two do — the roster belongs to the workspace, and switching
  // repository doesn't change which agents exist.
  {
    id: "agents",
    icon: Bot,
    labelKey: "tabbar.agents",
    descriptionKey: "tabbar.agentsDescription",
  },
  // Below the agents, and workspace-scoped for the plainest reason of the three: a requirement is
  // written before the code that satisfies it, so this screen has to work in a workspace whose
  // repositories don't exist yet.
  {
    id: "stories",
    icon: ClipboardList,
    labelKey: "tabbar.stories",
    descriptionKey: "tabbar.storiesDescription",
  },
  // Last, and workspace-scoped for the same reason as the databases above it: a host is part of the
  // environment a workspace's repositories are deployed to, so switching repository must not change
  // which machines are listed.
  {
    id: "remote",
    icon: MonitorSmartphone,
    labelKey: "tabbar.remote",
    descriptionKey: "tabbar.remoteDescription",
    beta: true,
  },
];

/** Rows are keyed and compared by view *and* workspace, since two of them share a view. */
function toolKey(tool: WorkspaceTool): string {
  return tool.workspace ? `${tool.id}:${tool.workspace}` : tool.id;
}

const MENU_WIDTH = 296;

/** A translucent wash of the workspace's own colour. Built as a string rather than a Tailwind
 * class because the colour comes from the database; `color` may also be a `var(...)` fallback. */
function wash(color: string, percent: number): string {
  return `color-mix(in oklab, ${color} ${percent}%, transparent)`;
}

/** The workspace colour, pulled toward the theme's text colour so it stays legible on both.
 *  A wash is fine behind a glyph; a glyph *in* an arbitrary user colour is not — a pale yellow
 *  vanishes on light. Mixing toward `--cf-text` borrows the theme's contrast for free. */
function ink(color: string): string {
  return `color-mix(in oklab, ${color} 55%, var(--cf-text))`;
}

const MENU_VARIANTS: Variants = {
  hidden: { opacity: 0, y: -6, scale: 0.97 },
  visible: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: { duration: 0.14, ease: "easeOut", staggerChildren: 0.03, delayChildren: 0.04 },
  },
  exit: { opacity: 0, y: -4, scale: 0.98, transition: { duration: 0.1, ease: "easeIn" } },
};

/** Honoured when the OS asks for reduced motion: the menu still appears and disappears, it just
 *  doesn't travel or scale. */
const PLAIN_VARIANTS: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { duration: 0.1 } },
  exit: { opacity: 0, transition: { duration: 0.08 } },
};

/** Rows fade in after the card so the eye lands on the workspace header first — with six tools
 * that ordering is what makes the grouping legible instead of a wall of cards. */
const ROW_VARIANTS: Variants = {
  hidden: { opacity: 0, y: -4 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.12, ease: "easeOut" } },
  exit: { opacity: 0, transition: { duration: 0.06 } },
};

/**
 * The workspace-scoped half of the tab bar, collapsed into one control.
 *
 * The repo tabs stay tabs because switching repository visibly reloads them; these don't follow
 * the repository at all, and a tab sitting next to the others implies they do. Pulling them into
 * a menu that is titled with the workspace — and tinted with the workspace's own colour, the same
 * one its dot uses in the sidebar — makes the scope the first thing you read rather than something
 * you discover when the API tab "fails" to change.
 *
 * Rows are cards (tile, name, description, status slot) so the list still reads as a set of tools
 * at six entries; the scope itself is spelled out in the trigger's tooltip.
 */
export function WorkspaceMenu() {
  const activeView = useUiStore((s) => s.activeView);
  const apiWorkspace = useUiStore((s) => s.apiWorkspace);
  const setActiveView = useUiStore((s) => s.setActiveView);
  const openApiWorkspace = useUiStore((s) => s.openApiWorkspace);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const t = useT();

  const reduceMotion = useReducedMotion();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [pos, setPos] = useState<{ top: number; right: number; maxHeight: number } | null>(null);
  const menuId = useId();

  const workspace = workspaces.find((w) => w.id === activeWorkspaceId) ?? null;
  // No workspace yet (first launch, or one was just deleted): fall back to the accent so the
  // chrome still looks deliberate instead of losing its colour entirely.
  const wsColor = workspace?.color ?? "var(--cf-accent)";
  const activeTool =
    TOOLS.find(
      (tool) => tool.id === activeView && (tool.workspace ?? apiWorkspace) === apiWorkspace,
    ) ?? null;
  // The one sentence that explains the scope, carried by the trigger's `title`. The `aria-label`
  // stays just the control's name, since gluing the two together would put separator punctuation
  // outside i18n.
  const scopeHint = workspace
    ? t("tabbar.scopeWorkspaceHint", { name: workspace.name })
    : t("tabbar.scopeWorkspaceNone");

  const reposition = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    // The bar is pinned to the top of the window, so this never needs to flip upward — only to
    // stay inside the right edge and give the list whatever height is left below.
    setPos({
      top: rect.bottom + 6,
      right: Math.max(8, window.innerWidth - rect.right),
      maxHeight: Math.max(200, window.innerHeight - rect.bottom - 24),
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    reposition();
    const onScroll = () => reposition();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    // Escape is bound to the document rather than to the trigger's `onKeyDown`, because the rows
    // call `preventDefault` on mousedown to keep focus put — and on the WebKit that Tauri renders
    // in, clicking a button doesn't focus it anyway. Handling it on the trigger would mean the
    // menu could only be dismissed with Escape when it had been opened from the keyboard.
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Something outside the menu can change the view — the command palette's "Open API client" runs
  // from the keyboard and so never fires the outside-click that would otherwise close this.
  useEffect(() => setOpen(false), [activeView]);

  useEffect(() => {
    if (!open || activeIndex < 0) return;
    menuRef.current
      ?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex]);

  const openMenu = () => {
    // Opens with no cursor at all. `activeIndex` is the *keyboard* cursor and nothing else — which
    // row you are on is already drawn by `isActive`, with its own accent rail and `aria-current`,
    // so seeding this with the current view bought nothing and seeding it with 0 was worse: from a
    // view that isn't one of these tools (the editor, the graph) `Math.max(-1, 0)` landed on the
    // first row, and the menu opened with something looking hovered under a pointer that had never
    // been near it. The first arrow key picks an end — see `step`.
    setActiveIndex(-1);
    setOpen(true);
  };

  const commit = (tool: WorkspaceTool) => {
    // A view with sub-workspaces needs both set at once, or the tab would open on whichever side was
    // last on screen rather than the one just picked.
    if (tool.workspace) openApiWorkspace(tool.workspace);
    else setActiveView(tool.id);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const step = (dir: 1 | -1) => {
    if (TOOLS.length === 0) return;
    setActiveIndex((i) =>
      // From "no cursor", down enters at the top and up enters at the bottom, rather than both
      // wrapping onto the first row.
      i < 0 ? (dir === 1 ? 0 : TOOLS.length - 1) : (i + dir + TOOLS.length) % TOOLS.length,
    );
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openMenu();
      }
      return;
    }
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        step(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        step(-1);
        break;
      case "Home":
        e.preventDefault();
        setActiveIndex(0);
        break;
      case "End":
        e.preventDefault();
        setActiveIndex(TOOLS.length - 1);
        break;
      case "Enter":
      case " ": {
        e.preventDefault();
        const tool = TOOLS[activeIndex];
        if (tool) commit(tool);
        break;
      }
      case "Tab":
        setOpen(false);
        break;
    }
  };

  const ActiveIcon = activeTool?.icon;

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-activedescendant={
          open && activeIndex >= 0 && TOOLS[activeIndex]
            ? `${menuId}-${toolKey(TOOLS[activeIndex])}`
            : undefined
        }
        aria-label={t("tabbar.workspaceTools")}
        title={scopeHint}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onKeyDown}
        className={`flex h-8 max-w-[240px] shrink-0 items-center gap-2 rounded-md border px-2 outline-none transition-colors ${
          activeTool
            ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
            : "text-[var(--cf-text-muted)] hover:bg-black/[0.03] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.04]"
        } ${
          open || activeTool
            ? "border-[color-mix(in_oklab,var(--cf-accent)_38%,transparent)]"
            : "border-[var(--cf-border)] focus-visible:border-[var(--cf-accent)]"
        }`}
      >
        <span
          className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] border"
          style={{ backgroundColor: wash(wsColor, 16), borderColor: wash(wsColor, 40) }}
        >
          <Layers size={11} style={{ color: ink(wsColor) }} />
        </span>
        <span className="truncate text-[13px] font-medium">
          {workspace?.name ?? t("tabbar.scopeWorkspace")}
        </span>
        {activeTool && ActiveIcon && (
          <span className="flex shrink-0 items-center gap-1 rounded-full bg-[color-mix(in_oklab,var(--cf-accent)_16%,transparent)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide">
            <ActiveIcon size={10} />
            {t(activeTool.labelKey)}
          </span>
        )}
        <ChevronDown size={13} className={`shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {createPortal(
        <AnimatePresence>
          {open && pos && (
            <motion.div
              ref={menuRef}
              id={menuId}
              role="menu"
              aria-label={t("tabbar.workspaceTools")}
              variants={reduceMotion ? PLAIN_VARIANTS : MENU_VARIANTS}
              initial="hidden"
              animate="visible"
              exit="exit"
              style={{
                position: "fixed",
                top: pos.top,
                right: pos.right,
                width: MENU_WIDTH,
                maxWidth: "calc(100vw - 16px)",
                maxHeight: pos.maxHeight,
                transformOrigin: "top right",
              }}
              className="z-[9999] flex flex-col overflow-hidden rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] shadow-[var(--cf-shadow)]"
            >
              <div className="flex shrink-0 items-center gap-2.5 border-b border-[var(--cf-border)] px-3 py-2.5">
                <span
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border"
                  style={{ backgroundColor: wash(wsColor, 18), borderColor: wash(wsColor, 42) }}
                >
                  <Layers size={14} style={{ color: ink(wsColor) }} />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[13px] font-semibold text-[var(--cf-text)]">
                    {workspace?.name ?? t("tabbar.scopeWorkspace")}
                  </span>
                  <span className="block truncate text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
                    {t("tabbar.workspaceTools")}
                  </span>
                </span>
              </div>

              {/* Clearing on the way *out of the list* rather than per row: between two rows the
                  leave and the enter both fire, and resetting on each one would blink the highlight
                  off and on again as the pointer crosses the gap. Out here it only fires when the
                  pointer has actually left, which is what stops a row staying lit under nothing. */}
              <div
                onMouseLeave={() => setActiveIndex(-1)}
                className="min-h-0 flex-1 overflow-y-auto p-1.5"
              >
                {TOOLS.length === 0 ? (
                  <p className="px-2 py-6 text-center text-[12px] text-[var(--cf-text-muted)]">
                    {t("tabbar.workspaceToolsEmpty")}
                  </p>
                ) : (
                  TOOLS.map((tool, i) => {
                    const Icon = tool.icon;
                    const isActive =
                      tool.id === activeView &&
                      (tool.workspace ?? apiWorkspace) === apiWorkspace;
                    const isHighlighted = i === activeIndex;
                    return (
                      <motion.button
                        key={toolKey(tool)}
                        id={`${menuId}-${toolKey(tool)}`}
                        type="button"
                        role="menuitem"
                        data-index={i}
                        aria-current={isActive ? "page" : undefined}
                        variants={reduceMotion ? PLAIN_VARIANTS : ROW_VARIANTS}
                        onMouseEnter={() => setActiveIndex(i)}
                        // Keep focus on the trigger; the keyboard handler lives there.
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => commit(tool)}
                        className={`relative flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left transition-colors ${
                          isActive
                            ? isHighlighted
                              ? "bg-[color-mix(in_oklab,var(--cf-accent)_20%,transparent)]"
                              : "bg-[var(--cf-accent-soft)]"
                            : isHighlighted
                              ? "bg-[color-mix(in_oklab,var(--cf-text)_6%,transparent)]"
                              : ""
                        }`}
                      >
                        {isActive && (
                          <span className="absolute inset-y-1.5 left-0 w-[2.5px] rounded-r-full bg-[var(--cf-accent)]" />
                        )}
                        <span
                          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md border transition-colors ${
                            isActive
                              ? "border-[color-mix(in_oklab,var(--cf-accent)_32%,transparent)] bg-[color-mix(in_oklab,var(--cf-accent)_18%,transparent)] text-[var(--cf-accent)]"
                              : "border-[var(--cf-border)] bg-[color-mix(in_oklab,var(--cf-text)_5%,transparent)] text-[var(--cf-text-muted)]"
                          }`}
                        >
                          <Icon size={14} />
                        </span>
                        <span className="min-w-0 flex-1">
                          {/* The badge rides the name line rather than the status slot on the right:
                              that slot is the row's "you're here / this navigates" affordance, and a
                              tag parked there would be read as one of those. */}
                          <span className="flex items-center gap-1.5">
                            <span
                              className={`min-w-0 truncate text-[13px] font-medium ${
                                isActive ? "text-[var(--cf-accent)]" : "text-[var(--cf-text)]"
                              }`}
                            >
                              {t(tool.labelKey)}
                            </span>
                            {tool.beta && <BetaBadge />}
                          </span>
                          <span className="block truncate text-[11px] text-[var(--cf-text-muted)]">
                            {t(tool.descriptionKey)}
                          </span>
                        </span>
                        {/* Reserved status slot — a count or a live-connection dot lands here later;
                            today it carries "you're here" and "this navigates". */}
                        <span className="flex w-4 shrink-0 items-center justify-end">
                          {isActive ? (
                            <Check size={14} className="text-[var(--cf-accent)]" />
                          ) : (
                            <ArrowRight
                              size={13}
                              className={`text-[var(--cf-text-muted)] transition-opacity ${
                                isHighlighted ? "opacity-100" : "opacity-0"
                              }`}
                            />
                          )}
                        </span>
                      </motion.button>
                    );
                  })
                )}
              </div>

            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </>
  );
}
