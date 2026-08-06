import { useMemo, useState } from "react";
import { Cloud, GitBranch, Lock, X } from "lucide-react";
import { useRepoStore } from "../../state/repoStore";
import { useT } from "../../state/languageStore";

export function BranchSwitcherModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const branches = useRepoStore((s) => s.branches);
  const checkoutBranch = useRepoStore((s) => s.checkoutBranch);
  const checkoutRemoteBranch = useRepoStore((s) => s.checkoutRemoteBranch);
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return branches.filter((b) => b.name.toLowerCase().includes(q));
  }, [branches, query]);

  const local = filtered.filter((b) => !b.is_remote);
  const remote = filtered.filter((b) => b.is_remote);

  const choose = async (name: string, isRemote: boolean) => {
    if (isRemote) await checkoutRemoteBranch(name);
    else await checkoutBranch(name);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-24"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        // Every row here is a branch name and nothing else, so the width is the number of
        // characters you can tell apart — narrower, `feature/…` rows all truncate to the same text.
        className="flex max-h-[60vh] w-[520px] max-w-[90vw] flex-col overflow-hidden rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] shadow-[var(--cf-shadow)]"
      >
        <div className="flex items-center gap-2 border-b border-[var(--cf-border)] px-3 py-2">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && onClose()}
            placeholder={t("branchModal.search")}
            className="flex-1 bg-transparent text-[13px] outline-none"
          />
          <button onClick={onClose} className="text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]">
            <X size={15} />
          </button>
        </div>

        <div className="flex-1 overflow-auto p-1.5">
          {local.length > 0 && (
            <div className="mb-1">
              <p className="px-2 py-1 text-[11px] font-semibold uppercase text-[var(--cf-text-muted)]">{t("branchModal.local")}</p>
              {local.map((b) => (
                <button
                  key={b.name}
                  onClick={() => choose(b.name, false)}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] ${
                    b.is_head
                      ? "font-semibold text-[var(--cf-accent)]"
                      : "hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
                  }`}
                >
                  <GitBranch size={13} className="shrink-0" />
                  {/* A list stays one row per branch, so this one still truncates — the `title`
                      is what makes the tail of an over-long name reachable. */}
                  <span className="min-w-0 flex-1 truncate" title={b.name}>
                    {b.name}
                  </span>
                  {/* A locked branch reads as locked wherever branches are listed, not only in
                      the sidebar row that owns the toggle. */}
                  {b.is_locked && (
                    <span className="shrink-0 text-[var(--cf-warning)]" title={t("branch.lockedBadge")}>
                      <Lock size={11} />
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}

          {remote.length > 0 && (
            <div>
              <p className="px-2 py-1 text-[11px] font-semibold uppercase text-[var(--cf-text-muted)]">{t("branchModal.remote")}</p>
              {remote.map((b) => (
                <button
                  key={b.name}
                  onClick={() => choose(b.name, true)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-[var(--cf-text-muted)] hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
                >
                  <Cloud size={13} className="shrink-0" />
                  {/* `min-w-0 flex-1` as well as `truncate`: without the floor a flex item won't
                      shrink below its content, so the name overflowed the row instead of eliding. */}
                  <span className="min-w-0 flex-1 truncate" title={b.name}>
                    {b.name}
                  </span>
                </button>
              ))}
            </div>
          )}

          {filtered.length === 0 && (
            <p className="px-2 py-3 text-center text-[12px] text-[var(--cf-text-muted)]">{t("branchModal.noMatches")}</p>
          )}
        </div>
      </div>
    </div>
  );
}
