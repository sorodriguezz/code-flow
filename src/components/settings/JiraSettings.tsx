import { useEffect, useState } from "react";
import { Check, KeyRound, Loader2, Trash2 } from "lucide-react";
import { TokenHowTo } from "./TokenHowTo";
import { deleteJiraToken, setJiraToken } from "../../lib/tauri/commands";
import {
  loadJiraConnections,
  normalizeJiraSite,
  saveJiraConnections,
  type JiraConnection,
} from "../../lib/jiraConnections";
import { pushErrorToast, useToastStore } from "../../state/toastStore";
import { useT } from "../../state/languageStore";

/**
 * The connected Jira sites, and the form that adds one.
 *
 * Three fields rather than Azure's two, and the extra one is not optional: Jira Cloud authenticates
 * `email:token` over HTTP Basic, so a token saved without the address it belongs to is a token that
 * can never be used. The e-mail is not secret and rides with the connection in app settings; only
 * the token reaches the OS keychain.
 *
 * Keyed by the **normalised** site, exactly as the backend resolves it — `acme`,
 * `acme.atlassian.net` and `https://acme.atlassian.net/jira` are one connection, not three, and a
 * user who types a different form of the same site next month overwrites rather than duplicates.
 */
/** Atlassian account-wide, not per site: one API token works across every Jira site the account
 * can reach, which is why this is a constant rather than built from the field above. */
const JIRA_TOKEN_PAGE = "https://id.atlassian.com/manage-profile/security/api-tokens";

export function JiraSettings() {
  const t = useT();
  const [connections, setConnections] = useState<JiraConnection[]>([]);
  const [site, setSite] = useState("");
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      setConnections(await loadJiraConnections());
      setLoaded(true);
    })();
  }, []);

  const handleSave = async () => {
    const cleanSite = normalizeJiraSite(site);
    if (!cleanSite || !email.trim() || !token.trim()) return;
    setSaving(true);
    try {
      await setJiraToken(cleanSite, token.trim());
      const next = [
        ...connections.filter((c) => normalizeJiraSite(c.site) !== cleanSite),
        { site: cleanSite, email: email.trim() },
      ];
      await saveJiraConnections(next);
      setConnections(next);
      setSite("");
      setEmail("");
      setToken("");
      useToastStore.getState().pushToast(t("toast.jiraConnected", { site: cleanSite }), "success");
    } catch (e) {
      pushErrorToast(t("toast.jiraSaveFailed", { error: String(e) }));
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async (removeSite: string) => {
    const clean = normalizeJiraSite(removeSite);
    try {
      await deleteJiraToken(clean);
      const next = connections.filter((c) => normalizeJiraSite(c.site) !== clean);
      await saveJiraConnections(next);
      setConnections(next);
      useToastStore.getState().pushToast(t("toast.jiraRemoved"), "info");
    } catch (e) {
      pushErrorToast(t("toast.jiraRemoveFailed", { error: String(e) }));
    }
  };

  if (!loaded) return null;

  return (
    // No heading of its own: the rail names the product and the card around this form carries the
    // hint — same arrangement as the three VCS forms beside it.
    <section>
      {connections.length > 0 && (
        <div className="mb-3 space-y-2">
          {connections.map((conn) => (
            <div
              key={normalizeJiraSite(conn.site)}
              className="flex items-center gap-3 rounded-lg border border-[var(--cf-border)] p-3"
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]">
                <KeyRound size={15} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium">{conn.site}</p>
                {/* The account, not the token: two connections to the same site under different
                    accounts see different projects, and that is the difference worth showing. */}
                <p className="truncate text-[12px] text-[var(--cf-text-muted)]">{conn.email}</p>
              </div>
              <span className="flex shrink-0 items-center gap-1 rounded-full bg-[color-mix(in_oklab,var(--cf-success)_16%,transparent)] px-2 py-0.5 text-[11px] font-medium text-[var(--cf-success)]">
                <Check size={11} /> {t("settings.connected")}
              </span>
              <button
                title={t("settings.remove")}
                onClick={() => handleRemove(conn.site)}
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
            {t("settings.jiraSite")}
          </label>
          <input
            value={site}
            onChange={(e) => setSite(e.target.value)}
            placeholder="acme.atlassian.net"
            className="w-full rounded-md border border-[var(--cf-border)] bg-transparent px-2.5 py-1.5 text-[13px] outline-none focus:border-[var(--cf-accent)]"
          />
        </div>
        <div>
          <label className="mb-1 block text-[12px] font-medium text-[var(--cf-text-muted)]">
            {t("settings.jiraEmail")}
          </label>
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="tu@empresa.com"
            className="w-full rounded-md border border-[var(--cf-border)] bg-transparent px-2.5 py-1.5 text-[13px] outline-none focus:border-[var(--cf-accent)]"
          />
        </div>
        <div>
          <label className="mb-1 block text-[12px] font-medium text-[var(--cf-text-muted)]">
            {t("settings.jiraToken")}
          </label>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            className="w-full rounded-md border border-[var(--cf-border)] bg-transparent px-2.5 py-1.5 text-[13px] outline-none focus:border-[var(--cf-accent)]"
          />
        </div>

        <div className="pt-1">
          <button
            disabled={saving || !site.trim() || !email.trim() || !token.trim()}
            onClick={handleSave}
            className="flex items-center gap-1.5 rounded-md bg-[var(--cf-accent)] px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-40"
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : <KeyRound size={13} />}
            {saving ? t("settings.savingToken") : t("settings.saveToken")}
          </button>
        </div>
      </div>

      <TokenHowTo
        title={t("settings.apiTokenHowTo")}
        steps={[
          t("settings.jiraTokenStep1"),
          t("settings.jiraTokenStep2"),
          t("settings.jiraTokenStep3"),
          t("settings.jiraTokenStep4"),
        ]}
        linkLabel={t("settings.jiraTokenOpenPage")}
        url={JIRA_TOKEN_PAGE}
      />
    </section>
  );
}
