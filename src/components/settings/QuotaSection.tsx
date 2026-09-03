import { useEffect, useState } from "react";
import { Gauge, RefreshCw } from "lucide-react";
import { useT } from "../../state/languageStore";
import { ageOf, limitKey, useQuotaStore } from "../../state/quotaStore";
import { QuotaLimits, limitLabel, limitTitle } from "../ai/QuotaLimits";
import { ProviderGlyph } from "../ai/ProviderGlyph";
import { providerDisplayLabel } from "../../lib/aiProviders";
import { Select, type SelectOption } from "../common/Select";

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
    <span className="min-w-0 flex-1 break-words text-[11px] leading-snug text-[var(--cf-text-muted)]">{label}</span>
  );
}

/**
 * Which single limit the status bar shows.
 *
 * The pill has room for one number, and until this existed the app chose it — the fullest window,
 * across everything routed. That is the right *default* and a poor *rule*: somebody on a weekly
 * plan watches the week all day, and the automatic answer keeps handing them whichever bucket is
 * momentarily highest, including a model they never touch. So the choice is offered where the
 * limits themselves are listed, phrased as what it is: a picker over the very rows above it.
 *
 * Options are built from the live reading, so a provider that publishes three windows offers three
 * entries and one that publishes none offers nothing — nothing here can be picked that the panel
 * cannot draw. The one exception is a stored pick whose window is not being reported *right now*
 * (signed out, mid-read, a renamed model): it stays in the list, marked, because dropping it would
 * silently reset a deliberate choice to "automatic" the moment a CLI logged out.
 */
function PillPicker() {
  const t = useT();
  const providers = useQuotaStore((s) => s.providers);
  const pick = useQuotaStore((s) => s.pick);
  const setPick = useQuotaStore((s) => s.setPick);

  const options: SelectOption[] = [
    { value: "", label: t("quota.pillAuto"), icon: Gauge },
    ...providers.flatMap((quota) =>
      quota.limits.map((limit) => ({
        value: limitKey(quota.provider, limit),
        label: limitTitle(quota, limit, t),
        leading: <ProviderGlyph providerId={quota.provider} size={13} />,
      })),
    ),
  ];
  // A pick nothing currently reports. Kept selectable and labelled rather than dropped — see above.
  // Its name is rebuilt from the key itself, which is exactly why the key stores the parts a label
  // is made of instead of an index: a window that is not in this reading can still say what it is.
  if (pick && !options.some((option) => option.value === pick)) {
    const [provider, kind, scope] = pick.split("|");
    const rebuilt = limitLabel({ kind, scope, used_percent: 0, resets_at: "" }, new Set(), t);
    options.push({
      value: pick,
      label: t("quota.pillMissing", { limit: `${providerDisplayLabel(provider, t)} · ${rebuilt}` }),
      leading: <ProviderGlyph providerId={provider} size={13} />,
    });
  }

  return (
    <div className="rounded-lg border border-[var(--cf-border)] p-2.5">
      <p className="text-[12.5px] font-medium text-[var(--cf-text)]">{t("quota.pillLabel")}</p>
      <p className="mb-1.5 text-[11px] leading-snug text-[var(--cf-text-muted)]">{t("quota.pillHint")}</p>
      <Select
        size="sm"
        ariaLabel={t("quota.pillLabel")}
        value={pick}
        onChange={(value) => void setPick(value)}
        options={options}
      />
    </div>
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

      {/* Under the limits, not above them: the picker is a choice *about* those rows, and reading
          the list first is what makes the options mean anything. */}
      <PillPicker />
    </section>
  );
}
