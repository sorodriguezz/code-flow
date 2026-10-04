import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../state/languageStore", () => ({
  useT: () => (key: string, params?: Record<string, unknown>) => (params ? `${key} ${JSON.stringify(params)}` : key),
}));

// The store, stood in for. A static render reads a zustand store's *initial* state (its server
// snapshot), so `setState` on the real one could never show here — see `ThinkingOrb.test.tsx`.
const store = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));
vi.mock("../../state/driverStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/driverStore")>();
  const hook = (select: (state: never) => unknown) => select(store.state as never);
  return {
    ...actual,
    useDriverStore: Object.assign(hook, {
      getState: () => store.state,
      setState: (partial: Record<string, unknown>) => Object.assign(store.state, partial),
    }),
  };
});

import { DriversView } from "./DriversView";
import { DriverDownloadDialog } from "./DriverDownloadDialog";
import { useDriverStore } from "../../state/driverStore";
import type { DbDriverSettings, DbDriversOverview } from "../../types/database";

/**
 * The Drivers half of the connection dialog and the "Incomplete configuration" question, drawn from
 * the real catalogue. What they promise: a JDBC driver shows its files and what downloading them
 * costs, a built-in one says there is nothing to download, a driver of the user's own is listed
 * under its own heading — and the question names everything a download will fetch.
 */

const overview = (ready: boolean, runtime: boolean): DbDriversOverview => ({
  runtime: { ready: runtime, release: runtime ? "jdk-21.0.8+9" : null, java: 21, path: null },
  drivers: [
    {
      id: "db2",
      files: [{ name: "jcc-12.1.2.0.jar", version: "12.1.2.0", size: 4_500_000, present: ready, user: false, path: "" }],
      ready,
      downloadBytes: ready ? 0 : 4_500_000,
    },
  ],
  root: "C:/state/drivers",
});

const custom: DbDriverSettings = {
  id: "custom-1",
  custom: true,
  name: "Acme DB",
  basedOn: "",
  class: "com.acme.Driver",
  files: ["C:/drivers/acme.jar"],
  urls: [],
  properties: [],
  vmOptions: "",
  vmEnv: [],
  javaHome: "",
};

const render = (selected: string, drafts = {}) =>
  renderToStaticMarkup(
    <DriversView
      selected={selected}
      onSelect={() => {}}
      drafts={drafts}
      onDraft={() => {}}
      onCreateDataSource={() => {}}
      usage={{ db2: 2 }}
    />,
  );

beforeEach(() => {
  store.state = {};
  useDriverStore.setState({
    overview: overview(false, false),
    overviewAt: 1,
    settings: [custom],
    progress: [],
    downloading: [],
    errors: {},
    prompt: null,
    focus: null,
  });
});

describe("DriversView", () => {
  it("lists the catalogue under its headings, with the user's drivers apart", () => {
    const markup = render("db2");
    expect(markup).toContain("db.drivers.groupComplete");
    expect(markup).toContain("db.drivers.groupBasic");
    expect(markup).toContain("db.drivers.groupUser");
    expect(markup).toContain("Snowflake");
    expect(markup).toContain("Acme DB");
  });

  it("shows a JDBC driver's class, its files and what downloading them costs", () => {
    const markup = render("db2");
    expect(markup).toContain("com.ibm.db2.jcc.DB2Driver");
    expect(markup).toContain("db.drivers.downloadVersion");
    expect(markup).toContain("db.drivers.urlTemplates");
    expect(markup).toContain("db.drivers.runtimeMissing");
    expect(markup).toContain("db.drivers.usedBy {&quot;n&quot;:2}");
  });

  it("says a built-in driver has nothing to download", () => {
    const markup = render("cockroachdb");
    expect(markup).toContain("db.drivers.builtIn");
    expect(markup).not.toContain("db.drivers.files");
  });

  it("keeps the URL templates of Oracle's own session out of its panel", () => {
    expect(render("oracle")).not.toContain("db.drivers.urlTemplates");
  });

  it("lets a driver of the user's own be named and based on another", () => {
    const markup = render("custom-1");
    expect(markup).toContain('value="Acme DB"');
    expect(markup).toContain("db.drivers.basedOn");
    expect(markup).toContain("C:/drivers/acme.jar");
  });
});

describe("DriverDownloadDialog", () => {
  it("names everything a download will fetch, the runtime included", () => {
    useDriverStore.setState({
      prompt: { driverId: "db2", kind: "missing", message: "IBM Db2 needs its driver files.", askedAt: 2 },
    });
    const markup = renderToStaticMarkup(<DriverDownloadDialog />);
    expect(markup).toContain("db.drivers.incompleteTitle");
    expect(markup).toContain("db.drivers.runtimeName");
    expect(markup).toContain("jcc-12.1.2.0.jar");
    expect(markup).toContain("db.drivers.downloadFiles");
  });

  it("sends a driver nobody may redistribute to its settings instead", () => {
    useDriverStore.setState({
      prompt: { driverId: "denodo", kind: "manual", message: "Get them from the vendor.", askedAt: 2 },
    });
    const markup = renderToStaticMarkup(<DriverDownloadDialog />);
    expect(markup).toContain("Get them from the vendor.");
    expect(markup).toContain("db.drivers.openSettings");
    expect(markup).not.toContain("db.drivers.downloadFiles");
  });

  it("is not there when nothing is being asked", () => {
    expect(renderToStaticMarkup(<DriverDownloadDialog />)).toBe("");
  });
});
