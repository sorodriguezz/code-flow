import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { useT } from "../../state/languageStore";
import { ageOf, useQuotaStore } from "../../state/quotaStore";
import { QuotaLimits } from "../ai/QuotaLimits";

/** How old the numbers are, beside the button that changes it.
 *
 * The half of the feedback that survives the spinner. On a quiet account every percentage comes
 * back identical, so without this a refresh is invisible — the screen is byte-for-byte what it was
 * and the user is left guessing whether the click registered. Here, "justo ahora" is the receipt.
 *
 * It re-renders itself once a minute: this is the one line on the screen whose text goes stale on
 * its own, without any new data arriving. */
function QuotaFreshness({ lastReadAt, loading }: { lastReadAt: number; loading: boolean }) {
  const t = useT();
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const age = ageOf(lastReadAt);
  const label = loading
    ? t("quota.refreshing")
    : age === null
      ? ""
      : age === "now"
        ? t("quota.updatedNow")
        : t("quota.updatedAgo", { minutes: age });

  return (
    <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--cf-text-muted)]">{label}</span>
  );
}

/**
 * How far through each provider's plan you are — its own settings tab.
 *
 * It used to sit on top of the usage screen, and the two never belonged together: this is what the
 * providers publish about a window that is still running, and that is what this app recorded about
 * windows that are over. Only one of them can run out, only one of them has a 5h/30d picker, and
 * having the picker sit directly under a set of bars it did not govern invited exactly the wrong
 * reading.
 *
 * The rail names this pane and the chrome prints the description, so neither is repeated here.
 *
 * Fetched on mount, because opening this tab is itself the deliberate action that the first
 * keychain prompt is allowed to hang off — see `quotaStore` for why quota is never read unasked.
 */
export function QuotaSection() {
  const t = useT();
  const refresh = useQuotaStore((s) => s.refresh);
  const watch = useQuotaStore((s) => s.watch);
  const loading = useQuotaStore((s) => s.loading);
  const lastReadAt = useQuotaStore((s) => s.lastReadAt);

  useEffect(() => watch(), [watch]);
  useEffect(() => {
    void refresh("open");
  }, [refresh]);

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <QuotaFreshness lastReadAt={lastReadAt} loading={loading} />
        <button
          type="button"
          onClick={() => void refresh("refresh")}
          disabled={loading}
          className="flex shrink-0 items-center gap-1.5 rounded-md border border-[var(--cf-border)] px-2 py-1 text-[11.5px] font-medium text-[var(--cf-text-muted)] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)] disabled:cursor-default disabled:opacity-60 disabled:hover:border-[var(--cf-border)] disabled:hover:text-[var(--cf-text-muted)]"
        >
          <RefreshCw size={12} className={loading ? "animate-spin" : undefined} />
          {t("quota.refresh")}
        </button>
      </div>

      <QuotaLimits />
    </section>
  );
}
