import { Link2 } from "lucide-react";
import { chainStatusOf } from "./chainStatus";
import { useChainStore } from "../../state/chainStore";
import { useT } from "../../state/languageStore";

/**
 * The one line that tells a task it is not on its own.
 *
 * A chain step's task looks exactly like any other agent task — same transcript, same log, same
 * composer — and without this the user would have no way to tell that its answer is about to be
 * handed to somebody else, or where to go to see the plan it belongs to.
 */
export function ChainStrip({ taskId }: { taskId: string }) {
  const t = useT();
  // Two primitive selectors and a lookup, deliberately. A selector that builds an object returns a
  // new reference on every call, and `useSyncExternalStore` reads that as "the store changed" —
  // which re-renders, which calls the selector again. React catches it ("getSnapshot should be
  // cached") only after the loop has already taken the view down.
  const ownerId = useChainStore((s) => {
    for (const chain of s.chains) {
      if ((s.stepsByChain[chain.id] ?? []).some((step) => step.task_id === taskId)) return chain.id;
    }
    return "";
  });
  const stepIndex = useChainStore((s) => {
    if (!ownerId) return -1;
    return (s.stepsByChain[ownerId] ?? []).find((step) => step.task_id === taskId)?.step_index ?? -1;
  });
  const chain = useChainStore((s) => s.chains.find((c) => c.id === ownerId) ?? null);

  if (!chain || stepIndex < 0) return null;
  const { color } = chainStatusOf(chain);
  const owner = { chainId: chain.id, title: chain.title, index: stepIndex, total: chain.step_count };

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-[var(--cf-border)] bg-black/[0.02] px-3 py-1.5 text-[11px] dark:bg-white/[0.03]">
      <Link2 size={11} className={`shrink-0 ${color}`} />
      <span className="min-w-0 truncate text-[var(--cf-text-muted)]">
        {t("agents.chainOf", { name: owner.title })}
      </span>
      <span className="shrink-0 tabular-nums text-[var(--cf-text-muted)]">
        · {t("agents.stepN", { n: owner.index + 1, total: owner.total })}
      </span>
      {/* Dots for the siblings: cheap, and it turns "step 2 of 3" from a number into a shape. */}
      <span className="flex shrink-0 items-center gap-1">
        {Array.from({ length: owner.total }, (_, i) => (
          <span
            key={i}
            className={`h-1.5 w-1.5 rounded-full ${
              i === owner.index ? "bg-[var(--cf-accent)]" : "bg-[var(--cf-text-muted)]/30"
            }`}
          />
        ))}
      </span>
      <button
        type="button"
        onClick={() => void useChainStore.getState().select(owner.chainId)}
        className="ml-auto shrink-0 text-[var(--cf-accent)] hover:underline"
      >
        {t("agents.backToChain")}
      </button>
    </div>
  );
}
