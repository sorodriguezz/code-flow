import { useEffect, useState } from "react";
import { FilePlus2, FileJson, Loader2, Play, RefreshCw } from "lucide-react";
import { Tooltip } from "../common/Tooltip";
import { Button, iconButtonClass } from "../common/Button";
import { createFile, readFileText, writeFileText } from "../../lib/tauri/commands";
import { parseTasks, TASKS_TEMPLATE, type RepoTask } from "../../lib/vscodeTasks";
import { currentPlatform } from "../../lib/platform";
import { useManagerFor } from "../../lib/useManagerFor";
import { useTerminalStore } from "../../state/terminalStore";
import { pushErrorToast } from "../../state/toastStore";
import { useT } from "../../state/languageStore";

const TASKS_FILE = ".vscode/tasks.json";

/**
 * The Tareas tab: the tasks of the repository's `.vscode/tasks.json` (see `lib/vscodeTasks`), each a
 * ▶ that runs it in the terminal dock — one terminal per task, reused on the next run, as a script
 * from package.json is. No file yet: one button writes VS Code's own template and opens it.
 */
export function TasksView({
  repoPath,
  projectId,
  activeFile,
  onOpen,
}: {
  repoPath: string;
  projectId: string;
  /** The file in front, for `${file}` and friends. */
  activeFile: string | null;
  onOpen: (path: string, line: number) => void;
}) {
  const t = useT();
  const manager = useManagerFor(repoPath, "").manager;
  const [tasks, setTasks] = useState<RepoTask[] | null>(null);
  const [missing, setMissing] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let live = true;
    setTasks(null);
    readFileText(repoPath, TASKS_FILE)
      .then((text) => {
        if (!live) return;
        setMissing(false);
        setTasks(parseTasks(text, { repoPath, file: activeFile, platform: currentPlatform(), packageManager: manager }));
      })
      .catch(() => {
        if (!live) return;
        setMissing(true);
        setTasks([]);
      });
    return () => {
      live = false;
    };
  }, [repoPath, activeFile, manager, version]);

  const run = (task: RepoTask) => {
    if (!task.command) return;
    void useTerminalStore
      .getState()
      .runCommand(projectId, { cwd: task.cwd, command: task.command, reuseKey: `task:${task.label}`, title: task.label })
      .catch((e: unknown) => pushErrorToast(String(e)));
  };

  const create = async () => {
    try {
      // Created first, with `.vscode/` if it is not there; refused rather than overwriting one.
      await createFile(repoPath, TASKS_FILE);
      await writeFileText(repoPath, TASKS_FILE, TASKS_TEMPLATE);
      setVersion((v) => v + 1);
      onOpen(TASKS_FILE, 1);
    } catch (e) {
      pushErrorToast(String(e));
    }
  };

  return (
    <div>
      <div className="flex items-center gap-1 px-2 pb-1 pt-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--cf-text-faint)]">{TASKS_FILE}</span>
        {!missing && (
          <Tooltip side="top" label={t("tasks.open")}>
            <button type="button" onClick={() => onOpen(TASKS_FILE, 1)} aria-label={t("tasks.open")} className={iconButtonClass({ size: "xs" })}>
              <FileJson size={13} />
            </button>
          </Tooltip>
        )}
        <Tooltip side="top" label={t("tests.refresh")}>
          <button type="button" onClick={() => setVersion((v) => v + 1)} aria-label={t("tests.refresh")} className={iconButtonClass({ size: "xs" })}>
            <RefreshCw size={13} />
          </button>
        </Tooltip>
      </div>
      {tasks === null ? (
        <p className="px-3 py-2">
          <Loader2 size={12} className="animate-spin text-[var(--cf-text-muted)]" />
        </p>
      ) : missing ? (
        <div className="flex items-center gap-3 px-3 py-2">
          <span className="text-[12px] text-[var(--cf-text-muted)]">{t("tasks.missing")}</span>
          <Button size="sm" variant="secondary" onClick={() => void create()}>
            <FilePlus2 size={12} />
            {t("tasks.create")}
          </Button>
        </div>
      ) : tasks.length === 0 ? (
        <p className="px-3 py-2 text-[12px] text-[var(--cf-text-muted)]">{t("tasks.none")}</p>
      ) : (
        tasks.map((task) => (
          <div key={task.label} className="group flex h-[26px] items-center gap-2 rounded-md pl-2 pr-2 hover:bg-[var(--cf-hover)]">
            <button
              type="button"
              onClick={() => run(task)}
              disabled={!task.command}
              aria-label={t("tasks.run", { label: task.label })}
              title={task.command ? t("tasks.run", { label: task.label }) : t("tasks.noCommand")}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--cf-text-muted)] hover:text-[var(--cf-success)] disabled:opacity-40"
            >
              <Play size={11} />
            </button>
            <span className="shrink-0 text-[12px] text-[var(--cf-text)]">{task.label}</span>
            {task.group && <span className="shrink-0 rounded bg-[var(--cf-surface-2)] px-1 text-[10px] text-[var(--cf-text-faint)]">{task.group}</span>}
            <span className="min-w-0 truncate font-mono text-[11px] text-[var(--cf-text-faint)]">{task.command ?? ""}</span>
          </div>
        ))
      )}
    </div>
  );
}
