import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import {
  abortChain,
  approveChainGate,
  claimNextChainStep,
  completeChainStep,
  createAgentChain,
  createContinuationChain,
  deleteChain,
  deleteChainTemplate,
  getChainDetail,
  harvestChainStep,
  listAgentChains,
  listChainTemplates,
  listWorkspaceChainSteps,
  resumeChain,
  retryChainStep,
  setChainGroup,
  setChainPinned,
  skipChainStep,
  upsertChainTemplate,
} from "../lib/tauri/commands";
import { onTurnSettled } from "./agentEvents";
import { useAgentsStore } from "./agentsStore";
import { newRunId, useAiRunStore } from "./aiRunStore";
import { notify } from "./notificationStore";
import { useWorkspaceStore } from "./workspaceStore";
import type {
  AgentChain,
  AgentChainStep,
  ChainDetail,
  ChainStepBrief,
  ChainTemplate,
  NewChainStep,
} from "../types/domain";

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
  selectedId: string | null;
  /** The template open in the middle column, if any. Mutually exclusive with a chain and a task. */
  selectedTemplateId: string | null;
  /** True while the window is hidden to the tray — nothing dispatches then. */
  background: boolean;

  setWorkspace: (id: string | null) => Promise<void>;
  select: (chainId: string | null) => Promise<void>;
  /** Opens a template in the middle column. Mirrors `select`, including which store clears which. */
  selectTemplate: (templateId: string | null) => void;
  refresh: (chainId: string) => Promise<void>;
  create: (input: {
    projectId: string;
    title: string;
    goal: string;
    steps: NewChainStep[];
    agentProjectId: string;
    start: boolean;
  }) => Promise<ChainDetail>;
  /** Advances a chain by at most one step. Safe to call repeatedly and concurrently. */
  pump: (chainId: string) => Promise<void>;
  approve: (chainId: string, input: string) => Promise<void>;
  skip: (chainId: string) => Promise<void>;
  retry: (chainId: string) => Promise<void>;
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
/** Poll timers for steps adopted after a reload, keyed by step id. */
const harvesting = new Map<string, ReturnType<typeof setInterval>>();

export const useChainStore = create<ChainState>((set, get) => ({
  workspaceId: null,
  chains: [],
  templates: [],
  stepsByChain: {},
  briefsByChain: {},
  selectedId: null,
  selectedTemplateId: null,
  background: false,

  setWorkspace: async (id) => {
    if (get().workspaceId === id) return;
    set({
      workspaceId: id,
      chains: [],
      templates: [],
      stepsByChain: {},
      briefsByChain: {},
      selectedId: null,
      selectedTemplateId: null,
    });
    if (!id) return;
    const [chains, templates, briefs] = await Promise.all([
      listAgentChains(id).catch(() => [] as AgentChain[]),
      listChainTemplates(id).catch(() => [] as ChainTemplate[]),
      listWorkspaceChainSteps(id).catch(() => [] as ChainStepBrief[]),
    ]);
    set((s) => (s.workspaceId === id ? { chains, templates, briefsByChain: groupBriefs(briefs) } : s));
    // A chain left `running` by a killed session was already demoted to `paused` by
    // `recover_after_restart`; one that is `queued` here is one the user resumed and then closed
    // the view on, so it is picked up rather than left looking about to start.
    for (const chain of chains) {
      if (chain.status === "queued") void get().pump(chain.id);
      if (chain.status === "running") void adoptRunningSteps(chain.id, get, set);
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

  refresh: async (chainId) => {
    const detail = await getChainDetail(chainId).catch(() => null);
    if (!detail) return;
    set((s) => ({
      chains: s.chains.map((c) => (c.id === chainId ? detail.chain : c)),
      stepsByChain: { ...s.stepsByChain, [chainId]: detail.steps },
      briefsByChain: { ...s.briefsByChain, [chainId]: detail.steps.map(briefOf) },
    }));
  },

  create: async ({ projectId, title, goal, steps, agentProjectId, start }) => {
    const detail = await createAgentChain(projectId, title, goal, steps, agentProjectId);
    set((s) => ({
      // Filtered rather than blindly prepended: the workspace subscription can have reloaded the
      // list while the create was in flight, and a chain listed twice is a duplicate React key —
      // which does not fail loudly, it silently drops one of the two.
      chains: [detail.chain, ...s.chains.filter((c) => c.id !== detail.chain.id)],
      stepsByChain: { ...s.stepsByChain, [detail.chain.id]: detail.steps },
      briefsByChain: { ...s.briefsByChain, [detail.chain.id]: detail.steps.map(briefOf) },
      selectedId: detail.chain.id,
      // A chain started from a template is authored with that template still open; the new chain
      // is what the user is now looking at.
      selectedTemplateId: null,
    }));
    // Created parked, then queued in a separate call: nothing in this app starts an engine as a
    // side effect of writing a row.
    if (start) {
      await resumeChain(detail.chain.id).then((chain) => chain && applyChain(chain, set));
      void get().pump(detail.chain.id);
    }
    return detail;
  },

  pump: async (chainId) => {
    if (inFlight.has(chainId) || get().background) return;
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
        await get().refresh(chainId);
        return;
      }
      stepId = claim.step.id;
      useAgentsStore.getState().adopt(claim.task);
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

  approve: async (chainId, input) => {
    const chain = await approveChainGate(chainId, input);
    if (chain) applyChain(chain, set);
    await get().refresh(chainId);
    void get().pump(chainId);
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

  resume: async (chainId) => {
    const chain = await resumeChain(chainId);
    if (chain) applyChain(chain, set);
    void get().pump(chainId);
  },

  abort: async (chainId) => {
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
    await deleteChain(chainId);
    set((s) => {
      const { [chainId]: _dropped, ...stepsByChain } = s.stepsByChain;
      const { [chainId]: _droppedBriefs, ...briefsByChain } = s.briefsByChain;
      return {
        chains: s.chains.filter((c) => c.id !== chainId),
        stepsByChain,
        briefsByChain,
        selectedId: s.selectedId === chainId ? null : s.selectedId,
      };
    });
  },

  abortForProject: async (projectId) => {
    const doomed = get().chains.filter((c) => c.project_id === projectId && !isTerminal(c.status));
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
    const detail = await createContinuationChain(sourceTaskId, title, goal, steps, agentProjectId);
    set((s) => ({
      chains: [detail.chain, ...s.chains.filter((c) => c.id !== detail.chain.id)],
      stepsByChain: { ...s.stepsByChain, [detail.chain.id]: detail.steps },
      briefsByChain: { ...s.briefsByChain, [detail.chain.id]: detail.steps.map(briefOf) },
      selectedId: detail.chain.id,
      selectedTemplateId: null,
    }));
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
  };
}

/** Buckets the workspace-wide load by chain. The backend already ordered it by chain then step
 * index, so each bucket comes out in step order. */
function groupBriefs(briefs: ChainStepBrief[]): Record<string, ChainStepBrief[]> {
  const byChain: Record<string, ChainStepBrief[]> = {};
  for (const brief of briefs) (byChain[brief.chain_id] ??= []).push(brief);
  return byChain;
}

function applyChain(chain: AgentChain, set: SetState) {
  set((s) => ({
    chains: s.chains.some((c) => c.id === chain.id)
      ? s.chains.map((c) => (c.id === chain.id ? chain : c))
      : [chain, ...s.chains],
  }));
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
    chain = await completeChainStep(stepId, "done", outcome.text, "").catch(() => null);
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
      status: chain.status === "done" ? "success" : "error",
      detail: chain.title,
    });
  }
  // Only `queued` continues. A gate, a failure or a stop all wait for the user — nothing retries
  // by itself anywhere in this file.
  if (chain?.status === "queued") void get().pump(chainId);
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
async function adoptRunningSteps(chainId: string, get: () => ChainState, set: SetState) {
  const detail = await getChainDetail(chainId).catch(() => null);
  if (!detail) return;
  set((s) => ({ stepsByChain: { ...s.stepsByChain, [chainId]: detail.steps } }));
  for (const step of detail.steps) {
    if (step.status !== "running" || harvesting.has(step.id)) continue;
    if (useAiRunStore.getState().active[step.run_id]) continue;
    const timer = setInterval(() => {
      void (async () => {
        const chain = await harvestChainStep(step.id).catch(() => null);
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
    harvesting.set(step.id, timer);
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
 * every chain waiting on that repository gets another go. */
onTurnSettled((projectId) => {
  const store = useChainStore.getState();
  for (const chain of store.chains) {
    if (chain.project_id === projectId && chain.status === "queued") void store.pump(chain.id);
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
