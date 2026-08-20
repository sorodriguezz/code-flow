import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { useT } from "../../state/languageStore";

/**
 * Copies a piece of text, and says so for a moment.
 *
 * The acknowledgement is the whole reason this is a component rather than an `onClick`. A clipboard
 * write is silent and instantaneous: without the tick, the only way to find out whether the click
 * landed is to go and paste somewhere, which people do, and then they click again in case.
 *
 * The timer is cleared on unmount because both callers live in panels that close — the reference
 * popover shuts on any press outside it, and a `setState` a second later on a component that is
 * gone is a warning in the console for a tick nobody can see.
 */
export function CopyButton({
  text,
  label,
  className,
  compact,
}: {
  text: string;
  /** Overrides the default "Copy". Used where the button names what it copies. */
  label?: string;
  className?: string;
  /** Icon only — for a button sitting inside a code block that has no room for a word. */
  compact?: boolean;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  const copy = () => {
    void navigator.clipboard.writeText(text);
    setCopied(true);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1400);
  };

  const title = copied ? t("dbml.convert.copied") : (label ?? t("dbml.convert.copy"));
  return (
    <button
      type="button"
      onClick={copy}
      title={title}
      aria-label={title}
      className={
        className ??
        `flex items-center gap-1 rounded-md border border-[var(--cf-border)] text-[10.5px] text-[var(--cf-text-muted)] transition-colors hover:text-[var(--cf-text)] ${
          compact ? "p-[3px]" : "px-1.5 py-[2px]"
        }`
      }
    >
      {copied ? <Check size={11} className="text-[var(--cf-success)]" /> : <Copy size={11} />}
      {!compact && (copied ? t("dbml.convert.copied") : (label ?? t("dbml.convert.copy")))}
    </button>
  );
}
