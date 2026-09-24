import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Ban, Check, ChevronDown, GitMerge, History, ThumbsDown, ThumbsUp } from "lucide-react";
import { ActiveUnderline } from "../common/ActivePill";
import {
  chipClass,
  popoverClass,
  tabCountClass,
  underlineStripClass,
  underlineTabClass,
  type ChipTone,
} from "../common/recipes";
import type { TranslationKey } from "../../lib/i18n/translations";
import { useT } from "../../state/languageStore";
import type { DocSegment } from "../../state/aiPanelStore";
import type { PrDecision, PullRequestSummary } from "../../types/domain";

/**
 * The pieces a findings document is built from — a pull request's review and a change analysis
 * alike. One vocabulary for both, so the two read as the same kind of page: a header that stays put,
 * a strip saying what state the thing is in, one scroll, and a bar at the bottom that offers only
 * what the current step allows.
 */

export type Translate = (key: TranslationKey, vars?: Record<string, string | number>) => string;

export function relativeTime(ts: number, t: Translate): string {
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return t("ai.justNow");
  if (mins < 60) return t("ai.minutesAgo", { n: mins });
  const hours = Math.round(mins / 60);
  if (hours < 24) return t("ai.hoursAgo", { n: hours });
  return t("ai.daysAgo", { n: Math.round(hours / 24) });
}

/** Copies `text`, flashing a checkmark for a moment. */
export function useCopy(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const copy = (text: string) => {
    void navigator.clipboard.writeText(text).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return [copied, copy];
}

/** Closes a popover on a click outside `ref` or on Escape. */
export function useDismiss(ref: RefObject<HTMLElement | null>, open: boolean, onClose: () => void): void {
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [ref, open, onClose]);
}

/** The width of an element, kept current — what decides the document's two-column layout. */
export function useElementWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

/** From this width on, a document shows its findings as a list beside the one being read. */
export const SPLIT_MIN_WIDTH = 620;

/**
 * The sticky top of a document: what it is, and the one strip of state that matters now.
 *
 * `tabs` is the document's section strip, drawn edge to edge under the rest. Its hairline is then
 * the header's bottom edge — the header draws its own only when there is no strip, so the two never
 * stack into a double rule.
 */
export function DocHeader({ children, tabs }: { children: ReactNode; tabs?: ReactNode }) {
  return (
    <div className={`sticky top-0 z-10 bg-[var(--cf-surface)] ${tabs ? "" : "border-b border-[var(--cf-border)]"}`}>
      <div className={`space-y-2 px-3.5 pt-3 ${tabs ? "pb-1.5" : "pb-3"}`}>{children}</div>
      {tabs}
    </div>
  );
}

/**
 * Findings · Comments · Summary — the sections of one document, so the underlined tabs rather than
 * a segmented control. `count` is omitted for a segment with nothing to count.
 *
 * `layoutId` is the underline's and must be unique per document: several reviews stay mounted
 * (hidden) behind the one on screen, and a shared id would send the rule flying from a hidden one
 * to the visible one on every switch.
 */
export function SegmentBar({
  value,
  onChange,
  segments,
  layoutId,
}: {
  value: DocSegment;
  onChange: (segment: DocSegment) => void;
  segments: { id: DocSegment; label: string; count?: number | null; busy?: boolean }[];
  layoutId: string;
}) {
  return (
    <div role="tablist" className={underlineStripClass}>
      {segments.map((segment) => {
        const selected = segment.id === value;
        return (
          <button
            key={segment.id}
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(segment.id)}
            className={underlineTabClass(selected, "min-w-0")}
          >
            {selected && <ActiveUnderline layoutId={layoutId} />}
            <span className="truncate">{segment.label}</span>
            {segment.count !== undefined && segment.count !== null && (
              <span className={tabCountClass}>{segment.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export interface RunChoice {
  id: string;
  /** "Review 3", "14:05"… — what the run is called in the menu and on the button. */
  label: string;
  detail: string;
}

/** The run a document is showing, and every earlier one — each readable, none of them lost. */
export function RunMenu({
  runs,
  current,
  latestId,
  onPick,
}: {
  runs: RunChoice[];
  current: string | null;
  latestId: string | null;
  onPick: (runId: string | null) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => setOpen(false));
  const shown = runs.find((run) => run.id === current) ?? runs.find((run) => run.id === latestId) ?? null;
  if (!shown) return null;
  return (
    <div ref={ref} className="relative ml-auto shrink-0">
      {/* The ghost button's shape, spelled out rather than taken from `buttonClass`: with a single
          run this stays a (disabled) label that still carries its tooltip, and the recipe's
          disabled state would dim it and switch its pointer events off. */}
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={runs.length < 2}
        aria-haspopup="menu"
        aria-expanded={open}
        title={runs.length < 2 ? shown.detail : t("doc.pickRun")}
        className={`inline-flex h-6 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium transition-colors duration-100 disabled:cursor-default ${
          open
            ? "bg-[var(--cf-press)] text-[var(--cf-text)]"
            : "text-[var(--cf-text-muted)] enabled:hover:bg-[var(--cf-hover)] enabled:hover:text-[var(--cf-text)]"
        }`}
      >
        <History size={13} className="shrink-0" />
        {shown.label}
        {runs.length > 1 && <ChevronDown size={12} className="shrink-0" />}
      </button>
      {open && (
        <div role="menu" className={`absolute right-0 top-full z-30 mt-1 max-h-72 w-60 overflow-auto ${popoverClass}`}>
          {runs.map((run) => {
            const selected = run.id === shown.id;
            return (
              <button
                key={run.id}
                role="menuitemradio"
                aria-checked={selected}
                onClick={() => {
                  onPick(run.id === latestId ? null : run.id);
                  setOpen(false);
                }}
                className={menuRowClass(selected)}
              >
                <span className="mt-0.5 w-3.5 shrink-0 text-[var(--cf-accent)]">{selected && <Check size={14} />}</span>
                <span className="min-w-0">
                  <span className="block text-[13px] text-[var(--cf-text)]">
                    {run.label}
                    {run.id === latestId && <span className="text-[var(--cf-text-muted)]"> · {t("doc.latest")}</span>}
                  </span>
                  <span className="block truncate text-[11px] text-[var(--cf-text-muted)]">{run.detail}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * A two-line row in one of the assistant's own popovers — `menuItemClass`'s states, with room for
 * the detail line under the label that the recipe's fixed 30px has not.
 */
export function menuRowClass(active = false, className = ""): string {
  return `flex w-full items-start gap-2.5 rounded-md px-2.5 py-[7px] text-left text-[13px] text-[var(--cf-text)] transition-colors duration-100 disabled:pointer-events-none disabled:opacity-45 ${
    active ? "bg-[var(--cf-hover)]" : "hover:bg-[var(--cf-hover)]"
  } ${className}`;
}

/**
 * A multi-line field: `fieldClass`'s fill, hairline and accent ring on focus, at the height its
 * `rows` give it — the recipe itself is a fixed 30px, which a paragraph does not fit in.
 */
export const textAreaClass =
  "w-full resize-y rounded-md border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-2.5 py-1.5 text-[12px] leading-relaxed text-[var(--cf-text)] outline-none transition-[border-color,box-shadow] duration-100 placeholder:text-[var(--cf-text-faint)] focus:border-[var(--cf-accent)] focus:shadow-[0_0_0_3px_color-mix(in_oklab,var(--cf-accent)_20%,transparent)] disabled:opacity-50";

/**
 * The bottom of a document: the next step, and nothing that belongs to a different one.
 *
 * Every step lays it out the same way — what qualifies the step on the left, the step's primary
 * action at the right edge, always. It used to be five layouts with the primary in three different
 * places (full width under a selector, mid-row, at the end), so the hand had to look for it again
 * after every step.
 */
export function ActionBar({ children }: { children: ReactNode }) {
  return (
    <div className="@container relative shrink-0 border-t border-[var(--cf-border)] bg-[var(--cf-surface)] px-3 py-2.5">
      {children}
    </div>
  );
}

/** Static tone classes, spelled out so Tailwind generates them. */
const STATE_TONES = {
  accent: "text-[var(--cf-accent)]",
  success: "text-[var(--cf-success)]",
  warning: "text-[var(--cf-warning)]",
  danger: "text-[var(--cf-danger)]",
} as const;

/**
 * What a pull request has settled into, shown in place of the decision it no longer takes: merged
 * or closed (nothing left to decide, for anyone), or approved by this user (they already decided).
 * A statement rather than a disabled button row — greyed-out buttons say "broken", a chip says "done".
 */
export function PrDecisionState({ status, decision }: { status: PullRequestSummary["status"]; decision: PrDecision }) {
  const t = useT();
  const state =
    status === "merged"
      ? { icon: GitMerge, tone: STATE_TONES.accent, label: t("pr.stateMerged"), hint: t("pr.stateLockedHint") }
      : status === "closed"
        ? { icon: Ban, tone: STATE_TONES.danger, label: t("pr.stateClosed"), hint: t("pr.stateLockedHint") }
        : decision === "approved"
          ? { icon: ThumbsUp, tone: STATE_TONES.success, label: t("pr.stateApproved"), hint: t("pr.stateApprovedHint") }
          : {
              icon: ThumbsDown,
              tone: STATE_TONES.warning,
              label: t("pr.stateChangesRequested"),
              hint: t("pr.stateChangesRequestedHint"),
            };
  const Icon = state.icon;
  return (
    // Sized like the button it stands in for, so settling a PR does not move the bar's right edge.
    <div
      title={state.hint}
      className={`inline-flex h-7 min-w-0 max-w-full shrink-0 items-center gap-1.5 rounded-md border border-dashed border-[var(--cf-border-strong)] px-2.5 text-[12px] font-medium ${state.tone}`}
    >
      <Icon size={13} className="shrink-0" />
      <span className="truncate">{state.label}</span>
    </div>
  );
}

/** The PR's state as a chip in the header: open, draft, merged, closed — and your own decision. */
export function PrStateChip({ status, decision }: { status: PullRequestSummary["status"]; decision: PrDecision }) {
  const t = useT();
  const chip: { label: string; tone: ChipTone } =
    status === "merged"
      ? { label: t("pr.stateMerged"), tone: "accent" }
      : status === "closed"
        ? { label: t("pr.stateClosed"), tone: "bad" }
        : decision === "approved"
          ? { label: t("pr.stateApproved"), tone: "ok" }
          : decision === "changes_requested"
            ? { label: t("pr.stateChangesRequested"), tone: "warn" }
            : status === "draft"
              ? { label: t("doc.draft"), tone: "neutral" }
              : { label: t("doc.open"), tone: "ok" };
  return <span className={chipClass(chip.tone)}>{chip.label}</span>;
}

/** A small uppercase label for a group inside the document body — the section label's type. */
export function GroupLabel({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]">
      {children}
    </p>
  );
}
