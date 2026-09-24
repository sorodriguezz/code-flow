import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { deleteReviewContext, listReviewContexts, upsertReviewContext } from "../../lib/tauri/commands";
import { useWorkspaceStore } from "../../state/workspaceStore";
import type { ReviewContext } from "../../types/domain";
import { confirmAction } from "../../state/confirmStore";
import { useT } from "../../state/languageStore";
import { Checkbox } from "../common/Checkbox";
import { buttonClass } from "../common/Button";
import { fieldClass } from "../common/recipes";

/**
 * The workspace's PR review context — a list of named, toggleable text blocks fed to the reviewer
 * (any model) alongside the diff. This is the single home for what used to be split across
 * "Context" and "Instructions (.md)": both were the same thing (named blocks folded into the
 * prompt), so they're merged here. A block can be a one-line rule or a long document; nothing is
 * ever written as a file, and none of it is Claude-specific.
 *
 * Chips select a block; the selected block gets a full-height editor below (title + content +
 * enable + delete) — good for both short rules and long instructions.
 */
export function ReviewContextEditor() {
  const t = useT();
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const [contexts, setContexts] = useState<ReviewContext[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const reload = async (id: string, keepSelection = true) => {
    const list = await listReviewContexts(id);
    setContexts(list);
    setSelectedId((prev) => (keepSelection && prev && list.some((c) => c.id === prev) ? prev : list[0]?.id ?? null));
  };

  useEffect(() => {
    if (workspaceId) void reload(workspaceId, false);
    else {
      setContexts([]);
      setSelectedId(null);
    }
  }, [workspaceId]);

  if (!workspaceId) {
    return <p className="text-[13px] text-[var(--cf-text-muted)]">{t("settings.contextSelectWorkspace")}</p>;
  }

  const addContext = async () => {
    const created = await upsertReviewContext(undefined, workspaceId, t("settings.newContextName"), "", true);
    setContexts((prev) => [...prev, created]);
    setSelectedId(created.id);
  };

  const update = async (ctx: ReviewContext, patch: Partial<ReviewContext>) => {
    const next = { ...ctx, ...patch };
    setContexts((prev) => prev.map((c) => (c.id === ctx.id ? next : c)));
    await upsertReviewContext(ctx.id, workspaceId, next.name, next.content, next.enabled);
  };

  const remove = async (ctx: ReviewContext) => {
    if (!(await confirmAction(t("settings.removeContextConfirm", { name: ctx.name || t("settings.untitledContext") })))) return;
    await deleteReviewContext(ctx.id);
    await reload(workspaceId, false);
  };

  const selected = contexts.find((c) => c.id === selectedId) ?? null;

  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-3">
        <p className="text-[12px] leading-snug text-[var(--cf-text-muted)]">{t("settings.contextHint")}</p>
        <button type="button" onClick={addContext} className={buttonClass({ variant: "secondary", size: "sm" })}>
          <Plus size={13} />
          {t("settings.addContext")}
        </button>
      </div>

      {contexts.length === 0 ? (
        <p className="mt-3 text-[12px] text-[var(--cf-text-muted)]">{t("settings.noContexts")}</p>
      ) : (
        <div className="mt-3 space-y-3">
          {/* The selected block wears the rail's selection — the soft accent fill with the label in
              full text — and the rest are quiet until pointed at. */}
          <div className="flex flex-wrap gap-1">
            {contexts.map((c) => (
              <button
                key={c.id}
                type="button"
                aria-pressed={c.id === selectedId}
                onClick={() => setSelectedId(c.id)}
                className={`inline-flex h-7 max-w-full items-center gap-1.5 rounded-md px-2.5 text-[12px] font-medium transition-colors duration-100 ${
                  c.id === selectedId
                    ? "bg-[var(--cf-accent-soft)] text-[var(--cf-text)]"
                    : "text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]"
                }`}
              >
                {!c.enabled && (
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--cf-text-faint)]" title={t("settings.enabled")} />
                )}
                <span className="truncate">{c.name || t("settings.untitledContext")}</span>
              </button>
            ))}
          </div>

          {selected && (
            <div className="rounded-lg border border-[var(--cf-border)] p-3">
              <div className="mb-2 flex items-center gap-3">
                <input
                  value={selected.name}
                  onChange={(e) => update(selected, { name: e.target.value })}
                  placeholder={t("settings.untitledContext")}
                  className={fieldClass({ className: "flex-1 font-medium" })}
                />
                <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-[12px] text-[var(--cf-text-muted)]">
                  <Checkbox checked={selected.enabled} onChange={(checked) => update(selected, { enabled: checked })} />
                  {t("settings.enabled")}
                </label>
                <button
                  type="button"
                  onClick={() => remove(selected)}
                  title={t("common.delete")}
                  aria-label={t("common.delete")}
                  className="inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md text-[var(--cf-text-muted)] transition-colors duration-100 hover:bg-[color-mix(in_oklab,var(--cf-danger)_10%,transparent)] hover:text-[var(--cf-danger)]"
                >
                  <Trash2 size={14} />
                </button>
              </div>
              <textarea
                value={selected.content}
                onChange={(e) => update(selected, { content: e.target.value })}
                rows={14}
                placeholder={t("settings.contextPlaceholder")}
                className={fieldClass({ size: "sm", className: "h-auto w-full resize-y py-1.5 font-mono leading-relaxed" })}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
