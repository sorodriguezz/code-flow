import { useEffect, useState } from "react";
import { Check, Lock, RotateCcw, X } from "lucide-react";
import { MIN_AUTO_FETCH_SECONDS, usePreferencesStore } from "../../state/preferencesStore";
import { getGitIdentity, setGitIdentity } from "../../lib/tauri/commands";
import { useT } from "../../state/languageStore";
import { confirmAction } from "../../state/confirmStore";
import { pushErrorToast } from "../../state/toastStore";
import { Checkbox } from "../common/Checkbox";
import { SettingsHeader } from "../api/settingsChrome";

export function GitSettings() {
  const t = useT();
  const autoFetchSeconds = usePreferencesStore((s) => s.autoFetchSeconds);
  const setAutoFetchSeconds = usePreferencesStore((s) => s.setAutoFetchSeconds);
  const secretScanEnabled = usePreferencesStore((s) => s.secretScanEnabled);
  const setSecretScanEnabled = usePreferencesStore((s) => s.setSecretScanEnabled);
  const [draft, setDraft] = useState(autoFetchSeconds || 30);

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [savedName, setSavedName] = useState("");
  const [savedEmail, setSavedEmail] = useState("");
  const [savedIdentity, setSavedIdentity] = useState(false);

  useEffect(() => {
    void getGitIdentity().then((identity) => {
      setName(identity.name ?? "");
      setEmail(identity.email ?? "");
      setSavedName(identity.name ?? "");
      setSavedEmail(identity.email ?? "");
    });
  }, []);

  const enabled = autoFetchSeconds > 0;
  const identityDirty = name.trim() !== savedName || email.trim() !== savedEmail;

  const saveIdentity = async () => {
    await setGitIdentity(name.trim(), email.trim());
    setSavedName(name.trim());
    setSavedEmail(email.trim());
    setSavedIdentity(true);
    setTimeout(() => setSavedIdentity(false), 1500);
  };

  return (
    <section>
      <SettingsHeader title={t("settings.gitTitle")} hint={t("settings.gitHint")} />

      <p className="mb-2 text-[13px] text-[var(--cf-text-muted)]">{t("settings.gitIdentityHint")}</p>
      <div className="mb-1.5 flex gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("settings.name")}
          className="flex-1 rounded-md border border-[var(--cf-border)] bg-transparent px-2.5 py-1.5 text-[13px] outline-none focus:border-[var(--cf-accent)]"
        />
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder={t("settings.email")}
          className="flex-1 rounded-md border border-[var(--cf-border)] bg-transparent px-2.5 py-1.5 text-[13px] outline-none focus:border-[var(--cf-accent)]"
        />
        <button
          onClick={saveIdentity}
          disabled={!name.trim() || !email.trim() || !identityDirty}
          className="flex items-center gap-1.5 rounded-md bg-[var(--cf-accent)] px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-40"
        >
          {savedIdentity ? <Check size={13} /> : null}
          {savedIdentity ? t("settings.saved") : t("common.save")}
        </button>
      </div>

      <p className="mb-4 mt-4 text-[13px] text-[var(--cf-text-muted)]">{t("settings.autoFetchDescription")}</p>

      <label className="mb-2 flex items-center gap-2 text-[13px]">
        <Checkbox checked={enabled} onChange={(checked) => setAutoFetchSeconds(checked ? draft : 0)} />
        {t("settings.autoFetchLabel")}
        <input
          type="number"
          min={MIN_AUTO_FETCH_SECONDS}
          disabled={!enabled}
          value={draft}
          onChange={(e) => {
            const next = Number(e.target.value) || MIN_AUTO_FETCH_SECONDS;
            setDraft(next);
            if (enabled) setAutoFetchSeconds(next);
          }}
          onBlur={() => enabled && setAutoFetchSeconds(draft)}
          className="w-20 rounded-md border border-[var(--cf-border)] bg-transparent px-2 py-1 text-[13px] outline-none focus:border-[var(--cf-accent)] disabled:opacity-40"
        />
        {t("settings.seconds")}
      </label>
      <p className="text-[11px] text-[var(--cf-text-muted)]">
        {t("settings.autoFetchHint", { n: MIN_AUTO_FETCH_SECONDS })}
      </p>

      <p className="mb-2 mt-4 text-[13px] text-[var(--cf-text-muted)]">{t("settings.secretScanDescription")}</p>
      <label className="mb-1 flex items-center gap-2 text-[13px]">
        <Checkbox checked={secretScanEnabled} onChange={(checked) => setSecretScanEnabled(checked)} />
        {t("settings.secretScanLabel")}
      </label>
      <p className="text-[11px] text-[var(--cf-text-muted)]">{t("settings.secretScanHint")}</p>

      <LockedBranchRules />
    </section>
  );
}

/**
 * The branches that come locked in every repository, without anyone having clicked a padlock.
 *
 * This lives in settings rather than beside the padlock because it is the one part of the feature
 * that isn't about a branch: "nothing merges into main" is true of every repository the user will
 * ever open, and a per-branch switch makes them re-assert it on each one, from memory, before the
 * first mistake rather than after it. The padlock keeps its job — the exception to this list, in
 * both directions — which is why nothing here can lock a branch you have deliberately opened.
 */
function LockedBranchRules() {
  const t = useT();
  const rules = usePreferencesStore((s) => s.lockedBranchRules);
  const setRules = usePreferencesStore((s) => s.setLockedBranchRules);
  const restore = usePreferencesStore((s) => s.restoreLockedBranchRules);
  const reload = usePreferencesStore((s) => s.reloadLockedBranchRules);
  const [draft, setDraft] = useState("");

  // A `null` list is normally the read having failed, but it is also what the store holds for the
  // moment between mount and `init()` resolving. Asking again on mount collapses the two: whichever
  // it was, this is what turns it into a list.
  useEffect(() => {
    if (usePreferencesStore.getState().lockedBranchRules === null) {
      void reload().catch(() => {});
    }
  }, [reload]);

  const save = async (next: string[]) => {
    try {
      await setRules(next);
    } catch (e) {
      pushErrorToast(String(e));
    }
  };

  /** Edits are computed from the store as it is *now*, not from the render that drew the chip: two
   * removals clicked before the first save comes back would otherwise both start from the same
   * snapshot and the second would put the first one's chip back. */
  const edit = (change: (current: string[]) => string[]) => {
    const current = usePreferencesStore.getState().lockedBranchRules;
    if (current === null) return;
    void save(change(current));
  };

  const add = () => {
    const pattern = draft.trim();
    if (!pattern) return;
    setDraft("");
    edit((current) =>
      // Matching is case-insensitive backend-side, so `Develop` next to `develop` would be one rule
      // shown twice. Silently ignored rather than refused — same as the custom-tools chips.
      current.some((r) => r.toLowerCase() === pattern.toLowerCase()) ? current : [...current, pattern],
    );
  };

  // `null` is "we don't know what the rules are", not "there are none" — so nothing here offers to
  // save a list, which at this point could only be a list built on top of a blank the backend
  // never agreed to. The rules themselves are still being enforced; it's only this screen that is
  // in the dark, and the way out is to ask again.
  if (rules === null) {
    return (
      <>
        <p className="mb-2 mt-4 text-[13px] text-[var(--cf-text-muted)]">
          {t("settings.lockedBranchesDescription")}
        </p>
        <div className="flex items-center gap-2">
          <p className="text-[11px] text-[var(--cf-text-muted)]">{t("settings.lockedBranchesUnavailable")}</p>
          <button
            onClick={() => void reload().catch((e) => pushErrorToast(String(e)))}
            className="flex shrink-0 items-center gap-1 text-[11px] text-[var(--cf-text-muted)] hover:text-[var(--cf-accent)]"
          >
            <RotateCcw size={11} />
            {t("settings.lockedBranchesReload")}
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="mb-2 mt-4 flex items-start justify-between gap-3">
        <p className="text-[13px] text-[var(--cf-text-muted)]">{t("settings.lockedBranchesDescription")}</p>
        {/* Asked first, like the review engine's reset and unlike the prompt templates': this one
            discards a list the user typed, and there is nothing to undo it with. */}
        <button
          onClick={async () => {
            if (!(await confirmAction(t("settings.lockedBranchesRestoreConfirm"), true, t("settings.lockedBranchesRestore")))) {
              return;
            }
            await restore().catch((e) => pushErrorToast(String(e)));
          }}
          className="flex shrink-0 items-center gap-1 text-[11px] text-[var(--cf-text-muted)] hover:text-[var(--cf-accent)]"
        >
          <RotateCcw size={11} />
          {t("settings.lockedBranchesRestore")}
        </button>
      </div>

      {rules.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {rules.map((rule) => (
            <span
              key={rule}
              className="flex items-center gap-1 rounded-md bg-[var(--cf-accent-soft)] px-2 py-0.5 font-mono text-[11px] text-[var(--cf-accent)]"
            >
              <Lock size={10} className="shrink-0 opacity-70" />
              {rule}
              <button
                title={t("settings.lockedBranchesRemove", { pattern: rule })}
                onClick={() => edit((current) => current.filter((r) => r !== rule))}
                className="hover:opacity-70"
              >
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      ) : (
        // Worth saying out loud: an empty list is a supported answer that survives a restart, and
        // "no chips" on its own is indistinguishable from a list that failed to load.
        <p className="text-[11px] text-[var(--cf-text-muted)]">{t("settings.lockedBranchesEmpty")}</p>
      )}

      <div className="mt-2 flex gap-1.5">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            add();
          }}
          placeholder={t("settings.lockedBranchesPlaceholder")}
          className="flex-1 rounded-md border border-[var(--cf-border)] bg-transparent px-2.5 py-1.5 font-mono text-[13px] outline-none focus:border-[var(--cf-accent)]"
        />
        <button
          onClick={add}
          disabled={!draft.trim()}
          className="rounded-md border border-[var(--cf-border)] px-2.5 text-[12px] text-[var(--cf-text-muted)] hover:bg-black/[0.03] disabled:opacity-40 dark:hover:bg-white/[0.04]"
        >
          {t("settings.add")}
        </button>
      </div>
      <p className="mt-1 text-[11px] leading-snug text-[var(--cf-text-muted)]">
        {t("settings.lockedBranchesHint")}
      </p>
    </>
  );
}
