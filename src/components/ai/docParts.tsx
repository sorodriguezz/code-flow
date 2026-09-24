import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Ban, Check, ChevronDown, GitMerge, History, ThumbsDown, ThumbsUp } from "lucide-react";
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

/** The sticky top of a document: what it is, and the one strip of state that matters now. */
export function DocHeader({ children }: { children: ReactNode }) {
  return (
    <div className="sticky top-0 z-10 space-y-1.5 border-b border-[var(--cf-border)] bg-[var(--cf-surface)] px-3 pb-2 pt-2.5">
      {children}
    </div>
  );
}

/** Findings · Comments · Summary. `counts` is omitted for a segment with nothing to count. */
export function SegmentBar({
  value,
  onChange,
  segments,
}: {
  value: DocSegment;
  onChange: (segment: DocSegment) => void;
  segments: { id: DocSegment; label: string; count?: number | null; busy?: boolean }[];
}) {
  return (
    <div role="tablist" className="flex gap-0.5 rounded-lg bg-black/[0.04] p-0.5 dark:bg-white/[0.05]">
      {segments.map((segment) => {
        const selected = segment.id === value;
        return (
          <button
            key={segment.id}
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(segment.id)}
            className={`flex min-w-0 flex-1 items-center justify-center gap-1 rounded-md px-2 py-1 text-[11.5px] font-medium ${
              selected
                ? "bg-[var(--cf-surface)] text-[var(--cf-text)] shadow-[0_1px_2px_rgba(0,0,0,0.08)]"
                : "text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
            }`}
          >
            <span className="truncate">{segment.label}</span>
            {segment.count !== undefined && segment.count !== null && (
              <span className="font-mono text-[10px] text-[var(--cf-text-muted)]">{segment.count}</span>
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
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={runs.length < 2}
        aria-haspopup="menu"
        aria-expanded={open}
        title={runs.length < 2 ? shown.detail : t("doc.pickRun")}
        className="flex items-center gap-1 rounded-md border border-[var(--cf-border)] px-1.5 py-0.5 text-[10.5px] font-medium text-[var(--cf-text-muted)] hover:text-[var(--cf-text)] disabled:cursor-default disabled:hover:text-[var(--cf-text-muted)]"
      >
        <History size={10} className="shrink-0" />
        {shown.label}
        {runs.length > 1 && <ChevronDown size={10} className="shrink-0" />}
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-30 mt-1 max-h-72 w-60 overflow-auto rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-1 shadow-[var(--cf-shadow)]"
        >
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
                className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
              >
                <span className="mt-0.5 w-3 shrink-0 text-[var(--cf-accent)]">{selected && <Check size={12} />}</span>
                <span className="min-w-0">
                  <span className="block text-[12px] text-[var(--cf-text)]">
                    {run.label}
                    {run.id === latestId && <span className="text-[var(--cf-text-muted)]"> · {t("doc.latest")}</span>}
                  </span>
                  <span className="block truncate text-[10.5px] text-[var(--cf-text-muted)]">{run.detail}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** The bottom of a document: the next step, and nothing that belongs to a different one. */
export function ActionBar({ children }: { children: ReactNode }) {
  return (
    <div className="@container relative shrink-0 border-t border-[var(--cf-border)] bg-[var(--cf-surface)] px-2.5 py-2">
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
    <div
      title={state.hint}
      className={`flex items-center justify-center gap-1.5 rounded-md border border-dashed border-[var(--cf-border)] px-2 py-1.5 text-[11.5px] font-medium ${state.tone}`}
    >
      <Icon size={12} className="shrink-0" />
      <span className="truncate">{state.label}</span>
    </div>
  );
}

/** The PR's state as a chip in the header: open, draft, merged, closed — and your own decision. */
export function PrStateChip({ status, decision }: { status: PullRequestSummary["status"]; decision: PrDecision }) {
  const t = useT();
  const chip =
    status === "merged"
      ? { label: t("pr.stateMerged"), cls: "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]" }
      : status === "closed"
        ? { label: t("pr.stateClosed"), cls: "bg-[color-mix(in_oklab,var(--cf-danger)_14%,transparent)] text-[var(--cf-danger)]" }
        : decision === "approved"
          ? { label: t("pr.stateApproved"), cls: "bg-[color-mix(in_oklab,var(--cf-success)_14%,transparent)] text-[var(--cf-success)]" }
          : decision === "changes_requested"
            ? { label: t("pr.stateChangesRequested"), cls: "bg-[color-mix(in_oklab,var(--cf-warning)_14%,transparent)] text-[var(--cf-warning)]" }
            : status === "draft"
              ? { label: t("doc.draft"), cls: "bg-black/[0.06] text-[var(--cf-text-muted)] dark:bg-white/[0.08]" }
              : { label: t("doc.open"), cls: "bg-black/[0.06] text-[var(--cf-text-muted)] dark:bg-white/[0.08]" };
  return (
    <span className={`inline-flex shrink-0 items-center rounded-full px-1.5 py-px text-[10px] font-semibold ${chip.cls}`}>
      {chip.label}
    </span>
  );
}

/** A small uppercase label for a group inside the document body. */
export function GroupLabel({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
      {children}
    </p>
  );
}
