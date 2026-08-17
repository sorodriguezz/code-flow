import { useEffect, useState } from "react";
import { providerDisplayLabel } from "../../lib/aiProviders";
import { ProviderGlyph } from "./ProviderGlyph";
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

/** The rule between two providers.
 *
 * Half-strength on purpose: with several engines listed, whitespace alone stopped saying where one
 * provider's windows ended and the next one's began — three bars and then three more read as six.
 * A full `--cf-border` line in a 300px panel turns the same list into a table with rows, which is
 * heavier than the job needs. This is a hairline you notice only when you are looking for the
 * boundary. */
const DIVIDER = "color-mix(in oklab, var(--cf-border) 55%, transparent)";

/**
 * What is left of each provider's plan, drawn the same way wherever it appears.
 *
 * One component for both surfaces on purpose: the status-bar popover and the settings screen are
 * answering the identical question, and two implementations of "how much is left" would eventually
 * disagree about rounding or about which end of the bar is full — which is exactly the kind of
 * disagreement nobody notices until they trust the wrong one.
 *
 * **Every provider the backend was able to ask is drawn, in order, whatever it answered.** The list
 * is the machine's installed engines that publish a limit at all — routing does not thin it, and
 * neither does a provider having come back empty. Both filters were tried and both produced the
 * same complaint: a panel titled "plan limits" that silently omitted an engine the user has
 * installed and signed into, which reads as the app having lost it rather than as the app being
 * tidy. So an engine with no numbers keeps its heading and says why underneath — reading, signed
 * out, or nothing published on this plan.
 *
 * What is still absent is what cannot have a limit at all: Cline publishes no plan window and a
 * metered API key has no cap, so neither is asked, and a row for either would be an invention
 * rather than an omission.
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

  // Nothing at all means no engine on this machine publishes a limit — the one case with nothing to
  // list. Anything the backend did ask is listed, including what it asked and got nothing from.
  if (providers.length === 0) {
    return <p className="text-[11px] text-[var(--cf-text-muted)]">{t("quota.none")}</p>;
  }

  return (
    <div className={compact ? "space-y-2.5" : "space-y-3.5"}>
      {providers.map((quota, index) => (
        <ProviderBlock key={quota.provider} quota={quota} compact={compact} first={index === 0} />
      ))}
    </div>
  );
}

function ProviderBlock({
  quota,
  compact,
  first,
}: {
  quota: ProviderQuota;
  compact: boolean;
  /** The first block draws no rule above it — a line under the panel's own header would be a
   * second one. */
  first: boolean;
}) {
  const t = useT();
  const narrowed = narrowedKinds(quota);

  return (
    <section
      className={first ? undefined : compact ? "border-t pt-2.5" : "border-t pt-3.5"}
      style={first ? undefined : { borderColor: DIVIDER }}
    >
      <div className="mb-1 flex items-center gap-1.5">
        <ProviderGlyph providerId={quota.provider} size={12} />
        <span className="min-w-0 flex-1 truncate text-[11.5px] font-semibold text-[var(--cf-text)]">
          {providerDisplayLabel(quota.provider, t)}
        </span>
        {quota.plan && (
          <span className="shrink-0 text-[10px] uppercase tracking-wide text-[var(--cf-text-muted)]">
            {quota.plan}
          </span>
        )}
      </div>

      {quota.limits.length === 0 ? (
        // Whatever it has instead of bars *is* its row. "You are signed out" is something the user
        // can act on; "reading…" is a five-second CLI read that otherwise looks like a broken
        // engine; and a plan that simply publishes no window — opencode without Go — says so, which
        // is a different sentence from having failed and a much better one than a missing heading.
        <p className="text-[10.5px] leading-snug text-[var(--cf-text-muted)]">
          {isPending(quota) ? t("quota.reading") : emptyMessage(quota.error, t)}
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
/** Which of one provider's window kinds it also reports *per model*.
 *
 * Anthropic reports the whole week **and** one model's slice of it, so its unscoped weekly row has
 * to say it means all of them; opencode reports one weekly window and nothing under it, where
 * "· all models" would be noise about a distinction that does not exist. Read off the data rather
 * than hardcoded per provider, so a provider that starts or stops splitting a window is labelled
 * right without a change here.
 *
 * Exported because the status-bar picker builds the same labels this panel draws, and two ways of
 * naming the same window would eventually disagree — the name in the dropdown has to be the name on
 * the row it points at. */
/** One limit named the way a human would name it across two providers: "Claude Code · Weekly ·
 * Fable". The status bar puts it in a tooltip and the picker puts it in a dropdown, and both have
 * to say exactly what the row in the panel says — a menu entry that names a window differently
 * from the bar it selects is a menu you cannot trust. */
export function limitTitle(quota: ProviderQuota, limit: QuotaLimit, t: Translate): string {
  return `${providerDisplayLabel(quota.provider, t)} · ${limitLabel(limit, narrowedKinds(quota), t)}`;
}

export function narrowedKinds(quota: ProviderQuota): Set<string> {
  return new Set(quota.limits.filter((limit) => limit.scope).map((limit) => limit.kind));
}

export function limitLabel(limit: QuotaLimit, narrowed: Set<string>, t: Translate): string {
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

/** The reason a provider has no numbers, said in a way that names the way out where there is one.
 *
 * The keys are the backend's `reason` constants, and the five answers are five genuinely different
 * situations — which is the point of splitting them. **An empty `error` is not a failure**: it is
 * the provider having answered, successfully, that there is no window to report — opencode on Zen
 * credits, where a prepaid balance has no denominator to be a percentage of. `no_plan` is the
 * account being on the free tier of something that *does* publish windows. `unreadable` is this app
 * failing to parse what it got, which is the only one of the five that is nobody's problem but
 * ours. Anything unrecognised falls in with that last one, because an HTTP status code in a 300px
 * panel helps nobody. */
function emptyMessage(error: string, t: Translate): string {
  if (!error) return t("quota.noLimits");
  if (error === "signed_out") return t("quota.signedOut");
  if (error === "stale") return t("quota.stale");
  if (error === "no_plan") return t("quota.noPlan");
  return t("quota.unreadable");
}
