import { useEffect, useState } from "react";
import { Check, KeyRound, Loader2, Pencil, Trash2 } from "lucide-react";
import { deleteAdoPat, getAdoPat, getSetting, setAdoPat, setSetting } from "../../lib/tauri/commands";
import { pushErrorToast, useToastStore } from "../../state/toastStore";
import { useT } from "../../state/languageStore";

const ORG_SETTING_KEY = "ado_default_org";

// Accepts a bare org name or a pasted `https://dev.azure.com/<org>` /
// `https://<org>.visualstudio.com` URL and reduces it to the bare name — the Azure DevOps
// REST client builds request paths straight from this value, and it rejects URLs.
function normalizeOrg(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, "");
  const devAzureMatch = trimmed.match(/^https?:\/\/dev\.azure\.com\/([^/]+)/i);
  if (devAzureMatch) return devAzureMatch[1];
  const visualStudioMatch = trimmed.match(/^https?:\/\/([^./]+)\.visualstudio\.com/i);
  if (visualStudioMatch) return visualStudioMatch[1];
  return trimmed;
}

export function AzureDevOpsSettings() {
  const t = useT();
  const [org, setOrg] = useState("");
  const [pat, setPat] = useState("");
  const [connected, setConnected] = useState(false);
  const [connectedOrg, setConnectedOrg] = useState("");
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(true);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      const savedOrg = await getSetting(ORG_SETTING_KEY);
      if (savedOrg) {
        setOrg(savedOrg);
        const existing = await getAdoPat(savedOrg);
        if (existing) {
          setConnected(true);
          setConnectedOrg(savedOrg);
          setEditing(false);
        }
      }
      setLoaded(true);
    })();
  }, []);

  const handleSave = async () => {
    if (!org.trim() || !pat.trim()) return;
    setSaving(true);
    try {
      const cleanOrg = normalizeOrg(org);
      await setAdoPat(cleanOrg, pat.trim());
      await setSetting(ORG_SETTING_KEY, cleanOrg);
      setConnected(true);
      setConnectedOrg(cleanOrg);
      setEditing(false);
      setPat("");
      useToastStore.getState().pushToast(t("toast.adoConnected", { org: cleanOrg }), "success");
    } catch (e) {
      pushErrorToast(t("toast.adoSaveFailed", { error: String(e) }));
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async () => {
    if (!connectedOrg) return;
    try {
      await deleteAdoPat(connectedOrg);
      setConnected(false);
      setEditing(true);
      setPat("");
      useToastStore.getState().pushToast(t("toast.adoRemoved"), "info");
    } catch (e) {
      pushErrorToast(t("toast.adoRemoveFailed", { error: String(e) }));
    }
  };

  if (!loaded) return null;

  return (
    <section>
      <h3 className="mb-1 text-sm font-semibold">{t("settings.azureTitle")}</h3>
      <p className="mb-3 text-[13px] text-[var(--cf-text-muted)]">{t("settings.azureHint")}</p>

      {connected && !editing ? (
        <div className="flex items-center gap-3 rounded-lg border border-[var(--cf-border)] p-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]">
            <KeyRound size={15} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-medium">{connectedOrg}</p>
            <p className="font-mono text-[12px] tracking-widest text-[var(--cf-text-muted)]">••••••••••••</p>
          </div>
          <span className="flex shrink-0 items-center gap-1 rounded-full bg-[color-mix(in_oklab,var(--cf-success)_16%,transparent)] px-2 py-0.5 text-[11px] font-medium text-[var(--cf-success)]">
            <Check size={11} /> {t("settings.connected")}
          </span>
          <button
            title={t("settings.changeToken")}
            onClick={() => setEditing(true)}
            className="shrink-0 text-[var(--cf-text-muted)] hover:text-[var(--cf-accent)]"
          >
            <Pencil size={13} />
          </button>
          <button
            title={t("settings.remove")}
            onClick={handleRemove}
            className="shrink-0 text-[var(--cf-text-muted)] hover:text-[var(--cf-danger)]"
          >
            <Trash2 size={13} />
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          <div>
            <label className="mb-1 block text-[12px] font-medium text-[var(--cf-text-muted)]">
              {t("settings.organization")}
            </label>
            <input
              value={org}
              onChange={(e) => setOrg(e.target.value)}
              className="w-full rounded-md border border-[var(--cf-border)] bg-transparent px-2.5 py-1.5 text-[13px] outline-none focus:border-[var(--cf-accent)]"
            />
          </div>
          <div>
            <label className="mb-1 block text-[12px] font-medium text-[var(--cf-text-muted)]">
              {t("settings.personalAccessToken")}
            </label>
            <input
              type="password"
              value={pat}
              onChange={(e) => setPat(e.target.value)}
              className="w-full rounded-md border border-[var(--cf-border)] bg-transparent px-2.5 py-1.5 text-[13px] outline-none focus:border-[var(--cf-accent)]"
            />
          </div>

          <div className="flex items-center gap-2 pt-1">
            <button
              disabled={saving || !org.trim() || !pat.trim()}
              onClick={handleSave}
              className="flex items-center gap-1.5 rounded-md bg-[var(--cf-accent)] px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-40"
            >
              {saving ? <Loader2 size={13} className="animate-spin" /> : <KeyRound size={13} />}
              {saving ? t("settings.savingToken") : t("settings.saveToken")}
            </button>
            {connected && (
              <button
                onClick={() => setEditing(false)}
                className="text-[12px] text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
              >
                {t("common.cancel")}
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
