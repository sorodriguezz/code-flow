import { lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  GitBranch,
  GitPullRequest,
  Link2Off,
  MessagesSquare,
  TerminalSquare,
  Workflow,
} from "lucide-react";
import { t, type MobileKey } from "./i18n";
import { connectEvents, onUnpaired, storedDeviceId, storedToken, type Frame } from "./transport";
import { useMobileStore, useRepoPath } from "./store";
import { announceInvalidation, type Invalidation } from "./invalidate";
import { toastInfo } from "./toast";
import { tapped } from "./haptics";
import { isSheet, useNav, type Route, type Tab } from "./nav";
import { ErrorBoundary } from "./ErrorBoundary";
import { Button } from "./ui/Button";
import { Spinner } from "./ui/Feedback";
import { Toaster } from "./ui/Toaster";
import { PairScreen } from "./screens/PairScreen";
import { RepoScreen } from "./screens/RepoScreen";
import { AgentsScreen } from "./screens/AgentsScreen";
import { PrScreen } from "./screens/PrScreen";
import { ChatScreen } from "./screens/ChatScreen";
import { DiffScreen } from "./screens/DiffScreen";
import { CommitScreen } from "./screens/CommitScreen";
import { BranchScreen } from "./screens/BranchScreen";
import { ChainScreen } from "./screens/ChainScreen";
import { ReviewScreen } from "./screens/ReviewScreen";
import { JobScreen } from "./screens/JobScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { ScopeSheet } from "./screens/ScopeSheet";
import { useSwipeBack } from "./ui/gestures";

/**
 * xterm and its fit addon are ~113 kB gzipped between them — half again the whole rest of this
 * client. Behind `lazy` so a session that never opens a shell never downloads one, which is most
 * sessions: the tab is only present when the desktop has granted terminal access at all.
 */
const TerminalScreen = lazy(() =>
  import("./screens/TerminalScreen").then((m) => ({ default: m.TerminalScreen })),
);

const TABS: { id: Tab; icon: typeof GitBranch; labelKey: MobileKey }[] = [
  { id: "repo", icon: GitBranch, labelKey: "nav.repo" },
  { id: "prs", icon: GitPullRequest, labelKey: "nav.prs" },
  { id: "chat", icon: MessagesSquare, labelKey: "nav.chat" },
  { id: "agents", icon: Workflow, labelKey: "nav.agents" },
  { id: "terminal", icon: TerminalSquare, labelKey: "nav.terminal" },
];

/**
 * The shell: pairing gate, the event wiring, five tabs, and a navigation stack over each of them.
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
 *
 * # The layers, and why they stop short of the tab bar
 *
 * Everything deeper than a tab root is drawn by `NavLayers` as an absolutely-positioned layer over
 * the *content area only*. That boundary is the fix for the complaint this rewrite started from: a
 * diff used to be a `fixed inset-0` overlay covering the tab bar, so a user who did not spot one
 * 18-pixel chevron had no way out of it at all. Now the tabs are always there, always work, and
 * always pop back to their own root.
 */
export function App() {
  const [paired, setPaired] = useState(() => storedToken() !== null);
  const tab = useNav((s) => s.tab);
  const select = useNav((s) => s.select);
  const ready = useMobileStore((s) => s.ready);
  const unpaired = useMobileStore((s) => s.unpaired);
  const terminalAllowed = useMobileStore((s) => s.terminalAllowed);
  /** How much is stacked over the tab body. Read here only to mark it inert — see below. */
  const depth = useNav((s) => s.stack.length);
  /** Whether the Shell tab has ever been opened. See the note where it is rendered — it decides
   *  whether the terminal is in the tree at all, and once true it stays true. */
  const [terminalVisited, setTerminalVisited] = useState(false);

  useEffect(() => {
    if (tab === "terminal") setTerminalVisited(true);
  }, [tab]);

  // The grant being withdrawn while the Shell tab is open. The tab itself disappears from the bar
  // below, so leaving `tab` pointing at it would show an empty pane with no way back — and moving
  // somebody to another tab without a word reads as the app losing its place, so it says why.
  useEffect(() => {
    if (!terminalAllowed && tab === "terminal") {
      select("agents");
      toastInfo(t("terminal.revoked"));
    }
  }, [terminalAllowed, tab, select]);

  useEffect(() => {
    if (paired) void useMobileStore.getState().bootstrap();
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
          // …and the open chain's own steps, which the store no longer owns. See `invalidate.ts`.
          announceInvalidation({ domain: "chains" });
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
          if (payload.repo_path === current) {
            void state.refreshRepo();
            // An open diff is a read of one file in that tree, and it went stale with the rest.
            announceInvalidation({ domain: "repo" });
          }
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
          // Screens that own their own data are told directly. `tasks` is deliberately absent —
          // there is no task screen on this client, so there is nothing for it to make stale.
          if (
            payload.domain === "reviews" ||
            payload.domain === "chat" ||
            payload.domain === "chains" ||
            payload.domain === "repo"
          ) {
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
          announceInvalidation({ domain: "repo" });
          break;
        // The server sends this when this socket fell far enough behind to lose frames — a locked
        // screen through a long run. Everything on screen is suspect, so everything is re-read, and
        // the user is told: a screen that silently rewrites itself is how somebody ends up acting on
        // what they thought they had read.
        case "state:resync":
          toastInfo(t("status.resync"));
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
  if (unpaired) {
    return (
      <div className="cf-brand-wash flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-[var(--cf-border)] bg-[var(--cf-surface)]">
          <Link2Off size={24} className="text-[var(--cf-text-muted)]" aria-hidden />
        </div>
        <p className="text-md font-medium">{t("status.unpaired")}</p>
        <p className="max-w-[19rem] text-base text-[var(--cf-text-muted)]">
          {t("status.unpairedHint")}
        </p>
        <Button variant="primary" size="lg" onClick={() => setPaired(false)}>
          {t("pair.submit")}
        </Button>
      </div>
    );
  }

  const tabs = TABS.filter((entry) => entry.id !== "terminal" || terminalAllowed);
  // Kept mounted from the first visit, and dropped only when the grant is withdrawn — at which point
  // the desktop has already killed the sessions, so there is nothing left for the screen to hold.
  const terminalMounted = terminalVisited && terminalAllowed;

  return (
    <div className="flex h-full flex-col bg-[var(--cf-bg)]">
      <ConnectionBar />

      {/* `relative`, and this is load-bearing: it is what every navigation layer and every sheet is
          positioned against. They used to be `fixed inset-0`, which resolves against the *layout*
          viewport and therefore opted straight out of the `--cf-vh` / `--cf-vt` correction the whole
          client is built on — so with the keyboard up a sheet's back button was pushed off the top
          of the screen. Inside this box they inherit the correction for free. */}
      <main className="relative min-h-0 flex-1 overflow-hidden">
        {!ready ? (
          <div className="flex h-full items-center justify-center">
            <Spinner size={20} />
          </div>
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
              <div
                className={tab === "terminal" ? "absolute inset-0 flex flex-col" : "hidden"}
                // Same reason as the tab body below: a pushed screen must not be swipe-through-able
                // into the pane underneath it. Settings is reachable from this tab's own bar, so
                // this pane does get covered.
                inert={depth > 0 ? true : undefined}
                aria-hidden={depth > 0 || undefined}
              >
                {/* Its own boundary: this is the one lazily-loaded screen, so it is the one that
                    throws when a chunk has gone missing under a stale page. */}
                <ErrorBoundary compact>
                  <Suspense
                    fallback={
                      <div className="flex flex-1 items-center justify-center">
                        <Spinner />
                      </div>
                    }
                  >
                    <TerminalScreen />
                  </Suspense>
                </ErrorBoundary>
              </div>
            )}
            {tab !== "terminal" && (
              // Keyed on the tab so React tears the previous root down rather than trying to
              // reconcile a Repo screen into a Chat one, and so each tab's own mount effects run
              // exactly once per visit.
              <ErrorBoundary key={tab} compact>
                {/* `inert` while a screen is pushed over this one. Without it a VoiceOver or
                    TalkBack user swiping through the diff reaches its end and carries straight on
                    into the file list underneath — controls that are covered, that they cannot see,
                    and that act on the screen they thought they had left. `aria-hidden` is the
                    fallback for Safari before 16.4, where `inert` does nothing. */}
                <div
                  className="absolute inset-0 flex flex-col"
                  inert={depth > 0 ? true : undefined}
                  aria-hidden={depth > 0 || undefined}
                >
                  {tab === "repo" ? (
                    <RepoScreen />
                  ) : tab === "prs" ? (
                    <PrScreen />
                  ) : tab === "chat" ? (
                    <ChatScreen />
                  ) : (
                    <AgentsScreen />
                  )}
                </div>
              </ErrorBoundary>
            )}

            <NavLayers />
          </>
        )}

        <Toaster />
      </main>

      <nav
        aria-label={t("nav.tabs")}
        className="cf-safe-bottom cf-safe-x shrink-0 border-t border-[var(--cf-border)] bg-[var(--cf-surface)]"
      >
        <div className="flex" role="tablist">
          {tabs.map((entry) => (
            <TabButton key={entry.id} id={entry.id} icon={entry.icon} labelKey={entry.labelKey} />
          ))}
        </div>
      </nav>
    </div>
  );
}

/**
 * One tab.
 *
 * `role="tab"` with `aria-selected` rather than a bare button: the bar switches what fills the pane
 * below it, which is what tabs mean, and without it a screen reader announced five identical
 * unlabelled buttons with no indication of which one was current.
 */
function TabButton({
  id,
  icon: Icon,
  labelKey,
}: {
  id: Tab;
  icon: typeof GitBranch;
  labelKey: MobileKey;
}) {
  const active = useNav((s) => s.tab === id);
  const select = useNav((s) => s.select);
  // The count of chains asking for something, on the tab that holds them. This is the number the
  // app exists to surface, so it is visible from every screen.
  const waiting = useMobileStore((s) =>
    id === "agents" ? s.chains.filter((c) => c.status === "gated").length : 0,
  );
  const label = t(labelKey);

  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      // The badge is a number with no meaning of its own next to a one-word label. Spelling it into
      // the accessible name is the difference between "Agentes, 2" and "two chains are waiting for
      // an answer".
      aria-label={waiting > 0 ? `${label} — ${t("nav.gatesWaiting", { n: waiting })}` : undefined}
      onClick={() => {
        tapped();
        select(id);
      }}
      className={`cf-tap relative flex flex-1 flex-col items-center justify-center gap-0.5 pb-1 pt-1.5 text-2xs transition-colors ${
        active ? "text-[var(--cf-accent)]" : "text-[var(--cf-text-muted)]"
      }`}
    >
      {/* The selected indicator is a bar at the top of the tab, not only a colour — colour alone is
          the one distinction a red-green colour-blind user cannot make, and the accent against grey
          at this size is a weak signal for everybody else too. */}
      <span
        aria-hidden
        className={`absolute inset-x-5 top-0 h-0.5 rounded-full bg-[var(--cf-accent)] transition-opacity duration-200 ${
          active ? "opacity-100" : "opacity-0"
        }`}
      />
      <span className="relative">
        <Icon size={19} aria-hidden />
        {waiting > 0 && (
          <span
            aria-hidden
            className="absolute -right-2.5 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--cf-accent-strong)] px-1 text-2xs font-bold text-[var(--cf-accent-contrast)]"
          >
            {waiting}
          </span>
        )}
      </span>
      {label}
    </button>
  );
}

/**
 * The strip above everything, and the safe area under the notch.
 *
 * It is always in the tree — collapsed to nothing but its own top inset when there is nothing to
 * say — for two reasons. It is what pads the app out from under the status bar, so its height must
 * not depend on whether the connection is up; and it sits *outside* the layer host, which is what
 * makes it the one thing a full-screen diff cannot cover. The old version of this lived in a header
 * the sheets painted over, so a phone that dropped off wifi while somebody was reading a diff said
 * nothing at all.
 */
function ConnectionBar() {
  const connected = useMobileStore((s) => s.connected);
  return (
    <div className="cf-safe-top cf-safe-x shrink-0 bg-[var(--cf-surface)]">
      {/* The live region is always mounted so an announcement fires the moment the sentence appears;
          the sentence itself is only in the tree while it is true. Collapsing a filled element to
          `h-0` hides it from the eye and not from a screen reader, which then read "Reconectando…"
          on every screen, permanently, while the connection was fine. */}
      <div
        role="status"
        aria-live="polite"
        className={`overflow-hidden transition-all duration-300 ${connected ? "h-0" : "h-6"}`}
      >
        {!connected && (
          <p className="flex items-center justify-center gap-1.5 bg-[var(--cf-warning-soft)] py-1 text-2xs font-medium text-[var(--cf-warning-text)]">
            <span className="cf-pulse h-1.5 w-1.5 rounded-full bg-current" aria-hidden />
            {t("status.reconnecting")}
          </p>
        )}
      </div>
    </div>
  );
}

/** One pushed route, resolved to the screen that draws it. */
function RouteView({ route }: { route: Route }) {
  switch (route.k) {
    case "diff":
      return <DiffScreen repoPath={route.repoPath} path={route.path} staged={route.staged} />;
    case "commit":
      return <CommitScreen repoPath={route.repoPath} commit={route.commit} />;
    case "branches":
      return <BranchScreen repoPath={route.repoPath} />;
    case "chain":
      return <ChainScreen chainId={route.chainId} title={route.title} />;
    case "review":
      return (
        <ReviewScreen
          id={route.runId}
          prId={route.prId}
          iter={route.iter}
          projectId={route.projectId}
        />
      );
    case "job":
      return <JobScreen id={route.id} label={route.label} />;
    case "settings":
      return <SettingsScreen />;
    case "scope":
      return <ScopeSheet />;
  }
}

/**
 * The pushed screens, drawn over the tab's own content and under the tab bar.
 *
 * # Why a leaving copy is kept for a quarter of a second
 *
 * React removes a component the instant its route leaves the stack, which would make every "back"
 * a hard cut. The route that just left is held in `leaving` for the length of the exit animation
 * so it can slide off; nothing else references it, and it is dropped by a timer that is cleaned up
 * if another navigation happens first.
 *
 * The one case that must *not* animate is a back that came from the edge-swipe gesture: the gesture
 * has already dragged the layer off the right of the screen itself, so replaying the exit would
 * snap it back to the middle and slide it out a second time. `suppress` is set by the gesture's
 * callback and consumed by the effect below.
 */
function NavLayers() {
  const stack = useNav((s) => s.stack);
  const back = useNav((s) => s.back);
  /**
   * The layers actually in the DOM, which lags the store by one exit animation.
   *
   * A popped route has to stay mounted while it slides off, and it has to stay mounted *as the same
   * component* — rendering a copy of it in a separate "leaving" slot was the first attempt, and it
   * remounts the screen, which fires its fetch again. Closing a diff should not cost a second
   * `get_file_diff` for a screen the user is watching leave.
   */
  const [layers, setLayers] = useState<Layer[]>(() => layersOf(stack));
  /** Set by the edge-swipe gesture, which has already animated the layer off the screen itself —
   *  replaying the exit would snap it back to the middle and slide it out a second time. */
  const suppress = useRef(false);
  const top = stack.length > 0 ? stack[stack.length - 1] : null;
  const repoPath = useRepoPath();
  const projectId = useMobileStore((s) => s.projectId);
  const workspaceId = useMobileStore((s) => s.workspaceId);

  // Escape, for the iPad-with-a-keyboard case. The sheet has had one since it was written; a pushed
  // screen is the same kind of thing and its absence is the sort of gap that makes an app feel like
  // a website in a frame.
  useEffect(() => {
    if (stack.length === 0) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") back();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stack.length, back]);

  /**
   * A screen whose scope moved out from under it.
   *
   * `setWorkspace` and `setProject` already unwind the stack, and this is belt and braces on
   * purpose: `resetDepth` is refused while a `history.go()` is still in flight, and a resync can
   * move the project without anybody tapping anything. Every scope-bound route carries the scope it
   * was opened under precisely so this comparison is possible — the alternative is a screen that
   * goes on being *correct about the wrong repository*, which is worse than being wrong, because
   * nothing on it says so.
   *
   * The `!== null` guards skip the moment mid-switch when the store has cleared the selection and
   * the new one has not landed.
   */
  useEffect(() => {
    if (!top) return;
    const stale =
      ("repoPath" in top && repoPath !== null && top.repoPath !== repoPath) ||
      ("projectId" in top && projectId !== null && top.projectId !== projectId) ||
      ("workspaceId" in top && workspaceId !== null && top.workspaceId !== workspaceId);
    if (!stale) return;
    toastInfo(t("scope.movedAway"));
    useNav.getState().popToRoot();
  }, [top, repoPath, projectId, workspaceId]);

  useEffect(() => {
    const desired = layersOf(stack);
    let popped = false;
    setLayers((current) => {
      const live = current.filter((layer) => !layer.exiting);
      if (desired.length >= live.length) return desired;
      if (suppress.current) {
        suppress.current = false;
        return desired;
      }
      popped = true;
      return [...desired, ...live.slice(desired.length).map((layer) => ({ ...layer, exiting: true }))];
    });
    if (!popped) return;
    const id = window.setTimeout(
      () => setLayers((current) => current.filter((layer) => !layer.exiting)),
      260,
    );
    return () => window.clearTimeout(id);
  }, [stack]);

  const sheet = stack.length > 0 && isSheet(stack[stack.length - 1]) ? stack[stack.length - 1] : null;
  const topIndex = layers.findIndex((layer) => layer.exiting) - 1;
  const lastLive = topIndex >= 0 ? topIndex : layers.filter((l) => !l.exiting).length - 1;

  return (
    <>
      {layers.map((layer, index) => (
        <NavLayer
          key={layer.key}
          layer={layer}
          index={index}
          // Only the layer on top is draggable, and only when no sheet is over it.
          draggable={index === lastLive && !sheet}
          onSwipeBack={() => {
            suppress.current = true;
            back();
          }}
        />
      ))}

      {sheet && (
        <ErrorBoundary compact>
          <RouteView route={sheet} />
        </ErrorBoundary>
      )}
    </>
  );
}

interface Layer {
  route: Route;
  key: string;
  /** On its way out. Kept in the tree for the length of the animation and then dropped. */
  exiting?: boolean;
}

function layersOf(stack: Route[]): Layer[] {
  return stack
    .filter((route) => !isSheet(route))
    .map((route, index) => ({ route, key: `${index}-${route.k}` }));
}

/**
 * One layer, with its own swipe gesture.
 *
 * A component per layer rather than one hook in the parent, because `useSwipeBack` installs its
 * listeners on whatever `ref.current` is when its effect runs — and a ref object's identity never
 * changes, so a hook in the parent would keep the listeners on the *first* layer's node forever and
 * the gesture would silently stop working the moment a second screen was pushed.
 *
 * `cf-push-in` is unconditional and not "only when this is the newest". A CSS animation runs when
 * the element is inserted; adding the class back later restarts it, which is what a conditional
 * would do to the layer underneath the moment the one above it was popped — sliding a screen the
 * user is returning *to* in from the right, as though it were new.
 */
function NavLayer({
  layer,
  index,
  draggable,
  onSwipeBack,
}: {
  layer: Layer;
  index: number;
  draggable: boolean;
  onSwipeBack: () => void;
}) {
  const node = useRef<HTMLDivElement>(null);
  useSwipeBack(node, onSwipeBack, draggable);

  return (
    <div
      ref={node}
      aria-hidden={layer.exiting || undefined}
      className={`absolute inset-0 flex flex-col bg-[var(--cf-bg)] shadow-[-10px_0_30px_rgba(0,0,0,0.12)] ${
        layer.exiting ? "cf-push-out" : "cf-push-in"
      }`}
      style={{ zIndex: 30 + index }}
    >
      <ErrorBoundary compact>
        <RouteView route={layer.route} />
      </ErrorBoundary>
    </div>
  );
}

