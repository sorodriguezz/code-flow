import { lspNotify, lspProbe, lspRequest, lspStart, lspStopProject } from "../tauri/commands";
import { LANGUAGE_SERVERS, serversForRepo, spawnFor, type LanguageServer } from "./servers";
import { fileUriFor } from "./protocol";

/**
 * Which language servers are running, and what they have been told.
 *
 * Module state rather than a store, for the same reason `tsOpenFiles` is: the other reader is not a
 * component. The Monaco providers in `useLanguageServer` are registered globally and the text-search
 * fallback in `lib/goToDefinition` is registered once at startup, and both have to ask "can a real
 * compiler answer for this file?" from outside React.
 *
 * **One project at a time.** The editor shows one repository, and a server is rooted at one. Opening
 * a second project stops the first one's servers rather than keeping both warm: a warm
 * `rust-analyzer` is several hundred megabytes, and the ones the user is not looking at are not
 * worth that.
 */

interface Session {
  id: string;
  server: LanguageServer;
  capabilities: Record<string, unknown>;
}

let context: { projectId: string; repoPath: string } | null = null;
const sessions = new Map<string, Session>();

/**
 * Every file a server has been told about, and which revision it last heard.
 *
 * Keyed by repo-relative path, one counter shared by every session holding that file: LSP only
 * requires the version to increase, so two servers reading the same document from the same counter
 * is both simpler and correct.
 */
const documents = new Map<string, { language: string; version: number }>();

interface Probe {
  /** How to launch it, or `null` when it is not installed. */
  launch: { command: string; args: string[] } | null;
  /** What the binary printed, for the badge in Settings. */
  version: string | null;
}

/**
 * One probe per server — memoised as the **promise**, not its result.
 *
 * Caching the result meant a read at the top and a write at the bottom with two awaited
 * subprocesses in between, so two callers arriving together both missed the cache and both probed.
 * A promise is placed in the map before the first await, which is what makes the second caller
 * wait for the first instead of repeating it.
 */
const probed = new Map<string, Promise<Probe>>();

/**
 * Sessions being started right now.
 *
 * Same shape of race, worse consequence. `sessions.has` was checked before `resolve()` and
 * `lspStart()` and written after both, so two editor groups mounting together each spawned a
 * server. `lsp::start` opens by stopping whatever holds that id — but it registers the session
 * *after* `initialize` returns, so the second caller finds nothing to stop, spawns its own, and its
 * registry insert drops the first `Arc<Session>` on the floor. `proc::command` sets no
 * `kill_on_drop`, so that first server is then unreachable and unkillable for the life of the app.
 */
const starting = new Map<string, Promise<void>>();

/**
 * Notified whenever the set of running sessions changes.
 *
 * Exists because starting a server is asynchronous and attaching a document is not. The editor's
 * sweep over `monaco.editor.getModels()` runs in the same React commit as the effect that kicks off
 * `startForProject`, so at sweep time no session exists yet and every model is skipped — which made
 * the one file open when a project opens the one file no server was ever told about. Models opened
 * later were fine, since `onDidCreateModel` fires long after. This is the signal to sweep again.
 */
const listeners = new Set<() => void>();

export function onSessionsChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Copied before iterating: a listener that unsubscribes itself must not mutate the set mid-loop. */
function announce(): void {
  for (const listener of [...listeners]) listener();
}

export function currentRepoPath(): string | null {
  return context?.repoPath ?? null;
}

export function currentProjectId(): string | null {
  return context?.projectId ?? null;
}

/** The running sessions whose server claims this Monaco language. Empty is the normal answer for
 *  most languages, and every provider treats it as "say nothing". */
export function sessionsForLanguage(language: string): Session[] {
  return [...sessions.values()].filter((session) => session.server.languages.includes(language));
}

/** Whether any server is holding this file and can be asked about it — the guard every provider
 *  opens with, and what `goToDefinition` checks before falling back to its own ranked guess. */
export function lspKnows(relPath: string): boolean {
  const entry = documents.get(relPath);
  return entry !== undefined && sessionsForLanguage(entry.language).length > 0;
}

/**
 * Whether a running server holding this file can actually answer *where a symbol is defined*.
 *
 * Not the same question as [`lspKnows`], and conflating them broke go-to-definition rather than
 * improving it. Ruff claims `python` and Tailwind claims `css`, `html` and `typescript`; neither
 * implements `textDocument/definition`. So in a Python repo with `ruff` installed and `pyright` not,
 * `lspKnows` was true, the ranked text search in `goToDefinition` stood aside for a compiler, the
 * compiler had nothing to say, and F12 silently did nothing where it used to jump.
 *
 * The server's own `initialize` answer settles it — which is what `capabilities` was being stored
 * for and, until now, never read.
 */
export function lspCanDefine(relPath: string): boolean {
  const entry = documents.get(relPath);
  if (!entry) return false;
  return sessionsForLanguage(entry.language).some((session) =>
    Boolean(session.capabilities?.definitionProvider),
  );
}

/**
 * How a server is actually launched, or `null` if it is not installed.
 *
 * The binary on `PATH` first. Failing that, and only for the npm-published ones, `npx --no` — which
 * runs a package that is *already* present (in the project's `node_modules/.bin`, or installed
 * globally) and refuses rather than fetching one that is not. That refusal is deliberate: a project
 * opening should never quietly download a package and spend the user's disk on it. Installing is
 * what the `install` string in the catalogue is for, and what the badge in Settings offers.
 */
function probe(server: LanguageServer): Promise<Probe> {
  const inflight = probed.get(server.id);
  if (inflight) return inflight;
  const attempt = (async (): Promise<Probe> => {
    const direct = await lspProbe(server.command, server.versionArgs).catch(() => null);
    if (direct !== null) return { launch: spawnFor(server, true), version: direct };
    if (server.npm) {
      const viaNpx = await lspProbe("npx", [
        "--no",
        "--package",
        server.npm,
        server.command,
        ...server.versionArgs,
      ]).catch(() => null);
      if (viaNpx !== null) {
        const { args } = spawnFor(server, false);
        // `--yes` in `spawnFor` would authorise a fetch; this path has already established the
        // package is present, and keeps refusing to fetch one that is not.
        return {
          launch: { command: "npx", args: args.map((arg) => (arg === "--yes" ? "--no" : arg)) },
          version: viaNpx,
        };
      }
    }
    return { launch: null, version: null };
  })();
  probed.set(server.id, attempt);
  return attempt;
}

/**
 * Forgets every probe.
 *
 * The cache has no expiry, which is right for a project switch and wrong for the one flow the
 * Settings panel exists to start: the user reads "not found", copies the install command, runs it,
 * and comes back to a panel still reporting what was true a minute ago. This is what its Refresh
 * button calls.
 */
export function refreshProbes(): void {
  probed.clear();
}

/**
 * Starts every server that has something to say about this repository.
 *
 * Failures are swallowed on purpose, one server at a time. A missing `gopls` is not an error the
 * user made — it is a feature that is not installed — and a repo with a stray `go.mod` must not
 * greet the user with a dialog about it. What a missing server produces is the same thing as before
 * this existed: no completions for Go.
 */
export async function startForProject(projectId: string, repoPath: string, rootEntries: string[]): Promise<void> {
  if (context && context.projectId !== projectId) await stopAll();
  context = { projectId, repoPath };

  await Promise.all(
    serversForRepo(rootEntries).map((server) => {
      const id = `${projectId}:${server.id}`;
      if (sessions.has(id)) return undefined;
      const inflight = starting.get(id);
      if (inflight) return inflight;
      const attempt = (async () => {
        const { launch } = await probe(server);
        if (!launch) return;
        // The outcome is carried rather than collapsed into `null`: `lsp_start` answers `null`
        // for a server that declares no capabilities, which is unusual but legal, and reading
        // that as "it failed to start" would leave a live process outside the registry.
        const started = await lspStart(
          id,
          repoPath,
          launch.command,
          launch.args,
          server.initializationOptions,
          server.settings,
        ).then(
          (capabilities) => ({ ok: true as const, capabilities }),
          () => ({ ok: false as const, capabilities: null }),
        );
        if (!started.ok) return;
        // The project this attempt belongs to may have closed while `initialize` was in flight;
        // registering now would resurrect it under a stale id. `stopAll` has already asked the
        // backend to stop everything under that prefix, so the process is on its way out.
        if (context?.projectId !== projectId) return;
        sessions.set(id, { id, server, capabilities: started.capabilities ?? {} });
      })().finally(() => {
        starting.delete(id);
      });
      starting.set(id, attempt);
      return attempt;
    }),
  );
  announce();
}

export async function stopAll(): Promise<void> {
  const projectId = context?.projectId;
  // Clearing a map of promises cancels nothing. Each attempt parked in `lspStart` still holds the
  // old project's id and root in closure, and still runs its `sessions.set` afterwards — so a
  // project switch during a slow start (rust-analyzer, or any first open where the probes are still
  // running) put a session keyed to the *old* repo back into the map, and sent the new project's
  // URIs to a server rooted at the old one. Worse on the backend: `lsp::start` registers only after
  // `initialize` returns, so the `lsp_stop_project` below finds nothing and the process lands in the
  // registry *after* the stop, resident for the life of the app.
  const inflight = [...starting.values()];
  starting.clear();
  // Repointed first, so a late arrival can see that its project is gone — see the guard in
  // `startForProject`.
  context = null;
  await Promise.allSettled(inflight);
  sessions.clear();
  documents.clear();
  announce();
  if (projectId) await lspStopProject(projectId).catch(() => {});
}

/** A session that has died — its process ended, so whatever was registered against it now answers
 *  nothing. Dropped rather than restarted: a server that crashed on this project's code will crash
 *  again, and a restart loop is worse than no completions. */
export function forgetSession(sessionId: string): void {
  if (sessions.delete(sessionId)) announce();
}

// ---------------------------------------------------------------------------
// Document sync
// ---------------------------------------------------------------------------
//
// The buffer is what gets sent, never the path. A server pointed at a file reads what is on disk,
// and what the user is looking at is what they have typed — so completions would describe the file
// as it was last saved. Every edit is a full-text `didChange`: LSP takes incremental ranges, and
// computing them from Monaco's change events is real work whose only payoff is on files far larger
// than a source file gets.

export function syncOpen(relPath: string, language: string, text: string): void {
  if (!context || documents.has(relPath)) return;
  const targets = sessionsForLanguage(language);
  if (targets.length === 0) return;
  documents.set(relPath, { language, version: 1 });
  const uri = fileUriFor(context.repoPath, relPath);
  for (const session of targets) {
    void lspNotify(session.id, "textDocument/didOpen", {
      textDocument: { uri, languageId: language, version: 1, text },
    }).catch(() => {});
  }
}

export function syncChange(relPath: string, text: string): void {
  const entry = documents.get(relPath);
  if (!context || !entry) return;
  entry.version += 1;
  const uri = fileUriFor(context.repoPath, relPath);
  for (const session of sessionsForLanguage(entry.language)) {
    void lspNotify(session.id, "textDocument/didChange", {
      textDocument: { uri, version: entry.version },
      // No `range`: full-text sync, which is what `client_capabilities` asks for.
      contentChanges: [{ text }],
    }).catch(() => {});
  }
}

export function syncSave(relPath: string, text: string): void {
  const entry = documents.get(relPath);
  if (!context || !entry) return;
  const uri = fileUriFor(context.repoPath, relPath);
  for (const session of sessionsForLanguage(entry.language)) {
    void lspNotify(session.id, "textDocument/didSave", { textDocument: { uri }, text }).catch(() => {});
  }
}

export function syncClose(relPath: string): void {
  const entry = documents.get(relPath);
  if (!context || !entry) return;
  documents.delete(relPath);
  const uri = fileUriFor(context.repoPath, relPath);
  for (const session of sessionsForLanguage(entry.language)) {
    void lspNotify(session.id, "textDocument/didClose", { textDocument: { uri } }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/**
 * Asks every server that claims this file's language, and hands back whatever answered.
 *
 * Plural because more than one is the normal case: Python is Pyright for types *and* Ruff for lint,
 * and the interesting answer may come from either. A server that rejects or times out contributes
 * nothing rather than failing the call — one slow server must not take the completion list with it.
 */
export async function askAll<T>(language: string, method: string, params: unknown): Promise<T[]> {
  const targets = sessionsForLanguage(language);
  // Annotated rather than inferred: `Promise.all` widens through `Awaited<T>`, which for an
  // unconstrained `T` is not the same type as `T` and makes the filter's predicate unprovable.
  const answers: (T | null)[] = await Promise.all(
    targets.map((session) => lspRequest<T>(session.id, method, params).catch(() => null)),
  );
  return answers.filter((answer): answer is T => answer !== null && answer !== undefined);
}

/** The `file://` URI for a repo-relative path in the open project. */
export function uriFor(relPath: string): string | null {
  return context ? fileUriFor(context.repoPath, relPath) : null;
}

/**
 * The catalogue, paired with whether each entry was found on this machine — what the Settings badge
 * draws.
 *
 * Goes through `probe`, which is the whole point: this used to call `lspProbe` directly, so every
 * open of the panel spawned fourteen `--version` processes while the comment above it claimed the
 * answers were cached. Call `refreshProbes` first to deliberately ask again.
 */
export async function serverStatuses(): Promise<{ server: LanguageServer; version: string | null }[]> {
  return Promise.all(
    LANGUAGE_SERVERS.map(async (server) => ({ server, version: (await probe(server)).version })),
  );
}
