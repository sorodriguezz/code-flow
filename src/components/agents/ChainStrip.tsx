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
  /**
   * Every step's state, as one character each — `"ddrpp"`.
   *
   * A **string** and not an array, for the reason in the note above: a selector returning a fresh
   * array is a selector that re-renders forever. Compressing the statuses into a primitive keeps
   * the comparison by value, and the first letters happen to be distinct across all six.
   */
  const marks = useChainStore((s) =>
    ownerId ? (s.stepsByChain[ownerId] ?? []).map((step) => step.status[0]).join("") : "",
  );
  const chain = useChainStore((s) => s.chains.find((c) => c.id === ownerId) ?? null);

  if (!chain || stepIndex < 0) return null;
  const { color } = chainStatusOf(chain);
  const owner = { chainId: chain.id, title: chain.title, index: stepIndex, total: chain.step_count };

  return (
    // A strip inside the sheet, so the sunken tone: it belongs to this task's page, not to the frame.
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--cf-border)] bg-[var(--cf-sunken)] pl-4 pr-2 text-[12px]">
      <Link2 size={13} className={`shrink-0 ${color}`} />
      <span className="min-w-0 truncate text-[var(--cf-text-muted)]">
        {t("agents.chainOf", { name: owner.title })}
      </span>
      <span className="shrink-0 tabular-nums text-[var(--cf-text-faint)]">
        · {t("agents.stepN", { n: owner.index + 1, total: owner.total })}
      </span>
      {/* Dots for the siblings: cheap, and it turns "step 2 of 3" from a number into a shape — one
          that fills in as the plan advances, so a task opened mid-chain says how much of the work
          around it is already behind it without going back to the chain. The dot you are standing
          on is drawn as the current one whatever its state says, because that is the question this
          strip answers — and it is a ring, larger than the rest, so it is found by shape and not
          only by colour. Steps not reached yet are hollow; the ones behind are filled. */}
      <span className="flex shrink-0 items-center gap-1" aria-hidden>
        {Array.from({ length: owner.total }, (_, i) => (
          <span
            key={i}
            className={`rounded-full ${
              i === owner.index
                ? "h-2 w-2 border-2 border-[var(--cf-accent)]"
                : marks[i] === "d"
                  ? "h-1.5 w-1.5 bg-[var(--cf-success)]"
                  : marks[i] === "r"
                    ? "h-1.5 w-1.5 bg-[color-mix(in_oklab,var(--cf-accent)_60%,transparent)]"
                    : marks[i] === "e"
                      ? "h-1.5 w-1.5 bg-[var(--cf-danger-fill)]"
                      : "h-1.5 w-1.5 border border-[var(--cf-text-faint)]"
            }`}
          />
        ))}
      </span>
      <button
        type="button"
        onClick={() => void useChainStore.getState().select(owner.chainId)}
        className="ml-auto shrink-0 rounded-md px-2 py-1 font-medium text-[var(--cf-accent)] transition-colors hover:bg-[var(--cf-accent-soft)]"
      >
        {t("agents.backToChain")}
      </button>
    </div>
  );
}
