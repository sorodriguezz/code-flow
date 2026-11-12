import { useEffect, useRef, useState } from "react";
import { Check, ShieldAlert, ShieldCheck } from "lucide-react";
import type { TranslationKey } from "../../lib/i18n/translations";
import type { ChatPermissions } from "../../lib/chatPermissions";
import { useT } from "../../state/languageStore";

const OPTIONS: ChatPermissions[] = ["restricted", "full"];

const LABEL: Record<ChatPermissions, TranslationKey> = {
  restricted: "assistant.permissions.restricted",
  full: "assistant.permissions.full",
};

const HINT: Record<ChatPermissions, TranslationKey> = {
  restricted: "assistant.permissions.restrictedHint",
  full: "assistant.permissions.fullHint",
};

/**
 * The composer's permissions, beside «Plan»: «Restringido» (the default — destructive commands, saved
 * credentials and destructive app actions wait for a yes) or «Completo» (the turn asks nothing). See
 * `lib/chatPermissions`. Each option says what it does, in its row and in its tooltip; the chip
 * names the choice and turns the warning colour on «Completo», so a turn that will not stop to ask
 * is never one the user forgot they chose.
 *
 * Plan mode is read-only whatever this says, so while it is on the chip is greyed out and its title
 * says why — the choice is kept for when plan mode is turned off.
 */
export function PermissionsPicker({
  value,
  onPick,
  planMode,
}: {
  value: ChatPermissions;
  onPick: (permissions: ChatPermissions) => void;
  planMode: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const full = value === "full";

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
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

  useEffect(() => {
    if (planMode) setOpen(false);
  }, [planMode]);

  const Icon = full ? ShieldAlert : ShieldCheck;
  const title = planMode
    ? t("assistant.permissions.planLocked")
    : `${t("assistant.permissions.title")}: ${t(LABEL[value])} — ${t(HINT[value])}`;

  return (
    <div ref={boxRef} className="relative shrink-0">
      <button
        type="button"
        disabled={planMode}
        onClick={() => setOpen((was) => !was)}
        title={title}
        aria-label={`${t("assistant.permissions.title")}: ${t(LABEL[value])}`}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
          full && !planMode
            ? "bg-[color-mix(in_oklab,var(--cf-warning)_14%,transparent)] text-[var(--cf-warning)]"
            : "text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]"
        }`}
      >
        <Icon size={13} />
        {/* The label gives way when the panel is narrow, like «Plan»'s: the icon and title stay. */}
        <span className="hidden @[26rem]:inline">{t(LABEL[value])}</span>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute bottom-[calc(100%+6px)] left-0 z-30 w-[280px] overflow-hidden rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface)] py-1 shadow-[var(--cf-shadow)]"
        >
          <p className="px-2.5 pb-1 pt-1 text-[10.5px] uppercase tracking-wide text-[var(--cf-text-muted)]">{t("assistant.permissions.title")}</p>
          {OPTIONS.map((option) => {
            const OptionIcon = option === "full" ? ShieldAlert : ShieldCheck;
            return (
              <button
                key={option}
                type="button"
                role="menuitemradio"
                aria-checked={value === option}
                onClick={() => {
                  setOpen(false);
                  onPick(option);
                }}
                title={t(HINT[option])}
                className="flex w-full items-start justify-between gap-2 px-2.5 py-1.5 text-left text-[12px] hover:bg-[var(--cf-surface-2)]"
              >
                <OptionIcon
                  size={13}
                  className={`mt-0.5 shrink-0 ${option === "full" ? "text-[var(--cf-warning)]" : "text-[var(--cf-text-muted)]"}`}
                />
                <span className="min-w-0 flex-1">
                  <span className="block">{t(LABEL[option])}</span>
                  <span className="block text-[10.5px] leading-snug text-[var(--cf-text-muted)]">{t(HINT[option])}</span>
                </span>
                {value === option && <Check size={12} className="mt-0.5 shrink-0 text-[var(--cf-accent)]" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
