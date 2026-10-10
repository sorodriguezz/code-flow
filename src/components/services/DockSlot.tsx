import { Suspense, useState, type ReactNode } from "react";
import { DockSkeleton } from "../common/ViewSkeleton";
import { useLayoutStore } from "../../state/layoutStore";
import { useTerminalStore } from "../../state/terminalStore";

/**
 * Where a window's bottom dock lives: mounted the first time it opens and never again unmounted —
 * the dock hides itself while closed (see `open` in `ServicesDock`), so opening it again shows what
 * is already built instead of building every terminal over.
 *
 * Until its code has arrived the first time it opens, its shape stands in (`DockSkeleton`): the
 * opening is answered at once, whatever is still loading behind it. `children` is the window's own
 * lazy `ServicesDock`.
 */
export function DockSlot({ children }: { children: ReactNode }) {
  const open = useTerminalStore((s) => s.panelOpen);
  const maximized = useTerminalStore((s) => s.dockMaximized);
  const height = useLayoutStore((s) => s.sizes.terminalPanelHeight);
  const listWidth = useLayoutStore((s) => s.sizes.servicesListWidth);
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);
  if (!mounted) return null;
  return (
    <Suspense
      key="terminal-dock"
      fallback={open ? <DockSkeleton height={height} maximized={maximized} listWidth={listWidth} /> : null}
    >
      {children}
    </Suspense>
  );
}
