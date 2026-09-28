import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { JsonObject } from "../notebook/json";

/** Mirrors `jupyter::kernelspec::KernelChoice` — a kernel this machine can start. */
export interface KernelChoice {
  /** `spec:<name>` or `python:<path>`; what a start names. */
  id: string;
  name: string;
  displayName: string;
  language: string;
  argv: string[];
  env: Record<string, string>;
  interruptMode: "signal" | "message";
  source: "jupyter" | "directory" | "venv" | "path";
  resourceDir: string | null;
  python: string | null;
}

/** An interpreter that could run a kernel once ipykernel is installed in it. */
export interface PythonCandidate {
  path: string;
  label: string;
  version: string | null;
  source: KernelChoice["source"];
}

export interface KernelDiscovery {
  kernels: KernelChoice[];
  withoutIpykernel: PythonCandidate[];
}

/** Mirrors `jupyter::kernel::Lifecycle`. */
export type KernelLifecycle =
  | { state: "starting" }
  | { state: "ready"; info: JsonObject }
  | { state: "restarting" }
  | { state: "unresponsive" }
  | { state: "responsive" }
  | { state: "died"; code: number | null; stderr: string }
  | { state: "stopped" };

/** Mirrors `jupyter::KernelEvent` — one entry of a `notebook:kernel-events` batch. */
export type KernelEvent =
  | {
      type: "message";
      kernelId: string;
      channel: "shell" | "iopub" | "stdin" | "control";
      msgType: string;
      msgId: string;
      parentMsgId: string | null;
      content: JsonObject;
      metadata: JsonObject;
    }
  | { type: "lifecycle"; kernelId: string; lifecycle: KernelLifecycle };

export const discoverKernels = (repoPath: string, notebookPath: string) =>
  invoke<KernelDiscovery>("notebook_discover_kernels", { repoPath, notebookPath });

/** Resolves with the kernel's `kernel_info_reply` content once it answers. */
export const startKernel = (kernelId: string, choiceId: string, repoPath: string, notebookPath: string) =>
  invoke<JsonObject>("notebook_kernel_start", { kernelId, choiceId, repoPath, notebookPath });

export const executeInKernel = (kernelId: string, msgId: string, code: string) =>
  invoke<void>("notebook_kernel_execute", { kernelId, msgId, code, allowStdin: true });

export const replyToInput = (kernelId: string, value: string) =>
  invoke<void>("notebook_kernel_input", { kernelId, value });

export const interruptKernel = (kernelId: string) => invoke<void>("notebook_kernel_interrupt", { kernelId });

export const restartKernel = (kernelId: string) => invoke<JsonObject>("notebook_kernel_restart", { kernelId });

export const shutdownKernel = (kernelId: string) => invoke<void>("notebook_kernel_shutdown", { kernelId });

/** Mirrors `jupyter::assist::AssistRequest`. */
export interface NotebookAssistRequest {
  action: "generate" | "explain" | "fix" | "document";
  kernelLanguage: string;
  replyLanguage: string;
  instruction?: string | null;
  target?: NotebookCellContext | null;
  error?: string | null;
  before: NotebookCellContext[];
  after: NotebookCellContext[];
  notebookName: string;
}

export interface NotebookCellContext {
  index: number;
  cellType: string;
  source: string;
  output?: string | null;
  executionCount?: number | null;
}

export const notebookAi = (request: NotebookAssistRequest, runId: string, workspaceId: string | null) =>
  invoke<string>("notebook_ai", { request, runId, workspaceId });

export const defaultNotebookTemplate = () => invoke<string>("default_notebook_template");

export const onKernelEvents = (handler: (events: KernelEvent[]) => void): Promise<UnlistenFn> =>
  listen<KernelEvent[]>("notebook:kernel-events", (event) => handler(event.payload));
