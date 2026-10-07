import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionRequest } from "../lib/tauri/containersCommands";

type Output = { id: string; data: string; seq?: number };
type Exit = { id: string; code?: number | null };

let output: (e: Output) => void = () => {};
let exit: (e: Exit) => void = () => {};
const opened: Array<{ resolve: (id: string) => void; reject: (e: unknown) => void }> = [];
const closeTerminal = vi.fn((_id: string) => Promise.resolve());
const refreshList = vi.fn(() => Promise.resolve());
const pushSuccessToast = vi.fn();

vi.mock("../lib/tauri/events", () => ({
  onTerminalOutput: (handler: (e: Output) => void) => {
    output = handler;
    return Promise.resolve(() => {});
  },
  onTerminalExit: (handler: (e: Exit) => void) => {
    exit = handler;
    return Promise.resolve(() => {});
  },
}));
vi.mock("../lib/tauri/containersCommands", () => ({
  containersOpenSession: () => new Promise<string>((resolve, reject) => opened.push({ resolve, reject })),
}));
vi.mock("../lib/tauri/commands", () => ({ closeTerminal: (id: string) => closeTerminal(id) }));
vi.mock("./terminalStore", () => ({ disownTerminalBacklog: vi.fn() }));
vi.mock("./containersStore", () => ({ useContainersStore: { getState: () => ({ refreshList }) } }));
vi.mock("./toastStore", () => ({ pushSuccessToast: (text: string) => pushSuccessToast(text) }));

const { jobBacklog, useContainersJobsStore } = await import("./containersJobsStore");

const pull = (target: string): SessionRequest => ({ kind: "pull", runtime: "docker", context: "orbstack", target });
const store = () => useContainersJobsStore.getState();
/** Lets `start` reach `containers_open_session` — it waits for its listeners first — or an awaited
 *  open's continuation run. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("a job outlives the page that started it", () => {
  beforeEach(() => {
    for (const job of store().jobs) store().close(job.key);
    useContainersJobsStore.setState({ jobs: [], shown: null, folded: false, history: [] });
    opened.length = 0;
    closeTerminal.mockClear();
    refreshList.mockClear();
    pushSuccessToast.mockClear();
  });

  it("keeps what printed before its id was known, and what printed after", async () => {
    const started = store().start("Descargando nginx", pull("nginx:alpine"), { refresh: ["images"], done: "Descargado", runImage: "nginx:alpine" });
    await settle();
    // The command printed before `containers_open_session` answered.
    output({ id: "s-1", data: "Pulling from library/nginx\r\n", seq: 1 });
    opened[0].resolve("s-1");
    await started;
    output({ id: "s-1", data: "Status: Downloaded\r\n", seq: 2 });
    // Another session's output is not this job's.
    output({ id: "elsewhere", data: "$ ls\r\n", seq: 1 });

    expect(jobBacklog("s-1")).toEqual({ text: "Pulling from library/nginx\r\nStatus: Downloaded\r\n", seq: 2 });
    expect(store().jobs[0]).toMatchObject({ sessionId: "s-1", ended: false });
  });

  it("does what it was told when it ends — read the lists again, say so — and is remembered", async () => {
    const started = store().start("Descargando nginx", pull("nginx:alpine"), { refresh: ["images"], done: "Descargado", runImage: "nginx:alpine", meta: { tag: "nginx:alpine" } });
    await settle();
    opened[0].resolve("s-2");
    await started;
    exit({ id: "s-2", code: 0 });

    expect(store().jobs[0]).toMatchObject({ ended: true, code: 0 });
    expect(refreshList).toHaveBeenCalledWith("docker", "images");
    expect(pushSuccessToast).toHaveBeenCalledWith("Descargado");
    expect(store().history[0]).toMatchObject({ kind: "pull", runtime: "docker", code: 0, meta: { tag: "nginx:alpine" } });
  });

  it("a failure reads the lists again but says nothing good", async () => {
    const started = store().start("Levantando tienda", { kind: "composeUp", runtime: "docker", context: null, target: "tienda" }, { refresh: ["containers"], done: "Levantado" });
    await settle();
    opened[0].resolve("s-3");
    await started;
    exit({ id: "s-3", code: 1 });

    expect(store().jobs[0]).toMatchObject({ ended: true, code: 1 });
    expect(refreshList).toHaveBeenCalledWith("docker", "containers");
    expect(pushSuccessToast).not.toHaveBeenCalled();
  });

  it("an end heard before the id arrived still ends it", async () => {
    const started = store().start("Descargando nada", pull("nope:1"), { refresh: ["images"] });
    await settle();
    output({ id: "s-4", data: "Error: manifest unknown\r\n", seq: 1 });
    exit({ id: "s-4", code: 1 });
    opened[0].resolve("s-4");
    await started;

    expect(store().jobs[0]).toMatchObject({ sessionId: "s-4", ended: true, code: 1 });
    expect(jobBacklog("s-4").text).toBe("Error: manifest unknown\r\n");
  });

  it("one that could not start has ended, with why", async () => {
    const started = store().start("Descargando", pull("x:1"));
    await settle();
    opened[0].reject("docker: not found");
    await started;
    expect(store().jobs[0]).toMatchObject({ ended: true, code: null, error: "docker: not found" });
  });

  it("closing a running one stops it; closing one still opening stops it once it opens", async () => {
    const first = store().start("Uno", pull("a:1"));
    await settle();
    opened[0].resolve("s-5");
    await first;
    store().close(store().jobs[0].key);
    expect(closeTerminal).toHaveBeenCalledWith("s-5");
    expect(jobBacklog("s-5")).toEqual({ text: "", seq: 0 });

    const second = store().start("Dos", pull("b:1"));
    await settle();
    store().close(store().jobs[0].key);
    opened[1].resolve("s-6");
    await second;
    await settle();
    expect(closeTerminal).toHaveBeenCalledWith("s-6");
    expect(store().jobs).toHaveLength(0);
  });

  it("lets the oldest ended jobs go, never a running one", async () => {
    const running = store().start("Sigue", pull("keep:1"));
    await settle();
    opened[0].resolve("live");
    await running;
    for (let i = 0; i < 8; i++) {
      const job = store().start(`Job ${i}`, pull(`img:${i}`));
      await settle();
      opened[opened.length - 1].resolve(`done-${i}`);
      await job;
      exit({ id: `done-${i}`, code: 0 });
    }
    // One more start trims: the running one and the newest ended ones stay.
    const last = store().start("Último", pull("last:1"));
    await settle();
    opened[opened.length - 1].resolve("last");
    await last;
    const titles = store().jobs.map((j) => j.title);
    expect(titles).toContain("Sigue");
    expect(titles).not.toContain("Job 0");
    expect(store().jobs.filter((j) => j.ended)).toHaveLength(6);
    expect(closeTerminal).toHaveBeenCalledWith("done-0");
  });
});
