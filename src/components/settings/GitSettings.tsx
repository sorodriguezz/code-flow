import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { MIN_AUTO_FETCH_SECONDS, usePreferencesStore } from "../../state/preferencesStore";
import { getGitIdentity, setGitIdentity } from "../../lib/tauri/commands";
import { useT } from "../../state/languageStore";
import { Checkbox } from "../common/Checkbox";

export function GitSettings() {
  const t = useT();
  const autoFetchSeconds = usePreferencesStore((s) => s.autoFetchSeconds);
  const setAutoFetchSeconds = usePreferencesStore((s) => s.setAutoFetchSeconds);
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
      <h3 className="mb-1 text-sm font-semibold">{t("settings.gitTitle")}</h3>

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
    </section>
  );
}
