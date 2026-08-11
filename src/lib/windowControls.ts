import {
  getCurrentWindow,
  currentMonitor,
  PhysicalPosition,
  PhysicalSize,
  type Window,
} from "@tauri-apps/api/window";
import { getSetting } from "./tauri/commands";
import { isMac } from "./platform";

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
 * The windowed rectangle the *previous* session ended on, as `window_state.rs` wrote it down.
 *
 * Read straight out of settings rather than through a command of its own, because that row is one
 * value with one owner and this is the only thing on this side that wants to look at it. The shape
 * is `WindowState` in that module; a row from a future version that no longer parses is treated the
 * same as no row at all.
 */
async function lastSessionBounds(): Promise<Bounds | null> {
  const raw = await getSetting("window_state").catch(() => null);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const { x, y, width, height } = parsed as Partial<Bounds>;
    if (![x, y, width, height].every((n) => typeof n === "number" && Number.isFinite(n))) return null;
    if (width! <= 0 || height! <= 0) return null;
    return { x: x!, y: y!, width: width!, height: height! };
  } catch {
    return null;
  }
}

/**
 * What the window currently *is*, for the two controls in the title bar that have to say so.
 *
 * ## Why this is a store and not four `useEffect`s
 *
 * It used to be four independent subscriptions to `onResized`/`onMoved` — `isFullscreen()` for the
 * traffic-light spacer, `isMaximized()` for the maximize button, `isMaximized()` again for the
 * bounds tracker, and `outerPosition()` + `innerSize()` for the rectangle itself. tao emits those
 * events once per WM_MOVE/WM_SIZE, which while a window is being dragged with a high-polling mouse
 * is hundreds a second, and each subscription answered with its own async IPC round-trip. Five
 * round-trips per event, plus two `setState`s re-rendering the whole title bar.
 *
 * Now: one listener, coalesced to one batch per animation frame, published to whoever asked.
 */
export interface WindowStatus {
  maximized: boolean;
  fullscreen: boolean;
}

/** Replaced rather than mutated, and only when something actually changed, so a subscriber reading
 * it through `useSyncExternalStore` doesn't re-render on every frame of a drag. */
let status: WindowStatus = { maximized: false, fullscreen: false };
const statusListeners = new Set<() => void>();

export function getWindowStatus(): WindowStatus {
  return status;
}

/** Subscribing is also what starts the tracking, so a component that wants the state never has to
 * care whether `App` got there first. */
export function subscribeWindowStatus(listener: () => void): () => void {
  statusListeners.add(listener);
  void startWindowBoundsTracking();
  return () => {
    statusListeners.delete(listener);
  };
}

async function sampleStatus(win: Window): Promise<void> {
  const [maximized, fullscreen] = await Promise.all([
    win.isMaximized().catch(() => status.maximized),
    // macOS-only question: the only thing that reads it is the gap left for the traffic lights, and
    // no other platform has any. Asking regardless was one more IPC round-trip per event on the
    // platform that emits the most of them.
    isMac() ? win.isFullscreen().catch(() => status.fullscreen) : Promise.resolve(false),
  ]);
  if (maximized === status.maximized && fullscreen === status.fullscreen) return;
  status = { maximized, fullscreen };
  for (const listener of statusListeners) listener();
}

/** How long after the last move/resize the restore rectangle is written down. The rectangle only
 * has to be right when the drag *ends* — every intermediate one is overwritten microseconds later,
 * and reading it costs two IPC round-trips. */
const REMEMBER_DEBOUNCE_MS = 150;

let tracking: Promise<void> | null = null;

/**
 * Keeps `restoreBounds` up to date with the last size and position the window had while it was not
 * maximized, and `status` up to date with what the window is. Idempotent; called once from `App`,
 * and again by anything that subscribes.
 */
export function startWindowBoundsTracking(): Promise<void> {
  tracking ??= track();
  return tracking;
}

async function track(): Promise<void> {
  const win = getCurrentWindow();

  const remember = async () => {
    // The maximized rectangle is not a restore target, and whether the window is maximized is read
    // from the window rather than tracked, because a maximize can also arrive from the OS (snap,
    // double-click) with no moment of ours to hook. It stays a real read even though `status`
    // carries the answer: this runs debounced, once per settle rather than once per event, so the
    // round-trip costs nothing here — and refreshing the store from a path driven by `setTimeout`
    // is also what unsticks the button icon if `requestAnimationFrame` was suspended (minimized
    // window, occluded document) across the change.
    await sampleStatus(win);
    if (status.maximized) return;
    restoreBounds = await readBounds(win).catch(() => restoreBounds ?? null);
  };

  await sampleStatus(win);

  // Launched maximized, because that is how the app was left — see `window_state.rs`. `remember`
  // has nothing to record in that case: the only rectangle on offer is the screen. So the windowed
  // one is taken from where the last session ended, and the first press of the maximize button puts
  // the window back the size it was yesterday instead of at `centeredFallback`.
  if (status.maximized) {
    restoreBounds = await lastSessionBounds();
  }

  await remember();

  // One handler for both events. The status read is coalesced with `requestAnimationFrame` — the
  // button icon is a feedback indicator and must flip the moment the window changes, and a frame is
  // both the soonest anyone could see it and less than the IPC round-trip it replaces. The bounds
  // read trails on a timer instead: nobody is looking at it, and a suspended rAF (minimized window,
  // hidden document) must not be able to strand it, which is why it is a `setTimeout` and not a
  // second passenger on the frame.
  let frame = 0;
  let rememberTimer = 0;
  const onWindowEvent = () => {
    if (!frame) {
      frame = requestAnimationFrame(() => {
        frame = 0;
        void sampleStatus(win);
      });
    }
    clearTimeout(rememberTimer);
    rememberTimer = window.setTimeout(() => void remember(), REMEMBER_DEBOUNCE_MS);
  };

  await win.onResized(onWindowEvent);
  await win.onMoved(onWindowEvent);
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
