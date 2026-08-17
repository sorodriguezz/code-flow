import { useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  ChevronRight,
  GitBranch,
  Loader2,
  RefreshCw,
  RotateCw,
  ShieldAlert,
  Sparkles,
} from "lucide-react";
import { t } from "../i18n";
import { rpc } from "../transport";
import { newId } from "../ids";
import { useBusy, useMobileStore } from "../store";
import { BranchSheet } from "./BranchSheet";
import { CommitSheet } from "./CommitSheet";
import { DiffSheet } from "./DiffSheet";
import type { CommitInfo, FileStatusEntry, SecretHit } from "../../types/domain";

/**
 * The working copy, as much of it as is worth having on a phone.
 *
 * What is here is the tail end of doing work: see what changed, stage it, write a message, send
 * it. What is deliberately absent is anything that *destroys* — no discard, no reset, no branch
 * delete. Those are missing from the server's allowlist too, so this is not a UI decision that
 * could be worked around; it is the shape of what a paired device can do at all.
 */

/**
 * One changed file.
 *
 * Two targets in one row, split by what a thumb is most likely to mean. The checkbox stages and
 * unstages; the path opens the diff. Making the whole row toggle staging (as it did first) meant
 * there was no way to *read* a change before accepting it, which is the thing you most want to do
 * from a phone — you are away from the desk precisely because you are not sure.
 */
function FileRow({
  entry,
  staged,
  repoPath,
  onOpenDiff,
}: {
  entry: FileStatusEntry;
  staged: boolean;
  repoPath: string;
  onOpenDiff: () => void;
}) {
  const run = useMobileStore((s) => s.run);
  const busy = useBusy("repo");

  return (
    <div className="flex w-full items-center">
      <button
        type="button"
        disabled={busy}
        aria-label={staged ? t("repo.unstageAll") : t("repo.stageAll")}
        onClick={() =>
          void run(() =>
            rpc<void>(staged ? "unstage_file" : "stage_file", { repoPath, filePath: entry.path }),
            "repo",
          )
        }
        className="cf-tap flex shrink-0 items-center justify-center pl-3 pr-1 disabled:opacity-50"
      >
        <span
          className={`flex h-4 w-4 items-center justify-center rounded border text-[9px] font-bold ${
            staged
              ? "border-[var(--cf-accent)] bg-[var(--cf-accent)] text-white"
              : "border-[var(--cf-field-border)]"
          }`}
        >
          {staged && <Check size={11} />}
        </span>
      </button>
      <button
        type="button"
        onClick={onOpenDiff}
        className="cf-tap flex min-w-0 flex-1 items-center gap-2 py-2 pr-3 text-left"
      >
        {/* The path is right-truncated with `direction: rtl` so the filename survives and the
            directory is what gets cut — on a phone-width row the opposite would show four levels
            of folder and no file. */}
        <span className="min-w-0 flex-1 truncate text-[13px]" style={{ direction: "rtl" }}>
          <bdi>{entry.path}</bdi>
        </span>
        <span className="shrink-0 font-mono text-[10px] text-[var(--cf-text-muted)]">
          {entry.status}
        </span>
      </button>
    </div>
  );
}

function Group({
  label,
  entries,
  staged,
  repoPath,
  onOpenDiff,
}: {
  label: string;
  entries: FileStatusEntry[];
  staged: boolean;
  repoPath: string;
  onOpenDiff: (path: string, staged: boolean) => void;
}) {
  if (entries.length === 0) return null;
  return (
    <div className="mt-3">
      <p className="px-3 text-[11px] font-medium uppercase tracking-wide text-[var(--cf-text-muted)]">
        {label} · {entries.length}
      </p>
      <div className="mt-1 divide-y divide-[var(--cf-border)] rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface)]">
        {entries.map((entry) => (
          <FileRow
            key={entry.path}
            entry={entry}
            staged={staged}
            repoPath={repoPath}
            onOpenDiff={() => onOpenDiff(entry.path, staged)}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * The pre-commit pass: a local secret scan and an AI read of the working tree.
 *
 * Placed above the commit button rather than below it, because the whole point is that it happens
 * *before*. Neither check blocks committing — the desktop does not block either, and a phone is
 * the worst place to be told "you may not" by a heuristic — but a critical secret hit is drawn in
 * the danger colour and is impossible to miss above the button you are reaching for.
 */
function PreCommit({ repoPath, projectId }: { repoPath: string; projectId: string }) {
  const run = useMobileStore((s) => s.run);
  const busy = useBusy("repo");
  // Its own group. `analyze_working_changes` runs an engine and is awaited inline in the request,
  // so it is one of the two calls that can hold a flag for minutes — sharing `repo` with it would
  // put the commit button back behind the wait this split exists to remove.
  const analyzeBusy = useBusy("analyze");
  const [secrets, setSecrets] = useState<SecretHit[] | null>(null);
  const [analysis, setAnalysis] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);

  return (
    <div className="mt-3 rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface)] p-3">
      <p className="text-[12px] font-medium">{t("precommit.title")}</p>

      <div className="mt-2 flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              setSecrets(await rpc<SecretHit[]>("scan_staged_secrets", { repoPath }));
            }, "repo")
          }
          className="cf-tap flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-[var(--cf-border)] text-[12px] disabled:opacity-40"
        >
          <ShieldAlert size={13} /> {t("precommit.secrets")}
        </button>
        <button
          type="button"
          disabled={analyzeBusy || analyzing}
          onClick={() => {
            setAnalyzing(true);
            void run(async () => {
              try {
                // `jobId` is minted here because the backend files the run's output under it —
                // the same contract the desktop's Analyze button uses.
                const jobId = newId();
                setAnalysis(await rpc<string>("analyze_working_changes", { projectId, jobId }));
              } finally {
                setAnalyzing(false);
              }
            }, "analyze");
          }}
          className="cf-tap flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-[var(--cf-border)] text-[12px] disabled:opacity-40"
        >
          {analyzing ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
          {t("precommit.analyze")}
        </button>
      </div>

      {secrets !== null && (
        <div className="mt-2">
          {secrets.length === 0 ? (
            <p className="text-[11px] text-[var(--cf-success)]">{t("precommit.secretsClean")}</p>
          ) : (
            <ul className="space-y-1">
              {secrets.map((hit, index) => (
                <li
                  key={`${hit.file}-${hit.line}-${index}`}
                  className={`cf-log rounded border px-2 py-1 ${
                    hit.severity === "critical"
                      ? "border-[var(--cf-danger)]/40 text-[var(--cf-danger)]"
                      : "border-[var(--cf-warning)]/40 text-[var(--cf-warning)]"
                  }`}
                >
                  {hit.rule_name} · {hit.file}:{hit.line}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {analysis && (
        <p className="cf-log mt-2 max-h-64 overflow-y-auto rounded border border-[var(--cf-border)] p-2 text-[var(--cf-text-muted)]">
          {analysis}
        </p>
      )}
    </div>
  );
}

/**
 * What has already landed.
 *
 * The commit list was being fetched on every filesystem event since this client existed and drawn
 * nowhere — thirty commits over wifi, parsed, discarded. It is rendered here because it answers the
 * question a phone is most often picked up to ask: *did the thing I left running actually commit
 * anything?* The unpushed ones are marked from the array the store now keeps, so the "3 sin enviar"
 * badge above resolves into three rows you can point at.
 */
function History({
  commits,
  unpushed,
  onOpen,
}: {
  commits: CommitInfo[];
  unpushed: CommitInfo[];
  onOpen: (commit: CommitInfo) => void;
}) {
  if (commits.length === 0) return null;
  const pending = new Set(unpushed.map((c) => c.id));

  return (
    <div className="mt-4">
      <p className="px-1 text-[11px] font-medium uppercase tracking-wide text-[var(--cf-text-muted)]">
        {t("commits.title")}
      </p>
      <div className="mt-1 divide-y divide-[var(--cf-border)] overflow-hidden rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface)]">
        {commits.map((commit) => (
          <button
            key={commit.id}
            type="button"
            onClick={() => onOpen(commit)}
            className="cf-tap flex w-full items-center gap-2 px-3 py-2 text-left"
          >
            {/* A dot, not a word: on a list where most rows are pushed, the marked ones have to be
                findable at a glance rather than read one by one. */}
            <span
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                pending.has(commit.id) ? "bg-[var(--cf-accent)]" : "bg-transparent"
              }`}
              aria-hidden
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12.5px]">{commit.summary}</span>
              <span className="block truncate text-[10.5px] text-[var(--cf-text-muted)]">
                <span className="font-mono">{commit.short_id}</span> · {commit.author_name}
              </span>
            </span>
            <ChevronRight size={13} className="shrink-0 text-[var(--cf-text-muted)]" />
          </button>
        ))}
      </div>
    </div>
  );
}

export function RepoScreen() {
  const { status, repoState, error, projects, projectId, commits, unpushed, run } =
    useMobileStore();
  const busy = useBusy("repo");
  const refreshRepo = useMobileStore((s) => s.refreshRepo);
  const [message, setMessage] = useState("");
  const [openDiff, setOpenDiff] = useState<{ path: string; staged: boolean } | null>(null);
  const [openCommit, setOpenCommit] = useState<CommitInfo | null>(null);
  const [pickingBranch, setPickingBranch] = useState(false);
  const repoPath = projects.find((p) => p.id === projectId)?.local_path;

  if (!repoPath) {
    return <p className="p-6 text-center text-[13px] text-[var(--cf-text-muted)]">{t("repo.noProject")}</p>;
  }

  const staged = status?.staged ?? [];
  // Untracked files are folded in with the unstaged ones rather than given their own section. On
  // the desktop the distinction earns its screen space; here it costs a heading and a scroll to
  // say something the `status` letter beside each row already says.
  const pending = [...(status?.unstaged ?? []), ...(status?.untracked ?? [])];
  const conflicted = status?.conflicted ?? [];
  /**
   * A clean tree — and only ever a real one.
   *
   * `status` is `null` for three different reasons: nothing has been asked yet, the project just
   * changed, or the read failed. All three used to arrive here as three empty arrays and were drawn
   * as *"El árbol de trabajo está limpio"*, so every cold start reported good news about a
   * repository nobody had looked at, and a revoked device reported it forever. Requiring a real
   * `RepoStatusInfo` is what makes the sentence mean what it says.
   */
  const clean =
    repoState === "ready" && status !== null && staged.length + pending.length + conflicted.length === 0;

  return (
    <div className="cf-scroll flex-1 px-3 pb-6">
      {openDiff && (
        <DiffSheet
          repoPath={repoPath}
          path={openDiff.path}
          staged={openDiff.staged}
          onClose={() => setOpenDiff(null)}
        />
      )}
      {openCommit && (
        <CommitSheet repoPath={repoPath} commit={openCommit} onClose={() => setOpenCommit(null)} />
      )}
      {pickingBranch && <BranchSheet repoPath={repoPath} onClose={() => setPickingBranch(false)} />}

      {/* Branch, and the two network actions that belong beside it. The chip is the picker: a phone
          has no sidebar to put a branch list in, and "look at what is on the other branch" is half
          of why somebody opens this from away from the desk. */}
      <button
        type="button"
        onClick={() => setPickingBranch(true)}
        className="cf-tap mt-3 flex w-full items-center gap-2 rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface)] px-3 py-2 text-left"
      >
        <GitBranch size={14} className="shrink-0 text-[var(--cf-text-muted)]" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
          {status?.current_branch ?? status?.head_oid?.slice(0, 7) ?? "—"}
        </span>
        {unpushed.length > 0 && (
          <span className="shrink-0 rounded-full bg-[var(--cf-accent)]/15 px-2 py-0.5 text-[10px] text-[var(--cf-accent)]">
            {t("repo.unpushed", { count: unpushed.length })}
          </span>
        )}
        <ChevronRight size={14} className="shrink-0 text-[var(--cf-text-muted)]" />
      </button>

      <div className="mt-2 grid grid-cols-3 gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => void run(() => rpc<void>("git_fetch", { repoPath }), "repo")}
          className="cf-tap flex items-center justify-center gap-1.5 rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface)] text-[13px] disabled:opacity-50"
        >
          <RefreshCw size={13} /> {t("repo.fetch")}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void run(() => rpc<void>("git_pull", { repoPath }), "repo")}
          className="cf-tap flex items-center justify-center gap-1.5 rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface)] text-[13px] disabled:opacity-50"
        >
          <ArrowDownToLine size={13} /> {t("repo.pull")}
        </button>
        <button
          type="button"
          disabled={busy}
          // `setUpstream` is always sent: a branch created on the desktop and pushed for the first
          // time from here would otherwise fail with git's "no upstream" error, which is a thing
          // this UI has no way to let the user fix.
          onClick={() => void run(() => rpc<void>("git_push", { repoPath, setUpstream: true }), "repo")}
          className="cf-tap flex items-center justify-center gap-1.5 rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface)] text-[13px] disabled:opacity-50"
        >
          <ArrowUpFromLine size={13} /> {t("repo.push")}
        </button>
      </div>

      {repoState === "loading" && status === null ? (
        <p className="mt-8 text-center text-[13px] text-[var(--cf-text-muted)]">
          {t("common.loading")}
        </p>
      ) : repoState === "error" ? (
        /* The retry is the point. `refreshRepo` had no caller in any screen, so a read that failed
           left the user with nothing to press and no way back short of killing the tab. */
        <div className="mt-8 flex flex-col items-center gap-2 text-center">
          <p className="text-[13px] text-[var(--cf-text-muted)]">{t("status.repoFailed")}</p>
          {error && (
            <p className="max-w-[22rem] break-words font-mono text-[11px] text-[var(--cf-text-muted)]">
              {error}
            </p>
          )}
          <button
            type="button"
            onClick={() => void refreshRepo()}
            className="cf-tap rounded-lg border border-[var(--cf-border)] px-4 text-[13px]"
          >
            {t("common.retry")}
          </button>
        </div>
      ) : clean ? (
        <p className="mt-8 text-center text-[13px] text-[var(--cf-text-muted)]">{t("repo.clean")}</p>
      ) : (
        <>
          <Group
            label={t("repo.conflicted")}
            entries={conflicted}
            staged={false}
            repoPath={repoPath}
            onOpenDiff={(path, isStaged) => setOpenDiff({ path, staged: isStaged })}
          />
          <Group
            label={t("repo.staged")}
            entries={staged}
            staged
            repoPath={repoPath}
            onOpenDiff={(path, isStaged) => setOpenDiff({ path, staged: isStaged })}
          />
          <Group
            label={t("repo.unstaged")}
            entries={pending}
            staged={false}
            repoPath={repoPath}
            onOpenDiff={(path, isStaged) => setOpenDiff({ path, staged: isStaged })}
          />

          <div className="mt-3 flex gap-2">
            <button
              type="button"
              disabled={busy || pending.length === 0}
              onClick={() => void run(() => rpc<void>("stage_all", { repoPath }), "repo")}
              className="cf-tap flex-1 rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface)] text-[12px] disabled:opacity-40"
            >
              {t("repo.stageAll")}
            </button>
            <button
              type="button"
              disabled={busy || staged.length === 0}
              onClick={() => void run(() => rpc<void>("unstage_all", { repoPath }), "repo")}
              className="cf-tap flex-1 rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface)] text-[12px] disabled:opacity-40"
            >
              {t("repo.unstageAll")}
            </button>
          </div>

          {projectId && <PreCommit repoPath={repoPath} projectId={projectId} />}

          <div className="mt-3">
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder={t("repo.commitPlaceholder")}
              rows={3}
              className="w-full resize-none rounded-lg border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-3 py-2 outline-none focus:border-[var(--cf-accent)]"
            />
            <button
              type="button"
              disabled={busy || staged.length === 0 || message.trim().length === 0}
              onClick={() =>
                void run(async () => {
                  await rpc<string>("commit", { repoPath, message: message.trim() });
                  setMessage("");
                }, "repo")
              }
              className="cf-tap mt-2 w-full rounded-lg bg-[var(--cf-accent)] text-[15px] font-medium text-white disabled:opacity-40"
            >
              {busy ? (
                <RotateCw size={15} className="mx-auto animate-spin" />
              ) : (
                `${t("repo.commit")} · ${staged.length}`
              )}
            </button>
          </div>
        </>
      )}

      {/* Outside the clean/dirty branch on purpose: a clean tree is exactly when the history is the
          only thing on this screen worth reading, and it was the state that used to show a single
          sentence and nothing else. */}
      {repoState !== "error" && (
        <History commits={commits} unpushed={unpushed} onOpen={setOpenCommit} />
      )}
    </div>
  );
}
