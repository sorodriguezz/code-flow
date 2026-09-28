import { memo, useMemo, useRef, useState } from "react";
import type { editor as MonacoEditorNS } from "monaco-editor";
import {
  ArrowDown,
  ArrowUp,
  CornerDownLeft,
  Ellipsis,
  Play,
  Plus,
  Trash2,
} from "lucide-react";
import { AiSparkles } from "../../common/AiGlyph";
import { ContextMenu, type MenuItem } from "../../common/ContextMenu";
import { Tooltip } from "../../common/Tooltip";
import { iconButtonClass } from "../../common/Button";
import { cellOutputs, cellSource, executionCount, type NotebookCell } from "../../../lib/notebook/nbformat";
import { isJsonObject, type JsonObject } from "../../../lib/notebook/json";
import {
  notebookActions,
  type CellRun,
  type NotebookAiRun,
  type PendingInput,
} from "../../../state/notebookStore";
import { useT } from "../../../state/languageStore";
import { CellEditor, type CellKey } from "./CellEditor";
import { CellOutputs, MarkdownBlock } from "./CellOutputs";
import { CellAiPanel } from "./CellAiPanel";
import type { OutputPalette } from "./HtmlOutput";

/** `![x](attachment:name.png)` pointed at the cell's own attachment, as a data URL the sanitizer
 *  lets through — an `attachment:` link would be dropped. */
function withAttachments(source: string, attachments: JsonObject | null): string {
  if (!attachments) return source;
  return source.replace(/attachment:([^\s)"']+)/g, (whole, name: string) => {
    const bundle = attachments[decodeURIComponent(name)];
    if (!isJsonObject(bundle)) return whole;
    const mime = Object.keys(bundle).find((type) => type.startsWith("image/"));
    if (!mime) return whole;
    const raw = bundle[mime];
    const data = Array.isArray(raw) ? raw.join("") : String(raw ?? "");
    return mime === "image/svg+xml"
      ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(data)}`
      : `data:${mime};base64,${data.replace(/\s+/g, "")}`;
  });
}

export interface CellViewProps {
  sessionKey: string;
  cell: NotebookCell;
  index: number;
  count: number;
  selected: boolean;
  editing: boolean;
  run: CellRun | undefined;
  input: PendingInput | null;
  ai: NotebookAiRun | undefined;
  language: string;
  modelPath: string;
  theme: string;
  palette: OutputPalette;
  onKey: (cellKey: string, key: CellKey) => void;
  onOpenLink: (href: string) => void;
  registerEditor: (cellKey: string, editor: MonacoEditorNS.IStandaloneCodeEditor | null) => void;
}

/**
 * One cell: its prompt (`[3]`, `[*]` running, `[·]` queued), its editor or rendered Markdown, its
 * outputs, an `input()` box when the kernel is waiting on it, and whatever an AI action on it
 * brought back. The toolbar shows on hover and on the selected cell.
 */
export const NotebookCellView = memo(function NotebookCellView(props: CellViewProps) {
  const {
    sessionKey,
    cell,
    index,
    count,
    selected,
    editing,
    run,
    input,
    ai,
    language,
    modelPath,
    theme,
    palette,
    onKey,
    onOpenLink,
    registerEditor,
  } = props;
  const t = useT();
  const type = String(cell.json.cell_type);
  const source = cellSource(cell);
  const outputs = type === "code" ? cellOutputs(cell) : [];
  const exec = executionCount(cell);
  const [menu, setMenu] = useState<{ rect: DOMRect; items: MenuItem[] } | null>(null);
  const hasError = outputs.some((output) => output.output_type === "error");
  const attachments = isJsonObject(cell.json.attachments) ? cell.json.attachments : null;
  const rendered = useMemo(
    () => (type === "markdown" && !editing ? withAttachments(source, attachments) : ""),
    [type, editing, source, attachments],
  );
  const inputRef = useRef<HTMLInputElement>(null);

  const prompt =
    type !== "code"
      ? ""
      : run?.status === "running"
        ? "[*]"
        : run?.status === "queued"
          ? "[·]"
          : `[${exec ?? " "}]`;

  const openMenu = (event: React.MouseEvent<HTMLButtonElement>, items: MenuItem[]) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setMenu({ rect, items });
  };

  const typeItems: MenuItem[] = (["code", "markdown", "raw"] as const).map((next) => ({
    label: t(next === "code" ? "notebook.typeCode" : next === "markdown" ? "notebook.typeMarkdown" : "notebook.typeRaw"),
    leading: <span className="w-3.5 text-center">{type === next ? "•" : ""}</span>,
    onClick: () => notebookActions.changeType(sessionKey, cell.key, next),
  }));

  const aiItems: MenuItem[] = [
    ...(type === "code"
      ? [
          { label: t("notebook.ai.explain"), onClick: () => void notebookActions.askAi(sessionKey, cell.key, "explain", null) },
          {
            label: t("notebook.ai.fix"),
            disabled: !hasError,
            onClick: () => void notebookActions.askAi(sessionKey, cell.key, "fix", null),
          },
          { label: t("notebook.ai.document"), onClick: () => void notebookActions.askAi(sessionKey, cell.key, "document", null) },
        ]
      : [{ label: t("notebook.ai.explain"), onClick: () => void notebookActions.askAi(sessionKey, cell.key, "explain", null) }]),
    { label: t("notebook.ai.generateBelow"), separated: true, onClick: () => notebookActions.openGenerate(sessionKey, cell.key) },
  ];

  const moreItems: MenuItem[] = [
    ...(type === "code"
      ? [
          { label: t("notebook.runAbove"), onClick: () => void notebookActions.runAbove(sessionKey, cell.key) },
          { label: t("notebook.runBelow"), onClick: () => void notebookActions.runBelow(sessionKey, cell.key) },
          { label: t("notebook.clearOutput"), separated: true, onClick: () => notebookActions.clearOutputs(sessionKey, cell.key) },
        ]
      : []),
    { label: t("notebook.addAbove"), separated: type === "code", onClick: () => notebookActions.insert(sessionKey, cell.key, "above") },
    ...typeItems.map((item, i) => ({ ...item, separated: i === 0 })),
  ];

  const tool = (label: string, icon: React.ReactNode, onClick: (event: React.MouseEvent<HTMLButtonElement>) => void, disabled = false) => (
    <Tooltip side="top" label={label}>
      <button
        onClick={(event) => {
          event.stopPropagation();
          onClick(event);
        }}
        onMouseDown={(event) => event.preventDefault()}
        disabled={disabled}
        aria-label={label}
        className={iconButtonClass({ size: "xs" })}
      >
        {icon}
      </button>
    </Tooltip>
  );

  return (
    <div
      data-cell={cell.key}
      onMouseDown={(event) => {
        // A press in the editor is the editor's: its focus puts the cell in edit mode. Anywhere else
        // in the cell — an output, the prompt, the toolbar — is command mode on this cell, as in
        // Jupyter.
        if ((event.target as HTMLElement).closest(".monaco-editor")) return;
        notebookActions.select(sessionKey, cell.key, false);
      }}
      className="group relative flex py-0.5"
    >
      <div
        className={`w-14 shrink-0 select-none pr-2 pt-[7px] text-right font-mono text-[11px] ${
          run ? "text-[var(--cf-accent)]" : "text-[var(--cf-text-muted)]"
        }`}
        title={run?.status === "queued" ? t("notebook.queued") : run?.status === "running" ? t("notebook.running") : undefined}
      >
        {prompt}
      </div>
      <div
        className={`relative min-w-0 flex-1 rounded-md border ${
          selected
            ? editing
              ? "border-[var(--cf-accent)]"
              : "border-[color-mix(in_oklab,var(--cf-accent)_55%,transparent)]"
            : "border-transparent group-hover:border-[var(--cf-border)]"
        } ${type === "code" ? "bg-[var(--cf-bg)]" : ""}`}
      >
        {/* The selected cell's rule down its left edge — command mode's cursor, as in Jupyter. */}
        {selected && <span className="absolute -left-[3px] bottom-1 top-1 w-[3px] rounded-full bg-[var(--cf-accent)]" />}

        {type === "markdown" && !editing ? (
          <div
            onDoubleClick={() => notebookActions.select(sessionKey, cell.key, true)}
            className="min-h-[32px] px-3 py-1.5 text-[13px]"
          >
            {source.trim() ? (
              <MarkdownBlock source={rendered} onOpenLink={onOpenLink} />
            ) : (
              <span className="text-[12px] italic text-[var(--cf-text-muted)]">{t("notebook.emptyMarkdown")}</span>
            )}
          </div>
        ) : (
          <CellEditor
            modelPath={modelPath}
            language={type === "code" ? language : type === "markdown" ? "markdown" : "plaintext"}
            value={source}
            theme={theme}
            autoFocus={editing}
            onChange={(value) => notebookActions.setSource(sessionKey, cell.key, value)}
            onKey={(key) => onKey(cell.key, key)}
            onFocus={() => notebookActions.select(sessionKey, cell.key, true)}
            onReady={(editor) => registerEditor(cell.key, editor)}
          />
        )}

        {input && (
          <form
            className="mx-2 my-1.5 flex items-center gap-2 rounded-md border border-[var(--cf-accent)] bg-[var(--cf-field)] px-2 py-1"
            onSubmit={(event) => {
              event.preventDefault();
              const value = inputRef.current?.value ?? "";
              void notebookActions.answerInput(sessionKey, value);
            }}
          >
            <span className="shrink-0 font-mono text-[12px] text-[var(--cf-text-muted)]">{input.prompt || "›"}</span>
            <input
              ref={inputRef}
              autoFocus
              type={input.password ? "password" : "text"}
              aria-label={t("notebook.inputLabel")}
              className="min-w-0 flex-1 bg-transparent font-mono text-[12px] outline-none"
              onKeyDown={(event) => event.stopPropagation()}
            />
            <button type="submit" aria-label={t("notebook.inputSend")} className={iconButtonClass({ size: "xs" })}>
              <CornerDownLeft size={12} />
            </button>
          </form>
        )}

        {type === "code" && <CellOutputs outputs={outputs} palette={palette} onOpenLink={onOpenLink} />}

        {ai && <CellAiPanel sessionKey={sessionKey} slot={cell.key} run={ai} currentSource={source} onOpenLink={onOpenLink} />}

        <div
          className={`absolute -top-3 right-2 z-10 flex items-center gap-0.5 rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] px-0.5 py-0.5 shadow-sm ${
            selected ? "flex" : "hidden group-hover:flex"
          }`}
        >
          {type === "code" &&
            tool(t("notebook.runCell"), <Play size={12} />, () => void notebookActions.run(sessionKey, [cell.key]))}
          {tool(t("notebook.moveUp"), <ArrowUp size={12} />, () => notebookActions.move(sessionKey, cell.key, -1), index === 0)}
          {tool(t("notebook.moveDown"), <ArrowDown size={12} />, () => notebookActions.move(sessionKey, cell.key, 1), index === count - 1)}
          {tool(t("notebook.ai.menu"), <AiSparkles size={12} />, (event) => openMenu(event, aiItems))}
          {tool(t("notebook.addBelow"), <Plus size={12} />, () => notebookActions.insert(sessionKey, cell.key, "below"))}
          {tool(t("notebook.more"), <Ellipsis size={12} />, (event) => openMenu(event, moreItems))}
          {tool(t("notebook.deleteCell"), <Trash2 size={12} />, () => notebookActions.remove(sessionKey, cell.key))}
        </div>
      </div>

      {menu && (
        <ContextMenu
          x={menu.rect.left}
          y={menu.rect.bottom}
          items={menu.items}
          anchor={{ top: menu.rect.top, bottom: menu.rect.bottom, left: menu.rect.left, right: menu.rect.right, align: "end" }}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
});
