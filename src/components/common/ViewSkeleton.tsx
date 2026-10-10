import { Skeleton } from "./Skeleton";
import { useSettingsFrame } from "../../lib/useSettingsFrame";

/**
 * What a view looks like for the frame or two its code chunk takes to arrive.
 *
 * Every main view is a `React.lazy` boundary now (see `App`), which means there is a moment — only
 * ever the first time a view is opened, and only ever as long as reading an already-downloaded
 * file off local disk — where React has nothing to render. Left as `null` that reads as the app
 * having gone blank; a spinner reads as work being done, which it isn't. So it wears the same
 * shimmer the views already use for their own loading states (`SkeletonRows` in the graph, the
 * explorer's tree placeholders): the boundary is invisible because it looks like the thing the
 * view underneath would have shown a beat later anyway.
 *
 * Built out of the shared `Skeleton` on purpose, so there is exactly one shimmer keyframe in the
 * app and it stays right in both themes.
 */
export function ViewSkeleton() {
  return (
    <div className="flex h-full flex-col gap-3 p-3">
      {/* The strip every view opens with: a few controls above the content. */}
      <div className="flex shrink-0 items-center gap-2">
        <Skeleton className="h-6 w-28" />
        <Skeleton className="h-6 w-20" />
        <div className="flex-1" />
        <Skeleton className="h-6 w-16" />
      </div>
      <div className="flex min-h-0 flex-1 gap-3">
        {/* A tree/list rail on the left and content on the right — the shape the API, Remote,
            Agents, Stories and Editor views all share, so the chunk landing swaps content in
            place instead of moving something the eye had already settled on. */}
        <div className="hidden w-56 shrink-0 flex-col gap-2 sm:flex">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-4" style={{ width: `${60 + ((i * 17) % 35)}%` }} />
          ))}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          {Array.from({ length: 10 }).map((_, i) => (
            <Skeleton key={i} className="h-4" style={{ width: `${45 + ((i * 23) % 50)}%` }} />
          ))}
        </div>
      </div>
    </div>
  );
}

/** The settings panel's own geometry, down to the backdrop — the same frame `SettingsView` takes
 *  (`useSettingsFrame`), so the real panel replaces this without the box moving. */
export function SettingsSkeleton() {
  const frame = useSettingsFrame();
  return (
    <div className="fixed inset-0 z-50">
      <div aria-hidden data-tauri-drag-region className="cf-settings-scrim absolute inset-0" />
      <div style={frame} className="flex flex-col gap-3 overflow-hidden rounded-[14px] border border-[var(--cf-border)] bg-[var(--cf-surface)] p-5 shadow-[var(--cf-shadow-modal)]">
        <Skeleton className="h-5 w-40" />
        <div className="flex min-h-0 flex-1 gap-4">
          <div className="flex w-52 shrink-0 flex-col gap-2">
            {Array.from({ length: 9 }).map((_, i) => (
              <Skeleton key={i} className="h-4" style={{ width: `${55 + ((i * 19) % 40)}%` }} />
            ))}
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            {Array.from({ length: 12 }).map((_, i) => (
              <Skeleton key={i} className="h-4" style={{ width: `${40 + ((i * 29) % 55)}%` }} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * A lazily loaded dialog's stand-in, in the dialog's own place: its backdrop, its anchor (hanging
 * from the top, or centred) and a card of its width — and of its height, where the dialog has a
 * fixed one. Without `panelClass` it is the backdrop alone: for a centred dialog whose height follows
 * what it lists, a card of a guessed height would only trade the jump for a resize.
 *
 * The classes are each dialog's own, copied at the call site. They all used to load under one
 * narrow card hanging from the top, and the centred ones — the branch switcher, the shortcuts,
 * "Nuevo proyecto" — then appeared in the middle of the window.
 */
export function DialogSkeleton({ overlayClass, panelClass }: { overlayClass: string; panelClass?: string }) {
  return (
    <div className={`fixed inset-0 z-50 flex justify-center ${overlayClass}`}>
      {panelClass && (
        <div
          className={`flex flex-col gap-2 overflow-hidden rounded-[14px] border border-[var(--cf-border)] p-3 shadow-[var(--cf-shadow-modal)] ${panelClass}`}
        >
          <Skeleton className="h-7 w-full" />
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-5" style={{ width: `${50 + ((i * 21) % 45)}%` }} />
          ))}
        </div>
      )}
    </div>
  );
}

/** The command palette's stand-in — its `pt-[12vh]` and its 600 px. */
export function PaletteSkeleton() {
  return (
    <DialogSkeleton
      overlayClass="items-start bg-black/30 pt-[12vh]"
      panelClass="w-[600px] max-w-[calc(100vw-2rem)] bg-[var(--cf-surface-raised)]"
    />
  );
}

/**
 * The bottom dock's body — its list and its pane — while what it holds is being put on screen.
 *
 * The dock's first opening builds every terminal it holds (an xterm and a GPU renderer each) and
 * that is real work: done in the same frame as the opening, the click waited on it and the dock
 * arrived late and all at once (user report, 2026-10-10: "como que esperan que algo cargue"). Now
 * the dock opens straight away with this in it, and the contents land a frame later. The list keeps
 * the width the real list will have, so nothing moves when they do.
 */
export function DockBodySkeleton({ listWidth }: { listWidth: number }) {
  return (
    <div className="flex min-h-0 flex-1" aria-busy>
      <div className="flex shrink-0 flex-col gap-2 border-r border-[var(--cf-border)] p-3" style={{ width: listWidth }}>
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-4" style={{ width: `${55 + ((i * 19) % 35)}%` }} />
        ))}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2 p-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-3.5" style={{ width: `${35 + ((i * 29) % 45)}%` }} />
        ))}
      </div>
    </div>
  );
}

/** The whole dock, for the frame or two its code chunk may take the very first time — the sheet at
 *  the dock's own height, its title row, and `DockBodySkeleton` under it. */
export function DockSkeleton({ height, maximized, listWidth }: { height: number; maximized: boolean; listWidth: number }) {
  return (
    <div style={maximized ? { flex: "100 1 0%" } : { height }} className="cf-sheet cf-panel-in flex min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-[var(--cf-border)] px-3">
        <Skeleton className="h-3.5 w-36" />
      </div>
      <DockBodySkeleton listWidth={listWidth} />
    </div>
  );
}
