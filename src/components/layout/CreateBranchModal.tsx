import { useEffect, useState } from "react";
import { Check, Cloud, GitBranch, GitCommitHorizontal, Loader2 } from "lucide-react";
import { useRepoStore } from "../../state/repoStore";
import { useT } from "../../state/languageStore";
import { Select } from "../common/Select";
import { ConfirmFlowDiagram } from "../common/ConfirmFlowDiagram";
import type { BranchInfo } from "../../types/domain";

/**
 * Creating a branch, in the same shape as every other branch operation: a modal with the diagram
 * of what is about to happen. It replaces a form that unfolded inside the sidebar section, where
 * it pushed the branch list down and had no room to say where the branch would start from.
 *
 * The diagram updates as you type, so the start point and the new name are visible together —
 * which is the pair that's easy to get wrong.
 */
export function CreateBranchModal({ branches, onClose }: { branches: BranchInfo[]; onClose: () => void }) {
  const createBranch = useRepoStore((s) => s.createBranch);
  const status = useRepoStore((s) => s.status);
  const [name, setName] = useState("");
  const [startPoint, setStartPoint] = useState("");
  const [creating, setCreating] = useState(false);
  const t = useT();

  // An empty start point means "wherever HEAD is", which the diagram has to name rather than
  // leave blank — including when HEAD is detached and there's no branch name to use.
  const headLabel =
    status?.current_branch ??
    (status?.is_detached
      ? `${t("statusbar.detachedHead")} ${status.head_oid?.slice(0, 7) ?? ""}`.trim()
      : t("sidebar.fromCurrentHead"));
  const source = startPoint || headLabel;
  const trimmed = name.trim();

  const submit = async () => {
    if (!trimmed || creating) return;
    setCreating(true);
    try {
      await createBranch(trimmed, startPoint || undefined);
      onClose();
    } finally {
      setCreating(false);
    }
  };

  // Escape on the window rather than on the dialog: the dialog itself isn't focusable, so once you
  // click the diagram or the backdrop, a key handler bound to it would never hear anything again.
  // Enter stays on the name field, where it can't collide with the start-point select using Enter
  // to pick an option.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !creating) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [creating, onClose]);

  return (
    // No backdrop click-to-close: this one holds a half-typed branch name, and losing it to a
    // stray click outside is not a trade worth making. Escape and Cancel are the ways out.
    // Centred, like every other dialog in this family, with the height capped so a short window
    // scrolls the dialog's own content instead of pushing its buttons off screen.
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      <div className="cf-fade-in max-h-[calc(100vh-2rem)] w-[460px] max-w-[90vw] overflow-y-auto rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-4 shadow-[var(--cf-shadow)]">
        <h3 className="mb-3 text-[13px] font-semibold">{t("branch.createModalTitle")}</h3>

        <label className="mb-1 block text-[11px] font-medium text-[var(--cf-text-muted)]">
          {t("sidebar.newBranchName")}
        </label>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void submit()}
          placeholder={t("sidebar.newBranchName")}
          className="mb-3 w-full rounded-md border border-[var(--cf-border)] bg-transparent px-2 py-1.5 font-mono text-[12px] outline-none focus:border-[var(--cf-accent)]"
        />

        <label className="mb-1 block text-[11px] font-medium text-[var(--cf-text-muted)]">
          {t("branch.createStartPoint")}
        </label>
        <div className="mb-4">
          <Select
            value={startPoint}
            onChange={setStartPoint}
            ariaLabel={t("branch.createStartPoint")}
            // The same two icons the sidebar labels its "local branches" and "remote branches"
            // sections with, so a name like `origin/main` is placed by its icon rather than by
            // whether you can still see which group heading you scrolled past. HEAD keeps the
            // commit icon the diagram below uses for the start point.
            options={[
              { value: "", label: t("sidebar.fromCurrentHead"), icon: GitCommitHorizontal },
              {
                label: t("sidebar.local"),
                options: branches
                  .filter((b) => !b.is_remote)
                  .map((b) => ({ value: b.name, label: b.name, icon: GitBranch })),
              },
              {
                label: t("sidebar.remote"),
                options: branches
                  .filter((b) => b.is_remote)
                  .map((b) => ({ value: b.name, label: b.name, icon: Cloud })),
              },
            ]}
          />
        </div>

        <ConfirmFlowDiagram
          flow={{
            kind: "branch-create",
            source,
            target: trimmed || t("branch.createTargetPlaceholder"),
            note: t("confirm.createBranchNote", { source }),
          }}
        />

        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-[12px] text-[var(--cf-text-muted)] hover:bg-black/[0.05] dark:hover:bg-white/[0.08]"
          >
            {t("common.cancel")}
          </button>
          <button
            onClick={submit}
            disabled={!trimmed || creating}
            className="flex items-center gap-1.5 rounded-md bg-[var(--cf-accent)] px-3 py-1.5 text-[12px] font-medium text-white hover:brightness-110 disabled:opacity-40"
          >
            {creating ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
            {t("sidebar.create")}
          </button>
        </div>
      </div>
    </div>
  );
}
