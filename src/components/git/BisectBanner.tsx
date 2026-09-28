import { Bug, Check, Loader2, SkipForward, X } from "lucide-react";
import { useGitToolsStore } from "../../state/gitToolsStore";
import { useRepoStore } from "../../state/repoStore";
import { useT } from "../../state/languageStore";
import { buttonClass } from "../common/Button";

/**
 * The bar over the graph while a bisect runs: which commit is under test, how much of the range is
 * left, and the verdicts. The search itself is git's (`git bisect`, see `git/bisect.rs`); a verdict
 * here checks the next candidate out, and the graph marks it.
 *
 * Before both ends are known it asks for the missing one — marked from a commit's context menu —
 * and once the range is down to one commit it names it and offers only the way out.
 */
export function BisectBanner() {
  const bisect = useGitToolsStore((s) => s.bisect);
  const pending = useGitToolsStore((s) => s.pending);
  const mark = useGitToolsStore((s) => s.bisectMark);
  const reset = useGitToolsStore((s) => s.bisectReset);
  const commits = useRepoStore((s) => s.commits);
  const selectCommit = useRepoStore((s) => s.selectCommit);
  const t = useT();
  if (!bisect?.active) return null;

  const busy = pending === "bisect";
  const summaryOf = (id: string | null) => (id ? commits.find((c) => c.id === id)?.summary ?? "" : "");

  let text: string;
  if (bisect.first_bad) {
    text = t("bisect.found", { sha: bisect.first_bad.slice(0, 7), summary: summaryOf(bisect.first_bad) });
  } else if (!bisect.bad) {
    text = t("bisect.needBad");
  } else if (bisect.good.length === 0) {
    text = t("bisect.needGood");
  } else {
    text = t("bisect.testing", {
      sha: bisect.candidate?.slice(0, 7) ?? "?",
      left: String(Math.max(0, bisect.remaining - 1)),
      steps: String(bisect.steps),
    });
  }
  const focus = bisect.first_bad ?? bisect.candidate;

  return (
    <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-2 border-b border-[var(--cf-border)] bg-[color-mix(in_oklab,var(--cf-warning)_10%,var(--cf-surface))] px-3 py-1.5">
      <Bug size={14} className="shrink-0 text-[var(--cf-warning)]" />
      <button
        type="button"
        disabled={!focus}
        onClick={() => focus && void selectCommit(focus)}
        className="min-w-0 flex-1 truncate text-left text-[12px] text-[var(--cf-text)]"
        title={t("bisect.hint")}
      >
        {text}
      </button>
      {busy && <Loader2 size={13} className="animate-spin text-[var(--cf-text-muted)]" />}
      {bisect.candidate && !bisect.first_bad && (
        <>
          <button
            type="button"
            disabled={busy}
            onClick={() => void mark("good")}
            className={buttonClass({ variant: "secondary", size: "sm" })}
          >
            <Check size={12} />
            {t("bisect.good")}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void mark("bad")}
            className={buttonClass({ variant: "secondary", size: "sm" })}
          >
            <Bug size={12} />
            {t("bisect.bad")}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void mark("skip")}
            title={t("bisect.skipHint")}
            className={buttonClass({ variant: "ghost", size: "sm" })}
          >
            <SkipForward size={12} />
            {t("bisect.skip")}
          </button>
        </>
      )}
      <button
        type="button"
        disabled={busy}
        onClick={() => void reset()}
        title={t("bisect.resetHint")}
        className={buttonClass({ variant: "ghost", size: "sm" })}
      >
        <X size={12} />
        {t("bisect.reset")}
      </button>
    </div>
  );
}
