import { useState, type MouseEvent, type ReactNode } from "react";
import { AlertTriangle, Check, ChevronLeft, Download, GitBranch, History, LoaderCircle, MoreHorizontal, Pencil, RotateCcw } from "lucide-react";
import { repoMenuItems } from "../../lib/repoMenu";
import { diagramsClearVersions, diagramsDeleteVersion, diagramsListVersions, diagramsVersionContent } from "../../lib/tauri/diagramsCommands";
import { useArchitectureStore } from "../../state/architectureStore";
import { confirmAction } from "../../state/confirmStore";
import { useT } from "../../state/languageStore";
import { promptAction } from "../../state/promptStore";
import { AiSparkles } from "../common/AiGlyph";
import { buttonClass, iconButtonClass } from "../common/Button";
import { ContextMenu, type MenuItem } from "../common/ContextMenu";
import { Tooltip } from "../common/Tooltip";
import { VersionHistoryModal } from "../common/VersionHistoryModal";
import { tabCountClass } from "../common/recipes";
import { exportArchitecture, type ArchExport } from "./exportArch";
import { useArchSourceDialog } from "./sources/ArchSourceDialog";
import type { ArchModel } from "./useArchModel";

type Menu = { x: number; y: number; items: MenuItem[]; anchor: { top: number; bottom: number; left: number; right: number } };

export function ArchDocumentToolbar({ model, documentsControl }: { model: ArchModel; documentsControl: ReactNode }) {
  const t = useT();
  const draft = useArchitectureStore((s) => s.draft);
  const item = useArchitectureStore((s) => s.items.find((i) => i.id === model.docId));
  const saving = useArchitectureStore((s) => s.saving);
  const fileConflict = useArchitectureStore((s) => s.fileConflict);
  const openSources = useArchSourceDialog((s) => s.openAs);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [history, setHistory] = useState(false);
  if (!draft) return null;

  const store = useArchitectureStore.getState;
  const title = item?.title ?? model.doc.meta?.title ?? t("arch.untitled");
  const originPath = item?.originPath ?? "";
  const sources = model.doc.sources ?? [];
  const sourcesLabel = t(sources.length ? "arch.src.update" : "arch.src.generate");
  const statusLabel = fileConflict ? t("arch.status.conflict")
    : draft.fileError ? t("arch.status.linkUnavailable")
    : saving ? t("arch.status.saving")
    : draft.dirty ? t("arch.status.unsaved")
    : t("arch.status.saved");
  const StatusIcon = fileConflict || draft.fileError ? AlertTriangle : saving ? LoaderCircle : draft.dirty ? Pencil : Check;

  const showMenu = (event: MouseEvent, items: MenuItem[]) => {
    const { top, bottom, left, right } = event.currentTarget.getBoundingClientRect();
    setMenu({ x: event.clientX, y: event.clientY, anchor: { top, bottom, left, right }, items });
  };
  const exportMenu = (event: MouseEvent) => {
    const run = (kind: ArchExport, dark = false) => () => void exportArchitecture(kind, { scene: model.scene, doc: model.doc, text: model.text, title, dark });
    showMenu(event, [
      { label: t("arch.export.svgSheet"), onClick: run("svgSheet") },
      { label: t("arch.export.svg"), onClick: run("svg") },
      { label: t("arch.export.svgDark"), onClick: run("svgSheet", true) },
      { label: t("arch.export.png"), onClick: run("png") },
      { label: t("arch.export.pdf"), onClick: run("pdf") },
      { label: t("arch.export.json"), onClick: run("json"), separated: true },
    ]);
  };
  const documentMenu = (event: MouseEvent) => {
    const reloadLabel = t(fileConflict ? "arch.status.reloadDisk" : "arch.status.reloadDocument");
    showMenu(event, [
      { label: t("arch.history"), icon: History, onClick: () => setHistory(true) },
      ...(draft.dirty ? [{
        label: reloadLabel,
        icon: RotateCcw,
        disabled: saving,
        onClick: async () => {
          if (await confirmAction(t("arch.status.reloadConfirm"), true, reloadLabel) && store().draft?.id === draft.id) {
            await store().open(draft.id, { discardChanges: true });
          }
        },
      }] : []),
      ...repoMenuItems({
        workspaceId: store().workspaceId,
        originPath,
        own: true,
        separated: true,
        onSave: (projectId) => void store().saveToRepo(projectId),
        onUnlink: () => void store().unlink(draft.id),
      }),
    ]);
  };
  const rename = async () => {
    const value = await promptAction(t("arch.renamePrompt"), { initial: title, confirmLabel: t("arch.rename") });
    if (value) await store().rename(draft.id, value);
  };

  return (
    <header className="flex min-h-14 min-w-0 shrink-0 items-center gap-2 border-b border-[var(--cf-border)] bg-[var(--cf-surface)] px-2.5 py-1.5 @min-[520px]:gap-3">
      <div className="flex shrink-0 items-center gap-0.5">
        {documentsControl}
        <Tooltip label={t("arch.home.back")}>
          <button type="button" className={iconButtonClass({ size: "md" })} onClick={() => void store().open(null)} aria-label={t("arch.home.back")}>
            <ChevronLeft size={17} />
          </button>
        </Tooltip>
      </div>
      <div className="min-w-0 flex-1">
        <h1 className="m-0 leading-tight">
          <button type="button" className="group -ml-1 flex max-w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-[14px] font-semibold text-[var(--cf-text)] hover:bg-[var(--cf-hover)]" onClick={() => void rename()} title={t("arch.rename")} aria-label={`${t("arch.rename")} · ${title}`}>
            <span className="min-w-0 truncate">{title}</span>
            <Pencil size={11} className="shrink-0 text-[var(--cf-text-muted)]" aria-hidden />
          </button>
        </h1>
        <div className="mt-0.5 flex min-w-0 items-center gap-2 text-[11px] text-[var(--cf-text-muted)]">
          <Tooltip label={statusLabel} description={fileConflict ? t("arch.status.conflictHint") : draft.fileError || undefined}>
            <span role="status" className={`flex min-w-0 items-center gap-1 ${fileConflict || draft.fileError ? "text-[var(--cf-warning)]" : ""}`}>
              <StatusIcon size={11} className={`shrink-0 ${saving ? "animate-spin" : ""}`} aria-hidden />
              <span className="truncate">{statusLabel}</span>
            </span>
          </Tooltip>
          {originPath ? (
            <Tooltip label={originPath}>
              <span className="flex min-w-0 items-center gap-1 border-l border-[var(--cf-border)] pl-2 @max-[570px]:hidden">
                <GitBranch size={11} className="shrink-0" /><span className="truncate">{originPath.split(/[\\/]/).pop()}</span>
              </span>
            </Tooltip>
          ) : null}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Tooltip label={sourcesLabel} description={sources.length ? sources.map((source) => source.name).join(" · ") : t("arch.src.none")}>
          <button type="button" className={buttonClass({ variant: "secondary", className: "@max-[620px]:px-2" })} onClick={() => openSources("update")} data-tour="arch-sources-button" aria-label={sourcesLabel}>
            <AiSparkles size={14} />
            <span className="@max-[620px]:hidden">{sourcesLabel}</span>
            {sources.length ? <span className={`${tabCountClass} @max-[440px]:hidden`}>{sources.length}</span> : null}
          </button>
        </Tooltip>
        <Tooltip label={t("arch.export")}>
          <button type="button" className={iconButtonClass({ size: "md" })} onClick={exportMenu} aria-label={t("arch.export")} aria-haspopup="menu"><Download size={15} /></button>
        </Tooltip>
        <Tooltip label={t("arch.documentActions")}>
          <button type="button" className={iconButtonClass({ size: "md" })} onClick={documentMenu} aria-label={t("arch.documentActions")} aria-haspopup="menu"><MoreHorizontal size={17} /></button>
        </Tooltip>
      </div>
      {menu ? <ContextMenu {...menu} onClose={() => setMenu(null)} /> : null}
      {history ? (
        <VersionHistoryModal
          title={title}
          listVersions={() => diagramsListVersions(draft.id)}
          readVersion={(versionId) => diagramsVersionContent(versionId)}
          deleteVersion={(versionId) => diagramsDeleteVersion(versionId)}
          clearVersions={() => diagramsClearVersions(draft.id)}
          onRestore={async (content) => {
            if (store().draft?.id !== draft.id) return;
            store().editText(content);
            await store().flush();
          }}
          onClose={() => setHistory(false)}
        />
      ) : null}
    </header>
  );
}
