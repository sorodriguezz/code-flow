import { open, save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { apiReadTextFile } from "../tauri/apiCommands";
import { writeFileBytes } from "../tauri/commands";
import { safeFileName } from "../diagrams/exportFile";
import { AGENT_CONFIGURATION, CONFIGURATION_ERRORS, EMPTY_TEXT, MAX_CONFIGURATION_BYTES, ZERO, configurationForExport, parseConfiguration, type ConfigurationFile, type ConfigurationImport, type SharingProject } from "./shareConfiguration";
import type { Team } from "../../types/team";
import type { WorkspaceAgent } from "../../types/domain";

const FILE_FILTER = { name: "CodeFlow agents / teams", extensions: ["json"] };
const FILE_SUFFIX = ".codeflow.json";
const FALLBACK_NAME = "configuration";
const JSON_INDENTATION = 2;
const LINE_ENDING = "\n";
const IMPORT_COMMAND = "crew_import_configuration";
const SINGLE_PATH_TYPE = "string";

export interface ImportedConfiguration {
  agents: WorkspaceAgent[];
  team: Team | null;
}

export async function exportConfiguration(source: WorkspaceAgent | Team, roster: WorkspaceAgent[], projects: SharingProject[]): Promise<boolean> {
  const file = configurationForExport(source, roster, projects);
  const name = safeFileName(source.name, FALLBACK_NAME);
  const serialized = JSON.stringify(file, null, JSON_INDENTATION);
  const encoder = new TextEncoder();
  const bytes = encoder.encode(`${serialized}${LINE_ENDING}`);
  if (bytes.length > MAX_CONFIGURATION_BYTES) throw new Error(CONFIGURATION_ERRORS.size);
  const path = await save({ defaultPath: `${name}${FILE_SUFFIX}`, filters: [FILE_FILTER] });
  if (!path) return false;
  await writeFileBytes(path, bytes);
  return true;
}

export async function openConfiguration(kind: ConfigurationFile["kind"]): Promise<ConfigurationFile | null> {
  const path = await open({ multiple: false, filters: [FILE_FILTER] });
  const singlePath = typeof path === SINGLE_PATH_TYPE;
  if (!singlePath) return null;
  const selectedPath = path as string;
  const contents = await apiReadTextFile(selectedPath);
  const file = parseConfiguration(contents);
  if (file.kind !== kind) throw new Error(CONFIGURATION_ERRORS.invalid);
  return file;
}

export async function importConfiguration(workspaceId: string, configuration: ConfigurationImport): Promise<ImportedConfiguration> {
  const hasAgents = configuration.agents.length > ZERO;
  const hasTeam = configuration.team !== null;
  if (workspaceId === EMPTY_TEXT || (!hasAgents && !hasTeam)) throw new Error(CONFIGURATION_ERRORS.invalid);
  return invoke<ImportedConfiguration>(IMPORT_COMMAND, { workspaceId, ...configuration });
}

export function configurationName(file: ConfigurationFile): string {
  return file.kind === AGENT_CONFIGURATION ? file.agents[ZERO].configuration.name : file.team?.name ?? EMPTY_TEXT;
}
