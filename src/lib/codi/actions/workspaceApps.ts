import { useWorkspaceStore } from "../../../state/workspaceStore";
import { useUiStore } from "../../../state/uiStore";
import { CodiError, type CodiAction, type CodiOutcome } from "../registry";
import { literal } from "../vocabulary";
import { askInChatApp } from "./text";
import {
  afterColon,
  answerOrTell,
  appName,
  defineAction,
  flag,
  oneOf,
  optionalText,
  outOfSight,
  params,
  pickByName,
  requireWorkspace,
  say,
  showAppHere,
  showOffer,
  showParam,
  spokenDuration,
  spokenList,
  spokenReason,
  tellWhenDone,
  text,
  watchStore,
} from "./shared";

/**
 * The rest of the rail's apps — Flujos, Diagramas, Arquitectura, Remoto, Agentes and the Chat app.
 *
 * Each action runs where its app lives (`where: "app:<key>"`), loads that app's store when it runs
 * (the stores are the size of their apps, and stay out of the catalogue's chunk), and goes through the
 * store's own verbs — the same ones the app's buttons call — so a flow run by voice asks for its form
 * or its trust exactly as one run with the mouse does.
 *
 * A flow's run and an agent's task are work, not places: out of sight (Settings › Codi › «Trabajar en
 * segundo plano», or «sin abrir») neither app opens, and how the work ended is said — within the turn
 * when it is quick, told when it lands otherwise. What needs the app (a run's form, its trust
 * question) is said and offered to be opened.
 */

async function flows() {
  const module = await import("../../../state/flowsStore");
  await module.ensureFlowsStoreLoaded();
  return module.useFlowsStore;
}

async function diagrams() {
  const module = await import("../../../state/diagramsStore");
  await module.ensureDiagramsStoreLoaded();
  return module.useDiagramsStore;
}

async function architectures() {
  const module = await import("../../../state/architectureStore");
  await module.ensureArchitectureStoreLoaded();
  return module.useArchitectureStore;
}

async function remote() {
  const module = await import("../../../state/remoteStore");
  await module.ensureRemoteStoreLoaded();
  return module.useRemoteStore;
}

/** The agents store on this window's workspace. Its view drives `setWorkspace` from an effect, which
 *  has not run when Codi gets here first. */
async function agents() {
  const { useAgentsStore } = await import("../../../state/agentsStore");
  const workspace = requireWorkspace();
  if (useAgentsStore.getState().workspaceId !== workspace.id) await useAgentsStore.getState().setWorkspace(workspace.id);
  return useAgentsStore;
}

function flowActions(): CodiAction[] {
  return [
    defineAction({
      id: "flows.list",
      title: { en: "List this workspace's flows, which are armed, and which are running.", es: "Lista los flujos del workspace, cuáles están activos y cuáles corriendo." },
      aliases: {
        es: ["que flujos hay", "lista los flujos", "mis flujos", "mis automatizaciones", "que automatizaciones hay"],
        en: ["which flows", "list the flows", "my flows", "my automations"],
      },
      params: params(),
      risk: "read",
      where: "app:flows",
      run: async () => {
        const store = await flows();
        const { useFlowRunsStore } = await import("../../../state/flowRunsStore");
        const current = useFlowRunsStore.getState().current;
        const list = store.getState().flows;
        return {
          result: {
            flows: list.slice(0, 40).map((f) => ({
              name: f.name,
              ...(f.active ? { armed: true } : {}),
              ...(current[f.id]?.run?.status === "running" ? { running: true } : {}),
            })),
            total: list.length,
          },
          say: list.length ? say("codi.say.flows", { list: spokenList(list.map((f) => f.name)) }) : say("codi.say.noFlows"),
        };
      },
    }),
    defineAction({
      id: "flow.open",
      title: { en: "Open a flow on its canvas, by name (loose match).", es: "Abre un flujo en su lienzo, por nombre (coincidencia flexible)." },
      aliases: {
        es: ["abre el flujo", "muestra el flujo", "ve al flujo", "abre la automatizacion", "edita el flujo"],
        en: ["open the flow", "show the flow", "go to the flow", "edit the flow", "open the automation"],
      },
      params: params({ name: text("The flow's name, as said.") }, ["name"]),
      risk: "navigate",
      where: "app:flows",
      run: async ({ name }) => {
        showAppHere("flows");
        const store = await flows();
        const flow = pickByName(store.getState().flows, String(name), (f) => f.name, "flow");
        await store.getState().openFlow(flow.id);
        return { result: { opened: flow.name }, say: say("codi.say.flowOpened", { name: flow.name }) };
      },
    }),
    defineAction({
      id: "flow.run",
      title: {
        en: "Run a flow now, by name (loose match), and say how it ended — without opening Flujos unless show is true. As its Run button: a flow that asks for input or for trust says so, and opening it is offered.",
        es: "Ejecuta un flujo ahora, por nombre (coincidencia flexible), y dice cómo terminó, sin abrir Flujos salvo que show sea true. Como su botón Ejecutar: si pide datos o confianza lo dice y ofrece abrirlo.",
      },
      aliases: {
        es: ["ejecuta el flujo", "corre el flujo", "lanza el flujo", "dispara el flujo", "ejecuta la automatizacion", "arranca el flujo"],
        en: ["run the flow", "start the flow", "trigger the flow", "run the automation", "fire the flow"],
      },
      params: params({ name: text("The flow's name, as said."), show: showParam }, ["name"]),
      risk: "write",
      where: "app:flows",
      frequent: true,
      run: async ({ name, show }) => {
        const store = await flows();
        const flow = pickByName(store.getState().flows, String(name), (f) => f.name, "flow");
        const { useFlowRunsStore, ensureFlowRunEvents } = await import("../../../state/flowRunsStore");
        // The run's end arrives as an event, which a window listens for once Flujos has been opened —
        // or now, for a run nobody watches on screen.
        ensureFlowRunEvents();
        if (useFlowRunsStore.getState().current[flow.id]?.run?.status === "running") {
          return { result: { flow: flow.name, already: true }, say: say("codi.say.flowAlreadyRunning", { name: flow.name }) };
        }
        const quiet = await outOfSight(show);
        if (!quiet) {
          showAppHere("flows");
          void store.getState().openFlow(flow.id);
        }
        const run = await useFlowRunsStore.getState().start(flow.id, { kind: "full" });
        if (run) return followRun(flow.id, flow.name, run.id);
        const runs = useFlowRunsStore.getState();
        if (runs.formPrompt?.flowId === flow.id || runs.trustPrompt?.flowId === flow.id) {
          const asks = runs.formPrompt?.flowId === flow.id ? "form" : "trust";
          // The form and the trust question are drawn by the Flujos view: on screen they are in front of
          // the user already; out of sight, opening it is asked.
          if (quiet) {
            throw new CodiError(
              `${flow.name} waits for its ${asks === "form" ? "form" : "trust question"}, which Flujos shows`,
              say(asks === "form" ? "codi.say.flowNeedsFormAsk" : "codi.say.flowNeedsTrustAsk", { name: flow.name }),
              { action: "flow.open", params: { name: flow.name } },
            );
          }
          return {
            result: { flow: flow.name, waitingFor: asks },
            say: say(asks === "form" ? "codi.say.flowNeedsForm" : "codi.say.flowNeedsTrust", { name: flow.name }),
          };
        }
        throw new CodiError(`${flow.name} did not start`, say("codi.say.flowFailed", { name: flow.name }));
      },
    }),
  ];
}

/** How a run ended — said within the turn when it is quick, told when it lands otherwise. A failure is
 *  said with its reason and offers to open the flow. */
function followRun(flowId: string, name: string, runId: string): Promise<CodiOutcome> {
  const work = (async (): Promise<CodiOutcome> => {
    const { useFlowRunsStore } = await import("../../../state/flowRunsStore");
    const ended = await watchStore(useFlowRunsStore, (state) => {
      const run = state.current[flowId]?.run;
      return run && run.id === runId && run.status !== "running" && run.status !== "waiting" ? run : undefined;
    });
    if (!ended) return { result: { flow: name, run: runId, running: true } };
    const ms = ended.durationMs ?? (ended.finishedAt ? Date.parse(ended.finishedAt) - Date.parse(ended.startedAt) : 0);
    if (ended.status === "success") {
      return { result: { flow: name, run: runId, status: ended.status, ms }, say: say("codi.say.flowFinished", { name, time: spokenDuration(Math.max(0, ms)) }) };
    }
    if (ended.status === "canceled") return { result: { flow: name, run: runId, status: ended.status }, say: say("codi.say.flowStopped", { name }) };
    throw new CodiError(
      `${name} ended ${ended.status}: ${ended.error}`,
      say("codi.say.flowFailedWhy", { name, reason: spokenReason(ended.error || ended.status) }),
      { action: "flow.open", params: { name } },
    );
  })();
  return answerOrTell(work, {
    source: `flow:${flowId}`,
    still: { result: { flow: name, run: runId, running: true }, say: say("codi.say.flowStartedTell", { name }) },
    failed: (error) => say("codi.say.flowFailedWhy", { name, reason: spokenReason(error) }),
  });
}

/** The formats a new diagram can be, by the names the Diagramas menu gives them. */
const DIAGRAM_KINDS: Record<string, string> = { drawio: "mxgraph", excalidraw: "excalidraw", dbml: "dbml", mermaid: "mermaid" };

function diagramActions(): CodiAction[] {
  return [
    defineAction({
      id: "diagram.open",
      title: { en: "Open a diagram by its title (loose match).", es: "Abre un diagrama por su título (coincidencia flexible)." },
      aliases: {
        es: ["abre el diagrama", "muestra el diagrama", "ve al diagrama", "abre el dibujo", "abre el esquema"],
        en: ["open the diagram", "show the diagram", "go to the diagram", "open the drawing", "open the schema"],
      },
      params: params({ name: text("The diagram's title, as said.") }, ["name"]),
      risk: "navigate",
      where: "app:diagrams",
      run: async ({ name }) => {
        showAppHere("diagrams");
        const store = await diagrams();
        const diagram = pickByName(store.getState().diagrams, String(name), (d) => d.title, "diagram", (d) => d.pinned);
        await store.getState().openDiagram(diagram.id);
        return { result: { opened: diagram.title, format: diagram.format }, say: say("codi.say.diagramOpened", { name: diagram.title }) };
      },
    }),
    defineAction({
      id: "diagram.new",
      title: {
        en: "Start a new diagram — draw.io (the default), Excalidraw, a DBML schema or Mermaid.",
        es: "Crea un diagrama nuevo: draw.io (por defecto), Excalidraw, un esquema DBML o Mermaid.",
      },
      aliases: {
        es: ["nuevo diagrama", "crea un diagrama", "haz un diagrama", "dibuja", "nuevo esquema", "crea un esquema"],
        en: ["new diagram", "create a diagram", "make a diagram", "draw", "new schema"],
      },
      get vocabulary() {
        return {
          kind: literal({
            drawio: { es: ["draw io", "drawio", "diagrama normal", "diagrama de flujo", "diagrama"], en: ["draw io", "drawio", "flowchart", "diagram"] },
            excalidraw: { es: ["excalidraw", "pizarra", "boceto", "a mano alzada"], en: ["excalidraw", "whiteboard", "sketch", "hand drawn"] },
            dbml: { es: ["dbml", "esquema", "esquema de base de datos", "modelo de datos", "tablas"], en: ["dbml", "schema", "database schema", "data model", "tables"] },
            mermaid: { es: ["mermaid", "diagrama en texto", "secuencia"], en: ["mermaid", "text diagram", "sequence diagram"] },
          }),
        };
      },
      params: params({ kind: oneOf(Object.keys(DIAGRAM_KINDS), "Which kind; draw.io when left out."), title: optionalText("Its title.") }),
      risk: "write",
      where: "app:diagrams",
      run: async ({ kind, title }) => {
        showAppHere("diagrams");
        const store = await diagrams();
        const format = DIAGRAM_KINDS[String(kind ?? "drawio")] ?? "mxgraph";
        const id = await store.getState().createDiagram(null, title ? String(title) : undefined, format);
        if (!id) throw new CodiError("the diagram could not be created", say("codi.say.diagramFailed"));
        const made = store.getState().diagrams.find((d) => d.id === id);
        return { result: { created: made?.title ?? id, format }, say: say("codi.say.diagramCreated", { name: made?.title ?? "" }) };
      },
    }),
  ];
}

function architectureActions(): CodiAction[] {
  return [
    defineAction({
      id: "architecture.open",
      title: {
        en: "Open Arquitectura, optionally on one architecture document by name (loose match).",
        es: "Abre Arquitectura, opcionalmente en un documento de arquitectura por nombre (coincidencia flexible).",
      },
      aliases: {
        es: ["abre la arquitectura", "muestra la arquitectura", "abre el documento de arquitectura", "ve a arquitectura"],
        en: ["open the architecture", "show the architecture", "open the architecture document", "go to architecture"],
      },
      params: params({ name: optionalText("The document's title. Left out: the app as it was left.") }),
      risk: "navigate",
      where: "app:architecture",
      run: async ({ name }) => {
        showAppHere("architecture");
        if (!name) return { result: { opened: "architecture" }, say: say("codi.say.appOpened", { name: appName("architecture") }) };
        const store = await architectures();
        const item = pickByName(store.getState().items, String(name), (i) => i.title, "architecture document", (i) => i.pinned);
        await store.getState().open(item.id);
        return { result: { opened: item.title }, say: say("codi.say.architectureOpened", { name: item.title }) };
      },
    }),
  ];
}

function remoteActions(): CodiAction[] {
  return [
    defineAction({
      id: "remote.list",
      title: { en: "List the saved remote hosts (SSH) and which have a session open.", es: "Lista los hosts remotos guardados (SSH) y cuáles tienen una sesión abierta." },
      aliases: {
        es: ["que servidores hay", "lista los hosts", "mis servidores", "que maquinas hay", "mis hosts"],
        en: ["which servers", "list the hosts", "my servers", "my hosts", "which machines"],
      },
      params: params(),
      risk: "read",
      where: "app:remote",
      run: async () => {
        const store = await remote();
        const { hosts, tabs } = store.getState();
        const open = new Set(tabs.filter((t) => t.kind === "session" && !t.exited).map((t) => (t as { hostId: string }).hostId));
        return {
          result: {
            hosts: hosts.slice(0, 40).map((h) => ({ name: h.name, ...(h.group_name ? { group: h.group_name } : {}), ...(open.has(h.id) ? { connected: true } : {}) })),
            total: hosts.length,
          },
          say: hosts.length ? say("codi.say.hosts", { list: spokenList(hosts.map((h) => h.name)) }) : say("codi.say.noHosts"),
        };
      },
    }),
    defineAction({
      id: "remote.connect",
      title: { en: "Open a session to a saved remote host, by name (loose match).", es: "Abre una sesión en un host remoto guardado, por nombre (coincidencia flexible)." },
      aliases: {
        es: ["conectate a", "conectate al servidor", "abre una sesion en", "entra al servidor", "ssh a", "abre ssh en"],
        en: ["connect to", "connect to the server", "open a session on", "ssh into", "log into the server"],
      },
      params: params({ host: text("The host's name, as said.") }, ["host"]),
      risk: "write",
      where: "app:remote",
      run: async ({ host }) => {
        showAppHere("remote");
        const store = await remote();
        const target = pickByName(store.getState().hosts, String(host), (h) => h.name, "host");
        const before = store.getState().tabs.length;
        await store.getState().openSession(target.id);
        if (store.getState().tabs.length === before) {
          throw new CodiError(`the session to ${target.name} did not open`, say("codi.say.remoteFailed", { name: target.name }));
        }
        return { result: { connected: target.name }, say: say("codi.say.remoteConnected", { name: target.name }) };
      },
    }),
  ];
}

function agentActions(): CodiAction[] {
  return [
    defineAction({
      id: "agents.list",
      title: {
        en: "List this workspace's agents (the roster) and its latest agent tasks with their status.",
        es: "Lista los agentes del workspace y sus últimas tareas de agente con su estado.",
      },
      aliases: {
        es: ["que agentes hay", "mis agentes", "lista los agentes", "que tareas de agentes hay", "como van los agentes"],
        en: ["which agents", "my agents", "list the agents", "agent tasks", "how are the agents doing"],
      },
      params: params(),
      risk: "read",
      where: "app:agents",
      run: async () => {
        const store = await agents();
        const { isRunnableAgent } = await import("../../../state/agentsStore");
        const { roster, tasks } = store.getState();
        const runnable = roster.filter(isRunnableAgent);
        return {
          result: {
            agents: runnable.map((a) => a.name),
            tasks: tasks.slice(0, 12).map((t) => ({ title: t.title, status: t.status, agent: t.agent_name })),
            totalTasks: tasks.length,
          },
          say: runnable.length ? say("codi.say.agents", { list: spokenList(runnable.map((a) => a.name)) }) : say("codi.say.noAgents"),
        };
      },
    }),
    defineAction({
      id: "agent.task",
      title: {
        en: "Give an agent a task in a repository: creates it in Agentes and starts its first turn, as the New task dialog does. agent and repo are names (loose match); left out, the first runnable agent and the open repository.",
        es: "Encarga una tarea a un agente en un repositorio: la crea en Agentes y arranca su primer turno, como el diálogo Nueva tarea. agent y repo son nombres (coincidencia flexible); sin ellos, el primer agente disponible y el repositorio abierto.",
      },
      aliases: {
        es: ["encarga", "encargale al agente", "pidele al agente", "dile al agente que", "crea una tarea", "nueva tarea de agente", "que el agente"],
        en: ["ask the agent to", "have the agent", "create a task", "new agent task", "give the agent a task"],
      },
      params: params(
        {
          prompt: text("What the agent should do."),
          agent: optionalText("The agent's name. Left out: the first runnable one."),
          repo: optionalText("The repository's name. Left out: the one open in this window."),
          show: showParam,
        },
        ["prompt"],
      ),
      risk: "write",
      where: "app:agents",
      frequent: true,
      run: async ({ prompt, agent, repo, show }) => {
        const store = await agents();
        const { isRunnableAgent } = await import("../../../state/agentsStore");
        const runnable = store.getState().roster.filter(isRunnableAgent);
        if (runnable.length === 0) throw new CodiError("this workspace has no agent that can run — add one in Agentes", say("codi.say.noAgents"));
        const chosen = agent ? pickByName(runnable, String(agent), (a) => a.name, "agent") : runnable[0];
        const ws = useWorkspaceStore.getState();
        const projects = ws.activeWorkspaceId ? (ws.projectsByWorkspace[ws.activeWorkspaceId] ?? []) : [];
        const project = repo
          ? pickByName(projects, String(repo), (p) => p.name, "repository")
          : (ws.activeProject() ?? (projects.length === 1 ? projects[0] : null));
        if (!project) throw new CodiError("say which repository the task is for (repo)", say("codi.say.whichRepo"));
        const quiet = await outOfSight(show);
        if (!quiet) showAppHere("agents");
        const goal = String(prompt);
        const task = await store.getState().create({ projectId: project.id, agent: chosen, goal });
        // What the dialog does next: the first turn, unless the one-agent-per-repository guard says
        // no — the task stays, selected, with its goal and a Run button.
        const started = store.getState().send(task.id, goal);
        // Out of sight, its turn's end is told — a turn takes minutes, so nothing waits for it.
        if (started && quiet) {
          tellWhenDone(`agent:${task.id}`, followTask(task.id, chosen.name, task.title), (error) =>
            say("codi.say.agentFailed", { name: chosen.name, title: task.title, reason: afterColon(error) }),
          );
        }
        return {
          result: { task: task.title, agent: chosen.name, repo: project.name, started },
          say: started
            ? say(quiet ? "codi.say.agentStartedTell" : "codi.say.agentStarted", { name: chosen.name, repo: project.name })
            : say("codi.say.agentQueued", { name: chosen.name, repo: project.name }),
        };
      },
    }),
  ];
}

/** How an agent's turn ended: done, waiting for an answer, or stopped — followed through the store the
 *  Agentes view reads. A turn that waits offers to show the task (selected by then). */
async function followTask(taskId: string, agent: string, title: string): Promise<CodiOutcome | null> {
  const { useAgentsStore } = await import("../../../state/agentsStore");
  let seenRunning = false;
  const ended = await watchStore(useAgentsStore, (state) => {
    const task = state.tasks.find((t) => t.id === taskId);
    if (!task) return undefined;
    if (task.status === "running") {
      seenRunning = true;
      return undefined;
    }
    return seenRunning || task.status === "done" || task.status === "error" || task.status === "cancelled" ? task : undefined;
  });
  if (!ended) return null;
  if (ended.status === "error") throw new CodiError(`${agent}'s task ${title} failed`, say("codi.say.agentFailed", { name: agent, title, reason: "" }));
  if (ended.status === "cancelled") return { say: say("codi.say.agentStopped", { name: agent, title }) };
  void useAgentsStore.getState().select(taskId);
  return {
    say: say(ended.status === "done" ? "codi.say.agentDone" : "codi.say.agentWaiting", { name: agent, title }),
    offer: showOffer("app.open", { app: "agents" }),
  };
}

function chatActions(): CodiAction[] {
  return [
    defineAction({
      id: "chat.new",
      title: {
        en: "Start a new conversation in the Chat app — with a first message when one is given, sent if asked.",
        es: "Empieza una conversación nueva en la app Chat; con un primer mensaje si se da, y enviado si se pide.",
      },
      aliases: {
        es: ["nuevo chat", "nueva conversacion", "empieza un chat", "abre un chat nuevo", "chat nuevo"],
        en: ["new chat", "new conversation", "start a chat", "open a new chat"],
      },
      params: params({ text: optionalText("The first message."), send: flag("Send it now.") }),
      risk: "write",
      where: "app:chat",
      run: async ({ text: first, send }) => {
        showAppHere("chat");
        const { useConversationStore } = await import("../../../state/conversationStore");
        // The view's own "new": it drops the selection, so the next message mints the thread.
        useConversationStore.getState().deselect();
        if (first) {
          await askInChatApp(String(first), send === true);
        } else {
          useUiStore.getState().focusChatComposer();
        }
        return {
          result: { newChat: true, ...(first ? { sent: send === true } : {}) },
          say: first && send === true ? say("codi.say.chatSent") : say("codi.say.chatNew"),
        };
      },
    }),
  ];
}

/** Every action of this area, for the main window — each one also registered by its app's island. */
export function workspaceAppActions(): CodiAction[] {
  return [...flowActions(), ...diagramActions(), ...architectureActions(), ...remoteActions(), ...agentActions(), ...chatActions()];
}

/** What an island holding the rail app `key` registers of this area. */
export function workspaceAppActionsFor(key: string): CodiAction[] {
  switch (key) {
    case "flows":
      return flowActions();
    case "diagrams":
      return diagramActions();
    case "architecture":
      return architectureActions();
    case "remote":
      return remoteActions();
    case "agents":
      return agentActions();
    case "chat":
      return chatActions();
    default:
      return [];
  }
}
