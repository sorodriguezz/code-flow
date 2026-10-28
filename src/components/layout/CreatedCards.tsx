import { useEffect } from "react";
import { Brain, ListTodo, X } from "lucide-react";
import { NoticeStack } from "../common/NoticeDock";
import { buttonClass } from "../common/Button";
import { useT } from "../../state/languageStore";
import { useCreatedCardsStore } from "../../state/createdCardsStore";

/** Bottom right, with the app's other notices: this is the app telling the person what an agent just did. */
const PLACEMENT = { edge: "bottom", align: "right" } as const;

/** One card per thing an agent made through `cf` — Open it, take it back, or let it go. */
export function CreatedCards() {
  const t = useT();
  const cards = useCreatedCardsStore((s) => s.cards);
  const init = useCreatedCardsStore((s) => s.init);
  const open = useCreatedCardsStore((s) => s.open);
  const undo = useCreatedCardsStore((s) => s.undo);
  const dismiss = useCreatedCardsStore((s) => s.dismiss);

  useEffect(() => init(), [init]);

  if (cards.length === 0) return null;
  return (
    <NoticeStack kind="popups" placement={PLACEMENT}>
      {cards.map((card) => {
        const Icon = card.kind === "task" ? ListTodo : Brain;
        return (
          <div
            key={card.key}
            role="status"
            className="pointer-events-auto w-[340px] rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-3 shadow-[var(--cf-toast-shadow)]"
          >
            <div className="flex items-start gap-2.5">
              <Icon size={16} className="mt-0.5 shrink-0 text-[var(--cf-accent)]" />
              <div className="min-w-0 flex-1">
                <p className="text-[12px] text-[var(--cf-text-muted)]">{t(card.kind === "task" ? "created.task" : "created.memory")}</p>
                <p className="truncate text-[13px] font-medium text-[var(--cf-text)]" title={card.title}>
                  {card.title}
                </p>
              </div>
              <button
                type="button"
                onClick={() => dismiss(card.key)}
                aria-label={t("cliUpdates.close")}
                title={t("cliUpdates.close")}
                className="-mr-1 -mt-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)]"
              >
                <X size={13} />
              </button>
            </div>
            <div className="mt-2.5 flex items-center gap-2">
              <button type="button" onClick={() => open(card)} className={buttonClass({ variant: "primary", size: "sm" })}>
                {t("created.open")}
              </button>
              <button type="button" onClick={() => void undo(card)} className={buttonClass({ variant: "ghost", size: "sm" })}>
                {t("created.undo")}
              </button>
            </div>
          </div>
        );
      })}
    </NoticeStack>
  );
}
