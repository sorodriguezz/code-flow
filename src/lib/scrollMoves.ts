/**
 * Whether a `scroll` heard in the capture phase moved what a floating panel is pinned to — the
 * only scroll that should put the panel away.
 *
 * Menus, pickers and tooltips here are `position: fixed` at coordinates taken once, and they listen
 * for `scroll` on `window` in the capture phase because the scroller that matters is some panel's,
 * not the window's. But capture hears *every* scroller in the window, and some of them scroll on
 * their own: a chat following its answer moves its `scrollTop` on every token, a terminal on every
 * line of output. Closing on all of them meant that while a model was answering, a right-click menu
 * opened in the editor's tree vanished before it could be used, and no tooltip anywhere lived long
 * enough to appear.
 *
 * A scroll moves the panel's target only when the element that scrolled contains it. The document
 * contains everything, so a scroll of the page itself still counts.
 *
 * @param pinnedTo what the panel points at: its trigger, or the element under the press that opened
 *   it. `null` when there is nothing to point at, and then every scroll counts, as it always did.
 * @param inside the panel's own nodes. Scrolling its own list is using the panel, not leaving it.
 */
export function scrollMoves(
  event: Event,
  pinnedTo: Node | null | undefined,
  inside: ReadonlyArray<Node | null | undefined> = [],
): boolean {
  const target = event.target;
  if (!(target instanceof Node)) return true;
  if (inside.some((node) => node?.contains(target))) return false;
  return !pinnedTo || target.contains(pinnedTo);
}
