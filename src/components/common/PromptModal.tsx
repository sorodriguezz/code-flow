import { useEffect, useRef, useState } from "react";
import { Pencil } from "lucide-react";
import { useFocusTrap } from "../../lib/useFocusTrap";
import { usePromptStore } from "../../state/promptStore";
import { useT } from "../../state/languageStore";

/**
 * The one-field dialog, `ConfirmModal`'s twin.
 *
 * Same layer, same shell, same two buttons in the same order — because the only difference between
 * "are you sure" and "call it what" is the field in the middle, and two dialogs that framed that
 * differently would be two dialogs to learn.
 *
 * **The validation shows before the submit, not after.** A rule the far side would answer with an
 * opaque code (`InvalidResourceName`) is a rule worth stating while there is still a cursor in the
 * field, so the message sits under the input and the confirm button stays out of reach until the
 * value satisfies it.
 */
export function PromptModal() {
  const panelRef = useRef<HTMLDivElement>(null);
  const request = usePromptStore((s) => s.request);
  const respond = usePromptStore((s) => s.respond);
  const t = useT();

  const [value, setValue] = useState("");
  const field = useRef<HTMLInputElement>(null);

  // Reset per request rather than per render: the store hands over a new object each time it is
  // asked, and the previous answer left in the box would be the wrong default for the next one.
  useEffect(() => {
    if (!request) return;
    setValue(request.initial);
    // Selected, not just focused — a rename opens on the old name and the first keystroke should
    // replace it, which is what every rename field anywhere does.
    const timer = window.setTimeout(() => field.current?.select(), 0);
    return () => window.clearTimeout(timer);
  }, [request]);

  // Above the early return, and it has to stay there. `useFocusTrap` is a hook, so calling it after
  // `if (!request) return null` makes the render that *opens* the dialog run one more hook than the
  // render before it — which React answers by throwing "Rendered more hooks than during the previous
  // render" and unwinding to the nearest boundary. The nearest one here is the app's outermost, so
  // the whole window is replaced by the fatal card: every rename, every "new folder", every prompt
  // in the app. `ConfirmModal` has the same pair in the right order; keep them matching.
  useFocusTrap(panelRef, request !== null);

  if (!request) return null;

  const trimmed = value.trim();
  const problem = trimmed ? (request.validate?.(trimmed) ?? null) : null;
  const ready = trimmed.length > 0 && !problem;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 p-4"
      onClick={() => respond(null)}
    >
      <div
        ref={panelRef}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className="cf-fade-in max-h-[calc(100vh-2rem)] w-[380px] max-w-[90vw] overflow-y-auto rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-4 shadow-[var(--cf-shadow)]"
      >
        <div className="mb-3 flex items-start gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]">
            <Pencil size={15} />
          </span>
          <p className="flex-1 pt-1 text-[13px] leading-snug text-[var(--cf-text)]">{request.message}</p>
        </div>

        <input
          ref={field}
          autoFocus
          value={value}
          spellCheck={false}
          placeholder={request.placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            // Handled on the field rather than on the window: a global Enter listener would also
            // fire for the confirm button's own activation, answering twice.
            if (e.key === "Enter" && ready) respond(trimmed);
            if (e.key === "Escape") respond(null);
          }}
          className="w-full rounded-md border border-[var(--cf-border)] bg-transparent px-2 py-1.5 font-mono text-[12px] outline-none focus:border-[var(--cf-accent)]"
        />
        {problem && (
          <p className="pt-1.5 text-[11px] leading-relaxed text-[var(--cf-danger)]">{problem}</p>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={() => respond(null)}
            className="rounded-md px-3 py-1.5 text-[12px] text-[var(--cf-text-muted)] hover:bg-black/[0.05] dark:hover:bg-white/[0.08]"
          >
            {t("common.cancel")}
          </button>
          <button
            onClick={() => ready && respond(trimmed)}
            disabled={!ready}
            className="rounded-md bg-[var(--cf-accent)] px-3 py-1.5 text-[12px] font-medium text-white hover:brightness-110 disabled:opacity-40 disabled:hover:brightness-100"
          >
            {request.confirmLabel ?? t("common.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
