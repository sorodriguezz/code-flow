import { useUiStore } from "../../../state/uiStore";
import { useRepoStore } from "../../../state/repoStore";
import { useTerminalStore } from "../../../state/terminalStore";
import { pipelinesAvailable, useVcsConnectionsStore } from "../../../state/vcsConnectionsStore";
import { foldName } from "../fuzzy";
import { CodiError, type CodiAction, type CodiOutcome } from "../registry";
import type { ContainerRow, KubeRow, RuntimeId } from "../../../types/containers";
import type { PipelineRun, Project } from "../../../types/domain";
import { readContainer, readRun } from "../diagnose";
import {
  afterColon,
  defineAction,
  findProject,
  flag,
  optionalText,
  outOfSight,
  params,
  pickByName,
  requireProject,
  say,
  showOffer,
  showParam,
  spokenList,
  tellWhenDone,
  text,
  watchStore,
  workspaceName,
} from "./shared";
import { useWorkspaceStore } from "../../../state/workspaceStore";

/**
 * What runs beside the code: the containers in the dock, the repository's pipelines, and the AI
 * review of a pull request. Main window only — the containers panel and the assistant live there,
 * and the Pipelines tab of a repository island is that window's own React state.
 */

/** The engines whose containers are listed — a cluster's pods are read apart (`clusterPods`). */
const ENGINES: RuntimeId[] = ["docker", "podman", "nerdctl", "ctr"];

interface FoundContainer {
  runtime: RuntimeId;
  context: string | null;
  row: ContainerRow;
}

/** Every container of every running engine, read fresh — or a refusal when no engine runs. */
async function allContainers(): Promise<FoundContainer[]> {
  const found = await engineContainers();
  if (found === null) throw new CodiError("no container engine is running", say("codi.say.noEngine"));
  return found;
}

/** Every container of every running engine, read fresh; `null` when no engine runs. */
async function engineContainers(): Promise<FoundContainer[] | null> {
  const { listKey, useContainersStore } = await import("../../../state/containersStore");
  const store = useContainersStore.getState();
  if (!store.detected) await store.detect();
  const engines = useContainersStore.getState().runtimes.filter((r) => r.running && ENGINES.includes(r.id));
  if (engines.length === 0) return null;
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

/** How long the cluster may take to list its pods before the answer goes without them. */
const POD_READ_MS = 6000;

/** The pods of the cluster the panel is connected to (in its namespace, or all), read fresh;
 *  `null` when no cluster is connected, `rows: null` when it did not answer in time. */
async function clusterPods(): Promise<{ context: string; rows: KubeRow[] | null } | null> {
  const { listKey, useContainersStore } = await import("../../../state/containersStore");
  const store = useContainersStore.getState();
  if (!store.runtimes.some((r) => r.id === "kubernetes" && r.running)) return null;
  const context = store.contextOf("kubernetes");
  if (!context) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((resolve) => (timer = setTimeout(() => resolve("late"), POD_READ_MS)));
  const read = await Promise.race([store.refreshList("kubernetes", "pods").then(() => "read" as const), late]).finally(() => clearTimeout(timer));
  const list = useContainersStore.getState().lists[listKey("kubernetes", context, useContainersStore.getState().namespaceOf(context), "pods")];
  if (read === "late" || !list || list.error) return { context, rows: null };
  return { context, rows: list.rows as KubeRow[] };
}

function containerActions(): CodiAction[] {
  return [
    defineAction({
      id: "containers.list",
      title: {
        en: "List the containers of every running engine (Docker, Podman…) with their state, and count the pods of the Kubernetes cluster the panel is connected to.",
        es: "Lista los contenedores de cada motor en marcha (Docker, Podman…) con su estado, y cuenta los pods del clúster de Kubernetes al que está conectado el panel.",
      },
      aliases: {
        es: ["lista los contenedores", "mis contenedores", "docker ps", "contenedores corriendo", "estado de los contenedores"],
        en: ["list the containers", "running containers", "my containers", "docker ps", "container status"],
      },
      // Asked, not ordered: answered without opening the panel (user, 2026-10-22: «codi cuántos
      // contenedores tengo corriendo en local?»).
      questions: {
        es: [
          "cuantos contenedores", "cuantos contenedores tengo", "cuantos contenedores hay", "cuantos contenedores tengo corriendo", "cuantos contenedores estan corriendo",
          "cuantos contenedores hay corriendo", "cuantos contenedores corren", "cuantos contenedores activos", "cuantos contenedores levantados", "que contenedores",
          "que contenedores hay", "que contenedores tengo", "que contenedores estan corriendo", "que contenedores corren", "cuales contenedores", "hay contenedores",
        ],
        en: ["how many containers", "how many containers are running", "how many containers do i have running", "which containers", "which containers are running", "what containers", "are there containers", "are any containers running"],
      },
      params: params(),
      risk: "read",
      where: "main",
      frequent: true,
      run: async () => {
        // A cluster's pods are containers too (user, 2026-10-22): said apart, with the cluster's name,
        // since it is rarely this machine.
        const [found, cluster] = await Promise.all([engineContainers(), clusterPods().catch(() => null)]);
        if (found === null && cluster === null) throw new CodiError("no container engine is running and no cluster is connected", say("codi.say.noEngine"));
        const containers = found ?? [];
        const up = containers.filter((c) => isUp(c.row));
        const said: string[] = [];
        if (found !== null) {
          said.push(up.length ? say("codi.say.containersUp", { n: up.length, list: spokenList(up.map((c) => c.row.name), 3) }) : say("codi.say.noContainersUp"));
        }
        let pods: Record<string, unknown> | undefined;
        if (cluster && cluster.rows === null) {
          said.push(say("codi.say.podsUnread", { context: cluster.context }));
          pods = { context: cluster.context, read: false };
        } else if (cluster && cluster.rows) {
          const running = cluster.rows.filter((p) => p.status === "Running");
          const troubled = cluster.rows.filter((p) => p.tone === "bad");
          said.push(say("codi.say.podsUp", { context: cluster.context, n: running.length }));
          if (troubled.length) said.push(say("codi.say.podsTrouble", { list: spokenList(troubled.map((p) => p.name), 3) }));
          pods = { context: cluster.context, total: cluster.rows.length, running: running.length, troubled: troubled.slice(0, 10).map((p) => ({ name: p.name, namespace: p.namespace, status: p.status })) };
        }
        return {
          result: {
            containers: containers.slice(0, 40).map((c) => ({
              name: c.row.name,
              state: c.row.state,
              image: c.row.image,
              ...(c.row.project ? { compose: c.row.project } : {}),
              ...(c.runtime !== "docker" ? { engine: c.runtime } : {}),
            })),
            total: containers.length,
            running: up.length,
            ...(pods ? { pods } : {}),
          },
          say: said.join(" "),
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
    defineAction({
      id: "container.why",
      title: {
        en: "Why a container stopped, restarts or is unhealthy — its exit code, when, and its last error line — said without opening the panel. Offers the AI's reading of the log.",
        es: "Por qué un contenedor se detuvo, se reinicia o está enfermo —su código de salida, cuándo y su última línea de error—, sin abrir el panel. Ofrece que la IA lea el registro.",
      },
      aliases: { es: ["diagnostica el contenedor", "estado del contenedor", "revisa el contenedor"], en: ["diagnose the container", "check the container", "container health"] },
      questions: {
        es: [
          "por que cayo el contenedor", "por que se cayo el contenedor", "por que se detuvo el contenedor", "por que murio el contenedor", "por que fallo el contenedor",
          "por que se reinicia el contenedor", "que le paso al contenedor", "como esta el contenedor",
        ],
        en: ["why did the container stop", "why did the container die", "why did the container crash", "why is the container restarting", "what happened to the container", "how is the container"],
      },
      params: params({ name: text("The container's name, as said.") }, ["name"]),
      risk: "read",
      where: "main",
      frequent: true,
      run: async ({ name }) => {
        // The one that is down wins a tie: the question is about the one that fell.
        const found = pickByName(await allContainers(), String(name), (c) => c.row.name, "container", (c) => !isUp(c.row));
        const { containersContainerDetail, containersLogsTail } = await import("../../tauri/containersCommands");
        const [detail, log] = await Promise.all([
          containersContainerDetail(found.runtime, found.context, found.row.id, false).catch(() => null),
          containersLogsTail(found.runtime, found.context, found.row.id, 60).catch(() => ""),
        ]);
        const reading = readContainer(found.row, detail, log);
        return {
          result: { container: found.row.name, state: found.row.state, exitCode: detail?.exitCode ?? found.row.exitCode, oomKilled: detail?.oomKilled ?? undefined, restarts: detail?.restartCount ?? undefined, health: detail?.health ?? undefined },
          say: reading.sentence,
          ...(reading.troubled && log.trim()
            ? { offer: { action: "container.explain", params: { name: found.row.name }, question: say("codi.say.offerExplain") } }
            : {}),
        };
      },
    }),
    defineAction({
      id: "container.explain",
      title: {
        en: "Have the AI read a container's recent log and say why it failed, in the background — the answer is said when ready.",
        es: "Hace que la IA lea el registro reciente de un contenedor y diga por qué falló, en segundo plano; la respuesta se dice cuando está.",
      },
      aliases: { es: ["analiza el registro del contenedor", "analiza los logs del contenedor", "analiza el log de"], en: ["analyse the container log", "analyze the logs of", "explain the log of"] },
      params: params({ name: text("The container's name, as said.") }, ["name"]),
      risk: "read",
      where: "main",
      run: async ({ name }) => {
        const found = pickByName(await allContainers(), String(name), (c) => c.row.name, "container", (c) => !isUp(c.row));
        const { containersLogsTail } = await import("../../tauri/containersCommands");
        const { codiExplain } = await import("../../tauri/codiCommands");
        const log = await containersLogsTail(found.runtime, found.context, found.row.id, 400);
        if (!log.trim()) throw new CodiError(`${found.row.name}'s log is empty`, say("codi.say.emptyLog", { name: found.row.name }));
        const question = say("codi.say.explainQuestion", { name: found.row.name, state: found.row.status || found.row.state });
        await codiExplain(found.row.name, question, log);
        return { result: { explaining: found.row.name }, say: say("codi.say.explaining", { name: found.row.name }) };
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
      id: "pipeline.status",
      title: {
        en: "How a repository's latest pipeline run went or is going — which, on which branch, when — said without opening anything. `repo` and `workspace` by name (any workspace); left out, the open repository.",
        es: "Cómo le fue o le va a la ejecución más reciente del pipeline de un repositorio —cuál, en qué rama, cuándo—, sin abrir nada. `repo` y `workspace` por nombre (cualquier workspace); sin ellos, el repositorio abierto.",
      },
      aliases: { es: ["estado del pipeline", "estado del ultimo pipeline", "ultimo pipeline"], en: ["pipeline status", "last pipeline", "latest pipeline"] },
      questions: {
        es: [
          "como va el pipeline", "como va el ultimo pipeline", "como esta el pipeline", "como esta el ultimo pipeline", "como le fue al pipeline", "como quedo el pipeline",
          "paso el pipeline", "fallo el pipeline", "como va el ci", "como esta el ci", "como van los pipelines",
        ],
        en: ["how is the pipeline", "how is the last pipeline", "how did the pipeline go", "did the pipeline pass", "did the pipeline fail", "how is ci", "how is the build"],
      },
      params: params({
        repo: optionalText("The repository, as said; left out, the open one."),
        workspace: optionalText("The workspace it is in, when said."),
      }),
      risk: "read",
      where: "main",
      frequent: true,
      run: async ({ repo, workspace }) => {
        const project = await findProject(repo, workspace);
        if (!pipelinesAvailable(project, useVcsConnectionsStore.getState())) {
          throw new CodiError("this repository is not linked to a connected host with CI", say("codi.say.noPipelines", { name: project.name }));
        }
        const { listPipelineRuns } = await import("../../tauri/commands");
        const runs = await listPipelineRuns(project.id, null, 5).catch((error) => {
          throw new CodiError(`the host did not answer: ${String(error)}`, say("codi.say.hostSilent", { name: project.name }));
        });
        if (runs.length === 0) throw new CodiError("no pipeline runs yet", say("codi.say.noRuns"));
        const run = runs[0];
        const elsewhere = project.workspace_id !== useWorkspaceStore.getState().activeWorkspaceId;
        return {
          result: { repo: project.name, ...(elsewhere ? { workspace: workspaceName(project.workspace_id) } : {}), run: run.name, number: run.number, branch: run.branch, status: run.status, finished: run.finished_at },
          say: readRun(run, project.name),
          // A red run is offered its reading, as a fallen container is.
          ...(run.status === "failed"
            ? { offer: { action: "pipeline.explain", params: { repo: project.name, workspace: workspaceName(project.workspace_id), run: run.id }, question: say("codi.say.offerExplainRun") } }
            : {}),
        };
      },
    }),
    defineAction({
      id: "pipeline.explain",
      title: {
        en: "Have the AI read the log of the job a repository's pipeline failed on and say why, in the background — the answer is said when ready. `run`: the run's id, else the newest failed one. `repo` and `workspace` by name (any workspace); left out, the open repository.",
        es: "Hace que la IA lea el registro del job en el que falló el pipeline de un repositorio y diga por qué, en segundo plano; la respuesta se dice cuando está. `run`: el id de la ejecución; si no, la fallida más reciente. `repo` y `workspace` por nombre (cualquier workspace); sin ellos, el repositorio abierto.",
      },
      aliases: {
        es: ["analiza el pipeline", "analiza por que fallo el pipeline", "analiza el error del pipeline", "revisa el log del pipeline"],
        en: ["analyse the pipeline", "analyze the pipeline", "explain the pipeline failure", "check the pipeline log"],
      },
      questions: {
        es: ["por que fallo el pipeline", "por que fallo el ultimo pipeline", "por que se cayo el pipeline", "por que fallo el ci", "por que fallo el build"],
        en: ["why did the pipeline fail", "why did the last pipeline fail", "why did ci fail", "why did the build fail"],
      },
      params: params({
        run: optionalText("The run's id, as pipeline.status gave it; left out, the newest failed run."),
        repo: optionalText("The repository, as said; left out, the open one."),
        workspace: optionalText("The workspace it is in, when said."),
      }),
      risk: "read",
      where: "main",
      run: async ({ run, repo, workspace }) => {
        const project = await findProject(repo, workspace);
        if (!pipelinesAvailable(project, useVcsConnectionsStore.getState())) {
          throw new CodiError("this repository is not linked to a connected host with CI", say("codi.say.noPipelines", { name: project.name }));
        }
        const { listPipelineRuns } = await import("../../tauri/commands");
        const runs = await listPipelineRuns(project.id, null, 20).catch((error) => {
          throw new CodiError(`the host did not answer: ${String(error)}`, say("codi.say.hostSilent", { name: project.name }));
        });
        const failed = run ? runs.find((r) => r.id === String(run)) : runs.find((r) => r.status === "failed");
        if (!failed || failed.status !== "failed") throw new CodiError("no recent run of it failed", say("codi.say.noFailedRun", { name: project.name }));
        const { codiExplainPipeline } = await import("../../tauri/codiCommands");
        const question = say("codi.say.explainRunQuestion", { name: failed.name, branch: failed.branch });
        try {
          await codiExplainPipeline(project.id, failed.id, project.name, question);
        } catch (error) {
          throw new CodiError(`could not start reading the log: ${String(error)}`, say("codi.say.researchFailed", { name: project.name }));
        }
        return { result: { explaining: failed.name, repo: project.name, run: failed.id }, say: say("codi.say.explainingRun", { name: project.name }) };
      },
    }),
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

/** The PR's tab in the assistant, as «Revisar» from a link opens it. */
async function openPrTab(projectId: string, pr: Awaited<ReturnType<typeof ensurePr>>) {
  if (!pr) return;
  const { useAiPanelStore } = await import("../../../state/aiPanelStore");
  useAiPanelStore.getState().open({ kind: "pr", projectId, pr });
}

async function ensurePr(projectId: string, prId: number) {
  const { usePrStore } = await import("../../../state/prStore");
  return usePrStore.getState().ensureProjectPr(projectId, prId);
}

/**
 * How a review ended, from the job the jobs store files it as (the one Actividad and the bell read):
 * its findings counted by severity and said, the PR's tab offered. A review takes minutes: it is told
 * when it ends, never waited for.
 */
async function followReview(projectId: string, prId: number): Promise<CodiOutcome | null> {
  const { useJobsStore } = await import("../../../state/jobsStore");
  const job = await watchStore(
    useJobsStore,
    (state) => (state.byProject[projectId] ?? []).find((j) => j.kind === "pr-review" && j.meta.prId === prId && j.status === "running"),
    5000,
  );
  if (!job) return null;
  const ended = await watchStore(useJobsStore, (state) => {
    const now = (state.byProject[projectId] ?? []).find((j) => j.id === job.id);
    return now && now.status !== "running" ? now : undefined;
  });
  if (!ended || ended.status === "cancelled") return null;
  if (ended.status === "error") {
    throw new CodiError(`the review of PR #${prId} failed`, say("codi.say.reviewFailed", { n: prId, reason: afterColon(ended.error?.message ?? "") }));
  }
  const { parseAnalysis } = await import("../../parseAnalysis");
  const findings = parseAnalysis(ended.result ?? "").findings;
  const count = (severity: string) => findings.filter((f) => f.severity === severity).length;
  const parts = [
    count("critical") ? say("codi.say.reviewCritical", { n: count("critical") }) : "",
    count("warning") ? say("codi.say.reviewWarnings", { n: count("warning") }) : "",
    count("info") ? say("codi.say.reviewInfo", { n: count("info") }) : "",
  ].filter(Boolean);
  return {
    say: parts.length ? say("codi.say.reviewDone", { n: prId, list: parts.join(", ") }) : say("codi.say.reviewClean", { n: prId }),
    offer: showOffer("pr.open", { number: prId }),
  };
}

function reviewActions(): CodiAction[] {
  return [
    defineAction({
      id: "pr.open",
      title: {
        en: "Open a pull request of the open repository, by number, in its tab of the assistant — its description, its review and findings.",
        es: "Abre un pull request del repositorio abierto, por número, en su pestaña del asistente: su descripción, su revisión y sus hallazgos.",
      },
      aliases: {
        es: ["abre el pr", "abre el pull request", "muestra el pr", "muestrame el pr", "abre la pr"],
        en: ["open the pr", "open pull request", "show the pr", "show me the pr"],
      },
      params: params({ number: { type: "integer", minimum: 1, description: "The pull request's number." } }, ["number"]),
      risk: "navigate",
      where: "main",
      run: async ({ number }) => {
        const project = requireProject();
        const prId = Number(number);
        const pr = await ensurePr(project.id, prId);
        if (!pr) throw new CodiError(`no pull request #${prId} in ${project.name} (or the host did not answer)`, say("codi.say.prNotFound", { n: prId }));
        await openPrTab(project.id, pr);
        return { result: { opened: prId, title: pr.title }, say: say("codi.say.prOpened", { n: prId }) };
      },
    }),
    defineAction({
      id: "review.pr",
      title: {
        en: "Start the AI review of a pull request of the open repository, by number, in the background — and say how it went when it ends. Its tab in the assistant opens only when show is true.",
        es: "Empieza la revisión con IA de un pull request del repositorio abierto, por número, en segundo plano, y dice cómo resultó cuando termina. Su pestaña del asistente se abre solo si show es true.",
      },
      aliases: {
        es: ["revisa el pr", "revisa el pull request", "haz review del pr", "revision del pr", "revisa la pr"],
        en: ["review the pr", "review pull request", "review pr", "start a review of"],
      },
      params: params({ number: { type: "integer", minimum: 1, description: "The pull request's number." }, show: showParam }, ["number"]),
      risk: "write",
      where: "main",
      run: async ({ number, show }) => {
        const project = requireProject();
        const prId = Number(number);
        const { usePrStore } = await import("../../../state/prStore");
        const pr = await ensurePr(project.id, prId);
        if (!pr) throw new CodiError(`no pull request #${prId} in ${project.name} (or the host did not answer)`, say("codi.say.prNotFound", { n: prId }));
        // What «Revisar» from a link does: the PR in its own tab (on screen only), the list refreshed
        // behind it, the review started — and tracked by the jobs store, so it outlives whatever screen
        // is next. How it went is told when it ends.
        if (!(await outOfSight(show))) await openPrTab(project.id, pr);
        void usePrStore.getState().loadPullRequests(project.id);
        usePrStore.getState().reviewPr({ kind: "project", projectId: project.id }, pr);
        tellWhenDone(`review:${project.id}:${prId}`, followReview(project.id, prId), (error) =>
          say("codi.say.reviewFailed", { n: prId, reason: afterColon(error) }),
        );
        return { result: { reviewing: prId, title: pr.title, repo: project.name }, say: say("codi.say.reviewStarted", { n: prId }) };
      },
    }),
  ];
}

export function devopsActions(): CodiAction[] {
  return [...containerActions(), ...pipelineActions(), ...reviewActions()];
}
