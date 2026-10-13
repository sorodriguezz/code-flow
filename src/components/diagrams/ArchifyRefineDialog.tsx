import { useRef, useState } from "react";
import { ChatModelPicker } from "../ai/ChatModelPicker";
import { AiSparkles } from "../common/AiGlyph";
import { buttonClass } from "../common/Button";
import type { ArchifyMode } from "../../lib/diagrams/archify/ir";
import { useDialog } from "../../lib/useFocusTrap";
import { useT } from "../../state/languageStore";

/**
 * "What should change?" — said over a diagram that is already on screen.
 *
 * It is easier to correct a drawing than to guess, up front, what to ask for: the first answer shows
 * what the repository really holds, and the second sentence — *add the payment step*, *follow only the
 * error path*, *drop the cache* — is usually obvious from it. The dialog offers a few of those, per type,
 * that fill the box rather than send it, so they can be finished in the user's own words.
 *
 * ⌘/Ctrl+Enter applies; Enter is a new line, since a change is often more than one sentence.
 */
export function ArchifyRefineDialog({
  mode,
  onSubmit,
  onClose,
}: {
  mode: ArchifyMode;
  onSubmit: (instruction: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const panel = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState("");
  useDialog(panel, true, onClose);

  const ready = value.trim().length > 0;
  const send = () => ready && onSubmit(value.trim());
  const ideas = [1, 2, 3, 4].map((n) => t(`archify.refine.example.${mode}.${n}` as never));
  const add = (idea: string) => {
    setValue((current) => (current.trim() ? `${current.trim()}. ${idea}` : idea));
    field.current?.focus();
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 p-4" onClick={onClose}>
      <div
        ref={panel}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className="cf-fade-in max-h-[calc(100vh-2rem)] w-[520px] max-w-[92vw] overflow-y-auto rounded-[14px] border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-5 shadow-[var(--cf-shadow-modal)]"
      >
        <div className="mb-3 flex items-start gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]">
            <AiSparkles size={15} />
          </span>
          <div className="min-w-0 flex-1 pt-0.5">
            <p className="text-[13.5px] font-medium leading-snug text-[var(--cf-text)]">{t("archify.refine.title")}</p>
            <p className="mt-0.5 text-[11.5px] leading-snug text-[var(--cf-text-muted)]">{t("archify.refine.hint")}</p>
          </div>
        </div>

        <textarea
          ref={field}
          autoFocus
          rows={3}
          value={value}
          spellCheck={false}
          placeholder={t("archify.refine.placeholder")}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              send();
            }
          }}
          className="w-full resize-none rounded-md border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-2.5 py-2 text-[13px] leading-snug text-[var(--cf-text)] outline-none transition-[border-color,box-shadow] duration-100 placeholder:text-[var(--cf-text-faint)] focus:border-[var(--cf-accent)] focus:shadow-[0_0_0_3px_color-mix(in_oklab,var(--cf-accent)_20%,transparent)]"
        />

        <p className="mb-1.5 mt-3.5 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--cf-text-faint)]">
          {t("archify.refine.ideas")}
        </p>
        <div className="flex flex-wrap gap-1.5">
          {ideas.map((idea) => (
            <button
              key={idea}
              type="button"
              onClick={() => add(idea)}
              className="rounded-full border border-[var(--cf-border)] bg-[var(--cf-surface)] px-2.5 py-1 text-left text-[11.5px] text-[var(--cf-text)] transition-colors hover:border-[var(--cf-accent)] hover:bg-[var(--cf-accent-soft)]"
            >
              {idea}
            </button>
          ))}
        </div>

        <div className="mt-5 flex items-center justify-between gap-2">
          <ChatModelPicker
            task="diagram"
            variant="tag"
            liveModel={null}
            chatActive={false}
            title={t("codemap.archify.modelHint")}
          />
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className={buttonClass({ variant: "ghost" })}>
              {t("common.cancel")}
            </button>
            <button type="button" onClick={send} disabled={!ready} className={buttonClass({ variant: "primary" })}>
              {t("archify.refine.submit")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
