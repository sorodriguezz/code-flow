import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * The bridge between «Codi» (the voice assistant, run by `src-tauri/src/codi/`) and the windows it
 * drives. Two halves:
 *
 * - **Actions** (`lib/codi/actions`): every window registers the catalogue of what it can do and
 *   answers `codi:act` requests addressed to it. The backend turns the catalogue into the tools an
 *   engine sees (`cf ui`, the app's MCP server, the local agent) — one list, three doors.
 * - **The runtime's state** (`codi:*` events): what the Codi window draws — listening, the words
 *   heard, what it did, what it asks to confirm.
 */

/** How much an action can change. `destructive` ones are confirmed by the user before they run. */
export type CodiRisk = "read" | "navigate" | "write" | "destructive";

/** One action a window can run. `id` is dotted (`app.open`); a tool's name is the id with `_`. */
export interface CodiActionSpec {
  id: string;
  /** What it does, in both of the app's languages — the tool's description. */
  title: { es: string; en: string };
  /** Spoken verb phrases that pick it, lowercase without accents, for the router that needs no
   *  model ("abre", "cambia al repositorio", "open"…). */
  aliases?: { es: string[]; en: string[] };
  /** For a param, for each of its enum values, the names a user says for it — `{ app: { flows: { es:
   *  ["flujos"], en: ["flows"] } } }`. What lets «abre flujos» run without a model. */
  vocabulary?: Record<string, Record<string, { es: string[]; en: string[] }>>;
  /** How a *question* names it — «cómo funciona», "how does" — for the few actions that answer one
   *  by acting (a tour explains an app). The router takes a question only through these, and only
   *  when every word of it is explained. */
  questions?: { es: string[]; en: string[] };
  /** JSON Schema of `params` (an object schema). Enums wherever the values are a closed set. */
  params: Record<string, unknown>;
  risk: CodiRisk;
  /** Where it runs: `main`, `any` (whichever window is asked), or `app:<appKey>` (the window holding
   *  that rail app — an island when it is detached, else main). */
  where: string;
  /** Typed tools are offered to small local models only for the frequent ones; the rest go through
   *  the generic `ui_act`. */
  frequent?: boolean;
}

/** A request the backend sends one window. Every window hears every request (a global `listen`
 *  receives events of any target), so each answers only those carrying its own label. */
export interface CodiActRequest {
  id: string;
  /** The label of the window that should run it (`main`, `sat-app-notes`…). */
  window: string;
  action: string;
  params: Record<string, unknown>;
}

/** The window's answer. `result` is shown to the engine (keep it short); `say` is what Codi says
 *  when the action alone answers the order ("Listo, abrí Flujos"). */
export interface CodiActResult {
  id: string;
  ok: boolean;
  result?: unknown;
  say?: string;
  error?: string;
  /** Not what was asked, but what was probably meant: `say` asks it as a yes or no, and a yes runs
   *  this action (`codi::brain`). */
  offer?: CodiOffer;
}

/** An action another proposes, with its params. A failed action asks it with its `say`; one that
 *  worked says what it found and then asks `question` («¿Quieres que analice el registro?»). */
export interface CodiOffer {
  action: string;
  params: Record<string, unknown>;
  question?: string;
}

export const codiRegisterActions = (window: string, actions: CodiActionSpec[]) => invoke<void>("codi_register_actions", { window, actions });
export const codiActResult = (answer: CodiActResult) => invoke<void>("codi_act_result", { answer });
export const onCodiAct = (handler: (request: CodiActRequest) => void): Promise<UnlistenFn> =>
  listen<CodiActRequest>("codi:act", (event) => handler(event.payload));

// ------------------------------------------------------------------------------------ the runtime

/** `codi::Phase`: what Codi is doing. */
export type CodiPhase = "off" | "idle" | "hearing" | "thinking" | "acting" | "speaking" | "waiting";

/** `codi::CodiState` — what Codi's window draws (`codi:state`). */
export interface CodiState {
  phase: CodiPhase;
  mic: boolean;
  sound: boolean;
  /** `wake` (by name, the default) · `conversation` · `ptt`. */
  mode: "wake" | "conversation" | "ptt";
  /** The listener in use (`parakeet`, `small`…), `""` when none is usable. */
  listenModel: string;
  /** What must be downloaded before the microphone can open. */
  missing: ("library" | "detector" | "listener")[];
  error: string | null;
  /** The push-to-talk key is held. */
  talking: boolean;
  /** The system-wide push-to-talk chord (`Ctrl+Shift+Space`), when in push-to-talk and one is chosen. */
  pttKey: string | null;
}

/** `codi:heard`: one utterance, transcribed. `ignored` says why it was not acted on. */
export interface CodiHeard {
  text: string;
  addressed: boolean;
  ignored: "name" | "own" | "quiet" | null;
}

/** One action of a turn. */
export interface CodiActed {
  action: string;
  params: Record<string, unknown>;
  ok: boolean;
  say: string | null;
  error: string | null;
}

/** `codi:turn`: an order and what came of it. */
export interface CodiTurn {
  id: number;
  order: string;
  reply: string;
  /** `own` (its own words) · `router` (no model) · `local` · `provider`. */
  tier: "own" | "router" | "local" | "provider";
  actions: CodiActed[];
  ms: number;
  error: string | null;
}

/** `codi:confirm`: a destructive action waiting for a yes (`answer: null`), or its answer. */
export interface CodiConfirmation {
  id: string;
  action: string;
  params: Record<string, unknown>;
  what: string;
  answer: boolean | null;
}

/** `codi:prepare`: a download of what Codi needs. `item`: `library` · `detector` · a model id. */
export interface CodiPrepare {
  item: string;
  done: number;
  total: number;
}

/** The error `codiSetMic(true)` fails with when something is missing: `CODI_MISSING:library,listener`. */
export const CODI_MISSING = "CODI_MISSING";

export const codiStatus = () => invoke<CodiState>("codi_status");
export const codiOpenWindow = () => invoke<string>("codi_open_window");
export const codiSetMic = (on: boolean) => invoke<CodiState>("codi_set_mic", { on });
export const codiSetSound = (on: boolean) => invoke<CodiState>("codi_set_sound", { on });
export const codiTalk = (held: boolean) => invoke<void>("codi_talk", { held });
/** The push-to-talk chord chosen (`null` = switched off) and this build's default. */
export const codiPttHotkey = () => invoke<{ accelerator: string | null; defaultAccelerator: string }>("codi_ptt_hotkey");
/** `off`, or `""` for the default. Rejects when the system refused the chord. */
export const codiSetPttHotkey = (accelerator: string) => invoke<void>("codi_set_ptt_hotkey", { accelerator });
/** Frees the chord while a new one is being recorded. */
export const codiSuspendPttHotkey = (suspended: boolean) => invoke<void>("codi_suspend_ptt_hotkey", { suspended });
export const codiOrder = (text: string) => invoke<void>("codi_order", { text });
export const codiConfirm = (id: string, yes: boolean) => invoke<boolean>("codi_confirm", { id, yes });
export const codiHush = () => invoke<void>("codi_hush");
/** How a narrated line ended: said whole, stopped (hushed, talked over, overtaken), Codi's sound
 *  off, or failed. */
export type CodiNarration = "done" | "stopped" | "silent" | "failed";
/** Researches a question in a repository's code, read-only, in the background; Codi says the
 *  answer when it is ready. Rejects when the folder is gone or three are already running. */
export const codiResearch = (path: string, name: string, question: string) => invoke<void>("codi_research", { path, name, question });

/** What the index gave a fast answer (`codi::research::Looked`). */
export interface CodiLooked {
  found: number;
  partial: string[];
  ms: number;
}

/** Answers `question` from what the app has indexed — the repository at `path`, or the workspace with
 *  none — the answer told when written. `deep` is offered when the index does not answer it. */
export const codiKnow = (path: string | null, workspaceId: string, subject: string, question: string, deep: CodiOffer | null) =>
  invoke<CodiLooked>("codi_know", { path, workspaceId, subject, question, deep });
/** Explains `material` (a container's log, credentials already redacted) to answer `question` about
 *  `subject`, in the background; Codi says the answer when it is ready. */
export const codiExplain = (subject: string, question: string, material: string) => invoke<void>("codi_explain", { subject, question, material });
/** Why the run `runId` of `projectId` failed, read from its failed job's log in the background; told when ready. */
export const codiExplainPipeline = (projectId: string, runId: string, subject: string, question: string) =>
  invoke<void>("codi_explain_pipeline", { projectId, runId, subject, question });
/** Says one step of a guided tour in Codi's voice, after the turn under way (and its answer). */
export const codiNarrate = (text: string) => invoke<CodiNarration>("codi_narrate", { text });
export const codiAnnounce = (text: string, source: string) => invoke<void>("codi_announce", { text, source });
/** One recollection of an earlier session: when (unix seconds) and what it keeps. */
export interface CodiRecollection {
  id: number;
  at: number;
  text: string;
}
/** What Codi keeps from earlier sessions, newest first. */
export const codiRecollections = () => invoke<CodiRecollection[]>("codi_recollections");
/** One recollection forgotten. */
export const codiForget = (id: number) => invoke<void>("codi_forget", { id });
/** The apps installed on this computer, by name. */
export const codiInstalledApps = () => invoke<string[]>("codi_installed_apps");
/** Every action Codi can run now: its own (`native`) and every window's. */
export const codiActionCatalog = () => invoke<CodiActionSpec[]>("codi_action_catalog");
/** «Olvidar todo»: every recollection of earlier sessions goes. */
export const codiForgetAll = () => invoke<void>("codi_forget_all");
/** What an action finished after its turn answered, told in Codi's voice even with the microphone off. */
/** Told in Codi's voice once nothing else is being said; with an `offer` that has a question, it is
 *  asked next and a yes runs it (`codi_cmd::codi_tell`). */
export const codiTell = (text: string, source: string, offer: CodiOffer | null = null) => invoke<void>("codi_tell", { text, source, offer });

/** What a shell command run out of sight came to (`codi_cmd::codi_run_command`). */
export interface CodiCommandRun {
  /** `null` when it was stopped (the time ran out) or ended by a signal. */
  code: number | null;
  /** The end of what it printed, without colours, with any credential masked. */
  output: string;
  timedOut: boolean;
  ms: number;
}
export const codiRunCommand = (cwd: string, command: string) => invoke<CodiCommandRun>("codi_run_command", { cwd, command });
export const codiPrepare = () => invoke<CodiState>("codi_prepare");
/** Codi's window back to the top-right corner, forgetting where it was left. */
export const codiWindowToCorner = () => invoke<void>("codi_window_to_corner");
/** «Abrir Codi al encender el equipo» — switching it on also switches on CodeFlow's login item.
 *  Answers whether CodeFlow now starts at login. */
export const codiSetAtLogin = (on: boolean) => invoke<boolean>("codi_set_at_login", { on });

/** One step of a routine (`codi::routines::Step`). */
export type CodiRoutineStep =
  | { kind: "search"; query: string; pages?: number }
  | { kind: "read"; url: string }
  | { kind: "readApp"; app: string }
  | { kind: "open"; target: string }
  | { kind: "say"; text: string }
  | { kind: "command"; command: string; cwd?: string }
  | { kind: "action"; action: string; params?: Record<string, unknown> }
  | { kind: "answer"; instruction: string };

/** A routine: the sentences that start it (`{slot}` takes words), its slots' defaults, its steps. */
export interface CodiRoutine {
  id: string;
  name: string;
  phrases: string[];
  defaults: Record<string, string>;
  steps: CodiRoutineStep[];
  enabled: boolean;
}

/** The routines — the three examples while none are saved. */
export const codiRoutines = () => invoke<CodiRoutine[]>("codi_routines");
export const codiSetRoutines = (routines: CodiRoutine[]) => invoke<void>("codi_set_routines", { routines });
/** Runs a routine by name (or id); `input` fills its one slot. Answers what it says at the end. */
export const codiRunRoutine = (name: string, input: string | null = null) => invoke<string>("codi_run_routine", { name, input });

/** What reading other apps needs from the system — macOS asks; Windows grants it all. */
export interface DesktopPermissions {
  accessibility: boolean;
  screen: boolean;
  supported: boolean;
}
export const desktopPermissions = () => invoke<DesktopPermissions>("desktop_permissions");
/** The system's prompt and its settings pane, for `accessibility` or `screen`. */
export const desktopAskPermission = (kind: "accessibility" | "screen") => invoke<void>("desktop_ask_permission", { kind });

export const onCodiState = (f: (state: CodiState) => void): Promise<UnlistenFn> => listen<CodiState>("codi:state", (e) => f(e.payload));
/** The microphone's level, ~25 a second while it is open: what `setListenLevel` is fed. */
export const onCodiLevel = (f: (level: number) => void): Promise<UnlistenFn> => listen<number>("codi:level", (e) => f(e.payload));
export const onCodiHeard = (f: (heard: CodiHeard) => void): Promise<UnlistenFn> => listen<CodiHeard>("codi:heard", (e) => f(e.payload));
export const onCodiTurn = (f: (turn: CodiTurn) => void): Promise<UnlistenFn> => listen<CodiTurn>("codi:turn", (e) => f(e.payload));
export const onCodiConfirm = (f: (question: CodiConfirmation) => void): Promise<UnlistenFn> => listen<CodiConfirmation>("codi:confirm", (e) => f(e.payload));
export const onCodiAnnounce = (f: (said: { text: string; source: string }) => void): Promise<UnlistenFn> =>
  listen<{ text: string; source: string }>("codi:announce", (e) => f(e.payload));
export const onCodiPrepare = (f: (progress: CodiPrepare) => void): Promise<UnlistenFn> => listen<CodiPrepare>("codi:prepare", (e) => f(e.payload));
