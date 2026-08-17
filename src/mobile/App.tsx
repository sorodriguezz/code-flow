import { lazy, Suspense, useEffect, useState } from "react";
import {
  GitBranch,
  GitPullRequest,
  Link2Off,
  Loader2,
  MessagesSquare,
  TerminalSquare,
  Workflow,
} from "lucide-react";
import { t, type MobileKey } from "./i18n";
import { connectEvents, onUnpaired, storedDeviceId, storedToken, type Frame } from "./transport";
import { useMobileStore } from "./store";
import { announceInvalidation, type Invalidation } from "./invalidate";
import { ErrorBoundary } from "./ErrorBoundary";
import { PairScreen } from "./screens/PairScreen";
import { RepoScreen } from "./screens/RepoScreen";
import { RunsScreen } from "./screens/RunsScreen";
import { ChainsScreen } from "./screens/ChainsScreen";
import { PrScreen } from "./screens/PrScreen";
import { ChatScreen } from "./screens/ChatScreen";

/**
 * xterm and its fit addon are ~113 kB gzipped between them — half again the whole rest of this
 * client. Behind `lazy` so a session that never opens a shell never downloads one, which is most
 * sessions: the tab is only present when the desktop has granted terminal access at all.
 */
const TerminalScreen = lazy(() =>
  import("./screens/TerminalScreen").then((m) => ({ default: m.TerminalScreen })),
);

type Tab = "repo" | "prs" | "chat" | "agents" | "terminal";

const TABS: { id: Tab; icon: typeof GitBranch; labelKey: MobileKey }[] = [
  { id: "repo", icon: GitBranch, labelKey: "nav.repo" },
  { id: "prs", icon: GitPullRequest, labelKey: "nav.prs" },
  { id: "chat", icon: MessagesSquare, labelKey: "nav.chat" },
  { id: "agents", icon: Workflow, labelKey: "nav.agents" },
  { id: "terminal", icon: TerminalSquare, labelKey: "nav.terminal" },
];

/**
 * The shell: pairing gate, the event wiring, and five tabs.
 *
 * # Where the live behaviour comes from
 *
 * Every frame this client acts on is one the desktop was already emitting for its own window. That
 * is the whole architecture in one sentence — the phone is not a second app being kept in step, it
 * is a second listener on the same process. `repo:fs-changed` for a commit somebody made at the
 * desk, `ai:output-batch` for a run, `state:invalidate` for a chain that moved. The desktop did not
 * have to learn that a phone might be watching, and the phone does not poll for any of it.
 *
 * # Why five tabs and not seven
 *
 * A bottom bar stops being tappable past five on a phone-width screen. Chains and live runs share
 * the "Agents" tab behind a segmented control because they are two views of one thing — a chain
 * *is* what most runs belong to — and the terminal tab is hidden entirely unless the desktop has
 * granted it, which keeps the common case at four.
 */
export function App() {
  const [tab, setTab] = useState<Tab>("agents");
  const [agentsView, setAgentsView] = useState<"chains" | "runs">("chains");
  const [paired, setPaired] = useState(() => storedToken() !== null);
  /** Whether the Shell tab has ever been opened. See the note where it is rendered — it decides
   *  whether the terminal is in the tree at all, and once true it stays true. */
  const [terminalVisited, setTerminalVisited] = useState(false);
  const store = useMobileStore();

  useEffect(() => {
    if (tab === "terminal") setTerminalVisited(true);
  }, [tab]);

  // The grant being withdrawn while the Shell tab is open. The tab itself disappears from the bar
  // below, so leaving `tab` pointing at it would show an empty pane with no way back.
  useEffect(() => {
    if (!store.terminalAllowed && tab === "terminal") setTab("agents");
  }, [store.terminalAllowed, tab]);

  useEffect(() => {
    if (paired) void store.bootstrap();
    // Bootstrapping is a once-per-pairing concern; `store` changes on every state write and must
    // not re-trigger it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paired]);

  // The token can be dropped from inside any request, including ones whose callers ignore the
  // failure. Subscribing here is what turns that into the re-pair screen instead of a client that
  // quietly stops working — which is what it did before, because nothing was listening.
  useEffect(() => onUnpaired(() => useMobileStore.setState({ unpaired: true })), []);

  useEffect(() => {
    if (!paired) return;

    const onFrame = (frame: Frame) => {
      const state = useMobileStore.getState();
      switch (frame.event) {
        case "ai:output-batch": {
          const payload = frame.payload as {
            run_id: string;
            lines: { stream: string; line: string }[];
          };
          state.appendLog(
            payload.run_id,
            payload.lines.map((l) => l.line),
          );
          break;
        }
        case "ai:engine": {
          const payload = frame.payload as { run_id: string; engine: string; model: string };
          state.setEngine(
            payload.run_id,
            payload.model ? `${payload.engine} · ${payload.model}` : payload.engine,
          );
          break;
        }
        case "ai:done":
          state.markRunFinished((frame.payload as { run_id: string }).run_id);
          // A run that ended is a run whose effects have landed. Every chain step is an AI run, and
          // an agent turn typically rewrote the working tree — so without these two the Repo tab
          // kept showing the diff as it was before the agent started, and the chain kept showing
          // the step as running, for as long as nothing else happened to fire.
          void state.refreshRepo();
          void state.refreshChains();
          break;
        // Terminal bytes belong to a canvas, not to React state — routed straight to whoever has
        // xterm mounted. Going through the store would mean a re-render per chunk, which drops
        // frames on anything that prints fast.
        case "terminal:output": {
          const payload = frame.payload as { id: string; data: string };
          window.dispatchEvent(new CustomEvent("codeflow:terminal", { detail: payload }));
          break;
        }
        // The shell ended — typed `exit`, killed, or the process died on its own.
        //
        // **Its own event, not `codeflow:terminal` with a marker in it.** The output listener writes
        // `detail.data` into xterm unconditionally, so an exit routed through that channel would
        // write the string `undefined` into the terminal and then go on accepting keystrokes for a
        // session that no longer exists. The screen needs to do something different here, so it gets
        // told something different.
        case "terminal:exit": {
          const payload = frame.payload as { id: string };
          window.dispatchEvent(new CustomEvent("codeflow:terminal-exit", { detail: payload }));
          break;
        }
        case "repo:fs-changed": {
          // Filtered by path, where it used to refresh for any repository at all. The desktop
          // watches whatever project it has open as well as this one, and a `cargo build` in the
          // other one is thousands of files: unfiltered, every burst cost this client three git
          // calls over wifi to re-read a repository nothing had touched.
          const payload = frame.payload as { repo_path: string };
          const current = state.projects.find((p) => p.id === state.projectId)?.local_path;
          if (payload.repo_path === current) void state.refreshRepo();
          break;
        }
        case "state:invalidate": {
          const payload = frame.payload as Invalidation & {
            origin?: string;
            allowTerminal?: boolean;
          };
          // This device's own action, echoed back through the global emit that carries it to the
          // desktop. Refetching here would be the same read twice for every tap — which is exactly
          // what `store.run` documents itself as not doing.
          if (payload.origin && payload.origin === storedDeviceId()) break;
          if (payload.domain === "chains") void state.refreshChains();
          if (payload.domain === "repo") void state.refreshRepo();
          // Reviews and chat have no home in the store — they are screen-local, loaded by whichever
          // of the two is mounted. So they are routed the way terminal bytes are: as a DOM event
          // the screen subscribes to, which costs nothing when nobody is listening and avoids
          // giving the store two fields it would only ever hold to trigger a re-render with.
          //
          // `tasks` is deliberately absent — there is no task screen on this client, so there is
          // nothing for it to make stale.
          if (payload.domain === "reviews" || payload.domain === "chat") {
            announceInvalidation(payload);
          }
          // The shell grant, **pushed**. This is not a domain that went stale, it is a setting whose
          // new value is in the frame — which is the point: the phone learns this once at bootstrap
          // and has no way to notice it changing, and the obvious alternative (re-probe by calling a
          // terminal command) is the exact mistake that used to unpair every device at startup. See
          // `remotectl_set_allow_terminal`.
          //
          // `typeof` rather than a truthiness test, because `false` is the interesting value here and
          // is precisely what a loose check would drop.
          if (payload.domain === "remote" && typeof payload.allowTerminal === "boolean") {
            useMobileStore.setState({ terminalAllowed: payload.allowTerminal });
          }
          break;
        }
        case "git:done":
          void state.refreshRepo();
          break;
        // The server sends this when this socket fell far enough behind to lose frames — a locked
        // screen through a long run. Everything on screen is suspect, so everything is re-read.
        case "state:resync":
          void state.resync();
          break;
        // The desktop's keepalive. Nothing to do with it here: its only job is to be *received*,
        // which is what tells the transport layer the flow is still alive. See `transport.ts`.
        case "state:heartbeat":
          break;
      }
    };

    return connectEvents(
      onFrame,
      (connected) => useMobileStore.getState().setConnected(connected),
      // A reconnection is a gap, and a gap is exactly what `state:resync` describes — the desktop
      // emitted into a socket nobody was holding. The difference is that nothing tells us about
      // this one, so the reopen has to assume the worst on its own.
      () => void useMobileStore.getState().resync(),
    );
  }, [paired]);

  if (!paired) {
    return (
      <PairScreen
        onPaired={() => {
          // `unpaired` cleared here and not left to `bootstrap`, which only clears it on success.
          // Without this the screen below wins the very next render — so a user who has just
          // re-paired is told again that they are revoked while the bootstrap is still in flight —
          // and if that bootstrap fails for any *other* reason it sets `error` and leaves `unpaired`
          // true, with a valid token in hand and nothing on screen but the button back to this
          // form. That is a loop: pair, "revocado", pair.
          useMobileStore.setState({ unpaired: false });
          setPaired(true);
        }}
      />
    );
  }

  // A revoked device: the desktop no longer knows this token, and there is nothing to do but pair
  // again. Said plainly rather than shown as a wall of failing requests.
  if (store.unpaired) {
    return (
      <div className="flex min-h-full flex-col items-center justify-center gap-3 px-8 text-center">
        <Link2Off size={28} className="text-[var(--cf-text-muted)]" />
        <p className="text-[14px]">{t("status.unpaired")}</p>
        <button
          type="button"
          onClick={() => setPaired(false)}
          className="cf-tap rounded-lg bg-[var(--cf-accent)] px-5 text-[14px] font-medium text-white"
        >
          {t("pair.submit")}
        </button>
      </div>
    );
  }

  // The terminal tab is present only when the desktop granted it. `terminalAllowed` is *told*, not
  // discovered: it arrives in `remote_bootstrap` and is pushed again whenever the switch moves. The
  // client used to find it out by calling a terminal command and reading the refusal, which is what
  // made a default install unpair every phone at startup.
  const tabs = TABS.filter((entry) => entry.id !== "terminal" || store.terminalAllowed);
  // Kept mounted from the first visit, and dropped only when the grant is withdrawn — at which point
  // the desktop has already killed the sessions, so there is nothing left for the screen to hold.
  const terminalMounted = terminalVisited && store.terminalAllowed;

  return (
    <div className="flex h-full flex-col">
      {/* Workspace and project pickers, above everything: they scope every other tab, and on a
          phone a scope control that is not always visible is one people forget is set. */}
      <header className="cf-safe-top shrink-0 border-b border-[var(--cf-border)] bg-[var(--cf-surface)] px-3 pb-2 pt-2">
        <div className="flex gap-2">
          <select
            value={store.workspaceId ?? ""}
            onChange={(e) => void store.setWorkspace(e.target.value)}
            className="min-w-0 flex-1 rounded-lg border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-2 py-1.5 text-[13px]"
          >
            {store.workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name}
              </option>
            ))}
          </select>
          <select
            value={store.projectId ?? ""}
            onChange={(e) => void store.setProject(e.target.value)}
            className="min-w-0 flex-1 rounded-lg border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-2 py-1.5 text-[13px]"
          >
            {store.projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </div>
        {/* One line, only when something is wrong. A permanently visible connection indicator is
            noise; its absence is the signal. */}
        {!store.connected && (
          <p className="mt-1 text-[11px] text-[var(--cf-warning)]">{t("status.reconnecting")}</p>
        )}
        {store.error && <p className="mt-1 text-[11px] text-[var(--cf-danger)]">{store.error}</p>}
      </header>

      <main className="flex min-h-0 flex-1 flex-col">
        {!store.ready ? (
          <p className="p-6 text-center text-[13px] text-[var(--cf-text-muted)]">{t("common.loading")}</p>
        ) : (
          <>
            {/* The Shell tab is **hidden when you leave it, never unmounted** — the same rule
                `TerminalPane.tsx` documents for the desktop dock, and it is here for the same two
                reasons. Unmounting ran the screen's effect cleanup, and that cleanup used to call
                `close_terminal`: tapping "Repo" to check a diff killed the build you had opened the
                terminal to watch. It also threw away xterm's scrollback, so even a terminal that
                survived came back empty. An effect cleanup must never be what ends a user's process.

                Only this tab gets the treatment, deliberately. Keeping all five mounted would fire
                every screen's loads at startup — five round trips over somebody's wifi to draw one
                screen — and none of the other four owns anything that cannot be re-read. This one
                owns a process. */}
            {terminalMounted && (
              <div className={tab === "terminal" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
                {/* Its own boundary, inside the layout: this is the one lazily-loaded screen, so it
                    is the one that throws when a chunk has gone missing under a stale page. Catching
                    it here keeps the header and the tab bar mounted, so the failure costs one tab
                    rather than the whole client. */}
                <ErrorBoundary compact>
                  <Suspense
                    fallback={
                      <Loader2
                        size={16}
                        className="mx-auto mt-8 animate-spin text-[var(--cf-text-muted)]"
                      />
                    }
                  >
                    <TerminalScreen />
                  </Suspense>
                </ErrorBoundary>
              </div>
            )}
            {tab === "repo" ? (
              <RepoScreen />
            ) : tab === "prs" ? (
              <PrScreen />
            ) : tab === "chat" ? (
              <ChatScreen />
            ) : tab === "terminal" ? null : (
              <>
                <div className="flex shrink-0 gap-1 px-3 pt-2">
                  {(["chains", "runs"] as const).map((view) => (
                    <button
                      key={view}
                      type="button"
                      onClick={() => setAgentsView(view)}
                      className={`cf-tap flex-1 rounded-lg border text-[12px] ${
                        agentsView === view
                          ? "border-[var(--cf-accent)] text-[var(--cf-accent)]"
                          : "border-[var(--cf-border)] text-[var(--cf-text-muted)]"
                      }`}
                    >
                      {t(view === "chains" ? "agents.chains" : "agents.runs")}
                    </button>
                  ))}
                </div>
                {agentsView === "chains" ? <ChainsScreen /> : <RunsScreen />}
              </>
            )}
          </>
        )}
      </main>

      <nav className="cf-safe-bottom shrink-0 border-t border-[var(--cf-border)] bg-[var(--cf-surface)]">
        <div className="flex">
          {tabs.map((entry) => {
            const Icon = entry.icon;
            const active = tab === entry.id;
            // The count of chains asking for something, on the tab that holds them. This is the
            // number the app exists to surface, so it is visible from every screen.
            const waiting =
              entry.id === "agents" ? store.chains.filter((c) => c.status === "gated").length : 0;
            return (
              <button
                key={entry.id}
                type="button"
                onClick={() => setTab(entry.id)}
                className={`cf-tap relative flex flex-1 flex-col items-center justify-center gap-0.5 py-1.5 text-[10px] ${
                  active ? "text-[var(--cf-accent)]" : "text-[var(--cf-text-muted)]"
                }`}
              >
                <Icon size={18} />
                {t(entry.labelKey)}
                {waiting > 0 && (
                  <span className="absolute right-[18%] top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--cf-accent)] px-1 text-[9px] font-semibold text-white">
                    {waiting}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
