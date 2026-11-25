import { listen } from "@tauri-apps/api/event";
import { dbLoadTree } from "../../lib/tauri/dbCommands";
import { containersMarketStacks } from "../../lib/tauri/containersMarketCommands";
import { useApiStore } from "../../state/apiStore";
import { onJobEnd, useContainersJobsStore } from "../../state/containersJobsStore";
import { useDbStore } from "../../state/dbStore";
import { translate } from "../../state/languageStore";
import { pushErrorToast, pushSuccessToast } from "../../state/toastStore";
import { marketJobToast } from "./marketModel";
import type { StackView } from "../../types/containersMarket";

/**
 * A service-catalogue stack's `compose up` as a job of the jobs panel (`containersJobsStore`), and
 * what happens once it ends — registered here, at import, so it runs whether or not the catalogue's
 * page is still open by then. The backend settles the stack itself before the panel hears the job end
 * (`containers_market_up_job`); this only says how it went and reloads what the stack wired into.
 */

/** Base de datos and the API client hold their rows in memory: what a stack made there is read again. */
export async function refreshModules(workspaceId: string) {
  const db = useDbStore.getState();
  if (db.workspaceId === workspaceId) {
    try {
      const tree = await dbLoadTree(workspaceId);
      if (useDbStore.getState().workspaceId === workspaceId) useDbStore.setState({ connections: tree.connections, groups: tree.groups });
    } catch {
      // The Database page reads its tree again when it opens.
    }
  }
  const api = useApiStore.getState();
  if (api.workspaceId === workspaceId) {
    await Promise.allSettled([api.reloadEnvironments(), api.reloadTree()]);
  }
}

/** The backend settled a stack's `up` job — also one closed from the panel, which no job end reports. */
export const onMarketChanged = (handler: (id: string) => void) => listen<{ id: string }>("containers:market-changed", (e) => handler(e.payload.id));

/** Brings a stack up in the jobs panel. Its title and request name the stack, never a password. */
export function startMarketUp(stack: Pick<StackView, "id" | "name" | "runtime" | "context">) {
  return useContainersJobsStore
    .getState()
    .start(translate("containers.market.job.up", { name: stack.name }), { kind: "marketUp", runtime: stack.runtime, context: stack.context, target: stack.id }, { refresh: ["containers", "images", "volumes", "networks"], meta: { stack: stack.id, name: stack.name } });
}

onJobEnd("marketUp", (job, code, error) => {
  const name = job.options.meta?.name ?? job.request.target;
  void containersMarketStacks()
    .catch(() => [] as StackView[])
    .then(async (stacks) => {
      const stack = stacks.find((s) => s.id === job.request.target);
      const toast = marketJobToast(name, stack, code, error);
      if (toast) (toast.tone === "success" ? pushSuccessToast : pushErrorToast)(translate(toast.key, toast.params));
      if (stack && code === 0) await refreshModules(stack.workspaceId);
    });
});
