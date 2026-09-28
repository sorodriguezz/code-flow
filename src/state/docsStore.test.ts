import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DocPage } from "../types/domain";

/**
 * Publishing a document only over the wiki version it was read from: when the page changed since,
 * nothing is written and the user picks what happens — and each answer does exactly that.
 */

type Handler = (args: Record<string, unknown>) => unknown;
let handlers: Record<string, Handler> = {};
let calls: { name: string; args: Record<string, unknown> }[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (name: string, args: Record<string, unknown> = {}) => {
    calls.push({ name, args });
    const handler = handlers[name];
    return handler ? handler(args) : null;
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {} }));
vi.mock("./notificationStore", () => ({ notify: () => {} }));

const { useDocsStore } = await import("./docsStore");
const { useConfirmStore } = await import("./confirmStore");

const page = {
  id: "d1",
  workspace_id: "w1",
  project_id: null,
  scope: "workspace",
  title: "Arquitectura",
  content: "# Mío",
  ado_org: "acme",
  ado_project: "Plataforma",
  wiki_id: "wiki-1",
  wiki_name: "Wiki",
  page_path: "/Arquitectura",
  published_at: "",
  published_url: "",
  engine: "",
  model: "",
  version: "",
  status: "ready",
  last_error: "",
  created_at: "",
  updated_at: "",
} as unknown as DocPage;

async function asked() {
  for (let i = 0; i < 100; i++) {
    const request = useConfirmStore.getState().request;
    if (request) return request;
    await Promise.resolve();
  }
  throw new Error("nothing was asked");
}

const publishes = () => calls.filter((call) => call.name === "publish_doc_page").map((call) => call.args.overwrite);

beforeEach(() => {
  calls = [];
  useConfirmStore.setState({ request: null });
  useDocsStore.setState({ pages: [page], selectedId: "d1", draft: null, publishing: false, workspaceId: "w1" });
  let first = true;
  handlers = {
    publish_doc_page: (args) => {
      if (first && !args.overwrite) {
        first = false;
        throw "WIKI_CONFLICT::412 Precondition Failed";
      }
      return { path: "/Arquitectura", url: "https://example.invalid/wiki", updated: true, etag: '"v2"' };
    },
    reload_doc_page_from_wiki: () => ({ ...page, content: "# Suyo" }),
  };
});

describe("publishing over a page that changed", () => {
  it("asks, with keeping the work as the default and overwriting as the danger", async () => {
    const run = useDocsStore.getState().publish();
    const request = await asked();
    expect(request.choices?.map((choice) => choice.id)).toEqual(["keep", "reload", "overwrite"]);
    expect(request.choices?.[0].variant).toBe("primary");
    expect(request.choices?.[2].variant).toBe("danger");
    useConfirmStore.getState().pick("keep");
    await run;
    expect(publishes()).toEqual([false]);
    expect(useDocsStore.getState().pages[0].content).toBe("# Mío");
  });

  it("overwrites only when told to", async () => {
    const run = useDocsStore.getState().publish();
    await asked();
    useConfirmStore.getState().pick("overwrite");
    await run;
    expect(publishes()).toEqual([false, true]);
    expect(useDocsStore.getState().pages[0].published_url).toBe("https://example.invalid/wiki");
  });

  it("reloads the wiki's version over the local one", async () => {
    const run = useDocsStore.getState().publish();
    await asked();
    useConfirmStore.getState().pick("reload");
    await run;
    expect(calls.some((call) => call.name === "reload_doc_page_from_wiki")).toBe(true);
    expect(useDocsStore.getState().pages[0].content).toBe("# Suyo");
    expect(publishes()).toEqual([false]);
  });
});
