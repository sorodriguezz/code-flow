import { useEffect, useState, type CSSProperties } from "react";
import { ArrowUpRight, Clock3 } from "lucide-react";
import { useT } from "../../state/languageStore";
import { formatResetIn, formatUsed, quotaKey, railWindows, severityOf, useQuotaStore } from "../../state/quotaStore";
import { useAccountName, useAiAccountsStore } from "../../state/aiAccountsStore";
import { useUiStore } from "../../state/uiStore";
import { providerDisplayLabel } from "../../lib/aiProviders";
import { limitLabel, narrowedKinds, quotaAccountLabel } from "../ai/QuotaLimits";
import { ProviderGlyph } from "../ai/ProviderGlyph";
import { Tooltip } from "../common/Tooltip";
import type { QuotaLimit } from "../../types/domain";

const SIZE = 36;
const STROKE = 2.5;
/** Outer ring: the week (or the provider's longer window). */
const R_OUTER = SIZE / 2 - STROKE / 2 - 0.5;
/** Inner ring: the session, one stroke and a hairline inside the outer one. */
const R_INNER = R_OUTER - STROKE - 1.25;

/** How each severity paints. Normal follows whatever accent the theme uses, but softened, so the
 * warnings are the only strong colour on the ring — even with an orange or red accent, a ring that
 * turns amber or red reads as a change rather than as more of the same. */
const RING_STYLE: Record<ReturnType<typeof severityOf>, { stroke: string; width: number; glow?: string }> = {
  normal: { stroke: "color-mix(in oklab, var(--cf-accent) 60%, transparent)", width: STROKE },
  low: { stroke: "#f59e0b", width: STROKE + 0.5, glow: "drop-shadow(0 0 2px rgba(245,158,11,0.7))" },
  critical: { stroke: "#ef4444", width: STROKE + 0.5, glow: "drop-shadow(0 0 2px rgba(239,68,68,0.75))" },
};

/** Each ring is cut into ten segments of 10% each, so the reading is exact at a glance: a segment
 * fills proportionally (8% → most of the first one; 99% → nine full and the tenth almost full), and
 * a ring only looks complete when it really is at 100%. */
const SEGMENTS = 10;
/** Gap between segments along the ring, in user units. */
const GAP = 1.6;
/** Smallest visible fill for a non-zero value, so 1% still shows a sliver. */
const MIN_FILL = 0.8;

function Ring({ r, limit }: { r: number; limit: QuotaLimit | null }) {
  const c = 2 * Math.PI * r;
  const step = c / SEGMENTS;
  const seg = step - GAP;
  const used = limit ? Math.min(100, Math.max(0, limit.used_percent)) : 0;
  const style = RING_STYLE[severityOf(used)];
  const perSegment = 100 / SEGMENTS;
  return (
    <>
      {/* Track: ten dashes of `seg`, each followed by a gap, starting half a gap past the top. */}
      <circle
        cx={SIZE / 2}
        cy={SIZE / 2}
        r={r}
        fill="none"
        stroke="var(--cf-border)"
        strokeWidth={STROKE}
        strokeDasharray={`${seg} ${GAP}`}
        strokeDashoffset={-GAP / 2}
        opacity={limit ? 1 : 0.4}
      />
      {limit &&
        used > 0 &&
        Array.from({ length: SEGMENTS }, (_, i) => {
          const fraction = Math.min(1, Math.max(0, (used - i * perSegment) / perSegment));
          if (fraction <= 0) return null;
          const len = Math.max(seg * fraction, MIN_FILL);
          return (
            <circle
              key={i}
              cx={SIZE / 2}
              cy={SIZE / 2}
              r={r}
              fill="none"
              stroke={style.stroke}
              strokeWidth={style.width}
              strokeDasharray={`${len} ${c}`}
              strokeDashoffset={-(i * step + GAP / 2)}
              style={{ filter: style.glow, animationDelay: `calc(var(--cf-quota-delay) + ${i * 24}ms)` }}
              className="cf-quota-segment"
            />
          );
        })}
    </>
  );
}

/**
 * One ring per account at the foot of the rail — the plan limits, readable without opening
 * anything. The session fills the inner ring and the week the outer one, both clockwise from the
 * top, in the same colours as the bars in the panel. Hovering names the provider and the account
 * (two Claude accounts draw the same glyph, so the tooltip is what tells them apart) and spells the
 * two numbers out with their resets; a click opens Settings → Plan limits.
 *
 * Opt-in (`railRings`, the check in the limits panel and in Settings). With it off, or with no
 * account reporting a number yet, nothing is rendered and the rail is exactly what it was. It sits
 * in the rail's fixed foot, so it takes room from the app list — which scrolls — rather than
 * overlapping it.
 */
export function RailQuotaRings() {
  const t = useT();
  const enabled = useQuotaStore((s) => s.railRings);
  const providers = useQuotaStore((s) => s.providers);
  const hidden = useQuotaStore((s) => s.railHidden);
  const accounts = useAiAccountsStore((s) => s.accounts);
  const ensureAccounts = useAiAccountsStore((s) => s.ensure);
  const nameOf = useAccountName();
  const watch = useQuotaStore((s) => s.watch);

  // Its own watch, so the poll keeps running for the rings even if the status bar is hidden.
  useEffect(() => (enabled ? watch() : undefined), [enabled, watch]);
  const anyAccount = providers.some((quota) => quota.account_id);
  useEffect(() => {
    if (enabled && anyAccount) void ensureAccounts();
  }, [enabled, anyAccount, ensureAccounts]);
  // The countdowns in the tooltips go stale on their own.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, [enabled]);

  if (!enabled) return null;
  const rows = providers
    .map((quota) => ({ quota, ...railWindows(quota) }))
    .filter((row) => (row.session || row.long) && !hidden.includes(quotaKey(row.quota)));
  if (rows.length === 0) return null;

  return (
    <>
      {rows.map(({ quota, session, long }, index) => {
        const account = quotaAccountLabel(quota, accounts, nameOf);
        const who = account ? `${providerDisplayLabel(quota.provider, t)} · ${account}` : providerDisplayLabel(quota.provider, t);
        const narrowed = narrowedKinds(quota);
        const fullest = Math.max(session?.used_percent ?? 0, long?.used_percent ?? 0);
        const severity = severityOf(fullest);
        const summary = [session, long].filter((limit) => limit !== null)
          .map((limit) => `${limitLabel(limit, narrowed, t)}: ${t("quota.used", { percent: formatUsed(limit.used_percent) })}`)
          .join(" · ");
        return (
          <Tooltip
            key={quotaKey(quota)}
            side="left"
            label={who}
            leading={<ProviderGlyph providerId={quota.provider} size={13} />}
            trailing={quota.plan ? <span className="cf-quota-plan">{quota.plan}</span> : undefined}
            description={
              <span className="cf-quota-details">
                {session && <QuotaWindow limit={session} narrowed={narrowed} inner />}
                {long && <QuotaWindow limit={long} narrowed={narrowed} />}
                <span className="cf-quota-hint">
                  {t("quota.railOpenLimits")} <ArrowUpRight size={12} aria-hidden />
                </span>
              </span>
            }
          >
            <button
              type="button"
              aria-label={`${t("quota.title")} · ${who} · ${summary}`}
              onClick={() => useUiStore.getState().openSettingsAt("claude", "limits")}
              className="cf-quota-orbit relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
              data-severity={severity}
              style={{ "--cf-quota-color": RING_STYLE[severity].stroke, "--cf-quota-delay": `${Math.min(index, 5) * 65}ms` } as CSSProperties}
            >
              <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} className="absolute inset-0 -rotate-90" aria-hidden>
                <Ring r={R_OUTER} limit={long} />
                <Ring r={R_INNER} limit={session} />
              </svg>
              <span className="cf-quota-core" aria-hidden>
                <ProviderGlyph providerId={quota.provider} size={14} className="cf-quota-logo" />
                <span className="cf-quota-value">{formatUsed(fullest)}</span>
              </span>
              {severity !== "normal" && <span className="cf-quota-warning" aria-hidden />}
            </button>
          </Tooltip>
        );
      })}
      <span className="my-1 h-px w-5 bg-[var(--cf-border)]" />
    </>
  );
}

/** The tooltip mirrors the rings: an outlined marker is the outer window, a filled one the inner. */
function QuotaWindow({ limit, narrowed, inner = false }: { limit: QuotaLimit; narrowed: Set<string>; inner?: boolean }) {
  const t = useT();
  const used = Math.min(100, Math.max(0, limit.used_percent));
  const reset = formatResetIn(limit.resets_at);
  return (
    <span className="cf-quota-window" style={{ "--cf-quota-color": RING_STYLE[severityOf(used)].stroke } as CSSProperties}>
      <span className="cf-quota-window-heading">
        <span className="cf-quota-window-name">
          <span className={`cf-quota-key ${inner ? "cf-quota-key-inner" : ""}`} aria-hidden />
          {limitLabel(limit, narrowed, t)}
        </span>
        <span className="cf-quota-window-value">{t("quota.used", { percent: formatUsed(used) })}</span>
      </span>
      <span className="cf-quota-meter" aria-hidden>
        <span style={{ width: `${used}%` }} />
      </span>
      {reset && <span className="cf-quota-reset"><Clock3 size={10} aria-hidden />{t("quota.resetsIn", { time: reset })}</span>}
    </span>
  );
}
