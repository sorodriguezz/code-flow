import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VersionLine } from "../lib/scaffold/api";

const fetchVersions = vi.fn<(source: unknown) => Promise<VersionLine[]>>();

vi.mock("../lib/scaffold/api", () => ({
  detectTools: vi.fn(),
  fetchVersions: (source: unknown) => fetchVersions(source),
  springMetadata: vi.fn(),
}));
vi.mock("../lib/tauri/commands", () => ({ getSetting: vi.fn(), setSetting: vi.fn() }));

const { useScaffoldStore } = await import("./scaffoldStore");

const SOURCE = { kind: "npm", package: "@angular/cli" } as const;
const KEY = "npm:@angular/cli";
const line = (version: string): VersionLine => ({ version, line: version.split(".")[0], channel: "latest", requires: null, eol: false });
const HOUR = 60 * 60 * 1000;

/** Lets the store's promise chain settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("registry answers in the initializer", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-26T12:00:00Z"));
    fetchVersions.mockReset();
    useScaffoldStore.setState({ versions: {} });
  });
  afterEach(() => vi.useRealTimers());

  it("are reused within the hour and fetched again after it", async () => {
    fetchVersions.mockResolvedValueOnce([line("22.2.0")]);
    useScaffoldStore.getState().loadVersions(SOURCE);
    await settle();
    expect(useScaffoldStore.getState().versions[KEY]?.data?.[0].version).toBe("22.2.0");

    vi.setSystemTime(Date.now() + HOUR - 1000);
    useScaffoldStore.getState().loadVersions(SOURCE);
    expect(fetchVersions).toHaveBeenCalledTimes(1);

    // An hour on, a release came out. The refresh keeps the old lines on screen while it runs.
    vi.setSystemTime(Date.now() + 2000);
    let release: (lines: VersionLine[]) => void = () => {};
    fetchVersions.mockReturnValueOnce(new Promise((resolve) => (release = resolve)));
    useScaffoldStore.getState().loadVersions(SOURCE);
    useScaffoldStore.getState().loadVersions(SOURCE);
    expect(fetchVersions).toHaveBeenCalledTimes(2);
    expect(useScaffoldStore.getState().versions[KEY]?.status).toBe("ready");
    expect(useScaffoldStore.getState().versions[KEY]?.data?.[0].version).toBe("22.2.0");

    release([line("23.0.0")]);
    await settle();
    expect(useScaffoldStore.getState().versions[KEY]?.data?.[0].version).toBe("23.0.0");
  });

  it("keep what they had when a refresh fails, and try again minutes later", async () => {
    fetchVersions.mockResolvedValueOnce([line("22.2.0")]);
    useScaffoldStore.getState().loadVersions(SOURCE);
    await settle();

    vi.setSystemTime(Date.now() + HOUR + 1000);
    fetchVersions.mockRejectedValueOnce(new Error("offline"));
    useScaffoldStore.getState().loadVersions(SOURCE);
    await settle();
    const kept = useScaffoldStore.getState().versions[KEY];
    expect(kept?.status).toBe("ready");
    expect(kept?.data?.[0].version).toBe("22.2.0");

    useScaffoldStore.getState().loadVersions(SOURCE);
    expect(fetchVersions).toHaveBeenCalledTimes(2);
    vi.setSystemTime(Date.now() + 5 * 60 * 1000);
    fetchVersions.mockResolvedValueOnce([line("23.0.0")]);
    useScaffoldStore.getState().loadVersions(SOURCE);
    await settle();
    expect(fetchVersions).toHaveBeenCalledTimes(3);
    expect(useScaffoldStore.getState().versions[KEY]?.data?.[0].version).toBe("23.0.0");
  });

  it("report a first load that fails as an error, and retry it on the next ask", async () => {
    fetchVersions.mockRejectedValueOnce(new Error("offline"));
    useScaffoldStore.getState().loadVersions(SOURCE);
    await settle();
    expect(useScaffoldStore.getState().versions[KEY]?.status).toBe("error");

    fetchVersions.mockResolvedValueOnce([line("22.2.0")]);
    useScaffoldStore.getState().loadVersions(SOURCE);
    await settle();
    expect(useScaffoldStore.getState().versions[KEY]?.status).toBe("ready");
  });
});
