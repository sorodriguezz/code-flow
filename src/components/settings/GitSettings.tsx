import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { MIN_AUTO_FETCH_SECONDS, usePreferencesStore } from "../../state/preferencesStore";
import { getGitIdentity, setGitIdentity } from "../../lib/tauri/commands";
import { useT } from "../../state/languageStore";
import { Checkbox } from "../common/Checkbox";
import { buttonClass } from "../common/Button";
import { fieldClass } from "../common/recipes";
import { LockedBranchRules } from "./LockedBranchRules";
import { WorkspaceIdentities } from "./WorkspaceIdentities";
import { RailSection } from "./settingsNav";

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

  // The pane hints carry the one-line descriptions that used to sit above each control.
  return (
    <RailSection section="git" title={t("settings.gitTitle")} hint={t("settings.gitHint")} fallback="identity">
      {(tab) => (
        <>
          {tab === "identity" && (
            <>
              <div className="mb-1.5 flex items-center gap-2">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t("settings.name")}
                  className={fieldClass({ className: "flex-1" })}
                />
                <input
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder={t("settings.email")}
                  className={fieldClass({ className: "flex-1" })}
                />
                <button
                  type="button"
                  onClick={saveIdentity}
                  disabled={!name.trim() || !email.trim() || !identityDirty}
                  className={buttonClass({ variant: "primary", size: "md" })}
                >
                  {savedIdentity ? <Check size={13} /> : null}
                  {savedIdentity ? t("settings.saved") : t("common.save")}
                </button>
              </div>

              <WorkspaceIdentities />
            </>
          )}

          {tab === "fetch" && (
            <>
              <label className="mb-2 flex items-center gap-2.5 text-[13px] text-[var(--cf-text)]">
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
                  className={fieldClass({ size: "sm", className: "w-20 tabular-nums" })}
                />
                {t("settings.seconds")}
              </label>
              <p className="pl-[26px] text-[11px] leading-snug text-[var(--cf-text-muted)]">
                {t("settings.autoFetchHint", { n: MIN_AUTO_FETCH_SECONDS })}
              </p>
            </>
          )}

          {tab === "secrets" && (
            <>
              <label className="mb-1 flex items-center gap-2.5 text-[13px] text-[var(--cf-text)]">
                <Checkbox checked={secretScanEnabled} onChange={(checked) => setSecretScanEnabled(checked)} />
                {t("settings.secretScanLabel")}
              </label>
              <p className="pl-[26px] text-[11px] leading-snug text-[var(--cf-text-muted)]">{t("settings.secretScanHint")}</p>
            </>
          )}

          {/* Under Git rather than Appearance, and it is not an obvious call: the thing this switches
              on is a git read — a blame walk — rather than a colour. The `<label>` wrapper is what
              makes the text clickable, since `Checkbox` is a hidden real input under a styled span. */}
          {tab === "blame" && (
            <>
              <label className="mb-1 flex items-center gap-2.5 text-[13px] text-[var(--cf-text)]">
                <Checkbox checked={blameAnnotationEnabled} onChange={(checked) => setBlameAnnotationEnabled(checked)} />
                {t("settings.blameLabel")}
              </label>
              <p className="pl-[26px] text-[11px] leading-snug text-[var(--cf-text-muted)]">{t("settings.blameHint")}</p>
            </>
          )}

          {tab === "locked" && <LockedBranchRules bare />}
        </>
      )}
    </RailSection>
  );
}
