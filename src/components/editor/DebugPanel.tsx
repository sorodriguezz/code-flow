import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Copy, CornerDownRight, CornerRightUp, FileJson, FilePlus2, Pause, Play, Redo2, Square, Trash2 } from "lucide-react";
import { ResizeHandle } from "../common/ResizeHandle";
import { Select } from "../common/Select";
import { Tooltip } from "../common/Tooltip";
import { iconButtonClass } from "../common/Button";
import { explorerHeadClass, explorerTitleClass, fieldClass, rowClass } from "../common/recipes";
import { useDebugStore } from "../../state/debugStore";
import { useServicesStore } from "../../state/servicesStore";
import { DEBUG_ADAPTERS, adapterById, adapterForFile } from "../../lib/debugAdapters";
import { launchTemplate, parseLaunch, type LaunchEntry } from "../../lib/vscodeLaunch";
import { currentPlatform } from "../../lib/platform";
import { createFile, readFileText, writeFileText } from "../../lib/tauri/commands";
import { pushErrorToast } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import { BreakpointsSection, FoldSection, VariableRow, WatchSection } from "./DebugSections";
import { DebugValue, useFoldedSection, useStoredNumber } from "./debugValue";

const LAUNCH_FILE = ".vscode/launch.json";
/** The console's floor when open: its heading, a couple of lines and the prompt. */
const CONSOLE_MIN = 96;

/** A frame in code that is not the user's: an installed dependency, or the runtime's own. */
function isLibraryFrame(file: string): boolean {
  return /[\\/]node_modules[\\/]|^node:|^internal[\\/]|site-packages[\\/]/.test(file);
}

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
  onOpenFile,
}: {
  repoPath: string;
  /** The active editor file, offered as the thing to run when it's a script. */
  suggestedProgram: string | null;
  onOpenFrame: (file: string, line: number) => void;
  /** Opens a repo-relative file — `.vscode/launch.json`. */
  onOpenFile: (path: string, line: number) => void;
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
  const stepping = useDebugStore((s) => s.stepping);
  const serviceId = useDebugStore((s) => s.serviceId);
  const serviceName = useServicesStore((s) => (serviceId ? s.services.find((service) => service.id === serviceId)?.name : undefined));
  const [program, setProgram] = useState("");
  const [adapterId, setAdapterId] = useState("node");
  /** Overrides the preset's binary — for an adapter that isn't on PATH, or a custom one. */
  const [adapterCommand, setAdapterCommand] = useState("");
  const [expression, setExpression] = useState("");
  /** What was evaluated, oldest first — ↑ and ↓ in the prompt walk it, as in every console. */
  const [history, setHistory] = useState<string[]>([]);
  const [historyAt, setHistoryAt] = useState(-1);
  const consoleRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [consoleFolded, toggleConsole] = useFoldedSection("console");
  const [consoleHeight, setConsoleHeight, commitConsoleHeight] = useStoredNumber("consoleHeight", 220);
  /** The console may take the body but for room to see a few rows of the sections above it. */
  const consoleMax = () => Math.max(CONSOLE_MIN, (bodyRef.current?.clientHeight ?? 600) - 140);
  /** `.vscode/launch.json`'s configurations; `null` while reading, `[]` with `launchMissing` when
   *  there is no file. */
  const [configs, setConfigs] = useState<LaunchEntry[] | null>(null);
  const [launchMissing, setLaunchMissing] = useState(false);
  const [launchVersion, setLaunchVersion] = useState(0);
  /** The configuration picked, by name; `""` is the program typed by hand. */
  const [configName, setConfigName] = useState("");
  const config = configs?.find((entry) => entry.name === configName) ?? null;

  const relativeFile = (() => {
    if (!suggestedProgram) return null;
    const root = repoPath.replace(/[\\/]+$/, "").replace(/\\/g, "/");
    const file = suggestedProgram.replace(/\\/g, "/");
    return file.startsWith(`${root}/`) ? file.slice(root.length + 1) : null;
  })();

  useEffect(() => {
    let live = true;
    readFileText(repoPath, LAUNCH_FILE)
      .then((text) => {
        if (!live) return;
        setLaunchMissing(false);
        const entries = parseLaunch(text, { repoPath, file: relativeFile, platform: currentPlatform() });
        setConfigs(entries);
        // The first configuration that can start here is the default, as VS Code's picker opens on
        // the first entry — but never over one the user picked.
        setConfigName((current) =>
          current && entries.some((entry) => entry.name === current) ? current : (entries.find((entry) => !entry.unsupported)?.name ?? ""),
        );
      })
      .catch(() => {
        if (!live) return;
        setLaunchMissing(true);
        setConfigs([]);
        setConfigName("");
      });
    return () => {
      live = false;
    };
  }, [repoPath, relativeFile, launchVersion]);

  const createLaunch = async () => {
    try {
      await createFile(repoPath, LAUNCH_FILE);
      await writeFileText(repoPath, LAUNCH_FILE, launchTemplate(suggestedProgram ? (adapterForFile(suggestedProgram)?.id ?? null) : null));
      setLaunchVersion((v) => v + 1);
      onOpenFile(LAUNCH_FILE, 1);
    } catch (e) {
      pushErrorToast(String(e));
    }
  };

  const startConfig = (entry: LaunchEntry) => {
    if (entry.unsupported || !entry.adapterId) return;
    const adapter = adapterById(entry.adapterId);
    void useDebugStore
      .getState()
      .start(entry.cwd, entry.program, adapter, adapter.command ?? undefined, { args: entry.args, launch: entry.launch });
  };

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

  // Follows new output only while the reader is at the bottom, and keyed on the last line rather
  // than the count: the console is capped, and once full its length stopped changing — so new lines
  // stopped scrolling into view — while a reader scrolled up was dragged back down on every line.
  const lastLine = consoleLines[consoleLines.length - 1];
  const followConsole = useRef(true);
  useEffect(() => {
    const el = consoleRef.current;
    if (el && followConsole.current) el.scrollTop = el.scrollHeight;
  }, [lastLine]);

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
        {/* A service being debugged: said, with its two ways out told apart — leaving it running
            undebugged, or stopping it. The launch controls below have nothing to do with it. */}
        {serviceId ? (
          <div className="rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] px-2.5 py-2">
            <div className="flex items-center gap-1.5">
              <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-[var(--cf-accent-fill)]" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--cf-text)]">
                {t("debug.debuggingService", { name: serviceName ?? t("debug.aService") })}
              </span>
            </div>
            <div className="mt-1.5 flex gap-1.5">
              <button
                type="button"
                onClick={() => void store.detach()}
                title={t("debug.detachHint")}
                className="flex-1 rounded-md border border-[var(--cf-border)] px-2 py-1 text-[11px] text-[var(--cf-text)] hover:bg-[var(--cf-hover)]"
              >
                {t("debug.detach")}
              </button>
              <button
                type="button"
                onClick={() => void store.stop()}
                className="flex-1 rounded-md border border-[color-mix(in_oklab,var(--cf-danger)_40%,var(--cf-border))] px-2 py-1 text-[11px] text-[var(--cf-danger)] hover:bg-[color-mix(in_oklab,var(--cf-danger)_8%,transparent)]"
              >
                {t("debug.stopService")}
              </button>
            </div>
          </div>
        ) : (
          <>
        {/* `.vscode/launch.json`: its configurations by name, or a button that writes one. */}
        <div className="mb-1.5 flex items-center gap-1">
          {configs && configs.length > 0 ? (
            <div className="min-w-0 flex-1">
              <Select
                size="compact"
                ariaLabel={t("debug.config")}
                value={configName}
                onChange={setConfigName}
                disabled={running}
                options={[
                  { value: "", label: t("debug.configManual") },
                  ...configs.map((entry) => ({
                    value: entry.name,
                    label: entry.unsupported ? `${entry.name} — ${t("debug.configUnsupported", { reason: entry.unsupported })}` : entry.name,
                  })),
                ]}
              />
            </div>
          ) : (
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--cf-text-faint)]">{LAUNCH_FILE}</span>
          )}
          {launchMissing ? (
            <Tooltip side="bottom" label={t("debug.createLaunch")}>
              <button type="button" onClick={() => void createLaunch()} aria-label={t("debug.createLaunch")} className={iconButtonClass({ size: "xs" })}>
                <FilePlus2 size={13} />
              </button>
            </Tooltip>
          ) : (
            <Tooltip side="bottom" label={t("debug.openLaunch")}>
              <button type="button" onClick={() => onOpenFile(LAUNCH_FILE, 1)} aria-label={t("debug.openLaunch")} className={iconButtonClass({ size: "xs" })}>
                <FileJson size={13} />
              </button>
            </Tooltip>
          )}
        </div>
        {config ? (
          <div className="flex items-center gap-1">
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--cf-text-muted)]" title={config.program || config.cwd}>
              {config.program ? fileName(config.program) : String(config.launch.module ?? config.cwd)}
            </span>
            {running ? (
              <Tooltip side="bottom" label={t("debug.stop")}>
                <button onClick={() => void store.stop()} aria-label={t("debug.stop")} className={iconButtonClass({ size: "sm" })}>
                  <Square size={13} className="fill-current text-[var(--cf-danger)]" />
                </button>
              </Tooltip>
            ) : (
              <Tooltip side="bottom" label={t("debug.start")}>
                <button
                  onClick={() => startConfig(config)}
                  disabled={Boolean(config.unsupported)}
                  aria-label={t("debug.start")}
                  className={iconButtonClass({ size: "sm" })}
                >
                  <Play size={14} className="fill-current text-[var(--cf-success)]" />
                </button>
              </Tooltip>
            )}
          </div>
        ) : (
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
        )}
        {config?.preLaunchTask && !running && (
          <p className="mt-1 text-[11px] leading-snug text-[var(--cf-text-faint)]">{t("debug.preLaunchTask", { task: config.preLaunchTask })}</p>
        )}

          </>
        )}
        {running && (
          <div className="mt-2 flex items-center gap-0.5">
            <Tooltip side="bottom" label={paused ? t("debug.continue") : t("debug.pauseRun")}>
              <button
                onClick={() => (paused ? void store.resume() : void store.pause())}
                aria-label={paused ? t("debug.continue") : t("debug.pauseRun")}
                className={iconButtonClass({ size: "sm" })}
              >
                {paused ? <Play size={14} /> : <Pause size={14} />}
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

        {!running && !config && adapterById(adapterId).command !== null && (
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

      <div ref={bodyRef} className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-auto px-2 pb-2">
          {(paused || (stepping && frames.length > 0)) && (
            // While a step runs, the last stop stays — dimmed and inert — until the next replaces it.
            <div className={paused ? undefined : "pointer-events-none opacity-55 transition-opacity"}>
              {paused && (pauseReason === "exception" || pauseReason === "promiseRejection") && (
                <p className="mx-1 mt-2 rounded-md bg-[color-mix(in_oklab,var(--cf-danger)_10%,transparent)] px-2 py-1.5 text-[11px] leading-snug text-[var(--cf-danger)]" title={pauseDescription ?? undefined}>
                  {t("debug.pausedOnException")}
                  {pauseDescription ? ` · ${pauseDescription}` : ""}
                </p>
              )}
              {/* Stopped in code that is not the user's — a dependency, the runtime: said, with the
                  way out, rather than looking exactly like a stop in their own file. */}
              {paused && frames[selectedFrame] && isLibraryFrame(frames[selectedFrame].file) && (
                <div className="mx-1 mt-2 rounded-md bg-[color-mix(in_oklab,var(--cf-warning)_10%,transparent)] px-2 py-1.5 text-[11px] leading-snug text-[var(--cf-text)]">
                  {t("debug.pausedInLibrary")}
                  <span className="mt-1 flex gap-1.5">
                    <button type="button" onClick={() => void store.step("out")} className="rounded border border-[var(--cf-border)] px-1.5 py-[1px] hover:bg-[var(--cf-hover)]">
                      {t("debug.stepOut")}
                    </button>
                    <button type="button" onClick={() => void store.resume()} className="rounded border border-[var(--cf-border)] px-1.5 py-[1px] hover:bg-[var(--cf-hover)]">
                      {t("debug.continue")}
                    </button>
                  </span>
                </div>
              )}
              <FoldSection id="callstack" title={t("debug.callStack")} count={frames.filter((frame) => !frame.is_async).length}>
                {frames.map((frame, index) => {
                  const library = isLibraryFrame(frame.file);
                  const firstAsync = frame.is_async && !frames[index - 1]?.is_async;
                  return (
                    <div key={`${frame.id || "async"}-${index}`}>
                      {/* Where the awaited callers start: everything below ran before an `await`. */}
                      {firstAsync && (
                        <div className="flex items-center gap-2 px-1.5 pb-0.5 pt-1.5 text-[10px] uppercase tracking-[0.06em] text-[var(--cf-text-faint)]">
                          <span className="h-px flex-1 bg-[var(--cf-border)]" />
                          async
                          <span className="h-px flex-1 bg-[var(--cf-border)]" />
                        </div>
                      )}
                      <button
                        onClick={() => {
                          // Any live frame, not only the top one: its own scopes, its own watches. An
                          // async frame has none to give — it only opens where it was awaited from.
                          if (!frame.is_async) void store.selectFrame(index);
                          if (frame.file.includes("/") || frame.file.includes("\\")) onOpenFrame(frame.file, frame.line);
                        }}
                        className={rowClass(index === selectedFrame && !frame.is_async, "h-[26px]")}
                        title={`${frame.file}:${frame.line}${library ? ` · ${t("debug.libraryFrame")}` : ""}`}
                      >
                        <span
                          className={`shrink-0 font-mono text-[12px] ${
                            frame.is_async || library ? "text-[var(--cf-text-faint)]" : "text-[var(--cf-text)]"
                          } ${frame.is_async ? "italic" : ""}`}
                        >
                          {frame.name || t("debug.anonymous")}
                        </span>
                        <span className={`ml-auto truncate font-mono text-[11px] text-[var(--cf-text-faint)] ${library ? "opacity-70" : ""}`}>
                          {fileName(frame.file)}:{frame.line}
                        </span>
                      </button>
                    </div>
                  );
                })}
              </FoldSection>

              <FoldSection id="variables" title={t("debug.variables")}>
                {scopes.length === 0 ? (
                  <p className="px-1.5 py-1 text-[11px] text-[var(--cf-text-faint)]">{t("debug.noVariables")}</p>
                ) : (
                  scopes.map((scope) => <VariableRow key={`${scope.name}-${scope.object_id}`} variable={scope} depth={0} />)
                )}
              </FoldSection>
            </div>
          )}
          {!running && (
            <p className="px-2 pt-3 text-[11px] leading-snug text-[var(--cf-text-faint)]">{t("debug.idleHint")}</p>
          )}
          <WatchSection paused={paused} />
          <BreakpointsSection repoPath={repoPath} debuggerId={debuggerId} onOpen={onOpenFrame} />
        </div>

        {/* The console: a log well, sunk a step below the panel. Its top edge drags it taller or
            shorter, its heading folds it down to that heading — it used to be a fixed 38% slab
            that neither moved nor got out of the way (user report, 2026-11-18). */}
        {!consoleFolded && (
          <ResizeHandle
            axis="y"
            value={Math.min(consoleHeight, consoleMax())}
            min={CONSOLE_MIN}
            max={consoleMax()}
            invert
            onChange={setConsoleHeight}
            onCommit={commitConsoleHeight}
          />
        )}
        <div
          style={consoleFolded ? undefined : { height: Math.min(consoleHeight, consoleMax()) }}
          className={`flex shrink-0 flex-col bg-[var(--cf-sunken)] ${consoleFolded ? "border-t border-[var(--cf-border)]" : ""}`}
        >
          <div className="flex h-8 shrink-0 items-center gap-1 pl-1.5 pr-1.5">
            <button
              type="button"
              onClick={toggleConsole}
              aria-expanded={!consoleFolded}
              className="flex min-w-0 items-center gap-1 rounded px-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)] hover:text-[var(--cf-text-muted)]"
            >
              {consoleFolded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
              {t("debug.console")}
              {consoleLines.length > 0 && (
                <span className="ml-0.5 rounded-full bg-[var(--cf-press)] px-1.5 text-[10px] font-medium normal-case tracking-normal tabular-nums">
                  {consoleLines.length}
                </span>
              )}
            </button>
            <span className="flex-1" />
            {consoleLines.length > 0 && (
              <Tooltip side="bottom" label={t("debug.copyConsole")}>
                <button
                  onClick={() => void navigator.clipboard.writeText(consoleLines.map((line) => (line.kind === "input" ? `› ${line.text}` : line.text)).join("\n"))}
                  aria-label={t("debug.copyConsole")}
                  className={iconButtonClass({ size: "xs" })}
                >
                  <Copy size={12} />
                </button>
              </Tooltip>
            )}
            <Tooltip side="bottom" label={t("debug.clearConsole")}>
              <button onClick={() => store.clearConsole()} aria-label={t("debug.clearConsole")} className={iconButtonClass({ size: "xs" })}>
                <Trash2 size={12} />
              </button>
            </Tooltip>
          </div>
          {!consoleFolded && (
            <>
              <div
                ref={consoleRef}
                onScroll={(e) => {
                  const el = e.currentTarget;
                  followConsole.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
                }}
                className="min-h-0 flex-1 overflow-auto px-2 pb-1 font-mono text-[11.5px] leading-[1.55]"
              >
                {consoleLines.length === 0 && (
                  <p className="px-1 py-1 font-sans text-[11px] text-[var(--cf-text-faint)]">{t("debug.consoleEmpty")}</p>
                )}
                {consoleLines.map((line, index) =>
                  line.kind === "result" && line.objectId ? (
                    // An object answers as a tree, opened in place like a variable.
                    <VariableRow key={index} variable={{ name: "←", value: line.text, object_id: line.objectId }} depth={0} />
                  ) : (
                    <div
                      key={index}
                      className={`flex gap-1.5 whitespace-pre-wrap break-all rounded px-1 ${
                        line.kind === "error" || line.kind === "stderr"
                          ? "bg-[color-mix(in_oklab,var(--cf-danger)_8%,transparent)] text-[var(--cf-danger)]"
                          : line.kind === "input"
                            ? "text-[var(--cf-accent)]"
                            : "text-[var(--cf-text-muted)]"
                      }`}
                    >
                      {line.kind === "input" && <span className="shrink-0 select-none">›</span>}
                      {line.kind === "result" && <span className="shrink-0 select-none text-[var(--cf-text-faint)]">←</span>}
                      {line.kind === "result" ? <DebugValue value={line.text} className="whitespace-pre-wrap" /> : <span>{line.text}</span>}
                    </div>
                  ),
                )}
              </div>
              <div className="flex h-[30px] shrink-0 items-center gap-1.5 border-t border-[var(--cf-border)] px-3">
                <span className={`select-none font-mono text-[12px] ${paused ? "text-[var(--cf-accent)]" : "text-[var(--cf-text-faint)]"}`}>›</span>
                <input
                  value={expression}
                  onChange={(e) => {
                    setExpression(e.target.value);
                    setHistoryAt(-1);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "ArrowUp" && history.length > 0) {
                      e.preventDefault();
                      const at = historyAt < 0 ? history.length - 1 : Math.max(0, historyAt - 1);
                      setHistoryAt(at);
                      setExpression(history[at]);
                      return;
                    }
                    if (e.key === "ArrowDown" && historyAt >= 0) {
                      e.preventDefault();
                      const at = historyAt + 1;
                      if (at >= history.length) {
                        setHistoryAt(-1);
                        setExpression("");
                      } else {
                        setHistoryAt(at);
                        setExpression(history[at]);
                      }
                      return;
                    }
                    if (e.key !== "Enter" || !expression.trim()) return;
                    e.preventDefault();
                    const asked = expression.trim();
                    void store.evaluate(asked);
                    setHistory((list) => [...list.filter((item) => item !== asked), asked].slice(-50));
                    setHistoryAt(-1);
                    setExpression("");
                  }}
                  // Only meaningful while paused: an expression needs a frame to be evaluated in.
                  disabled={!paused}
                  placeholder={paused ? t("debug.evaluatePlaceholder") : t("debug.evaluateDisabled")}
                  spellCheck={false}
                  className="min-w-0 flex-1 bg-transparent font-mono text-[12px] text-[var(--cf-text)] outline-none placeholder:text-[var(--cf-text-faint)] disabled:opacity-60"
                />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
