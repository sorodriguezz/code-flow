import { useEffect, useState } from "react";
import { AlertTriangle, Check, ExternalLink, KeyRound, Loader2, Trash2 } from "lucide-react";
import { adoCheckOrg, adoVerifyPat, deleteAdoPat, openExternalUrl, setAdoPat } from "../../lib/tauri/commands";
import { loadAdoConnections, normalizeAdoOrg, saveAdoConnections } from "../../lib/adoConnections";
import { pushErrorToast, useToastStore } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import type { AdoConnection } from "../../types/domain";

/** Azure's own token page for an organization. Deep-linking it is the difference between four
 * steps you follow and one link you click — and it's per-org, which is exactly the parameter the
 * user has already typed into the field above it. */
function tokenPageUrl(org: string): string {
  const clean = normalizeAdoOrg(org);
  return clean
    ? `https://dev.azure.com/${encodeURIComponent(clean)}/_usersSettings/tokens`
    : "https://dev.azure.com";
}

export function AzureDevOpsSettings() {
  const t = useT();
  const [connections, setConnections] = useState<AdoConnection[]>([]);
  const [org, setOrg] = useState("");
  const [pat, setPat] = useState("");
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  /** Why the last attempt didn't connect. Kept on the form rather than pushed as a toast: a
   * rejected token is something you fix in the two fields right here, and a message that has
   * already faded is no help while you're doing it. */
  const [error, setError] = useState<string | null>(null);

  /**
   * Live state of each saved connection, keyed by org: the account it reached, or why it didn't.
   *
   * A saved row used to be labelled "Connected" purely because it existed in the list, which is a
   * claim the app was in no position to make — the token behind it may have been wrong from the
   * start (saved before this screen verified anything) or have expired since. Checked on open,
   * so the badge reports the connection rather than the record of one.
   */
  const [health, setHealth] = useState<Record<string, { account: string } | { error: string } | null>>({});

  const checkOrg = (checkedOrg: string) => {
    setHealth((prev) => ({ ...prev, [checkedOrg]: null }));
    adoCheckOrg(checkedOrg)
      .then((account) => setHealth((prev) => ({ ...prev, [checkedOrg]: { account } })))
      .catch((e: unknown) => setHealth((prev) => ({ ...prev, [checkedOrg]: { error: String(e) } })));
  };

  useEffect(() => {
    (async () => {
      const saved = await loadAdoConnections();
      setConnections(saved);
      setLoaded(true);
      // Concurrently and without awaiting: the form is usable while these land, and one org being
      // slow or unreachable must not hold up the others.
      for (const conn of saved) checkOrg(conn.org);
    })();
  }, []);

  /**
   * Verify, then save — never the other way round.
   *
   * This used to write the token to the keychain and declare the org connected without ever
   * calling Azure, so a typo'd organization or an expired PAT produced a green "Connected" badge
   * and failed hours later at the first attempt to list pull requests, where nothing points back
   * at the credentials as the cause. `adoVerifyPat` asks Azure who the token belongs to first, so
   * "connected" means a round trip actually succeeded — and nothing is stored when it doesn't,
   * which also means re-entering a bad token can't clobber a working one for the same org.
   */
  const handleSave = async () => {
    const cleanOrg = normalizeAdoOrg(org);
    if (!cleanOrg || !pat.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const account = await adoVerifyPat(cleanOrg, pat.trim());
      await setAdoPat(cleanOrg, pat.trim());
      const next = [...connections.filter((c) => c.org.toLowerCase() !== cleanOrg.toLowerCase()), { org: cleanOrg }];
      await saveAdoConnections(next);
      setConnections(next);
      // Seeded from the verification that just ran rather than re-checked: same answer, one
      // fewer round trip, and the new row is never briefly labelled as still checking.
      setHealth((prev) => ({ ...prev, [cleanOrg]: { account } }));
      setOrg("");
      setPat("");
      // Naming the account is the receipt: it's a fact only the server could have supplied.
      useToastStore.getState().pushToast(t("toast.adoConnectedAs", { org: cleanOrg, account }), "success");
    } catch (e) {
      setError(String(e));
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
          {connections.map((conn) => {
            const state = health[conn.org];
            const failed = state && "error" in state;
            return (
              <div
                key={conn.org}
                className={`flex items-center gap-3 rounded-lg border p-3 ${
                  failed ? "border-[var(--cf-danger)]/40" : "border-[var(--cf-border)]"
                }`}
              >
                <span
                  className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md ${
                    failed
                      ? "bg-[color-mix(in_oklab,var(--cf-danger)_16%,transparent)] text-[var(--cf-danger)]"
                      : "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
                  }`}
                >
                  <KeyRound size={15} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium">{conn.org}</p>
                  {/* The second line carries the evidence: who Azure says the token is, or what it
                      said instead. The row of dots it replaces only ever restated that a token was
                      stored — which was never the thing in doubt. */}
                  {state && "account" in state ? (
                    <p className="truncate text-[12px] text-[var(--cf-text-muted)]">{state.account}</p>
                  ) : failed ? (
                    <p className="select-text break-words text-[11.5px] leading-snug text-[var(--cf-danger)]">
                      {state.error}
                    </p>
                  ) : (
                    <p className="font-mono text-[12px] tracking-widest text-[var(--cf-text-muted)]">••••••••••••</p>
                  )}
                </div>
                {state === undefined || state === null ? (
                  <span className="flex shrink-0 items-center gap-1 rounded-full bg-black/[0.05] px-2 py-0.5 text-[11px] font-medium text-[var(--cf-text-muted)] dark:bg-white/[0.08]">
                    <Loader2 size={11} className="animate-spin" /> {t("settings.adoChecking")}
                  </span>
                ) : failed ? (
                  <button
                    onClick={() => checkOrg(conn.org)}
                    title={t("settings.adoRecheck")}
                    className="flex shrink-0 items-center gap-1 rounded-full bg-[color-mix(in_oklab,var(--cf-danger)_16%,transparent)] px-2 py-0.5 text-[11px] font-medium text-[var(--cf-danger)]"
                  >
                    <AlertTriangle size={11} /> {t("settings.adoNotWorking")}
                  </button>
                ) : (
                  <span className="flex shrink-0 items-center gap-1 rounded-full bg-[color-mix(in_oklab,var(--cf-success)_16%,transparent)] px-2 py-0.5 text-[11px] font-medium text-[var(--cf-success)]">
                    <Check size={11} /> {t("settings.connected")}
                  </span>
                )}
                <button
                  title={t("settings.remove")}
                  onClick={() => handleRemove(conn.org)}
                  className="shrink-0 text-[var(--cf-text-muted)] hover:text-[var(--cf-danger)]"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Where the token comes from, in the place you're being asked for one. Azure calls this a
          Personal Access Token and files it under the account menu rather than the organization
          settings, which is not where anyone looks first — and picking the scopes is its own
          decision, made once, on a page with dozens of checkboxes. */}
      <div className="mb-3 rounded-lg border border-[var(--cf-border)] bg-black/[0.02] p-3 dark:bg-white/[0.03]">
        <p className="mb-1.5 text-[12px] font-medium">{t("settings.adoPatHowTo")}</p>
        <ol className="ml-3.5 list-decimal space-y-1 text-[11.5px] leading-snug text-[var(--cf-text-muted)]">
          <li>{t("settings.adoPatStep1")}</li>
          <li>{t("settings.adoPatStep2")}</li>
          <li>{t("settings.adoPatStep3")}</li>
          <li>{t("settings.adoPatStep4")}</li>
        </ol>
        <button
          onClick={() => void openExternalUrl(tokenPageUrl(org))}
          className="mt-2 flex items-center gap-1 text-[11.5px] font-medium text-[var(--cf-accent)] hover:underline"
        >
          <ExternalLink size={11} />
          {t("settings.adoPatOpenPage")}
        </button>
      </div>

      <div className="space-y-2">
        <div>
          <label className="mb-1 block text-[12px] font-medium text-[var(--cf-text-muted)]">
            {t("settings.organization")}
          </label>
          <input
            value={org}
            onChange={(e) => setOrg(e.target.value)}
            placeholder={t("settings.adoOrgPlaceholder")}
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

        {error && (
          <div className="flex items-start gap-2 rounded-md border border-[var(--cf-danger)]/30 bg-[color-mix(in_oklab,var(--cf-danger)_8%,transparent)] px-2.5 py-2">
            <AlertTriangle size={13} className="mt-0.5 shrink-0 text-[var(--cf-danger)]" />
            <div className="min-w-0 flex-1">
              <p className="text-[12px] font-medium text-[var(--cf-danger)]">{t("settings.adoVerifyFailed")}</p>
              {/* Azure's own words, selectable — they name the failure precisely enough to be
                  worth searching for, and nothing here has a copy button. */}
              <p className="mt-0.5 select-text break-words text-[11.5px] leading-snug text-[var(--cf-text-muted)]">
                {error}
              </p>
            </div>
          </div>
        )}

        <div className="pt-1">
          <button
            disabled={saving || !org.trim() || !pat.trim()}
            onClick={handleSave}
            className="flex items-center gap-1.5 rounded-md bg-[var(--cf-accent)] px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-40"
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : <KeyRound size={13} />}
            {saving ? t("settings.adoVerifying") : t("settings.saveToken")}
          </button>
        </div>
      </div>
    </section>
  );
}
