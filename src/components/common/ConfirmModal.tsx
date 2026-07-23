import { useEffect } from "react";
import { TriangleAlert } from "lucide-react";
import { useConfirmStore } from "../../state/confirmStore";
import { useT } from "../../state/languageStore";

export function ConfirmModal() {
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

  if (!request) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30" onClick={() => respond(false)}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[380px] max-w-[90vw] rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-4 shadow-[var(--cf-shadow)]"
      >
        <div className="mb-4 flex items-start gap-3">
          <span
            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
              request.danger
                ? "bg-[color-mix(in_oklab,var(--cf-danger)_16%,transparent)] text-[var(--cf-danger)]"
                : "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
            }`}
          >
            <TriangleAlert size={16} />
          </span>
          <p className="flex-1 pt-1 text-[13px] leading-snug text-[var(--cf-text)]">{request.message}</p>
        </div>
        <div className="flex justify-end gap-2">
          <button
            onClick={() => respond(false)}
            className="rounded-md px-3 py-1.5 text-[12px] text-[var(--cf-text-muted)] hover:bg-black/[0.05] dark:hover:bg-white/[0.08]"
          >
            {t("common.cancel")}
          </button>
          <button
            onClick={() => respond(true)}
            autoFocus
            className={`rounded-md px-3 py-1.5 text-[12px] font-medium text-white hover:brightness-110 ${
              request.danger ? "bg-[var(--cf-danger)]" : "bg-[var(--cf-accent)]"
            }`}
          >
            {t("common.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
