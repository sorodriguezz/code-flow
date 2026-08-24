/**
 * "Your copy of X is stale", delivered to whichever screen happens to be mounted.
 *
 * # Why this is a DOM event and not a store field
 *
 * Three of the invalidation domains — `reviews`, `chat` and one chain's detail — have no home in
 * `store.ts`. The pull requests, the saved review runs, a conversation's turns and a chain's steps
 * are all loaded by the screen that draws them and thrown away when it unmounts, because there is
 * exactly one of each on screen at a time and a phone gains nothing from caching what it can re-read
 * in a round trip.
 *
 * That leaves nowhere for the frame to land. Adding `reviewsEpoch` / `chatEpoch` counters to the
 * store would mean fields that hold no data and exist only to make a component re-render — every
 * subscriber of the store waking for a number none of them read. So these follow the same route
 * `terminal:output` already takes: a `CustomEvent` on `window`, which costs nothing when nobody is
 * listening and is picked up by the one screen that cares, if it is mounted at all.
 *
 * `chains` is announced here *as well as* driving `store.refreshChains`, and that is not a
 * duplication: the store owns the list, and the open chain's steps are owned by the screen showing
 * them. The list used to re-read the open chain on the store's behalf, which is what kept a chain
 * open across tab switches and left the Agents tab with no way back to its own list.
 *
 * The event is dispatched by the frame router in `App.tsx`, *after* it has dropped this device's own
 * echo — so a listener never has to think about origins.
 */

/** The payload `state:invalidate` carries, as the screens need it. */
export interface Invalidation {
  domain?: string;
  /** Which project the change was about, when the emitter named one. Both listening screens are
   *  scoped to a project, so a change in another one is not theirs to reload. */
  project?: string;
  /** Which conversation, for `chat`. A project holds dozens. */
  conversation?: string;
}

const EVENT = "codeflow:invalidate";

/** Announces one invalidation to whatever is mounted. Called only from the frame router. */
export function announceInvalidation(detail: Invalidation) {
  window.dispatchEvent(new CustomEvent<Invalidation>(EVENT, { detail }));
}

/**
 * Calls `listener` when `domain` goes stale for `projectId`, and returns the unsubscribe.
 *
 * Scoped to the project on purpose. A phone shows one at a time, and a review finished against
 * another repository is not a reason to re-read this screen — an invalidation carrying no project
 * at all is treated as "could be anyone's" and does reload, because the alternative is missing a
 * change the emitter simply did not scope.
 */
export function onInvalidate(
  domain: "reviews" | "chat" | "chains" | "repo",
  projectId: string | null,
  listener: (detail: Invalidation) => void,
): () => void {
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<Invalidation>).detail;
    if (detail.domain !== domain) return;
    if (detail.project && projectId && detail.project !== projectId) return;
    listener(detail);
  };
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}
