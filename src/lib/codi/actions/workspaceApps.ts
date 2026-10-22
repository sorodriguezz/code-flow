import { useWorkspaceStore } from "../../../state/workspaceStore";
import { useUiStore } from "../../../state/uiStore";
import { CodiError, type CodiAction } from "../registry";
import { literal } from "../vocabulary";
import { askInChatApp } from "./text";
import {
  appName,
  defineAction,
  flag,
  oneOf,
  optionalText,
  params,
  pickByName,
  requireWorkspace,
  say,
  showAppHere,
  spokenList,
  text,
} from "./shared";

/**
 * The rest of the rail's apps — Flujos, Diagramas, Arquitectura, Remoto, Agentes and the Chat app.
 *
 * Each action runs where its app lives (`where: "app:<key>"`), loads that app's store when it runs
 * (the stores are the size of their apps, and stay out of the catalogue's chunk), and goes through the
 * store's own verbs — the same ones the app's buttons call — so a flow run by voice asks for its form
 * or its trust exactly as one run with the mouse does.
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
        en: "Run a flow now, by name (loose match) — as its Run button does: a flow that asks for input shows its form, one with someone else's commands asks to be trusted first.",
        es: "Ejecuta un flujo ahora, por nombre (coincidencia flexible), como su botón Ejecutar: si pide datos muestra su formulario, y si trae comandos de otra persona pide confianza antes.",
      },
      aliases: {
        es: ["ejecuta el flujo", "corre el flujo", "lanza el flujo", "dispara el flujo", "ejecuta la automatizacion", "arranca el flujo"],
        en: ["run the flow", "start the flow", "trigger the flow", "run the automation", "fire the flow"],
      },
      params: params({ name: text("The flow's name, as said.") }, ["name"]),
      risk: "write",
      where: "app:flows",
      frequent: true,
      run: async ({ name }) => {
        const store = await flows();
        const flow = pickByName(store.getState().flows, String(name), (f) => f.name, "flow");
        const { useFlowRunsStore } = await import("../../../state/flowRunsStore");
        if (useFlowRunsStore.getState().current[flow.id]?.run?.status === "running") {
          return { result: { flow: flow.name, already: true }, say: say("codi.say.flowAlreadyRunning", { name: flow.name }) };
        }
        const run = await useFlowRunsStore.getState().start(flow.id, { kind: "full" });
        if (run) return { result: { flow: flow.name, run: run.id, status: run.status }, say: say("codi.say.flowStarted", { name: flow.name }) };
        const runs = useFlowRunsStore.getState();
        if (runs.formPrompt?.flowId === flow.id || runs.trustPrompt?.flowId === flow.id) {
          // The form and the trust question are drawn by the Flujos view: put it on screen with the
          // flow, so the question the run is waiting on is in front of the user.
          showAppHere("flows");
          void store.getState().openFlow(flow.id);
          const asks = runs.formPrompt?.flowId === flow.id ? "form" : "trust";
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
        },
        ["prompt"],
      ),
      risk: "write",
      where: "app:agents",
      frequent: true,
      run: async ({ prompt, agent, repo }) => {
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
        showAppHere("agents");
        const goal = String(prompt);
        const task = await store.getState().create({ projectId: project.id, agent: chosen, goal });
        // What the dialog does next: the first turn, unless the one-agent-per-repository guard says
        // no — the task stays, selected, with its goal and a Run button.
        const started = store.getState().send(task.id, goal);
        return {
          result: { task: task.title, agent: chosen.name, repo: project.name, started },
          say: started
            ? say("codi.say.agentStarted", { name: chosen.name, repo: project.name })
            : say("codi.say.agentQueued", { name: chosen.name, repo: project.name }),
        };
      },
    }),
  ];
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
