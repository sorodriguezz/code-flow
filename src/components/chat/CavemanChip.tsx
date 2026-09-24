import { useEffect, useRef, useState } from "react";
import { SpellCheck } from "lucide-react";
import { useT } from "../../state/languageStore";
import type { TranslationKey } from "../../lib/i18n/translations";

/**
 * One line under each level, so the list is a choice rather than six words to try one at a time.
 *
 * Keyed by the level's own identifier, which is never translated — see `caveman::LEVELS`. A level
 * this build does not know has no key and simply shows its name, which is the right degradation:
 * the backend is the source of the list, so a newer backend can offer one this dictionary predates.
 */
const LEVEL_HINTS: Record<string, TranslationKey> = {
  lite: "chat.cavemanLite",
  full: "chat.cavemanFull",
  ultra: "chat.cavemanUltra",
  "wenyan-lite": "chat.cavemanWenyanLite",
  "wenyan-full": "chat.cavemanWenyanFull",
  "wenyan-ultra": "chat.cavemanWenyanUltra",
};

/**
 * The mark that this conversation's answers come back compressed.
 *
 * # Why it is only here when the mode is on
 *
 * Because an always-visible control would be a seventh thing in a row that already carries the
 * model, the reasoning dial, the capabilities panel, the context meter, the paperclip and send. The
 * mode is turned *on* from the `/` menu, which is where a feature like this is discovered and is
 * where the levels are explained; what the composer owes is the other half — saying so while it is
 * on, and getting out of it in one click.
 *
 * That asymmetry is deliberate and is the same one the editing banner above the composer has: a
 * state the user chose, announced while it lasts, invisible when it does not.
 *
 * # Why it says which level
 *
 * "caveman" alone would leave the difference between a tight professional answer and one written in
 * classical Chinese entirely invisible, on a chip whose whole job is to explain why the replies
 * stopped looking normal.
 */
export function CavemanChip({
  level,
  levels,
  onPick,
}: {
  /** The conversation's level. This component renders nothing for `""`. */
  level: string;
  /** What the backend accepts, in its order. Empty while the probe is in flight, which only means
   *  the menu has nothing to offer yet — the chip still shows the level and can still turn it off. */
  levels: string[];
  /** `""` turns it off. */
  onPick: (level: string) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!level) return null;

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={t("chat.cavemanOn", { level })}
        aria-expanded={open}
        className="flex h-[26px] shrink-0 items-center gap-1 rounded-md border border-[var(--cf-accent-line)] bg-[var(--cf-accent-soft)] px-2 text-[11px] text-[var(--cf-accent)]"
      >
        <SpellCheck size={11} className="shrink-0" />
        {level}
      </button>

      {open && (
        <div className="absolute bottom-9 left-0 z-30 w-[260px] rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-1.5 text-[12px] shadow-[var(--cf-shadow)]">
          {levels.map((candidate) => (
            <button
              key={candidate}
              type="button"
              onClick={() => {
                onPick(candidate);
                setOpen(false);
              }}
              className={`flex w-full flex-col items-start gap-0.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-[var(--cf-hover)] ${
                candidate === level ? "text-[var(--cf-accent)]" : "text-[var(--cf-text)]"
              }`}
            >
              {/* The identifier, unstyled and untranslated: it is what you type after the command,
                  so seeing it here is how `/caveman ultra` becomes something you can remember. */}
              <span className="text-[12px]">{candidate}</span>
              {LEVEL_HINTS[candidate] && (
                <span className="text-[10.5px] leading-snug text-[var(--cf-text-muted)]">
                  {t(LEVEL_HINTS[candidate])}
                </span>
              )}
            </button>
          ))}
          <div className="my-1 h-px bg-[var(--cf-border)]" />
          <button
            type="button"
            onClick={() => {
              onPick("");
              setOpen(false);
            }}
            className="w-full rounded-lg px-2 py-1.5 text-left text-[12px] text-[var(--cf-text-muted)] transition-colors hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]"
          >
            {t("chat.cavemanOff")}
          </button>
        </div>
      )}
    </div>
  );
}
