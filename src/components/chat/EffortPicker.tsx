import { Check } from "lucide-react";
import { AiBrain } from "../common/AiGlyph";
import { useEffect, useRef, useState } from "react";
import { CHAT_EFFORTS } from "../../lib/tauri/chatCommands";
import type { TranslationKey } from "../../lib/i18n/translations";
import { useT } from "../../state/languageStore";

/** The level → label mapping, kept next to the values so a fifth step cannot be added without
 *  someone noticing there is no word for it. `""` is the fifth *state*, not a fifth level. */
const LABEL: Record<string, TranslationKey> = {
  "": "chat.effortDefault",
  low: "chat.effortLow",
  medium: "chat.effortMedium",
  high: "chat.effortHigh",
  max: "chat.effortMax",
};

/**
 * How hard the model should think, per conversation.
 *
 * # Why this exists as a control at all
 *
 * All six CLIs take a reasoning level, and every one of them spells it differently — Claude has
 * `--effort`, Codex wants a `-c model_reasoning_effort` config override, opencode calls it a model
 * *variant*, Cline calls it `--thinking`, agy stops at `high`. The translation is each engine's
 * (`AiEngine::effort_args`); what reaches here is one four-step scale.
 *
 * # Why "default" is the first option and not a synonym for medium
 *
 * Choosing nothing sends no flag, which leaves whatever the user configured inside the CLI in
 * charge. That matters: someone with `model_reasoning_effort = "max"` in `~/.codex/config.toml` has
 * already answered this question, and an app that sent `medium` on every turn would overrule them
 * silently. So the empty string is a real, selectable state and the one a conversation starts in.
 *
 * # Why it is per conversation
 *
 * The level is a property of the question, not of the user. "Read this stack trace and tell me why
 * it happens" wants `max`; "what is the flag for X" should not pay for it. Pinning it globally
 * would mean the setting is always wrong for one of the two.
 *
 * # Why it is a prop and not a lookup
 *
 * `supported` arrives already decided, because the decision needs two things this component has no
 * business knowing: whether the CLI takes the flag at all, and whether the model it is pointed at
 * would read it. The second is the one that moves — opencode and cline drive whatever their
 * configured providers serve, so the same CLI can be aimed at a model that reasons and at one that
 * does not, and a dial over the second spends a flag nobody reads. See `ChatView`.
 *
 * # Why there is no footnote
 *
 * There was one: two sentences about higher levels costing more and each CLI having its own scale.
 * Both true, neither actionable — a menu of five words does not need a paragraph explaining that
 * the last one is the biggest, and the scale translation is the app's problem, not the reader's.
 * An absent control is honest, a dial that turns nothing is not, and a dial that turns something
 * needs no defence.
 */
export function EffortPicker({
  value,
  supported,
  disabled,
  onPick,
}: {
  /** The conversation's level, or `""` for the CLI's own default. */
  value: string;
  /** Whether this conversation's engine accepts a level. `false` renders nothing at all. */
  supported: boolean;
  disabled?: boolean;
  onPick: (effort: string) => void | Promise<void>;
}) {
  const t = useT();
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

  if (!supported) return null;

  const current = t(LABEL[value] ?? LABEL[""]);

  return (
    <div ref={boxRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((was) => !was)}
        title={t("chat.effortTitle")}
        className="flex h-[26px] items-center gap-1 rounded-md px-2 text-[12px] text-[var(--cf-text-muted)] transition-colors hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)] disabled:cursor-not-allowed disabled:opacity-40"
      >
        <AiBrain size={13} />
        {/* The word only when a level was actually chosen. An unchosen control that announces
            "Default" next to the model name is noise in the row that matters most. */}
        {value && <span>{current}</span>}
      </button>

      {open && (
        <div className="absolute bottom-[calc(100%+6px)] left-0 z-30 w-[220px] overflow-hidden rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface)] py-1 shadow-[var(--cf-shadow)]">
          <p className="px-2.5 pb-1 pt-1 text-[10.5px] uppercase tracking-wide text-[var(--cf-text-muted)]">
            {t("chat.effortTitle")}
          </p>
          {["", ...CHAT_EFFORTS].map((level) => (
            <button
              key={level || "default"}
              type="button"
              onClick={() => {
                setOpen(false);
                void onPick(level);
              }}
              className="flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left text-[12px] hover:bg-[var(--cf-surface-2)]"
            >
              <span>{t(LABEL[level])}</span>
              {value === level && <Check size={12} className="text-[var(--cf-accent)]" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
