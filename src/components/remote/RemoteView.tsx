import { useEffect, useState } from "react";
import { FolderOpen, Monitor, MonitorSmartphone, Terminal, Waypoints, X } from "lucide-react";
import { EmptyState } from "../common/EmptyState";
import { TerminalPane } from "../terminal/TerminalPane";
import { HostExplorer } from "./HostExplorer";
import { HostDetailsPanel } from "./HostDetailsPanel";
import { ImportSshConfigModal } from "./ImportSshConfigModal";
import { ForwardsPanel } from "./ForwardsPanel";
import { AllForwardsPanel } from "./AllForwardsPanel";
import { SftpPanel } from "./SftpPanel";
import { ScreenPanel } from "./ScreenPanel";
import { HostGallery } from "./HostGallery";
import { ConnectBar } from "./ConnectBar";
import { CARD } from "./remoteChrome";
import {
  ensureRemoteStoreLoaded,
  FORWARD_POLL_MS,
  useRemoteStore,
  type RemoteTab,
} from "../../state/remoteStore";
import { useUiStore } from "../../state/uiStore";
import { onTerminalExit } from "../../lib/tauri/events";
import { useT } from "../../state/languageStore";

/**
 * The Remote workspace's shell: host inventory, tab strip, and whichever panel the active tab
 * wants.
 *
 * It sits in the workspace menu rather than the tab bar for the same reason the API client and the
 * database workspace do — a host belongs to the environment a workspace's repositories deploy to,
 * not to the repository you happen to have selected, and a tab beside Graph/Changes/Editor would
 * imply it reloaded when you clicked a different repo.
 *
 * **Session panes are mounted for as long as their tab exists and only ever hidden with CSS.** A
 * pty is a live process with scrollback: unmounting the xterm to switch tabs would throw away every
 * line the shell has written. This is the same rule `App.tsx` applies to whole views, one level
 * down.
 */
export function RemoteView() {
  const tabs = useRemoteStore((s) => s.tabs);
  const activeTabId = useRemoteStore((s) => s.activeTabId);
  const workspaceId = useRemoteStore((s) => s.workspaceId);
  const pollForwards = useRemoteStore((s) => s.pollForwards);
  const markExited = useRemoteStore((s) => s.markExited);
  const recordCommand = useRemoteStore((s) => s.recordCommand);
  const activeView = useUiStore((s) => s.activeView);
  const t = useT();

  const [importing, setImporting] = useState(false);

  useEffect(() => {
    void ensureRemoteStoreLoaded();
  }, []);

  // A session whose `ssh` ended — the far side logged out, the network dropped, the user typed
  // `exit`. The tab stays: its scrollback is often the reason you want to look at it, and closing
  // it out from under the user would take the error message with it.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void onTerminalExit((event) => markExited(event.id)).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, [markExited]);

  // Only while this view is on screen. The list is advisory and re-read on every action that could
  // change it, so polling behind a workspace the user isn't looking at buys nothing.
  useEffect(() => {
    if (activeView !== "remote") return;
    const timer = window.setInterval(() => void pollForwards(), FORWARD_POLL_MS);
    return () => window.clearInterval(timer);
  }, [activeView, pollForwards]);

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;

  if (!workspaceId) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--cf-bg)]">
        <EmptyState
          icon={MonitorSmartphone}
          title={t("remote.noWorkspace")}
          subtitle={t("remote.noWorkspaceHint")}
        />
      </div>
    );
  }

  return (
    <>
      {/* The outer column is what makes the row below fill the window: `App.tsx` hands each
          workspace view a plain block of `h-full`, so a `flex-1` with no flex parent to resolve
          against collapses the whole view to the height of its own content. Every other workspace
          view carries this same wrapper for the same reason. */}
      <div className="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--cf-bg)]">
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <HostExplorer onImport={() => setImporting(true)} />

          <div className={`flex min-w-0 flex-1 flex-col overflow-hidden ${CARD}`}>
            {/* Above the tabs, not inside them: it belongs to the whole workspace, and it is the
                first thing to reach for whether or not anything is open. */}
            <ConnectBar />
            {tabs.length > 0 && <RemoteTabStrip />}

            <div className="relative min-h-0 flex-1">
              {tabs.length === 0 ? (
                <HostGallery />
              ) : (
                <>
                  {/* Sessions: always mounted, hidden with CSS. See the note at the top. */}
                  {tabs.map((tab) =>
                    tab.kind === "session" ? (
                      <div
                        key={tab.id}
                        className={`absolute inset-0 ${tab.id === activeTabId ? "" : "hidden"}`}
                      >
                        <TerminalPane
                          sessionId={tab.sessionId}
                          visible={tab.id === activeTabId}
                          onCommand={(line) => recordCommand(tab.sessionId, line)}
                        />
                      </div>
                    ) : null,
                  )}
                  {/* The other two are stateless views over the store, so they render on demand. */}
                  {activeTab?.kind === "forwards" && (
                    <div className="absolute inset-0">
                      <ForwardsPanel tab={activeTab} />
                    </div>
                  )}
                  {activeTab?.kind === "screen" && (
                    <div className="absolute inset-0">
                      <ScreenPanel tab={activeTab} />
                    </div>
                  )}
                  {activeTab?.kind === "sftp" && (
                    <div className="absolute inset-0">
                      <SftpPanel tab={activeTab} />
                    </div>
                  )}
                  {activeTab?.kind === "all-forwards" && (
                    <div className="absolute inset-0">
                      <AllForwardsPanel />
                    </div>
                  )}
                </>
              )}
            </div>

            <RemoteStatusBar />
          </div>

          {/* A third column, not an overlay: the point of the panel is that the tree and the
              session stay visible while you edit. */}
          <HostDetailsPanel />
        </div>
      </div>

      {importing && <ImportSshConfigModal onClose={() => setImporting(false)} />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

function tabIcon(tab: RemoteTab) {
  if (tab.kind === "forwards" || tab.kind === "all-forwards") return Waypoints;
  if (tab.kind === "sftp") return FolderOpen;
  if (tab.kind === "screen") return tab.launch?.protocol === "rdp" ? MonitorSmartphone : Monitor;
  return Terminal;
}

function RemoteTabStrip() {
  const tabs = useRemoteStore((s) => s.tabs);
  const activeTabId = useRemoteStore((s) => s.activeTabId);
  const setActiveTab = useRemoteStore((s) => s.setActiveTab);
  const closeTab = useRemoteStore((s) => s.closeTab);
  const hosts = useRemoteStore((s) => s.hosts);
  const t = useT();

  return (
    <div className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-[var(--cf-border)] px-1.5 py-1">
      {tabs.map((tab) => {
        const Icon = tabIcon(tab);
        const host = hosts.find((entry) => entry.id === tab.hostId);
        const active = tab.id === activeTabId;
        const exited = tab.kind === "session" && tab.exited;
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={active}
            tabIndex={0}
            onClick={() => setActiveTab(tab.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setActiveTab(tab.id);
              }
            }}
            // Middle click closes, the way every tab strip in this app does.
            onAuxClick={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                void closeTab(tab.id);
              }
            }}
            className={`group flex shrink-0 cursor-default items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] outline-none transition-colors focus-visible:ring-1 focus-visible:ring-[var(--cf-accent)] ${
              active
                ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
                : "text-[var(--cf-text-muted)] hover:bg-black/[0.03] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.04]"
            }`}
            style={host?.color && active ? { color: host.color } : undefined}
          >
            <Icon size={12} className={exited ? "opacity-50" : undefined} />
            <span className={`max-w-[160px] truncate ${exited ? "line-through opacity-60" : ""}`}>
              {tab.name}
            </span>
            {tab.kind === "forwards" && (
              <span className="text-[10px] uppercase tracking-wide opacity-60">
                {t("remote.tabForwardsShort")}
              </span>
            )}
            <button
              type="button"
              aria-label={t("common.close")}
              onClick={(e) => {
                e.stopPropagation();
                void closeTab(tab.id);
              }}
              className={`rounded p-px transition-opacity hover:bg-black/[0.06] focus-visible:opacity-100 group-hover:opacity-100 dark:hover:bg-white/[0.1] ${
                active ? "opacity-100" : "opacity-0"
              }`}
            >
              <X size={11} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/**
 * The one line that says what is actually running.
 *
 * Sessions and forwards are counted separately because they fail separately — a tunnel dropping
 * leaves the shell working, and a shell exiting leaves an auto forward's tunnel gone with it. A
 * single "connected" light would hide both.
 */
function RemoteStatusBar() {
  const forwards = useRemoteStore((s) => s.forwards);
  const sessions = useRemoteStore(
    (s) => s.tabs.filter((tab) => tab.kind === "session" && !tab.exited).length,
  );
  const openAllForwards = useRemoteStore((s) => s.openAllForwards);
  const t = useT();

  if (sessions === 0 && forwards.length === 0) return null;

  return (
    <div className="flex shrink-0 items-center gap-2 border-t border-[var(--cf-border)] px-3 py-1 text-[11px] text-[var(--cf-text-muted)]">
      {sessions > 0 && (
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="h-[6px] w-[6px] rounded-full bg-[var(--cf-success)]" />
          {sessions === 1 ? t("remote.statusSessionsOne") : t("remote.statusSessions", { n: String(sessions) })}
        </span>
      )}
      {sessions > 0 && forwards.length > 0 && <span aria-hidden>·</span>}
      {forwards.length > 0 && (
        <>
          <button
            type="button"
            onClick={openAllForwards}
            className="rounded px-1 underline-offset-2 hover:text-[var(--cf-text)] hover:underline"
          >
            {forwards.length === 1
              ? t("remote.statusForwardsOne")
              : t("remote.statusForwards", { n: String(forwards.length) })}
          </button>
          <span className="min-w-0 truncate font-mono">
            {forwards
              .slice(0, 3)
              .map((forward) =>
                forward.kind === "dynamic"
                  ? `SOCKS :${forward.listen_port}`
                  : `${forward.listen_port} → ${forward.target_host}:${forward.target_port}`,
              )
              .join("  ·  ")}
          </span>
        </>
      )}
    </div>
  );
}
