import { useEffect, useRef, useState } from "react";
import { LayoutGrid, Play, Save, Trash2 } from "lucide-react";
import { ContextMenu, type MenuItem } from "../common/ContextMenu";
import { Tooltip } from "../common/Tooltip";
import { useBenchStore } from "../../state/benchStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { usePackageManagerStore } from "../../state/packageManagerStore";
import { promptAction } from "../../state/promptStore";
import { pushErrorToast } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import { readFileText } from "../../lib/tauri/commands";
import { PACKAGE_JSON, isRunnableScriptName, scriptCommandLine } from "../../lib/packageScripts";
import type { LayoutPane } from "../../lib/bench/layouts";

/**
 * The bench's saved arrangements, and the repository's own scripts.
 *
 * # Why these two are one menu
 *
 * They answer the same question — "open the shells I actually use" — from the two places the answer
 * lives. A **layout** is one the user built and named ("dev" is a server, a test watcher and an
 * agent). A **script** is one the repository already declares in its `package.json`, where typing
 * `pnpm run dev` by hand is work the manifest already did.
 *
 * # What it costs
 *
 * The scripts are read when the menu opens and not before: a `package.json` is a file read, and
 * doing it per render — or on a timer — would be a read of every open project forever. The layouts
 * are a settings row, read once per workspace.
 *
 * Nothing starts by itself. A layout is processes; opening a window is not consent to start them.
 */
export function BenchLayoutMenu({ disabled }: { disabled: boolean }) {
  const t = useT();
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const project = useWorkspaceStore((s) => s.activeProject());
  const layouts = useBenchStore((s) => s.savedLayouts);
  const terminals = useBenchStore((s) => s.terminals);
  const activeTabId = useBenchStore((s) => s.activeTabId);
  const manager = usePackageManagerStore((s) => s.choice);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [scripts, setScripts] = useState<string[]>([]);
  const button = useRef<HTMLButtonElement>(null);

  // The workspace's own list, re-read when the workspace changes and at no other time.
  useEffect(() => {
    if (!workspaceId) return;
    void useBenchStore.getState().loadSavedLayouts(workspaceId);
  }, [workspaceId]);

  const fail = (error: unknown) => pushErrorToast(String(error));

  /** The repository's runnable scripts, read when the menu opens. */
  const readScripts = async () => {
    const repo = project?.local_path ?? "";
    if (!repo) {
      setScripts([]);
      return;
    }
    try {
      const text = await readFileText(repo, PACKAGE_JSON);
      const parsed: unknown = JSON.parse(text);
      const table = (parsed as { scripts?: Record<string, unknown> } | null)?.scripts ?? {};
      setScripts(Object.keys(table).filter((name) => isRunnableScriptName(name)));
    } catch {
      // No manifest, or one that is not JSON: the menu simply has no scripts in it, which is the
      // truth about this repository and not an error worth a toast.
      setScripts([]);
    }
  };

  const open = () => {
    const rect = button.current?.getBoundingClientRect();
    void readScripts();
    if (rect) setMenu({ x: rect.right - 4, y: rect.bottom + 2 });
  };

  /** The open tab's panes, as a layout would record them: where each shell is and what it is called. */
  const currentPanes = (): LayoutPane[] =>
    terminals
      .filter((terminal) => terminal.tab_id === activeTabId)
      .map((terminal) => ({ cwd: terminal.cwd, ...(terminal.title ? { title: terminal.title } : {}) }));

  const saveCurrent = () => {
    const panes = currentPanes();
    if (!workspaceId || panes.length === 0) return;
    void promptAction(t("bench.layoutName"), { confirmLabel: t("bench.layoutSave") }).then((name) => {
      if (!name?.trim()) return;
      // The commands are not recorded: the bench knows where each shell is, not what was typed into
      // it half an hour ago. The layout opens the arrangement, and the user adds the commands to it
      // by editing the row — which is also why saving twice under one name replaces it.
      void useBenchStore.getState().saveLayout(workspaceId, { name: name.trim(), panes }).catch(fail);
    });
  };

  const items: MenuItem[] = [
    ...layouts.map((layout) => ({
      label: layout.name,
      icon: Play,
      onClick: () => {
        if (workspaceId) void useBenchStore.getState().runLayout(workspaceId, layout.name).catch(fail);
      },
    })),
    ...(layouts.length > 0
      ? [
          {
            label: t("bench.layoutForget"),
            icon: Trash2,
            danger: true,
            onClick: () => {
              if (!workspaceId) return;
              void promptAction(t("bench.layoutForgetWhich"), { initial: layouts[0]?.name ?? "" }).then((name) => {
                if (name?.trim()) void useBenchStore.getState().removeLayout(workspaceId, name.trim()).catch(fail);
              });
            },
          },
        ]
      : []),
    {
      label: t("bench.layoutSaveCurrent"),
      icon: Save,
      separated: true,
      disabled: activeTabId === null || currentPanes().length === 0,
      onClick: saveCurrent,
    },
    // The repository's own, under the user's. `scriptCommandLine` is the same resolver the explorer's
    // play buttons use, so a pnpm repo gets `pnpm run x` here too.
    ...scripts.map((name, at) => ({
      label: t("bench.scriptRun", { name }),
      icon: Play,
      separated: at === 0,
      onClick: () => {
        const line = scriptCommandLine(manager ?? "npm", name);
        if (!workspaceId || !line || !project) return;
        void useBenchStore
          .getState()
          .runPanes(workspaceId, [{ cwd: project.local_path, title: name, command: line }])
          .catch(fail);
      },
    })),
  ];

  return (
    <>
      <Tooltip label={t("bench.layouts")}>
        <button
          ref={button}
          type="button"
          onClick={open}
          disabled={disabled}
          aria-haspopup="menu"
          aria-label={t("bench.layouts")}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--cf-text-muted)] transition-colors hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)] disabled:pointer-events-none disabled:opacity-40"
        >
          <LayoutGrid size={13} />
        </button>
      </Tooltip>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />}
    </>
  );
}
