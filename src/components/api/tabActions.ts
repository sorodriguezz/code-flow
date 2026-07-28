/**
 * Save/Send for a request tab, published by the `RequestBuilder` that owns them so the view's
 * keyboard handler can reach them.
 *
 * Both actions are several hundred lines of state deep inside `RequestBuilder` — resolving the
 * draft, running the scripts, persisting scope writes — and none of that belongs in `ApiView`.
 * Lifting them into a store would be worse still: nothing *renders* from them, so every
 * registration would be a re-render for no visual change. A plain module-level map is the honest
 * shape for "the component that can do this is mounted".
 */
export interface TabActions {
  save: () => void;
  /** No-op for tabs whose protocol has no Send button (WebSocket, MQTT, gRPC drive their own). */
  send: () => void;
}

const registry = new Map<string, TabActions>();

/** Returns the unregister function, so callers can hand it straight back from a `useEffect`. */
export function registerTabActions(tabId: string, actions: TabActions): () => void {
  registry.set(tabId, actions);
  return () => {
    // Guarded so a remount that registered before this cleanup ran doesn't lose its entry.
    if (registry.get(tabId) === actions) registry.delete(tabId);
  };
}

export function tabActions(tabId: string): TabActions | null {
  return registry.get(tabId) ?? null;
}
