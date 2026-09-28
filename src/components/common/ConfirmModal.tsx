import { useEffect, useId, useRef } from "react";
import { CircleHelp, TriangleAlert } from "lucide-react";
import { useFocusTrap } from "../../lib/useFocusTrap";
import { useConfirmStore } from "../../state/confirmStore";
import { useT } from "../../state/languageStore";
import { ConfirmFlowDiagram } from "./ConfirmFlowDiagram";
import { buttonClass } from "./Button";
import { confirmKeyAction, focusPlace } from "./dialogKeys";

export function ConfirmModal() {
  const panelRef = useRef<HTMLDivElement>(null);
  const request = useConfirmStore((s) => s.request);
  const respond = useConfirmStore((s) => s.respond);
  const pick = useConfirmStore((s) => s.pick);
  const t = useT();
  const messageId = useId();

  useEffect(() => {
    if (!request) return;
    // Enter belongs to the focused control; only with nothing interactive focused does it give the
    // dialog's default answer (the first choice, or "confirm"). It used to confirm from here no
    // matter what was focused — Tab to Cancel, Enter, and the branch was deleted. See `dialogKeys`.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      const action = confirmKeyAction(
        e.key,
        focusPlace(panelRef.current, document.activeElement),
        request.choices,
      );
      switch (action.kind) {
        case "cancel":
          e.preventDefault();
          respond(false);
          break;
        case "confirm":
          e.preventDefault();
          respond(true);
          break;
        case "pick":
          e.preventDefault();
          pick(action.id);
          break;
        case "block":
          e.preventDefault();
          break;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [request, respond, pick]);

  useFocusTrap(panelRef, request !== null);

  if (!request) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 p-4" onClick={() => respond(false)}>
      <div
        ref={panelRef}
        onClick={(e) => e.stopPropagation()}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={messageId}
        tabIndex={-1}
        // Wider with a diagram than without: the two branch pills split the width between them,
        // so each one only ever gets half of it — and a name that wraps to three lines in a pill
        // is harder to read than the same name on one. Wider with several answers too, so their
        // buttons sit on one row.
        className={`cf-fade-in max-h-[calc(100vh-2rem)] max-w-[90vw] overflow-y-auto rounded-[14px] border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-5 shadow-[var(--cf-shadow-modal)] ${
          request.flow ? "w-[560px]" : request.choices ? "w-[480px]" : "w-[380px]"
        }`}
      >
        <div className="mb-4 flex items-start gap-3">
          <span
            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
              request.danger
                ? "bg-[color-mix(in_oklab,var(--cf-danger)_16%,transparent)] text-[var(--cf-danger)]"
                : "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
            }`}
          >
            {request.danger ? <TriangleAlert size={16} /> : <CircleHelp size={16} />}
          </span>
          <p id={messageId} className="flex-1 pt-1 text-[13px] leading-snug text-[var(--cf-text)]">
            {request.message}
          </p>
        </div>

        {request.items && request.items.length > 0 && (
          <ul className="mb-4 max-h-40 overflow-y-auto rounded-md border border-[var(--cf-border)] bg-[var(--cf-sunken)] px-3 py-2 font-mono text-[12px] leading-relaxed text-[var(--cf-text-muted)]">
            {request.items.map((item, i) => (
              <li key={`${item}-${i}`} className="truncate" title={item}>
                {item}
              </li>
            ))}
          </ul>
        )}

        {request.flow && <ConfirmFlowDiagram flow={request.flow} />}
        <div className="flex flex-wrap justify-end gap-2">
          {/* A destructive yes/no question opens on Cancel, so the Enter pressed out of habit keeps
              what the dialog was about to destroy. The many-answer form opens on its first choice,
              which `chooseAction`'s contract makes the one that loses nothing. */}
          <button
            onClick={() => respond(false)}
            autoFocus={request.danger && !request.choices}
            className={buttonClass({ variant: "ghost" })}
          >
            {t("common.cancel")}
          </button>
          {request.choices ? (
            request.choices.map((choice, i) => (
              <button
                key={choice.id}
                onClick={() => pick(choice.id)}
                autoFocus={i === 0}
                className={buttonClass({ variant: choice.variant ?? "secondary" })}
              >
                {choice.label}
              </button>
            ))
          ) : (
            <button
              onClick={() => respond(true)}
              autoFocus={!request.danger}
              className={buttonClass({ variant: request.danger ? "danger" : "primary" })}
            >
              {request.confirmLabel ?? t("common.confirm")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
