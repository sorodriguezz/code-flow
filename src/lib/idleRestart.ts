import { relaunch } from "@tauri-apps/plugin-process";
import { useAiRunStore } from "../state/aiRunStore";
import { useAgentsStore } from "../state/agentsStore";
import { useChainStore } from "../state/chainStore";
import { useUpdateStore } from "../state/updateStore";
import { busyReasons, type BusyReason } from "./busyReasons";

/** Looks at the live stores. */
export function currentBusyReasons(): BusyReason[] {
  const aiRuns = Object.values(useAiRunStore.getState().active).filter(Boolean).length;
  const chainsMoving = useChainStore.getState().chains.filter((c) => c.status === "running" || c.status === "queued").length;
  const agentTasks = useAgentsStore.getState().tasks.filter((task) => task.status === "running").length;
  return busyReasons({ aiRuns, chainsMoving, agentTasks });
}

/** How often to look, and how many looks in a row must find nothing: a turn that ends and another that
 * starts a breath later must not slip a restart between them. */
const POLL_MS = 3_000;
const CLEAR_POLLS = 2;

let timer: ReturnType<typeof setInterval> | null = null;

/** Restarts to apply the downloaded update as soon as nothing is running. Idempotent; cancel with {@link cancelIdleRestart}. */
export function requestIdleRestart(): void {
  if (timer !== null) return;
  let clear = 0;
  const look = () => {
    const busy = currentBusyReasons();
    useUpdateStore.getState().setIdleRestart(true, busy);
    clear = busy.length === 0 ? clear + 1 : 0;
    if (clear >= CLEAR_POLLS) {
      cancelIdleRestart();
      void relaunch();
    }
  };
  look();
  timer = setInterval(look, POLL_MS);
}

export function cancelIdleRestart(): void {
  if (timer !== null) clearInterval(timer);
  timer = null;
  useUpdateStore.getState().setIdleRestart(false, []);
}
