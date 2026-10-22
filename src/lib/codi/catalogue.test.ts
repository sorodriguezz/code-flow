import { describe, expect, it, vi } from "vitest";
import type { WindowIdentity } from "../windowIdentity";

/**
 * The catalogue as the backend receives it. The Rust side builds tools from these specs and its
 * model-free router matches spoken orders against `aliases` + `vocabulary`, so the rules pinned here
 * are the ones that would break it silently: ids unique, every enum value nameable in both
 * languages, every phrase lowercase without accents, the destructive ones marked, and each island
 * offered only what acts on what it holds.
 */

vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => null }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {}, emitTo: async () => {} }));
vi.mock("../../state/languageStore", () => {
  const state = { language: "en" };
  const store = Object.assign((select: (s: typeof state) => unknown) => select(state), {
    getState: () => state,
    setState: () => {},
    subscribe: () => () => {},
  });
  return { useLanguageStore: store, useT: () => (key: string) => key, translate: (key: string) => key, languageFromLocale: () => "en" };
});

const { catalogueFor } = await import("./actions");
const { registerActions, actionSpecs, clearActionsForTests } = await import("./registry");

const main: WindowIdentity = { label: "main", main: true, satellite: null, openedIn: null };
const island = (kind: "app" | "repo" | "file" | "quick", refId: string): WindowIdentity => ({
  label: `sat-${kind}-${refId}`,
  main: false,
  satellite: { kind, refId },
  openedIn: null,
});

function specsFor(identity: WindowIdentity) {
  clearActionsForTests();
  registerActions(catalogueFor(identity));
  return actionSpecs();
}

const plain = /^[a-z0-9 ]+$/;

describe("the main window's catalogue", () => {
  const specs = specsFor(main);
  const ids = specs.map((s) => s.id);

  it("has every action of the first wave, once", () => {
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of [
      "app.open", "view.open", "settings.open", "settings.close", "panel.ai", "dock.show", "dock.hide", "sidebar.toggle",
      "palette.open", "palette.search", "palette.run", "nav.back", "nav.forward", "workspace.switch", "workspace.list",
      "repo.switch", "repo.list", "branch.checkout", "branch.list", "island.detach", "island.return", "island.focus",
      "island.list", "chat.ask", "text.type", "text.submit", "editor.open", "editor.save", "git.fetch", "git.pull",
      "git.push", "git.commit", "service.start", "service.stop", "service.restart", "services.list", "terminal.run",
      "notes.create", "notifications.list", "notification.open", "shortcut.run", "ui.state", "ui.controls", "ui.press", "ui.fill",
      // The second wave: the rail apps' own, and undoing a move.
      "nav.undo", "notes.search", "notes.open", "notes.append", "meeting.start", "meeting.stop", "meeting.status",
      "api.send", "api.open", "api.list", "db.open", "db.run", "db.refresh", "flow.run", "flow.open", "flows.list",
      "diagram.open", "diagram.new", "remote.connect", "remote.list", "containers.list", "container.restart",
      "container.logs", "pipelines.open", "pipeline.rerun", "architecture.open", "agent.task", "agents.list",
      "chat.new", "review.pr",
    ]) {
      expect(ids, id).toContain(id);
    }
  });

  it("serializes to plain data", () => {
    expect(JSON.parse(JSON.stringify(specs))).toEqual(JSON.parse(JSON.stringify(specs)));
    expect(specs.every((s) => !("run" in s))).toBe(true);
  });

  it("marks what cannot be taken back, and offers the frequent ones as typed tools", () => {
    const destructive = specs.filter((s) => s.risk === "destructive").map((s) => s.id).sort();
    expect(destructive).toEqual(["container.restart", "db.run", "git.push", "pipeline.rerun", "terminal.run"]);
    const frequent = specs.filter((s) => s.frequent).length;
    expect(frequent).toBeGreaterThanOrEqual(20);
    expect(frequent).toBeLessThanOrEqual(32);
  });

  it("speaks in lowercase without accents", () => {
    for (const spec of specs) {
      for (const phrase of [...(spec.aliases?.es ?? []), ...(spec.aliases?.en ?? [])]) expect(phrase, spec.id).toMatch(plain);
      for (const values of Object.values(spec.vocabulary ?? {})) {
        for (const names of Object.values(values)) {
          for (const phrase of [...names.es, ...names.en]) expect(phrase, spec.id).toMatch(plain);
        }
      }
    }
  });

  it("names every value of every enum param, in both languages", () => {
    for (const spec of specs) {
      const properties = (spec.params as { properties?: Record<string, { enum?: string[] }> }).properties ?? {};
      for (const [param, schema] of Object.entries(properties)) {
        if (!schema.enum) continue;
        const vocabulary = spec.vocabulary?.[param];
        expect(vocabulary, `${spec.id}.${param}`).toBeDefined();
        for (const value of schema.enum) {
          const names = vocabulary?.[value];
          expect(names?.en.length, `${spec.id}.${param}=${value} (en)`).toBeGreaterThan(0);
          // Settings panes and shortcut commands are named from the UI's labels alone, and Spanish
          // is only loaded in a Spanish session — the hand-written sets must not depend on it.
          if (param !== "tab" && param !== "id") expect(names?.es.length, `${spec.id}.${param}=${value} (es)`).toBeGreaterThan(0);
        }
      }
    }
  });

  it("sends every rail app's own action to the window holding that app", () => {
    const where = (id: string) => specs.find((s) => s.id === id)?.where;
    expect(where("notes.open")).toBe("app:notes");
    expect(where("meeting.start")).toBe("app:notes");
    expect(where("api.send")).toBe("app:api:requests");
    expect(where("db.run")).toBe("app:api:database");
    expect(where("flow.run")).toBe("app:flows");
    expect(where("agent.task")).toBe("app:agents");
    expect(where("chat.new")).toBe("app:chat");
    expect(where("container.restart")).toBe("main");
  });

  it("says Flujos and the databases the way people do", () => {
    const vocabulary = specs.find((s) => s.id === "app.open")?.vocabulary?.app;
    expect(vocabulary?.flows.es).toContain("flujos");
    expect(vocabulary?.["api:database"].es).toEqual(expect.arrayContaining(["base de datos", "bd"]));
    expect(vocabulary?.["api:database"].en).toEqual(expect.arrayContaining(["databases", "db"]));
  });
});

describe("an island's catalogue", () => {
  it("in a repository island: its repository's verbs, no shell", () => {
    const ids = specsFor(island("repo", "p1")).map((s) => s.id);
    expect(ids).toEqual(expect.arrayContaining(["git.push", "branch.checkout", "terminal.run", "island.return", "ui.state", "text.type"]));
    for (const id of ["app.open", "repo.switch", "settings.open", "workspace.switch", "palette.run"]) expect(ids).not.toContain(id);
  });

  it("in the Notes island: notes and its own workspace", () => {
    const specs = specsFor(island("app", "notes"));
    const ids = specs.map((s) => s.id);
    expect(ids).toEqual(expect.arrayContaining(["notes.create", "workspace.switch", "island.return"]));
    expect(ids).not.toContain("git.push");
    expect(specs.find((s) => s.id === "notes.create")?.where).toBe("app:notes");
  });

  it("in an app's island: that app's own actions, and no other app's", () => {
    const notes = specsFor(island("app", "notes")).map((s) => s.id);
    expect(notes).toEqual(expect.arrayContaining(["notes.open", "notes.append", "meeting.start", "nav.undo"]));
    expect(notes).not.toContain("api.send");
    const database = specsFor(island("app", "api:database")).map((s) => s.id);
    expect(database).toEqual(expect.arrayContaining(["db.open", "db.run", "db.refresh"]));
    expect(database).not.toContain("api.send");
    expect(specsFor(island("app", "flows")).map((s) => s.id)).toEqual(expect.arrayContaining(["flow.run", "flows.list"]));
  });

  it("in the Chat island: the chat is asked there", () => {
    const chat = specsFor(island("app", "chat")).find((s) => s.id === "chat.ask");
    expect(chat?.where).toBe("app:chat");
  });

  it("nothing at all in the hotkey ask box", () => {
    expect(specsFor(island("quick", "ask"))).toEqual([]);
  });
});
