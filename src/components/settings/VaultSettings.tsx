/**
 * The keyring's section in the Settings window.
 *
 * It exists because its settings did not live here: the auto-lock timer, whether this machine
 * remembers the master password and how to change it were all inside a modal reachable only from
 * the keyring's own toolbar. That is a reasonable place to *put* them and the worst possible place
 * to *look* for them — "how long before it locks itself" is an application preference, and every
 * other application preference in this app is behind one window.
 *
 * The modal stays for the one moment Settings cannot serve: the lock screen's "I have lost my
 * master password" link, where the vault is closed and the reset is the only door.
 *
 * The health report below the controls is the part that is new rather than moved.
 */

import { useEffect, useState } from "react";
import {
  AlertTriangle,
  Clock,
  Copy,
  KeyRound,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import { keyvaultPasswordHealth } from "../../lib/tauri/keyvaultCommands";
import { useT, type Translate } from "../../state/languageStore";
import { useUiStore } from "../../state/uiStore";
import { useVaultStore } from "../../state/vaultStore";
import { VaultSettingsBody } from "../vault/VaultSettingsModal";
import { Group, Note, SettingsHeader } from "../api/settingsChrome";
import { Skeleton } from "../common/Skeleton";
import type { PasswordHealth, PasswordVerdict } from "../../types/vault";

/**
 * A row's problems, as words rather than three icons to decode.
 *
 * Returned with their glyph attached rather than matched back by string later: comparing a rendered
 * label against another rendered label to decide which icon to draw breaks the moment a translation
 * changes, and breaks silently.
 */
function problemsOf(verdict: PasswordVerdict, t: Translate): { icon: LucideIcon; text: string }[] {
  const out: { icon: LucideIcon; text: string }[] = [];
  if (verdict.reuse_group !== null) out.push({ icon: Copy, text: t("vault.healthReused") });
  if (verdict.weak) out.push({ icon: ShieldAlert, text: t("vault.healthWeak") });
  if (verdict.stale) out.push({ icon: Clock, text: t("vault.healthStale", { days: verdict.age_days }) });
  return out;
}

function HealthReport() {
  const t = useT();
  const unlocked = useVaultStore((s) => s.unlocked);
  const setActiveView = useUiStore((s) => s.setActiveView);
  const closeSettings = useUiStore((s) => s.closeSettings);

  const [health, setHealth] = useState<PasswordHealth | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");

  const run = async () => {
    setRunning(true);
    setError("");
    try {
      setHealth(await keyvaultPasswordHealth());
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
    }
  };

  // Runs on arrival when the vault is already open, because a report you have to ask for is a
  // report nobody sees. Locked, it waits — every read here needs the key.
  useEffect(() => {
    if (unlocked) void run();
    else setHealth(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unlocked]);

  if (!unlocked) {
    return <Note>{t("vault.healthLocked")}</Note>;
  }

  if (running && !health) {
    return (
      <div className="space-y-1.5" aria-hidden>
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
    );
  }

  if (error) return <Note tone="warning">{error}</Note>;
  if (!health) return null;

  const flagged = health.verdicts.filter(
    (verdict) => verdict.reuse_group !== null || verdict.weak || verdict.stale,
  );

  return (
    <>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 text-[12px] leading-snug text-[var(--cf-text)]">
          {flagged.length === 0
            ? t("vault.healthAllGood", { n: health.checked })
            : t("vault.healthSummary", { flagged: flagged.length, checked: health.checked })}
        </p>
        <button
          type="button"
          onClick={() => void run()}
          disabled={running}
          className="flex shrink-0 items-center gap-1 rounded-md border border-[var(--cf-border)] px-2 py-1 text-[11px] text-[var(--cf-text-muted)] transition-colors hover:text-[var(--cf-text)] disabled:opacity-50"
        >
          <RefreshCw size={11} className={running ? "animate-spin" : ""} />
          {t("vault.healthRecheck")}
        </button>
      </div>

      {flagged.length === 0 ? (
        <p className="flex items-center gap-1.5 rounded-md bg-[color-mix(in_oklab,var(--cf-success)_10%,transparent)] px-2.5 py-2 text-[11.5px] text-[var(--cf-success)]">
          <ShieldCheck size={12} className="shrink-0" />
          {t("vault.healthNothingToDo")}
        </p>
      ) : (
        <ul className="space-y-1">
          {flagged.map((verdict) => (
            <li key={verdict.item_id}>
              <button
                type="button"
                onClick={() => {
                  // The report says which entries; fixing one happens in the keyring itself.
                  void useVaultStore.getState().openItem(verdict.item_id);
                  setActiveView("vault");
                  closeSettings();
                }}
                className="flex w-full items-start gap-2 rounded-md border border-[var(--cf-border)] px-2 py-1.5 text-left transition-colors hover:border-[var(--cf-accent)]/50"
              >
                <AlertTriangle size={12} className="mt-[3px] shrink-0 text-[var(--cf-warning)]" />
                <span className="min-w-0 flex-1">
                  {/* Wraps: an entry title is what identifies the row, and half of one identifies
                      nothing. */}
                  <span className="block break-words text-[12px] leading-snug text-[var(--cf-text)]">
                    {verdict.title}
                  </span>
                  <span className="mt-px flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] leading-snug text-[var(--cf-text-muted)]">
                    {problemsOf(verdict, t).map(({ icon: ProblemIcon, text }) => (
                      <span key={text} className="flex items-center gap-1">
                        <ProblemIcon size={10} className="shrink-0" />
                        {text}
                      </span>
                    ))}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-2 text-[10.5px] leading-snug text-[var(--cf-text-muted)]">
        {t("vault.healthPrivacyNote")}
      </p>
    </>
  );
}

export function VaultSettings() {
  const t = useT();
  return (
    <section>
      <SettingsHeader title={t("tabbar.vault")} hint={t("vault.settingsHint")} />

      <Group title={t("vault.healthTitle")}>
        <p className="mb-2 text-[11.5px] leading-snug text-[var(--cf-text-muted)]">{t("vault.healthHint")}</p>
        <HealthReport />
      </Group>

      <Group title={t("vault.settings")}>
        <VaultSettingsBody />
      </Group>

      <p className="mt-3 flex items-start gap-1.5 text-[11px] leading-snug text-[var(--cf-text-muted)]">
        <KeyRound size={11} className="mt-[2px] shrink-0" />
        {t("vault.settingsFooter")}
      </p>
    </section>
  );
}
