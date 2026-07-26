import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  CornerRightUp,
  Play,
  Redo2,
  Square,
  Trash2,
} from "lucide-react";
import { useDebugStore } from "../../state/debugStore";
import { DEBUG_ADAPTERS, adapterById, adapterForFile } from "../../lib/debugAdapters";
import type { DebugVariable } from "../../lib/tauri/commands";
import { useT } from "../../state/languageStore";

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** One variable row. Objects expand one level at a time, on click — a deep graph fetched eagerly
 * is slow to produce and almost entirely unread. */
function VariableRow({ variable, depth }: { variable: DebugVariable; depth: number }) {
  const expanded = useDebugStore((s) => (variable.object_id ? s.expanded[variable.object_id] : undefined));
  const expand = useDebugStore((s) => s.expand);
  const expandable = Boolean(variable.object_id);

  return (
    <>
      <button
        onClick={() => variable.object_id && void expand(variable.object_id)}
        style={{ paddingLeft: depth * 12 + 6 }}
        className="flex w-full items-baseline gap-1.5 py-0.5 pr-2 text-left hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
      >
        {expandable ? (
          expanded ? (
            <ChevronDown size={10} className="shrink-0 text-[var(--cf-text-muted)]" />
          ) : (
            <ChevronRight size={10} className="shrink-0 text-[var(--cf-text-muted)]" />
          )
        ) : (
          <span className="w-2.5 shrink-0" />
        )}
        <span className="shrink-0 font-mono text-[11px] text-[var(--cf-text)]">{variable.name}</span>
        <span className="truncate font-mono text-[11px] text-[var(--cf-text-muted)]">{variable.value}</span>
      </button>
      {expanded?.map((child) => (
        <VariableRow key={`${variable.object_id}-${child.name}`} variable={child} depth={depth + 1} />
      ))}
    </>
  );
}

/** Run and Debug: launch a program, stop where you asked, and look around.
 *
 * Node runs on the built-in backend (the runtime *is* the debugger, so nothing to install);
 * every other language drives an installed debug adapter over DAP — the same arrangement VS Code
 * has, where the adapter arrives in an extension. Both report through identical events, so this
 * panel never learns which one is behind a session.
 */
export function DebugPanel({
  repoPath,
  suggestedProgram,
  onOpenFrame,
}: {
  repoPath: string;
  /** The active editor file, offered as the thing to run when it's a script. */
  suggestedProgram: string | null;
  onOpenFrame: (file: string, line: number) => void;
}) {
  const t = useT();
  const status = useDebugStore((s) => s.status);
  const frames = useDebugStore((s) => s.frames);
  const selectedFrame = useDebugStore((s) => s.selectedFrame);
  const variables = useDebugStore((s) => s.variables);
  const consoleLines = useDebugStore((s) => s.console);
  const error = useDebugStore((s) => s.error);
  const breakpoints = useDebugStore((s) => s.breakpoints);
  const [program, setProgram] = useState("");
  const [adapterId, setAdapterId] = useState("node");
  /** Overrides the preset's binary — for an adapter that isn't on PATH, or a custom one. */
  const [adapterCommand, setAdapterCommand] = useState("");
  const [expression, setExpression] = useState("");
  const consoleRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    useDebugStore.getState().init();
  }, []);

  // The active file is the default program, but only until the user types their own.
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (touched || !suggestedProgram) return;
    setProgram(suggestedProgram);
    // The file decides the language: opening a .py and hitting play should not try Node.
    const matched = adapterForFile(suggestedProgram);
    if (matched) {
      setAdapterId(matched.id);
      setAdapterCommand(matched.command ?? "");
    }
  }, [suggestedProgram, touched]);

  useEffect(() => {
    consoleRef.current?.scrollTo({ top: consoleRef.current.scrollHeight });
  }, [consoleLines.length]);

  const running = status !== "idle";
  const paused = status === "paused";
  const store = useDebugStore.getState();
  const breakpointCount = Object.values(breakpoints).reduce((sum, lines) => sum + lines.length, 0);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-[var(--cf-border)] p-2">
        <div className="flex items-center gap-1">
          <input
            value={program}
            onChange={(e) => {
              setTouched(true);
              setProgram(e.target.value);
            }}
            placeholder={t("debug.programPlaceholder")}
            disabled={running}
            className="min-w-0 flex-1 rounded-md border border-[var(--cf-border)] bg-[var(--cf-bg)] px-1.5 py-1 font-mono text-[11px] outline-none disabled:opacity-60"
          />
          {/* Which debugger runs it. Node is built in; the rest drive an installed adapter. */}
          <select
            value={adapterId}
            onChange={(e) => {
              setAdapterId(e.target.value);
              setAdapterCommand(adapterById(e.target.value).command ?? "");
            }}
            disabled={running}
            className="shrink-0 rounded-md border border-[var(--cf-border)] bg-[var(--cf-bg)] px-1 py-1 text-[11px] outline-none disabled:opacity-60"
          >
            {DEBUG_ADAPTERS.map((adapter) => (
              <option key={adapter.id} value={adapter.id}>
                {adapter.label}
              </option>
            ))}
          </select>
          {running ? (
            <button
              onClick={() => void store.stop()}
              title={t("debug.stop")}
              className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--cf-danger)] hover:bg-black/[0.05] dark:hover:bg-white/[0.08]"
            >
              <Square size={12} className="fill-current" />
            </button>
          ) : (
            <button
              onClick={() =>
                program.trim() &&
                void store.start(repoPath, program.trim(), adapterById(adapterId), adapterCommand)
              }
              disabled={!program.trim()}
              title={t("debug.start")}
              className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--cf-success)] hover:bg-black/[0.05] disabled:opacity-40 dark:hover:bg-white/[0.08]"
            >
              <Play size={12} className="fill-current" />
            </button>
          )}
        </div>

        {running && (
          <div className="mt-1.5 flex items-center gap-1">
            <button
              onClick={() => (paused ? void store.resume() : void store.pause())}
              title={paused ? t("debug.continue") : t("debug.pauseRun")}
              className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-black/[0.05] dark:hover:bg-white/[0.08]"
            >
              {paused ? <Play size={12} /> : <Square size={11} />}
            </button>
            <button
              onClick={() => void store.step("over")}
              disabled={!paused}
              title={t("debug.stepOver")}
              className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-black/[0.05] disabled:opacity-30 dark:hover:bg-white/[0.08]"
            >
              <Redo2 size={12} />
            </button>
            <button
              onClick={() => void store.step("into")}
              disabled={!paused}
              title={t("debug.stepInto")}
              className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-black/[0.05] disabled:opacity-30 dark:hover:bg-white/[0.08]"
            >
              <CornerDownRight size={12} />
            </button>
            <button
              onClick={() => void store.step("out")}
              disabled={!paused}
              title={t("debug.stepOut")}
              className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-black/[0.05] disabled:opacity-30 dark:hover:bg-white/[0.08]"
            >
              <CornerRightUp size={12} />
            </button>
            <span className="ml-auto text-[10px] text-[var(--cf-text-muted)]">
              {paused ? t("debug.paused") : t("debug.runningState")}
            </span>
          </div>
        )}

        {!running && adapterById(adapterId).command !== null && (
          <div className="mt-1.5">
            <input
              value={adapterCommand}
              onChange={(e) => setAdapterCommand(e.target.value)}
              placeholder={t("debug.adapterPlaceholder")}
              className="w-full rounded-md border border-[var(--cf-border)] bg-[var(--cf-bg)] px-1.5 py-1 font-mono text-[11px] outline-none"
            />
            <p className="mt-0.5 text-[10px] text-[var(--cf-text-muted)]">
              {t("debug.adapterHint", { install: adapterById(adapterId).install })}
            </p>
          </div>
        )}

        {!running && (
          <p className="mt-1.5 text-[10px] text-[var(--cf-text-muted)]">
            {breakpointCount > 0 ? t("debug.breakpointCount", { n: breakpointCount }) : t("debug.noBreakpoints")}
          </p>
        )}
        {error && <p className="mt-1.5 text-[10px] text-[var(--cf-danger)]">{error}</p>}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {paused && (
          <>
            <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
              {t("debug.callStack")}
            </p>
            {frames.map((frame, index) => (
              <button
                key={frame.id}
                onClick={() => {
                  void store.selectFrame(index);
                  if (frame.file.includes("/") || frame.file.includes("\\")) onOpenFrame(frame.file, frame.line);
                }}
                className={`flex w-full items-baseline gap-1.5 px-2 py-0.5 text-left ${
                  index === selectedFrame ? "bg-[var(--cf-accent-soft)]" : "hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
                }`}
              >
                <span className="shrink-0 font-mono text-[11px] text-[var(--cf-text)]">{frame.name}</span>
                <span className="truncate text-[10px] text-[var(--cf-text-muted)]">
                  {fileName(frame.file)}:{frame.line}
                </span>
              </button>
            ))}

            <p className="px-2 pt-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
              {t("debug.variables")}
            </p>
            {variables.length === 0 ? (
              <p className="px-2 py-1 text-[10px] text-[var(--cf-text-muted)]">{t("debug.noVariables")}</p>
            ) : (
              variables.map((variable) => (
                <VariableRow key={variable.name} variable={variable} depth={0} />
              ))
            )}
          </>
        )}
      </div>

      <div className="flex h-[38%] shrink-0 flex-col border-t border-[var(--cf-border)]">
        <div className="flex items-center gap-1 px-2 py-1">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
            {t("debug.console")}
          </span>
          <button
            onClick={() => store.clearConsole()}
            title={t("debug.clearConsole")}
            className="ml-auto text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
          >
            <Trash2 size={11} />
          </button>
        </div>
        <div ref={consoleRef} className="min-h-0 flex-1 overflow-auto px-2 pb-1 font-mono text-[10px]">
          {consoleLines.map((line, index) => (
            <div
              key={index}
              className={`whitespace-pre-wrap break-all ${
                line.kind === "error" || line.kind === "stderr"
                  ? "text-[var(--cf-danger)]"
                  : line.kind === "input"
                    ? "text-[var(--cf-accent)]"
                    : "text-[var(--cf-text-muted)]"
              }`}
            >
              {line.kind === "input" ? "› " : ""}
              {line.text}
            </div>
          ))}
        </div>
        <input
          value={expression}
          onChange={(e) => setExpression(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || !expression.trim()) return;
            e.preventDefault();
            void store.evaluate(expression.trim());
            setExpression("");
          }}
          // Only meaningful while paused: an expression needs a frame to be evaluated in.
          disabled={!paused}
          placeholder={paused ? t("debug.evaluatePlaceholder") : t("debug.evaluateDisabled")}
          className="shrink-0 border-t border-[var(--cf-border)] bg-transparent px-2 py-1 font-mono text-[11px] outline-none disabled:opacity-60"
        />
      </div>
    </div>
  );
}
