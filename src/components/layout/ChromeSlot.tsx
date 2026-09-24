import { useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useUiStore, type MainView } from "../../state/uiStore";

/**
 * A place in the title row for a workspace app's own top-level controls — the Especificación mode
 * switch, for one. They are the level of the *app*, so they sit beside the app's name in the one
 * row that says where you are, instead of in a strip of their own under it.
 *
 * The title row registers the element (`setChromeSlot`); a view renders `<ChromeSlot view="…">`
 * wherever it likes. Views are never unmounted when hidden (see `MainContent`), so the portal only
 * opens while its own view is the active one — otherwise a hidden view would keep drawing into the
 * row of whichever app is on screen. A satellite window has no slot, and there the controls simply
 * render in place.
 */
let slot: HTMLElement | null = null;
const listeners = new Set<() => void>();

export function setChromeSlot(el: HTMLElement | null) {
  if (slot === el) return;
  slot = el;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function ChromeSlot({
  view,
  inPlace,
  children,
}: {
  view: MainView;
  /** How the controls are laid out when there is no title row to hold them — a satellite window,
   *  where they render inside the view instead, usually as a strip of their own. */
  inPlace?: (children: ReactNode) => ReactNode;
  children: ReactNode;
}) {
  const el = useSyncExternalStore(subscribe, () => slot);
  const activeView = useUiStore((s) => s.activeView);
  if (!el) return <>{inPlace ? inPlace(children) : children}</>;
  return activeView === view ? createPortal(children, el) : null;
}
