import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { Check, Minus, Plus } from "lucide-react";
import { t } from "../i18n";
import { rpc } from "../transport";
import { useBusy, useMobileStore } from "../store";
import { onInvalidate } from "../invalidate";
import { PushBar } from "../ui/AppBar";
import { Screen } from "../ui/Screen";
import { Button, IconButton } from "../ui/Button";
import { Badge, ErrorState, Skeleton } from "../ui/Feedback";
import { FileDiff } from "./DiffView";
import type { FileDiffInfo } from "../../types/domain";

/**
 * One file's diff, on a phone.
 *
 * # Context is requested small
 *
 * `contextLines: 3` rather than the desktop's full-file default. The full-file form exists so the
 * split view can reconstruct both sides; nothing here reconstructs anything, and a phone asking for
 * whole files over wifi would pay megabytes to render a screenful.
 *
 * # The text-size control
 *
 * Code is drawn at 11px, which is right for skimming a change on a phone and far too small for
 * reading an unfamiliar function. The page-level pinch zoom is back (see `mobile.html`) but zooming
 * the whole UI to read one hunk is a poor answer, so this screen carries a stepper that scales the
 * code and nothing else. It is remembered, because somebody who needs 15px needs it every time.
 */

const SIZE_KEY = "codeflow.remote.codeSize";
/** In `rem`, matching `--cf-code-size` in `mobile.css`. The floor is the old fixed value. */
const SIZES = [0.6875, 0.75, 0.8125, 0.9375, 1.0625];

function storedSize(): number {
  try {
    const raw = Number(localStorage.getItem(SIZE_KEY));
    return SIZES.includes(raw) ? raw : SIZES[0];
  } catch {
    return SIZES[0];
  }
}

/** How many lines the change adds and removes, so the app bar can say how big it is before the
 *  reader has scrolled a pixel. */
function countLines(diff: FileDiffInfo): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const hunk of diff.hunks) {
    for (const line of hunk.lines) {
      if (line.origin === "+") added += 1;
      else if (line.origin === "-") removed += 1;
    }
  }
  return { added, removed };
}

export function DiffScreen({
  repoPath,
  path,
  staged: openedStaged,
}: {
  repoPath: string;
  path: string;
  staged: boolean;
}) {
  const run = useMobileStore((s) => s.run);
  const busy = useBusy("repo");
  /**
   * Which side of the index this screen is showing.
   *
   * Seeded from the route and then **owned here**, because staging from inside the diff moves the
   * file to the other side. Left keyed to the route, the screen would go on asking for the unstaged
   * diff of a file that is now staged — which is empty — and the reader would watch the change they
   * had just accepted turn into "Nada por aquí". Flipping the view instead keeps the same lines on
   * screen and turns the button into its own undo.
   */
  const [staged, setStaged] = useState(openedStaged);
  const [diff, setDiff] = useState<FileDiffInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** Bumped by the retry button and by an invalidation; the effect's dependency is what re-runs
   *  the read. */
  const [attempt, setAttempt] = useState(0);
  const [size, setSize] = useState(storedSize);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    void rpc<FileDiffInfo | null>("get_file_diff", { repoPath, path, staged, contextLines: 3 })
      .then((result) => {
        if (!alive) return;
        setDiff(result);
        setLoading(false);
      })
      .catch((e) => {
        // Was `alive && setLoading(false)`, which turned every failure into the same "Nada por
        // aquí" the raced-file case shows — so a diff that could not be read was reported as a file
        // with nothing in it. Being unable to see what a change is about, and being told there is
        // nothing to see, are not the same sentence.
        if (!alive) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [repoPath, path, staged, attempt]);

  // The tree moved — an agent finished, somebody committed at the desk, the file was staged from
  // this very screen. A diff nobody re-reads is a photograph presented as a live view.
  useEffect(() => onInvalidate("repo", null, reload), [reload]);

  const step = (direction: 1 | -1) => {
    const index = SIZES.indexOf(size);
    const next = SIZES[Math.min(SIZES.length - 1, Math.max(0, index + direction))];
    setSize(next);
    try {
      localStorage.setItem(SIZE_KEY, String(next));
    } catch {
      /* private browsing; the size lasts as long as the page */
    }
  };

  const stats = diff ? countLines(diff) : null;
  const name = path.split("/").pop() ?? path;
  const folder = path.slice(0, Math.max(0, path.length - name.length - 1));

  return (
    <Screen
      bare
      bar={
        <PushBar
          title={name}
          subtitle={folder || undefined}
          actions={
            <>
              <IconButton
                icon={<Minus size={16} />}
                label={t("diff.smaller")}
                disabled={size === SIZES[0]}
                onClick={() => step(-1)}
              />
              <IconButton
                icon={<Plus size={16} />}
                label={t("diff.bigger")}
                disabled={size === SIZES[SIZES.length - 1]}
                onClick={() => step(1)}
              />
            </>
          }
          below={
            <div className="flex items-center gap-2 border-t border-[var(--cf-divider)] px-3 py-1.5">
              <Badge tone={staged ? "accent" : "neutral"}>
                {staged ? t("diff.staged") : t("diff.unstaged")}
              </Badge>
              {stats && (
                <span className="text-xs tabular-nums">
                  <span className="text-[var(--cf-success-text)]">+{stats.added}</span>{" "}
                  <span className="text-[var(--cf-danger-text)]">−{stats.removed}</span>
                </span>
              )}
              <span className="flex-1" />
              {/* Staging from inside the diff, which is the whole reason to read one on a phone:
                  you opened it because you were not sure, and the answer to "yes, that is right" is
                  a button here rather than a trip back to the list to find the row again. */}
              <Button
                size="sm"
                variant={staged ? "secondary" : "primary"}
                disabled={busy}
                icon={staged ? undefined : <Check size={13} />}
                onClick={() =>
                  void run(
                    async () => {
                      await rpc<void>(staged ? "unstage_file" : "stage_file", {
                        repoPath,
                        filePath: path,
                      });
                      setStaged((v) => !v);
                    },
                    "repo",
                    staged ? t("toast.unstaged") : t("toast.staged"),
                  )
                }
              >
                {staged ? t("repo.unstageThis") : t("repo.stageThis")}
              </Button>
            </div>
          }
        />
      }
    >
      <div style={{ "--cf-code-size": `${size}rem` } as CSSProperties} className="py-2">
        {loading ? (
          <div className="space-y-1.5 px-3 pt-2" role="status" aria-label={t("common.loading")}>
            {/* Skeleton lines of uneven length, because that is what a diff looks like. */}
            {[80, 55, 92, 40, 70, 60, 88, 35].map((width, index) => (
              <Skeleton key={index} className="h-3" style={{ width: `${width}%` }} />
            ))}
          </div>
        ) : error ? (
          <ErrorState title={t("diff.failed")} detail={error} onRetry={reload} />
        ) : !diff ? (
          // No diff at all: the file was staged, discarded or committed between the list being drawn
          // and this being opened. The desktop says the same thing.
          <p className="px-6 pt-10 text-center text-base text-[var(--cf-text-muted)]">
            {t("common.empty")}
          </p>
        ) : (
          <FileDiff diff={diff} />
        )}
      </div>
    </Screen>
  );
}
