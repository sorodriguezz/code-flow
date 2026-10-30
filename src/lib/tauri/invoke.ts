import { invoke as tauriInvoke, type InvokeArgs, type InvokeOptions } from "@tauri-apps/api/core";

type InvokeObserver = (command: string, args: Record<string, unknown>, ok: boolean, result: unknown) => void;

let observer: InvokeObserver | null = null;

/** Observes this window's application commands without replacing Tauri's read-only IPC internals. */
export function setInvokeObserver(next: InvokeObserver | null): void {
  observer = next;
}

/** The public Tauri API, with best-effort observation that cannot alter the caller's outcome. */
export function invoke<T>(...parameters: [command: string, args?: InvokeArgs, options?: InvokeOptions]): Promise<T> {
  const pending = tauriInvoke<T>(...parameters);
  const [command, args] = parameters;
  const watching = observer;
  if (watching && !command.startsWith("plugin:")) {
    const plain = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
    const notify = (ok: boolean, result: unknown) => {
      try {
        watching(command, plain, ok, result);
      } catch {
        // Statistics must never reject a successful command or create an unhandled rejection.
      }
    };
    void pending.then((result) => notify(true, result), () => notify(false, undefined));
  }
  return pending;
}
