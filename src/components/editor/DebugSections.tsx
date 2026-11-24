import { useEffect, useState, type ReactNode } from "react";
import { Check, ChevronDown, ChevronRight, Copy, Eye, ListX, Pencil, ScrollText, X } from "lucide-react";
import { Checkbox } from "../common/Checkbox";
import { Tooltip } from "../common/Tooltip";
import { iconButtonClass } from "../common/Button";
import { useDebugStore, type Breakpoint } from "../../state/debugStore";
import { useT, type Translate } from "../../state/languageStore";
import type { DebugVariable, ExceptionFilter } from "../../lib/tauri/commands";
import { breakpointGlyphClass, promptBreakpoint } from "./useBreakpointGutter";
import { DebugValue, useFoldedSection, valueKind } from "./debugValue";
import { previewOf } from "./useDebugEditorValues";

/** The section heading every part of the debug panel wears, with room for its own buttons. */
export function SectionHead({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex h-7 items-center gap-0.5 px-1.5 pt-2">
      <span className="mr-auto text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]">
        {title}
      </span>
      {children}
    </div>
  );
}

/**
 * A section of the debug panel that folds: its heading is the toggle, with a count of what it holds
 * and room for its own buttons. Folded, only the heading stays — eighty locals no longer push the
 * watches and the breakpoints off the bottom (user report, 2026-11-18). Remembered per section.
 */
export function FoldSection({
  id,
  title,
  count,
  actions,
  children,
}: {
  id: string;
  title: string;
  count?: number;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const [folded, toggle] = useFoldedSection(id);
  return (
    <section>
      <div className="group/sec flex h-7 items-center gap-0.5 pt-1.5 pr-1">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={!folded}
          className="mr-auto flex min-w-0 items-center gap-1 rounded px-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)] hover:text-[var(--cf-text-muted)]"
        >
          {folded ? <ChevronRight size={12} className="shrink-0" /> : <ChevronDown size={12} className="shrink-0" />}
          <span className="truncate">{title}</span>
          {count !== undefined && count > 0 && (
            <span className="ml-0.5 rounded-full bg-[var(--cf-press)] px-1.5 text-[10px] font-medium normal-case tracking-normal tabular-nums">
              {count}
            </span>
          )}
        </button>
        {actions && <span className="flex shrink-0 items-center">{actions}</span>}
      </div>
      {!folded && <div className="pb-1">{children}</div>}
    </section>
  );
}

/** A slice row of a long array, as the backend names it: `[100 … 199]`. */
export function isRangeRow(variable: DebugVariable): boolean {
  return variable.value === "" && /^\[\d+ … \d+\]$/.test(variable.name);
}

/** Copies `value` and says so for a moment — the button every value row offers on hover. */
function CopyValueButton({ value }: { value: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <Tooltip side="left" label={t("debug.copyValue")}>
      <span
        role="button"
        tabIndex={0}
        aria-label={t("debug.copyValue")}
        onClick={(event) => {
          event.stopPropagation();
          void navigator.clipboard.writeText(value);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        }}
        className={iconButtonClass({ size: "xs", className: "opacity-0 group-hover:opacity-100 focus-visible:opacity-100" })}
      >
        {copied ? <Check size={11} className="text-[var(--cf-success)]" /> : <Copy size={11} />}
      </span>
    </Tooltip>
  );
}

/** One variable row. Objects expand one level at a time, on click — a deep graph fetched eagerly
 * is slow to produce and almost entirely unread. A scope (`Local`, `Global`) is a row like any
 * other, with no value of its own. */
export function VariableRow({
  variable,
  depth,
  inScope = false,
  parentPath = "",
}: {
  variable: DebugVariable;
  depth: number;
  /** The names from the scope down to this row's parent — with its own name, the path that keeps
   *  the row open across stops. Empty for rows outside the variables tree (watches, the console). */
  parentPath?: string;
  /** A scope's own variable (`Local` › `documento`): its name alone is an expression that means the
   *  same thing at the next stop, so it can become a watch. A property under a watch or a console
   *  result is not — `email` under `this.user` would watch the wrong thing. */
  inScope?: boolean;
}) {
  const t = useT();
  const expanded = useDebugStore((s) => (variable.object_id ? s.expanded[variable.object_id] : undefined));
  const expand = useDebugStore((s) => s.expand);
  const addWatch = useDebugStore((s) => s.addWatch);
  const expandable = Boolean(variable.object_id);
  // A slice of a long array (`[0 … 99]`) has no value of its own either, but it is no scope: its
  // children are indexes, not names to watch.
  const isRange = isRangeRow(variable);
  const isScope = variable.value === "" && !isRange;
  // Only rows of the variables tree are remembered: a scope starts one, its children extend it.
  const treePath = depth === 0 ? (isScope ? variable.name : undefined) : parentPath ? `${parentPath}/${variable.name}` : undefined;
  // An object row shows its first fields, not the bare "Object" the backend calls it — the shallow
  // rows only, each a round trip; what is opened shows its children anyway.
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => {
    if (isScope || depth > 2 || !variable.object_id || valueKind(variable.value) !== "object") return;
    let live = true;
    void previewOf(variable.value, variable.object_id).then((text) => live && setPreview(text));
    return () => {
      live = false;
    };
  }, [isScope, depth, variable.object_id, variable.value]);

  return (
    <>
      <button
        onClick={() => variable.object_id && void expand(variable.object_id, treePath)}
        style={{ paddingLeft: depth * 12 + 6 }}
        className="group flex h-6 w-full items-center gap-1.5 rounded-md pr-1 text-left hover:bg-[var(--cf-hover)]"
      >
        {expandable ? (
          expanded ? (
            <ChevronDown size={12} className="shrink-0 text-[var(--cf-text-faint)]" />
          ) : (
            <ChevronRight size={12} className="shrink-0 text-[var(--cf-text-faint)]" />
          )
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <span className={`shrink-0 font-mono text-[12px] ${isScope ? "font-medium text-[var(--cf-text-muted)]" : "text-[var(--cf-text)]"}`}>
          {variable.name}
        </span>
        {!isScope && <DebugValue value={expanded ? variable.value : (preview ?? variable.value)} className="min-w-0 flex-1" />}
        {(isScope || isRange) && <span className="flex-1" />}
        {/* A local's own row (a scope's direct child) can become a watch: the name is an expression
            that means the same thing at the next stop. Deeper rows have no path to evaluate by. */}
        {!isScope && inScope && (
          <Tooltip side="left" label={t("debug.addToWatch")}>
            <span
              role="button"
              tabIndex={0}
              aria-label={t("debug.addToWatch")}
              onClick={(event) => {
                event.stopPropagation();
                addWatch(variable.name);
              }}
              className={iconButtonClass({ size: "xs", className: "opacity-0 group-hover:opacity-100 focus-visible:opacity-100" })}
            >
              <Eye size={11} />
            </span>
          </Tooltip>
        )}
        {!isScope && <CopyValueButton value={variable.value} />}
      </button>
      {expanded?.map((child) => (
        <VariableRow
          key={`${variable.object_id}-${child.name}`}
          variable={child}
          depth={depth + 1}
          inScope={isScope}
          parentPath={treePath ?? ""}
        />
      ))}
    </>
  );
}

/** Expressions evaluated again at every stop, in the selected frame. */
export function WatchSection({ paused }: { paused: boolean }) {
  const t = useT();
  const watches = useDebugStore((s) => s.watches);
  const values = useDebugStore((s) => s.watchValues);
  const expandedMap = useDebugStore((s) => s.expanded);
  const expand = useDebugStore((s) => s.expand);
  const addWatch = useDebugStore((s) => s.addWatch);
  const removeWatch = useDebugStore((s) => s.removeWatch);
  const [draft, setDraft] = useState("");

  return (
    <FoldSection id="watch" title={t("debug.watch")} count={watches.length}>
      {watches.map((expression) => {
        const result = paused ? values[expression] : undefined;
        const objectId = result?.objectId ?? null;
        const children = objectId ? expandedMap[objectId] : undefined;
        return (
          <div key={expression}>
            <div className="group flex h-6 items-center gap-1.5 rounded-md pl-1.5 pr-1 hover:bg-[var(--cf-hover)]">
              <button
                onClick={() => objectId && void expand(objectId)}
                className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                disabled={!objectId}
              >
                {objectId ? (
                  children ? (
                    <ChevronDown size={12} className="shrink-0 text-[var(--cf-text-faint)]" />
                  ) : (
                    <ChevronRight size={12} className="shrink-0 text-[var(--cf-text-faint)]" />
                  )
                ) : (
                  <span className="w-3 shrink-0" />
                )}
                <span className="shrink-0 font-mono text-[12px] text-[var(--cf-text)]">{expression}</span>
                {result?.error ? (
                  <span className="truncate font-mono text-[12px] text-[var(--cf-danger)]" title={result.value}>
                    {result.value}
                  </span>
                ) : result ? (
                  <DebugValue value={result.value} className="min-w-0" />
                ) : (
                  <span className="font-mono text-[12px] text-[var(--cf-text-faint)]">—</span>
                )}
              </button>
              <Tooltip side="left" label={t("debug.watchRemove")}>
                <button
                  onClick={() => removeWatch(expression)}
                  aria-label={t("debug.watchRemove")}
                  className={iconButtonClass({ size: "xs", className: "opacity-0 group-hover:opacity-100 focus-visible:opacity-100" })}
                >
                  <X size={12} />
                </button>
              </Tooltip>
            </div>
            {children?.map((child) => (
              <VariableRow key={`${objectId}-${child.name}`} variable={child} depth={1} />
            ))}
          </div>
        );
      })}
      <input
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && draft.trim()) {
            event.preventDefault();
            addWatch(draft);
            setDraft("");
          } else if (event.key === "Escape") {
            setDraft("");
          }
        }}
        placeholder={t("debug.watchPlaceholder")}
        spellCheck={false}
        className="h-6 w-full rounded-md bg-transparent px-[22px] font-mono text-[12px] text-[var(--cf-text)] outline-none placeholder:text-[var(--cf-text-faint)] focus:bg-[var(--cf-hover)]"
      />
    </FoldSection>
  );
}

function filterLabel(option: ExceptionFilter, t: Translate): string {
  if (option.filter === "uncaught") return t("debug.exceptionsUncaught");
  if (option.filter === "all") return t("debug.exceptionsAll");
  return option.label;
}

function fileLabel(file: string, repoPath: string): string {
  const root = `${repoPath.replace(/\\/g, "/").replace(/\/+$/, "")}/`;
  return file.startsWith(root) ? file.slice(root.length) : (file.split("/").pop() ?? file);
}

/** The file's own name. */
const baseName = (file: string) => file.split("/").pop() ?? file;

/** The folder the file is in, relative to the repository — empty at its root. */
function dirLabel(file: string, repoPath: string): string {
  const label = fileLabel(file, repoPath);
  const cut = label.lastIndexOf("/");
  return cut < 0 ? "" : label.slice(0, cut);
}

/**
 * Every breakpoint in the workspace, and the exceptions that stop the program: switch one off
 * without losing it, give it a condition, turn it into a logpoint, or take it away.
 */
export function BreakpointsSection({
  repoPath,
  debuggerId,
  onOpen,
}: {
  repoPath: string;
  /** Whose exception filters to offer: `node`, or the adapter's id. */
  debuggerId: string;
  onOpen: (file: string, line: number) => void;
}) {
  const t = useT();
  const breakpoints = useDebugStore((s) => s.breakpoints);
  const options = useDebugStore((s) => s.offeredFilters[debuggerId]) ?? [];
  const chosen = useDebugStore((s) => s.exceptionFilters[debuggerId]);
  const setExceptionFilter = useDebugStore((s) => s.setExceptionFilter);
  const setBreakpoint = useDebugStore((s) => s.setBreakpoint);
  const removeBreakpoint = useDebugStore((s) => s.removeBreakpoint);
  const removeAll = useDebugStore((s) => s.removeAllBreakpoints);
  const enabled = chosen ?? options.filter((option) => option.default).map((option) => option.filter);

  const rows: Array<{ file: string; bp: Breakpoint }> = Object.entries(breakpoints)
    .flatMap(([file, list]) => list.map((bp) => ({ file, bp })))
    .sort((a, b) => fileLabel(a.file, repoPath).localeCompare(fileLabel(b.file, repoPath)) || a.bp.line - b.bp.line);

  return (
    <FoldSection
      id="breakpoints"
      title={t("debug.breakpoints")}
      count={rows.length}
      actions={
        rows.length > 0 && (
          <Tooltip side="left" label={t("debug.removeAllBreakpoints")}>
            <button onClick={removeAll} aria-label={t("debug.removeAllBreakpoints")} className={iconButtonClass({ size: "xs" })}>
              <ListX size={13} />
            </button>
          </Tooltip>
        )
      }
    >
      {options.map((option) => (
        <label key={option.filter} className="flex h-6 cursor-pointer items-center gap-2 rounded-md px-1.5 hover:bg-[var(--cf-hover)]">
          <Checkbox
            checked={enabled.includes(option.filter)}
            onChange={(on) => setExceptionFilter(debuggerId, option.filter, on)}
          />
          <span className="truncate text-[12px] text-[var(--cf-text)]">{filterLabel(option, t)}</span>
        </label>
      ))}
      {rows.length === 0 ? (
        <p className="px-1.5 py-1 text-[11px] text-[var(--cf-text-faint)]">{t("debug.noBreakpoints")}</p>
      ) : (
        rows.map(({ file, bp }) => (
          // The label has the whole row at rest; the actions sit over its right end and show on
          // hover or keyboard focus, when the label makes room for them. Hidden but still laid out,
          // they used to keep ~70px of a narrow sidebar empty and cut every path short (user ask,
          // 2026-11-23).
          <div
            key={`${file}:${bp.line}`}
            className="group relative flex h-6 items-center gap-2 rounded-md pl-1.5 pr-1 hover:bg-[var(--cf-hover)]"
          >
            <Checkbox checked={bp.enabled} onChange={(on) => setBreakpoint(file, bp.line, { enabled: on })} />
            {/* The gutter's own glyph, so the row says at a glance what kind of breakpoint it is. */}
            <span className={`relative h-3 w-3 shrink-0 ${breakpointGlyphClass(bp)}`} aria-hidden />
            <button
              onClick={() => onOpen(file, bp.line)}
              className="flex min-w-0 flex-1 items-center gap-1.5 text-left group-focus-within:pr-[68px] group-hover:pr-[68px]"
              title={[fileLabel(file, repoPath) + `:${bp.line}`, bp.logMessage ? `“${bp.logMessage}”` : bp.condition].filter(Boolean).join("\n")}
            >
              {/* File and line first, the folder after it in the faint tone: two breakpoints in the
                  same deep folder read apart, where a path cut from the end made them identical. */}
              <span className="min-w-0 shrink-0 truncate font-mono text-[12px] text-[var(--cf-text)]">
                {baseName(file)}:{bp.line}
              </span>
              <span className="min-w-0 truncate font-mono text-[11px] text-[var(--cf-text-faint)]">
                {bp.logMessage ? `“${bp.logMessage}”` : bp.condition || dirLabel(file, repoPath)}
              </span>
            </button>
            <div className="absolute inset-y-0 right-1 flex items-center opacity-0 transition-opacity duration-100 group-focus-within:opacity-100 group-hover:opacity-100">
              <Tooltip side="left" label={t("debug.editCondition")}>
                <button
                  onClick={() => void promptBreakpoint(file, bp.line, "condition")}
                  aria-label={t("debug.editCondition")}
                  className={iconButtonClass({ size: "xs" })}
                >
                  <Pencil size={12} />
                </button>
              </Tooltip>
              <Tooltip side="left" label={t("debug.editLogpoint")}>
                <button
                  onClick={() => void promptBreakpoint(file, bp.line, "logMessage")}
                  aria-label={t("debug.editLogpoint")}
                  className={iconButtonClass({ size: "xs" })}
                >
                  <ScrollText size={12} />
                </button>
              </Tooltip>
              <Tooltip side="left" label={t("debug.removeBreakpoint")}>
                <button
                  onClick={() => removeBreakpoint(file, bp.line)}
                  aria-label={t("debug.removeBreakpoint")}
                  className={iconButtonClass({ size: "xs" })}
                >
                  <X size={12} />
                </button>
              </Tooltip>
            </div>
          </div>
        ))
      )}
    </FoldSection>
  );
}
