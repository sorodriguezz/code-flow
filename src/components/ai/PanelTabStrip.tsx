import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import {
  ChevronDown,
  Clock,
  GitPullRequest,
  Inbox,
  Link2,
  Maximize2,
  MessageSquare,
  Minimize2,
  Plus,
  RotateCcw,
  ShieldCheck,
  X,
  type LucideIcon,
} from "lucide-react";
import { ThinkingOrb } from "../common/ThinkingOrb";
import { jobPrUrl } from "../../lib/activityEntries";
import { workspaceActivityKey } from "../../lib/prTarget";
import { openAnalysis, openNewChat } from "../../lib/aiPanelNav";
import { useRepoQueueStore } from "../../lib/repoQueue";
import { useDismiss, useElementWidth } from "./docParts";
import { EMPTY_JOBS, useJobsStore } from "../../state/jobsStore";
import { useChatStore } from "../../state/chatStore";
import { useChatHistoryStore } from "../../state/activityStore";
import { usePrStore } from "../../state/prStore";
import { usePrWatchStore, EMPTY_TRACKED } from "../../state/prWatchStore";
import { INBOX_KEY, useAiPanelStore, type PanelTab } from "../../state/aiPanelStore";
import { useUiStore } from "../../state/uiStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useT } from "../../state/languageStore";
import type { PullRequestSummary } from "../../types/domain";

const EMPTY_PRS: PullRequestSummary[] = [];

/**
 * The top of the assistant: the Inbox, one tab per open thing, and the three controls that act on
 * the panel itself (open something new, wide mode, close).
 *
 * A tab says what it is (its kind's icon), where it is at (the orb while a model works on it, a
 * clock while it waits for its repository, a dot when a result landed that you have not looked at)
 * and — when it belongs to another repository of the workspace — which one. Tabs other than the one
 * on screen shrink to that icon once the strip would overflow; the name is in the tooltip.
 *
 * "Would overflow" is measured, not counted: wide mode is half the window, so no tab count holds
 * for every screen, and a count let the last tab end up cut in half at the strip's edge.
 */
export function PanelTabStrip({
  workspaceId,
  tabs,
  activeKey,
  onOpenCheckpoints,
}: {
  workspaceId: string;
  tabs: PanelTab[];
  activeKey: string;
  onOpenCheckpoints: (() => void) | null;
}) {
  const t = useT();
  const wide = useAiPanelStore((s) => s.wide);
  const toggleWide = useAiPanelStore((s) => s.toggleWide);
  const closePanel = useUiStore((s) => s.toggleAiPanel);
  const stripRef = useRef<HTMLDivElement>(null);
  const stripWidth = useElementWidth(stripRef);
  const [compact, setCompact] = useState(false);
  const holds = `${activeKey}|${tabs.map((tab) => tab.key).join(",")}`;

  // Names first, every time what the strip holds or its width changes; icons only if the names do
  // not fit. Both passes land before the browser paints, so neither is ever seen.
  useLayoutEffect(() => setCompact(false), [holds, stripWidth]);
  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (!strip || compact) return;
    const overflows = () => strip.scrollWidth > strip.clientWidth + 1;
    if (overflows()) {
      setCompact(true);
      return;
    }
    // A name can also grow on its own — a conversation's title arriving from disk.
    const observer = new ResizeObserver(() => {
      if (overflows()) setCompact(true);
    });
    for (const tab of Array.from(strip.children)) observer.observe(tab);
    return () => observer.disconnect();
  }, [compact, holds, stripWidth]);

  // Keep the tab on screen in view when the strip scrolls — without moving anything but the strip.
  useEffect(() => {
    const strip = stripRef.current;
    const tab = strip?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!strip || !tab) return;
    if (tab.offsetLeft < strip.scrollLeft) strip.scrollLeft = tab.offsetLeft - 4;
    else if (tab.offsetLeft + tab.offsetWidth > strip.scrollLeft + strip.clientWidth) {
      strip.scrollLeft = tab.offsetLeft + tab.offsetWidth - strip.clientWidth + 4;
    }
  }, [activeKey, tabs.length]);

  return (
    <div className="flex h-10 shrink-0 items-center gap-0.5 border-b border-[var(--cf-border)] pl-1.5 pr-1">
      <div
        ref={stripRef}
        role="tablist"
        aria-label={t("assistant.tabs")}
        className="relative flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <InboxTab workspaceId={workspaceId} active={activeKey === INBOX_KEY} compact={compact && activeKey !== INBOX_KEY} />
        {tabs.map((tab) => (
          <TabButton key={tab.key} tab={tab} workspaceId={workspaceId} active={tab.key === activeKey} compact={compact && tab.key !== activeKey} />
        ))}
      </div>
      <NewMenu workspaceId={workspaceId} onOpenCheckpoints={onOpenCheckpoints} />
      <HeaderButton
        icon={wide ? Minimize2 : Maximize2}
        label={wide ? t("assistant.narrow") : t("assistant.wide")}
        onClick={toggleWide}
      />
      <HeaderButton icon={X} label={t("assistant.closePanel")} onClick={closePanel} />
    </div>
  );
}

function HeaderButton({ icon: Icon, label, onClick }: { icon: LucideIcon; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-black/[0.05] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.08]"
    >
      <Icon size={13} />
    </button>
  );
}

/** How many things wait on the user in this workspace: pending decisions plus unread results. */
function useNeedsCount(workspaceId: string): number {
  const tracked = usePrWatchStore((s) => s.byWorkspace[workspaceId] ?? EMPTY_TRACKED);
  const unread = useAiPanelStore((s) => s.unread);
  return useMemo(() => {
    const keys = new Set(Object.entries(unread).filter(([, m]) => m.workspaceId === workspaceId).map(([key]) => key));
    for (const pr of tracked) {
      keys.add(pr.kind === "link" && pr.url ? `prlink:${pr.url}` : `pr:${pr.projectId}:${pr.prId}`);
    }
    return keys.size;
  }, [tracked, unread, workspaceId]);
}

function InboxTab({ workspaceId, active, compact }: { workspaceId: string; active: boolean; compact: boolean }) {
  const t = useT();
  const count = useNeedsCount(workspaceId);
  const focus = useAiPanelStore((s) => s.focus);
  const loadWatch = usePrWatchStore((s) => s.load);
  useEffect(() => {
    void loadWatch(workspaceId);
  }, [workspaceId, loadWatch]);
  return (
    <TabShell
      active={active}
      title={t("assistant.inbox")}
      onSelect={() => focus(INBOX_KEY, workspaceId)}
      icon={<Inbox size={13} className="shrink-0" />}
      label={compact ? null : t("assistant.inbox")}
      trailing={
        count > 0 ? (
          <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--cf-accent)] px-1 text-[9.5px] font-bold text-white">
            {count}
          </span>
        ) : null
      }
    />
  );
}

function TabShell({
  active,
  title,
  onSelect,
  onClose,
  icon,
  label,
  dot,
  trailing,
}: {
  active: boolean;
  title: string;
  onSelect: () => void;
  onClose?: () => void;
  icon: ReactNode;
  label: string | null;
  dot?: "unread" | "error" | null;
  trailing?: ReactNode;
}) {
  const t = useT();
  return (
    <div
      role="tab"
      tabIndex={0}
      aria-selected={active}
      title={title}
      onClick={onSelect}
      onAuxClick={(e: ReactMouseEvent) => {
        // Middle click closes, the way it does in every tabbed thing.
        if (e.button === 1 && onClose) {
          e.preventDefault();
          onClose();
        }
      }}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        } else if ((e.key === "Delete" || e.key === "Backspace") && onClose) {
          e.preventDefault();
          onClose();
        }
      }}
      className={`group relative flex h-7 max-w-[190px] shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-[12px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-[var(--cf-accent)] ${
        active
          ? "bg-[var(--cf-accent-soft)] text-[var(--cf-text)]"
          : "text-[var(--cf-text-muted)] hover:bg-black/[0.04] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.05]"
      }`}
    >
      <span className="relative flex shrink-0 items-center">
        {icon}
        {dot && (
          <span
            className={`absolute -right-1 -top-1 h-1.5 w-1.5 rounded-full ring-2 ring-[var(--cf-surface)] ${
              dot === "error" ? "bg-[var(--cf-danger)]" : "bg-[var(--cf-accent)]"
            }`}
          />
        )}
      </span>
      {label && <span className="min-w-0 truncate">{label}</span>}
      {trailing}
      {onClose && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          title={t("assistant.closeTab")}
          aria-label={t("assistant.closeTab")}
          className={`-mr-1 flex h-4 w-4 shrink-0 items-center justify-center rounded text-[var(--cf-text-muted)] hover:bg-black/[0.08] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.1] ${
            active ? "" : "hidden group-hover:flex"
          }`}
        >
          <X size={10} />
        </button>
      )}
    </div>
  );
}

function TabButton({ tab, workspaceId, active, compact }: { tab: PanelTab; workspaceId: string; active: boolean; compact: boolean }) {
  const focus = useAiPanelStore((s) => s.focus);
  const close = useAiPanelStore((s) => s.close);
  const mark = useAiPanelStore((s) => s.unread[tab.key] ?? null);
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId);
  const projectId = tab.kind === "prLink" ? null : tab.projectId;
  const projectName = useWorkspaceStore((s) =>
    projectId ? (Object.values(s.projectsByWorkspace).flat().find((p) => p.id === projectId)?.name ?? "") : "",
  );
  const status = useTabStatus(tab);

  const base = useTabTitle(tab);
  // Another repository's tab says which one, since the panel no longer follows the repository.
  const foreign = projectId !== null && projectId !== activeProjectId && projectName;
  const title = foreign ? `${projectName} · ${base}` : base;
  const Icon: LucideIcon =
    tab.kind === "chat" ? MessageSquare : tab.kind === "pr" ? GitPullRequest : tab.kind === "prLink" ? Link2 : ShieldCheck;
  const icon =
    status === "running" ? (
      <ThinkingOrb size="sm" />
    ) : status === "queued" ? (
      <Clock size={13} className="shrink-0 text-[var(--cf-warning)]" />
    ) : (
      <Icon size={13} className="shrink-0" />
    );
  const short = tab.kind === "pr" ? `#${tab.prId}` : tab.kind === "prLink" ? `#${tab.session.pr.id}` : null;
  const label = compact ? null : active ? title : (short ?? base);
  return (
    <TabShell
      active={active}
      title={title}
      onSelect={() => focus(tab.key, workspaceId)}
      onClose={() => close(tab.key, workspaceId)}
      icon={icon}
      label={label}
      dot={mark && status === "idle" ? (mark.status === "error" ? "error" : "unread") : null}
    />
  );
}

/** What a tab is called — the same words its document or conversation uses. */
function useTabTitle(tab: PanelTab): string {
  const t = useT();
  const liveTitle = useChatStore((s) => (tab.kind === "chat" ? s.byConversation[tab.conversationId]?.title : undefined));
  const storedTitle = useChatHistoryStore((s) =>
    tab.kind === "chat" ? s.byProject[tab.projectId]?.find((c) => c.session_id === tab.conversationId)?.title : undefined,
  );
  switch (tab.kind) {
    case "chat":
      return storedTitle || liveTitle || t("assistant.newChat");
    case "pr":
      return `#${tab.pr.id} ${tab.pr.title}`;
    case "prLink":
      return `#${tab.session.pr.id} ${tab.session.repoLabel} · ${tab.session.pr.title}`;
    case "analysis":
      return t("analyze.title");
  }
}

/** Whether a model is working on what a tab shows, or waiting for its repository to do so. */
function useTabStatus(tab: PanelTab): "running" | "queued" | "idle" {
  const bucket =
    tab.kind === "prLink" ? workspaceActivityKey(tab.session.workspaceId) : tab.kind === "chat" ? null : tab.projectId;
  const jobs = useJobsStore((s) => (bucket ? (s.byProject[bucket] ?? EMPTY_JOBS) : EMPTY_JOBS));
  const chat = useChatStore((s) => (tab.kind === "chat" ? s.byConversation[tab.conversationId] : undefined));
  const queued = useRepoQueueStore((s) => s.queued);
  let runId: string | null = null;
  if (tab.kind === "chat") runId = chat?.sending ? chat.runId : null;
  else {
    const running = jobs.find(
      (job) =>
        job.status === "running" &&
        (tab.kind === "analysis"
          ? job.kind === "analyze-changes"
          : job.kind === "pr-review" &&
            (tab.kind === "prLink" ? jobPrUrl(job) === tab.session.url : job.meta.prId === tab.prId && jobPrUrl(job) === null)),
    );
    runId = running?.id ?? null;
  }
  if (!runId) return "idle";
  return queued[runId] ? "queued" : "running";
}

/**
 * "+" — a new chat, a change analysis, a pull request to review, or a restore point to go back to.
 * All of it for the repository on screen; a PR from anywhere else comes in through its link.
 */
function NewMenu({ workspaceId, onOpenCheckpoints }: { workspaceId: string; onOpenCheckpoints: (() => void) | null }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => setOpen(false));
  const project = useWorkspaceStore((s) => s.activeProject());
  const inWorkspace = useWorkspaceStore((s) => (project ? s.workspaceOfProject(project.id) === workspaceId : false));
  const projectId = project && inWorkspace ? project.id : null;
  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={() => setOpen((v) => !v)}
        title={t("assistant.openNew")}
        aria-label={t("assistant.openNew")}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-black/[0.05] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.08]"
      >
        <Plus size={14} />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-40 mt-1 w-72 rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-1 shadow-[var(--cf-shadow)]"
        >
          <MenuItem
            icon={MessageSquare}
            label={t("assistant.newChat")}
            detail={project?.name}
            disabled={!projectId}
            onClick={() => {
              setOpen(false);
              if (projectId) openNewChat(projectId);
            }}
          />
          <MenuItem
            icon={ShieldCheck}
            label={t("assistant.analyze")}
            detail={project?.name}
            disabled={!projectId}
            onClick={() => {
              setOpen(false);
              if (projectId) openAnalysis(projectId, { run: true });
            }}
          />
          <div className="mx-1 my-1 h-px bg-[var(--cf-border)]" />
          {projectId && <PrPicker projectId={projectId} onPicked={() => setOpen(false)} />}
          <MenuItem
            icon={Link2}
            label={t("assistant.reviewFromLink")}
            onClick={() => {
              setOpen(false);
              useUiStore.getState().openPrLinkModal();
            }}
          />
          {onOpenCheckpoints && (
            <>
              <div className="mx-1 my-1 h-px bg-[var(--cf-border)]" />
              <MenuItem
                icon={RotateCcw}
                label={t("assistant.restorePoints")}
                onClick={() => {
                  setOpen(false);
                  onOpenCheckpoints();
                }}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}

function MenuItem({
  icon: Icon,
  label,
  detail,
  disabled,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  detail?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-black/[0.04] disabled:opacity-40 disabled:hover:bg-transparent dark:hover:bg-white/[0.05]"
    >
      <Icon size={14} className="mt-0.5 shrink-0 text-[var(--cf-text-muted)]" />
      <span className="min-w-0">
        <span className="block truncate text-[12px] text-[var(--cf-text)]">{label}</span>
        {detail && <span className="block truncate text-[10.5px] text-[var(--cf-text-muted)]">{detail}</span>}
      </span>
    </button>
  );
}

/** The repository's open pull requests, fetched when the menu first shows them. */
function PrPicker({ projectId, onPicked }: { projectId: string; onPicked: () => void }) {
  const t = useT();
  const prs = usePrStore((s) => s.prsByProject[projectId] ?? EMPTY_PRS);
  const loading = usePrStore((s) => s.loadingProjectId === projectId);
  const loadPullRequests = usePrStore((s) => s.loadPullRequests);
  const loaded = usePrStore((s) => projectId in s.prsByProject);
  useEffect(() => {
    if (!loaded) void loadPullRequests(projectId);
  }, [loaded, loadPullRequests, projectId]);
  const open = prs.filter((pr) => pr.status === "open" || pr.status === "draft").slice(0, 8);
  return (
    <div>
      <p className="px-2 pb-0.5 pt-1 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
        {t("assistant.reviewPr")}
      </p>
      {loading && open.length === 0 && <p className="px-2 py-1 text-[11px] text-[var(--cf-text-muted)]">{t("assistant.loadingPrs")}</p>}
      {!loading && open.length === 0 && <p className="px-2 py-1 text-[11px] text-[var(--cf-text-muted)]">{t("assistant.noOpenPrs")}</p>}
      {open.map((pr) => (
        <MenuItem
          key={pr.id}
          icon={GitPullRequest}
          label={`#${pr.id} ${pr.title}`}
          detail={`@${pr.author} · ${pr.source_branch}`}
          onClick={() => {
            onPicked();
            useAiPanelStore.getState().open({ kind: "pr", projectId, pr });
          }}
        />
      ))}
    </div>
  );
}

/** "Review PR" as a button with its own menu — the Inbox's version of the "+" menu's PR list. */
export function ReviewPrMenu({ projectId }: { projectId: string; variant?: "button" }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => setOpen(false));
  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-1.5 rounded-md border border-[var(--cf-border)] px-2.5 py-1 text-[12px] font-medium text-[var(--cf-text)] hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
      >
        <GitPullRequest size={12} />
        {t("assistant.reviewPr")}
        <ChevronDown size={11} className="text-[var(--cf-text-muted)]" />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute left-0 top-full z-40 mt-1 w-72 rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-1 shadow-[var(--cf-shadow)]"
        >
          <PrPicker projectId={projectId} onPicked={() => setOpen(false)} />
          <MenuItem
            icon={Link2}
            label={t("assistant.reviewFromLink")}
            onClick={() => {
              setOpen(false);
              useUiStore.getState().openPrLinkModal();
            }}
          />
        </div>
      )}
    </div>
  );
}
