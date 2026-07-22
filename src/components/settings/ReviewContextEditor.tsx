import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { deleteReviewContext, listReviewContexts, upsertReviewContext } from "../../lib/tauri/commands";
import { useWorkspaceStore } from "../../state/workspaceStore";
import type { ReviewContext } from "../../types/domain";
import { useT } from "../../state/languageStore";
import { Checkbox } from "../common/Checkbox";

export function ReviewContextEditor() {
  const t = useT();
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const workspaceName = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.name ?? "");
  const [contexts, setContexts] = useState<ReviewContext[]>([]);

  const reload = async (id: string) => {
    setContexts(await listReviewContexts(id));
  };

  useEffect(() => {
    if (workspaceId) void reload(workspaceId);
    else setContexts([]);
  }, [workspaceId]);

  if (!workspaceId) {
    return (
      <section>
        <h3 className="mb-1 text-sm font-semibold">{t("settings.contextTitle")}</h3>
        <p className="text-[13px] text-[var(--cf-text-muted)]">{t("settings.contextSelectWorkspace")}</p>
      </section>
    );
  }

  const addContext = async () => {
    await upsertReviewContext(undefined, workspaceId, t("settings.newContextName"), "", true);
    await reload(workspaceId);
  };

  const update = async (ctx: ReviewContext, patch: Partial<ReviewContext>) => {
    const next = { ...ctx, ...patch };
    setContexts((prev) => prev.map((c) => (c.id === ctx.id ? next : c)));
    await upsertReviewContext(ctx.id, workspaceId, next.name, next.content, next.enabled);
  };

  const remove = async (id: string) => {
    await deleteReviewContext(id);
    await reload(workspaceId);
  };

  return (
    <section>
      <div className="mb-1 flex items-center justify-between">
        <h3 className="text-sm font-semibold">{t("settings.contextTitleForProject", { name: workspaceName })}</h3>
        <button
          onClick={addContext}
          className="flex items-center gap-1 text-[12px] text-[var(--cf-accent)] hover:underline"
        >
          <Plus size={13} /> {t("settings.addContext")}
        </button>
      </div>
      <p className="mb-3 text-[13px] text-[var(--cf-text-muted)]">{t("settings.contextHint")}</p>

      <div className="space-y-3">
        {contexts.map((ctx) => (
          <div key={ctx.id} className="rounded-lg border border-[var(--cf-border)] p-3">
            <div className="mb-2 flex items-center gap-2">
              <input
                value={ctx.name}
                onChange={(e) => update(ctx, { name: e.target.value })}
                className="flex-1 rounded-md border border-transparent bg-transparent px-1 text-[13px] font-medium outline-none focus:border-[var(--cf-accent)]"
              />
              <label className="flex items-center gap-1.5 text-[12px] text-[var(--cf-text-muted)]">
                <Checkbox checked={ctx.enabled} onChange={(checked) => update(ctx, { enabled: checked })} />
                {t("settings.enabled")}
              </label>
              <button onClick={() => remove(ctx.id)} className="text-[var(--cf-text-muted)] hover:text-[var(--cf-danger)]">
                <Trash2 size={13} />
              </button>
            </div>
            <textarea
              value={ctx.content}
              onChange={(e) => update(ctx, { content: e.target.value })}
              rows={4}
              placeholder={t("settings.contextPlaceholder")}
              className="w-full resize-none rounded-md border border-[var(--cf-border)] bg-transparent px-2 py-1.5 text-[13px] outline-none focus:border-[var(--cf-accent)]"
            />
          </div>
        ))}
        {contexts.length === 0 && (
          <p className="text-[12px] text-[var(--cf-text-muted)]">{t("settings.noContexts")}</p>
        )}
      </div>
    </section>
  );
}
