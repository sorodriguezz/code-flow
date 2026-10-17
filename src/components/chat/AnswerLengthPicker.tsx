import { useEffect, useRef, useState } from "react";
import { AlignLeft, Check } from "lucide-react";
import type { TranslationKey } from "../../lib/i18n/translations";
import { useT } from "../../state/languageStore";
import { ANSWER_LENGTHS, useAnswerLengthStore, type AnswerLength } from "../../state/answerLengthStore";

const LABEL: Record<AnswerLength, TranslationKey> = {
  auto: "chat.length.auto",
  short: "chat.length.short",
  normal: "chat.length.normal",
  detailed: "chat.length.detailed",
};

const HINT: Record<AnswerLength, TranslationKey> = {
  auto: "chat.length.autoHint",
  short: "chat.length.shortHint",
  normal: "chat.length.normalHint",
  detailed: "chat.length.detailedHint",
};

/**
 * How long the answers are: short and precise, normal (nothing added), detailed (a full structure)
 * or automatic (a quick answer to a quick question). One setting for both chats, so the dial reads
 * the same wherever it is turned. Beside the reasoning dial, and like it says its word only when
 * something other than the default is chosen.
 */
export function AnswerLengthPicker({ compact = false, disabled }: { compact?: boolean; disabled?: boolean }) {
  const t = useT();
  const length = useAnswerLengthStore((s) => s.length);
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

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

  return (
    <div ref={boxRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((was) => !was)}
        title={t("chat.length.title")}
        aria-label={t("chat.length.title")}
        className={`flex ${compact ? "h-6 px-1.5 text-[11px]" : "h-[26px] px-2 text-[12px]"} items-center gap-1 rounded-md text-[var(--cf-text-muted)] transition-colors hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)] disabled:cursor-not-allowed disabled:opacity-40`}
      >
        <AlignLeft size={13} />
        {length !== "normal" && <span>{t(LABEL[length])}</span>}
      </button>

      {open && (
        <div className="absolute bottom-[calc(100%+6px)] left-0 z-30 w-[250px] overflow-hidden rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface)] py-1 shadow-[var(--cf-shadow)]">
          <p className="px-2.5 pb-1 pt-1 text-[10.5px] uppercase tracking-wide text-[var(--cf-text-muted)]">{t("chat.length.title")}</p>
          {ANSWER_LENGTHS.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => {
                setOpen(false);
                void useAnswerLengthStore.getState().pick(option);
              }}
              title={t(HINT[option])}
              className="flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left text-[12px] hover:bg-[var(--cf-surface-2)]"
            >
              <span className="min-w-0">
                <span className="block">{t(LABEL[option])}</span>
                <span className="block text-[10.5px] text-[var(--cf-text-muted)]">{t(HINT[option])}</span>
              </span>
              {length === option && <Check size={12} className="shrink-0 text-[var(--cf-accent)]" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
