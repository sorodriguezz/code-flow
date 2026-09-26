import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ExternalLink,
  FolderGit2,
  GitBranchPlus,
  GitPullRequest,
  Link2,
  Loader2,
  Search,
  X,
} from "lucide-react";
import { AiGlyph } from "../common/AiGlyph";
import { resolvePrLink } from "../../lib/tauri/commands";
import { VIEW_ON_KEYS } from "../../lib/providerLabels";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { usePrStore } from "../../state/prStore";
import { useUiStore } from "../../state/uiStore";
import { useAiPanelStore } from "../../state/aiPanelStore";
import { pushErrorToast } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import { ReviewLevelSelector } from "../ai/ReviewLevelSelector";
import { CloneRepoModal } from "./CloneRepoModal";
import type { PrLinkResolution, PullRequestSummary } from "../../types/domain";
import { buttonClass } from "../common/Button";
import { fieldClass } from "../common/recipes";

/** Cheap "is this worth auto-resolving?" test for whatever happens to be on the clipboard — the
 * backend is the real parser, this only decides whether to spend a round-trip on open. */
function looksLikePrLink(text: string): boolean {
  const value = text.trim().toLowerCase();
  if (value.length > 500 || !/^https?:\/\//.test(value)) return false;
  return (
    value.includes("/pull/") ||
    value.includes("/pullrequest/") ||
    value.includes("/pullrequests/") ||
    // GitLab's own shape — without it a merge-request URL already on the clipboard is never
    // offered, which is the whole convenience this modal exists for.
    value.includes("/merge_requests/")
  );
}

function PrPreview({ pr }: { pr: PullRequestSummary }) {
  const t = useT();
  return (
    <div className="rounded-lg border border-[var(--cf-border)] bg-[var(--cf-hover)] p-2.5">
      <p className="flex items-start gap-1.5 text-[12px] font-semibold">
        <GitPullRequest size={12} className="mt-0.5 shrink-0 text-[var(--cf-accent)]" />
        <span className="min-w-0 flex-1">
          #{pr.id} {pr.title}
        </span>
      </p>
      <p className="mt-1 pl-[18px] text-[11px] text-[var(--cf-text-muted)]">
        {t("chat.prBy", { author: pr.author })} ·{" "}
        {t("chat.prBranches", { source: pr.source_branch, target: pr.target_branch })}
      </p>
      <a
        href={pr.url}
        target="_blank"
        rel="noreferrer"
        className="mt-1 inline-flex items-center gap-1 pl-[18px] text-[11px] text-[var(--cf-accent)] hover:underline"
      >
        <ExternalLink size={10} />
        {t(VIEW_ON_KEYS[pr.provider])}
      </a>
    </div>
  );
}

/**
 * "Review a PR from its link" — paste the URL a teammate sent you and CodeFlow works out which
 * of your repositories it belongs to, links that repository to its host if it wasn't already,
 * and hands the pull request to the normal review pipeline. No hunting through the sidebar, and
 * no need to know which project (or even which workspace) the repo lives in.
 *
 * When the repository isn't on this machine at all there are two honest answers, and both are
 * offered rather than picked for the user: review straight from the API diff (instant, but the
 * model never sees the surrounding codebase), or clone it once and get the full review.
 */
export function OpenPrLinkModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const reviewLevel = usePrStore((s) => s.reviewLevel);
  const setReviewLevel = usePrStore((s) => s.setReviewLevel);
  const openSettings = useUiStore((s) => s.openSettings);

  const [url, setUrl] = useState("");
  const [resolving, setResolving] = useState(false);
  const [resolution, setResolution] = useState<PrLinkResolution | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showClone, setShowClone] = useState(false);
  // Only the newest lookup may write state — the field stays editable while one is in flight.
  const requestRef = useRef(0);

  const resolve = useCallback(async (value: string): Promise<PrLinkResolution | null> => {
    const link = value.trim();
    if (!link) return null;
    const token = ++requestRef.current;
    setResolving(true);
    setError(null);
    setResolution(null);
    try {
      const result = await resolvePrLink(link);
      if (requestRef.current !== token) return null;
      setResolution(result);
      return result;
    } catch (e) {
      if (requestRef.current === token) setError(String(e));
      return null;
    } finally {
      if (requestRef.current === token) setResolving(false);
    }
  }, []);

  // Opening this modal is already the statement of intent, so a pull-request link sitting on the
  // clipboard is filled in and looked up straight away — the common case ("someone just sent me
  // this PR") becomes a single click. Clipboard reads can be denied; that's simply a no-op.
  useEffect(() => {
    let cancelled = false;
    void navigator.clipboard
      ?.readText()
      .then((text) => {
        if (cancelled || !looksLikePrLink(text)) return;
        setUrl(text.trim());
        void resolve(text);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [resolve]);

  /** Puts the PR on screen exactly as selecting it in the sidebar would, crossing into its
   * workspace/project first, and optionally launches the review straight away. */
  const openPr = async (ready: Extract<PrLinkResolution, { status: "Ready" }>, review: boolean) => {
    try {
      await useWorkspaceStore.getState().focusProject(ready.workspace_id, ready.project_id);
    } catch (e) {
      pushErrorToast(String(e));
      return;
    }
    // Its own tab in the assistant; whatever else was open there stays open.
    useAiPanelStore.getState().open({ kind: "pr", projectId: ready.project_id, pr: ready.pr });
    // The sidebar's own list is refreshed in the background so this PR shows as the one on screen
    // there too — the review itself doesn't wait on it.
    void usePrStore.getState().loadPullRequests(ready.project_id);
    if (review) usePrStore.getState().reviewPr({ kind: "project", projectId: ready.project_id }, ready.pr);
    onClose();
  };

  // After cloning, the new repository's remote is what makes the link resolvable — so the same
  // URL is looked up again and, this time, goes straight into the review the user asked for.
  const onCloned = async () => {
    const result = await resolve(url);
    if (result?.status === "Ready") void openPr(result, true);
  };

  /** Hands the PR to the panel with no clone behind it. From here on it is an ordinary review —
   * same findings, same comment threads, same approve / request changes / close, same Activity —
   * just reading its diff from the host instead of from a working copy. */
  const openWithoutCloning = (found: Extract<PrLinkResolution, { status: "NoLocalRepo" }>) => {
    if (!activeWorkspaceId) return;
    const session = {
      url: url.trim(),
      pr: found.pr,
      repoLabel: found.repo_label,
      cloneUrl: found.clone_url,
      workspaceId: activeWorkspaceId,
    };
    // The tab is the session: a link review belongs to no project, and its tab is its handle.
    useAiPanelStore.getState().open({ kind: "prLink", session });
    usePrStore.getState().reviewPr({ kind: "link", url: session.url, workspaceId: activeWorkspaceId }, found.pr, { session });
    onClose();
  };

  const lookupBody = (
    <>
      <p className="mb-2 text-[11px] text-[var(--cf-text-muted)]">{t("prLink.subtitle")}</p>

      <div className="mb-3 flex items-center gap-2">
        <input
          autoFocus
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void resolve(url);
          }}
          placeholder={t("prLink.placeholder")}
          className={fieldClass({ className: "min-w-0 flex-1 font-mono" })}
        />
        <button
          onClick={() => void resolve(url)}
          disabled={!url.trim() || resolving}
          className={buttonClass({ variant: "secondary" })}
        >
          {resolving ? <Loader2 size={13} className="animate-spin" /> : <Search size={13} />}
          {resolving ? t("prLink.searching") : t("prLink.find")}
        </button>
      </div>

      {error && (
        <p className="mb-3 flex items-start gap-1.5 rounded-lg border border-[var(--cf-danger)]/40 p-2.5 text-[11px] text-[var(--cf-danger)]">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
          <span className="min-w-0 flex-1 break-words">{error}</span>
        </p>
      )}

      {resolution?.status === "Unrecognized" && (
        <p className="mb-3 rounded-lg border border-[var(--cf-border)] p-2.5 text-[11px] text-[var(--cf-text-muted)]">
          {t("prLink.unrecognized")}
        </p>
      )}

      {resolution?.status === "NeedsToken" && (
        <p className="mb-3 rounded-lg border border-[var(--cf-border)] p-2.5 text-[11px] text-[var(--cf-text-muted)]">
          {t("prLink.needsToken", { identifier: resolution.identifier })}{" "}
          <button
            onClick={() => {
              openSettings("azure", resolution.provider);
              onClose();
            }}
            className="text-[var(--cf-accent)] hover:underline"
          >
            {t("statusbar.settings")}
          </button>
        </p>
      )}

      {resolution?.status === "NoLocalRepo" && (
        <div className="mb-3 space-y-2">
          <PrPreview pr={resolution.pr} />
          <p className="text-[11px] text-[var(--cf-text-muted)]">
            {t("prLink.noLocalRepo", { repo: resolution.repo_label })}
          </p>
          {!activeWorkspaceId && <p className="text-[11px] text-[var(--cf-danger)]">{t("prLink.noWorkspace")}</p>}
        </div>
      )}

      {resolution?.status === "Ready" && (
        <div className="mb-3 space-y-2">
          <PrPreview pr={resolution.pr} />
          <p className="flex items-center gap-1.5 text-[11px] text-[var(--cf-text-muted)]">
            <FolderGit2 size={11} className="shrink-0" />
            {t("prLink.foundIn", { project: resolution.project_name })}
          </p>
        </div>
      )}

      <div className="flex items-center justify-end gap-2">
        {resolution?.status === "Ready" && (
          <>
            <ReviewLevelSelector value={reviewLevel} onChange={setReviewLevel} disabled={false} />
            <div className="flex-1" />
            <button
              onClick={() => void openPr(resolution, false)}
              className={buttonClass({ variant: "secondary" })}
            >
              {t("prLink.open")}
            </button>
            <button
              onClick={() => void openPr(resolution, true)}
              className={buttonClass({ variant: "primary" })}
            >
              <AiGlyph size={13} onFill />
              {t("prLink.review")}
            </button>
          </>
        )}

        {resolution?.status === "NoLocalRepo" && (
          <>
            {/* The deeper option, kept secondary: it downloads the repository, and the point of
                this screen is that a link alone is enough. */}
            <button
              onClick={() => setShowClone(true)}
              disabled={!activeWorkspaceId}
              className={buttonClass({ variant: "secondary" })}
            >
              <GitBranchPlus size={13} />
              {t("prLink.cloneAndReview")}
            </button>
            <button
              onClick={() => openWithoutCloning(resolution)}
              disabled={!activeWorkspaceId}
              className={buttonClass({ variant: "primary" })}
            >
              <AiGlyph size={13} onFill />
              {t("prLink.quickReview")}
            </button>
          </>
        )}

        {resolution?.status !== "Ready" && resolution?.status !== "NoLocalRepo" && (
          <button
            onClick={onClose}
            className={buttonClass({ variant: "ghost" })}
          >
            {t("common.cancel")}
          </button>
        )}
      </div>
    </>
  );

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-24" onClick={onClose}>
        <div
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
          }}
          className="flex w-[480px] flex-col rounded-[14px] border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-5 shadow-[var(--cf-shadow-modal)]"
        >
          <div className="mb-3 flex shrink-0 items-center justify-between">
            <h3 className="flex items-center gap-1.5 text-[15px] font-semibold">
              <Link2 size={14} />
              {t("prLink.title")}
            </h3>
            <button onClick={onClose} className="text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]">
              <X size={15} />
            </button>
          </div>

          {lookupBody}
        </div>
      </div>

      {/* A sibling, not a child: nested inside the backdrop above, a click anywhere on the clone
          modal's own overlay would bubble up and close this one out from under it. */}
      {showClone && activeWorkspaceId && resolution?.status === "NoLocalRepo" && (
        <CloneRepoModal
          workspaceId={activeWorkspaceId}
          initialUrl={resolution.clone_url}
          onCloned={() => void onCloned()}
          onClose={() => setShowClone(false)}
        />
      )}
    </>
  );
}
