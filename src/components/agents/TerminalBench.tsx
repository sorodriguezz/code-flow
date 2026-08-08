import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  Columns2,
  Pencil,
  Play,
  Plus,
  Rows2,
  TerminalSquare,
  Trash2,
  X,
} from "lucide-react";
import { benchTabLabel, useBenchStore } from "../../state/benchStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { confirmAction } from "../../state/confirmStore";
import { pushErrorToast } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import { EmptyState } from "../common/EmptyState";
import { TerminalPane } from "../terminal/TerminalPane";
import { PaneTree } from "./PaneTree";
import { ContextMenu } from "../api/CollectionTree";
import { listShellProfiles } from "../../lib/tauri/commands";
import type { BenchTerminal, ShellProfile } from "../../types/domain";

/**
 * The shell picker behind an action.
 *
 * The list is re-read on every open rather than cached, for the same reason the repository dock's
 * is: a shell installed while the app was running, or a profile just added in Settings, should be
 * in the menu without a restart and without invalidation plumbing.
 *
 * It differs from the dock's in the thing that matters here — the choice is per *pane*. Running
 * `claude` in one and `psql` beside it is the ordinary case, and each wants the shell it wants.
 */
function ShellMenu({ onPick, disabled, label }: { onPick: (profileId?: string) => void; disabled: boolean; label: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [profiles, setProfiles] = useState<ShellProfile[]>([]);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    void listShellProfiles()
      .then(setProfiles)
      .catch(() => setProfiles([]));
    const dismiss = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", dismiss);
    return () => window.removeEventListener("mousedown", dismiss);
  }, [open]);

  return (
    <div ref={boxRef} className="relative flex items-center">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        title={label}
        aria-label={label}
        className="flex h-6 w-4 items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-black/[0.05] hover:text-[var(--cf-text)] disabled:opacity-40 dark:hover:bg-white/[0.08]"
      >
        <ChevronDown size={11} />
      </button>
      {open && (
        <div className="cf-fade-in absolute right-0 top-7 z-30 min-w-[10rem] rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-1 shadow-[var(--cf-shadow)]">
          {profiles.length === 0 ? (
            <p className="px-2 py-1.5 text-[11px] text-[var(--cf-text-muted)]">{t("bench.noShells")}</p>
          ) : (
            profiles.map((profile) => (
              <button
                key={profile.id}
                onClick={() => {
                  setOpen(false);
                  onPick(profile.id);
                }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
              >
                <TerminalSquare size={12} className="shrink-0 text-[var(--cf-text-muted)]" />
                <span className="truncate">{profile.name}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

/** A toolbar button, shaped like the rest of the app's icon-only controls. */
function ToolButton({
  onClick,
  title,
  disabled,
  danger,
  children,
}: {
  onClick: () => void;
  title: string;
  disabled?: boolean;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-black/[0.05] disabled:opacity-30 dark:hover:bg-white/[0.08] ${
        danger ? "hover:text-[var(--cf-danger)]" : "hover:text-[var(--cf-text)]"
      }`}
    >
      {children}
    </button>
  );
}

/**
 * One tab.
 *
 * **Rename lives on the right-click menu, not on a pencil in the row.** A tab is narrow and gets
 * narrower with every one you open, so each control parked in it is width taken from the only thing
 * the tab is for — its name. The close button earns its place because closing is the action you
 * reach for while scanning a strip; renaming is deliberate, done once, and is exactly what a
 * context menu is for. Double-click still works, and now it is the shortcut for something visible
 * rather than the only way in.
 *
 * `editing` is lifted to the parent through `renaming`, because the menu that starts a rename is
 * portalled to `document.body` and cannot reach into this component's own state.
 */
function BenchTabButton({
  label,
  live,
  active,
  editing,
  onStartRename,
  onSelect,
  onRename,
  onClose,
  onMenu,
}: {
  label: string;
  live: boolean;
  active: boolean;
  editing: boolean;
  onStartRename: () => void;
  onSelect: () => void;
  onRename: (title: string) => void;
  onClose: () => void;
  onMenu: (x: number, y: number) => void;
}) {
  const t = useT();

  return (
    <div
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e.clientX, e.clientY);
      }}
      className={`group flex min-w-0 shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[12px] ${
        active
          ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
          : "text-[var(--cf-text-muted)] hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
      }`}
    >
      {/* Alive or not, as a dot — the one thing about a tab that is not in its name, and the one
          that decides what opening it does: attach to running shells, or start them under a
          replay. Green when *anything* in the tab is running. */}
      <span
        aria-hidden
        title={live ? t("bench.running") : t("bench.stopped")}
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${live ? "bg-[var(--cf-success)]" : "bg-[var(--cf-text-muted)]/40"}`}
      />
      {editing ? (
        <input
          autoFocus
          defaultValue={label}
          onBlur={(e) => onRename(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            // Blanks are ignored by the store, so cancelling is "commit nothing" rather than a
            // second path out — one way to leave this input, whichever key got you here.
            else if (e.key === "Escape") onRename("");
          }}
          className="w-24 min-w-0 bg-transparent outline-none"
        />
      ) : (
        <button onClick={onSelect} onDoubleClick={onStartRename} className="min-w-0 max-w-[9rem] truncate">
          {label}
        </button>
      )}
      <button
        onClick={onClose}
        title={t("bench.closeTab")}
        aria-label={t("bench.closeTab")}
        className="shrink-0 opacity-0 transition-opacity hover:text-[var(--cf-danger)] group-hover:opacity-100"
      >
        <X size={11} />
      </button>
    </div>
  );
}

/**
 * The terminal bench: tabs of tiled shells, belonging to the workspace rather than to a repository.
 *
 * **Every pane stays mounted.** Only the active tab is visible; the rest are hidden with a class,
 * never unmounted. xterm's scrollback lives in the DOM, so unmounting a hidden tab would throw away
 * everything above the fold and rebuild it from the transcript on the way back — a visible flicker
 * in exchange for nothing. Same reason, same shape, as the repository dock.
 *
 * **A pane is keyed by session, not by terminal.** A resumed terminal is a *different* pty behind
 * the same row, and it has to be a different xterm: reusing the instance would leave the old
 * shell's cursor state, alternate screen and colour attributes on top of a process that never set
 * them.
 *
 * **Closing is not stopping.** The × puts the panel away and does nothing else — see `benchStore`.
 */
export function TerminalBench() {
  const t = useT();
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const project = useWorkspaceStore((s) => s.activeProject());
  const tabs = useBenchStore((s) => s.tabs);
  const terminals = useBenchStore((s) => s.terminals);
  const layouts = useBenchStore((s) => s.layouts);
  const activeTabId = useBenchStore((s) => s.activeTabId);
  const focusedPane = useBenchStore((s) => s.focusedPane);
  const loading = useBenchStore((s) => s.loading);
  const hide = useBenchStore((s) => s.hide);

  /** The right-clicked tab and where its menu goes, or `null`. */
  const [menu, setMenu] = useState<{ x: number; y: number; tabId: string } | null>(null);
  /** Which tab is being renamed in place — in the store, because the list in the left panel starts
   *  it too. See `benchStore.renamingTabId`. */
  const renaming = useBenchStore((s) => s.renamingTabId);
  const setRenaming = useBenchStore((s) => s.startRenameTab);

  /**
   * Where a new shell starts.
   *
   * The selected repository when there is one, because that is overwhelmingly where the CLI you are
   * about to run belongs — and the shell's own default when there isn't, which is a real state
   * here: the agent console works in a workspace with no repository open, and a bench that refused
   * to open a shell until you picked one would be refusing on behalf of `claude`, `gh` and `psql`,
   * none of which need a working copy.
   */
  const cwd = project?.local_path ?? "";

  const byId = new Map(terminals.map((terminal) => [terminal.id, terminal]));

  const fail = (e: unknown) => pushErrorToast(String(e));

  const newTab = (profileId?: string) => {
    if (!workspaceId) return;
    void useBenchStore.getState().addTab(workspaceId, cwd, profileId).catch(fail);
  };

  const split = (dir: "row" | "col", profileId?: string) => {
    if (!workspaceId || !activeTabId) return;
    void useBenchStore.getState().split(workspaceId, activeTabId, cwd, dir, profileId).catch(fail);
  };

  const killEverything = async () => {
    if (!workspaceId) return;
    const ok = await confirmAction(t("bench.clearConfirm", { n: terminals.length }), true, t("bench.clearAction"));
    if (!ok) return;
    await useBenchStore.getState().clear(workspaceId).catch(fail);
  };

  const tabIsLive = (tabId: string): boolean =>
    terminals.some((terminal) => terminal.tab_id === tabId && terminal.session_id !== null);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-1 border-b border-[var(--cf-border)] px-2 py-1">
        <TerminalSquare size={13} className="shrink-0 text-[var(--cf-text-muted)]" />
        <span className="mr-1 shrink-0 truncate text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
          {t("bench.title")}
        </span>

        {/* The tabs take the slack and scroll sideways rather than wrapping: the toolbar's two ends
            are fixed controls, and a second row appearing at seven tabs would move them. */}
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {tabs.map((tab) => (
            <BenchTabButton
              key={tab.id}
              label={benchTabLabel(tab, terminals, t("bench.title"))}
              live={tabIsLive(tab.id)}
              active={tab.id === activeTabId}
              editing={renaming === tab.id}
              onStartRename={() => setRenaming(tab.id)}
              onSelect={() => useBenchStore.getState().selectTab(tab.id)}
              onRename={(title) => void useBenchStore.getState().renameTab(tab.id, title).catch(fail)}
              onClose={() => void useBenchStore.getState().closeTab(tab.id).catch(fail)}
              onMenu={(x, y) => setMenu({ x, y, tabId: tab.id })}
            />
          ))}
        </div>

        {/* Split before new-tab, because that is the order they are reached in: you are looking at a
            pane and want another beside it far more often than you want a fresh tab. Both disabled
            with no tab open, since there is nothing to split. */}
        <ToolButton onClick={() => split("row")} title={t("bench.splitRight")} disabled={!activeTabId}>
          <Columns2 size={13} />
        </ToolButton>
        <ToolButton onClick={() => split("col")} title={t("bench.splitDown")} disabled={!activeTabId}>
          <Rows2 size={13} />
        </ToolButton>
        <ShellMenu onPick={(profileId) => split("row", profileId)} disabled={!activeTabId} label={t("bench.splitWith")} />

        <span className="mx-1 h-4 w-px shrink-0 bg-[var(--cf-border)]" />

        <ToolButton onClick={() => newTab()} title={t("bench.newTab")} disabled={!workspaceId}>
          <Plus size={13} />
        </ToolButton>
        <ShellMenu onPick={newTab} disabled={!workspaceId} label={t("bench.newTabWith")} />

        {/* Kill and close, visibly apart. They are the two ways out and they are not near-synonyms:
            one throws the work away, the other just stops looking at it. */}
        <span className="mx-1 h-4 w-px shrink-0 bg-[var(--cf-border)]" />
        <ToolButton onClick={() => void killEverything()} title={t("bench.clearAction")} disabled={tabs.length === 0} danger>
          <Trash2 size={13} />
        </ToolButton>
        <ToolButton onClick={hide} title={t("bench.close")}>
          <X size={13} />
        </ToolButton>
      </div>

      <div className="relative min-h-0 flex-1">
        {tabs.length === 0 ? (
          <EmptyState
            icon={TerminalSquare}
            title={loading ? t("bench.loading") : t("bench.empty")}
            subtitle={loading ? "" : t("bench.emptyHint")}
          />
        ) : (
          tabs.map((tab) => {
            const node = layouts[tab.id] ?? null;
            const visible = tab.id === activeTabId;
            return (
              <div key={tab.id} className={visible ? "flex h-full min-h-0" : "hidden"}>
                {node && (
                  <PaneTree
                    node={node}
                    path=""
                    onResize={(path, ratio) => useBenchStore.getState().resize(tab.id, path, ratio)}
                    renderPane={(terminalId) => {
                      const terminal = byId.get(terminalId);
                      if (!terminal) return null;
                      return (
                        <Pane
                          terminal={terminal}
                          visible={visible}
                          focused={focusedPane[tab.id] === terminalId}
                          onFocus={() => useBenchStore.getState().focusPane(tab.id, terminalId)}
                          onClose={() => void useBenchStore.getState().closePane(tab.id, terminalId).catch(fail)}
                        />
                      );
                    }}
                  />
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Rename and close, on the tab you right-clicked. Portalled by `ContextMenu`, so no scroll
          container between here and the window can clip it. */}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={[
            { label: t("bench.renameTab"), icon: Pencil, onClick: () => setRenaming(menu.tabId) },
            {
              label: t("bench.closeTab"),
              icon: Trash2,
              danger: true,
              separated: true,
              onClick: () => void useBenchStore.getState().closeTab(menu.tabId).catch(fail),
            },
          ]}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

/**
 * One pane: a title strip and the terminal under it.
 *
 * The strip is what makes a tiled view usable — with four shells on screen, "which one is this and
 * which one is the toolbar about to split" cannot be answered by the output alone. It also carries
 * the pane's own close, because reaching for a specific one of four is a click on *it*, not a
 * selection followed by a toolbar press.
 *
 * The accent left edge marks the focused pane, and focus follows the pointer down: clicking
 * anywhere in a pane — including into its terminal — makes it the one the toolbar acts on, which is
 * what stops "split" from surprising you by dividing whichever pane you last used a button on.
 */
function Pane({
  terminal,
  visible,
  focused,
  onFocus,
  onClose,
}: {
  terminal: BenchTerminal;
  visible: boolean;
  focused: boolean;
  onFocus: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);

  return (
    <div
      onPointerDownCapture={onFocus}
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      style={{ boxShadow: focused ? "inset 2px 0 0 var(--cf-accent)" : undefined }}
    >
      <div className="group flex shrink-0 items-center gap-1.5 px-2 py-0.5 text-[11px] text-[var(--cf-text-muted)]">
        <span
          aria-hidden
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
            terminal.session_id ? "bg-[var(--cf-success)]" : "bg-[var(--cf-text-muted)]/40"
          }`}
        />
        {editing ? (
          <input
            autoFocus
            defaultValue={terminal.title}
            onBlur={(e) => {
              void useBenchStore.getState().renameTerminal(terminal.id, e.target.value).catch(() => {});
              setEditing(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              else if (e.key === "Escape") setEditing(false);
            }}
            className="w-24 min-w-0 bg-transparent outline-none"
          />
        ) : (
          <span onDoubleClick={() => setEditing(true)} className="min-w-0 flex-1 truncate">
            {terminal.title}
          </span>
        )}
        <button
          onClick={() => setEditing(true)}
          title={t("bench.renameTerminal")}
          aria-label={t("bench.renameTerminal")}
          className="shrink-0 opacity-0 transition-opacity hover:text-[var(--cf-accent)] group-hover:opacity-100"
        >
          <Pencil size={10} />
        </button>
        <button
          onClick={onClose}
          title={t("bench.removeTerminal")}
          aria-label={t("bench.removeTerminal")}
          className="shrink-0 hover:text-[var(--cf-danger)]"
        >
          <X size={11} />
        </button>
      </div>

      <div className="min-h-0 flex-1">
        {terminal.session_id ? (
          <TerminalPane
            key={terminal.session_id}
            sessionId={terminal.session_id}
            visible={visible}
            replay={terminal.transcript}
          />
        ) : (
          // No shell behind this pane. Rather than starting one on sight — which would mean opening
          // the bench silently spawning six processes — it says so and offers the button. The
          // transcript is still there and comes back with it.
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-4 text-center">
            <p className="text-[12px] text-[var(--cf-text-muted)]">{t("bench.stoppedHint")}</p>
            <button
              onClick={() => void useBenchStore.getState().resume(terminal.id).catch((e: unknown) => pushErrorToast(String(e)))}
              className="flex items-center gap-1.5 rounded-md bg-[var(--cf-accent)] px-3 py-1.5 text-[12px] font-medium text-white"
            >
              <Play size={12} />
              {t("bench.resume")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
