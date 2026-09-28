import { useEffect, useRef, useState } from "react";
import { CornerDownRight, CornerRightUp, Play, Redo2, Square, Trash2 } from "lucide-react";
import { Select } from "../common/Select";
import { Tooltip } from "../common/Tooltip";
import { iconButtonClass } from "../common/Button";
import { explorerHeadClass, explorerTitleClass, fieldClass, rowClass } from "../common/recipes";
import { useDebugStore } from "../../state/debugStore";
import { DEBUG_ADAPTERS, adapterById, adapterForFile } from "../../lib/debugAdapters";
import { useT } from "../../state/languageStore";
import { BreakpointsSection, SectionHead, VariableRow, WatchSection } from "./DebugSections";

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
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
  const scopes = useDebugStore((s) => s.scopes);
  const pauseReason = useDebugStore((s) => s.pauseReason);
  const pauseDescription = useDebugStore((s) => s.pauseDescription);
  const sessionDebugger = useDebugStore((s) => s.sessionDebugger);
  const consoleLines = useDebugStore((s) => s.console);
  const error = useDebugStore((s) => s.error);
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
  /** Whose exception filters the breakpoints list offers: the running session's debugger, else the
   *  one picked to start with. */
  const debuggerId = running && sessionDebugger ? sessionDebugger : adapterId;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* The head every panel of the activity rail wears. */}
      <div className={explorerHeadClass}>
        <span className={`${explorerTitleClass} mr-auto`}>
          <span className="truncate">{t("debug.title")}</span>
        </span>
      </div>

      <div className="shrink-0 border-b border-[var(--cf-border)] px-3 pb-3">
        <div className="flex items-center gap-1">
          <input
            value={program}
            onChange={(e) => {
              setTouched(true);
              setProgram(e.target.value);
            }}
            placeholder={t("debug.programPlaceholder")}
            disabled={running}
            className={fieldClass({ size: "sm", className: "flex-1 font-mono" })}
          />
          {/* Which debugger runs it. Node is built in; the rest drive an installed adapter.
              The shared `Select` rather than a native one, at the same 11px metrics as the field
              beside it — a native `<select>` sets its own height on macOS and sat a couple of
              pixels taller than the input no matter what it was padded with. */}
          <div className="w-[104px] shrink-0">
            <Select
              size="compact"
              ariaLabel={t("debug.adapter")}
              value={adapterId}
              onChange={(next) => {
                setAdapterId(next);
                setAdapterCommand(adapterById(next).command ?? "");
              }}
              options={DEBUG_ADAPTERS.map((adapter) => ({
                value: adapter.id,
                label: adapter.label,
              }))}
              disabled={running}
            />
          </div>
          {running ? (
            <Tooltip side="bottom" label={t("debug.stop")}>
              <button onClick={() => void store.stop()} aria-label={t("debug.stop")} className={iconButtonClass({ size: "sm" })}>
                <Square size={13} className="fill-current text-[var(--cf-danger)]" />
              </button>
            </Tooltip>
          ) : (
            <Tooltip side="bottom" label={t("debug.start")}>
              <button
                onClick={() =>
                  program.trim() &&
                  void store.start(repoPath, program.trim(), adapterById(adapterId), adapterCommand)
                }
                disabled={!program.trim()}
                aria-label={t("debug.start")}
                className={iconButtonClass({ size: "sm" })}
              >
                <Play size={14} className="fill-current text-[var(--cf-success)]" />
              </button>
            </Tooltip>
          )}
        </div>

        {running && (
          <div className="mt-2 flex items-center gap-0.5">
            <Tooltip side="bottom" label={paused ? t("debug.continue") : t("debug.pauseRun")}>
              <button
                onClick={() => (paused ? void store.resume() : void store.pause())}
                aria-label={paused ? t("debug.continue") : t("debug.pauseRun")}
                className={iconButtonClass({ size: "sm" })}
              >
                {paused ? <Play size={14} /> : <Square size={13} />}
              </button>
            </Tooltip>
            <Tooltip side="bottom" label={t("debug.stepOver")}>
              <button
                onClick={() => void store.step("over")}
                disabled={!paused}
                aria-label={t("debug.stepOver")}
                className={iconButtonClass({ size: "sm" })}
              >
                <Redo2 size={14} />
              </button>
            </Tooltip>
            <Tooltip side="bottom" label={t("debug.stepInto")}>
              <button
                onClick={() => void store.step("into")}
                disabled={!paused}
                aria-label={t("debug.stepInto")}
                className={iconButtonClass({ size: "sm" })}
              >
                <CornerDownRight size={14} />
              </button>
            </Tooltip>
            <Tooltip side="bottom" label={t("debug.stepOut")}>
              <button
                onClick={() => void store.step("out")}
                disabled={!paused}
                aria-label={t("debug.stepOut")}
                className={iconButtonClass({ size: "sm" })}
              >
                <CornerRightUp size={14} />
              </button>
            </Tooltip>
            <span className="ml-auto text-[11px] text-[var(--cf-text-faint)]">
              {paused ? t("debug.paused") : t("debug.runningState")}
            </span>
          </div>
        )}

        {!running && adapterById(adapterId).command !== null && (
          <div className="mt-2">
            <input
              value={adapterCommand}
              onChange={(e) => setAdapterCommand(e.target.value)}
              placeholder={t("debug.adapterPlaceholder")}
              className={fieldClass({ size: "sm", className: "w-full font-mono" })}
            />
            <p className="mt-1 text-[11px] leading-snug text-[var(--cf-text-faint)]">
              {t("debug.adapterHint", { install: adapterById(adapterId).install })}
            </p>
          </div>
        )}

        {error && <p className="mt-2 whitespace-pre-wrap text-[11px] text-[var(--cf-danger)]">{error}</p>}
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-2 pb-2">
        {paused && (
          <>
            {(pauseReason === "exception" || pauseReason === "promiseRejection") && (
              <p className="px-1.5 pt-2 text-[11px] text-[var(--cf-danger)]" title={pauseDescription ?? undefined}>
                {t("debug.pausedOnException")}
                {pauseDescription ? ` · ${pauseDescription}` : ""}
              </p>
            )}
            <SectionHead title={t("debug.callStack")} />
            {frames.map((frame, index) => (
              <button
                key={frame.id}
                onClick={() => {
                  // Any frame, not only the top one: its own scopes, its own watches.
                  void store.selectFrame(index);
                  if (frame.file.includes("/") || frame.file.includes("\\")) onOpenFrame(frame.file, frame.line);
                }}
                className={rowClass(index === selectedFrame, "h-[26px]")}
              >
                <span className="shrink-0 font-mono text-[12px] text-[var(--cf-text)]">{frame.name}</span>
                <span className="truncate font-mono text-[11px] text-[var(--cf-text-faint)]">
                  {fileName(frame.file)}:{frame.line}
                </span>
              </button>
            ))}

            <SectionHead title={t("debug.variables")} />
            {scopes.length === 0 ? (
              <p className="px-1.5 py-1 text-[11px] text-[var(--cf-text-faint)]">{t("debug.noVariables")}</p>
            ) : (
              scopes.map((scope) => <VariableRow key={`${scope.name}-${scope.object_id}`} variable={scope} depth={0} />)
            )}
          </>
        )}
        <WatchSection paused={paused} />
        <BreakpointsSection repoPath={repoPath} debuggerId={debuggerId} onOpen={onOpenFrame} />
      </div>

      {/* The console: a log well, sunk a step below the panel it sits in. */}
      <div className="flex h-[38%] shrink-0 flex-col border-t border-[var(--cf-border)] bg-[var(--cf-sunken)]">
        <div className="flex h-8 shrink-0 items-center gap-1 pl-3 pr-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]">
            {t("debug.console")}
          </span>
          <Tooltip side="bottom" label={t("debug.clearConsole")}>
            <button
              onClick={() => store.clearConsole()}
              aria-label={t("debug.clearConsole")}
              className={iconButtonClass({ size: "xs", className: "ml-auto" })}
            >
              <Trash2 size={13} />
            </button>
          </Tooltip>
        </div>
        <div ref={consoleRef} className="min-h-0 flex-1 overflow-auto px-3 pb-1 font-mono text-[11px] leading-[1.55]">
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
          // Flush with the well rather than a boxed field: this is the console's own prompt line.
          className="h-[30px] shrink-0 border-t border-[var(--cf-border)] bg-transparent px-3 font-mono text-[12px] text-[var(--cf-text)] outline-none placeholder:text-[var(--cf-text-faint)] disabled:opacity-60"
        />
      </div>
    </div>
  );
}
