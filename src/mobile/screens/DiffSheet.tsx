import { useEffect, useState } from "react";
import { ChevronLeft, Loader2 } from "lucide-react";
import { t } from "../i18n";
import { rpc } from "../transport";
import { FileDiff } from "./DiffView";
import type { FileDiffInfo } from "../../types/domain";

/**
 * One file's diff, on a phone.
 *
 * The rendering lives in `DiffView` — this is the sheet around it: the read, its three failure
 * states, and a way back.
 *
 * # Context is requested small
 *
 * `contextLines: 3` rather than the desktop's full-file default. The full-file form exists so the
 * split view can reconstruct both sides; nothing here reconstructs anything, and a phone asking for
 * whole files over wifi would pay megabytes to render a screenful. The argument was being sent long
 * before anything read it — `get_file_diff` had no context parameter at all — so every diff opened
 * on a phone was the whole file until now.
 */

export function DiffSheet({
  repoPath,
  path,
  staged,
  onClose,
}: {
  repoPath: string;
  path: string;
  staged: boolean;
  onClose: () => void;
}) {
  const [diff, setDiff] = useState<FileDiffInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** Bumped by the retry button; the effect's dependency is what re-runs the read. */
  const [attempt, setAttempt] = useState(0);

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
        setError(String(e));
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [repoPath, path, staged, attempt]);

  return (
    <div className="fixed inset-0 z-30 flex flex-col bg-[var(--cf-bg)]">
      <div className="cf-safe-top flex shrink-0 items-center gap-1 border-b border-[var(--cf-border)] px-1 py-1.5">
        <button type="button" onClick={onClose} className="cf-tap flex items-center px-2">
          <ChevronLeft size={18} />
        </button>
        {/* `rtl` so the filename survives truncation and the directory is what gets cut. */}
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium" style={{ direction: "rtl" }}>
          <bdi>{path}</bdi>
        </span>
      </div>

      <div className="cf-scroll flex-1 py-2">
        {loading ? (
          <Loader2 size={16} className="mx-auto mt-6 animate-spin text-[var(--cf-text-muted)]" />
        ) : error ? (
          <div className="mt-6 flex flex-col items-center gap-2 px-6 text-center">
            <p className="text-[13px] text-[var(--cf-text-muted)]">{t("diff.failed")}</p>
            <p className="break-words font-mono text-[11px] text-[var(--cf-text-muted)]">{error}</p>
            <button
              type="button"
              onClick={() => setAttempt((n) => n + 1)}
              className="cf-tap rounded-lg border border-[var(--cf-border)] px-4 text-[13px]"
            >
              {t("common.retry")}
            </button>
          </div>
        ) : !diff ? (
          // No diff at all: the file was staged, discarded or committed between the list being drawn
          // and this being opened. The desktop says the same thing.
          <p className="mt-6 text-center text-[13px] text-[var(--cf-text-muted)]">{t("common.empty")}</p>
        ) : (
          <FileDiff diff={diff} />
        )}
      </div>
    </div>
  );
}
