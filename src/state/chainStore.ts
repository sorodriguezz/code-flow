import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import {
  abortChain,
  approveChainGate,
  claimNextChainStep,
  completeChainStep,
  runChainStepCheck,
  createAgentChain,
  createContinuationChain,
  createStoryChain,
  deleteChain,
  deleteChainTemplate,
  getChainDetail,
  harvestChainStep,
  listAgentChains,
  listGatedChains,
  listChainTemplates,
  listWorkspaceChainSteps,
  notifyStateChange,
  resumeChain,
  rerunChainFrom,
  retryChainStep,
  setChainGroup,
  setChainPinned,
  setChainStepInput,
  setChainStepSkipped,
  skipChainStep,
  upsertChainTemplate,
} from "../lib/tauri/commands";
import { onTurnSettled } from "./agentEvents";
import { useAgentsStore } from "./agentsStore";
import { newRunId, useAiRunStore } from "./aiRunStore";
import { translate } from "./languageStore";
import { notify } from "./notificationStore";
import { pushErrorToast } from "./toastStore";
import { useWorkspaceStore } from "./workspaceStore";
import type {
  AgentChain,
  AgentChainStep,
  ChainDetail,
  ChainRepo,
  ChainStepBrief,
  GatedChain,
  ChainTemplate,
  NewChainStep,
  NewStoryWorkItem,
} from "../types/domain";

/** What `approve_chain_gate` answers when the step the caller named is not the one the chain is
 *  parked at. A wire constant — it must match `queries::GATE_MOVED`. */
const GATE_MOVED = "chain.gateMoved";

/** How often a step whose run outlived the webview is re-checked for its turn landing. */
const HARVEST_POLL_MS = 5_000;
/** After this long with no turn on disk, a recovered step is given up on and its run stopped. */
const STEP_TIMEOUT_MS = 45 * 60_000;

/**
 * The chain scheduler.
 *
 * It is deliberately thin. Every decision — is the repository still there, is the next step gated,
 * whose turn is it, is the plan finished — is made by `claim_next_chain_step` inside one
 * transaction on the backend; this store's whole job is to ask, carry out the answer, and report
 * back. That split is what makes the feature survive being killed: the driver is frontend code
 * that can die between any two lines, so nothing may exist in an engine that is not already
 * recorded on disk.
 *
 * It also never dispatches on its own initiative. A chain moves when the user starts it, when a
 * turn in its repository settles (which is the only moment a blocked chain can become unblocked),
 * or when the user approves a gate — and never while the window is hidden in the tray, because an
 * agent turn edits a real working copy and there would be no way to see it or stop it.
 */
interface ChainState {
  workspaceId: string | null;
  chains: AgentChain[];
  /** Reusable plans. Configuration, so they load with the workspace and never carry run state. */
  templates: ChainTemplate[];
  /** Steps of whichever chain is open, keyed by chain id. Only the open one is loaded. */
  stepsByChain: Record<string, AgentChainStep[]>;
  /** Every chain's steps, slim — what the task list needs to draw a chain as a group and to give
   * its icon a state. `stepsByChain` stays the full, single-chain load the detail pane reads. */
  briefsByChain: Record<string, ChainStepBrief[]>;
  /** The repository set of whichever chains have been opened. Loaded with the detail, like the
   * steps: the list draws a count, which rides on the chain row itself. */
  reposByChain: Record<string, ChainRepo[]>;
  selectedId: string | null;
  /** The template open in the middle column, if any. Mutually exclusive with a chain and a task. */
  selectedTemplateId: string | null;
  /** True while the window is hidden to the tray — nothing dispatches then. */
  background: boolean;
  /**
   * Every plan parked on a human decision, **across every workspace**.
   *
   * The one thing in this store that is not scoped to `workspaceId`, and the exception is the
   * point. Everything else here feeds the Agents view, which shows one workspace; this feeds the
   * status bar, which is the app's single answer to "is anything waiting on me?" — and a gate is a
   * plan that has *stopped*. Scoped like the rest, a plan parked in workspace A vanished from that
   * bar the moment the user looked at B, and when it was the only row the indicator unmounted
   * altogether. Nothing else would have said so either: a gate deliberately files no notification,
   * because it is a state to be resolved rather than an event that happened.
   *
   * Read whole from the backend rather than filtered out of `chains`, since `chains` holds one
   * workspace by construction. Deliberately **not** cleared by `setWorkspace`.
   */
  gatedChains: GatedChain[];
  /** Re-reads the cross-workspace gate list. Cheap and idempotent; called wherever a chain's status
   *  can have changed, local or remote. */
  refreshGates: () => Promise<void>;

  setWorkspace: (id: string | null) => Promise<void>;
  select: (chainId: string | null) => Promise<void>;
  /** Opens a template in the middle column. Mirrors `select`, including which store clears which. */
  selectTemplate: (templateId: string | null) => void;
  refresh: (chainId: string) => Promise<void>;
  /** Re-reads the whole chain list and its step briefs for the workspace already loaded, keeping
   *  the selection. The list-level counterpart to `refresh`, which reloads a single chain.
   *
   *  Same reason as `agentsStore.reloadTasks`: `setWorkspace(currentId)` early-returns, and
   *  forcing it past that throws away `selectedId`, `stepsByChain` and every harvest timer with
   *  it. Used when the rows moved underneath a view nobody navigated — a gate approved from a
   *  phone (see `state:invalidate` in `App.tsx`). */
  reloadChains: () => Promise<void>;
  create: (input: {
    /** The whole repository set, first one first. */
    projectIds: string[];
    title: string;
    goal: string;
    steps: NewChainStep[];
    agentProjectId: string;
    start: boolean;
  }) => Promise<ChainDetail>;
  /** A story run: 2N steps built in Rust from the work item, parked before the first one that
   * writes anything. */
  createStory: (input: {
    projectIds: string[];
    title: string;
    notes: string;
    analystAgentId: string;
    implementerAgentId: string;
    agentProjectId: string;
    workItem: NewStoryWorkItem;
    start: boolean;
  }) => Promise<ChainDetail>;
  /**
   * Approves a story run's plan: which repositories go ahead, and with what written into each.
   *
   * The order is the whole of it. Dropping a repository takes its step out of `pending` *before*
   * the gate is approved, so `approve_chain_gate` — which acts on whatever is pending next — can
   * never clear a gate onto a step the user just said no to. With every repository dropped there is
   * nothing pending left and the chain lands on `done`, which is the honest outcome of "none of
   * these need to change".
   */
  approvePlan: (
    chainId: string,
    decisions: Array<{ stepId: string; include: boolean; input: string }>,
  ) => Promise<void>;
  /**
   * Advances a chain by at most one step. Safe to call repeatedly and concurrently.
   *
   * `remote: true` means a person asked for this from somewhere other than this window — a phone
   * approving a gate — and it is what lets the step run with the window hidden in the tray. See the
   * `background` guard inside.
   *
   * The chain does **not** have to belong to the loaded workspace. It is claimed and run by id, and
   * a chain from anywhere else is deliberately not filed into this window's lists — see
   * [`applyChain`] and `refresh`.
   */
  pump: (chainId: string, opts?: { remote?: boolean }) => Promise<void>;
  /**
   * Clears the gate the chain is parked at.
   *
   * `stepId` is the step whose gate the caller drew, checked by the backend against the step the
   * chain is actually waiting on. Pass it from anything showing a gate; omit it only when the caller
   * has just rewritten the step set itself and its copy of the statuses is deliberately behind
   * disk — see `approvePlan`.
   */
  approve: (chainId: string, input: string, stepId?: string) => Promise<void>;
  skip: (chainId: string) => Promise<void>;
  retry: (chainId: string) => Promise<void>;
  /** "Do that again, but…" — back to one step, carrying the user's own words, and moving. */
  rerunFrom: (chainId: string, stepIndex: number, note: string) => Promise<void>;
  resume: (chainId: string) => Promise<void>;
  abort: (chainId: string) => Promise<void>;
  remove: (chainId: string) => Promise<void>;
  /** Stops anything live and aborts every chain of a repository that is about to be deleted. */
  abortForProject: (projectId: string) => Promise<void>;
  /** Files the chain under an `AgentProject`, or unfiles it with `""` — a folder, not the
   * repository the steps run in. */
  setGroup: (chainId: string, agentProjectId: string) => Promise<void>;
  setPinned: (chainId: string, pinned: boolean) => Promise<void>;
  /** Drops a deleted folder's id off every chain that pointed at it. */
  forgetProject: (agentProjectId: string) => void;

  reloadTemplates: () => Promise<void>;
  /** Returns the saved template, or `null` when there is no workspace to save it into. Callers need
   * the id back: without it, a second save from the same dialog creates a second template rather
   * than overwriting the one it just made. */
  saveTemplate: (input: {
    id?: string;
    name: string;
    description: string;
    steps: NewChainStep[];
  }) => Promise<ChainTemplate | null>;
  removeTemplate: (id: string) => Promise<void>;
  /** Seeds a chain from a finished task: step 1 is that task, already done. */
  continueFrom: (input: {
    sourceTaskId: string;
    title: string;
    goal: string;
    steps: NewChainStep[];
    agentProjectId: string;
    start: boolean;
  }) => Promise<ChainDetail>;
}

/** One advance per chain at a time. A second `pump` while one is in flight would claim the same
 * step twice — the backend would refuse the second, but the wasted round trip is avoidable. */
const inFlight = new Set<string>();

/**
 * Chains a person is driving from somewhere other than this window.
 *
 * # Why the flag outlives the tap that set it
 *
 * `background` stops this window dispatching engines while it is hidden in the tray, and that guard
 * is right: an agent turn rewrites a real working copy, and starting one with nothing on screen
 * gives the user no way to watch it or stop it. A gate approved from a phone is the one case where
 * both halves of that reasoning are false — somebody *did* ask, and the phone is showing the run's
 * output with a stop button under it.
 *
 * But a plan is what was approved, not a step. Marking only the one `pump` the invalidation
 * triggered would run step 4 and then park again the moment it settled, because `settleStep`'s own
 * pump would find `background` still set — a ten-step chain approved from the sofa would advance
 * once and stop, which is the same "it says it happened and nothing happens" this whole batch is
 * about. So the chain stays marked until it stops moving on its own, and the next thing that parks
 * it (a gate, a failure, the end of the plan) clears it: a second approval re-marks it.
 */
const drivenRemotely = new Set<string>();
/**
 * Poll timers for steps adopted after a reload, keyed by step id.
 *
 * The chain id travels with the timer rather than being looked up in `stepsByChain`. That lookup is
 * what used to tie harvesting to the loaded workspace — `stepsByChain` holds one workspace, so
 * "which timers belong to this chain?" stopped being answerable the moment the user looked
 * elsewhere, and the blunt answer was to stop all of them on every switch. Two extra words per
 * entry buy the question an answer that does not depend on where anybody is standing.
 */
const harvesting = new Map<string, { timer: ReturnType<typeof setInterval>; chainId: string }>();

/**
 * Stops every timer one chain owns.
 *
 * Harvesting is pure recovery bookkeeping — it exists to collect the result of a run that outlived
 * a webview reload — and it only ever cleared itself from inside its own callback, when the run it
 * was watching finished. A step the user aborts or deletes never reaches that branch, so its timer
 * kept firing every four seconds for the rest of the session, holding its closure and spending an
 * IPC round trip and a database read each time on a chain that no longer exists. Nothing is lost by
 * stopping those: there is no result left to collect, and `adoptRunningSteps` re-adopts cleanly if
 * the chain is resumed, since its guard is `harvesting.has(step.id)`.
 *
 * **Aborting is the only reason to stop one from outside.** Changing workspace is not — see the note
 * in `setWorkspace` — and a timer whose step has been deleted needs nobody: `harvestChainStep`
 * answers `gone` and it clears itself, which is what covers a chain destroyed in a workspace this
 * window is not holding.
 *
 * Asked of the timers rather than of `stepsByChain`: that map holds the workspace on screen, so it
 * answers "no steps" for a chain aborted from anywhere else, which is exactly the case where a
 * timer would be left behind.
 */
function stopHarvestingForChain(chainId: string): void {
  for (const [stepId, entry] of harvesting) {
    if (entry.chainId !== chainId) continue;
    clearInterval(entry.timer);
    harvesting.delete(stepId);
  }
}

/** Which cross-workspace gate read is the current one. See `refreshGates`. */
let gatesSeq = 0;

export const useChainStore = create<ChainState>((set, get) => ({
  workspaceId: null,
  chains: [],
  gatedChains: [],
  templates: [],
  stepsByChain: {},
  briefsByChain: {},
  reposByChain: {},
  selectedId: null,
  selectedTemplateId: null,
  background: false,

  setWorkspace: async (id) => {
    if (get().workspaceId === id) return;
    // **Harvesting deliberately survives this.**
    //
    // Every timer used to be cleared here, on the grounds that `stepsByChain` was about to be
    // thrown away and a poller would be watching a step this store could no longer name. That was
    // true of the *bookkeeping* and false of the *work*: a harvest timer is how the result of a run
    // that outlived a webview reload gets collected at all, and killing it meant a plan recovered
    // that way simply stopped advancing for as long as the user was looking at another workspace —
    // silently, since an adopted step has no live promise and nothing else to report it. Which
    // workspace is on screen is not a fact about whether a result is worth collecting.
    //
    // What made it safe to keep is that the callback writes nothing workspace-scoped without a
    // guard of its own: `refresh` declines a chain the loaded list does not hold, `applyChain`'s
    // `map` simply matches nothing, and `pump` is workspace-agnostic by design (it is what advances
    // a chain on a phone's behalf). The one thing that did depend on `stepsByChain` — finding a
    // chain's timers in order to stop them — now travels with the timer instead.
    set({
      workspaceId: id,
      chains: [],
      templates: [],
      stepsByChain: {},
      briefsByChain: {},
      reposByChain: {},
      selectedId: null,
      selectedTemplateId: null,
    });
    // Before the early return below, and unscoped: the gate list spans every workspace, so it is
    // just as true for a switch to none as for a switch to another one — and this is the call that
    // populates it at boot.
    void get().refreshGates();
    if (!id) return;
    const [chains, templates, briefs] = await Promise.all([
      listAgentChains(id).catch(() => [] as AgentChain[]),
      listChainTemplates(id).catch(() => [] as ChainTemplate[]),
      listWorkspaceChainSteps(id).catch(() => [] as ChainStepBrief[]),
    ]);
    set((s) => (s.workspaceId === id ? { chains, templates, briefsByChain: groupBriefs(briefs) } : s));
    // Recovery first, and deliberately *before* the guard below.
    //
    // A step left running by a webview reload has no live promise anywhere; adopting it is how its
    // result gets collected at all, and `adoptRunningSteps` guards its own workspace-scoped write.
    // Three loads and a workspace switch is one keystroke, so skipping this because the user moved
    // during the load would leave that step with nobody watching for it until they came back — the
    // same silent stall that clearing the timers on every switch used to cause.
    for (const chain of chains) {
      if (chain.status === "running") void adoptRunningSteps(chain.id, id, get, set);
    }
    // Starting engines is the other half, and that one *is* worth withholding. `chains` may be a
    // list this store has already decided not to hold, and a queued chain pumped for a workspace
    // nobody is in launches a model against a working copy on the strength of a keystroke the user
    // has already taken back.
    if (get().workspaceId !== id) return;
    // A chain left `running` by a killed session was already demoted to `paused` by
    // `recover_after_restart`; one that is `queued` here is one the user resumed and then closed
    // the view on, so it is picked up rather than left looking about to start.
    for (const chain of chains) {
      if (chain.status === "queued") void get().pump(chain.id);
    }
  },

  select: async (chainId) => {
    // The template goes whatever the argument is: `select(null)` is how a task takes the column,
    // so leaving a template behind would put two things in it.
    set({ selectedId: chainId, selectedTemplateId: null });
    // Exactly one thing occupies the middle column. Cleared from here rather than the other way
    // round because this store may depend on the task store and not the reverse.
    if (chainId) useAgentsStore.setState({ selectedId: null });
    if (chainId) await get().refresh(chainId);
  },

  selectTemplate: (templateId) => {
    set({ selectedTemplateId: templateId, selectedId: null });
    if (templateId) useAgentsStore.setState({ selectedId: null });
  },

  refreshGates: async () => {
    // Sequenced, because this is fired from several places at once — a chain settling, a list
    // reload and a workspace switch can all land within a tick of each other, and two reads
    // resolving out of order would leave the older answer on screen. The counter is bookkeeping,
    // not state: nothing renders it.
    const seq = ++gatesSeq;
    const gates = await listGatedChains().catch(() => null);
    // A read that did not come back leaves the previous answer standing rather than emptying the
    // bar. "Nothing is waiting on you" is a claim, and one failed query is not grounds for making
    // it — the row the user would stop seeing is the one they most need.
    if (!gates || seq !== gatesSeq) return;
    set({ gatedChains: gates });
  },

  reloadChains: async () => {
    const id = get().workspaceId;
    if (!id) return;
    const [chains, briefs] = await Promise.all([
      listAgentChains(id).catch(() => [] as AgentChain[]),
      listWorkspaceChainSteps(id).catch(() => [] as ChainStepBrief[]),
    ]);
    // Templates are deliberately not re-read: nothing reachable from a phone can edit one, so
    // asking for them would be a query per invalidation that can never come back different.
    set((s) => (s.workspaceId === id ? { chains, briefsByChain: groupBriefs(briefs) } : s));
    // Outside the guard above, because the gate list is not this workspace's: whatever moved the
    // chains may well have parked — or freed — a plan somewhere else.
    void get().refreshGates();
  },

  refresh: async (chainId) => {
    // A chain this window's list does not hold belongs to another workspace, and it is here only
    // because a phone asked for it to be advanced (see `pump`). Reading its steps would be a round
    // trip whose answer goes into `stepsByChain` — the map the detail pane draws for the workspace
    // that *is* loaded — so it is skipped rather than filed somewhere it does not belong.
    if (!get().chains.some((c) => c.id === chainId)) return;
    const detail = await getChainDetail(chainId).catch(() => null);
    if (!detail) return;
    set((s) => ({
      chains: s.chains.map((c) => (c.id === chainId ? detail.chain : c)),
      stepsByChain: { ...s.stepsByChain, [chainId]: detail.steps },
      briefsByChain: { ...s.briefsByChain, [chainId]: detail.steps.map(briefOf) },
      reposByChain: { ...s.reposByChain, [chainId]: detail.repos },
    }));
  },

  create: async ({ projectIds, title, goal, steps, agentProjectId, start }) => {
    // Read before the await, never after: this is the workspace the plan was authored in, and it is
    // the only moment at which that is still an observable fact. See `adoptDetail`.
    const startedIn = get().workspaceId;
    const detail = await createAgentChain(projectIds, title, goal, steps, agentProjectId);
    adoptDetail(detail, startedIn, set);
    // Created parked, then queued in a separate call: nothing in this app starts an engine as a
    // side effect of writing a row.
    if (start) {
      await resumeChain(detail.chain.id).then((chain) => chain && applyChain(chain, set));
      void get().pump(detail.chain.id);
    }
    return detail;
  },

  createStory: async ({
    projectIds,
    title,
    notes,
    analystAgentId,
    implementerAgentId,
    agentProjectId,
    workItem,
    start,
  }) => {
    const startedIn = get().workspaceId;
    const detail = await createStoryChain({
      projectIds,
      title,
      notes,
      analystAgentId,
      implementerAgentId,
      agentProjectId,
      workItem,
    });
    adoptDetail(detail, startedIn, set);
    if (start) {
      await resumeChain(detail.chain.id).then((chain) => chain && applyChain(chain, set));
      void get().pump(detail.chain.id);
    }
    return detail;
  },

  approvePlan: async (chainId, decisions) => {
    // Sequential, and dropped before kept: `approve_chain_gate` reads "the next pending step", so
    // every no has to be off the board before the yes is recorded.
    for (const decision of decisions.filter((d) => !d.include)) {
      await setChainStepSkipped(decision.stepId, true).catch(() => undefined);
    }
    const kept = decisions.filter((d) => d.include);
    for (const decision of kept) {
      // Re-included: a repository the user had unticked and then thought better of is still
      // `skipped` on disk, and a step that is not pending is one the input write below ignores.
      await setChainStepSkipped(decision.stepId, false).catch(() => undefined);
      await setChainStepInput(decision.stepId, decision.input).catch(() => undefined);
    }
    // `""`, deliberately: the message for the gated step was just written by the loop above, and
    // approving with an empty input is what tells the backend to send exactly that.
    //
    // And no step id, equally deliberately: the loop above just moved several steps in and out of
    // `pending` on disk, and this store's copy of their statuses is a plan ago. Naming a step from
    // it would name one this call itself had skipped, and the precondition would refuse the very
    // approval it exists to protect. Nothing is lost — this dialog *is* the read of the gate, and
    // it was open across the writes.
    await get().approve(chainId, "");
  },

  pump: async (chainId, opts) => {
    // Recorded before either guard, and that ordering matters twice over. What follows may leave the
    // chain queued for `settleStep` to pick up minutes from now, by which time the tap that
    // authorised it is long over — and an approval that lands while this chain is already mid-advance
    // returns at the very next line, which would otherwise throw the authorisation away with it.
    if (opts?.remote) drivenRemotely.add(chainId);
    if (inFlight.has(chainId)) return;
    // The tray guard, with the one exemption it always needed. `background` exists so a hidden
    // window does not start engines nobody asked for — and a phone tap *is* somebody asking, from a
    // screen that shows the run's output and offers to stop it. Without the exemption this feature
    // did nothing at all in its most common setting: the desktop is closed to the tray, which is
    // exactly why the user is answering the gate from a phone.
    if (get().background && !drivenRemotely.has(chainId)) return;
    inFlight.add(chainId);
    let stepId: string | null = null;
    try {
      // Minted here because the claim records it before the run exists — that is what lets a
      // recovered step be matched back to the turn it produced.
      const runId = newRunId("agent");
      const claim = await claimNextChainStep(chainId, runId);
      applyChain(claim.chain, set);
      if (claim.kind !== "run" || !claim.task || !claim.step) {
        // "Nothing to run" is not "nothing happened": the claim may have frozen a gate's message
        // onto its step, failed one for an unroutable agent, or marked the plan finished. Applying
        // only the chain would leave the pane showing a gate with no message in it.
        //
        // It is also where a remotely driven chain stops moving, so the mark goes with it: whatever
        // parked it wants a person again, and that person's next answer re-marks it.
        drivenRemotely.delete(chainId);
        await get().refresh(chainId);
        return;
      }
      stepId = claim.step.id;
      // The task list is the loaded workspace's, and a chain pumped for a phone need not be from it.
      // Adopting a foreign row would put a task in the tree whose repository is not in the workspace
      // the tree is drawn for; `runTurn` is handed the row directly instead, which is all it needed
      // the store for.
      const agents = useAgentsStore.getState();
      const foreign = claim.task.workspace_id !== agents.workspaceId;
      if (!foreign) agents.adopt(claim.task);
      // Both copies of the step, or the tree would draw the running step as still pending for as
      // long as the turn takes — the next write to either is `settleStep`, minutes later.
      set((s) => ({
        stepsByChain: {
          ...s.stepsByChain,
          [chainId]: (s.stepsByChain[chainId] ?? []).map((step) =>
            step.id === claim.step!.id ? claim.step! : step,
          ),
        },
        briefsByChain: {
          ...s.briefsByChain,
          [chainId]: (s.briefsByChain[chainId] ?? []).map((brief) =>
            brief.id === claim.step!.id ? briefOf(claim.step!) : brief,
          ),
        },
      }));

      await useAgentsStore.getState().runTurn(claim.task.id, claim.message, {
        runId,
        // Only when the store has no row of its own to find — see `foreign` above.
        task: foreign ? claim.task : undefined,
        // The plan, not the step. Both are true of this run, and the plan is the one worth
        // offering: it is where the whole sequence is readable, and the step's own task is one
        // click further in from there.
        about: {
          kindKey: "agents.liveKindChain",
          detail: claim.chain.title || claim.chain.goal,
          // A chain carries no workspace of its own — every one of its queries reaches the
          // workspace through the project. The task the step runs as does, and it is the same one.
          workspaceId: claim.task.workspace_id,
          target: {
            view: "agents",
            projectId: claim.step.project_id,
            select: { kind: "chain", id: chainId },
          },
        },
        onSettle: (outcome) => {
          void settleStep(claim.step!.id, chainId, outcome, get, set);
        },
      });
    } catch (e) {
      // The claim itself failed, or the turn threw somewhere `runTurn` does not cover. A step
      // already marked dispatched must not be left that way: back to `pending`, chain `queued`.
      if (stepId) {
        const chain = await completeChainStep(stepId, "requeue", "", String(e)).catch(() => null);
        if (chain) applyChain(chain, set);
      }
    } finally {
      inFlight.delete(chainId);
    }
  },

  approve: async (chainId, input, stepId) => {
    // The one command here that can be refused on a precondition, so the one that has to say so.
    // Every caller invokes this as a bare `void`, and a rejection would be an unhandled one — which
    // is the worst possible shape for "your click did nothing": no message, no reload, and a pane
    // still showing the gate it just failed to clear.
    const chain = await approveChainGate(chainId, input, stepId).catch((e: unknown) => {
      const message = e instanceof Error ? e.message : String(e);
      // A refused precondition comes back as a translation key, the same convention `last_reason`
      // uses and for the same reason — the language is the reader's, not the writer's. Anything
      // else is a real failure and is shown as it arrived.
      pushErrorToast(message === GATE_MOVED ? translate("chain.gateMoved") : message);
      return null;
    });
    if (chain) applyChain(chain, set);
    // The refresh runs either way, and it is the point of the refusal: nothing was written, so the
    // gate that is actually open is the one this re-read brings back.
    await get().refresh(chainId);
    if (chain) void get().pump(chainId);
  },

  skip: async (chainId) => {
    const chain = await skipChainStep(chainId);
    if (chain) applyChain(chain, set);
    await get().refresh(chainId);
    void get().pump(chainId);
  },

  retry: async (chainId) => {
    const chain = await retryChainStep(chainId);
    if (chain) applyChain(chain, set);
    await get().refresh(chainId);
    void get().pump(chainId);
  },

  rerunFrom: async (chainId, stepIndex, note) => {
    const chain = await rerunChainFrom(chainId, stepIndex, note);
    if (chain) applyChain(chain, set);
    await get().refresh(chainId);
    if (chain?.status === "queued") void get().pump(chainId);
  },

  resume: async (chainId) => {
    const chain = await resumeChain(chainId);
    if (chain) applyChain(chain, set);
    void get().pump(chainId);
  },

  abort: async (chainId) => {
    // Every timer this chain owns, before anything else: an aborted step has no result to harvest,
    // and a poller left behind here is one that never stops (see `stopHarvestingForChain`).
    stopHarvestingForChain(chainId);
    // "Stop" is the one answer that cannot be followed by another step, so whoever was driving this
    // remotely is no longer driving anything.
    drivenRemotely.delete(chainId);
    // Stop the live step first, or the engine keeps editing a working copy for a plan that no
    // longer exists — the same reason `agentsStore.remove` cancels before deleting.
    const step = (get().stepsByChain[chainId] ?? []).find((s) => s.status === "running");
    if (step?.run_id) await useAiRunStore.getState().cancel(step.run_id);
    const chain = await abortChain(chainId);
    if (chain) applyChain(chain, set);
    await get().refresh(chainId);
  },

  remove: async (chainId) => {
    await get().abort(chainId);
    // The step tasks go with the chain now — the backend deletes them in the same transaction, and
    // hands back which ones so the task list can forget them here rather than keep drawing rows for
    // work whose plan is gone.
    const orphaned = await deleteChain(chainId);
    if (orphaned.length > 0) useAgentsStore.getState().forget(orphaned);
    set((s) => {
      const { [chainId]: _dropped, ...stepsByChain } = s.stepsByChain;
      const { [chainId]: _droppedBriefs, ...briefsByChain } = s.briefsByChain;
      const { [chainId]: _droppedRepos, ...reposByChain } = s.reposByChain;
      return {
        chains: s.chains.filter((c) => c.id !== chainId),
        stepsByChain,
        briefsByChain,
        reposByChain,
        selectedId: s.selectedId === chainId ? null : s.selectedId,
        // Dropped here as well, so a deleted plan stops asking for an answer. The list above is
        // this workspace's; this one is every workspace's, and a chain deleted while parked at a
        // gate would otherwise keep an amber row in the status bar that leads to nothing. Filtered
        // rather than re-read: the row is gone, and that is knowable without a round trip.
        gatedChains: s.gatedChains.filter((g) => g.chain_id !== chainId),
      };
    });
  },

  abortForProject: async (projectId) => {
    // Every chain with a step in that repository, not only the ones whose *primary* it is. The
    // database cascades the latter away with the project; the former survive it, and one of them
    // could have a turn running in the working copy that is about to disappear.
    const touched = (chainId: string) =>
      (get().briefsByChain[chainId] ?? []).some((brief) => brief.project_id === projectId);
    const doomed = get().chains.filter(
      (c) => (c.project_id === projectId || touched(c.id)) && !isTerminal(c.status),
    );
    for (const chain of doomed) await get().abort(chain.id);
    set((s) => ({ chains: s.chains.filter((c) => c.project_id !== projectId) }));
    // The database cascades these away with the project; the stores would otherwise keep showing
    // them until the next workspace reload, with a stop button pointing at nothing.
    useAgentsStore.setState((s) => {
      const doomedTasks = new Set(s.tasks.filter((task) => task.project_id === projectId).map((task) => task.id));
      if (doomedTasks.size === 0) return s;
      return {
        tasks: s.tasks.filter((task) => !doomedTasks.has(task.id)),
        live: Object.fromEntries(Object.entries(s.live).filter(([id]) => !doomedTasks.has(id))),
        selectedId: s.selectedId && doomedTasks.has(s.selectedId) ? null : s.selectedId,
      };
    });
    // The gate list is deliberately *not* refreshed here. The chains this repository takes with it
    // go by database cascade, which has not happened yet — the caller deletes the row after this
    // returns — so a read from here would faithfully report every one of them as still waiting.
    // `removeProject` fires it on the other side of the delete instead.
  },

  // Filing and pinning leave `updated_at` alone on both sides — the list is ordered by it, and
  // neither says anything about the plan itself.
  setGroup: async (chainId, agentProjectId) => {
    const chain = get().chains.find((c) => c.id === chainId);
    if (!chain || chain.agent_project_id === agentProjectId) return;
    set((s) => ({
      chains: s.chains.map((c) => (c.id === chainId ? { ...c, agent_project_id: agentProjectId } : c)),
    }));
    await setChainGroup(chainId, agentProjectId);
  },

  setPinned: async (chainId, pinned) => {
    const chain = get().chains.find((c) => c.id === chainId);
    if (!chain || chain.pinned === pinned) return;
    set((s) => ({ chains: s.chains.map((c) => (c.id === chainId ? { ...c, pinned } : c)) }));
    await setChainPinned(chainId, pinned);
  },

  // The delete already unfiled these rows on disk. This is the copy on screen, and it is the
  // caller's to run — `agentsStore.removeProject` cannot reach in here, the dependency between the
  // two stores only runs the other way.
  forgetProject: (agentProjectId) =>
    set((s) => ({
      chains: s.chains.map((c) =>
        c.agent_project_id === agentProjectId ? { ...c, agent_project_id: "" } : c,
      ),
    })),

  reloadTemplates: async () => {
    const id = get().workspaceId;
    if (!id) return;
    const templates = await listChainTemplates(id).catch(() => [] as ChainTemplate[]);
    set((s) => (s.workspaceId === id ? { templates } : s));
  },

  saveTemplate: async ({ id, name, description, steps }) => {
    const workspaceId = get().workspaceId;
    if (!workspaceId) return null;
    const saved = await upsertChainTemplate(id, workspaceId, name, description, steps);
    await get().reloadTemplates();
    return saved;
  },

  removeTemplate: async (id) => {
    await deleteChainTemplate(id);
    set((s) => ({ templates: s.templates.filter((template) => template.id !== id) }));
  },

  continueFrom: async ({ sourceTaskId, title, goal, steps, agentProjectId, start }) => {
    const startedIn = get().workspaceId;
    const detail = await createContinuationChain(sourceTaskId, title, goal, steps, agentProjectId);
    adoptDetail(detail, startedIn, set);
    // The seeded step is already `done`, so starting goes straight to the agent the user picked —
    // it never re-runs the task it came from.
    if (start) {
      const chain = await resumeChain(detail.chain.id);
      if (chain) applyChain(chain, set);
      void get().pump(detail.chain.id);
    }
    return detail;
  },
}));

type SetState = (partial: Partial<ChainState> | ((s: ChainState) => Partial<ChainState>)) => void;

function isTerminal(status: AgentChain["status"]): boolean {
  return status === "done" || status === "aborted";
}

/** The slim step the tree draws with, taken off a full row rather than re-read: whoever already
 * holds the detail holds a newer copy than another workspace-wide query would return. */
function briefOf(step: AgentChainStep): ChainStepBrief {
  return {
    id: step.id,
    chain_id: step.chain_id,
    step_index: step.step_index,
    agent_name: step.agent_name,
    instruction: step.instruction,
    gate: step.gate,
    task_id: step.task_id,
    status: step.status,
    project_id: step.project_id,
    project_name: step.project_name,
    phase: step.phase,
  };
}

/** Files a freshly created chain into all four maps and opens it.
 *
 * Filtered rather than blindly prepended: the workspace subscription can have reloaded the list
 * while the create was in flight, and a chain listed twice is a duplicate React key — which does
 * not fail loudly, it silently drops one of the two.
 *
 * `startedIn` is the workspace the create was launched from, read before its await. Every caller
 * reaches here after a round trip, and the authoring modal does not block the app: `workspace.next`
 * / `workspace.prev` (Mod+Alt+PageDown/PageUp) and the command palette both render above it, so the
 * user can genuinely be standing somewhere else by the time the chain comes back. Filing it anyway
 * prepended one workspace's plan into another's list, gave it `selectedId`, and — with `start: true`
 * — pumped it in front of somebody who never asked for it, naming repositories they cannot see. The
 * chain itself still runs; `pump` claims by id and is deliberately workspace-agnostic. What this
 * refuses is drawing it in a list that claims to be a different workspace's. */
function adoptDetail(detail: ChainDetail, startedIn: string | null, set: SetState) {
  set((s) =>
    s.workspaceId !== startedIn
      ? s
      : {
          chains: [detail.chain, ...s.chains.filter((c) => c.id !== detail.chain.id)],
          stepsByChain: { ...s.stepsByChain, [detail.chain.id]: detail.steps },
          briefsByChain: { ...s.briefsByChain, [detail.chain.id]: detail.steps.map(briefOf) },
          reposByChain: { ...s.reposByChain, [detail.chain.id]: detail.repos },
          selectedId: detail.chain.id,
          // A chain started from a template is authored with that template still open; the new chain
          // is what the user is now looking at.
          selectedTemplateId: null,
        },
  );
}

/** Buckets the workspace-wide load by chain. The backend already ordered it by chain then step
 * index, so each bucket comes out in step order. */
function groupBriefs(briefs: ChainStepBrief[]): Record<string, ChainStepBrief[]> {
  const byChain: Record<string, ChainStepBrief[]> = {};
  for (const brief of briefs) (byChain[brief.chain_id] ??= []).push(brief);
  return byChain;
}

/**
 * Files a chain row that just moved, and tells the phones it moved.
 *
 * # Why the notification lives here and not at the seven callers
 *
 * Every way a chain changes on this side ends in this function: approve, skip, retry, resume,
 * abort, rerun, the claim that starts a step, and `settleStep` when one finishes. That makes it the
 * one place where "the chain is not what your copy says" is unambiguously true, and the one place
 * that cannot be forgotten when an eighth path is added.
 *
 * The gap it closes is the whole of the desktop→phone direction for chains. `approve_chain_gate` is
 * pure SQL and the executor is right here in the webview, so a chain advancing at the desk moved no
 * bytes on disk and printed nothing a phone was subscribed to — the Agents tab kept showing a gate
 * that had been answered, until somebody switched tabs.
 *
 * # Why an unknown chain is dropped rather than inserted
 *
 * `chains` means "the chains of the loaded workspace" — `reloadChains` reads exactly that and
 * `setWorkspace` empties it. Since `pump` now runs chains from *any* workspace on behalf of a phone,
 * inserting whatever came back would draw another workspace's plan in a list that claims to be this
 * one's, with no briefs behind it and no way for the user to reach the repository it names.
 *
 * Nothing loses a row to this: the one caller that files a genuinely new chain is `create`, and it
 * goes through `adoptDetail` first — every other caller is acting on a chain that is already on
 * screen. The notification is unconditional either way, because a chain did move.
 */
function applyChain(chain: AgentChain, set: SetState) {
  set((s) => ({
    chains: s.chains.map((c) => (c.id === chain.id ? chain : c)),
  }));
  // Every local chain transition passes through here, which makes it the one place worth asking the
  // gate question from: a plan that just parked has to appear in the status bar, and one whose gate
  // was just answered has to leave it. The `map` above cannot serve for either, because it only
  // ever touches the workspace this window has loaded — and `pump` advances chains belonging to
  // others on a phone's behalf, so `chain` here is not always one of them.
  void useChainStore.getState().refreshGates();
  notifyStateChange("chains");
}

/** Reports a finished step and, when the chain is ready to move again, moves it. */
async function settleStep(
  stepId: string,
  chainId: string,
  outcome: { kind: "ok"; text: string } | { kind: "error"; message: string; busy: boolean } | { kind: "cancelled" },
  get: () => ChainState,
  set: SetState,
) {
  let chain: AgentChain | null = null;
  if (outcome.kind === "ok") {
    // The turn answered. Whether that counts as having *worked* is the check's to say, and it is
    // the one fact in a chain no agent authored — so it is asked before the step is recorded, not
    // after. A step with no check comes back `ran: false` and the line below is what it always was.
    //
    // A check that throws is treated as no check at all rather than as a failure: the command
    // itself already reports a missing binary or an unreadable directory as a failed verdict, so
    // anything reaching here is the IPC call breaking, and failing the step for that would punish
    // the agent for the app's problem.
    const verdict = await runChainStepCheck(stepId).catch(() => null);
    chain = verdict?.ran && !verdict.passed
      ? await completeChainStep(stepId, "check_failed", outcome.text, verdict.output).catch(() => null)
      : await completeChainStep(stepId, "done", outcome.text, "").catch(() => null);
  } else if (outcome.kind === "cancelled") {
    chain = await completeChainStep(stepId, "cancelled", "", "chain.stopped").catch(() => null);
  } else if (outcome.busy) {
    // Never a failure: the turn did not run. Back in the queue, and the sweep re-arms it when
    // whoever holds the repository finishes.
    chain = await completeChainStep(stepId, "requeue", "", "chain.repoBusy").catch(() => null);
  } else {
    chain = await completeChainStep(stepId, "error", "", outcome.message).catch(() => null);
  }
  if (chain) applyChain(chain, set);
  // The chain row did not come back, but the *step* still moved — and a phone with the chain detail
  // open is reading step rows, not the chain's. `applyChain` is the only other notifier, so without
  // this the one case where it did not run would go out silently.
  else notifyStateChange("chains");
  await get().refresh(chainId);
  // The plan reaching its end, as opposed to one of its steps. Each turn already files its own
  // "agent task finished" through `agentsStore`, but a ten-step chain is the longest-running thing
  // in the app and "they are all done" is the only one of those eleven notifications the user was
  // actually waiting for. `aborted` is the user's own stop, so it stays silent like every other
  // cancelled run; `gated` and `paused` are still in flight and say nothing yet.
  if (chain?.status === "done" || chain?.status === "failed") {
    notify({
      source: "agents",
      titleKey: chain.status === "done" ? "notifications.chainDone" : "notifications.chainFailed",
      // A chain carries no workspace column of its own — every one of its queries reaches the
      // workspace through the first repository of its set — so this is where the stamp comes from,
      // the same route `pump` uses for the run itself. It answers `null` for a workspace this
      // session has never loaded the projects of, and the target below is what repairs that: the
      // project id outranks the stamp in `enterWorkspace`, so a row filed under nothing still lands
      // on the right plan once the workspace it belongs to has been resolved from the repository.
      workspaceId: useWorkspaceStore.getState().workspaceOfProject(chain.project_id),
      target: { view: "agents", projectId: chain.project_id, select: { kind: "chain", id: chain.id } },
      status: chain.status === "done" ? "success" : "error",
      detail: chain.title,
    });
  }
  // Only `queued` continues, and this line is also the whole of the retry loop: a turn that failed
  // with attempts left comes back from `complete_chain_step` as `queued` rather than `failed`, so
  // it is picked up here like any other move. Which attempt it is on is counted in Rust, by the
  // claim — this side never decides to retry, it only carries out a chain that is ready to move.
  // A gate, an exhausted step or a stop all still wait for the user.
  //
  // `remote` carries whatever the last person to ask said, so a plan approved from a phone keeps
  // going with the window in the tray for the whole of its remaining steps rather than for one. It
  // is cleared here the moment the chain stops on something a person has to answer.
  if (chain?.status === "queued") void get().pump(chainId, { remote: drivenRemotely.has(chainId) });
  else drivenRemotely.delete(chainId);
}

/**
 * Steps still marked `running` with no live run behind them — the webview reloaded while the Rust
 * side kept going.
 *
 * They are **not** cancelled: the old turn still holds the repository's lease and will still write
 * its row when it finishes, so the work is waiting to be collected rather than lost. It is polled
 * for until it lands, or until the step has been out there long enough that something is clearly
 * wrong, at which point the run is stopped and the chain parks.
 */
async function adoptRunningSteps(
  chainId: string,
  startedIn: string | null,
  get: () => ChainState,
  set: SetState,
) {
  const detail = await getChainDetail(chainId).catch(() => null);
  if (!detail) return;
  // The read is a round trip and the user may have left in the middle of it, so the two halves of
  // this function part company here.
  //
  // `stepsByChain` is the detail pane's map for the workspace that *is* loaded, so writing another
  // workspace's steps into it would put a chain on screen that does not belong there — the guard
  // stays, and the pane fills in again the next time that workspace is opened.
  //
  // The timers below are the other half, and they are not workspace state at all: they are how the
  // result of a run that outlived a webview reload gets collected. Skipping them because the user
  // walked away mid-load is how a recovered plan used to sit still until somebody came back to
  // watch it. Nothing here needs to be watched.
  if (get().workspaceId === startedIn) {
    set((s) => ({ stepsByChain: { ...s.stepsByChain, [chainId]: detail.steps } }));
  }
  for (const step of detail.steps) {
    if (step.status !== "running" || harvesting.has(step.id)) continue;
    if (useAiRunStore.getState().active[step.run_id]) continue;
    const timer = setInterval(() => {
      void (async () => {
        const outcome = await harvestChainStep(step.id).catch(() => null);
        // Nothing left to wait for: the step was deleted with its chain, or cascaded away with the
        // repository the chain was filed under — from any workspace, by anyone, including a phone.
        // This is the only stop that does not need somebody to come and ask for it, which is what
        // makes it the right one now that a timer outlives the workspace it was armed in.
        if (outcome?.gone) {
          clearInterval(timer);
          harvesting.delete(step.id);
          return;
        }
        const chain = outcome?.chain ?? null;
        if (chain) {
          clearInterval(timer);
          harvesting.delete(step.id);
          applyChain(chain, set);
          await get().refresh(chainId);
          if (chain.status === "queued") void get().pump(chainId);
          return;
        }
        if (Date.now() - Date.parse(step.updated_at) > STEP_TIMEOUT_MS) {
          clearInterval(timer);
          harvesting.delete(step.id);
          if (step.run_id) await useAiRunStore.getState().cancel(step.run_id);
          const parked = await completeChainStep(step.id, "cancelled", "", "chain.timedOut").catch(() => null);
          if (parked) applyChain(parked, set);
          await get().refresh(chainId);
        }
      })();
    }, HARVEST_POLL_MS);
    harvesting.set(step.id, { timer, chainId });
  }
}

/**
 * Wiring, at module scope on purpose.
 *
 * The Agents view is only mounted once the user has visited it, so anything hung off a component
 * effect would leave chains frozen for a session spent in the Graph — and the whole point is that
 * they keep going while you are elsewhere.
 */
useWorkspaceStore.subscribe((state, previous) => {
  if (state.activeWorkspaceId !== previous.activeWorkspaceId) {
    void useChainStore.getState().setWorkspace(state.activeWorkspaceId);
  }
});

/** The app's first real queue: after *any* agent turn in a repository — chained or hand-typed —
 * every chain waiting on that repository gets another go.
 *
 * "Waiting on that repository" is a question about the chain's *steps*, not about the chain: on a
 * multi-repo plan the next step routinely runs somewhere other than the repository the chain is
 * filed under, and matching on `chain.project_id` alone left those parked until something else
 * happened to nudge them. A chain whose briefs have not loaded yet is pumped anyway — the claim
 * refuses whatever is not runnable, so the cost of asking is one round trip. */
onTurnSettled((projectId) => {
  const store = useChainStore.getState();
  for (const chain of store.chains) {
    if (chain.status !== "queued") continue;
    const briefs = store.briefsByChain[chain.id];
    const waiting =
      chain.project_id === projectId ||
      briefs === undefined ||
      briefs.some((brief) => brief.project_id === projectId && brief.status === "pending");
    if (waiting) void store.pump(chain.id);
  }
});

// Hiding the window does not stop the webview, so without this a chain would keep launching
// engines with nothing on screen to show them and no button to stop them.
void listen("app:background", () => useChainStore.setState({ background: true }));
void listen("app:foreground", () => {
  useChainStore.setState({ background: false });
  const store = useChainStore.getState();
  for (const chain of store.chains) {
    if (chain.status === "queued") void store.pump(chain.id);
  }
});
