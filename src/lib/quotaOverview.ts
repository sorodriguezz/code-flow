import type { ProviderQuota, QuotaLimit } from "../types/domain";

/**
 * How much of an account is left, said as a state rather than a number — what «Consumo y límites»
 * counts, colours and sorts by.
 *
 * **No percentage is ever averaged across accounts.** 80% of one provider's week is not 80% of
 * another's session: the windows are of different lengths and the allowances behind them of
 * different sizes, so a "global use" figure would be a number with no unit. What can be compared is
 * the state each account is in, and that is counted.
 *
 * The thresholds are this app's own reading of a percentage, not anything a provider publishes:
 * one table, here, so every surface that says «próximo al límite» means the same thing by it.
 */
export type Availability = "available" | "moderate" | "near" | "critical" | "exhausted" | "unknown";

/** Where each state begins, in percent consumed — fullest first. */
export const AVAILABILITY_BANDS: readonly { status: Exclude<Availability, "unknown">; from: number }[] = [
  { status: "exhausted", from: 100 },
  { status: "critical", from: 95 },
  { status: "near", from: 80 },
  { status: "moderate", from: 60 },
  { status: "available", from: 0 },
];

/** Every state, in the order a summary lists them: what can be used first, what cannot be told last. */
export const AVAILABILITY_ORDER: readonly Availability[] = ["available", "moderate", "near", "critical", "exhausted", "unknown"];

/** How bad a state is, for sorting worst first. Not knowing is not bad news: it sorts last. */
const RANK: Record<Availability, number> = { exhausted: 5, critical: 4, near: 3, moderate: 2, available: 1, unknown: 0 };

export function availabilityRank(status: Availability): number {
  return RANK[status];
}

/** The state a window that is `usedPercent` consumed is in; `unknown` when there is no reading. */
export function availabilityOf(usedPercent: number | null | undefined): Availability {
  if (usedPercent === null || usedPercent === undefined || Number.isNaN(usedPercent)) return "unknown";
  // Rounded as the figure beside it is (`formatUsed` rounds up), so «100%» is never «crítico».
  const used = Math.ceil(Math.min(100, Math.max(0, usedPercent)));
  return AVAILABILITY_BANDS.find((band) => used >= band.from)?.status ?? "available";
}

/** A state that asks for something to be done about it: near the limit, critical or exhausted. */
export function needsAttention(status: Availability): boolean {
  return RANK[status] >= RANK.near;
}

const fullest = (limits: QuotaLimit[]): QuotaLimit | null =>
  limits.reduce<QuotaLimit | null>((best, limit) => (!best || limit.used_percent > best.used_percent ? limit : best), null);
const emptiest = (limits: QuotaLimit[]): QuotaLimit | null =>
  limits.reduce<QuotaLimit | null>((best, limit) => (!best || limit.used_percent < best.used_percent ? limit : best), null);

/**
 * The state of one account, and the window that puts it there.
 *
 * **A model's limit is not the account's.** A window with no scope — the session, the week — stops
 * everything when it is spent, so the account is as far gone as the fullest of those. A window
 * scoped to one model, or to one group of them, only stops that model: the account can still be
 * used with the others. So where an account reports general windows, the scoped ones do not move
 * its state (they are listed apart, as a model's own limit — see [`attentionItems`]); and where
 * it reports nothing but scoped ones, it is as available as the least spent of them — spent only
 * when every one is.
 */
export function accountAvailability(quota: ProviderQuota): { status: Availability; limit: QuotaLimit | null } {
  const general = quota.limits.filter((limit) => !limit.scope);
  const limit = general.length > 0 ? fullest(general) : emptiest(quota.limits);
  return { status: availabilityOf(limit?.used_percent), limit };
}

/** Whether `limit` stops one model only, the account going on with the others. */
export function modelOnly(quota: ProviderQuota, limit: QuotaLimit): boolean {
  if (!limit.scope) return false;
  // A general window beside it, or another group that is not spent: there is somewhere else to go.
  return quota.limits.some((other) => other !== limit && (!other.scope || availabilityOf(other.used_percent) !== "exhausted"));
}

/** One window that is near its limit or past it. */
export interface AttentionItem {
  quota: ProviderQuota;
  limit: QuotaLimit;
  status: Availability;
  /** It stops one model, not the account. */
  modelOnly: boolean;
}

/** Every window that asks for attention, the fullest first — the account's own before a model's at
 *  the same percentage. */
export function attentionItems(providers: readonly ProviderQuota[]): AttentionItem[] {
  return providers
    .flatMap((quota) =>
      quota.limits
        .map((limit) => ({ quota, limit, status: availabilityOf(limit.used_percent), modelOnly: modelOnly(quota, limit) }))
        .filter((item) => needsAttention(item.status)),
    )
    .sort((a, b) => b.limit.used_percent - a.limit.used_percent || Number(a.modelOnly) - Number(b.modelOnly));
}

/** A window and the moment it comes back. */
export interface UpcomingReset {
  quota: ProviderQuota;
  limit: QuotaLimit;
  at: number;
}

/**
 * Which windows give capacity back first: the ones that are at least moderately spent, soonest
 * first. A window nobody has touched rolling over changes nothing, so it is only listed when no
 * spent one has a known reset — then the soonest of any that were used at all.
 */
export function upcomingResets(providers: readonly ProviderQuota[], now: number = Date.now(), max = 4): UpcomingReset[] {
  const all = providers.flatMap((quota) =>
    quota.limits
      .map((limit) => ({ quota, limit, at: Date.parse(limit.resets_at) }))
      .filter((reset) => !Number.isNaN(reset.at) && reset.at > now),
  );
  const spent = all.filter((reset) => RANK[availabilityOf(reset.limit.used_percent)] >= RANK.moderate);
  const shown = spent.length > 0 ? spent : all.filter((reset) => reset.limit.used_percent > 0);
  return shown.sort((a, b) => a.at - b.at).slice(0, max);
}

/** One account as the summary counts it. */
export interface AccountState {
  quota: ProviderQuota;
  status: Availability;
  /** The window its state is read from, when there is one. */
  limit: QuotaLimit | null;
}

/** One provider's accounts, the most available first — the order its bar is drawn in. */
export interface ProviderState {
  provider: string;
  accounts: AccountState[];
  /** How many of them can be used without a second thought: available or moderately spent. */
  available: number;
}

export interface QuotaOverview {
  accounts: AccountState[];
  providers: ProviderState[];
  /** How many accounts are in each state. */
  byStatus: Record<Availability, number>;
  /** Available or moderately spent. */
  available: number;
  /** Near the limit, critical or exhausted. */
  critical: number;
}

/** Everything the summary says, counted off the readings. */
export function quotaOverview(providers: readonly ProviderQuota[]): QuotaOverview {
  const accounts: AccountState[] = providers.map((quota) => ({ quota, ...accountAvailability(quota) }));
  const byStatus: Record<Availability, number> = { available: 0, moderate: 0, near: 0, critical: 0, exhausted: 0, unknown: 0 };
  for (const account of accounts) byStatus[account.status] += 1;
  const order: string[] = [];
  for (const account of accounts) if (!order.includes(account.quota.provider)) order.push(account.quota.provider);
  const usable = (status: Availability) => status === "available" || status === "moderate";
  return {
    accounts,
    byStatus,
    available: accounts.filter((account) => usable(account.status)).length,
    critical: accounts.filter((account) => needsAttention(account.status)).length,
    providers: order.map((provider) => {
      const own = accounts
        .filter((account) => account.quota.provider === provider)
        // What cannot be told sits at the end of the bar, after what is spent.
        .sort((a, b) => (a.status === "unknown" ? 9 : RANK[a.status]) - (b.status === "unknown" ? 9 : RANK[b.status]));
      return { provider, accounts: own, available: own.filter((account) => usable(account.status)).length };
    }),
  };
}
