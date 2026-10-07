import { useEffect, useMemo, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { ArrowDownToLine, ArrowUpFromLine, FilePlus2, FileUp, MoreHorizontal, Play, RotateCw, ScrollText, Square } from "lucide-react";
import { Button } from "../common/Button";
import { ContextMenu } from "../common/ContextMenu";
import { ComposeBuilderDialog } from "./ComposeBuilderDialog";
import { RowAction, StateDot } from "./containerBits";
import { engineMenu, runtimeLabel } from "./containerActions";
import { DataTable, EmptyLine, LiveMark, LoadingLine, PageHead, PageToolbar, SearchField, Td, Th, trClass } from "./ui";
import { menuAt, useEngineList, type MenuState } from "./pageBits";
import { COMPOSE_PROJECT, composeOptions, composeProjectName, composeProjects, dirOf, baseName, firstRead, type ComposeProject } from "./pageModel";
import { confirmAction } from "../../state/confirmStore";
import { promptAction } from "../../state/promptStore";
import { useContainersJobsStore } from "../../state/containersJobsStore";
import { useContainersStore } from "../../state/containersStore";
import { useT } from "../../state/languageStore";
import type { TranslationKey } from "../../lib/i18n/translations";
import type { ContainerRow, RuntimeInfo } from "../../types/containers";

/**
 * An engine's Compose projects, read from its containers' labels: how many of each run, its services,
 * the folder it came from. Brought up (from its files, or from any compose file picked here — or one
 * written here, «New compose»), stopped, started, restarted, taken down; `up`, `pull` and the
 * project's log run as the manager's jobs (see `JobsPanel`), where what Compose prints can be
 * followed — and keep running if the page is left.
 */

export function ComposePage({ runtime }: { runtime: RuntimeInfo }) {
  const t = useT();
  const context = useContainersStore((s) => s.contextOf(runtime.id));
  const { list, rows } = useEngineList<ContainerRow>(runtime.id, context, "containers");
  const act = useContainersStore((s) => s.act);
  const busy = useContainersStore((s) => s.busy);
  const select = useContainersStore((s) => s.select);
  const refreshList = useContainersStore((s) => s.refreshList);
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState<MenuState>(null);
  const [building, setBuilding] = useState(false);
  const startJob = useContainersJobsStore((s) => s.start);
  const ctr = runtime.id === "ctr";
  const place = context || runtimeLabel(runtime.id, t);

  useEffect(() => {
    if (runtime.running) void refreshList(runtime.id, "containers");
  }, [runtime.id, runtime.running, context, refreshList]);

  const projects = useMemo(() => composeProjects(rows), [rows]);
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return projects;
    return projects.filter((p) => p.name.toLowerCase().includes(needle) || p.services.some((s) => s.toLowerCase().includes(needle)) || p.projectDir.toLowerCase().includes(needle));
  }, [projects, query]);

  const run = (project: ComposeProject, action: string, label: TranslationKey) =>
    void act({ runtime: runtime.id, context, object: "project", action, ids: [project.name], options: composeOptions(project), label: t(label, { name: project.name }) });
  const down = async (project: ComposeProject) => {
    if (await confirmAction(t("containers.confirmDown", { name: project.name, context: place }), true, t("containers.project.down"))) run(project, "down", "containers.done.down");
  };
  const up = (name: string, projectDir: string, configFiles: string) =>
    void startJob(
      t("containers.m.compose.upping", { name }),
      { kind: "composeUp", runtime: runtime.id, context, target: name, projectDir, configFiles },
      { refresh: ["containers", "images", "volumes", "networks"], done: t("containers.done.up", { name }) },
    );
  const logs = (project: ComposeProject) =>
    void startJob(
      t("containers.m.compose.logsOf", { name: project.name }),
      { kind: "projectLogs", runtime: runtime.id, context, target: project.name, tail: 300, ...composeOptions(project) },
      { follow: true },
    );
  /** Any compose file on this computer: its folder is the project's, its name the folder's unless
   *  another is given. */
  const upFromFile = async () => {
    const picked = await openDialog({ title: t("containers.m.compose.pickFile"), filters: [{ name: "Compose", extensions: ["yaml", "yml"] }] });
    if (typeof picked !== "string") return;
    const dir = dirOf(picked);
    const suggested = composeProjectName(dir);
    const name = await promptAction(t("containers.m.compose.namePrompt", { file: baseName(picked) }), {
      initial: suggested,
      placeholder: suggested || "app",
      confirmLabel: t("containers.project.up"),
      allowEmpty: !!suggested,
      validate: (value) => {
        const typed = value.trim();
        if (!typed) return suggested ? null : t("containers.m.compose.nameInvalid");
        return COMPOSE_PROJECT.test(typed) ? null : t("containers.m.compose.nameInvalid");
      },
    });
    if (name === null) return;
    up(name.trim() || suggested, dir, picked);
  };
  const rowMenu = (project: ComposeProject) =>
    engineMenu({ runtime: runtime.id, context, object: "project", project: { name: project.name, rows: project.rows }, t, act, select: () => openProject(project) });
  const openProject = (project: ComposeProject) => select({ runtime: runtime.id, context, namespace: null, object: "project", id: project.name, name: project.name });

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageHead title={t("containers.m.section.compose")} sub={projects.length ? String(projects.length) : undefined}>
        {/* Writing a file needs no engine; bringing it up does, and the dialog says so itself. */}
        <Button size="sm" variant="secondary" onClick={() => setBuilding(true)} disabled={ctr}>
          <FilePlus2 size={13} />
          {t("containers.m.compose.new")}
        </Button>
        <Button size="sm" variant="primary" onClick={() => void upFromFile()} disabled={!runtime.running || ctr}>
          <FileUp size={13} />
          {t("containers.m.compose.upFromFile")}
        </Button>
      </PageHead>
      <PageToolbar>
        <SearchField value={query} onChange={setQuery} placeholder={t("containers.m.compose.search")} />
        <div className="flex-1" />
        {runtime.running && <LiveMark />}
      </PageToolbar>
      <div className="flex min-h-0 flex-1 flex-col [&_table]:table-fixed">
        {ctr ? (
          <EmptyLine>{t("containers.m.compose.unsupported")}</EmptyLine>
        ) : !runtime.running ? (
          <EmptyLine>{runtime.problem ?? t("containers.notRunningHint")}</EmptyLine>
        ) : list?.error ? (
          <EmptyLine>{list.error}</EmptyLine>
        ) : firstRead(list) ? (
          <LoadingLine />
        ) : shown.length === 0 ? (
          <EmptyLine>{projects.length ? t("containers.m.compose.noMatch") : t("containers.m.compose.none")}</EmptyLine>
        ) : (
          <DataTable minWidth={720}>
            <thead>
              <tr>
                <Th width={170}>{t("containers.m.compose.col.project")}</Th>
                <Th width={170}>{t("containers.m.col.state")}</Th>
                <Th>{t("containers.m.compose.col.services")}</Th>
                <Th>{t("containers.m.compose.col.folder")}</Th>
                <Th align="right" width={128}>
                  {t("containers.m.col.actions")}
                </Th>
              </tr>
            </thead>
            <tbody>
              {shown.map((project) => {
                const total = project.rows.length;
                const tone = project.running === 0 ? "idle" : project.running === total ? "ok" : "warn";
                const working = busy[`project|${project.name}`];
                const canUp = !!project.configFiles;
                return (
                  <tr key={project.name} className={trClass(false)} onContextMenu={(e) => setMenu(menuAt(e, rowMenu(project)))}>
                    <Td>
                      <button onClick={() => openProject(project)} title={t("containers.m.compose.openDetail")} className="block max-w-full truncate text-left font-semibold text-[var(--cf-text)] hover:text-[var(--cf-accent)] hover:underline">
                        {project.name}
                      </button>
                    </Td>
                    <Td>
                      <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                        <StateDot tone={tone} />
                        <span className={project.running ? "text-[var(--cf-text)]" : "text-[var(--cf-text-muted)]"}>{t("containers.projectCount", { up: project.running, total })}</span>
                      </span>
                    </Td>
                    <Td>
                      <span className="block truncate text-[var(--cf-text-muted)]" title={project.services.join(", ")}>
                        {project.services.join(", ") || "—"}
                      </span>
                    </Td>
                    <Td>
                      <span className="block truncate font-mono text-[11.5px] text-[var(--cf-text-muted)]" title={[project.projectDir, ...project.configFiles.split(",").filter(Boolean)].filter(Boolean).join("\n")}>
                        {project.projectDir || "—"}
                      </span>
                    </Td>
                    <Td className="w-[128px]">
                      <div className="flex items-center justify-end gap-0.5">
                        <RowAction
                          label={canUp ? t("containers.project.up") : `${t("containers.project.up")} — ${t("containers.m.compose.noFiles")}`}
                          disabled={!canUp || working}
                          onClick={() => up(project.name, project.projectDir, project.configFiles)}
                        >
                          <ArrowUpFromLine size={12} />
                        </RowAction>
                        {project.running > 0 ? (
                          <>
                            <RowAction label={t("containers.project.stop")} disabled={working} onClick={() => run(project, "stop", "containers.done.stop")}>
                              <Square size={12} />
                            </RowAction>
                            <RowAction label={t("containers.project.restart")} disabled={working} onClick={() => run(project, "restart", "containers.done.restart")}>
                              <RotateCw size={12} />
                            </RowAction>
                          </>
                        ) : (
                          <RowAction label={t("containers.project.start")} disabled={working} onClick={() => run(project, "start", "containers.done.start")}>
                            <Play size={12} className="text-[var(--cf-success)]" />
                          </RowAction>
                        )}
                        <RowAction label={t("containers.tab.logs")} onClick={() => logs(project)}>
                          <ScrollText size={12} />
                        </RowAction>
                        <RowAction label={t("containers.project.down")} danger disabled={working} onClick={() => void down(project)}>
                          <ArrowDownToLine size={12} />
                        </RowAction>
                        <RowAction label={t("containers.m.moreActions")} onClick={(e) => setMenu(menuAt(e, rowMenu(project)))}>
                          <MoreHorizontal size={13} />
                        </RowAction>
                      </div>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </DataTable>
        )}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {building && <ComposeBuilderDialog runtime={runtime} context={context} onClose={() => setBuilding(false)} onUp={up} />}
    </div>
  );
}
