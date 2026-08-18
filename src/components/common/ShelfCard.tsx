import { Fragment } from "react";
import { ChevronRight, type LucideIcon } from "lucide-react";

/**
 * The card, and the row, for **a container you can open**.
 *
 * Notes calls them books and Diagrams calls them folders, but the thing being drawn is the same
 * thing in both: a tinted glyph, a name, a chevron that leans toward the click, and a foot of
 * small print about what is inside. That is why this is neither `BookCard` nor `FolderCard` — a
 * name from either workspace would have made the other one look like a borrower.
 *
 * # Why one component and not one per workspace
 *
 * The obvious move was to copy `BookCard` next to the Diagrams gallery and adjust it, and it is
 * the move this file exists to prevent. Two definitions of the same card is exactly how one ends
 * up `min-h-[92px]` and the other `min-h-[88px]`, one gets the hover chevron and the other keeps
 * a static one, and the two workspaces stop looking like two rooms of the same app — the argument
 * `diagramsChrome` already makes about rows and tints, and the one the Diagrams header carries
 * about its own toolbar. A shelf card is the third thing that has to agree, and copying it would
 * have been the third time we hoped it would.
 *
 * # Why `meta` is an array of strings and not fields
 *
 * The one real difference between the two uses is the *content* of the foot, not its shape: Notes
 * prints a note count, Diagrams prints a diagram count and how long ago something inside it was
 * touched. Modelling that as `count?: number; time?: string` would push both workspaces' wording
 * and both formatters in here, and the next caller with a third kind of fact would add a third
 * optional field. Pre-translated pieces keep the decision of *what to say* with the view that
 * knows, and leave this file with the decision of *how it looks* — which is the only thing it is
 * for.
 *
 * # Why neither of these is memoised
 *
 * `BookCard` was `memo`'d before it moved here, and that wrapper never once hit: the parent builds
 * a fresh `onOpen` closure inside `.map()` on every render, so the shallow compare fails every
 * time and all the wrapper buys is the cost of failing it — plus the false comfort that the card
 * is cheap. Making it real would mean the `DiagramTreeRow` pattern (stable callbacks plus the id
 * as an argument), and a shelf level is four or five rows that paint no bitmap and ask for no
 * `content-visibility`. The machinery would cost more to read than it saves.
 */

/** The props both of them take — one interface, because a card and its row are one thing at two
 *  densities, and a prop that exists on only one of them is how they start to disagree. */
interface ShelfItemProps {
  /** `Book` in Notes, `Folder` in Diagrams. */
  icon: LucideIcon;
  name: string;
  /** Already resolved to ink by `bookInk`/`folderInk` — this component picks no colours. */
  tint: string;
  /** The pieces of the foot, already translated and in order. Empty ones are dropped. */
  meta: string[];
  /** The button's accessible name: "Open the book X" / "Open the folder X". */
  label: string;
  onOpen: () => void;
}

export function ShelfCard({ icon: Icon, name, tint, meta, label, onOpen }: ShelfItemProps) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={label}
      className="group flex min-h-[92px] cursor-pointer flex-col justify-between gap-3 rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface)] p-3 text-left transition-colors hover:border-[var(--cf-accent)]"
    >
      {/* A `<span>` around a `<span>` where this used to be a `<div>` around an `<h3>`, and not for
          tidiness: a `<button>` may only contain phrasing content, so the old nesting was invalid
          — browsers repaired it silently and it worked, right up until something read the DOM. The
          heading was carrying nothing either, because the button announces itself through
          `aria-label` and the name inside it is never the thing a screen reader reaches for. As a
          flex item a span blockifies exactly as the h3 did, so not a pixel moves. */}
      <span className="flex items-start gap-2">
        <Icon size={15} className="mt-px shrink-0" style={tint ? { color: tint } : undefined} />
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-[var(--cf-text)]">
          {name}
        </span>
        <ChevronRight
          size={13}
          className="mt-px shrink-0 text-[var(--cf-text-muted)] transition-transform group-hover:translate-x-0.5"
          aria-hidden
        />
      </span>
      <Meta
        parts={meta}
        className="flex items-center gap-2 text-[10.5px] tabular-nums text-[var(--cf-text-muted)]"
      />
    </button>
  );
}

export function ShelfRow({ icon: Icon, name, tint, meta, label, onOpen }: ShelfItemProps) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={label}
      className="group flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
    >
      <Icon size={14} className="shrink-0" style={tint ? { color: tint } : undefined} />
      <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-[var(--cf-text)]">
        {name}
      </span>
      <Meta
        parts={meta}
        className="flex shrink-0 items-center gap-2 text-[10.5px] tabular-nums text-[var(--cf-text-muted)]"
      />
      <ChevronRight
        size={13}
        className="shrink-0 text-[var(--cf-text-muted)] transition-transform group-hover:translate-x-0.5"
        aria-hidden
      />
    </button>
  );
}

/**
 * The foot: the pieces that survive, with separators put *between* them.
 *
 * Two things here are load-bearing and neither looks it.
 *
 * **The wrapper is drawn even when nothing survives.** That is what `BookCard` did when it wrote
 * `{count > 0 ? countLabel : ""}` into a span it always rendered, and it is not an accident of how
 * it was written: the card is `justify-between` with exactly two children, so dropping the empty
 * foot leaves the layout one child to distribute and the title stops sitting where it sits on
 * every other card. An empty flex item is zero pixels tall — the card keeps its `min-h-[92px]`
 * and nothing shifts — which is the cheapest way to keep an empty shelf card and a full one the
 * same card.
 *
 * **The pieces are filtered before the separators are placed, not after.** A missing piece is the
 * normal case, not the corner: the count hides itself at zero, and `relativeTime` returns `""` for
 * a timestamp it cannot parse. Interleaving first and filtering after — or hanging a `·` off the
 * front of each piece — leaves a separator dangling with nothing on one side of it, which reads as
 * a rendering bug on precisely the cards that have the least to say.
 */
function Meta({ parts, className }: { parts: string[]; className: string }) {
  const shown = parts.filter(Boolean);
  return (
    <span className={className}>
      {shown.map((part, index) => (
        <Fragment key={index}>
          {index > 0 && <span aria-hidden>·</span>}
          <span>{part}</span>
        </Fragment>
      ))}
    </span>
  );
}
