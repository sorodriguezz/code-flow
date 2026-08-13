import { useEffect } from "react";
import { RefreshCw } from "lucide-react";
import { useT } from "../../state/languageStore";
import { useQuotaStore } from "../../state/quotaStore";
import { QuotaLimits } from "../ai/QuotaLimits";

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

  useEffect(() => watch(), [watch]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <section className="space-y-3">
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => void refresh()}
          className="flex items-center gap-1.5 rounded-md border border-[var(--cf-border)] px-2 py-1 text-[11.5px] font-medium text-[var(--cf-text-muted)] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]"
        >
          <RefreshCw size={12} className={loading ? "animate-spin" : undefined} />
          {t("quota.refresh")}
        </button>
      </div>

      <QuotaLimits />
    </section>
  );
}
