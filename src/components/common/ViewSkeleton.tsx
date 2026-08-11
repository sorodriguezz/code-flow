import { Skeleton } from "./Skeleton";

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

/** The settings panel's own geometry, down to the backdrop — the numbers are copied from
 *  `SettingsView` so the real panel replaces this without the box moving. */
export function SettingsSkeleton() {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20">
      <div className="flex h-[640px] max-h-[85vh] w-[1040px] max-w-[92vw] flex-col gap-3 overflow-hidden rounded-2xl border border-[var(--cf-border)] bg-[var(--cf-surface)] p-4 shadow-[var(--cf-shadow)]">
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
 * The shape the small keyboard-reachable dialogs share — command palette, branch switcher, PR
 * link, shortcuts: a dim backdrop with a narrow card hanging from the top. Same `pt-24`,
 * `bg-black/30` and raised surface those four use, so the card doesn't jump when the real one
 * takes its place.
 */
export function PaletteSkeleton() {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-24">
      <div className="flex w-[440px] max-w-[92vw] flex-col gap-2 overflow-hidden rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-3 shadow-[var(--cf-shadow)]">
        <Skeleton className="h-7 w-full" />
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-5" style={{ width: `${50 + ((i * 21) % 45)}%` }} />
        ))}
      </div>
    </div>
  );
}
