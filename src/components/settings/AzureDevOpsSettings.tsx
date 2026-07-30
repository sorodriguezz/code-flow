import { useEffect, useState } from "react";
import { Check, KeyRound, Loader2, Trash2 } from "lucide-react";
import { deleteAdoPat, setAdoPat } from "../../lib/tauri/commands";
import { loadAdoConnections, normalizeAdoOrg, saveAdoConnections } from "../../lib/adoConnections";
import { pushErrorToast, useToastStore } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import type { AdoConnection } from "../../types/domain";

export function AzureDevOpsSettings() {
  const t = useT();
  const [connections, setConnections] = useState<AdoConnection[]>([]);
  const [org, setOrg] = useState("");
  const [pat, setPat] = useState("");
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      setConnections(await loadAdoConnections());
      setLoaded(true);
    })();
  }, []);

  const handleSave = async () => {
    const cleanOrg = normalizeAdoOrg(org);
    if (!cleanOrg || !pat.trim()) return;
    setSaving(true);
    try {
      await setAdoPat(cleanOrg, pat.trim());
      const next = [...connections.filter((c) => c.org.toLowerCase() !== cleanOrg.toLowerCase()), { org: cleanOrg }];
      await saveAdoConnections(next);
      setConnections(next);
      setOrg("");
      setPat("");
      useToastStore.getState().pushToast(t("toast.adoConnected", { org: cleanOrg }), "success");
    } catch (e) {
      pushErrorToast(t("toast.adoSaveFailed", { error: String(e) }));
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async (removeOrg: string) => {
    try {
      await deleteAdoPat(removeOrg);
      const next = connections.filter((c) => c.org.toLowerCase() !== removeOrg.toLowerCase());
      await saveAdoConnections(next);
      setConnections(next);
      useToastStore.getState().pushToast(t("toast.adoRemoved"), "info");
    } catch (e) {
      pushErrorToast(t("toast.adoRemoveFailed", { error: String(e) }));
    }
  };

  if (!loaded) return null;

  return (
    // No heading or hint of its own, for the reason given in `GitHubSettings`: the rail names the
    // provider and the card around this form carries the hint.
    <section>
      {connections.length > 0 && (
        <div className="mb-3 space-y-2">
          {connections.map((conn) => (
            <div key={conn.org} className="flex items-center gap-3 rounded-lg border border-[var(--cf-border)] p-3">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]">
                <KeyRound size={15} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium">{conn.org}</p>
                <p className="font-mono text-[12px] tracking-widest text-[var(--cf-text-muted)]">••••••••••••</p>
              </div>
              <span className="flex shrink-0 items-center gap-1 rounded-full bg-[color-mix(in_oklab,var(--cf-success)_16%,transparent)] px-2 py-0.5 text-[11px] font-medium text-[var(--cf-success)]">
                <Check size={11} /> {t("settings.connected")}
              </span>
              <button
                title={t("settings.remove")}
                onClick={() => handleRemove(conn.org)}
                className="shrink-0 text-[var(--cf-text-muted)] hover:text-[var(--cf-danger)]"
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      )}

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

        <div className="pt-1">
          <button
            disabled={saving || !org.trim() || !pat.trim()}
            onClick={handleSave}
            className="flex items-center gap-1.5 rounded-md bg-[var(--cf-accent)] px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-40"
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : <KeyRound size={13} />}
            {saving ? t("settings.savingToken") : t("settings.saveToken")}
          </button>
        </div>
      </div>
    </section>
  );
}
