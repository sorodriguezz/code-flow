import { useEffect, useMemo, useState } from "react";
import { Check, Cloud, GitBranch, Lock, Plus, Search, X } from "lucide-react";
import { t } from "../i18n";
import { rpc } from "../transport";
import { useBusy, useMobileStore } from "../store";
import { useNav } from "../nav";
import { toastError, toastSuccess } from "../toast";
import { since } from "../time";
import { PushBar } from "../ui/AppBar";
import { Screen } from "../ui/Screen";
import { Button, IconButton } from "../ui/Button";
import { Card, Divider, Row, Section } from "../ui/List";
import { Badge, EmptyState, ErrorState, SkeletonList } from "../ui/Feedback";
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
 * # Why the failure stays on this screen
 *
 * It goes to a toast rather than into the app-wide error slot, and the toast keeps git's own text in
 * its detail line. A checkout failure is about the branch row that was just tapped, and it is long —
 * it names files. The old version wrote it into a banner in a header this screen covered.
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
    <Row
      leading={
        branch.is_remote ? (
          <Cloud size={15} className="text-[var(--cf-text-muted)]" aria-hidden />
        ) : (
          <GitBranch
            size={15}
            className={branch.is_head ? "text-[var(--cf-accent)]" : "text-[var(--cf-text-muted)]"}
            aria-hidden
          />
        )
      }
      title={branch.name}
      titleClassName={branch.is_head ? "font-semibold" : ""}
      subtitle={branch.tip_time ? since(branch.tip_time) : undefined}
      chevron={false}
      trailing={
        <span className="flex shrink-0 items-center gap-1.5">
          {branch.is_locked && (
            <Badge tone="warning" icon={<Lock size={9} aria-hidden />}>
              {t("branches.locked")}
            </Badge>
          )}
          {/* Ahead/behind only when there is something to say. A branch level with its upstream is
              the normal case and does not need two zeroes next to it. */}
          {(branch.ahead > 0 || branch.behind > 0) && (
            <span className="font-mono text-2xs tabular-nums text-[var(--cf-text-muted)]">
              ↑{branch.ahead} ↓{branch.behind}
            </span>
          )}
          {branch.is_head && <Check size={16} className="text-[var(--cf-accent)]" aria-hidden />}
        </span>
      }
      disabled={disabled || branch.is_head}
      onClick={onPick}
    />
  );
}

export function BranchScreen({ repoPath }: { repoPath: string }) {
  const run = useMobileStore((s) => s.run);
  const refreshRepo = useMobileStore((s) => s.refreshRepo);
  const back = useNav((s) => s.back);
  // `repo`, shared with commit/push/stage rather than given a group of its own: a checkout and a
  // commit both write the same working tree, and those two genuinely should wait for each other.
  const busy = useBusy("repo");
  const [branches, setBranches] = useState<BranchInfo[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [readFailed, setReadFailed] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setReadFailed(null);
    void rpc<BranchInfo[]>("list_branches", { repoPath })
      .then((result) => {
        if (!alive) return;
        setBranches(result);
        setLoading(false);
      })
      .catch((e) => {
        if (!alive) return;
        setReadFailed(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [repoPath, attempt]);

  /**
   * Runs one branch action, reporting its failure without leaving the screen.
   *
   * Deliberately does not go through `run`'s own toast: the message git returns here is long and
   * names files, and it belongs in the detail line under a sentence rather than as the sentence.
   */
  const attemptAction = (action: () => Promise<unknown>, success: string) => {
    // Which screen this action belongs to, captured before anything is awaited. A checkout plus a
    // status read is comfortably a second on a large repository over home wifi, and nothing stops
    // the user going back and opening a diff in the meantime — at which point the `back()` below
    // would close *that* instead. Same capture-before-await guard the store's loads use.
    const opened = useNav.getState().top();
    void run(async () => {
      try {
        await action();
        // The watcher will emit for the files that changed, but not for HEAD moving on its own — a
        // branch switch between two identical trees touches nothing the watcher looks at. Reading
        // the status back is what makes the chip show the branch you just chose.
        await refreshRepo();
        toastSuccess(success);
        if (useNav.getState().top() === opened) back();
      } catch (e) {
        toastError(t("error.actionFailed"), plainError(e instanceof Error ? e.message : String(e)));
      }
    }, "repo");
  };

  const checkout = (branch: BranchInfo) =>
    attemptAction(
      () =>
        branch.is_remote
          ? // Creates the local branch tracking it (or reuses one) and switches to it — the same
            // "connect to this branch" the desktop does. A plain `checkout_local_branch` cannot: the
            // name it would be given (`origin/foo`) is not a local branch.
            rpc<string>("checkout_remote_tracking", { repoPath, remoteBranch: branch.name })
          : rpc<void>("checkout_local_branch", { repoPath, name: branch.name }),
      t("toast.checkedOut", { branch: branch.name }),
    );

  // `create_branch` creates and does **not** switch — so the two calls are chained here rather than
  // leaving somebody on the old branch wondering why the chip did not change.
  const createAndCheckout = () => {
    const name = newName.trim();
    if (!name) return;
    attemptAction(async () => {
      await rpc<void>("create_branch", { repoPath, name, startPoint: null });
      await rpc<void>("checkout_local_branch", { repoPath, name });
      setNewName("");
      setCreating(false);
    }, t("toast.branchCreated", { branch: name }));
  };

  const { local, remote } = useMemo(() => {
    const all = branches ?? [];
    const needle = query.trim().toLowerCase();
    const matches = (b: BranchInfo) => !needle || b.name.toLowerCase().includes(needle);
    const localBranches = all.filter((b) => !b.is_remote);
    return {
      local: localBranches.filter(matches),
      // Remote-tracking refs whose branch already exists locally are dropped: the same branch listed
      // twice, once with a cloud icon, reads as two places to go and one of them is a longer route
      // to the other.
      remote: all.filter(
        (b) => b.is_remote && !localBranches.some((l) => b.name.endsWith(`/${l.name}`)) && matches(b),
      ),
    };
  }, [branches, query]);

  const total = (branches ?? []).length;

  return (
    <Screen
      bar={
        <PushBar
          title={t("branches.title")}
          actions={
            !creating ? (
              <IconButton
                icon={<Plus size={18} />}
                label={t("branches.new")}
                tone="accent"
                disabled={busy}
                onClick={() => setCreating(true)}
              />
            ) : undefined
          }
        />
      }
      onRefresh={() => setAttempt((n) => n + 1)}
    >
      {creating && (
        <Card padded raised className="mt-3">
          <label htmlFor="cf-new-branch" className="text-xs font-semibold text-[var(--cf-text-faint)]">
            {t("branches.new")}
          </label>
          <input
            id="cf-new-branch"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder={t("branches.newPlaceholder")}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            autoFocus
            className="mt-1 w-full rounded-lg border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-3 py-2.5 outline-none focus:border-[var(--cf-accent)]"
          />
          <div className="mt-2 flex gap-2">
            <Button full size="sm" onClick={() => setCreating(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              full
              size="sm"
              variant="primary"
              loading={busy}
              disabled={newName.trim().length === 0}
              onClick={createAndCheckout}
            >
              {t("branches.create")}
            </Button>
          </div>
        </Card>
      )}

      {/* A search box, once there are enough branches for the list to be a scroll rather than a
          glance. A repository with eight branches does not need one; the ones people actually use a
          phone against have sixty. */}
      {total > 8 && (
        <div className="relative mt-3">
          <Search
            size={15}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--cf-text-faint)]"
            aria-hidden
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("branches.search")}
            aria-label={t("branches.search")}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="w-full rounded-lg border border-[var(--cf-field-border)] bg-[var(--cf-field)] py-2.5 pl-9 pr-9 outline-none focus:border-[var(--cf-accent)]"
          />
          {query && (
            <button
              type="button"
              aria-label={t("common.dismiss")}
              onClick={() => setQuery("")}
              className="absolute right-1 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center text-[var(--cf-text-faint)]"
            >
              <X size={15} aria-hidden />
            </button>
          )}
        </div>
      )}

      {loading ? (
        <Section title={t("branches.local")}>
          <SkeletonList rows={5} />
        </Section>
      ) : readFailed ? (
        <ErrorState
          title={t("common.empty")}
          detail={readFailed}
          onRetry={() => setAttempt((n) => n + 1)}
        />
      ) : local.length === 0 && remote.length === 0 ? (
        <EmptyState icon={<GitBranch size={26} aria-hidden />} title={t("branches.noMatch")} />
      ) : (
        <>
          {local.length > 0 && (
            <Section title={t("branches.local")}>
              <Card>
                {local.map((branch, index) => (
                  <div key={branch.name}>
                    {index > 0 && <Divider inset />}
                    <BranchRow branch={branch} disabled={busy} onPick={() => checkout(branch)} />
                  </div>
                ))}
              </Card>
            </Section>
          )}
          {remote.length > 0 && (
            <Section title={t("branches.remote")}>
              <Card>
                {remote.map((branch, index) => (
                  <div key={branch.name}>
                    {index > 0 && <Divider inset />}
                    <BranchRow branch={branch} disabled={busy} onPick={() => checkout(branch)} />
                  </div>
                ))}
              </Card>
            </Section>
          )}
        </>
      )}
    </Screen>
  );
}
