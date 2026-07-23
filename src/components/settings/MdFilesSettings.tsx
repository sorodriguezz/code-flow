import { useEffect, useState } from "react";
import { FileText, Plus, Trash2 } from "lucide-react";
import { deleteWorkspaceMdFile, listWorkspaceMdFiles, upsertWorkspaceMdFile } from "../../lib/tauri/commands";
import { useWorkspaceStore } from "../../state/workspaceStore";
import type { WorkspaceMdFile } from "../../types/domain";
import { confirmAction } from "../../state/confirmStore";
import { useT } from "../../state/languageStore";
import { Checkbox } from "../common/Checkbox";

export function MdFilesSettings() {
  const t = useT();
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const [files, setFiles] = useState<WorkspaceMdFile[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const reload = async (id: string, keepSelection = true) => {
    const list = await listWorkspaceMdFiles(id);
    setFiles(list);
    setSelectedId((prev) => {
      if (keepSelection && prev && list.some((f) => f.id === prev)) return prev;
      return list[0]?.id ?? null;
    });
  };

  useEffect(() => {
    if (workspaceId) void reload(workspaceId, false);
    else {
      setFiles([]);
      setSelectedId(null);
    }
  }, [workspaceId]);

  if (!workspaceId) {
    return (
      <section>
        <h3 className="mb-1 text-sm font-semibold">{t("settings.mdFilesTitle")}</h3>
        <p className="text-[13px] text-[var(--cf-text-muted)]">{t("settings.mdFilesSelectWorkspace")}</p>
      </section>
    );
  }

  const addFile = async () => {
    const created = await upsertWorkspaceMdFile(undefined, workspaceId, "CLAUDE.md", "", true);
    setFiles((prev) => [...prev, created]);
    setSelectedId(created.id);
  };

  const update = async (file: WorkspaceMdFile, patch: Partial<WorkspaceMdFile>) => {
    const next = { ...file, ...patch };
    setFiles((prev) => prev.map((f) => (f.id === file.id ? next : f)));
    await upsertWorkspaceMdFile(file.id, workspaceId, next.filename, next.content, next.enabled);
  };

  const remove = async (file: WorkspaceMdFile) => {
    if (!(await confirmAction(t("settings.removeMdFileConfirm", { name: file.filename || t("settings.untitledMdFile") })))) {
      return;
    }
    await deleteWorkspaceMdFile(file.id);
    await reload(workspaceId, false);
  };

  const selected = files.find((f) => f.id === selectedId) ?? null;

  return (
    <section>
      <div className="mb-1 flex items-center justify-between">
        <h3 className="text-sm font-semibold">{t("settings.mdFilesTitle")}</h3>
        <button onClick={addFile} className="flex items-center gap-1 text-[12px] text-[var(--cf-accent)] hover:underline">
          <Plus size={13} /> {t("settings.addMdFile")}
        </button>
      </div>
      <p className="mb-3 text-[13px] text-[var(--cf-text-muted)]">{t("settings.mdFilesHint")}</p>

      {files.length === 0 ? (
        <p className="text-[12px] text-[var(--cf-text-muted)]">{t("settings.noMdFiles")}</p>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-1.5">
            {files.map((f) => (
              <button
                key={f.id}
                onClick={() => setSelectedId(f.id)}
                className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] ${
                  f.id === selectedId
                    ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
                    : "text-[var(--cf-text-muted)] hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
                }`}
              >
                <FileText size={11} />
                {f.filename || t("settings.untitledMdFile")}
              </button>
            ))}
          </div>

          {selected && (
            <div className="rounded-lg border border-[var(--cf-border)] p-3">
              <div className="mb-2 flex items-center gap-2">
                <input
                  value={selected.filename}
                  onChange={(e) => update(selected, { filename: e.target.value })}
                  className="flex-1 rounded-md border border-transparent bg-transparent px-1 font-mono text-[13px] font-medium outline-none focus:border-[var(--cf-accent)]"
                />
                <label className="flex items-center gap-1.5 text-[12px] text-[var(--cf-text-muted)]">
                  <Checkbox checked={selected.enabled} onChange={(checked) => update(selected, { enabled: checked })} />
                  {t("settings.enabled")}
                </label>
                <button
                  onClick={() => remove(selected)}
                  className="text-[var(--cf-text-muted)] hover:text-[var(--cf-danger)]"
                >
                  <Trash2 size={13} />
                </button>
              </div>
              <textarea
                value={selected.content}
                onChange={(e) => update(selected, { content: e.target.value })}
                rows={14}
                placeholder={t("settings.mdFileContentPlaceholder")}
                className="w-full resize-none rounded-md border border-[var(--cf-border)] bg-transparent px-2.5 py-1.5 font-mono text-[12px] outline-none focus:border-[var(--cf-accent)]"
              />
            </div>
          )}
        </div>
      )}
    </section>
  );
}
