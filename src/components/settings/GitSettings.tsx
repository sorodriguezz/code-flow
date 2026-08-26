import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { MIN_AUTO_FETCH_SECONDS, usePreferencesStore } from "../../state/preferencesStore";
import { getGitIdentity, setGitIdentity } from "../../lib/tauri/commands";
import { useT } from "../../state/languageStore";
import { Checkbox } from "../common/Checkbox";
import { LockedBranchRules } from "./LockedBranchRules";
import { WorkspaceIdentities } from "./WorkspaceIdentities";
import { SettingsHeader } from "../api/settingsChrome";

export function GitSettings() {
  const t = useT();
  const autoFetchSeconds = usePreferencesStore((s) => s.autoFetchSeconds);
  const setAutoFetchSeconds = usePreferencesStore((s) => s.setAutoFetchSeconds);
  const secretScanEnabled = usePreferencesStore((s) => s.secretScanEnabled);
  const setSecretScanEnabled = usePreferencesStore((s) => s.setSecretScanEnabled);
  // Two selectors, never one object selector: a selector returning `{ enabled, set }` builds a fresh
  // object on every store change and re-renders this screen for every unrelated preference.
  const blameAnnotationEnabled = usePreferencesStore((s) => s.blameAnnotationEnabled);
  const setBlameAnnotationEnabled = usePreferencesStore((s) => s.setBlameAnnotationEnabled);
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

      <WorkspaceIdentities />

      <p className="mb-4 mt-6 text-[13px] text-[var(--cf-text-muted)]">{t("settings.autoFetchDescription")}</p>

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

      {/* Here rather than under Appearance, and it is not an obvious call: there is no editor settings
          section at all, `ThemeSettings` has no checkbox in it, and the thing this switches on is a git
          read — a blame walk — rather than a colour. The screen's own hint was widened to say so.
          Same fixed triplet as the two toggles above it (description, label, hint), and the `<label>`
          wrapper is what makes the text clickable, since `Checkbox` is a hidden real input under a
          styled span. */}
      <p className="mb-2 mt-4 text-[13px] text-[var(--cf-text-muted)]">{t("settings.blameDescription")}</p>
      <label className="mb-1 flex items-center gap-2 text-[13px]">
        <Checkbox checked={blameAnnotationEnabled} onChange={(checked) => setBlameAnnotationEnabled(checked)} />
        {t("settings.blameLabel")}
      </label>
      <p className="text-[11px] text-[var(--cf-text-muted)]">{t("settings.blameHint")}</p>

      <LockedBranchRules />
    </section>
  );
}
