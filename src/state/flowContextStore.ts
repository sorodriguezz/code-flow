import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { Workflow } from "lucide-react";
import type { MenuItem } from "../components/common/ContextMenu";
import { flowsContextEntries, flowsContextRun, type FlowContextEntry, type FlowContextPlace } from "../lib/tauri/flowsCommands";
import { chooseAction, confirmAction } from "./confirmStore";
import { translate } from "./languageStore";
import { pushErrorToast, pushSuccessToast } from "./toastStore";
import { useWorkspaceStore } from "./workspaceStore";

/**
 * What active flows offer on a right click («Menú contextual» triggers), by place, for the active
 * workspace — kept here so a menu, which is built the instant it opens, can list them without a
 * round trip. Read again whenever the armed triggers change (`flows:triggers`) or the workspace does.
 */

const PLACES: FlowContextPlace[] = ["file", "folder", "selection", "commit", "pr"];

interface FlowContextState {
  workspaceId: string | null;
  entries: Record<FlowContextPlace, FlowContextEntry[]>;
  load: (workspaceId: string) => Promise<void>;
}

const empty = (): Record<FlowContextPlace, FlowContextEntry[]> => ({ file: [], folder: [], selection: [], commit: [], pr: [] });

/** Each load's number: an answer that arrives after a later load's is dropped. Two loads race when
 *  the workspace changes while one is in flight, and the older could otherwise land last. */
let loads = 0;

export const useFlowContextStore = create<FlowContextState>((set) => ({
  workspaceId: null,
  entries: empty(),
  load: async (workspaceId) => {
    const mine = ++loads;
    try {
      const lists = await Promise.all(PLACES.map((place) => flowsContextEntries(workspaceId, place, null)));
      if (mine !== loads) return;
      const entries = empty();
      PLACES.forEach((place, index) => {
        entries[place] = lists[index];
      });
      set({ workspaceId, entries });
    } catch {
      if (mine === loads) set({ workspaceId, entries: empty() });
    }
  },
}));

let started = false;

/** Starts following the armed flows — once, wherever a menu that lists them first mounts. */
export function ensureFlowContextEntries(): void {
  if (started) return;
  started = true;
  const reload = () => {
    const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;
    if (workspaceId) void useFlowContextStore.getState().load(workspaceId);
  };
  reload();
  void listen("flows:triggers", reload);
  useWorkspaceStore.subscribe((state, previous) => {
    if (state.activeWorkspaceId !== previous.activeWorkspaceId) reload();
  });
}

/** `*.csv, report-*` split into patterns — on the commas outside braces, so `*.{ts,tsx}` stays one. */
export function splitPatterns(patterns: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of patterns) {
    if (char === "{") depth += 1;
    if (char === "}") depth = Math.max(0, depth - 1);
    if (char === "," && depth === 0) {
      out.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  out.push(current);
  return out.map((p) => p.trim()).filter(Boolean);
}

/** One glob as a regular expression: `**` across folders (`**\/` also matching none), `*` and `?`
 *  within a name, `[abc]`/`[!abc]` classes and `{a,b}` alternatives — the shapes people write. */
function globSource(pattern: string): string {
  let out = "";
  let inClass = false;
  let braces = 0;
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (inClass) {
      if (char === "]") inClass = false;
      out += char === "\\" ? "\\\\" : char;
      continue;
    }
    if (char === "*" && pattern[i + 1] === "*") {
      const slash = pattern[i + 2] === "/";
      out += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (char === "*") {
      out += "[^/]*";
    } else if (char === "?") {
      out += "[^/]";
    } else if (char === "[") {
      inClass = true;
      out += "[";
      if (pattern[i + 1] === "!") {
        out += "^";
        i += 1;
      }
    } else if (char === "{") {
      braces += 1;
      out += "(?:";
    } else if (char === "}" && braces > 0) {
      braces -= 1;
      out += ")";
    } else if (char === "," && braces > 0) {
      out += "|";
    } else {
      out += char.replace(/[.+^$()|\\]/g, "\\$&");
    }
  }
  return out;
}

/**
 * The trigger's «Solo archivos como» against a file: a pattern with a folder in it (`src/**\/*.ts`)
 * against its path in the repository, any other against its name — `*.csv`, `**\/*.ts`,
 * `*.{ts,tsx}`, `report-[0-9]*`. Case-insensitive, like the file systems people mostly use.
 */
export function globMatches(patterns: string, path: string): boolean {
  const list = splitPatterns(patterns);
  const relative = path.replace(/\\/g, "/").replace(/^\.\//, "");
  const name = relative.split("/").pop() ?? "";
  if (list.length === 0 || !name) return true;
  return list.some((pattern) => {
    const target = pattern.replace(/^\*\*\//, "").includes("/") ? relative : name;
    try {
      return new RegExp(`^${globSource(pattern.replace(/^\*\*\//, ""))}$`, "i").test(target);
    } catch {
      return target.toLowerCase().includes(pattern.toLowerCase());
    }
  });
}

/** The entries for a place — for a file (or a selection in one), only those whose pattern fits it.
 *  A folder is not filtered: the pattern is about files. */
export function flowEntriesFor(place: FlowContextPlace, path?: string | null): FlowContextEntry[] {
  const filtered = (place === "file" || place === "selection") && !!path;
  return useFlowContextStore.getState().entries[place].filter((entry) => !entry.glob || !filtered || globMatches(entry.glob, path ?? ""));
}

/** Starts the entry's flow with what was right-clicked — asking first when its trigger says so. */
export async function runFlowEntry(entry: FlowContextEntry, payload: Record<string, unknown>): Promise<void> {
  if (entry.askFirst && !(await confirmAction(translate("flows.context.ask", { label: entry.label, flow: entry.flowName }), false, translate("flows.context.run")))) {
    return;
  }
  try {
    const answer = await flowsContextRun(entry.flowId, entry.nodeId, { place: payload.place, ...payload });
    pushSuccessToast(answer.held ? translate("flows.context.held", { flow: entry.flowName }) : translate("flows.context.started", { flow: entry.flowName }));
  } catch (error) {
    pushErrorToast(String(error));
  }
}

/** The menu rows for a place, each starting its flow with `payload`. */
export function flowMenuItems(place: FlowContextPlace, path: string | null, payload: () => Record<string, unknown>, separated = true): MenuItem[] {
  return flowEntriesFor(place, path).map((entry, index) => ({
    label: entry.label,
    icon: Workflow,
    separated: separated && index === 0,
    onClick: () => void runFlowEntry(entry, { place, ...payload() }),
  }));
}

/** For a menu that cannot grow rows of its own (Monaco's): one row that asks which flow, then runs it. */
export async function pickAndRunFlow(place: FlowContextPlace, path: string | null, payload: Record<string, unknown>): Promise<void> {
  const entries = flowEntriesFor(place, path);
  if (entries.length === 0) {
    pushErrorToast(translate("flows.context.none"));
    return;
  }
  let chosen: FlowContextEntry | undefined = entries[0];
  if (entries.length > 1) {
    const id = await chooseAction({
      message: translate("flows.context.which"),
      choices: entries.map((e) => ({ id: `${e.flowId}/${e.nodeId}`, label: `${e.label} — ${e.flowName}` })),
    });
    chosen = entries.find((e) => `${e.flowId}/${e.nodeId}` === id);
  }
  if (chosen) await runFlowEntry(chosen, { place, ...payload });
}
