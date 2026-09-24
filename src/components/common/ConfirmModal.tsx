import { useEffect, useRef } from "react";
import { CircleHelp, TriangleAlert } from "lucide-react";
import { useFocusTrap } from "../../lib/useFocusTrap";
import { useConfirmStore } from "../../state/confirmStore";
import { useT } from "../../state/languageStore";
import { ConfirmFlowDiagram } from "./ConfirmFlowDiagram";
import { buttonClass } from "./Button";

export function ConfirmModal() {
  const panelRef = useRef<HTMLDivElement>(null);
  const request = useConfirmStore((s) => s.request);
  const respond = useConfirmStore((s) => s.respond);
  const t = useT();

  useEffect(() => {
    if (!request) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") respond(false);
      if (e.key === "Enter") respond(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [request, respond]);

  useFocusTrap(panelRef, request !== null);

  if (!request) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 p-4" onClick={() => respond(false)}>
      <div
        ref={panelRef}
        onClick={(e) => e.stopPropagation()}
        role="alertdialog"
        aria-modal="true"
        tabIndex={-1}
        // Wider with a diagram than without: the two branch pills split the width between them,
        // so each one only ever gets half of it — and a name that wraps to three lines in a pill
        // is harder to read than the same name on one.
        className={`cf-fade-in max-h-[calc(100vh-2rem)] max-w-[90vw] overflow-y-auto rounded-[14px] border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-5 shadow-[var(--cf-shadow-modal)] ${
          request.flow ? "w-[560px]" : "w-[380px]"
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
          <p className="flex-1 pt-1 text-[13px] leading-snug text-[var(--cf-text)]">{request.message}</p>
        </div>

        {request.flow && <ConfirmFlowDiagram flow={request.flow} />}
        <div className="flex justify-end gap-2">
          <button onClick={() => respond(false)} className={buttonClass({ variant: "ghost" })}>
            {t("common.cancel")}
          </button>
          <button
            onClick={() => respond(true)}
            autoFocus
            className={buttonClass({ variant: request.danger ? "danger" : "primary" })}
          >
            {request.confirmLabel ?? t("common.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
