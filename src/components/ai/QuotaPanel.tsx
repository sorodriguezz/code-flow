/**
 * «Consumo y límites»: what is behind the status bar's gauge.
 *
 * Two readings of the same numbers. **Resumen** is the one it opens on, and answers three
 * questions without anybody reading a bar: how much capacity there is to work with, which accounts
 * are about to run out, and which get capacity back first. **Cuentas** is every account one by
 * one, by provider, to be searched and sorted. With a dozen accounts the first is what is wanted
 * on every glance, and the second only when one of them has to be looked at.
 *
 * Accounts are counted by the state each is in (`lib/quotaOverview`) and their percentages are
 * never averaged: a provider's week and another's session are not the same amount of anything.
 *
 * **Quota only**, as the panel it replaces: tokens and cost live in Settings → AI → Usage, and the
 * foot of the panel says so.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowRight, BarChart3, ChartColumn, ChevronDown, Clock, Info, PanelLeft, RefreshCw, Search, SlidersHorizontal } from "lucide-react";
import { providerDisplayLabel } from "../../lib/aiProviders";
import type { AccountNamer } from "../../lib/aiAccounts";
import type { TranslationKey } from "../../lib/i18n/translations";
import {
  AVAILABILITY_BANDS,
  AVAILABILITY_ORDER,
  attentionItems,
  availabilityOf,
  availabilityRank,
  quotaOverview,
  upcomingResets,
  type AccountState,
  type Availability,
} from "../../lib/quotaOverview";
import type { AiAccount } from "../../lib/tauri/accountCommands";
import { useAccountName, useAiAccountsStore } from "../../state/aiAccountsStore";
import { useLanguageStore, useT } from "../../state/languageStore";
import { ageOf, formatResetAt, formatResetIn, formatUsed, missingClaudeSession, missingClaudeWeekly, quotaBlocks, quotaKey, railWindows, useQuotaStore } from "../../state/quotaStore";
import { useUiStore } from "../../state/uiStore";
import type { ProviderQuota, QuotaLimit } from "../../types/domain";
import { Checkbox } from "../common/Checkbox";
import { ProviderGlyph } from "./ProviderGlyph";
import { FromRunNote, MissingQuota, emptyMessage, isPending, limitLabel, quotaAccountLabel, resetAtLabel } from "./QuotaLimits";

type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string;

/** How each state is drawn, the same wherever it is: a dot, a segment, a figure. */
export const AVAILABILITY_COLOUR: Record<Availability, string> = {
  available: "var(--cf-success)",
  moderate: "#7c86a8",
  near: "#eab308",
  critical: "#f97316",
  exhausted: "#ef4444",
  unknown: "var(--cf-text-faint)",
};

const BAND_LABEL: Record<Availability, TranslationKey> = {
  available: "quota.band.available",
  moderate: "quota.band.moderate",
  near: "quota.band.near",
  critical: "quota.band.critical",
  exhausted: "quota.band.exhausted",
  unknown: "quota.band.unknown",
};

/** What a state means in numbers, for whoever asks: «80–94% usado». */
function bandRange(status: Availability, t: Translate): string {
  if (status === "unknown") return t("quota.bandRangeUnknown");
  if (status === "exhausted") return t("quota.bandRangeFull");
  const at = AVAILABILITY_BANDS.findIndex((band) => band.status === status);
  return t("quota.bandRange", { from: AVAILABILITY_BANDS[at].from, to: AVAILABILITY_BANDS[at - 1].from - 1 });
}

/** The colour of a window's bar: the accent while there is room — a row of green bars for accounts
 *  nobody is close to spending is noise — and the state's own colour from «próximo al límite» on. */
function barColour(used: number): string {
  const status = availabilityOf(used);
  return availabilityRank(status) >= availabilityRank("near") ? AVAILABILITY_COLOUR[status] : "var(--cf-accent)";
}

/** Who an account is: the provider, and which of its accounts when it has more than one. */
function useNaming() {
  const t = useT();
  const accounts = useAiAccountsStore((s) => s.accounts);
  const nameOf = useAccountName();
  return useMemo(() => naming(t, accounts, nameOf), [t, accounts, nameOf]);
}

function naming(t: Translate, accounts: readonly AiAccount[], nameOf: AccountNamer) {
  const provider = (quota: ProviderQuota) => providerDisplayLabel(quota.provider, t);
  /** The account by itself, as its row under its provider says it. */
  const account = (quota: ProviderQuota) => quotaAccountLabel(quota, accounts, nameOf) ?? nameOf(quota.provider, quota.account_id);
  /** «Claude · Personal» — or just the provider, where it has the one account. */
  const full = (quota: ProviderQuota) => {
    const which = quotaAccountLabel(quota, accounts, nameOf);
    return which ? `${provider(quota)} · ${which}` : provider(quota);
  };
  return { provider, account, full };
}

const NO_NARROWING = new Set<string>();
/** What a window is called on a row that already names its account: «Semanal», «Semanal · Fable». */
const windowName = (limit: QuotaLimit, t: Translate) => limitLabel(limit, NO_NARROWING, t) || limit.kind;

function Bar({ used, className = "" }: { used: number; className?: string }) {
  return (
    <span aria-hidden className={`block h-1 overflow-hidden rounded-full bg-[var(--cf-press)] ${className}`}>
      <span className="block h-full rounded-full transition-[width]" style={{ width: `${Math.min(100, Math.max(0, used))}%`, background: barColour(used) }} />
    </span>
  );
}

function Stat({ label, value, hint, tone }: { label: string; value: number; hint: string; tone?: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface)] px-2 py-2" title={`${label}: ${value} · ${hint}`}>
      <span className="block truncate text-[10.5px] text-[var(--cf-text-muted)]">{label}</span>
      <b className="block text-[19px] font-semibold leading-tight tabular-nums" style={tone ? { color: tone } : undefined}>{value}</b>
      <span className="block truncate text-[10px] tracking-[-0.01em] text-[var(--cf-text-muted)]">{hint}</span>
    </div>
  );
}

/** The accounts as a ring: one arc per state, as long as the accounts in it are many. */
function Donut({ counts, total, unit }: { counts: Record<Availability, number>; total: number; unit: string }) {
  const size = 92;
  const stroke = 10;
  const r = (size - stroke) / 2;
  const around = 2 * Math.PI * r;
  // A hair between arcs, so two states side by side are two; none when there is only one.
  const parts = AVAILABILITY_ORDER.filter((status) => counts[status] > 0);
  const gap = parts.length > 1 ? 3 : 0;
  let offset = 0;
  return (
    <span className="relative grid shrink-0 place-items-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--cf-press)" strokeWidth={stroke} />
        {total > 0 && parts.map((status) => {
          const length = (counts[status] / total) * around;
          const arc = (
            <circle
              key={status}
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke={AVAILABILITY_COLOUR[status]}
              strokeWidth={stroke}
              strokeDasharray={`${Math.max(0, length - gap)} ${around}`}
              strokeDashoffset={-offset}
            />
          );
          offset += length;
          return arc;
        })}
      </svg>
      <span className="absolute text-center leading-none">
        <b className="block text-[19px] font-semibold tabular-nums">{total}</b>
        <span className="text-[9.5px] text-[var(--cf-text-muted)]">{unit}</span>
      </span>
    </span>
  );
}

function Heading({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-2 flex items-baseline gap-2">
      <h3 className="min-w-0 flex-1 truncate text-[12px] font-semibold text-[var(--cf-text)]">{children}</h3>
      {aside && <span className="shrink-0 text-[10.5px] text-[var(--cf-text-muted)]">{aside}</span>}
    </div>
  );
}

const RULE = "border-t border-[color-mix(in_oklab,var(--cf-border)_70%,transparent)] pt-3";

/** The summary: how many accounts are in each state, how each provider stands, what needs
 *  attention and what comes back first. */
function Summary({ providers }: { providers: ProviderQuota[] }) {
  const t = useT();
  const names = useNaming();
  const overview = useMemo(() => quotaOverview(providers), [providers]);
  const attention = useMemo(() => attentionItems(providers), [providers]);
  const now = Date.now();
  const resets = upcomingResets(providers, now);
  const total = overview.accounts.length;
  // What can be used is always said, with what is not when there is any of it.
  const listed = AVAILABILITY_ORDER.filter((status) => status === "available" || overview.byStatus[status] > 0);
  const attentionAccounts = new Set(attention.map((item) => quotaKey(item.quota))).size;

  return (
    <div className="space-y-3">
      <section>
        <Heading>{t("quota.availabilityTitle")}</Heading>
        <div className="flex items-center gap-4">
          <Donut counts={overview.byStatus} total={total} unit={total === 1 ? t("quota.accountUnit") : t("quota.accountsUnit")} />
          <ul className="min-w-0 flex-1 space-y-1.5">
            {listed.map((status) => (
              <li key={status} className="flex items-center gap-2 text-[11.5px]" title={bandRange(status, t)}>
                <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ background: AVAILABILITY_COLOUR[status] }} />
                <span className="min-w-0 flex-1 truncate text-[var(--cf-text)]">{t(BAND_LABEL[status])}</span>
                <b className="shrink-0 font-semibold tabular-nums">{overview.byStatus[status]}</b>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className={RULE}>
        <Heading>{t("quota.byProvider")}</Heading>
        <ul className="space-y-2.5">
          {overview.providers.map((row) => (
            <li key={row.provider} className="flex items-start gap-2.5">
              <span className="flex w-[104px] shrink-0 items-start gap-1.5">
                <ProviderGlyph providerId={row.provider} size={13} className="mt-[1px]" />
                <span className="min-w-0">
                  <span className="block truncate text-[11.5px] font-medium leading-tight text-[var(--cf-text)]">{providerDisplayLabel(row.provider, t)}</span>
                  <span className="block truncate text-[10.5px] leading-tight text-[var(--cf-text-muted)]">{t("quota.accountsN", { n: row.accounts.length })}</span>
                </span>
              </span>
              <span className="min-w-0 flex-1">
                {/* One segment an account, the most available first: how the provider stands is seen
                    without a number being read. */}
                <span className="mt-[5px] flex gap-[3px]">
                  {row.accounts.map((account) => (
                    <span
                      key={quotaKey(account.quota)}
                      title={`${names.account(account.quota)} · ${t(BAND_LABEL[account.status])}${account.limit ? ` · ${formatUsed(account.limit.used_percent)}` : ""}`}
                      className="h-1.5 min-w-0 flex-1 rounded-full"
                      style={{ background: AVAILABILITY_COLOUR[account.status], opacity: account.status === "unknown" ? 0.45 : 1 }}
                    />
                  ))}
                </span>
                <span className="mt-1 block text-[10.5px] leading-tight text-[var(--cf-text-muted)]">{t("quota.availableN", { n: row.available })}</span>
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className={RULE}>
        <Heading aside={attention.length > 0 ? t("quota.accountsN", { n: attentionAccounts }) : undefined}>{t("quota.attention")}</Heading>
        {attention.length === 0 ? (
          <p className="text-[11px] text-[var(--cf-text-muted)]">{t("quota.attentionNone")}</p>
        ) : (
          <ul className="space-y-1.5">
            {attention.map((item) => {
              const left = formatResetIn(item.limit.resets_at, now);
              return (
                <li key={`${quotaKey(item.quota)}|${item.limit.kind}|${item.limit.scope}`} className="rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface)] px-2.5 py-2">
                  <div className="flex items-baseline gap-2">
                    <b className="min-w-0 flex-1 truncate text-[11.5px] font-medium">{names.full(item.quota)}</b>
                    <b className="shrink-0 text-[12px] font-semibold tabular-nums" style={{ color: AVAILABILITY_COLOUR[item.status] }} title={t(BAND_LABEL[item.status])}>{formatUsed(item.limit.used_percent)}</b>
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5 text-[10.5px] text-[var(--cf-text-muted)]">
                    <span className="min-w-0 truncate">{windowName(item.limit, t)}</span>
                    {item.modelOnly && <span className="shrink-0 rounded-full bg-[var(--cf-press)] px-1.5 py-px text-[9.5px] font-medium" title={t("quota.modelOnlyHint")}>{t("quota.modelOnly")}</span>}
                  </div>
                  <Bar used={item.limit.used_percent} className="mt-1.5" />
                  <p className="mt-1.5 flex items-center gap-1 text-[10.5px] tabular-nums text-[var(--cf-text-muted)]">
                    <Clock size={11} className="shrink-0" />
                    {left ? t("quota.resetsShort", { time: left }) : t("quota.resetUnknown")}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {resets.length > 0 && (
        <section className={RULE}>
          <Heading>{t("quota.nextResets")}</Heading>
          <ul className="space-y-1.5">
            {resets.map((reset) => (
              <li key={`${quotaKey(reset.quota)}|${reset.limit.kind}|${reset.limit.scope}`} className="flex items-center gap-2 text-[11.5px]">
                <Clock size={12} className="shrink-0 text-[var(--cf-text-muted)]" />
                <span className="min-w-0 flex-1 truncate">
                  {names.full(reset.quota)}
                  <span className="text-[var(--cf-text-muted)]"> — {windowName(reset.limit, t)}</span>
                </span>
                <b className="shrink-0 font-medium tabular-nums">{formatResetIn(reset.limit.resets_at, now)}</b>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className={RULE}>
        <button
          type="button"
          onClick={() => useUiStore.getState().openSettingsAt("claude", "usage")}
          className="flex w-full items-center gap-2 rounded-md py-0.5 text-left text-[11.5px] text-[var(--cf-text-muted)] outline-none hover:text-[var(--cf-text)] focus-visible:shadow-[0_0_0_2px_var(--cf-accent-line)]"
        >
          <ChartColumn size={13} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate">{t("quota.seeUsage")}</span>
          <ArrowRight size={13} className="shrink-0" />
        </button>
      </div>
    </div>
  );
}

type Sort = "" | "use" | "name" | "reset";

/** A filter of the accounts list. Native on purpose: a menu drawn outside the panel is a press
 *  outside the panel, and the panel closes on those. */
function Filter<T extends string>({ label, value, onChange, options }: { label: string; value: T; onChange: (value: T) => void; options: { value: T; label: string }[] }) {
  const chosen = options.find((option) => option.value === value);
  return (
    <label className={`relative flex h-7 min-w-0 flex-1 items-center gap-1 rounded-md border px-2 text-[11.5px] ${value ? "border-[var(--cf-accent)] text-[var(--cf-accent)]" : "border-[var(--cf-border)] text-[var(--cf-text)]"} hover:bg-[var(--cf-hover)]`}>
      <span className="min-w-0 flex-1 truncate">{value && chosen ? chosen.label : label}</span>
      <ChevronDown size={12} className="shrink-0 opacity-70" />
      <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value as T)} className="absolute inset-0 cursor-pointer opacity-0">
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
  );
}

/** One account of a provider: who, on which plan, and each of its windows. */
function AccountRow({ account, name }: { account: AccountState; name: string }) {
  const t = useT();
  const language = useLanguageStore((s) => s.language);
  const { quota, status } = account;
  const now = Date.now();
  return (
    <li className="rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface)] px-2.5 py-2">
      <div className="flex items-start gap-2.5">
        <span className="flex w-[86px] shrink-0 items-start gap-1.5">
          <span aria-hidden className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: AVAILABILITY_COLOUR[status] }} title={t(BAND_LABEL[status])} />
          <span className="min-w-0">
            <b className="block truncate text-[11.5px] font-medium leading-tight" title={`${name} · ${t(BAND_LABEL[status])}`}>{name}</b>
            {quota.plan && <span className="mt-1 inline-block max-w-full truncate rounded bg-[color-mix(in_oklab,var(--cf-accent)_12%,transparent)] px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-[var(--cf-accent)]">{quota.plan}</span>}
          </span>
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          {quota.limits.length === 0 ? (
            <p className="text-[10.5px] leading-snug text-[var(--cf-text-muted)]">{isPending(quota) ? t("quota.reading") : emptyMessage(quota.error, t)}</p>
          ) : (
            <>
              {missingClaudeSession(quota) && <MissingQuota label={t("quota.session")} />}
              {quotaBlocks(quota).map(({ limit }) => {
                const left = formatResetIn(limit.resets_at, now);
                const at = formatResetAt(limit.resets_at, now, language);
                const label = windowName(limit, t);
                // A narrow column: the session by one word, a model's slice by the model — the row
                // above it is the window it is a slice of, and the whole name is a hover away.
                const short = limit.kind === "session" && !limit.scope ? t("quota.sessionShort") : limit.scope || label;
                return (
                  <div key={`${limit.kind}|${limit.scope}`} className="flex items-center gap-1.5 text-[10.5px]" title={left ? `${label} · ${t("quota.resetsIn", { time: left })}${at ? ` · ${resetAtLabel(at, t)}` : ""}` : label}>
                    <span className={`w-[76px] shrink-0 truncate text-[var(--cf-text-muted)] ${limit.scope && limit.kind ? "pl-2" : ""}`}>{short}</span>
                    <b className="w-[30px] shrink-0 text-right font-medium tabular-nums">{formatUsed(limit.used_percent)}</b>
                    <Bar used={limit.used_percent} className="min-w-0 flex-1" />
                    <span className="w-[44px] shrink-0 truncate text-right tabular-nums text-[var(--cf-text-muted)]">{left ?? "—"}</span>
                  </div>
                );
              })}
              {missingClaudeWeekly(quota) && <MissingQuota label={t("quota.weekly")} />}
              {quota.error.startsWith("from_run") && <FromRunNote quota={quota} />}
            </>
          )}
        </div>
      </div>
    </li>
  );
}

/** Every account, by provider: searched, narrowed to a provider or a state, sorted. */
function Accounts({ providers }: { providers: ProviderQuota[] }) {
  const t = useT();
  const names = useNaming();
  const overview = useMemo(() => quotaOverview(providers), [providers]);
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState("");
  const [status, setStatus] = useState<Availability | "">("");
  const [sort, setSort] = useState<Sort>("");
  const [folded, setFolded] = useState<Record<string, boolean>>({});

  const wanted = query.trim().toLocaleLowerCase();
  const soonest = (account: AccountState) => {
    const times = account.quota.limits.map((limit) => Date.parse(limit.resets_at)).filter((at) => !Number.isNaN(at) && at > Date.now());
    return times.length > 0 ? Math.min(...times) : Number.POSITIVE_INFINITY;
  };
  const groups = overview.providers
    .filter((row) => !provider || row.provider === provider)
    .map((row) => {
      // As the backend lists them, unless asked otherwise: the order the rail and Settings use.
      const own = providers.filter((quota) => quota.provider === row.provider).map((quota) => row.accounts.find((account) => account.quota === quota)!);
      const shown = own.filter((account) => {
        if (status && account.status !== status) return false;
        return !wanted || `${names.provider(account.quota)} ${names.account(account.quota)} ${account.quota.plan}`.toLocaleLowerCase().includes(wanted);
      });
      if (sort === "use") shown.sort((a, b) => (b.limit?.used_percent ?? -1) - (a.limit?.used_percent ?? -1));
      else if (sort === "name") shown.sort((a, b) => names.account(a.quota).localeCompare(names.account(b.quota)));
      else if (sort === "reset") shown.sort((a, b) => soonest(a) - soonest(b));
      return { provider: row.provider, total: own.length, shown };
    })
    .filter((group) => group.shown.length > 0);
  // Narrowed down, what matched is what is wanted on screen: nothing stays folded over it.
  const narrowed = wanted !== "" || status !== "";

  return (
    <div className="space-y-2">
      <label className="flex h-7 items-center gap-1.5 rounded-md border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-2 focus-within:border-[var(--cf-accent)]">
        <Search size={12} className="shrink-0 text-[var(--cf-text-muted)]" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("quota.search")}
          aria-label={t("quota.search")}
          className="min-w-0 flex-1 bg-transparent text-[11.5px] outline-none placeholder:text-[var(--cf-text-faint)]"
        />
      </label>
      <div className="flex gap-1.5">
        <Filter label={t("quota.filterProvider")} value={provider} onChange={setProvider} options={[{ value: "", label: t("quota.filterAny") }, ...overview.providers.map((row) => ({ value: row.provider, label: providerDisplayLabel(row.provider, t) }))]} />
        <Filter<Availability | ""> label={t("quota.filterStatus")} value={status} onChange={setStatus} options={[{ value: "", label: t("quota.filterAny") }, ...AVAILABILITY_ORDER.map((value) => ({ value, label: t(BAND_LABEL[value]) }))]} />
        <Filter<Sort>
          label={t("quota.sort")}
          value={sort}
          onChange={setSort}
          options={[{ value: "", label: t("quota.sortDefault") }, { value: "use", label: t("quota.sortUse") }, { value: "name", label: t("quota.sortName") }, { value: "reset", label: t("quota.sortReset") }]}
        />
      </div>

      {groups.length === 0 && <p className="px-0.5 py-2 text-[11px] text-[var(--cf-text-muted)]">{t("quota.noMatches")}</p>}
      {groups.map((group) => {
        const name = providerDisplayLabel(group.provider, t);
        const open = narrowed || !folded[group.provider];
        return (
          <section key={group.provider} className="rounded-lg border border-[var(--cf-border)] bg-[color-mix(in_oklab,var(--cf-press)_45%,transparent)]">
            <button
              type="button"
              aria-expanded={open}
              aria-label={open ? t("quota.collapse", { name }) : t("quota.expand", { name })}
              onClick={() => setFolded((was) => ({ ...was, [group.provider]: !was[group.provider] }))}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left outline-none hover:bg-[var(--cf-hover)] focus-visible:shadow-[inset_0_0_0_2px_var(--cf-accent-line)]"
            >
              <ProviderGlyph providerId={group.provider} size={14} />
              <b className="min-w-0 truncate text-[12px] font-semibold">{name}</b>
              <span className="shrink-0 rounded-full bg-[var(--cf-press)] px-1.5 py-px text-[10px] text-[var(--cf-text-muted)]">{t("quota.accountsN", { n: group.total })}</span>
              {/* Folded, the provider still says how its accounts stand. */}
              <span className="ml-auto flex shrink-0 items-center gap-[3px]">
                {!open && group.shown.map((account) => <span key={quotaKey(account.quota)} aria-hidden className="h-1.5 w-1.5 rounded-full" style={{ background: AVAILABILITY_COLOUR[account.status] }} />)}
                <ChevronDown size={14} className={`ml-1 text-[var(--cf-text-muted)] transition-transform ${open ? "rotate-180" : ""}`} />
              </span>
            </button>
            {open && (
              <ul className="space-y-1.5 px-1.5 pb-1.5">
                {group.shown.map((account) => <AccountRow key={quotaKey(account.quota)} account={account} name={names.account(account.quota)} />)}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

/**
 * Which accounts draw a ring at the foot of the sidebar. One list, no switch above it: an account
 * ticked is a ring shown, and none ticked is no rings — the same two settings the switch and its
 * list were (`quota_rail_rings`, `quota_rail_hidden`), so Settings → Plan limits agrees with it.
 */
function RailPicker({ providers }: { providers: ProviderQuota[] }) {
  const t = useT();
  const names = useNaming();
  const on = useQuotaStore((s) => s.railRings);
  const hidden = useQuotaStore((s) => s.railHidden);
  const [open, setOpen] = useState(false);
  // Only the accounts that would draw a ring: one with no session or week has nothing to show.
  const choices = providers.filter((quota) => {
    const { session, long } = railWindows(quota);
    return session || long;
  });
  if (choices.length === 0) return null;
  const keys = choices.map(quotaKey);
  const shown = on ? keys.filter((key) => !hidden.includes(key)) : [];
  const toggle = (key: string, show: boolean) => {
    const { setRailRings, setRailHidden } = useQuotaStore.getState();
    const next = show ? [...shown, key] : shown.filter((k) => k !== key);
    // What is left out is what is stored, so an account added later shows by itself.
    void setRailHidden(next.length === 0 ? [] : keys.filter((k) => !next.includes(k)));
    if ((next.length > 0) !== on) void setRailRings(next.length > 0);
  };
  return (
    <div className="shrink-0 border-t border-[var(--cf-border)] px-3 py-2">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 rounded-md text-left outline-none focus-visible:shadow-[0_0_0_2px_var(--cf-accent-line)]">
        <PanelLeft size={13} className="shrink-0 text-[var(--cf-text-muted)]" />
        <b className="min-w-0 flex-1 truncate text-[11.5px] font-medium">{t("quota.railPickTitle")}</b>
        <span className="shrink-0 text-[10.5px] tabular-nums text-[var(--cf-text-muted)]">{shown.length === 0 ? t("quota.railPickNone") : t("quota.railPickCount", { n: shown.length })}</span>
        <ChevronDown size={13} className={`shrink-0 text-[var(--cf-text-muted)] transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <>
          <p className="mt-1 text-[10.5px] leading-snug text-[var(--cf-text-muted)]">{t("quota.railPickHint")}</p>
          <div className="mt-1.5 grid max-h-[112px] grid-cols-2 gap-x-3 gap-y-1 overflow-y-auto">
            {choices.map((quota) => {
              const key = quotaKey(quota);
              return (
                <label key={key} className="flex min-w-0 cursor-pointer items-center gap-1.5" title={names.full(quota)}>
                  <Checkbox checked={shown.includes(key)} onChange={(value) => toggle(key, value)} />
                  <ProviderGlyph providerId={quota.provider} size={12} />
                  <span className="min-w-0 truncate text-[11.5px] text-[var(--cf-text)]">{names.full(quota)}</span>
                </label>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

/** How often what counts down re-renders: nothing on screen shows less than a minute. */
const TICK_MS = 30_000;

export function QuotaPanel() {
  const t = useT();
  const providers = useQuotaStore((s) => s.providers);
  const loading = useQuotaStore((s) => s.loading);
  const fetched = useQuotaStore((s) => s.fetched);
  const lastReadAt = useQuotaStore((s) => s.lastReadAt);
  const refresh = useQuotaStore((s) => s.refresh);
  const ensureAccounts = useAiAccountsStore((s) => s.ensure);
  const [tab, setTab] = useState<"summary" | "accounts">("summary");
  const overview = useMemo(() => quotaOverview(providers), [providers]);

  useEffect(() => {
    void ensureAccounts();
  }, [ensureAccounts]);
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), TICK_MS);
    return () => clearInterval(id);
  }, []);

  const age = ageOf(lastReadAt);
  const synced = loading ? t("quota.refreshing") : age === null ? t("quota.notSynced") : age === "now" ? t("quota.syncedNow") : t("quota.syncedAgo", { minutes: age });
  const iconButton = "flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[var(--cf-border)] text-[var(--cf-text-muted)] outline-none hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)] focus-visible:shadow-[0_0_0_2px_var(--cf-accent-line)] disabled:opacity-60 disabled:hover:bg-transparent";
  const empty = providers.length === 0;

  return (
    <>
      <div className="flex shrink-0 items-center gap-2.5 px-3 pb-2.5 pt-3">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[10px] bg-[color-mix(in_oklab,var(--cf-accent)_14%,transparent)] text-[var(--cf-accent)]">
          <BarChart3 size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <b className="block truncate text-[13.5px] font-semibold leading-tight">{t("quota.panelTitle")}</b>
          <span className="block truncate text-[10.5px] text-[var(--cf-text-muted)]">{synced}</span>
        </div>
        {/* `"refresh"` — bypasses the backend cache. Without it a press inside the cache window
            returns the same numbers instantly, which reads as a dead button. */}
        <button type="button" onClick={() => void refresh("refresh")} disabled={loading} title={t("quota.refresh")} aria-label={t("quota.refresh")} className={iconButton}>
          <RefreshCw size={13} className={loading ? "animate-spin" : undefined} />
        </button>
        <button type="button" onClick={() => useUiStore.getState().openSettingsAt("claude", "limits")} title={t("quota.openSettings")} aria-label={t("quota.openSettings")} className={iconButton}>
          <SlidersHorizontal size={13} />
        </button>
      </div>

      {loading && !fetched ? (
        <p className="px-3 pb-3 text-[11px] text-[var(--cf-text-muted)]">{t("quota.loading")}</p>
      ) : empty ? (
        // No engine on this machine publishes a limit — the one case with nothing to count.
        <p className="px-3 pb-3 text-[11px] text-[var(--cf-text-muted)]">{t("quota.none")}</p>
      ) : (
        <>
          <div className="grid shrink-0 grid-cols-3 gap-1.5 px-3">
            <Stat label={t("quota.statAccounts")} value={overview.accounts.length} hint={t("quota.statProviders", { n: overview.providers.length })} />
            <Stat label={t("quota.statAvailable")} value={overview.available} hint={t("quota.statAvailableHint")} tone={overview.available > 0 ? "var(--cf-success)" : undefined} />
            <Stat label={t("quota.statCritical")} value={overview.critical} hint={overview.critical > 0 ? t("quota.statCriticalHint") : t("quota.statCriticalNone")} tone={overview.critical > 0 ? "#f97316" : undefined} />
          </div>

          <div role="tablist" className="mx-3 mt-2.5 grid shrink-0 grid-cols-2 gap-0.5 rounded-lg bg-[var(--cf-press)] p-0.5">
            {(["summary", "accounts"] as const).map((id) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                onClick={() => setTab(id)}
                className={`h-6 rounded-md text-[11.5px] outline-none transition-colors focus-visible:shadow-[0_0_0_2px_var(--cf-accent-line)] ${tab === id ? "bg-[var(--cf-surface)] font-medium text-[var(--cf-text)] shadow-[0_1px_2px_rgba(0,0,0,0.12)]" : "text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"}`}
              >
                {id === "summary" ? t("quota.tabSummary") : t("quota.tabAccounts")}
              </button>
            ))}
          </div>

          <div role="tabpanel" className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
            {tab === "summary" ? <Summary providers={providers} /> : <Accounts providers={providers} />}
          </div>

          <RailPicker providers={providers} />
        </>
      )}

      {/* Where the other half is. Tokens and cost are not here: two kinds of number in one small
          panel meant reading which was which every time, and only one of them can run out. */}
      <p className="flex shrink-0 items-center gap-1.5 border-t border-[var(--cf-border)] px-3 py-2 text-[10.5px] leading-snug text-[var(--cf-text-muted)]">
        <Info size={12} className="shrink-0" />
        {t("quota.spendMovedHint")}
      </p>
    </>
  );
}
