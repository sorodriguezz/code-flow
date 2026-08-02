/**
 * "A turn just finished in this repository."
 *
 * A deliberately tiny module rather than a store, and it exists to keep one dependency arrow
 * pointing the right way: the chain scheduler has to know when *any* agent turn settles — its own
 * or a hand-typed one, since both compete for the same working copy — but `agentsStore` must never
 * import `chainStore`. A listener array in the middle lets the scheduler subscribe without the
 * task layer knowing it exists.
 */

type Listener = (projectId: string) => void;

const listeners: Listener[] = [];

/** Returns the unsubscribe. Safe to call at module scope. */
export function onTurnSettled(listener: Listener): () => void {
  listeners.push(listener);
  return () => {
    const at = listeners.indexOf(listener);
    if (at >= 0) listeners.splice(at, 1);
  };
}

/** Fired after the turn's state has been written, never before — a listener that immediately asks
 * "is this repository free?" has to get the answer from after the run, not from during it. */
export function notifyTurnSettled(projectId: string): void {
  // Copied first: a listener that unsubscribes itself while being notified would otherwise skip
  // the next one along.
  for (const listener of [...listeners]) {
    try {
      listener(projectId);
    } catch {
      // A broken listener is not allowed to take the turn's own bookkeeping down with it.
    }
  }
}
