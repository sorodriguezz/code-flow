import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Gauge, RefreshCw } from "lucide-react";
import { useT } from "../../state/languageStore";
import { formatUsed, severityOf, tightestLimit, useQuotaStore } from "../../state/quotaStore";
import { QuotaLimits } from "../ai/QuotaLimits";

const PANEL_WIDTH = 300;

/**
 * How far through each provider's plan you are, next to the bell.
 *
 * **Quota only.** Tokens and cost used to share this panel and no longer do — they live on the
 * Settings → AI screen, which is where a spend history belongs anyway. Two kinds of number in one
 * 300px panel meant working out which was which on every glance, and only one of them can run out.
 * What is left here is a single question with a single direction: how much of the window is gone.
 *
 * Nothing here is derived from what this app measured. The percentages come from the providers (see
 * `ai_quota.rs`); the moment a "% used" is computed from recorded tokens it becomes a guess wearing
 * a limit's clothes.
 *
 * **The pill shows the fullest limit.** One number in a status bar can only honestly be the worst
 * one; the panel is where "each limit" fits.
 *
 * **Quota is read on open, not on mount.** On macOS, reading Claude Code's token means reading
 * another application's keychain item, and that asks the user for permission the first time. That
 * prompt has to follow something they just did — which is also why the button renders before it has
 * a number to show.
 *
 * A provider that publishes no limit simply is not here. A row reading zero would be a claim, and
 * this has no way to make it.
 */
export function UsageMeter() {
  const t = useT();
  const quotaProviders = useQuotaStore((s) => s.providers);
  const quotaLoading = useQuotaStore((s) => s.loading);
  const refreshQuota = useQuotaStore((s) => s.refresh);
  const watchQuota = useQuotaStore((s) => s.watch);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ bottom: number; right: number; maxHeight: number } | null>(null);

  useEffect(() => watchQuota(), [watchQuota]);

  // Opening the panel is the deliberate action the first keychain prompt hangs off, and is also
  // simply when the numbers are wanted. Re-read on every open rather than once: the backend caches
  // for a minute, so reopening twice in a row costs one request between them.
  useEffect(() => {
    if (open) void refreshQuota("open");
  }, [open, refreshQuota]);

  const reposition = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    // Upward: this lives in a footer pinned to the bottom of the window, so there is never room
    // below it. Same reasoning — and the same numbers — as the notification panel beside it.
    setPos({
      bottom: window.innerHeight - rect.top + 6,
      right: Math.max(8, window.innerWidth - rect.right),
      maxHeight: Math.max(200, rect.top - 24),
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    reposition();
    const onScroll = () => reposition();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const tightest = tightestLimit(quotaProviders);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        aria-expanded={open}
        title={t("quota.title")}
        className={`flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] tabular-nums hover:bg-black/[0.05] dark:hover:bg-white/[0.08] ${
          open ? "text-[var(--cf-accent)]" : "text-[var(--cf-text-muted)]"
        }`}
      >
        {/* Always rendered, even before anything has been read — which is not the old behaviour and
            has to be, now that the pill is quota and nothing else. Quota is only fetched once the
            panel is opened (see above), so a button that waited for a number would be waiting on a
            click it is the only way to make. The bare gauge is the invitation. */}
        <Gauge size={12} className="shrink-0" />
        {tightest && (
          // The limit furthest through, coloured only once it is worth looking at. Which limit it
          // is stays out of the pill: it changes as windows roll over, and a label that flickers
          // between "week" and "session" is harder to read than the bare number the panel explains.
          <span
            className={
              severityOf(tightest.limit.used_percent) === "critical"
                ? "text-[#ef4444]"
                : severityOf(tightest.limit.used_percent) === "low"
                  ? "text-[#f59e0b]"
                  : undefined
            }
          >
            {formatUsed(tightest.limit.used_percent)}
          </span>
        )}
      </button>

      {open &&
        pos &&
        createPortal(
          <div
            ref={panelRef}
            style={{ bottom: pos.bottom, right: pos.right, width: PANEL_WIDTH, maxHeight: pos.maxHeight }}
            className="cf-fade-in fixed z-[60] flex flex-col overflow-hidden rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] shadow-[var(--cf-shadow)]"
          >
            <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--cf-border)] px-3 py-2">
              <Gauge size={13} className="shrink-0 text-[var(--cf-accent)]" />
              <span className="min-w-0 flex-1 truncate text-[12px] font-semibold">{t("quota.title")}</span>
              {/* `"refresh"` — bypasses the backend cache. Without it a press inside the cache
                  window returns the same numbers instantly, which reads as a dead button. */}
              <button
                type="button"
                onClick={() => void refreshQuota("refresh")}
                disabled={quotaLoading}
                title={t("quota.refresh")}
                aria-label={t("quota.refresh")}
                className="shrink-0 rounded p-0.5 text-[var(--cf-text-muted)] hover:bg-black/[0.05] hover:text-[var(--cf-text)] disabled:opacity-60 disabled:hover:bg-transparent dark:hover:bg-white/[0.08]"
              >
                <RefreshCw size={11} className={quotaLoading ? "animate-spin" : undefined} />
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
              <QuotaLimits compact />
            </div>

            {/* Where the other half went. Tokens and cost used to sit under this and no longer do:
                two kinds of number in one small panel meant reading which was which every time, and
                only one of them can run out. Spend is a screen's worth of material anyway. */}
            <p className="shrink-0 border-t border-[var(--cf-border)] px-3 py-2 text-[10.5px] leading-snug text-[var(--cf-text-muted)]">
              {t("quota.spendMovedHint")}
            </p>
          </div>,
          document.body,
        )}
    </>
  );
}
