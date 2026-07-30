import {
  getCurrentWindow,
  currentMonitor,
  PhysicalPosition,
  PhysicalSize,
  type Window,
} from "@tauri-apps/api/window";

/**
 * Maximize and restore for the window this app draws its own title bar into.
 *
 * ## Why this isn't just `toggleMaximize()`
 *
 * On Windows the window is created with `decorations: false` (see `tauri.conf.json`) so the bar can
 * be ours. An undecorated Win32 window has no non-client frame, and restoring one does not reliably
 * put back the rectangle it had before — the report this fixes was exactly that: the window grew,
 * pressing the button again flipped the state back, and the window stayed the size of the screen.
 * From the outside it looks like the button stopped working; underneath, the maximize *did* undo
 * itself and nothing moved the window back.
 *
 * So the restore rectangle is ours to keep. Every maximize records where the window was first, and
 * restoring writes that back explicitly instead of asking the platform to remember.
 *
 * ## Why the tracker, and not just a capture in the toggle
 *
 * The button is not the only way to maximize: double-clicking the drag region does it, and so does
 * dragging the window to the top edge on Windows. Those never pass through here, so the bounds are
 * also tracked as the window is moved and resized — whatever the window last was while it wasn't
 * maximized is what "restore" means, however it got big.
 */

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Physical pixels throughout. Capturing and reapplying in the same unit the platform reports means
 * a window on a scaled display comes back the size it was, rather than the size it was times the
 * scale factor — the classic off-by-1.5 that lands a restored window half off screen.
 */
let restoreBounds: Bounds | null = null;

/** Fallback size when there is nothing to restore to, in logical pixels — the config's own. */
const DEFAULT_SIZE = { width: 1440, height: 900 };

async function readBounds(win: Window): Promise<Bounds> {
  const [position, size] = await Promise.all([win.outerPosition(), win.innerSize()]);
  return { x: position.x, y: position.y, width: size.width, height: size.height };
}

/**
 * Where to put a window with no history — the app was launched maximized, or the window was already
 * big when this module started tracking.
 *
 * Centred in the monitor's *work area* rather than its full size, so it doesn't sit under the
 * taskbar, and clamped to it so a default larger than the screen still lands fully on screen.
 */
async function centeredFallback(): Promise<Bounds> {
  const monitor = await currentMonitor();
  if (!monitor) {
    return { x: 0, y: 0, width: DEFAULT_SIZE.width, height: DEFAULT_SIZE.height };
  }
  const { position, size } = monitor.workArea;
  const width = Math.min(Math.round(DEFAULT_SIZE.width * monitor.scaleFactor), size.width);
  const height = Math.min(Math.round(DEFAULT_SIZE.height * monitor.scaleFactor), size.height);
  return {
    x: position.x + Math.round((size.width - width) / 2),
    y: position.y + Math.round((size.height - height) / 2),
    width,
    height,
  };
}

/**
 * Keeps `restoreBounds` up to date with the last size and position the window had while it was not
 * maximized. Idempotent; called once from `App`.
 */
export async function startWindowBoundsTracking(): Promise<void> {
  const win = getCurrentWindow();

  const remember = async () => {
    // The maximized rectangle is not a restore target. `isMaximized` is asked on every event rather
    // than tracked, because a maximize can also arrive from the OS (snap, double-click) with no
    // moment of ours to hook.
    if (await win.isMaximized().catch(() => false)) return;
    restoreBounds = await readBounds(win).catch(() => restoreBounds ?? null);
  };

  await remember();
  await win.onResized(() => void remember());
  await win.onMoved(() => void remember());
}

/**
 * What the maximize button does: grow to the screen, or put the window back exactly where it was.
 */
export async function toggleMaximize(): Promise<void> {
  const win = getCurrentWindow();
  if (await win.isMaximized()) {
    const target = restoreBounds ?? (await centeredFallback());
    await win.unmaximize();
    // Order matters: size first, then position. Setting the position of a window that is still the
    // size of the screen can have the platform clamp it back onto the monitor, which lands it in a
    // different place than the one asked for.
    await win.setSize(new PhysicalSize(target.width, target.height));
    await win.setPosition(new PhysicalPosition(target.x, target.y));
    return;
  }

  // Captured here as well as by the tracker: this is the one path where the bounds are known to be
  // current, with no event in flight to race against.
  restoreBounds = await readBounds(win).catch(() => restoreBounds ?? null);
  await win.maximize();
}
