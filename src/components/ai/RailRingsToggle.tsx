import { Checkbox } from "../common/Checkbox";
import { useT } from "../../state/languageStore";
import { quotaKey, railWindows, useQuotaStore } from "../../state/quotaStore";
import {
  useAccountName,
  useAiAccountsStore,
} from "../../state/aiAccountsStore";
import { providerDisplayLabel } from "../../lib/aiProviders";
import { quotaAccountLabel } from "./QuotaLimits";
import { ProviderGlyph } from "./ProviderGlyph";

/** The check that puts one ring per account on the rail. The same store value from the status-bar
 * panel and from Settings → Plan limits, so ticking it in one shows ticked in the other. Worded
 * apart from "Show in the status bar" — that one picks *which* limit the pill reports; this one
 * says *whether* the rail draws them all. */
export function RailRingsToggle({ compact = false }: { compact?: boolean }) {
  const t = useT();
  const on = useQuotaStore((s) => s.railRings);
  const setOn = useQuotaStore((s) => s.setRailRings);
  const providers = useQuotaStore((s) => s.providers);
  const hidden = useQuotaStore((s) => s.railHidden);
  const setShown = useQuotaStore((s) => s.setRailShown);
  const accounts = useAiAccountsStore((s) => s.accounts);
  const nameOf = useAccountName();
  // Only the accounts that would draw a ring: one with no session or week has nothing to show.
  const choices = providers.filter((quota) => {
    const { session, long } = railWindows(quota);
    return session || long;
  });
  return (
    <div
      className={
        compact ? "" : "rounded-lg border border-[var(--cf-border)] p-3"
      }
    >
      <label className="flex cursor-pointer items-start gap-2">
        <Checkbox
          checked={on}
          onChange={(v) => void setOn(v)}
          className="mt-0.5"
        />
        <span className="min-w-0">
          <span
            className={`block font-medium text-[var(--cf-text)] ${compact ? "text-[12px]" : "text-[13px]"}`}
          >
            {t("quota.railLabel")}
          </span>
          <span
            className={`block leading-snug text-[var(--cf-text-muted)] ${compact ? "text-[10.5px]" : "text-[11px]"}`}
          >
            {t("quota.railHint")}
          </span>
        </span>
      </label>
      {/* Which accounts get a ring — with several plans, not every one is worth a place on the rail. */}
      {on && choices.length > 1 && (
        <div className="ml-6 mt-1.5 space-y-1">
          {choices.map((quota) => {
            const key = quotaKey(quota);
            const account = quotaAccountLabel(quota, accounts, nameOf);
            return (
              <label
                key={key}
                className="flex cursor-pointer items-center gap-2"
              >
                <Checkbox
                  checked={!hidden.includes(key)}
                  onChange={(v) => void setShown(key, v)}
                />
                <ProviderGlyph providerId={quota.provider} size={12} />
                <span
                  className={`min-w-0 truncate text-[var(--cf-text)] ${compact ? "text-[11.5px]" : "text-[12px]"}`}
                >
                  {providerDisplayLabel(quota.provider, t)}
                  {account && (
                    <span className="text-[var(--cf-text-muted)]">
                      {" "}
                      · {account}
                    </span>
                  )}
                </span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}
