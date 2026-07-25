import { useEffect, useMemo, useState } from "react";
import { GitPullRequest, Loader2, Sparkles, X } from "lucide-react";
import { listBranches, generatePrDescription } from "../../lib/tauri/commands";
import { usePrStore } from "../../state/prStore";
import { pushErrorToast } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import type { BranchInfo, Project } from "../../types/domain";

const PREFERRED_TARGETS = ["main", "master", "develop", "development"];

interface CreatePrModalProps {
  project: Project;
  onClose: () => void;
  onCreated: () => void;
}

/**
 * Opens a pull request on the project's linked host. Branches are read straight from the repo on
 * disk (so it works for any linked project, not only the active one); "Generate with AI" drafts a
 * title + description from the diff between the chosen branches and prefills the form.
 */
export function CreatePrModal({ project, onClose, onCreated }: CreatePrModalProps) {
  const t = useT();
  const createPr = usePrStore((s) => s.createPr);

  const [branches, setBranches] = useState<BranchInfo[] | null>(null);
  const [source, setSource] = useState("");
  const [target, setTarget] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [draft, setDraft] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [creating, setCreating] = useState(false);

  const localBranches = useMemo(() => (branches ?? []).filter((b) => !b.is_remote), [branches]);

  useEffect(() => {
    let cancelled = false;
    void listBranches(project.local_path)
      .then((list) => {
        if (cancelled) return;
        setBranches(list);
        const local = list.filter((b) => !b.is_remote);
        const head = local.find((b) => b.is_head);
        const src = head?.name ?? local[0]?.name ?? "";
        const tgt =
          local.find((b) => PREFERRED_TARGETS.includes(b.name) && b.name !== src)?.name ??
          local.find((b) => b.name !== src)?.name ??
          "";
        setSource(src);
        setTarget(tgt);
      })
      .catch((e) => {
        if (!cancelled) {
          setBranches([]);
          pushErrorToast(String(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [project.local_path]);

  const sameBranch = source !== "" && source === target;
  const canSubmit = !creating && !generating && title.trim() !== "" && source !== "" && target !== "" && !sameBranch;
  const busy = creating || generating;

  const generate = async () => {
    if (!source || !target || sameBranch) return;
    setGenerating(true);
    try {
      const draftText = await generatePrDescription(project.id, source, target);
      if (draftText.title.trim()) setTitle(draftText.title.trim());
      setDescription(draftText.body);
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setGenerating(false);
    }
  };

  const submit = async () => {
    if (!canSubmit) return;
    setCreating(true);
    try {
      await createPr(project.id, {
        title: title.trim(),
        description,
        sourceBranch: source,
        targetBranch: target,
        draft,
      });
      onCreated();
      onClose();
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-16" onClick={busy ? undefined : onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[520px] max-w-[92vw] rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-4 shadow-[var(--cf-shadow)]"
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="flex items-center gap-1.5 text-[13px] font-semibold">
            <GitPullRequest size={14} />
            {t("createPr.title")}
          </h3>
          {!busy && (
            <button onClick={onClose} className="text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]">
              <X size={15} />
            </button>
          )}
        </div>

        {branches !== null && localBranches.length < 2 ? (
          <p className="py-4 text-center text-[12px] text-[var(--cf-text-muted)]">{t("createPr.needTwoBranches")}</p>
        ) : (
          <>
            <div className="mb-3 flex items-center gap-2">
              <div className="flex-1">
                <label className="mb-1 block text-[11px] font-medium text-[var(--cf-text-muted)]">
                  {t("createPr.source")}
                </label>
                <select
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                  disabled={busy || branches === null}
                  className="w-full rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface)] px-2.5 py-1.5 text-[13px] outline-none focus:border-[var(--cf-accent)] disabled:opacity-50"
                >
                  {localBranches.map((b) => (
                    <option key={b.name} value={b.name}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </div>
              <span className="mt-5 text-[var(--cf-text-muted)]">→</span>
              <div className="flex-1">
                <label className="mb-1 block text-[11px] font-medium text-[var(--cf-text-muted)]">
                  {t("createPr.target")}
                </label>
                <select
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                  disabled={busy || branches === null}
                  className="w-full rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface)] px-2.5 py-1.5 text-[13px] outline-none focus:border-[var(--cf-accent)] disabled:opacity-50"
                >
                  {localBranches.map((b) => (
                    <option key={b.name} value={b.name}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            {sameBranch && <p className="-mt-2 mb-2 text-[11px] text-[var(--cf-danger)]">{t("createPr.sameBranch")}</p>}

            <div className="mb-1 flex items-center justify-between">
              <label className="text-[11px] font-medium text-[var(--cf-text-muted)]">{t("createPr.titleField")}</label>
              <button
                onClick={generate}
                disabled={busy || sameBranch || !source || !target}
                title={t("createPr.generate")}
                className="flex items-center gap-1 text-[11px] text-[var(--cf-accent)] hover:underline disabled:opacity-40"
              >
                {generating ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />}
                {generating ? t("createPr.generating") : t("createPr.generate")}
              </button>
            </div>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("createPr.titlePlaceholder")}
              disabled={busy}
              className="mb-3 w-full rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface)] px-2.5 py-1.5 text-[13px] outline-none focus:border-[var(--cf-accent)] disabled:opacity-50"
            />

            <label className="mb-1 block text-[11px] font-medium text-[var(--cf-text-muted)]">
              {t("createPr.description")}
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("createPr.descriptionPlaceholder")}
              rows={7}
              disabled={busy}
              className="mb-3 w-full resize-none rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface)] px-2.5 py-1.5 font-mono text-[12px] outline-none focus:border-[var(--cf-accent)] disabled:opacity-50"
            />

            <label className="mb-4 flex items-center gap-2 text-[12px] text-[var(--cf-text-muted)]">
              <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} disabled={busy} />
              {t("createPr.draft")}
            </label>

            <div className="flex justify-end gap-2">
              <button
                disabled={busy}
                onClick={onClose}
                className="rounded-md px-3 py-1.5 text-[12px] text-[var(--cf-text-muted)] hover:bg-black/[0.05] disabled:opacity-40 dark:hover:bg-white/[0.08]"
              >
                {t("common.cancel")}
              </button>
              <button
                disabled={!canSubmit}
                onClick={submit}
                className="flex items-center gap-1.5 rounded-md bg-[var(--cf-accent)] px-3 py-1.5 text-[12px] font-medium text-white disabled:opacity-40"
              >
                {creating ? <Loader2 size={13} className="animate-spin" /> : <GitPullRequest size={13} />}
                {creating ? t("createPr.creating") : t("createPr.create")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
