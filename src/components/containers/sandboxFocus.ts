import { create } from "zustand";
import { useContainersStore } from "../../state/containersStore";
import { useUiStore } from "../../state/uiStore";
import type { RuntimeId } from "../../types/containers";

/**
 * Which sandbox the Sandboxes page has open — kept outside the page so another view (a story's
 * «Ambiente» chip) can open one: it sets the sandbox here, then goes to the page.
 */
interface SandboxFocus {
  openId: string | null;
  /** Bumped whenever the list should be read again (a sandbox created elsewhere). */
  version: number;
  open: (id: string | null) => void;
  touch: () => void;
}

export const useSandboxFocus = create<SandboxFocus>((set) => ({
  openId: null,
  version: 0,
  open: (id) => set({ openId: id }),
  touch: () => set((s) => ({ version: s.version + 1 })),
}));

/** Goes to the Sandboxes page of `runtime`, with `id` open. */
export function showSandbox(runtime: string, id: string) {
  useSandboxFocus.getState().open(id);
  useSandboxFocus.getState().touch();
  useContainersStore.getState().setNav({ runtime: runtime as RuntimeId, section: "sandboxes" });
  useUiStore.getState().setActiveView("containers");
}
