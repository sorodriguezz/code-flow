import { useEffect, useState } from "react";
import { Check, ChevronLeft, Cloud, GitBranch, Loader2, Plus } from "lucide-react";
import { t } from "../i18n";
import { rpc } from "../transport";
import { useBusy, useMobileStore } from "../store";
import type { BranchInfo } from "../../types/domain";

/**
 * Switching branch, from a phone.
 *
 * # Why the failure text is shown raw
 *
 * A checkout fails for one reason far more often than any other: uncommitted work in the tree that
 * the switch would clobber. The desktop answers that by offering to stash — and **there is no stash
 * command in the remote allowlist**, deliberately, so this client has nothing to offer. The one
 * useful thing left is to say exactly what git said, which at least names the files. Rewriting it
 * into "no se pudo cambiar de rama" would take away the only information in the sentence.
 *
 * The internal markers are the exception: `CHECKOUT_CONFLICT:` and `BRANCH_LOCKED:` are prefixes the
 * backend adds *for a UI to key on*, and neither of the UIs they were written for exists here. They
 * are stripped so the user reads git's message, not this app's routing tag.
 *
 * # Why the failure is held here and not in the store
 *
 * This sheet covers the header, and the header is where `store.error` is drawn. An error written
 * there would be invisible while it mattered and stale by the time it was not.
 */

/** Prefixes the backend adds so a frontend can offer a specific remedy — see `git/branch.rs`. */
const MARKERS = ["CHECKOUT_CONFLICT: ", "BRANCH_LOCKED: "];

function plainError(message: string): string {
  const marker = MARKERS.find((prefix) => message.startsWith(prefix));
  return marker ? message.slice(marker.length) : message;
}

function BranchRow({
  branch,
  disabled,
  onPick,
}: {
  branch: BranchInfo;
  disabled: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled || branch.is_head}
      onClick={onPick}
      className="cf-tap flex w-full items-center gap-2 px-3 py-2.5 text-left disabled:opacity-60"
    >
      {branch.is_remote ? (
        <Cloud size={13} className="shrink-0 text-[var(--cf-text-muted)]" />
      ) : (
        <GitBranch size={13} className="shrink-0 text-[var(--cf-text-muted)]" />
      )}
      <span className="min-w-0 flex-1 truncate text-[13px]">{branch.name}</span>
      {/* Ahead/behind only when there is something to say. A branch level with its upstream is the
          normal case and does not need two zeroes next to it. */}
      {(branch.ahead > 0 || branch.behind > 0) && (
        <span className="shrink-0 font-mono text-[10px] text-[var(--cf-text-muted)]">
          ↑{branch.ahead} ↓{branch.behind}
        </span>
      )}
      {branch.is_head && <Check size={14} className="shrink-0 text-[var(--cf-accent)]" />}
    </button>
  );
}

export function BranchSheet({ repoPath, onClose }: { repoPath: string; onClose: () => void }) {
  const { run, refreshRepo } = useMobileStore();
  // `repo`, shared with commit/push/stage rather than given a group of its own: a checkout and a
  // commit both write the same working tree, and those two genuinely should wait for each other.
  const busy = useBusy("repo");
  const [branches, setBranches] = useState<BranchInfo[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let alive = true;
    void rpc<BranchInfo[]>("list_branches", { repoPath })
      .then((result) => {
        if (!alive) return;
        setBranches(result);
        setLoading(false);
      })
      .catch((e) => {
        if (!alive) return;
        setFailure(String(e));
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [repoPath]);

  /**
   * Runs one branch action, keeping its failure on this screen.
   *
   * Deliberately does not rethrow into `run`: `run` would file the message in `store.error`, which
   * is drawn under this sheet. The busy flag is still worth taking — it is what stops a checkout
   * from racing a commit started on another tab.
   */
  const attempt = (action: () => Promise<unknown>) => {
    setFailure(null);
    void run(async () => {
      try {
        await action();
        // The watcher will emit for the files that changed, but not for HEAD moving on its own — a
        // branch switch between two identical trees touches nothing the watcher looks at. Reading
        // the status back is what makes the chip show the branch you just chose.
        await refreshRepo();
        onClose();
      } catch (e) {
        setFailure(plainError(String(e)));
      }
    }, "repo");
  };

  const checkout = (branch: BranchInfo) =>
    attempt(() =>
      branch.is_remote
        ? // Creates the local branch tracking it (or reuses one) and switches to it — the same
          // "connect to this branch" the desktop does. A plain `checkout_local_branch` cannot: the
          // name it would be given (`origin/foo`) is not a local branch.
          rpc<string>("checkout_remote_tracking", { repoPath, remoteBranch: branch.name })
        : rpc<void>("checkout_local_branch", { repoPath, name: branch.name }),
    );

  // `create_branch` creates and does **not** switch — so the two calls are chained here rather than
  // leaving somebody on the old branch wondering why the chip did not change.
  const createAndCheckout = () => {
    const name = newName.trim();
    if (!name) return;
    attempt(async () => {
      await rpc<void>("create_branch", { repoPath, name, startPoint: null });
      await rpc<void>("checkout_local_branch", { repoPath, name });
      setNewName("");
      setCreating(false);
    });
  };

  const local = (branches ?? []).filter((b) => !b.is_remote);
  // Remote-tracking refs whose branch already exists locally are dropped: the same branch listed
  // twice, once with a cloud icon, reads as two places to go and one of them is a longer route to
  // the other.
  const remote = (branches ?? []).filter(
    (b) => b.is_remote && !local.some((l) => b.name.endsWith(`/${l.name}`)),
  );

  return (
    <div className="fixed inset-0 z-30 flex flex-col bg-[var(--cf-bg)]">
      <div className="cf-safe-top flex shrink-0 items-center gap-1 border-b border-[var(--cf-border)] px-1 py-1.5">
        <button type="button" onClick={onClose} className="cf-tap flex items-center px-2">
          <ChevronLeft size={18} />
        </button>
        <span className="min-w-0 flex-1 truncate text-[14px] font-medium">{t("branches.title")}</span>
      </div>

      <div className="cf-scroll flex-1 px-3 pb-6">
        {failure && (
          <p className="mt-3 break-words rounded-lg border border-[var(--cf-danger)]/40 px-3 py-2 font-mono text-[11px] text-[var(--cf-danger)]">
            {failure}
          </p>
        )}

        {creating ? (
          <div className="mt-3 rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface)] p-3">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder={t("branches.newPlaceholder")}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className="w-full rounded-lg border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-3 py-2 text-[13px] outline-none focus:border-[var(--cf-accent)]"
            />
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={() => setCreating(false)}
                className="cf-tap flex-1 rounded-lg border border-[var(--cf-border)] text-[13px]"
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                disabled={busy || newName.trim().length === 0}
                onClick={createAndCheckout}
                className="cf-tap flex-1 rounded-lg bg-[var(--cf-accent)] text-[13px] font-medium text-white disabled:opacity-40"
              >
                {t("branches.create")}
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => setCreating(true)}
            className="cf-tap mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface)] text-[13px] disabled:opacity-40"
          >
            <Plus size={13} /> {t("branches.new")}
          </button>
        )}

        {loading ? (
          <Loader2 size={16} className="mx-auto mt-6 animate-spin text-[var(--cf-text-muted)]" />
        ) : (
          <>
            {local.length > 0 && (
              <>
                <p className="mt-4 px-1 text-[11px] font-medium uppercase tracking-wide text-[var(--cf-text-muted)]">
                  {t("branches.local")}
                </p>
                <div className="mt-1 divide-y divide-[var(--cf-border)] overflow-hidden rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface)]">
                  {local.map((branch) => (
                    <BranchRow
                      key={branch.name}
                      branch={branch}
                      disabled={busy}
                      onPick={() => checkout(branch)}
                    />
                  ))}
                </div>
              </>
            )}
            {remote.length > 0 && (
              <>
                <p className="mt-4 px-1 text-[11px] font-medium uppercase tracking-wide text-[var(--cf-text-muted)]">
                  {t("branches.remote")}
                </p>
                <div className="mt-1 divide-y divide-[var(--cf-border)] overflow-hidden rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface)]">
                  {remote.map((branch) => (
                    <BranchRow
                      key={branch.name}
                      branch={branch}
                      disabled={busy}
                      onPick={() => checkout(branch)}
                    />
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
