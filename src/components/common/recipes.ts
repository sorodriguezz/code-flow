/**
 * The shared class recipes of the "Trazo" redesign — one per kind of control, so a sub-app never
 * writes its own version of something the rest of the app already draws.
 *
 * Why strings and not components: most of these sit on elements whose structure is the call site's
 * own (a `<button>` with a context menu, a `<div role="tab">` that is also a drop target), and a
 * wrapper component would have to forward all of that. A class string composes with whatever the
 * element already is.
 *
 * Text sizes stay on the app's scale — 10.5 · 11 · 12 · 13 · 14 · 15 (17/18/26 for display) — with
 * 10.5px as the floor.
 *
 * Each recipe answers one level of the "what depends on what" question — the reason there is only
 * one of each:
 * - **document tab** (`docTabClass`): the open things of a surface — files, requests, queries,
 *   remote sessions. The active tab melts into the sheet below it.
 * - **underline tab** (`underlineTabClass` + `ActiveUnderline`): the sections of one document.
 * - **segmented** (`Segmented` / `segTrackClass` + `segItemClass`): two to four peer choices that
 *   change how the same thing is shown.
 */

/** A small status or label chip. 20px tall, 11px text — never below the 10.5px floor. */
export type ChipTone = "neutral" | "accent" | "ok" | "warn" | "bad" | "info";

const CHIP_TONES: Record<ChipTone, string> = {
  neutral: "bg-[var(--cf-hover)] text-[var(--cf-text-muted)] shadow-[inset_0_0_0_1px_var(--cf-border)]",
  accent:
    "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)] shadow-[inset_0_0_0_1px_var(--cf-accent-line)]",
  ok: "bg-[color-mix(in_oklab,var(--cf-success)_14%,transparent)] text-[var(--cf-success)]",
  warn: "bg-[color-mix(in_oklab,var(--cf-warning)_15%,transparent)] text-[var(--cf-warning)]",
  bad: "bg-[color-mix(in_oklab,var(--cf-danger)_13%,transparent)] text-[var(--cf-danger)]",
  info: "bg-[color-mix(in_oklab,var(--cf-blue)_14%,transparent)] text-[var(--cf-blue)]",
};

export function chipClass(tone: ChipTone = "neutral", className = ""): string {
  return `inline-flex h-5 shrink-0 items-center gap-[5px] whitespace-nowrap rounded-[5px] px-[7px] text-[11px] font-medium ${CHIP_TONES[tone]} ${className}`;
}

/**
 * A text field: 30px, the field fill, a hairline that turns accent with a soft 3px halo on focus.
 * `sm` is the 26px strip size for fields that share a toolbar with 26px icon buttons.
 */
export function fieldClass({ size = "md", className = "" }: { size?: "sm" | "md"; className?: string } = {}): string {
  return `${
    size === "sm" ? "h-[26px] text-[12px]" : "h-[30px] text-[13px]"
  } min-w-0 rounded-md border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-2.5 text-[var(--cf-text)] outline-none transition-[border-color,box-shadow] duration-100 placeholder:text-[var(--cf-text-faint)] focus:border-[var(--cf-accent)] focus:shadow-[0_0_0_3px_color-mix(in_oklab,var(--cf-accent)_20%,transparent)] disabled:opacity-50 ${className}`;
}

/**
 * The document tab: the open files of the editor, the requests of the API client, the queries of a
 * database, the sessions of Remoto. The active one takes the sheet's own colour so it reads as the
 * top of the page below it; the others sit on the strip, muted, and lift to a hover tint.
 *
 * It also wears a 2px accent rule along its top edge — a `::before`, so every strip gets it from here
 * without an element of its own. The sheet's colour alone left two open requests with the same name
 * nearly indistinguishable on a dark strip (user, 2026-09-26: "marca con una franja con el acento").
 * A strip with something more urgent to say draws its own rule over this one, later in the DOM (the
 * API client's conflict warning).
 *
 * The strip itself is `docStripClass` — the sunken tone with a bottom hairline the active tab
 * covers (`-mb-px` on the tab makes that work without a second border).
 */
export const docStripClass =
  "flex h-9 shrink-0 items-stretch overflow-x-auto border-b border-[var(--cf-border)] bg-[var(--cf-sunken)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden";

export function docTabClass(active: boolean, className = ""): string {
  return `group/doctab relative -mb-px flex min-w-0 max-w-[220px] shrink-0 items-center gap-1.5 border-r border-[var(--cf-border)] pl-3 pr-1.5 text-[13px] transition-colors duration-100 ${
    active
      ? "border-b border-b-[var(--cf-surface)] bg-[var(--cf-surface)] text-[var(--cf-text)] before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:h-[2px] before:bg-[var(--cf-accent)] before:content-['']"
      : "text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]"
  } ${className}`;
}

/**
 * Underlined section tabs: 36px strip, 13px medium labels 16px apart, the active one in full text
 * with a 2px accent rule (`ActiveUnderline`, so it slides between tabs) sitting on the hairline.
 */
export const underlineStripClass =
  "flex h-9 shrink-0 items-stretch gap-4 overflow-x-auto border-b border-[var(--cf-border)] px-3.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden";

export function underlineTabClass(active: boolean, className = ""): string {
  return `relative inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[13px] font-medium transition-colors duration-100 ${
    active ? "text-[var(--cf-text)]" : "text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
  } ${className}`;
}

/** The count that rides on an underline tab ("Headers 3"). */
export const tabCountClass =
  "rounded-full bg-[var(--cf-hover)] px-1.5 text-[11px] font-medium tabular-nums text-[var(--cf-text-muted)]";

/**
 * The segmented control's track and items, for call sites that need their own markup. When the
 * options are plain, use the `Segmented` component instead — it also slides the thumb.
 *
 * `full` stretches the control across its row, and the items share it in proportion to their words
 * (`flex-auto`), not in equal parts: equal thirds cut "Colecciones" off at an explorer's default
 * width while "Entornos" had room to spare. Squeezed below that, a label ends in an ellipsis rather
 * than being clipped.
 */
export function segTrackClass({ full = false, className = "" }: { full?: boolean; className?: string } = {}): string {
  return `${full ? "flex" : "inline-flex"} shrink-0 gap-0.5 rounded-lg bg-[var(--cf-hover)] p-0.5 shadow-[inset_0_0_0_1px_var(--cf-border)] ${className}`;
}

export function segItemClass(
  active: boolean,
  { size = "md", full = false, className = "" }: { size?: "sm" | "md"; full?: boolean; className?: string } = {},
): string {
  return `relative inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-colors duration-100 ${
    size === "sm" ? "h-[22px] px-2 text-[11px]" : "h-6 px-2.5 text-[12px]"
  } ${full ? "min-w-0 flex-auto" : ""} ${active ? "text-[var(--cf-text)]" : "text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"} ${className}`;
}

/**
 * A list row — one recipe for every explorer and picker; density comes from height only. Selected
 * rows take the accent tint; hover is the neutral tint.
 */
export function rowClass(selected: boolean, className = ""): string {
  return `relative flex w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-[13px] transition-colors duration-100 ${
    selected ? "bg-[var(--cf-accent-soft)] text-[var(--cf-text)]" : "text-[var(--cf-text)] hover:bg-[var(--cf-hover)]"
  } ${className}`;
}

/** The small uppercase heading over a group of rows ("PROYECTOS", "FIJADAS"). */
export const sectionLabelClass =
  "flex items-center gap-1.5 px-1.5 pb-1.5 pt-3 text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]";

/**
 * The anatomy every sub-app shares: an explorer on the left, the surface, and sometimes an
 * inspector on the right. The side panels sit a half-step into the sunken tone so the surface in
 * the middle reads as the page.
 */
export const explorerClass =
  "flex min-h-0 shrink-0 flex-col border-r border-[var(--cf-border)] bg-[color-mix(in_oklab,var(--cf-sunken)_55%,var(--cf-surface))]";
export const inspectorClass =
  "flex min-h-0 shrink-0 flex-col border-l border-[var(--cf-border)] bg-[color-mix(in_oklab,var(--cf-sunken)_55%,var(--cf-surface))]";
/** An explorer's head row: its title (14px semibold) and a few icon buttons. */
export const explorerHeadClass = "flex h-11 shrink-0 items-center gap-1 pl-3.5 pr-2";
export const explorerTitleClass = "flex min-w-0 items-center gap-2 text-[14px] font-semibold text-[var(--cf-text)]";
/** A surface's toolbar: 44px, a hairline under it. */
export const toolbarClass =
  "flex h-11 shrink-0 items-center gap-2 border-b border-[var(--cf-border)] pl-4 pr-3 min-w-0";

/** A popover or menu panel that is not the shared `ContextMenu`. */
export const popoverClass =
  "rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-[5px] shadow-[var(--cf-shadow)]";

/** A row inside such a popover. */
export function menuItemClass(active = false, className = ""): string {
  return `flex h-[30px] w-full items-center gap-2.5 rounded-md px-2.5 text-left text-[13px] text-[var(--cf-text)] transition-colors duration-100 disabled:pointer-events-none disabled:opacity-45 ${
    active ? "bg-[var(--cf-hover)]" : "hover:bg-[var(--cf-hover)]"
  } ${className}`;
}
