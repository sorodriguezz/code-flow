import { deriveRunning, isActive, useServicesStore } from "../../../state/servicesStore";
import { useTerminalStore } from "../../../state/terminalStore";
import { useWorkspaceStore } from "../../../state/workspaceStore";
import { CodiError, type CodiAction } from "../registry";
import type { ServiceRow } from "../../../types/services";
import { defineAction, params, pickByName, requireProject, requireWorkspace, say, spokenList, text } from "./shared";

/**
 * Starting things: the workspace's services (the Rust supervisor's — this store only asks it), and
 * a command in a terminal.
 *
 * A command runs in a terminal of Codi's own (`reuseKey: "codi"`), never typed into the user's
 * shell: that one may be sitting in a REPL or running a dev server, and a line meant for a prompt
 * would land in its stdin. `terminalStore.runCommand` reuses the same tab next time, which is what
 * an action that runs commands should look like — one tab that says what Codi ran.
 */

/** The workspace's service definitions, read if this window has not read them for this workspace. */
async function workspaceServices(): Promise<ServiceRow[]> {
  const workspace = requireWorkspace();
  const store = useServicesStore.getState();
  const loaded = store.services.length > 0 && store.services.every((s) => s.workspace_id === workspace.id);
  if (!loaded) await store.load(workspace.id);
  return useServicesStore.getState().services.filter((s) => s.workspace_id === workspace.id);
}

type Verb = "start" | "stop" | "restart";

function serviceVerb(verb: Verb): CodiAction {
  const titles: Record<Verb, { en: string; es: string }> = {
    start: { en: "Start one of the workspace's services, by name.", es: "Arranca uno de los servicios del workspace, por nombre." },
    stop: { en: "Stop one of the workspace's services, by name.", es: "Detiene uno de los servicios del workspace, por nombre." },
    restart: { en: "Restart one of the workspace's services, by name.", es: "Reinicia uno de los servicios del workspace, por nombre." },
  };
  const aliases: Record<Verb, { en: string[]; es: string[] }> = {
    start: {
      es: ["arranca", "arranca el servicio", "levanta", "levanta el servicio", "inicia", "inicia el servicio", "enciende", "prende"],
      en: ["start", "start the service", "bring up", "run the service", "spin up"],
    },
    stop: {
      es: ["deten", "deten el servicio", "para", "para el servicio", "baja el servicio", "apaga", "apaga el servicio", "mata el servicio"],
      en: ["stop", "stop the service", "bring down", "kill the service", "shut down"],
    },
    restart: {
      es: ["reinicia", "reinicia el servicio", "reinicialo", "reinicia de nuevo"],
      en: ["restart", "restart the service", "reboot the service"],
    },
  };
  return defineAction({
    id: `service.${verb}`,
    title: titles[verb],
    aliases: aliases[verb],
    params: params({ name: text("The service's name, as said.") }, ["name"]),
    risk: "write",
    where: "main",
    frequent: verb !== "restart",
    run: async ({ name }) => {
      const services = await workspaceServices();
      const service = pickByName(services, String(name), (s) => s.name, "service");
      const store = useServicesStore.getState();
      const running = isActive(store.runtimeOf(service.id));
      if (verb === "start" && running) {
        return { result: { service: service.name, already: true }, say: say("codi.say.serviceAlreadyRunning", { name: service.name }) };
      }
      if (verb === "stop" && !running) {
        return { result: { service: service.name, already: true }, say: say("codi.say.serviceNotRunning", { name: service.name }) };
      }
      await store[verb](service.id);
      const key = verb === "start" ? "codi.say.serviceStarted" : verb === "stop" ? "codi.say.serviceStopped" : "codi.say.serviceRestarted";
      return { result: { service: service.name, [verb]: true }, say: say(key, { name: service.name }) };
    },
  });
}

export function serviceActions(): CodiAction[] {
  return [
    serviceVerb("start"),
    serviceVerb("stop"),
    serviceVerb("restart"),
    defineAction({
      id: "services.list",
      title: {
        en: "List the workspace's services and their status, plus any running in other workspaces.",
        es: "Lista los servicios del workspace y su estado, y los que corren en otros workspaces.",
      },
      aliases: { es: ["que servicios hay", "que servicios corren", "lista los servicios", "servicios corriendo", "que esta corriendo"], en: ["which services", "list the services", "running services", "what is running"] },
      params: params(),
      risk: "read",
      where: "main",
      run: async () => {
        const services = await workspaceServices();
        const { runtime } = useServicesStore.getState();
        const running = deriveRunning(runtime, useWorkspaceStore.getState().activeWorkspaceId);
        const names = running.map((s) => s.name);
        return {
          result: {
            services: services.map((s) => ({ name: s.name, status: runtime[s.id]?.status ?? "stopped" })),
            elsewhere: running.filter((s) => s.foreign).map((s) => s.name),
          },
          say: names.length
            ? say("codi.say.servicesRunning", { n: names.length, list: spokenList(names) })
            : say("codi.say.noServicesRunning"),
        };
      },
    }),
  ];
}

export function terminalActions(): CodiAction[] {
  return [
    defineAction({
      id: "terminal.run",
      title: {
        en: "Run a shell command in the open repository, in a terminal of Codi's own in the dock. Asks the user first.",
        es: "Ejecuta un comando de shell en el repositorio abierto, en una terminal propia de Codi en el dock. Pide confirmación.",
      },
      aliases: { es: ["ejecuta", "ejecuta el comando", "corre", "corre el comando", "lanza", "lanza el comando", "en la terminal ejecuta"], en: ["run", "run the command", "execute", "execute the command", "in the terminal run"] },
      params: params({ command: text("The command line, exactly as it should be typed.") }, ["command"]),
      risk: "destructive",
      where: "any",
      frequent: true,
      run: async ({ command }) => {
        const project = requireProject();
        const line = String(command).trim();
        if (line.includes("\n")) throw new CodiError("one command line at a time");
        await useTerminalStore.getState().runCommand(project.id, {
          cwd: project.local_path,
          command: line,
          reuseKey: "codi",
          title: "Codi",
        });
        return { result: { ran: line, in: project.name }, say: say("codi.say.commandRunning") };
      },
    }),
  ];
}
