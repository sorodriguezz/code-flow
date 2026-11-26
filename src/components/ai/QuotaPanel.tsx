import { useEffect, useId, useMemo, useRef, useState } from "react";
import { BarChart3, ChevronDown, ListFilter, PanelLeft, RefreshCw, Search, SlidersHorizontal, X } from "lucide-react";
import { providerDisplayLabel } from "../../lib/aiProviders";
import type { AccountNamer } from "../../lib/aiAccounts";
import type { TranslationKey } from "../../lib/i18n/translations";
import {
  AVAILABILITY_ORDER,
  accountAvailability,
  availabilityOf,
  needsAttention,
  type AccountState,
  type Availability,
} from "../../lib/quotaOverview";
import type { AiAccount } from "../../lib/tauri/accountCommands";
import { useAccountName, useAiAccountsStore } from "../../state/aiAccountsStore";
import { useLanguageStore, useT } from "../../state/languageStore";
import { ageOf, formatResetAt, formatResetIn, formatUsed, missingClaudeSession, missingClaudeWeekly, quotaBlocks, quotaKey, railWindows, useQuotaStore } from "../../state/quotaStore";
import { useUiStore } from "../../state/uiStore";
import type { ProviderQuota, QuotaLimit } from "../../types/domain";
import { buttonClass, iconButtonClass } from "../common/Button";
import { Checkbox } from "../common/Checkbox";
import { Select } from "../common/Select";
import { ProviderGlyph } from "./ProviderGlyph";
import { FromRunNote, MissingQuota, emptyMessage, isPending, limitLabel, narrowedKinds, quotaAccountLabel } from "./QuotaLimits";

type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string;

/** How each state is drawn, the same wherever it is: a dot, a segment, a figure. */
const AVAILABILITY_COLOUR: Record<Availability, string> = {
  available: "var(--cf-success)",
  moderate: "#7c86a8",
  near: "var(--cf-warning)",
  critical: "var(--cf-danger)",
  exhausted: "var(--cf-danger)",
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

type Sort = "" | "use" | "name" | "reset";

function Filter<T extends string>({ label, value, onChange, options, popupId }: { label: string; value: T; onChange: (value: T) => void; options: { value: T; label: string }[]; popupId: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-[11px] font-medium text-[var(--cf-text-muted)]">{label}</span>
      <Select
        ariaLabel={label}
        value={value}
        options={options}
        popupOwnerId={popupId}
        onChange={(next) => {
          const option = options.find(({ value }) => value === next);
          if (option) onChange(option.value);
        }}
        size="compact"
        style={value ? { backgroundColor: "var(--cf-accent-soft)" } : undefined}
      />
    </div>
  );
}

function QuotaWindow({ limit, label, now }: { limit: QuotaLimit; label: string; now: number }) {
  const t = useT();
  const language = useLanguageStore((s) => s.language);
  const left = formatResetIn(limit.resets_at, now);
  const at = formatResetAt(limit.resets_at, now, language, "calendar");
  const reset = left ? t("quota.resetsIn", { time: left }) : t("quota.resetUnknown");
  const status = availabilityOf(limit.used_percent);
  const attention = needsAttention(status);
  const colour = attention ? AVAILABILITY_COLOUR[status] : "var(--cf-accent)";

  return (
    <li className="grid grid-cols-[minmax(0,1fr)_2.75rem_3.5rem] items-start gap-x-2 gap-y-0.5 text-[11.5px] leading-4 @[320px]:grid-cols-[minmax(0,1fr)_2.75rem_clamp(2rem,15cqw,4.25rem)_3.5rem]">
      <span className="col-start-1 row-start-1 min-w-0 text-[var(--cf-text-muted)] [overflow-wrap:anywhere]">
        {label}
      </span>
      <b className="col-start-2 row-start-1 text-right font-semibold tabular-nums" style={attention ? { color: colour } : undefined}>
        {formatUsed(limit.used_percent)}
      </b>
      <span aria-hidden className="col-span-full row-start-2 flex h-2 items-center @[320px]:col-[3/4] @[320px]:row-start-1 @[320px]:h-4">
        <span className="h-1 w-full overflow-hidden rounded-full bg-[var(--cf-press)]">
          <span className="block h-full rounded-full transition-[width]" style={{ width: `${Math.min(100, Math.max(0, limit.used_percent))}%`, backgroundColor: colour }} />
        </span>
      </span>
      <span className="col-start-3 row-start-1 whitespace-nowrap text-right tabular-nums text-[var(--cf-text-muted)] @[320px]:col-start-4" title={reset}>
        <span className="sr-only">{reset}</span>
        <span aria-hidden>{left ?? "—"}</span>
      </span>
      {at && (
        <time dateTime={limit.resets_at} className="col-span-full row-start-3 text-[10.5px] leading-[14px] tabular-nums text-[var(--cf-text-muted)] @[320px]:row-start-2">
          <span className="sr-only">{t("quota.resetsOn", { when: at.text })}</span>
          <span aria-hidden>{at.text}</span>
        </time>
      )}
    </li>
  );
}

/** One account of a provider: who, on which plan, and each of its windows. */
function AccountRow({ account, name }: { account: AccountState; name: string }) {
  const t = useT();
  const { quota, status } = account;
  const now = Date.now();
  const narrowed = narrowedKinds(quota);
  return (
    <li className="px-1 py-2.5">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: AVAILABILITY_COLOUR[status] }} title={t(BAND_LABEL[status])} />
          <b className="text-[12px] font-semibold [overflow-wrap:anywhere]">{name}</b>
        </span>
        {quota.plan && <span className="rounded bg-[var(--cf-press)] px-1.5 py-px text-[9.5px] font-medium uppercase tracking-wide text-[var(--cf-text-muted)]">{quota.plan}</span>}
        <span className={needsAttention(status) ? "ml-auto text-[11px] font-medium" : "sr-only"} style={{ color: AVAILABILITY_COLOUR[status] }}>
          {t(BAND_LABEL[status])}
        </span>
      </div>
      {quota.limits.length === 0 ? (
        <p className="mt-1 pl-3 text-[11.5px] leading-snug text-[var(--cf-text-muted)]">{isPending(quota) ? t("quota.reading") : emptyMessage(quota.error, t)}</p>
      ) : (
        <div className="mt-2 space-y-1.5 pl-3">
          {missingClaudeSession(quota) && <MissingQuota label={t("quota.session")} />}
          <ul className="space-y-2">
            {quotaBlocks(quota).map(({ limit }) => (
              <QuotaWindow key={`${limit.kind}|${limit.scope}`} limit={limit} label={limitLabel(limit, narrowed, t) || limit.kind} now={now} />
            ))}
          </ul>
          {missingClaudeWeekly(quota) && <MissingQuota label={t("quota.weekly")} />}
          {quota.error.startsWith("from_run") && <FromRunNote quota={quota} />}
        </div>
      )}
    </li>
  );
}

function Accounts({ providers, popupId }: { providers: ProviderQuota[]; popupId: string }) {
  const t = useT();
  const names = useNaming();
  const byProvider = useMemo(() => {
    const groups = new Map<string, AccountState[]>();
    for (const quota of providers) {
      const accounts = groups.get(quota.provider) ?? [];
      accounts.push({ quota, ...accountAvailability(quota) });
      groups.set(quota.provider, accounts);
    }
    return [...groups];
  }, [providers]);
  const search = useRef<HTMLInputElement>(null);
  const filtersId = useId();
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState("");
  const [status, setStatus] = useState<Availability | "">("");
  const [sort, setSort] = useState<Sort>("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [folds, setFolds] = useState<{ scope: string; providers: Record<string, boolean> }>({ scope: "", providers: {} });

  const wanted = query.trim().toLocaleLowerCase();
  const expandMatches = Boolean(wanted || provider || status);
  const scope = JSON.stringify([wanted, provider, status]);
  const filterCount = Number(Boolean(provider)) + Number(Boolean(status)) + Number(Boolean(sort));
  const now = Date.now();
  const nextReset = ({ quota }: AccountState) =>
    quota.limits.reduce((soonest, limit) => {
      const time = Date.parse(limit.resets_at);
      return time > now ? Math.min(soonest, time) : soonest;
    }, Infinity);
  const byName = (a: string, b: string) => a.localeCompare(b);
  const compare = sort === "use" ? (a: AccountState, b: AccountState) => (b.limit?.used_percent ?? -1) - (a.limit?.used_percent ?? -1)
    : sort === "reset" ? (a: AccountState, b: AccountState) => nextReset(a) - nextReset(b)
    : sort === "name" ? (a: AccountState, b: AccountState) => byName(names.account(a.quota), names.account(b.quota))
    : null;
  const groups = byProvider
    .filter(([id]) => !provider || provider === id)
    .map(([id, accounts]) => {
      const name = providerDisplayLabel(id, t);
      const shown = accounts.filter(({ quota, status: band }) =>
        (!status || band === status)
        && (!wanted || `${name} ${names.account(quota)} ${quota.plan}`.toLocaleLowerCase().includes(wanted)),
      );
      if (compare) shown.sort(compare);
      return { id, name, shown };
    })
    .filter(({ shown }) => shown.length > 0);
  if (sort === "name") groups.sort((a, b) => byName(a.name, b.name));
  else if (compare) groups.sort((a, b) => compare(a.shown[0], b.shown[0]));

  const clearFilters = () => {
    setProvider("");
    setStatus("");
    setSort("");
  };
  const clearSearch = () => {
    setQuery("");
    search.current?.focus();
  };

  return (
    <>
      <div className="shrink-0 border-b border-[var(--cf-border)] px-4 pb-3">
        <div className="flex gap-2">
          <div className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-2.5 focus-within:border-[var(--cf-accent)] focus-within:ring-2 focus-within:ring-[var(--cf-accent-line)]">
            <Search size={14} aria-hidden className="shrink-0 text-[var(--cf-text-muted)]" />
            <input
              ref={search}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("quota.search")}
              aria-label={t("quota.search")}
              className="min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:text-[var(--cf-text-muted)]"
            />
            {query && (
              <button type="button" onClick={clearSearch} aria-label={t("quota.clearSearch")} title={t("quota.clearSearch")} className={iconButtonClass({ size: "xs", className: "-mr-1" })}>
                <X size={12} />
              </button>
            )}
          </div>
          <button
            type="button"
            aria-label={filterCount ? t("quota.activeFilters", { n: filterCount }) : t("quota.filters")}
            aria-expanded={filtersOpen}
            aria-controls={filtersId}
            onClick={() => setFiltersOpen(!filtersOpen)}
            className={buttonClass({ variant: "secondary", size: "lg", className: `px-2.5 text-[12px] ${filtersOpen || filterCount ? "text-[var(--cf-accent)]" : ""}` })}
          >
            <ListFilter size={14} aria-hidden />
            <span className="hidden @[300px]:inline">{t("quota.filters")}</span>
            {filterCount > 0 && <span className="tabular-nums">{filterCount}</span>}
          </button>
        </div>
        <div id={filtersId} hidden={!filtersOpen}>
          {filtersOpen && (
            <>
              <div className="mt-2.5 grid grid-cols-2 gap-2 @[350px]:grid-cols-3">
                <Filter popupId={popupId} label={t("quota.filterProvider")} value={provider} onChange={setProvider} options={[{ value: "", label: t("quota.filterAny") }, ...byProvider.map(([id]) => ({ value: id, label: providerDisplayLabel(id, t) }))]} />
                <Filter<Availability | ""> popupId={popupId} label={t("quota.filterStatus")} value={status} onChange={setStatus} options={[{ value: "", label: t("quota.filterAny") }, ...AVAILABILITY_ORDER.map((value) => ({ value, label: t(BAND_LABEL[value]) }))]} />
                <Filter<Sort> popupId={popupId} label={t("quota.sort")} value={sort} onChange={setSort} options={[{ value: "", label: t("quota.sortDefault") }, { value: "use", label: t("quota.sortUse") }, { value: "name", label: t("quota.sortName") }, { value: "reset", label: t("quota.sortReset") }]} />
              </div>
              {filterCount > 0 && (
                <button type="button" onClick={clearFilters} className="mt-2 text-[11px] font-medium text-[var(--cf-accent)] hover:underline">
                  {t("quota.clearFilters")}
                </button>
              )}
            </>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 divide-y divide-[var(--cf-border)] overflow-y-auto overscroll-contain px-4">
        {groups.length === 0 && (
          <div className="py-8 text-center">
            <p role="status" className="text-[12px] text-[var(--cf-text-muted)]">{t("quota.noMatches")}</p>
            <button type="button" onClick={() => { clearFilters(); clearSearch(); }} className="mt-2 text-[12px] font-medium text-[var(--cf-accent)] hover:underline">
              {t("quota.clearSearchAndFilters")}
            </button>
          </div>
        )}
        {groups.map(({ id, name, shown }) => {
          const open = (folds.scope === scope ? folds.providers[id] : undefined) ?? expandMatches;
          const bands = new Set(shown.map((account) => account.status));
          return (
            <section key={id} className="py-1.5">
              <button
                type="button"
                aria-expanded={open}
                aria-label={open ? t("quota.collapse", { name }) : t("quota.expand", { name })}
                onClick={() => setFolds((state) => ({ scope, providers: { ...(state.scope === scope ? state.providers : {}), [id]: !open } }))}
                className="flex w-full items-center gap-2 rounded-lg px-1 py-1 text-left outline-none hover:bg-[var(--cf-hover)] focus-visible:ring-2 focus-visible:ring-[var(--cf-accent-line)]"
              >
                <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-[var(--cf-sunken)]">
                  <ProviderGlyph providerId={id} size={15} />
                </span>
                <b className="min-w-0 truncate text-[13px] font-semibold">{name}</b>
                {shown.length > 1 && <span className="shrink-0 text-[11px] text-[var(--cf-text-muted)]">{shown.length} {t("quota.accountsUnit")}</span>}
                <span className="ml-auto flex shrink-0 items-center gap-1">
                  {!open && AVAILABILITY_ORDER.filter((band) => bands.has(band)).map((band) => (
                    <span key={band} className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: AVAILABILITY_COLOUR[band] }} title={t(BAND_LABEL[band])} />
                  ))}
                  <ChevronDown size={14} aria-hidden className={`ml-1 text-[var(--cf-text-muted)] transition-transform ${open ? "rotate-180" : ""}`} />
                </span>
              </button>
              {open && (
                <ul className="divide-y divide-[var(--cf-border)] pl-1">
                  {shown.map((account) => <AccountRow key={quotaKey(account.quota)} account={account} name={names.account(account.quota)} />)}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </>
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
  const choicesId = useId();
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
    <div className="shrink-0 border-t border-[var(--cf-border)] bg-[var(--cf-surface)] px-4 py-1.5">
      <button type="button" aria-expanded={open} aria-controls={choicesId} onClick={() => setOpen(!open)} className="flex min-h-8 w-full items-center gap-2 rounded-lg px-1 text-left outline-none hover:bg-[var(--cf-hover)] focus-visible:ring-2 focus-visible:ring-[var(--cf-accent-line)]">
        <PanelLeft size={15} aria-hidden className="shrink-0 text-[var(--cf-accent)]" />
        <b className="min-w-0 flex-1 text-[12px] font-semibold leading-snug">{t("quota.railPickTitle")}</b>
        <span className="shrink-0 text-[11px] tabular-nums text-[var(--cf-text-muted)]">{shown.length === 0 ? t("quota.railPickNone") : t("quota.railPickCount", { n: shown.length })}</span>
        <ChevronDown size={14} aria-hidden className={`shrink-0 text-[var(--cf-text-muted)] transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      <div id={choicesId} hidden={!open}>
        {open && (
          <div className="grid max-h-[min(9rem,22vh)] grid-cols-1 gap-x-2 overflow-y-auto overscroll-contain px-1 py-1 @[350px]:grid-cols-2">
            {choices.map((quota) => {
              const key = quotaKey(quota);
              const name = names.full(quota);
              return (
                <label key={key} className="flex min-h-8 min-w-0 cursor-pointer items-center gap-2 rounded-md px-1 hover:bg-[var(--cf-hover)]">
                  <Checkbox checked={shown.includes(key)} onChange={(value) => toggle(key, value)} />
                  <ProviderGlyph providerId={quota.provider} size={12} />
                  <span className="min-w-0 text-[11.5px] leading-snug [overflow-wrap:anywhere]">{name}</span>
                </label>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/** How often what counts down re-renders: nothing on screen shows less than a minute. */
const TICK_MS = 30_000;

export function QuotaPanel({ onClose, popupId }: { onClose: () => void; popupId: string }) {
  const t = useT();
  const providers = useQuotaStore((s) => s.providers);
  const loading = useQuotaStore((s) => s.loading);
  const fetched = useQuotaStore((s) => s.fetched);
  const lastReadAt = useQuotaStore((s) => s.lastReadAt);
  const refresh = useQuotaStore((s) => s.refresh);
  const ensureAccounts = useAiAccountsStore((s) => s.ensure);

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
  const iconButton = iconButtonClass({ size: "md", className: "focus-visible:ring-2 focus-visible:ring-[var(--cf-accent-line)]" });
  const empty = providers.length === 0;

  return (
    <>
      <div className="flex shrink-0 items-center gap-2.5 px-4 py-3.5">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]">
          <BarChart3 size={17} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] font-semibold leading-tight">{t("quota.panelTitle")}</h2>
          <p className="mt-0.5 text-[11px] leading-snug text-[var(--cf-text-muted)]">{synced}</p>
        </div>
        {/* `"refresh"` — bypasses the backend cache. Without it a press inside the cache window
            returns the same numbers instantly, which reads as a dead button. */}
        <button type="button" onClick={() => void refresh("refresh")} disabled={loading} title={t("quota.refresh")} aria-label={t("quota.refresh")} className={iconButton}>
          <RefreshCw size={13} className={loading ? "animate-spin" : undefined} />
        </button>
        <button type="button" onClick={() => { onClose(); useUiStore.getState().openSettingsAt("claude", "limits"); }} title={t("quota.openSettings")} aria-label={t("quota.openSettings")} className={iconButton}>
          <SlidersHorizontal size={13} />
        </button>
      </div>

      {loading && !fetched ? (
        <p role="status" className="px-4 pb-4 text-[12px] text-[var(--cf-text-muted)]">{t("quota.loading")}</p>
      ) : empty ? (
        // No engine on this machine publishes a limit — the one case with nothing to count.
        <p className="px-4 pb-4 text-[12px] text-[var(--cf-text-muted)]">{t("quota.none")}</p>
      ) : (
        <>
          <Accounts providers={providers} popupId={popupId} />
          <RailPicker providers={providers} />
        </>
      )}
    </>
  );
}
