import { CloudUpload, Download, Loader2, RefreshCw, Upload } from "lucide-react";
import { useRepoStore } from "../../state/repoStore";
import { useFetchTimerStore } from "../../state/fetchTimerStore";
import { useT } from "../../state/languageStore";
import { canPublish, canPull, canPush, fetchNow, pullNow, pushNow } from "../../lib/gitActions";
import { useShortcutHint } from "../../lib/useShortcutHint";

/**
 * Fetch, pull and push — the three things you do to a repository's remote — as one control.
 *
 * # Why it is not part of the status bar any more
 *
 * It was, and that made it main-window-only: `StatusBar` also carries the notification bell, the
 * agent pill, the meters and the settings button, so a satellite could not render it without
 * pulling the whole shell into a bundle that exists to exclude it. The result was a detached
 * repository window with four working tabs and no way to reach its remote at all — you had to go
 * back to the main window, select that repository there, and press fetch, which is the round trip
 * detaching it was supposed to remove.
 *
 * So it lives here, importing nothing but `repoStore` and `lib/gitActions`, both of which a
 * satellite already has. One component in two windows rather than two that agree by hand: these
 * buttons' disabled states are the same rules the keyboard shortcuts use, and a second copy is a
 * second place for them to drift.
 *
 * # The three are `repoStore`, and `repoStore` is per window
 *
 * Nothing here is main-only in the way the schedulers are. A satellite holds its own `repoStore`
 * pointed at its own repository, and `api.gitFetch` is a Rust call from whichever webview makes it
 * — so the work runs where it was asked for, against the right working copy. What a satellite does
 * *not* have is the auto-fetch timer, which is main's alone: `remainingSeconds` is then null and
 * the countdown simply is not drawn.
 */

/**
 * One of the three buttons.
 *
 * The same button three times over, deliberately. Push used to be a filled accent pill next to two
 * quiet text buttons, which read as "push is the thing to press" on a bar where the thing to press
 * is whichever one has work waiting — and that is what the counter now says, so the styling no
 * longer has to guess.
 *
 * No labels: this control is always on screen and the repository name next to it is never
 * truncated, so every word dropped here is width the branch name gets back. The tooltip carries
 * what the label used to say, plus how much there is to move — and the count also sits next to the
 * glyph, quietly, so the common question ("anything to pull?") is answered without hovering at all.
 */
function GitAction({
  icon,
  title,
  count,
  countdown,
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  /** Commits waiting, or 0 for an action that has nothing to count (fetch, publish). */
  count?: number;
  /** Seconds until the automatic fetch, for the one button that has a clock instead of a count. */
  countdown?: number | null;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className="flex h-6 min-w-6 shrink-0 items-center justify-center gap-0.5 rounded-md px-1 text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-[var(--cf-text-muted)] dark:disabled:hover:bg-transparent"
    >
      {icon}
      {/* The count as a digit beside the glyph, in the button's own colour — not a badge. A filled
          accent pip is what an app uses to say "come here now", and a branch being two commits
          behind is not that: it is a fact you read in passing, alongside the two buttons that have
          nothing to report. Inheriting the text colour is also what keeps the three homologated —
          the number brightens with the icon on hover instead of shouting on its own.

          Clamped at 99: past a hundred commits the exact number changes nothing about what you do
          next, and three digits would push the row around. */}
      {count !== undefined && count > 0 && (
        <span className="text-[10.5px] font-semibold leading-none tabular-nums">
          {count > 99 ? "99+" : count}
        </span>
      )}
      {/* The auto-fetch clock, a size below the commit counts: it is the one number here that is
          always running, and at the counts' weight a ticking digit would pull the eye across the
          bar once a second. Fixed width and right-aligned so `60s` shrinking to `9s` moves nothing
          around it — a control that shuffles its neighbours every ten seconds is unclickable. */}
      {countdown !== undefined && countdown !== null && (
        <span className="w-[17px] shrink-0 text-right text-[10.5px] font-medium leading-none tabular-nums">
          {countdown}s
        </span>
      )}
    </button>
  );
}

export function RemoteActions() {
  const branches = useRepoStore((s) => s.branches);
  const remoteOp = useRepoStore((s) => s.remoteOp);
  const remainingSeconds = useFetchTimerStore((s) => s.remainingSeconds);
  const t = useT();
  const hint = useShortcutHint();

  const current = branches.find((b) => b.is_head);
  const behind = current?.behind ?? 0;
  const ahead = current?.ahead ?? 0;
  // Availability comes from `lib/gitActions` so these buttons and the keyboard shortcuts that do
  // the same thing can't disagree about when there's nothing to do.
  const pullEnabled = canPull(current);
  const pushEnabled = canPush(current);
  const publishable = canPublish(current);
  /** "3 commits to pull" — the count spelled out for the tooltip, singular where it matters. */
  const commits = (n: number, one: "statusbar.commitToPull" | "statusbar.commitToPush") =>
    n === 1
      ? t(one)
      : t(one === "statusbar.commitToPull" ? "statusbar.commitsToPull" : "statusbar.commitsToPush", {
          n: String(n),
        });

  return (
    /* Tighter than the bar around it: three buttons that do neighbouring things read as one
       control. */
    <div data-tour="git-actions" className="flex shrink-0 items-center gap-0.5">
      <GitAction
        icon={
          remoteOp === "fetch" ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />
        }
        title={
          remainingSeconds !== null
            ? `${hint("git.fetch", t("statusbar.fetch"))} · ${t("statusbar.nextFetch", { n: remainingSeconds })}`
            : hint("git.fetch", t("statusbar.fetch"))
        }
        countdown={remainingSeconds}
        disabled={remoteOp !== null}
        onClick={fetchNow}
      />

      {publishable ? (
        <GitAction
          icon={
            remoteOp === "push" ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <CloudUpload size={13} />
            )
          }
          title={hint("git.push", t("statusbar.publishTo"))}
          disabled={remoteOp !== null}
          onClick={pushNow}
        />
      ) : (
        <>
          <GitAction
            icon={
              remoteOp === "pull" ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <Download size={13} />
              )
            }
            title={
              pullEnabled
                ? `${hint("git.pull", t("statusbar.pullFrom"))} · ${commits(behind, "statusbar.commitToPull")}`
                : t("statusbar.nothingToPull")
            }
            count={behind}
            disabled={remoteOp !== null || !pullEnabled}
            onClick={pullNow}
          />
          <GitAction
            icon={
              remoteOp === "push" ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <Upload size={13} />
              )
            }
            // A locked branch is a different reason for the same greyed-out button, and
            // "nothing to push" would be the wrong explanation for it.
            title={
              pushEnabled
                ? `${hint("git.push", t("statusbar.pushTo"))} · ${commits(ahead, "statusbar.commitToPush")}`
                : current?.is_locked
                  ? t("branch.lockedCannotPush", { name: current.name })
                  : t("statusbar.nothingToPush")
            }
            count={ahead}
            disabled={remoteOp !== null || !pushEnabled}
            onClick={pushNow}
          />
        </>
      )}
    </div>
  );
}
