import { useEffect, useMemo, useState } from "react";
import { ChevronRight, Cloud, Download, GitBranch, GitBranchPlus, Loader2, Lock, RefreshCw, X } from "lucide-react";
import { useRepoStore } from "../../state/repoStore";
import { useT } from "../../state/languageStore";
import type { BranchInfo } from "../../types/domain";

/**
 * The branch list the status bar opens.
 *
 * It is a switcher first — clicking a row checks that branch out and closes — but it is also the
 * only place every branch is listed side by side, which makes it the place to *act* on one you are
 * not standing on: fetch it, pull it, or bring a remote one down as a local branch. Those actions
 * deliberately leave the modal open, because none of them moves you and the answer to each is a
 * number in this list changing.
 *
 * The dialog does not close on a click outside it. Half of what is on screen here is a row of
 * small buttons that start network operations, and a missed one used to dismiss the whole list;
 * the X (and Escape, from the search box) is the way out.
 */
export function BranchSwitcherModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const branches = useRepoStore((s) => s.branches);
  const checkoutBranch = useRepoStore((s) => s.checkoutBranch);
  const checkoutRemoteBranch = useRepoStore((s) => s.checkoutRemoteBranch);
  const trackRemoteBranch = useRepoStore((s) => s.trackRemoteBranch);
  const fetchBranch = useRepoStore((s) => s.fetchBranch);
  const pullBranch = useRepoStore((s) => s.pullBranch);
  const remoteOp = useRepoStore((s) => s.remoteOp);
  const remoteOpBranch = useRepoStore((s) => s.remoteOpBranch);
  const busy = useRepoStore((s) => s.busy);
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return branches.filter((b) => b.name.toLowerCase().includes(q));
  }, [branches, query]);

  const local = filtered.filter((b) => !b.is_remote);
  const remote = filtered.filter((b) => b.is_remote);

  /** Every local branch name, from the unfiltered list: whether `origin/x` is already here is a
   * fact about the repository, not about what the search box currently shows. */
  const localNames = useMemo(
    () => new Set(branches.filter((b) => !b.is_remote).map((b) => b.name)),
    [branches],
  );

  /**
   * Remote branches are folded away until asked for.
   *
   * A repository that has been around for a while has hundreds of them and a handful of local
   * ones, so the group that answers "which branch am I switching to?" was the one you had to
   * scroll past everything else to reach.
   *
   * Typing unfolds it, because a search is a question about branches wherever they live — and
   * clearing the box folds it back. Between those two transitions the header is a plain toggle:
   * collapsing the group mid-search stays collapsed for the rest of that search.
   */
  const [remoteOpen, setRemoteOpen] = useState(false);
  const searching = query.trim() !== "";
  useEffect(() => {
    setRemoteOpen(searching);
  }, [searching]);

  const choose = async (name: string, isRemote: boolean) => {
    if (isRemote) await checkoutRemoteBranch(name);
    else await checkoutBranch(name);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
      <div
        role="dialog"
        aria-modal="true"
        // Every row here is a branch name and nothing else, so the width is the number of
        // characters you can tell apart — narrower, `feature/…` rows all truncate to the same text.
        className="flex max-h-[70vh] w-[560px] max-w-[90vw] flex-col overflow-hidden rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] shadow-[var(--cf-shadow)]"
      >
        <div className="flex items-center gap-2 border-b border-[var(--cf-border)] px-3 py-2">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && onClose()}
            placeholder={t("branchModal.search")}
            className="flex-1 bg-transparent text-[13px] outline-none"
          />
          <button
            onClick={onClose}
            title={t("branchModal.close")}
            aria-label={t("branchModal.close")}
            className="text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
          >
            <X size={15} />
          </button>
        </div>

        <div className="flex-1 overflow-auto p-1.5">
          {local.length > 0 && (
            <div className="mb-1">
              <p className="px-2 py-1 text-[11px] font-semibold uppercase text-[var(--cf-text-muted)]">{t("branchModal.local")}</p>
              {local.map((b) => (
                <LocalRow
                  key={b.name}
                  branch={b}
                  onChoose={() => choose(b.name, false)}
                  onFetch={() => void fetchBranch(b.name)}
                  onPull={() => void pullBranch(b.name)}
                  running={remoteOpBranch === b.name ? remoteOp : null}
                  locked={remoteOp !== null}
                />
              ))}
            </div>
          )}

          {remote.length > 0 && (
            <div>
              {/* A header that says how many are hidden, rather than a bare label: the count is
                  the reason the group is folded in the first place. */}
              <button
                onClick={() => setRemoteOpen((open) => !open)}
                aria-expanded={remoteOpen}
                title={remoteOpen ? t("branchModal.collapseRemote") : t("branchModal.expandRemote")}
                className="flex w-full items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold uppercase text-[var(--cf-text-muted)] hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
              >
                <ChevronRight
                  size={12}
                  className={`shrink-0 transition-transform ${remoteOpen ? "rotate-90" : ""}`}
                />
                <span>{t("branchModal.remote")}</span>
                <span className="font-normal normal-case opacity-70">({remote.length})</span>
              </button>
              {remoteOpen &&
                remote.map((b) => {
                  // `origin/feature/x` is local `feature/x` — the same split the checkout does.
                  const localName = b.name.split("/").slice(1).join("/") || b.name;
                  return (
                    <RemoteRow
                      key={b.name}
                      branch={b}
                      localName={localName}
                      alreadyLocal={localNames.has(localName)}
                      busy={busy}
                      onChoose={() => choose(b.name, true)}
                      onTrack={() => void trackRemoteBranch(b.name)}
                    />
                  );
                })}
            </div>
          )}

          {filtered.length === 0 && (
            <p className="px-2 py-3 text-center text-[12px] text-[var(--cf-text-muted)]">{t("branchModal.noMatches")}</p>
          )}
        </div>
      </div>
    </div>
  );
}

/** The row's two remote buttons, quiet until the row is under the pointer. Kept visible while
 * their own operation runs, so the spinner does not vanish the moment the mouse moves away. */
function RowAction({
  icon,
  title,
  disabled,
  running,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  disabled: boolean;
  running: boolean;
  onClick: () => void;
}) {
  return (
    <button
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className={`shrink-0 rounded p-0.5 text-[var(--cf-text-muted)] transition-opacity hover:text-[var(--cf-accent)] disabled:cursor-default disabled:opacity-30 disabled:hover:text-[var(--cf-text-muted)] ${
        running ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
      }`}
    >
      {icon}
    </button>
  );
}

function LocalRow({
  branch,
  onChoose,
  onFetch,
  onPull,
  running,
  locked,
}: {
  branch: BranchInfo;
  onChoose: () => void;
  onFetch: () => void;
  onPull: () => void;
  /** Which operation this very branch is in the middle of, if any. */
  running: "fetch" | "pull" | "push" | null;
  /** Some remote operation is running — anywhere, on any branch. All the buttons wait for it. */
  locked: boolean;
}) {
  const t = useT();
  // The remote's name as the branch itself records it, so the tooltip says where the commits would
  // come from rather than assuming `origin`.
  const remoteName = branch.upstream?.split("/")[0] ?? "";
  const tracked = Boolean(branch.upstream);

  return (
    <div
      className={`group flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] ${
        branch.is_head ? "font-semibold text-[var(--cf-accent)]" : "hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
      }`}
    >
      <button onClick={onChoose} className="flex min-w-0 flex-1 items-center gap-2 text-left">
        <GitBranch size={13} className="shrink-0" />
        {/* A list stays one row per branch, so this one still truncates — the `title`
            is what makes the tail of an over-long name reachable. */}
        <span className="min-w-0 flex-1 truncate" title={branch.name}>
          {branch.name}
        </span>
      </button>

      {/* What the Pull button next to it is for, on the row rather than in a tooltip: the reason to
          press it is that this number isn't zero. */}
      {branch.behind > 0 && (
        <span
          className="shrink-0 text-[11px] font-normal text-[var(--cf-text-muted)]"
          title={t("branchModal.behind", { n: String(branch.behind) })}
        >
          ↓{branch.behind}
        </span>
      )}

      {/* A locked branch reads as locked wherever branches are listed, not only in
          the sidebar row that owns the toggle. */}
      {branch.is_locked && (
        <span
          className="shrink-0 text-[var(--cf-warning)]"
          title={branch.locked_by_rule ? t("branch.lockedByRuleBadge") : t("branch.lockedBadge")}
        >
          <Lock size={11} />
        </span>
      )}

      <RowAction
        icon={running === "fetch" ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
        title={tracked ? t("branchModal.fetch", { remote: remoteName }) : t("branchModal.noUpstreamAction")}
        disabled={locked || !tracked}
        running={running === "fetch"}
        onClick={onFetch}
      />
      <RowAction
        icon={running === "pull" ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
        title={
          !tracked
            ? t("branchModal.noUpstreamAction")
            : branch.is_head
              ? t("branchModal.pullHead")
              : t("branchModal.pull", { remote: remoteName })
        }
        disabled={locked || !tracked}
        running={running === "pull"}
        onClick={onPull}
      />
    </div>
  );
}

function RemoteRow({
  branch,
  localName,
  alreadyLocal,
  busy,
  onChoose,
  onTrack,
}: {
  branch: BranchInfo;
  localName: string;
  alreadyLocal: boolean;
  busy: boolean;
  onChoose: () => void;
  onTrack: () => void;
}) {
  const t = useT();
  return (
    <div className="group flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-[var(--cf-text-muted)] hover:bg-black/[0.03] dark:hover:bg-white/[0.04]">
      <button onClick={onChoose} className="flex min-w-0 flex-1 items-center gap-2 text-left">
        <Cloud size={13} className="shrink-0" />
        {/* `min-w-0 flex-1` as well as `truncate`: without the floor a flex item won't
            shrink below its content, so the name overflowed the row instead of eliding. */}
        <span className="min-w-0 flex-1 truncate" title={branch.name}>
          {branch.name}
        </span>
      </button>
      {/* Bringing it down is not the same as switching to it: the branch joins the local group
          above — where it can then be fetched and pulled — and you stay where you are. */}
      <RowAction
        icon={<GitBranchPlus size={12} />}
        title={
          alreadyLocal
            ? t("branchModal.alreadyLocal", { name: localName })
            : t("branchModal.bringLocal", { name: localName })
        }
        disabled={alreadyLocal || busy}
        running={false}
        onClick={onTrack}
      />
      {alreadyLocal && (
        <span
          className="shrink-0 text-[10px] uppercase opacity-50"
          title={t("branchModal.alreadyLocal", { name: localName })}
        >
          {t("branchModal.local")}
        </span>
      )}
    </div>
  );
}
