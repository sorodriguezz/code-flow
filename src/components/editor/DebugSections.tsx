import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, ListX, Pencil, ScrollText, X } from "lucide-react";
import { Checkbox } from "../common/Checkbox";
import { Tooltip } from "../common/Tooltip";
import { iconButtonClass } from "../common/Button";
import { useDebugStore, type Breakpoint } from "../../state/debugStore";
import { useT, type Translate } from "../../state/languageStore";
import type { DebugVariable, ExceptionFilter } from "../../lib/tauri/commands";
import { breakpointGlyphClass, promptBreakpoint } from "./useBreakpointGutter";

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

/** One variable row. Objects expand one level at a time, on click — a deep graph fetched eagerly
 * is slow to produce and almost entirely unread. A scope (`Local`, `Global`) is a row like any
 * other, with no value of its own. */
export function VariableRow({ variable, depth }: { variable: DebugVariable; depth: number }) {
  const expanded = useDebugStore((s) => (variable.object_id ? s.expanded[variable.object_id] : undefined));
  const expand = useDebugStore((s) => s.expand);
  const expandable = Boolean(variable.object_id);

  return (
    <>
      <button
        onClick={() => variable.object_id && void expand(variable.object_id)}
        style={{ paddingLeft: depth * 12 + 6 }}
        className="flex h-6 w-full items-center gap-1.5 rounded-md pr-2 text-left hover:bg-[var(--cf-hover)]"
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
        <span className={`shrink-0 font-mono text-[12px] ${variable.value === "" ? "text-[var(--cf-text-muted)]" : "text-[var(--cf-text)]"}`}>
          {variable.name}
        </span>
        <span className="truncate font-mono text-[12px] text-[var(--cf-text-muted)]">{variable.value}</span>
      </button>
      {expanded?.map((child) => (
        <VariableRow key={`${variable.object_id}-${child.name}`} variable={child} depth={depth + 1} />
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
    <>
      <SectionHead title={t("debug.watch")} />
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
                <span
                  className={`truncate font-mono text-[12px] ${
                    result?.error ? "text-[var(--cf-danger)]" : "text-[var(--cf-text-muted)]"
                  }`}
                  title={result?.value}
                >
                  {result ? result.value : "—"}
                </span>
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
    </>
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
    <>
      <SectionHead title={t("debug.breakpoints")}>
        {rows.length > 0 && (
          <Tooltip side="left" label={t("debug.removeAllBreakpoints")}>
            <button onClick={removeAll} aria-label={t("debug.removeAllBreakpoints")} className={iconButtonClass({ size: "xs" })}>
              <ListX size={13} />
            </button>
          </Tooltip>
        )}
      </SectionHead>
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
          <div
            key={`${file}:${bp.line}`}
            className="group flex h-6 items-center gap-2 rounded-md pl-1.5 pr-1 hover:bg-[var(--cf-hover)]"
          >
            <Checkbox checked={bp.enabled} onChange={(on) => setBreakpoint(file, bp.line, { enabled: on })} />
            {/* The gutter's own glyph, so the row says at a glance what kind of breakpoint it is. */}
            <span className={`relative h-3 w-3 shrink-0 ${breakpointGlyphClass(bp)}`} aria-hidden />
            <button
              onClick={() => onOpen(file, bp.line)}
              className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
              title={bp.logMessage ?? bp.condition ?? file}
            >
              <span className="truncate font-mono text-[12px] text-[var(--cf-text)]">
                {fileLabel(file, repoPath)}:{bp.line}
              </span>
              {(bp.condition || bp.logMessage) && (
                <span className="truncate font-mono text-[11px] text-[var(--cf-text-faint)]">
                  {bp.logMessage ? `“${bp.logMessage}”` : bp.condition}
                </span>
              )}
            </button>
            <div className="flex shrink-0 items-center opacity-0 group-hover:opacity-100 focus-within:opacity-100">
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
    </>
  );
}
