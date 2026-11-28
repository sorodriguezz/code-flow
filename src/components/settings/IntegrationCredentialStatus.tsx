import { useState } from "react";
import { AlertTriangle, CalendarClock, Check, Loader2, RefreshCw } from "lucide-react";
import { ApiModal, GhostButton, PrimaryButton } from "../api/ApiModal";
import { DateField } from "../common/DateField";
import { chipClass, type ChipTone } from "../common/recipes";
import { Tooltip } from "../common/Tooltip";
import { expiryOf, statusOf, type IntegrationStatus } from "../../lib/integrationCredentialStatus";
import type { TranslationKey } from "../../lib/i18n/translations";
import { useLanguageStore, useT } from "../../state/languageStore";
import {
  integrationCredentialKey, recheckIntegrationCredential, saveIntegrationExpiration,
  useIntegrationCredentialStore, type IntegrationCredential,
} from "../../state/integrationCredentialStore";
import { pushErrorToast } from "../../state/toastStore";

const STATUS: Record<IntegrationStatus, { label: TranslationKey; tone: ChipTone }> = {
  valid: { label: "settings.connected", tone: "ok" },
  pending: { label: "integrations.credential.pending", tone: "neutral" },
  expiring: { label: "integrations.credential.expiring", tone: "warn" },
  expired: { label: "integrations.credential.expired", tone: "bad" },
  rejected: { label: "integrations.credential.rejected", tone: "bad" },
  access_denied: { label: "integrations.credential.accessDenied", tone: "warn" },
  missing: { label: "integrations.credential.missing", tone: "bad" },
  unavailable: { label: "integrations.credential.unavailable", tone: "neutral" },
};

function dateTimeInput(value: number | undefined): string {
  if (value === undefined) return "";
  const date = new Date(value);
  return new Date(value - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 19);
}

export function IntegrationCredentialStatus(credential: IntegrationCredential) {
  const t = useT();
  const language = useLanguageStore((s) => s.language);
  const key = integrationCredentialKey(credential);
  const health = useIntegrationCredentialStore((s) => {
    const entry = s.entries[key];
    return entry?.revision === (credential.revision ?? "") ? entry : undefined;
  });
  const checking = useIntegrationCredentialStore((s) => s.checking[key]);
  const status = useIntegrationCredentialStore((s) => statusOf(health, s.now));
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const { label, tone } = STATUS[status];
  const Icon = checking ? Loader2 : tone === "ok" ? Check : tone === "neutral" ? RefreshCw : AlertTriangle;
  const expiry = expiryOf(health);
  const date = expiry === undefined ? undefined : new Intl.DateTimeFormat(language, {
    dateStyle: "medium", timeStyle: "short",
  }).format(expiry);
  const dateLabel = date ?? t("integrations.credential.expiration");
  const providerExpiry = health?.providerExpiry !== undefined;
  const expiryDetail = providerExpiry ? t("integrations.credential.detectedExpiration", { date: dateLabel }) : undefined;
  const parsed = draft ? new Date(draft).getTime() : undefined;

  const save = async () => {
    setSaving(true);
    try {
      await saveIntegrationExpiration(credential, parsed);
      setDraft(null);
    } catch {
      pushErrorToast(t("integrations.credential.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      <Tooltip label={t("settings.adoRecheck")}>
        <button
          type="button"
          disabled={checking}
          aria-description={t("settings.adoRecheck")}
          className={chipClass(tone, "min-h-[22px]")}
          onClick={() => void recheckIntegrationCredential(credential).catch(() =>
            pushErrorToast(t("integrations.credential.unavailable"))
          )}
        >
          <Icon size={12} className={checking ? "animate-spin" : undefined} />
          {t(label)}
        </button>
      </Tooltip>
      {providerExpiry ? (
        <span title={expiryDetail} className="flex items-center gap-1 px-1 text-[11px] text-[var(--cf-text-muted)]">
          <CalendarClock size={12} /> {dateLabel}
        </span>
      ) : (
        <Tooltip label={t("integrations.credential.editExpiration")}>
          <button
            type="button"
            aria-label={t("integrations.credential.editExpiration")}
            onClick={() => setDraft(dateTimeInput(expiry))}
            className="flex items-center gap-1 rounded px-1 text-[11px] text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]"
          >
            <CalendarClock size={12} /> {dateLabel}
          </button>
        </Tooltip>
      )}

      {draft !== null && (
        <ApiModal
          icon={CalendarClock}
          title={t("integrations.credential.expiration")}
          subtitle={credential.account}
          width="max-w-sm"
          maxHeight="max-h-[calc(100dvh-3rem)]"
          overDrawers
          autoFocus={false}
          busy={saving}
          onClose={() => setDraft(null)}
          footer={
            <div className="flex w-full flex-wrap items-center gap-2">
              {draft && <GhostButton disabled={saving} onClick={() => setDraft("")}>{t("dateField.clear")}</GhostButton>}
              <div className="ml-auto flex items-center gap-2">
                <GhostButton disabled={saving} onClick={() => setDraft(null)}>{t("common.cancel")}</GhostButton>
                <PrimaryButton disabled={saving || Number.isNaN(parsed)} onClick={() => void save()}>
                  {t("common.save")}
                </PrimaryButton>
              </div>
            </div>
          }
        >
          <div className="min-h-0 overflow-y-auto px-5 py-3.5">
            <fieldset disabled={saving} className="m-0 min-w-0 border-0 p-0">
              <DateField inline withTime value={draft} onChange={setDraft} ariaLabel={t("integrations.credential.expiration")} />
            </fieldset>
            <p className="mt-3 text-[12px] leading-relaxed text-[var(--cf-text-muted)]">
              {t("integrations.credential.manualHint")}
            </p>
          </div>
        </ApiModal>
      )}
    </div>
  );
}
