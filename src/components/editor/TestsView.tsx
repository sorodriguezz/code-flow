import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, ChevronDown, ChevronRight, CircleDashed, Loader2, Play, RefreshCw, RotateCcw, Search, ShieldCheck, XCircle } from "lucide-react";
import { FileGlyph } from "../common/FileGlyph";
import { Tooltip } from "../common/Tooltip";
import { iconButtonClass } from "../common/Button";
import { listRepoFiles, readFileText } from "../../lib/tauri/commands";
import { testCommand, testLanguageOf, testNamesIn } from "../../lib/testCommand";
import { findTestManifest, runTestCommand, type TestRunResult } from "../../lib/testRun";
import { currentPlatform } from "../../lib/platform";
import { useManagerFor } from "../../lib/useManagerFor";
import { pushErrorToast } from "../../state/toastStore";
import { COVERAGE_FILES, coverageSummary, useCoverageStore } from "../../lib/coverage";
import { useT } from "../../state/languageStore";

/** Test files listed at most — a monorepo with thousands is narrowed with the filter. */
const MAX_FILES = 400;

type Status = "running" | "passed" | "failed";

/** One run's key: the file, or `file::test`. */
const keyOf = (path: string, test?: string) => (test ? `${path}::${test}` : path);

/** Results live for the window's session, per repository, so closing the panel loses nothing. */
const results = new Map<string, Map<string, { status: Status; result?: TestRunResult }>>();

/**
 * The Tests tab — VS Code's Testing view, as far as it goes without a runner extension per language:
 * the repository's test files (found by name, as `testLanguageOf` knows them), each test a file
 * declares, and a ▶ on any of them that runs it with the ecosystem's runner (`testCommand`) to the
 * end — ✓ or ✗ from its exit code, and its output a click away. «Reejecutar fallidos» runs again
 * every file or test whose last run failed.
 *
 * The editor's right click («Ejecutar este test») still types the same command into a terminal, for
 * a run you want to watch or interact with.
 */
export function TestsView({ repoPath, onOpen }: { repoPath: string; onOpen: (path: string, line: number) => void }) {
  const t = useT();
  const manager = useManagerFor(repoPath, "").manager;
  const [files, setFiles] = useState<string[] | null>(null);
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState<Record<string, { name: string; line: number }[] | null>>({});
  const [, bump] = useState(0);
  const [shown, setShown] = useState<string | null>(null);
  const store = useMemo(() => {
    let map = results.get(repoPath);
    if (!map) {
      map = new Map();
      results.set(repoPath, map);
    }
    return map;
  }, [repoPath]);

  /** Coverage over the code — the report the runner left behind, read when switched on and again
   *  after every run while it stays on. */
  const coverageShown = useCoverageStore((s) => s.shown);
  const coverage = useCoverageStore((s) => (s.repoPath === repoPath ? s.report : null));
  const coverageSource = useCoverageStore((s) => (s.repoPath === repoPath ? s.source : null));
  const summary = useMemo(() => (coverage ? coverageSummary(coverage) : null), [coverage]);
  const toggleCoverage = async () => {
    const state = useCoverageStore.getState();
    if (state.shown) {
      state.setShown(false);
      return;
    }
    if (await state.load(repoPath)) state.setShown(true);
    else pushErrorToast(t("tests.coverageMissing", { files: COVERAGE_FILES.join(", ") }));
  };

  const load = () => {
    setFiles(null);
    void listRepoFiles(repoPath)
      .then((all) => setFiles(all.filter((path) => testLanguageOf(path, "") !== null).sort()))
      .catch(() => setFiles([]));
  };
  useEffect(load, [repoPath]);

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return (files ?? []).filter((path) => !needle || path.toLowerCase().includes(needle)).slice(0, MAX_FILES);
  }, [files, filter]);

  const toggle = async (path: string) => {
    if (open[path] !== undefined) {
      setOpen(({ [path]: _gone, ...rest }) => rest);
      return;
    }
    setOpen((prev) => ({ ...prev, [path]: null }));
    const text = await readFileText(repoPath, path).catch(() => "");
    const language = testLanguageOf(path, text);
    setOpen((prev) => ({ ...prev, [path]: language ? testNamesIn(language, text) : [] }));
  };

  const run = async (path: string, test?: { name: string; line: number }) => {
    const key = keyOf(path, test?.name);
    if (store.get(key)?.status === "running") return;
    const text = await readFileText(repoPath, path).catch(() => "");
    const language = testLanguageOf(path, text);
    if (!language) return;
    const manifest = await findTestManifest(repoPath, path, language);
    const command = testCommand({
      language,
      path,
      text,
      manifest,
      packageManager: manager,
      windows: currentPlatform() === "windows",
      line: test?.line,
    });
    if (!command) {
      pushErrorToast(t("tests.noRunner"));
      return;
    }
    store.set(key, { status: "running" });
    bump((n) => n + 1);
    try {
      const result = await runTestCommand(repoPath, command.cwd, command.command);
      store.set(key, { status: result.code === 0 ? "passed" : "failed", result: { ...result, output: `$ ${command.command}\n\n${result.output}` } });
    } catch (error) {
      store.set(key, { status: "failed", result: { code: null, output: String(error), millis: 0 } });
    }
    bump((n) => n + 1);
    // A run with coverage on rewrote the report; the colours follow it.
    if (useCoverageStore.getState().shown) void useCoverageStore.getState().load(repoPath);
  };

  const failed = [...store.entries()].filter(([, entry]) => entry.status === "failed").map(([key]) => key);
  const rerunFailed = async () => {
    for (const key of failed) {
      const [path, name] = key.split("::");
      if (!name) {
        await run(path);
        continue;
      }
      const text = await readFileText(repoPath, path).catch(() => "");
      const language = testLanguageOf(path, text);
      const test = language ? testNamesIn(language, text).find((entry) => entry.name === name) : undefined;
      await run(path, test ?? { name, line: 1 });
    }
  };

  const statusIcon = (key: string) => {
    const status = store.get(key)?.status;
    if (status === "running") return <Loader2 size={12} className="shrink-0 animate-spin text-[var(--cf-accent)]" />;
    if (status === "passed") return <CheckCircle2 size={12} className="shrink-0 text-[var(--cf-success)]" />;
    if (status === "failed") return <XCircle size={12} className="shrink-0 text-[var(--cf-danger)]" />;
    return <CircleDashed size={12} className="shrink-0 text-[var(--cf-text-faint)]" />;
  };

  const runButton = (onClick: () => void) => (
    <button
      type="button"
      onClick={onClick}
      aria-label={t("tests.run")}
      title={t("tests.run")}
      className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--cf-text-muted)] opacity-0 hover:text-[var(--cf-success)] group-hover:opacity-100"
    >
      <Play size={11} />
    </button>
  );

  const output = shown ? store.get(shown)?.result : undefined;

  return (
    <div className="flex h-full min-h-0">
      <div className="min-w-0 flex-1 overflow-auto">
        <div className="flex items-center gap-1 px-2 pb-1 pt-1.5">
          <div className="flex h-[24px] min-w-0 flex-1 items-center gap-1.5 rounded-md border border-[var(--cf-border)] px-2">
            <Search size={11} className="shrink-0 text-[var(--cf-text-faint)]" />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={t("tests.filter")}
              className="min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:text-[var(--cf-text-faint)]"
            />
          </div>
          <Tooltip side="top" label={t("tests.rerunFailed")}>
            <button
              type="button"
              onClick={() => void rerunFailed()}
              disabled={failed.length === 0}
              aria-label={t("tests.rerunFailed")}
              className={`${iconButtonClass({ size: "xs" })} disabled:opacity-40`}
            >
              <RotateCcw size={13} />
            </button>
          </Tooltip>
          <Tooltip
            side="top"
            label={t("tests.coverage")}
            description={
              coverageShown && summary && coverageSource
                ? t("tests.coverageSummary", {
                    percent: summary.total ? Math.round((summary.hit / summary.total) * 100) : 0,
                    source: coverageSource,
                  })
                : t("tests.coverageTip")
            }
          >
            <button
              type="button"
              onClick={() => void toggleCoverage()}
              aria-label={t("tests.coverage")}
              aria-pressed={coverageShown}
              className={iconButtonClass({ size: "xs", active: coverageShown })}
            >
              <ShieldCheck size={13} />
            </button>
          </Tooltip>
          <Tooltip side="top" label={t("tests.refresh")}>
            <button type="button" onClick={load} aria-label={t("tests.refresh")} className={iconButtonClass({ size: "xs" })}>
              <RefreshCw size={13} />
            </button>
          </Tooltip>
        </div>
        {files === null ? (
          <p className="flex items-center gap-1.5 px-3 py-2 text-[12px] text-[var(--cf-text-muted)]">
            <Loader2 size={12} className="animate-spin" />
            {t("tests.finding")}
          </p>
        ) : visible.length === 0 ? (
          <p className="px-3 py-2 text-[12px] text-[var(--cf-text-muted)]">{t("tests.none")}</p>
        ) : (
          visible.map((path) => {
            const tests = open[path];
            const cut = path.lastIndexOf("/");
            return (
              <div key={path}>
                <div className="group flex h-[24px] items-center gap-1.5 rounded-md pl-1.5 pr-2 hover:bg-[var(--cf-hover)]">
                  <button type="button" onClick={() => void toggle(path)} className="flex h-4 w-4 shrink-0 items-center justify-center text-[var(--cf-text-faint)]">
                    {tests === null ? <Loader2 size={11} className="animate-spin" /> : tests ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  </button>
                  <button type="button" onClick={() => setShown(path)} className="flex shrink-0">
                    {statusIcon(path)}
                  </button>
                  <button type="button" onClick={() => onOpen(path, 1)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
                    <FileGlyph path={path} size={12} />
                    <span className="shrink-0 text-[12px] text-[var(--cf-text)]">{cut < 0 ? path : path.slice(cut + 1)}</span>
                    <span className="min-w-0 truncate text-[11px] text-[var(--cf-text-faint)]">{cut < 0 ? "" : path.slice(0, cut)}</span>
                  </button>
                  {runButton(() => void run(path))}
                </div>
                {tests?.map((test) => {
                  const key = keyOf(path, test.name);
                  return (
                    <div key={key} className="group flex h-[22px] items-center gap-1.5 rounded-md pl-8 pr-2 hover:bg-[var(--cf-hover)]">
                      <button type="button" onClick={() => setShown(key)} className="flex shrink-0">
                        {statusIcon(key)}
                      </button>
                      <button type="button" onClick={() => onOpen(path, test.line)} className="min-w-0 flex-1 truncate text-left text-[12px] text-[var(--cf-text-muted)]">
                        {test.name}
                      </button>
                      {runButton(() => void run(path, test))}
                    </div>
                  );
                })}
                {tests && tests.length === 0 && <p className="pl-8 text-[11px] text-[var(--cf-text-faint)]">{t("tests.noneInFile")}</p>}
              </div>
            );
          })
        )}
      </div>
      {output && shown && (
        <div className="flex w-[45%] min-w-[260px] flex-col border-l border-[var(--cf-border)]">
          <div className="flex h-7 shrink-0 items-center gap-1.5 border-b border-[var(--cf-border)] px-2 text-[11px] text-[var(--cf-text-muted)]">
            {statusIcon(shown)}
            <span className="min-w-0 flex-1 truncate">{shown}</span>
            <span className="shrink-0 tabular-nums">{(output.millis / 1000).toFixed(1)} s</span>
            <button type="button" onClick={() => setShown(null)} className="shrink-0 hover:text-[var(--cf-text)]">
              ×
            </button>
          </div>
          <pre className="select-text min-h-0 flex-1 overflow-auto whitespace-pre-wrap px-2 py-1.5 font-mono text-[11px] leading-[1.45] text-[var(--cf-text)]">
            {output.output}
          </pre>
        </div>
      )}
    </div>
  );
}
