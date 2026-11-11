import { useEffect, useState, type CSSProperties } from "react";
import { ArrowUpRight, Clock3 } from "lucide-react";
import { useLanguageStore, useT } from "../../state/languageStore";
import { formatResetAt, formatResetIn, formatUsed, missingClaudeWeekly, quotaKey, railWindows, useQuotaStore } from "../../state/quotaStore";
import { useAccountName, useAiAccountsStore } from "../../state/aiAccountsStore";
import { useUiStore } from "../../state/uiStore";
import { providerDisplayLabel } from "../../lib/aiProviders";
import { MissingWeeklyQuota, limitLabel, narrowedKinds, quotaAccountLabel, resetAtLabel } from "../ai/QuotaLimits";
import { ProviderGlyph } from "../ai/ProviderGlyph";
import { Tooltip } from "../common/Tooltip";
import type { QuotaLimit } from "../../types/domain";

const SIZE = 36;
const STROKE = 2.5;
const R_OUTER = SIZE / 2 - STROKE / 2 - 0.5;
const R_INNER = R_OUTER - STROKE - 1.25;
const MIN_USED_PERCENT = 0;
const MAX_USED_PERCENT = 100;
const YELLOW_THRESHOLD_PERCENT = 50;
const ORANGE_THRESHOLD_PERCENT = 75;
const WARNING_STROKE = STROKE + 0.5;
const RING_STYLE = {
  normal: { severity: "normal", stroke: "color-mix(in oklab, var(--cf-accent) 60%, transparent)", width: STROKE, glow: undefined },
  yellow: { severity: "yellow", stroke: "#eab308", width: WARNING_STROKE, glow: "drop-shadow(0 0 2px rgba(234,179,8,0.7))" },
  orange: { severity: "orange", stroke: "#f97316", width: WARNING_STROKE, glow: "drop-shadow(0 0 2px rgba(249,115,22,0.7))" },
  red: { severity: "critical", stroke: "#ef4444", width: WARNING_STROKE, glow: "drop-shadow(0 0 2px rgba(239,68,68,0.75))" },
};
const SESSION_SEGMENTS = 5;
const WEEKLY_SEGMENTS = 10;
const GAP = 1.6;
const MIN_FILL = 0.8;
const RING_CENTER = SIZE / 2;
const FULL_TURN = 2 * Math.PI;
const HALF_GAP = GAP / 2;
const FULL_FRACTION = 1;
const EMPTY_TRACK_OPACITY = 0.4;
const SEGMENT_DELAY_MS = 24;
const SVG_NO_FILL = "none";
const TRACK_STROKE = "var(--cf-border)";
const SEGMENT_CLASS_NAME = "cf-quota-segment";

function ringStyleFor(used: number) {
  if (used >= MAX_USED_PERCENT) return RING_STYLE.red;
  if (used >= ORANGE_THRESHOLD_PERCENT) return RING_STYLE.orange;
  if (used >= YELLOW_THRESHOLD_PERCENT) return RING_STYLE.yellow;
  return RING_STYLE.normal;
}

function clampedUsedPercent(limit: QuotaLimit | null) {
  if (!limit) return MIN_USED_PERCENT;
  const nonNegativeUsed = Math.max(MIN_USED_PERCENT, limit.used_percent);
  return Math.min(MAX_USED_PERCENT, nonNegativeUsed);
}

function Ring({ r, limit, segments }: { r: number; limit: QuotaLimit | null; segments: number }) {
  const c = FULL_TURN * r;
  const step = c / segments;
  const seg = step - GAP;
  const used = clampedUsedPercent(limit);
  const style = ringStyleFor(used);
  const perSegment = MAX_USED_PERCENT / segments;
  return (
    <>
      <circle
        cx={RING_CENTER}
        cy={RING_CENTER}
        r={r}
        fill={SVG_NO_FILL}
        stroke={TRACK_STROKE}
        strokeWidth={STROKE}
        strokeDasharray={`${seg} ${GAP}`}
        strokeDashoffset={-HALF_GAP}
        opacity={limit ? FULL_FRACTION : EMPTY_TRACK_OPACITY}
      />
      {limit &&
        used > MIN_USED_PERCENT &&
        Array.from({ length: segments }, (_, i) => {
          const remainingFraction = (used - i * perSegment) / perSegment;
          const nonNegativeFraction = Math.max(MIN_USED_PERCENT, remainingFraction);
          const fraction = Math.min(FULL_FRACTION, nonNegativeFraction);
          if (fraction <= MIN_USED_PERCENT) return null;
          const len = Math.max(seg * fraction, MIN_FILL);
          return (
            <circle
              key={i}
              cx={RING_CENTER}
              cy={RING_CENTER}
              r={r}
              fill={SVG_NO_FILL}
              stroke={style.stroke}
              strokeWidth={style.width}
              strokeDasharray={`${len} ${c}`}
              strokeDashoffset={-(i * step + HALF_GAP)}
              style={{ filter: style.glow, animationDelay: `calc(var(--cf-quota-delay) + ${i * SEGMENT_DELAY_MS}ms)` }}
              className={SEGMENT_CLASS_NAME}
            />
          );
        })}
    </>
  );
}

export function RailQuotaRings() {
  const t = useT();
  const enabled = useQuotaStore((s) => s.railRings);
  const providers = useQuotaStore((s) => s.providers);
  const hidden = useQuotaStore((s) => s.railHidden);
  const accounts = useAiAccountsStore((s) => s.accounts);
  const ensureAccounts = useAiAccountsStore((s) => s.ensure);
  const nameOf = useAccountName();
  const watch = useQuotaStore((s) => s.watch);

  useEffect(() => (enabled ? watch() : undefined), [enabled, watch]);
  const anyAccount = providers.some((quota) => quota.account_id);
  useEffect(() => {
    if (enabled && anyAccount) void ensureAccounts();
  }, [enabled, anyAccount, ensureAccounts]);
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
        const style = ringStyleFor(fullest);
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
                {missingClaudeWeekly(quota) && <span className="mt-3 block"><MissingWeeklyQuota /></span>}
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
              data-severity={style.severity}
              style={{ "--cf-quota-color": style.stroke, "--cf-quota-delay": `${Math.min(index, 5) * 65}ms` } as CSSProperties}
            >
              <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} className="absolute inset-0 -rotate-90" aria-hidden>
                <Ring r={R_OUTER} limit={long} segments={WEEKLY_SEGMENTS} />
                <Ring r={R_INNER} limit={session} segments={SESSION_SEGMENTS} />
              </svg>
              <span className="cf-quota-core" aria-hidden>
                <ProviderGlyph providerId={quota.provider} size={14} className="cf-quota-logo" />
                <span className="cf-quota-value">{formatUsed(fullest)}</span>
              </span>
            </button>
          </Tooltip>
        );
      })}
      <span className="my-1 h-px w-5 bg-[var(--cf-border)]" />
    </>
  );
}

function QuotaWindow({ limit, narrowed, inner = false }: { limit: QuotaLimit; narrowed: Set<string>; inner?: boolean }) {
  const t = useT();
  const used = clampedUsedPercent(limit);
  const style = ringStyleFor(used);
  // Like the quota panel: how long, and the clock reading it comes back at, in the app's language.
  const language = useLanguageStore((s) => s.language);
  const now = Date.now();
  const reset = formatResetIn(limit.resets_at, now);
  const resetAt = formatResetAt(limit.resets_at, now, language);
  return (
    <span className="cf-quota-window" style={{ "--cf-quota-color": style.stroke } as CSSProperties}>
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
      {reset && <span className="cf-quota-reset"><Clock3 size={10} aria-hidden />{t("quota.resetsIn", { time: reset })}{resetAt && ` · ${resetAtLabel(resetAt, t)}`}</span>}
    </span>
  );
}
