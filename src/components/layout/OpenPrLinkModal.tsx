import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useDialog } from "../../lib/useFocusTrap";
import {
  AlertTriangle,
  CheckCircle2,
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
import { clipboardReadText, resolvePrLink } from "../../lib/tauri/commands";
import { VIEW_ON_KEYS } from "../../lib/providerLabels";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { usePrStore } from "../../state/prStore";
import { useUiStore } from "../../state/uiStore";
import { useAiPanelStore } from "../../state/aiPanelStore";
import { pushErrorToast } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import { ReviewLevelSelector } from "../ai/ReviewLevelSelector";
import { ReviewEngineTag } from "../ai/ReviewEngineTag";
import { CloneRepoModal } from "./CloneRepoModal";
import type { PrLinkResolution, PullRequestSummary } from "../../types/domain";
import { buttonClass } from "../common/Button";
import { fieldClass } from "../common/recipes";
import { looksLikePrLink, splitPrLinks } from "../../lib/prLinks";

type ReadyLink = Extract<PrLinkResolution, { status: "Ready" }>;
type NoLocalLink = Extract<PrLinkResolution, { status: "NoLocalRepo" }>;

/** One link of a batch, as it resolves. */
interface BatchItem {
  url: string;
  resolution: PrLinkResolution | null;
  error: string | null;
}

/** One row of a batch: the PR when it was found, and what will happen to it. */
function BatchRow({ item }: { item: BatchItem }) {
  const t = useT();
  const r = item.resolution;
  const pr = r?.status === "Ready" || r?.status === "NoLocalRepo" ? r.pr : null;
  const status = item.error
    ? t("prLink.multiStatusError")
    : !r
      ? t("prLink.multiStatusResolving")
      : r.status === "Ready"
        ? t("prLink.multiStatusReady", { project: r.project_name })
        : r.status === "NoLocalRepo"
          ? t("prLink.multiStatusNoLocal", { repo: r.repo_label })
          : r.status === "NeedsToken"
            ? t("prLink.multiStatusNeedsToken", { identifier: r.identifier })
            : t("prLink.multiStatusUnrecognized");
  const ok = r?.status === "Ready" || r?.status === "NoLocalRepo";
  const pending = !r && !item.error;
  return (
    <li className="flex items-start gap-1.5 py-1 text-[11px]">
      {pending ? (
        <Loader2 size={12} className="mt-0.5 shrink-0 animate-spin text-[var(--cf-text-muted)]" />
      ) : ok ? (
        <CheckCircle2 size={12} className="mt-0.5 shrink-0 text-[var(--cf-accent)]" />
      ) : (
        <AlertTriangle size={12} className="mt-0.5 shrink-0 text-[var(--cf-danger)]" />
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate font-semibold text-[var(--cf-text)]" title={item.url}>
          {pr ? `#${pr.id} ${pr.title}` : item.url}
        </span>
        <span className={`block truncate ${ok || pending ? "text-[var(--cf-text-muted)]" : "text-[var(--cf-danger)]"}`} title={item.error ?? undefined}>
          {status}
        </span>
      </span>
    </li>
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
  // Several links at once: each resolved on its own, shown with its own status, opened in its own
  // tab. `null` is the single-link screen, which behaves exactly as it always has.
  const [batch, setBatch] = useState<BatchItem[] | null>(null);
  const [opening, setOpening] = useState(false);

  const resolve = useCallback(async (value: string): Promise<PrLinkResolution | null> => {
    const link = value.trim();
    if (!link) return null;
    const token = ++requestRef.current;
    setBatch(null);
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

  /** Looks every link of a batch up at once; each row fills in as its own answer arrives. */
  const resolveAll = useCallback(async (links: string[]) => {
    const token = ++requestRef.current;
    setResolution(null);
    setError(null);
    setBatch(links.map((url) => ({ url, resolution: null, error: null })));
    setResolving(true);
    await Promise.all(
      links.map(async (url, index) => {
        let patch: Partial<BatchItem>;
        try {
          patch = { resolution: await resolvePrLink(url) };
        } catch (e) {
          patch = { error: String(e) };
        }
        if (requestRef.current !== token) return;
        setBatch((items) => items?.map((item, i) => (i === index ? { ...item, ...patch } : item)) ?? items);
      }),
    );
    if (requestRef.current === token) setResolving(false);
  }, []);

  /** The field's text, looked up as one link or as a batch — a single link goes the old way. */
  const lookup = useCallback(
    (value: string) => {
      const links = splitPrLinks(value);
      if (links.length > 1) void resolveAll(links);
      else void resolve(value);
    },
    [resolve, resolveAll],
  );

  // Opening this modal is already the statement of intent, so a pull-request link sitting on the
  // clipboard is filled in and looked up straight away — the common case ("someone just sent me
  // this PR") becomes a single click. Read natively: WebKit's own `navigator.clipboard.readText()`
  // outside a paste gesture pops its "Paste" bubble wherever the pointer was, and the lookup waits
  // on the user clicking it. A failed read is simply a no-op.
  //
  // Opened for a PR already on screen (its "clone it after all"), the link is that PR's and the
  // clipboard is not consulted at all — it may hold a different PR from the same batch.
  //
  // A clipboard holding several links (a list from a chat, a ticket) fills them all in as a batch.
  useEffect(() => {
    let cancelled = false;
    const given = useUiStore.getState().prLinkModalUrl;
    if (given) {
      setUrl(given.trim());
      void resolve(given);
      return;
    }
    void clipboardReadText()
      .then((text) => {
        if (cancelled || !text) return;
        const links = splitPrLinks(text).filter(looksLikePrLink);
        if (links.length === 0) return;
        setUrl(links.join("\n"));
        if (links.length > 1) void resolveAll(links);
        else void resolve(links[0]);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [resolve, resolveAll]);

  /** Puts the PR on screen exactly as selecting it in the sidebar would, crossing into its
   * workspace/project first (unless `focus` is off — a batch crosses only once), and optionally
   * launches the review straight away. Resolves `false` when the project could not be focused. */
  const showPr = async (ready: ReadyLink, review: boolean, focus = true): Promise<boolean> => {
    if (focus) {
      try {
        await useWorkspaceStore.getState().focusProject(ready.workspace_id, ready.project_id);
      } catch (e) {
        pushErrorToast(String(e));
        return false;
      }
    }
    // Its own tab in the assistant; whatever else was open there stays open.
    useAiPanelStore.getState().open({ kind: "pr", projectId: ready.project_id, pr: ready.pr });
    // The sidebar's own list is refreshed in the background so this PR shows as the one on screen
    // there too — the review itself doesn't wait on it.
    void usePrStore.getState().loadPullRequests(ready.project_id);
    if (review) usePrStore.getState().reviewPr({ kind: "project", projectId: ready.project_id }, ready.pr);
    return true;
  };

  const openPr = async (ready: ReadyLink, review: boolean) => {
    if (await showPr(ready, review)) onClose();
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
  const showWithoutCloning = (link: string, found: NoLocalLink, review = true) => {
    if (!activeWorkspaceId) return;
    const session = {
      url: link.trim(),
      pr: found.pr,
      repoLabel: found.repo_label,
      cloneUrl: found.clone_url,
      workspaceId: activeWorkspaceId,
    };
    // The tab is the session: a link review belongs to no project, and its tab is its handle.
    useAiPanelStore.getState().open({ kind: "prLink", session });
    if (review) {
      usePrStore.getState().reviewPr({ kind: "link", url: session.url, workspaceId: activeWorkspaceId }, found.pr, { session });
    }
  };

  const openWithoutCloning = (found: NoLocalLink) => {
    if (!activeWorkspaceId) return;
    showWithoutCloning(url, found);
    onClose();
  };

  // What a batch can act on: the links that resolved to a PR (a repository without a clone needs
  // a workspace to file its link review under, like the single-link path).
  const batchActionable = (batch ?? []).filter(
    (item) => item.resolution?.status === "Ready" || (item.resolution?.status === "NoLocalRepo" && !!activeWorkspaceId),
  );
  const batchSkipped = (batch ?? []).filter((item) => (item.resolution || item.error) && !batchActionable.includes(item)).length;

  /** Every PR of the batch in its own tab — and, with `review`, its own review — through the very
   * same paths a single link takes. The first project is focused; the rest open beside it. */
  const openBatch = async (review: boolean) => {
    setOpening(true);
    let focused = false;
    try {
      for (const item of batchActionable) {
        const r = item.resolution;
        if (r?.status === "Ready") {
          const shown = await showPr(r, review, !focused);
          focused = focused || shown;
        } else if (r?.status === "NoLocalRepo") {
          showWithoutCloning(item.url, r, review);
        }
      }
    } finally {
      setOpening(false);
    }
    onClose();
  };

  const lookupBody = (
    <>
      <p className="mb-2 text-[11px] text-[var(--cf-text-muted)]">{t("prLink.subtitle")}</p>

      <div className="mb-3 flex items-start gap-2">
        {/* A textarea rather than an input so a pasted list keeps its line breaks — an input joins
            the lines, and two URLs glued together read as one broken link. One row until it holds
            more than one link. */}
        <textarea
          autoFocus
          value={url}
          rows={Math.min(5, Math.max(1, url.split("\n").length))}
          spellCheck={false}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              lookup(url);
            }
          }}
          placeholder={t("prLink.placeholder")}
          className={fieldClass({ className: "h-auto min-w-0 flex-1 resize-none py-1.5 font-mono leading-relaxed" })}
        />
        <button
          onClick={() => lookup(url)}
          disabled={!url.trim() || resolving}
          className={buttonClass({ variant: "secondary" })}
        >
          {resolving ? <Loader2 size={13} className="animate-spin" /> : <Search size={13} />}
          {resolving ? t("prLink.searching") : t("prLink.find")}
        </button>
      </div>

      {batch && (
        <div className="mb-3">
          <p className="mb-1 text-[11px] text-[var(--cf-text-muted)]">{t("prLink.multiDetected", { count: batch.length })}</p>
          <ul className="max-h-60 overflow-y-auto rounded-lg border border-[var(--cf-border)] px-2.5 py-1">
            {batch.map((item) => (
              <BatchRow key={item.url} item={item} />
            ))}
          </ul>
          {batchSkipped > 0 && (
            <p className="mt-1 text-[11px] text-[var(--cf-text-muted)]">{t("prLink.multiSkipped", { count: batchSkipped })}</p>
          )}
          {!activeWorkspaceId && batch.some((item) => item.resolution?.status === "NoLocalRepo") && (
            <p className="mt-1 text-[11px] text-[var(--cf-danger)]">{t("prLink.noWorkspace")}</p>
          )}
        </div>
      )}

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
        {batch && (
          <>
            <ReviewLevelSelector value={reviewLevel} onChange={setReviewLevel} disabled={false} />
            <ReviewEngineTag />
            <div className="flex-1" />
            <button
              onClick={() => void openBatch(false)}
              disabled={batchActionable.length === 0 || opening}
              className={buttonClass({ variant: "secondary" })}
            >
              {t("prLink.openAll", { count: batchActionable.length })}
            </button>
            <button
              onClick={() => void openBatch(true)}
              disabled={batchActionable.length === 0 || opening}
              className={buttonClass({ variant: "primary" })}
            >
              {opening ? <Loader2 size={13} className="animate-spin" /> : <AiGlyph size={13} onFill />}
              {t("prLink.reviewAll", { count: batchActionable.length })}
            </button>
          </>
        )}

        {resolution?.status === "Ready" && (
          <>
            <ReviewLevelSelector value={reviewLevel} onChange={setReviewLevel} disabled={false} />
            <ReviewEngineTag />
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

        {!batch && resolution?.status !== "Ready" && resolution?.status !== "NoLocalRepo" && (
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

  // Tab stays in the dialog and Escape closes it while it is on top — the clone dialog it can open
  // over itself takes the first Escape. Escape used to work only with the focus inside the card.
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useDialog(panelRef, true, onClose);

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-24" onClick={onClose}>
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          // ⌘⇧L closes it again — the one app chord that may run over it.
          data-shortcut-owner="pr.fromLink"
          onClick={(e) => e.stopPropagation()}
          className="flex w-[480px] flex-col rounded-[14px] border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-5 shadow-[var(--cf-shadow-modal)]"
        >
          <div className="mb-3 flex shrink-0 items-center justify-between">
            <h3 id={titleId} className="flex items-center gap-1.5 text-[15px] font-semibold">
              <Link2 size={14} />
              {t("prLink.title")}
            </h3>
            <button onClick={onClose} aria-label={t("common.close")} className="text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]">
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
