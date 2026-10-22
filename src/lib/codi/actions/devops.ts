import { useUiStore } from "../../../state/uiStore";
import { useRepoStore } from "../../../state/repoStore";
import { useTerminalStore } from "../../../state/terminalStore";
import { pipelinesAvailable, useVcsConnectionsStore } from "../../../state/vcsConnectionsStore";
import { foldName } from "../fuzzy";
import { CodiError, type CodiAction } from "../registry";
import type { ContainerRow, RuntimeId } from "../../../types/containers";
import type { PipelineRun, Project } from "../../../types/domain";
import { defineAction, flag, optionalText, params, pickByName, requireProject, say, spokenList, text } from "./shared";

/**
 * What runs beside the code: the containers in the dock, the repository's pipelines, and the AI
 * review of a pull request. Main window only — the containers panel and the assistant live there,
 * and the Pipelines tab of a repository island is that window's own React state.
 */

/** The engines whose containers are listed — Kubernetes lists pods, which are another conversation. */
const ENGINES: RuntimeId[] = ["docker", "podman", "nerdctl", "ctr"];

interface FoundContainer {
  runtime: RuntimeId;
  context: string | null;
  row: ContainerRow;
}

/** Every container of every running engine, read fresh. */
async function allContainers(): Promise<FoundContainer[]> {
  const { listKey, useContainersStore } = await import("../../../state/containersStore");
  const store = useContainersStore.getState();
  if (!store.detected) await store.detect();
  const engines = useContainersStore.getState().runtimes.filter((r) => r.running && ENGINES.includes(r.id));
  if (engines.length === 0) throw new CodiError("no container engine is running", say("codi.say.noEngine"));
  const found: FoundContainer[] = [];
  for (const engine of engines) {
    await useContainersStore.getState().refreshList(engine.id, "containers");
    const context = useContainersStore.getState().contextOf(engine.id);
    const rows = (useContainersStore.getState().lists[listKey(engine.id, context, null, "containers")]?.rows ?? []) as ContainerRow[];
    for (const row of rows) found.push({ runtime: engine.id, context, row });
  }
  return found;
}

const isUp = (row: ContainerRow) => row.state === "running" || row.state === "restarting";

function containerActions(): CodiAction[] {
  return [
    defineAction({
      id: "containers.list",
      title: {
        en: "List the containers of every running engine (Docker, Podman…) with their state.",
        es: "Lista los contenedores de cada motor en marcha (Docker, Podman…) con su estado.",
      },
      aliases: {
        es: ["que contenedores hay", "lista los contenedores", "que contenedores corren", "mis contenedores", "docker ps"],
        en: ["which containers", "list the containers", "running containers", "my containers", "docker ps"],
      },
      params: params(),
      risk: "read",
      where: "main",
      run: async () => {
        const found = await allContainers();
        const up = found.filter((c) => isUp(c.row));
        return {
          result: {
            containers: found.slice(0, 40).map((c) => ({
              name: c.row.name,
              state: c.row.state,
              image: c.row.image,
              ...(c.row.project ? { compose: c.row.project } : {}),
              ...(c.runtime !== "docker" ? { engine: c.runtime } : {}),
            })),
            total: found.length,
            running: up.length,
          },
          say: up.length ? say("codi.say.containersUp", { n: up.length, list: spokenList(up.map((c) => c.row.name), 3) }) : say("codi.say.noContainersUp"),
        };
      },
    }),
    defineAction({
      id: "container.restart",
      title: { en: "Restart a container by name (loose match). Asks the user first.", es: "Reinicia un contenedor por nombre (coincidencia flexible). Pide confirmación." },
      aliases: {
        es: ["reinicia el contenedor", "reinicia el docker", "reinicia el servicio de docker", "reinicia"],
        en: ["restart the container", "restart container", "restart"],
      },
      params: params({ name: text("The container's name, as said.") }, ["name"]),
      risk: "destructive",
      where: "main",
      run: async ({ name }) => {
        const found = pickByName(await allContainers(), String(name), (c) => c.row.name, "container", (c) => isUp(c.row));
        const { useContainersStore } = await import("../../../state/containersStore");
        const { translate } = await import("../../../state/languageStore");
        // The row's own «Reiniciar», with the label its toast carries. It answers the engine's
        // output, or `null` when the engine refused (and has said so in a toast).
        const output = await useContainersStore.getState().act({
          runtime: found.runtime,
          context: found.context,
          object: "container",
          action: "restart",
          ids: [found.row.id],
          label: translate("containers.done.restart", { name: found.row.name }),
        });
        if (output === null) throw new CodiError(`restarting ${found.row.name} failed`, say("codi.say.containerFailed", { name: found.row.name }));
        return { result: { restarted: found.row.name }, say: say("codi.say.containerRestarted", { name: found.row.name }) };
      },
    }),
    defineAction({
      id: "container.logs",
      title: { en: "Open a container's logs in the containers panel, by name (loose match).", es: "Abre los logs de un contenedor en el panel de contenedores, por nombre (coincidencia flexible)." },
      aliases: {
        es: ["muestra los logs de", "abre los logs de", "logs del contenedor", "ver los logs de", "registros de"],
        en: ["show the logs of", "open the logs of", "container logs", "logs for"],
      },
      params: params({ name: text("The container's name, as said.") }, ["name"]),
      risk: "read",
      where: "main",
      run: async ({ name }) => {
        const found = pickByName(await allContainers(), String(name), (c) => c.row.name, "container", (c) => isUp(c.row));
        const { useContainersStore } = await import("../../../state/containersStore");
        useTerminalStore.getState().showDock("containers");
        useContainersStore.getState().setNav({ runtime: found.runtime, section: "containers" });
        // A container's detail opens on its logs.
        useContainersStore.getState().select({
          runtime: found.runtime,
          context: found.context,
          namespace: null,
          object: "container",
          id: found.row.id,
          name: found.row.name,
        });
        return { result: { logs: found.row.name, state: found.row.state }, say: say("codi.say.containerLogs", { name: found.row.name }) };
      },
    }),
  ];
}

/** The open repository, with its Pipelines tab — or a refusal that says why there is none. */
function requirePipelines(): Project {
  const project = requireProject();
  if (!pipelinesAvailable(project, useVcsConnectionsStore.getState())) {
    throw new CodiError(
      "this repository has no Pipelines tab: it is not linked to a connected host with CI",
      say("codi.say.noPipelines", { name: project.name }),
    );
  }
  return project;
}

/** The run a spoken name means: a number ("123", "#123"), a workflow's name (its newest run), or —
 *  with neither — the newest run of the branch on screen, else the newest of all. */
function pickRun(runs: PipelineRun[], name: string | undefined, branch: string | null): PipelineRun {
  if (runs.length === 0) throw new CodiError("this repository has no pipeline runs yet", say("codi.say.noRuns"));
  if (name) {
    const number = Number(name.replace(/^#/, "").trim());
    if (Number.isInteger(number) && number > 0) {
      const byNumber = runs.find((r) => r.number === number);
      if (!byNumber) throw new CodiError(`no run #${number} in the loaded list`, say("codi.say.notFound", { name }));
      return byNumber;
    }
    const workflows = [...new Set(runs.map((r) => r.name))];
    const workflow = pickByName(workflows, name, (w) => w, "pipeline");
    // Newest first is the list's own order; the run on this branch wins over one elsewhere.
    const same = runs.filter((r) => foldName(r.name) === foldName(workflow));
    return same.find((r) => r.branch === branch) ?? same[0];
  }
  return runs.find((r) => r.branch === branch) ?? runs[0];
}

function pipelineActions(): CodiAction[] {
  return [
    defineAction({
      id: "pipelines.open",
      title: { en: "Show the open repository's Pipelines tab (CI/CD).", es: "Muestra la pestaña Pipelines (CI/CD) del repositorio abierto." },
      aliases: {
        es: ["abre los pipelines", "muestra los pipelines", "abre el ci", "como va el ci", "abre las integraciones continuas"],
        en: ["open the pipelines", "show the pipelines", "open ci", "how is ci doing"],
      },
      params: params(),
      risk: "navigate",
      where: "main",
      run: async () => {
        const project = requirePipelines();
        useUiStore.getState().setActiveView("pipelines");
        return { result: { view: "pipelines", repo: project.name }, say: say("codi.say.viewOpened", { name: say("tabbar.pipelines") }) };
      },
    }),
    defineAction({
      id: "pipeline.rerun",
      title: {
        en: "Run a pipeline again: by workflow name or run number, else the newest run of this branch. failedOnly reruns just the failed jobs where the host can. Asks the user first.",
        es: "Vuelve a ejecutar un pipeline: por nombre de workflow o número de ejecución; si no, la más reciente de esta rama. failedOnly repite solo los jobs fallidos donde el host lo permite. Pide confirmación.",
      },
      aliases: {
        es: ["relanza el pipeline", "vuelve a correr el pipeline", "reejecuta el pipeline", "repite el pipeline", "relanza el ci", "rerun"],
        en: ["rerun the pipeline", "run the pipeline again", "retry the pipeline", "rerun ci", "rerun"],
      },
      params: params({
        name: optionalText("A workflow's name or a run number. Left out: the newest run of this branch."),
        failedOnly: flag("Only the jobs that failed."),
      }),
      risk: "destructive",
      where: "main",
      run: async ({ name, failedOnly }) => {
        const project = requirePipelines();
        const { useCiStore } = await import("../../../state/ciStore");
        if (!useCiStore.getState().fetchedProjects[project.id]) await useCiStore.getState().load(project.id, { quiet: true });
        const runs = useCiStore.getState().runsByProject[project.id] ?? [];
        const run = pickRun(runs, name ? String(name) : undefined, useRepoStore.getState().status?.current_branch ?? null);
        const { rerunPipeline } = await import("../../tauri/commands");
        try {
          await rerunPipeline(project.id, run.id, failedOnly === true);
        } catch (error) {
          throw new CodiError(`the host refused the rerun: ${String(error)}`, say("codi.say.rerunFailed", { name: run.name }));
        }
        void useCiStore.getState().load(project.id, { quiet: true });
        return {
          result: { rerun: run.name, number: run.number, branch: run.branch, failedOnly: failedOnly === true || undefined },
          say: say("codi.say.rerunStarted", { name: run.name }),
        };
      },
    }),
  ];
}

function reviewActions(): CodiAction[] {
  return [
    defineAction({
      id: "review.pr",
      title: {
        en: "Start the AI review of a pull request of the open repository, by number — in its own tab of the assistant, in the background; a notification says when it ends.",
        es: "Empieza la revisión con IA de un pull request del repositorio abierto, por número, en su propia pestaña del asistente y en segundo plano; una notificación avisa cuando termina.",
      },
      aliases: {
        es: ["revisa el pr", "revisa el pull request", "haz review del pr", "revision del pr", "revisa la pr"],
        en: ["review the pr", "review pull request", "review pr", "start a review of"],
      },
      params: params({ number: { type: "integer", minimum: 1, description: "The pull request's number." } }, ["number"]),
      risk: "write",
      where: "main",
      run: async ({ number }) => {
        const project = requireProject();
        const prId = Number(number);
        const { usePrStore } = await import("../../../state/prStore");
        const pr = await usePrStore.getState().ensureProjectPr(project.id, prId);
        if (!pr) throw new CodiError(`no pull request #${prId} in ${project.name} (or the host did not answer)`, say("codi.say.prNotFound", { n: prId }));
        const { useAiPanelStore } = await import("../../../state/aiPanelStore");
        // What «Revisar» from a link does: the PR in its own tab, the list refreshed behind it, the
        // review started — and tracked by the jobs store, so it outlives whatever screen is next.
        useAiPanelStore.getState().open({ kind: "pr", projectId: project.id, pr });
        void usePrStore.getState().loadPullRequests(project.id);
        usePrStore.getState().reviewPr({ kind: "project", projectId: project.id }, pr);
        return { result: { reviewing: prId, title: pr.title, repo: project.name }, say: say("codi.say.reviewStarted", { n: prId }) };
      },
    }),
  ];
}

export function devopsActions(): CodiAction[] {
  return [...containerActions(), ...pipelineActions(), ...reviewActions()];
}
