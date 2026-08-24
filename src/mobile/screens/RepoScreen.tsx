import { useEffect, useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  CheckCheck,
  CircleDot,
  GitBranch,
  GitCommitHorizontal,
  RefreshCw,
  ShieldAlert,
  Sparkles,
} from "lucide-react";
import { t } from "../i18n";
import { rpc } from "../transport";
import { newId } from "../ids";
import { useBusy, useMobileStore, useRepoPath } from "../store";
import { useNav } from "../nav";
import { navigated } from "../haptics";
import { clearDraft, readDraft, writeDraft } from "../drafts";
import { since } from "../time";
import { RootBar } from "../ui/RootBar";
import { Screen } from "../ui/Screen";
import { BottomBar } from "../ui/BottomBar";
import { Button } from "../ui/Button";
import { Card, Divider, PathText, Row, Section } from "../ui/List";
import { Badge, EmptyState, ErrorState, SkeletonList } from "../ui/Feedback";
import type { CommitInfo, FileStatusEntry, SecretHit } from "../../types/domain";

/**
 * The working copy, as much of it as is worth having on a phone.
 *
 * What is here is the tail end of doing work: see what changed, stage it, write a message, send
 * it. What is deliberately absent is anything that *destroys* — no discard, no reset, no branch
 * delete. Those are missing from the server's allowlist too, so this is not a UI decision that
 * could be worked around; it is the shape of what a paired device can do at all.
 *
 * # The commit box is pinned, not at the bottom of the scroll
 *
 * It used to be the last thing in a column that on a busy tree is 800 px tall, under the file list
 * and the pre-commit checks — so committing meant scrolling past everything you had just staged. It
 * is now a bar at the bottom of the screen, in the same place and the same shape as the chat
 * composer, appearing only when there is something staged to commit.
 */

/** The letter git puts against a path, as a tone. Red for a deletion or a conflict, green for a new
 *  file, neutral for a modification — so a list of twenty rows sorts itself at a glance. */
function statusTone(status: string): "neutral" | "success" | "danger" | "warning" {
  const first = status.trim().charAt(0).toUpperCase();
  if (first === "A" || first === "?" || first === "N") return "success";
  if (first === "D") return "danger";
  if (first === "U" || first === "C") return "warning";
  return "neutral";
}

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
}: {
  entry: FileStatusEntry;
  staged: boolean;
  repoPath: string;
}) {
  const run = useMobileStore((s) => s.run);
  const push = useNav((s) => s.push);
  const busy = useBusy("repo");
  const name = entry.path.split("/").pop() ?? entry.path;

  return (
    <div className="flex w-full items-center">
      <button
        type="button"
        disabled={busy}
        role="checkbox"
        aria-checked={staged}
        // Names the file and the action, where it used to say only "Stage a todo" — the same string
        // on every row of a twenty-row list, describing a different button entirely.
        aria-label={staged ? t("repo.unstageOne", { file: name }) : t("repo.stageOne", { file: name })}
        onClick={() =>
          void run(
            () => rpc<void>(staged ? "unstage_file" : "stage_file", { repoPath, filePath: entry.path }),
            "repo",
            staged ? t("toast.unstaged") : t("toast.staged"),
          )
        }
        className="cf-tap cf-press flex shrink-0 items-center justify-center pl-3 pr-1 disabled:opacity-50"
      >
        <span
          className={`flex h-[1.15rem] w-[1.15rem] items-center justify-center rounded-[0.3rem] border-2 transition-colors ${
            staged
              ? "border-[var(--cf-accent-strong)] bg-[var(--cf-accent-strong)] text-[var(--cf-accent-contrast)]"
              : // Two pixels of `--cf-field-border` rather than one: at 1px on white the unchecked
                // box was a 1.5:1 outline, which is to say invisible, and the only thing telling
                // the user a row could be staged at all.
                "border-[var(--cf-field-border)]"
          }`}
        >
          {staged && <Check size={12} strokeWidth={3} aria-hidden />}
        </span>
      </button>
      <button
        type="button"
        aria-label={t("repo.openDiff", { file: name })}
        onClick={() => {
          navigated();
          push({ k: "diff", repoPath, path: entry.path, staged });
        }}
        className="cf-tap cf-press-row flex min-w-0 flex-1 items-center gap-2 py-2 pl-1 pr-3 text-left"
      >
        <PathText path={entry.path} className="min-w-0 flex-1 text-base" />
        <Badge tone={statusTone(entry.status)} className="font-mono">
          {entry.status}
        </Badge>
      </button>
    </div>
  );
}

function Group({
  label,
  entries,
  staged,
  repoPath,
  tone,
}: {
  label: string;
  entries: FileStatusEntry[];
  staged: boolean;
  repoPath: string;
  tone?: "danger";
}) {
  if (entries.length === 0) return null;
  return (
    <Section
      title={label}
      action={
        <Badge tone={tone === "danger" ? "danger" : "neutral"}>{entries.length}</Badge>
      }
    >
      <Card>
        {entries.map((entry, index) => (
          <div key={entry.path}>
            {index > 0 && <Divider inset />}
            <FileRow entry={entry} staged={staged} repoPath={repoPath} />
          </div>
        ))}
      </Card>
    </Section>
  );
}

/**
 * The pre-commit pass: a local secret scan and an AI read of the working tree.
 *
 * Placed above the commit bar rather than below it, because the whole point is that it happens
 * *before*. Neither check blocks committing — the desktop does not block either, and a phone is
 * the worst place to be told "you may not" by a heuristic — but a critical secret hit is drawn in
 * the danger colour and is impossible to miss.
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

  return (
    <Section title={t("precommit.title")}>
      <Card padded>
        <div className="flex gap-2">
          <Button
            full
            size="sm"
            disabled={busy}
            icon={<ShieldAlert size={14} />}
            onClick={() =>
              void run(async () => {
                setSecrets(await rpc<SecretHit[]>("scan_staged_secrets", { repoPath }));
              }, "repo")
            }
          >
            {t("precommit.secrets")}
          </Button>
          <Button
            full
            size="sm"
            loading={analyzeBusy}
            icon={<Sparkles size={14} />}
            onClick={() =>
              void run(
                async () => {
                  // `jobId` is minted here because the backend files the run's output under it —
                  // the same contract the desktop's Analyze button uses.
                  const jobId = newId();
                  setAnalysis(await rpc<string>("analyze_working_changes", { projectId, jobId }));
                },
                "analyze",
                t("toast.analyzed"),
              )
            }
          >
            {t("precommit.analyze")}
          </Button>
        </div>

        {secrets !== null &&
          (secrets.length === 0 ? (
            <p className="mt-2.5 flex items-center gap-1.5 text-xs text-[var(--cf-success-text)]">
              <CheckCheck size={13} aria-hidden />
              {t("precommit.secretsClean")}
            </p>
          ) : (
            <ul className="mt-2.5 space-y-1">
              {secrets.map((hit, index) => (
                <li
                  key={`${hit.file}-${hit.line}-${index}`}
                  className={`rounded-md border px-2 py-1.5 text-xs ${
                    hit.severity === "critical"
                      ? "border-[var(--cf-danger)]/40 bg-[var(--cf-danger-soft)] text-[var(--cf-danger-text)]"
                      : "border-[var(--cf-warning)]/40 bg-[var(--cf-warning-soft)] text-[var(--cf-warning-text)]"
                  }`}
                >
                  <span className="font-semibold">{hit.rule_name}</span>
                  <span className="cf-selectable mt-0.5 block break-all font-mono text-2xs opacity-80">
                    {hit.file}:{hit.line}
                  </span>
                </li>
              ))}
            </ul>
          ))}

        {analysis && (
          <div className="mt-2.5">
            <p className="text-xs font-semibold text-[var(--cf-text-faint)]">
              {t("precommit.analysis")}
            </p>
            <p className="cf-prose cf-scroll mt-1 max-h-64 rounded-md bg-[var(--cf-sunken)] p-2 text-[var(--cf-text-muted)]">
              {analysis}
            </p>
          </div>
        )}
      </Card>
    </Section>
  );
}

/**
 * What has already landed.
 *
 * It answers the question a phone is most often picked up to ask: *did the thing I left running
 * actually commit anything?* The unpushed ones are marked, so the "3 sin enviar" badge above
 * resolves into three rows you can point at, and every row says how long ago rather than at what
 * o'clock — which is the form of the answer somebody coming back from lunch wants.
 */
function History({ commits, unpushed }: { commits: CommitInfo[]; unpushed: CommitInfo[] }) {
  const push = useNav((s) => s.push);
  const repoPath = useRepoPath();
  if (!repoPath) return null;
  if (commits.length === 0) {
    return (
      <Section title={t("commits.title")}>
        <p className="px-1 text-base text-[var(--cf-text-muted)]">{t("commits.none")}</p>
      </Section>
    );
  }
  const pending = new Set(unpushed.map((c) => c.id));

  return (
    <Section title={t("commits.title")}>
      <Card>
        {commits.map((commit, index) => (
          <div key={commit.id}>
            {index > 0 && <Divider inset />}
            <Row
              leading={
                pending.has(commit.id) ? (
                  <CircleDot size={14} className="text-[var(--cf-accent-text)]" aria-hidden />
                ) : (
                  <GitCommitHorizontal
                    size={14}
                    className="text-[var(--cf-text-faint)]"
                    aria-hidden
                  />
                )
              }
              title={commit.summary}
              subtitle={
                <>
                  <span className="font-mono">{commit.short_id}</span> · {commit.author_name} ·{" "}
                  {since(commit.timestamp)}
                  {pending.has(commit.id) ? ` · ${t("commits.unpushedMark")}` : ""}
                </>
              }
              onClick={() => {
                navigated();
                push({ k: "commit", repoPath, commit });
              }}
            />
          </div>
        ))}
      </Card>
    </Section>
  );
}

/**
 * The commit composer, pinned above the tab bar.
 *
 * Same shape as the chat composer on purpose: one pattern for "type something and send it", learned
 * once. It is only in the tree when something is staged, so on a clean tree the screen is the whole
 * height it can be.
 */
function CommitBar({ repoPath, stagedCount }: { repoPath: string; stagedCount: number }) {
  const projectId = useMobileStore((s) => s.projectId);
  const run = useMobileStore((s) => s.run);
  const busy = useBusy("repo");
  const [message, setMessage] = useState(() => readDraft("commit", projectId));

  // The draft belongs to the project, so switching project must swap it rather than carry one
  // repository's message into another's.
  useEffect(() => {
    setMessage(readDraft("commit", projectId));
  }, [projectId]);

  return (
    <BottomBar className="p-2">
      <div className="flex items-end gap-2">
        <textarea
          value={message}
          onChange={(e) => {
            setMessage(e.target.value);
            writeDraft("commit", projectId, e.target.value);
          }}
          placeholder={t("repo.commitPlaceholder")}
          aria-label={t("repo.commitMessage")}
          rows={1}
          className="max-h-32 min-h-[2.75rem] flex-1 resize-none rounded-lg border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-3 py-2.5 outline-none focus:border-[var(--cf-accent)]"
        />
        <Button
          variant="primary"
          loading={busy}
          disabled={message.trim().length === 0}
          // Keeps its name while it is working, where a spinner used to replace the label and with
          // it the button's only accessible name.
          ariaLabel={`${t("repo.commit")} · ${stagedCount}`}
          onClick={() =>
            void run(
              async () => {
                await rpc<string>("commit", { repoPath, message: message.trim() });
                setMessage("");
                clearDraft("commit", projectId);
              },
              "repo",
              t("toast.committed"),
            )
          }
        >
          {t("repo.commit")} · {stagedCount}
        </Button>
      </div>
    </BottomBar>
  );
}

export function RepoScreen() {
  const status = useMobileStore((s) => s.status);
  const repoState = useMobileStore((s) => s.repoState);
  const error = useMobileStore((s) => s.error);
  const projectId = useMobileStore((s) => s.projectId);
  const commits = useMobileStore((s) => s.commits);
  const unpushed = useMobileStore((s) => s.unpushed);
  const run = useMobileStore((s) => s.run);
  const refreshRepo = useMobileStore((s) => s.refreshRepo);
  const push = useNav((s) => s.push);
  const busy = useBusy("repo");
  const repoPath = useRepoPath();

  if (!repoPath) {
    return (
      <Screen bar={<RootBar title={t("nav.repo")} />}>
        <EmptyState
          icon={<GitBranch size={26} aria-hidden />}
          title={t("repo.noProject")}
          hint={t("repo.noProjectHint")}
        />
      </Screen>
    );
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
    repoState === "ready" &&
    status !== null &&
    staged.length + pending.length + conflicted.length === 0;

  return (
    <>
      <Screen bar={<RootBar title={t("nav.repo")} />} onRefresh={() => refreshRepo()}>
        {/* Branch, and the two network actions that belong beside it. The chip is the picker: a
            phone has no sidebar to put a branch list in, and "look at what is on the other branch"
            is half of why somebody opens this from away from the desk. */}
        <Section>
          <Card>
            <Row
              leading={<GitBranch size={16} className="text-[var(--cf-text-muted)]" aria-hidden />}
              title={status?.current_branch ?? status?.head_oid?.slice(0, 7) ?? "—"}
              titleClassName="font-medium"
              subtitle={t("branches.current")}
              trailing={
                unpushed.length > 0 ? (
                  <Badge tone="accent">{t("repo.unpushed", { count: unpushed.length })}</Badge>
                ) : undefined
              }
              onClick={() => {
                navigated();
                push({ k: "branches", repoPath });
              }}
            />
            <Divider />
            <div className="grid grid-cols-3 divide-x divide-[var(--cf-divider)]">
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                icon={<RefreshCw size={14} />}
                onClick={() => void run(() => rpc<void>("git_fetch", { repoPath }), "repo", t("toast.fetched"))}
              >
                {t("repo.fetch")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                icon={<ArrowDownToLine size={14} />}
                onClick={() => void run(() => rpc<void>("git_pull", { repoPath }), "repo", t("toast.pulled"))}
              >
                {t("repo.pull")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                icon={<ArrowUpFromLine size={14} />}
                // `setUpstream` is always sent: a branch created on the desktop and pushed for the
                // first time from here would otherwise fail with git's "no upstream" error, which
                // is a thing this UI has no way to let the user fix.
                onClick={() =>
                  void run(
                    () => rpc<void>("git_push", { repoPath, setUpstream: true }),
                    "repo",
                    t("toast.pushed"),
                  )
                }
              >
                {t("repo.push")}
              </Button>
            </div>
          </Card>
        </Section>

        {repoState === "loading" && status === null ? (
          <Section title={t("repo.changes")}>
            <SkeletonList rows={4} />
          </Section>
        ) : repoState === "error" ? (
          /* The retry is the point. `refreshRepo` had no caller in any screen, so a read that failed
             left the user with nothing to press and no way back short of killing the tab. */
          <ErrorState
            title={t("status.repoFailed")}
            detail={error}
            onRetry={() => void refreshRepo()}
          />
        ) : clean ? (
          <EmptyState
            icon={<CheckCheck size={26} aria-hidden />}
            title={t("repo.clean")}
            hint={t("repo.cleanHint")}
          />
        ) : (
          <>
            <Group
              label={t("repo.conflicted")}
              entries={conflicted}
              staged={false}
              repoPath={repoPath}
              tone="danger"
            />
            <Group label={t("repo.staged")} entries={staged} staged repoPath={repoPath} />
            <Group
              label={t("repo.unstaged")}
              entries={pending}
              staged={false}
              repoPath={repoPath}
            />

            <div className="mt-3 flex gap-2">
              <Button
                full
                size="sm"
                disabled={busy || pending.length === 0}
                onClick={() =>
                  void run(() => rpc<void>("stage_all", { repoPath }), "repo", t("toast.staged"))
                }
              >
                {t("repo.stageAll")}
              </Button>
              <Button
                full
                size="sm"
                disabled={busy || staged.length === 0}
                onClick={() =>
                  void run(() => rpc<void>("unstage_all", { repoPath }), "repo", t("toast.unstaged"))
                }
              >
                {t("repo.unstageAll")}
              </Button>
            </div>

            {projectId && <PreCommit repoPath={repoPath} projectId={projectId} />}
          </>
        )}

        {/* Outside the clean/dirty branch on purpose: a clean tree is exactly when the history is
            the only thing on this screen worth reading, and it was the state that used to show a
            single sentence and nothing else. */}
        {repoState !== "error" && <History commits={commits} unpushed={unpushed} />}
      </Screen>

      {staged.length > 0 && <CommitBar repoPath={repoPath} stagedCount={staged.length} />}
    </>
  );
}
