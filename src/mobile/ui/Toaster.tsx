import type { ReactNode } from "react";
import { CheckCircle2, Info, TriangleAlert, X } from "lucide-react";
import { useToasts, type Tone } from "../toast";
import { t } from "../i18n";

/**
 * Where the toasts are drawn.
 *
 * # Above the tab bar, not below the header
 *
 * The banner this replaces lived in the header — which is the far end of the screen from where the
 * thumb and the eye are, and the far end from the button that raised it. A commit failing at the
 * bottom of a long Repo screen put its explanation somewhere the user had scrolled past. These
 * stack upward from just above the tab bar, which is where the last tap was.
 *
 * # `role="status"`, and why the errors are `alert`
 *
 * A success is polite: it is announced when the screen reader finishes what it is saying. A failure
 * is assertive, because the thing it interrupts is very often the user starting the next action on
 * the assumption the last one worked.
 */

const TONE_STYLE: Record<Tone, { ring: string; icon: ReactNode }> = {
  success: {
    ring: "border-[var(--cf-success)]/35",
    icon: <CheckCircle2 size={16} className="shrink-0 text-[var(--cf-success-text)]" aria-hidden />,
  },
  error: {
    ring: "border-[var(--cf-danger)]/40",
    icon: <TriangleAlert size={16} className="shrink-0 text-[var(--cf-danger-text)]" aria-hidden />,
  },
  info: {
    ring: "border-[var(--cf-border)]",
    icon: <Info size={16} className="shrink-0 text-[var(--cf-accent-text)]" aria-hidden />,
  },
};

export function Toaster() {
  const toasts = useToasts((s) => s.toasts);
  const dismiss = useToasts((s) => s.dismiss);

  if (toasts.length === 0) return null;

  return (
    <div
      // Above the screen's own bottom bar when it has one — see `BottomBar`, which publishes its
      // height. Without the offset a failed commit's toast covered the composer it had failed from.
      style={{ bottom: "var(--cf-bottom-bar, 0px)" }}
      className="pointer-events-none absolute inset-x-0 z-50 flex flex-col gap-1.5 px-3 pb-2"
    >
      {toasts.map((toast) => {
        const style = TONE_STYLE[toast.tone];
        return (
          <div
            key={toast.id}
            role={toast.tone === "error" ? "alert" : "status"}
            aria-live={toast.tone === "error" ? "assertive" : "polite"}
            className={`cf-toast-in pointer-events-auto flex items-start gap-2.5 rounded-lg border ${style.ring} bg-[var(--cf-surface-raised)] px-3 py-2.5 shadow-raised`}
          >
            <span className="mt-0.5">{style.icon}</span>
            <div className="min-w-0 flex-1">
              <p className="text-base leading-snug">{toast.text}</p>
              {toast.detail && (
                <p className="cf-selectable mt-1 break-words font-mono text-2xs leading-snug text-[var(--cf-text-muted)]">
                  {toast.detail}
                </p>
              )}
            </div>
            <button
              type="button"
              aria-label={t("common.dismiss")}
              onClick={() => dismiss(toast.id)}
              // Not `cf-tap`: a 44px target here would be taller than the toast it closes and would
              // sit over the text. The toast dismisses itself on a timer regardless, so this is a
              // shortcut rather than the only way out.
              className="-mr-1 -mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--cf-text-faint)]"
            >
              <X size={14} aria-hidden />
            </button>
          </div>
        );
      })}
    </div>
  );
}
