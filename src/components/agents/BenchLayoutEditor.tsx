import { useState } from "react";
import { LayoutGrid, Plus, Trash2 } from "lucide-react";
import { buttonClass, iconButtonClass } from "../common/Button";
import { Tooltip } from "../common/Tooltip";
import { fieldClass, rowClass } from "../common/recipes";
import { confirmAction } from "../../state/confirmStore";
import { useBenchStore } from "../../state/benchStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { pushErrorToast } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import { MAX_PANES, type BenchLayout, type LayoutPane } from "../../lib/bench/layouts";

/**
 * The editor for saved arrangements: a name, and a row per pane saying **where** the shell starts
 * and **what** it runs.
 *
 * # Why the commands have to be typed here
 *
 * Saving an open tab can only record what the bench knows — the folder each shell is in and what it
 * is called. What was typed into it half an hour ago is in that shell's scrollback, not in any state
 * this app keeps, and guessing it from the last command of a shell integration that may not be on
 * would be a layout that runs something nobody asked for. So "take it from this tab" fills the
 * folders, and the commands are written down once, here, by the person who knows them.
 *
 * # Why it is a dialog and not a settings pane
 *
 * It is reached from the bench's own menu, beside the arrangements it edits, and what it writes is
 * read by the row above it. A trip to Settings for a list that belongs to this panel would be a
 * longer way round to the same four fields.
 */
export function BenchLayoutEditor({ onClose }: { onClose: () => void }) {
  const t = useT();
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const layouts = useBenchStore((s) => s.savedLayouts);
  const terminals = useBenchStore((s) => s.terminals);
  const activeTabId = useBenchStore((s) => s.activeTabId);

  /** The layout being edited: an existing one by name, or a new one. */
  const [name, setName] = useState("");
  const [panes, setPanes] = useState<LayoutPane[]>([{ cwd: "", command: "" }]);
  /** The name it was loaded under, so renaming replaces rather than duplicates. */
  const [editing, setEditing] = useState<string | null>(null);

  const fail = (error: unknown) => pushErrorToast(String(error));

  const load = (layout: BenchLayout) => {
    setEditing(layout.name);
    setName(layout.name);
    setPanes(layout.panes.map((pane) => ({ cwd: pane.cwd, title: pane.title, command: pane.command ?? "" })));
  };

  const blank = () => {
    setEditing(null);
    setName("");
    setPanes([{ cwd: "", command: "" }]);
  };

  /** Fills the folders from the open tab. The commands are left for the user — see the note above. */
  const fromTab = () => {
    const open = terminals
      .filter((terminal) => terminal.tab_id === activeTabId)
      .map((terminal) => ({ cwd: terminal.cwd, title: terminal.title, command: "" }));
    if (open.length > 0) setPanes(open.slice(0, MAX_PANES));
  };

  const save = () => {
    const trimmed = name.trim();
    const kept = panes.filter((pane) => pane.cwd.trim() !== "" || (pane.command ?? "").trim() !== "");
    if (!workspaceId || trimmed === "" || kept.length === 0) return;
    void (async () => {
      // A rename is a save under the new name plus a removal of the old one: `saveLayout` replaces
      // by name, so without this the list would hold both.
      if (editing && editing.toLowerCase() !== trimmed.toLowerCase()) {
        await useBenchStore.getState().removeLayout(workspaceId, editing).catch(fail);
      }
      await useBenchStore.getState().saveLayout(workspaceId, { name: trimmed, panes: kept }).catch(fail);
      onClose();
    })();
  };

  const remove = () => {
    if (!workspaceId || !editing) return;
    void confirmAction(t("bench.layoutForgetConfirm", { name: editing }), true, t("bench.layoutForgetAction")).then((ok) => {
      if (!ok) return;
      void useBenchStore.getState().removeLayout(workspaceId, editing).catch(fail);
      blank();
    });
  };

  const setPane = (at: number, patch: Partial<LayoutPane>) =>
    setPanes((current) => current.map((pane, index) => (index === at ? { ...pane, ...patch } : pane)));

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40 p-6" onClick={onClose}>
      <div
        onClick={(event) => event.stopPropagation()}
        className="flex max-h-[80vh] w-full max-w-[640px] flex-col rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-4 shadow-[var(--cf-shadow)]"
      >
        <div className="flex items-center gap-2">
          <LayoutGrid size={15} className="shrink-0 text-[var(--cf-accent)]" />
          <p className="min-w-0 flex-1 text-[13px] font-semibold text-[var(--cf-text)]">{t("bench.layoutEditor")}</p>
        </div>

        {layouts.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {layouts.map((layout) => (
              <button
                key={layout.name}
                type="button"
                onClick={() => load(layout)}
                className={rowClass(editing === layout.name, "w-auto px-2 py-1 text-[12px]")}
              >
                {layout.name}
              </button>
            ))}
            <button type="button" onClick={blank} className={buttonClass({ variant: "ghost", size: "sm" })}>
              <Plus size={12} />
              {t("bench.layoutNew")}
            </button>
          </div>
        )}

        <div className="mt-3 flex items-center gap-2">
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t("bench.layoutNamePlaceholder")}
            aria-label={t("bench.layoutName")}
            className={fieldClass({ className: "min-w-0 flex-1" })}
          />
          <Tooltip label={t("bench.layoutFromTabHint")}>
            <button
              type="button"
              disabled={activeTabId === null}
              onClick={fromTab}
              className={buttonClass({ variant: "secondary", size: "sm" })}
            >
              {t("bench.layoutFromTab")}
            </button>
          </Tooltip>
        </div>

        <div className="mt-3 min-h-0 flex-1 overflow-y-auto">
          <div className="grid grid-cols-[1fr_1fr_auto] gap-1.5">
            <span className="px-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--cf-text-faint)]">
              {t("bench.layoutFolder")}
            </span>
            <span className="px-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--cf-text-faint)]">
              {t("bench.layoutCommand")}
            </span>
            <span />
            {panes.map((pane, at) => (
              <PaneRow
                key={at}
                pane={pane}
                onChange={(patch) => setPane(at, patch)}
                onRemove={() => setPanes((current) => current.filter((_, index) => index !== at))}
                removable={panes.length > 1}
                removeLabel={t("bench.layoutRemovePane")}
              />
            ))}
          </div>
          {panes.length < MAX_PANES && (
            <button
              type="button"
              onClick={() => setPanes((current) => [...current, { cwd: "", command: "" }])}
              className={buttonClass({ variant: "ghost", size: "sm", className: "mt-1.5" })}
            >
              <Plus size={12} />
              {t("bench.layoutAddPane")}
            </button>
          )}
          <p className="mt-2 px-1 text-[10.5px] leading-relaxed text-[var(--cf-text-muted)]">
            {t("bench.layoutHint")}
          </p>
        </div>

        <div className="mt-3 flex items-center gap-2 border-t border-[var(--cf-border)] pt-3">
          {editing && (
            <button type="button" onClick={remove} className={buttonClass({ variant: "danger-ghost", size: "sm" })}>
              <Trash2 size={12} />
              {t("bench.layoutForget")}
            </button>
          )}
          <span className="flex-1" />
          <button type="button" onClick={onClose} className={buttonClass({ variant: "ghost" })}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            disabled={name.trim() === ""}
            onClick={save}
            className={buttonClass({ variant: "primary" })}
          >
            {t("bench.layoutSave")}
          </button>
        </div>
      </div>
    </div>
  );
}

function PaneRow({
  pane,
  onChange,
  onRemove,
  removable,
  removeLabel,
}: {
  pane: LayoutPane;
  onChange: (patch: Partial<LayoutPane>) => void;
  onRemove: () => void;
  removable: boolean;
  removeLabel: string;
}) {
  return (
    <>
      <input
        value={pane.cwd}
        onChange={(event) => onChange({ cwd: event.target.value })}
        placeholder="~/code/app"
        className={fieldClass({ size: "sm", className: "min-w-0 font-mono" })}
      />
      <input
        value={pane.command ?? ""}
        onChange={(event) => onChange({ command: event.target.value })}
        placeholder="pnpm dev"
        className={fieldClass({ size: "sm", className: "min-w-0 font-mono" })}
      />
      <button
        type="button"
        disabled={!removable}
        onClick={onRemove}
        aria-label={removeLabel}
        title={removeLabel}
        className={iconButtonClass({ size: "sm" })}
      >
        <Trash2 size={13} />
      </button>
    </>
  );
}
