import { useEffect, useState } from "react";
import { AI_PROVIDERS } from "../../lib/aiProviders";
import { useT } from "../../state/languageStore";
import { formatResetIn, formatUsed, severityOf, useQuotaStore } from "../../state/quotaStore";
import type { ProviderQuota, QuotaLimit } from "../../types/domain";
import type { TranslationKey } from "../../lib/i18n/translations";

type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string;

/** How the bar is coloured at each severity. Green is deliberately *not* used for a barely-touched
 * limit — "you are 10% into your week" is not a success state, it is the ordinary one, and a row of
 * green bars trains the eye to stop reading them. Only the warnings get a colour. */
const BAR_COLOUR: Record<ReturnType<typeof severityOf>, string> = {
  normal: "var(--cf-accent)",
  low: "#f59e0b",
  critical: "#ef4444",
};

/** How often the countdowns re-render. They are the only thing on screen that moves without new
 * data, and a minute is the smallest unit any of them shows. */
const TICK_MS = 30_000;

/**
 * What is left of each provider's plan, drawn the same way wherever it appears.
 *
 * One component for both surfaces on purpose: the status-bar popover and the settings screen are
 * answering the identical question, and two implementations of "how much is left" would eventually
 * disagree about rounding or about which end of the bar is full — which is exactly the kind of
 * disagreement nobody notices until they trust the wrong one.
 *
 * A provider with nothing to report and nothing to say about why is not rendered at all. That is
 * the rule the module behind this is built on: Ollama has no plan to be out of, and a metered API
 * key has no cap, so a row for either would be an invention.
 *
 * Every number here is **consumption** — how far into the window you are. One direction throughout,
 * decided in the backend, so a bar and the figure beside it can never end up describing opposite
 * halves of the same limit.
 */
export function QuotaLimits({ compact = false }: { compact?: boolean }) {
  const t = useT();
  const providers = useQuotaStore((s) => s.providers);
  const loading = useQuotaStore((s) => s.loading);
  const fetched = useQuotaStore((s) => s.fetched);

  // Re-renders the countdowns without re-reading anything. `Date.now()` is read at render time, so
  // the state itself only exists to schedule the re-render.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), TICK_MS);
    return () => clearInterval(id);
  }, []);

  if (loading && !fetched) {
    return <p className="text-[11px] text-[var(--cf-text-muted)]">{t("quota.loading")}</p>;
  }

  // A provider still being read is shown *saying so*, not omitted. The ones that answer by running
  // their CLI (Gemini, Grok) take seconds and are fetched behind the answer, so on the first open
  // they have nothing yet — and leaving them out made a working engine look like a missing one for
  // a minute. Omitting is still right for a provider with genuinely nothing to report; it is only
  // wrong while an answer is on its way.
  const shown = providers.filter((p) => p.limits.length > 0 || p.error || isPending(p));
  if (shown.length === 0) {
    return <p className="text-[11px] text-[var(--cf-text-muted)]">{t("quota.none")}</p>;
  }

  return (
    <div className={compact ? "space-y-2.5" : "space-y-3.5"}>
      {shown.map((quota) => (
        <ProviderBlock key={quota.provider} quota={quota} compact={compact} />
      ))}
    </div>
  );
}

function ProviderBlock({ quota, compact }: { quota: ProviderQuota; compact: boolean }) {
  const t = useT();
  const provider = AI_PROVIDERS.find((p) => p.id === quota.provider);
  const Icon = provider?.icon;

  // Which window kinds this provider splits further. Anthropic reports the whole week *and* one
  // model's slice of it, so its unscoped weekly row has to say it means all of them; opencode
  // reports one weekly window and nothing under it, where "· all models" would be noise about a
  // distinction that does not exist. Read off the data rather than hardcoded per provider, so a
  // provider that starts or stops splitting a window is right without a change here.
  const narrowed = new Set(
    quota.limits.filter((limit) => limit.scope).map((limit) => limit.kind),
  );

  return (
    <section>
      <div className="mb-1 flex items-center gap-1.5">
        {Icon && <Icon size={12} className="shrink-0 text-[var(--cf-text-muted)]" />}
        <span className="min-w-0 flex-1 truncate text-[11.5px] font-semibold text-[var(--cf-text)]">
          {provider?.label ?? quota.provider}
        </span>
        {quota.plan && (
          <span className="shrink-0 text-[10px] uppercase tracking-wide text-[var(--cf-text-muted)]">
            {quota.plan}
          </span>
        )}
      </div>

      {quota.limits.length === 0 ? (
        // The error — or the wait — is the row. A provider that answered "you are signed out" has
        // told the user something actionable, and one that has not answered yet has to say *that*
        // rather than vanish, or a five-second read looks like a broken engine.
        <p className="text-[10.5px] leading-snug text-[var(--cf-text-muted)]">
          {isPending(quota) ? t("quota.reading") : errorMessage(quota.error, t)}
        </p>
      ) : (
        <div className={compact ? "space-y-1.5" : "space-y-2"}>
          {quota.limits.map((limit) => (
            <LimitRow key={`${limit.kind}:${limit.scope}`} limit={limit} narrowed={narrowed} />
          ))}
        </div>
      )}
    </section>
  );
}

function LimitRow({ limit, narrowed }: { limit: QuotaLimit; narrowed: Set<string> }) {
  const t = useT();
  const used = limit.used_percent;
  const resetsIn = formatResetIn(limit.resets_at);

  return (
    <div>
      <div className="flex items-baseline gap-1.5">
        <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--cf-text-muted)]">
          {limitLabel(limit, narrowed, t)}
        </span>
        <span className="shrink-0 text-[11px] font-medium tabular-nums text-[var(--cf-text)]">
          {t("quota.used", { percent: formatUsed(used) })}
        </span>
      </div>
      <div className="mt-0.5 h-1 w-full overflow-hidden rounded-full bg-black/[0.07] dark:bg-white/[0.1]">
        <div
          className="h-full rounded-full transition-[width]"
          style={{
            // The bar fills as the window is consumed, so it grows towards the warning rather than
            // shrinking away from it. Not rounded like the label: a hairline is a truer picture of
            // 0.4% used than either an empty bar or a visible sliver.
            width: `${Math.min(100, Math.max(0, used))}%`,
            backgroundColor: BAR_COLOUR[severityOf(used)],
          }}
        />
      </div>
      {resetsIn && (
        <p className="mt-0.5 text-[10px] tabular-nums text-[var(--cf-text-muted)]">
          {t("quota.resetsIn", { time: resetsIn })}
        </p>
      )}
    </div>
  );
}

/** What to call one window.
 *
 * `kind` carries the meaning and `scope` narrows it, so a weekly bucket scoped to one model reads
 * "Current week · Opus" rather than needing a translation per model — which is impossible anyway,
 * since the model names come from the provider at runtime. */
/** What to call one window.
 *
 * `kind` carries the window and `scope` narrows it, so a weekly bucket scoped to one model reads
 * "Weekly · Opus" rather than needing a translation per model — impossible anyway, since the model
 * names come from the provider at runtime.
 *
 * `narrowed` is the set of kinds this provider also reports per model. It only affects the
 * *unscoped* row: where a week is split, that row has to say it covers all of them, or the total
 * and its slice read as two unrelated weeks. Where nothing is split, the suffix would be noise. */
function limitLabel(limit: QuotaLimit, narrowed: Set<string>, t: Translate): string {
  const base =
    limit.kind === "session"
      ? t("quota.session")
      : limit.kind === "weekly"
        ? t("quota.weekly")
        : limit.kind === "monthly"
          ? t("quota.monthly")
          : "";
  // No window kind at all: the bucket is named by its scope alone. That is Gemini's per-model
  // rows, where the model *is* the window.
  if (!base) return limit.scope;
  if (limit.scope) return `${base} · ${limit.scope}`;
  return narrowed.has(limit.kind) ? `${base} · ${t("quota.allModels")}` : base;
}

/** Whether this provider has not answered yet, as opposed to having answered with nothing.
 *
 * The backend marks it by leaving `fetched_at` empty — no limits, no error and no read time is a
 * provider whose request is still out, which only happens for the ones that answer by running their
 * CLI. Everything else carries the instant it was read, even when what it read was "nothing". */
function isPending(quota: ProviderQuota): boolean {
  return quota.limits.length === 0 && !quota.error && !quota.fetched_at;
}

/** The reason a provider has no numbers, said in a way that names the way out. The keys are the
 * backend's `reason` constants; anything else is a transport failure and gets the generic line —
 * an HTTP status code in a status bar helps nobody. */
function errorMessage(error: string, t: Translate): string {
  if (error === "signed_out") return t("quota.signedOut");
  if (error === "stale") return t("quota.stale");
  return t("quota.unreadable");
}
