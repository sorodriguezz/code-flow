import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceAgent } from "../../types/domain";
import { emptyTeam } from "../../types/team";
import { AGENT_CONFIGURATION, CONFIGURATION_ERRORS, EMPTY_TEXT, ONE, TEAM_CONFIGURATION, ZERO, configurationForExport } from "./shareConfiguration";
import { exportConfiguration, importConfiguration, openConfiguration } from "./configurationFiles";

const mocks = vi.hoisted(() => ({ open: vi.fn(), save: vi.fn(), read: vi.fn(), write: vi.fn(), invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open, save: mocks.save }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("../tauri/apiCommands", () => ({ apiReadTextFile: mocks.read }));
vi.mock("../tauri/commands", () => ({ writeFileBytes: mocks.write }));
vi.mock("../diagrams/exportFile", () => ({ safeFileName: (name: string) => name }));

const SUITE = "configuration file dialogs and persistence";
const TESTS = {
  cancelExport: "cancels export without writing a file",
  export: "writes a portable JSON document through the selected path",
  cancelImport: "cancels import without reading or saving anything",
  read: "reads a compatible file without persisting it before review",
  wrongKind: "rejects team files in the agent importer",
  import: "sends agents and their team to one atomic backend command",
  invalid: "does not persist empty imports",
} as const;
const PATH = "/tmp/shared-configuration.codeflow.json";
const WORKSPACE = "test-workspace";
const NAME = "Asesor";
const PROVIDER = "claude";
const MODEL = "claude-sonnet";
const IMPORT_COMMAND = "crew_import_configuration";
const agent: WorkspaceAgent = { id: NAME, workspace_id: WORKSPACE, name: NAME, role: EMPTY_TEXT, provider: PROVIDER, model: MODEL, prompt: EMPTY_TEXT, enabled: true, sort_order: ZERO, created_at: EMPTY_TEXT };

beforeEach(() => { vi.resetAllMocks(); });

describe(SUITE, () => {
  it(TESTS.cancelExport, async () => {
    mocks.save.mockResolvedValue(null);
    const result = await exportConfiguration(agent, [agent], []);
    expect(result).toBe(false);
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it(TESTS.export, async () => {
    mocks.save.mockResolvedValue(PATH);
    const result = await exportConfiguration(agent, [agent], []);
    expect(result).toBe(true);
    expect(mocks.write).toHaveBeenCalledTimes(ONE);
    const [path, bytes] = mocks.write.mock.calls[ZERO];
    expect(path).toBe(PATH);
    const decoder = new TextDecoder();
    const text = decoder.decode(bytes);
    const file = JSON.parse(text);
    const expected = configurationForExport(agent, [agent], []);
    expect(file).toEqual(expected);
  });

  it(TESTS.cancelImport, async () => {
    mocks.open.mockResolvedValue(null);
    const result = await openConfiguration(AGENT_CONFIGURATION);
    expect(result).toBeNull();
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it(TESTS.read, async () => {
    const file = configurationForExport(agent, [agent], []);
    const contents = JSON.stringify(file);
    mocks.open.mockResolvedValue(PATH);
    mocks.read.mockResolvedValue(contents);
    const result = await openConfiguration(AGENT_CONFIGURATION);
    expect(result).toEqual(file);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it(TESTS.wrongKind, async () => {
    const team = { ...emptyTeam(WORKSPACE), name: NAME };
    const file = configurationForExport(team, [], []);
    expect(file.kind).toBe(TEAM_CONFIGURATION);
    const contents = JSON.stringify(file);
    mocks.open.mockResolvedValue(PATH);
    mocks.read.mockResolvedValue(contents);
    const attempt = openConfiguration(AGENT_CONFIGURATION);
    await expect(attempt).rejects.toThrow(CONFIGURATION_ERRORS.invalid);
  });

  it(TESTS.import, async () => {
    const team = { ...emptyTeam(WORKSPACE), name: NAME };
    const configuration = { agents: [], team };
    const saved = { agents: [], team };
    mocks.invoke.mockResolvedValue(saved);
    const result = await importConfiguration(WORKSPACE, configuration);
    expect(result).toEqual(saved);
    expect(mocks.invoke).toHaveBeenCalledTimes(ONE);
    expect(mocks.invoke).toHaveBeenCalledWith(IMPORT_COMMAND, { workspaceId: WORKSPACE, ...configuration });
  });

  it(TESTS.invalid, async () => {
    const attempt = importConfiguration(WORKSPACE, { agents: [], team: null });
    await expect(attempt).rejects.toThrow(CONFIGURATION_ERRORS.invalid);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
