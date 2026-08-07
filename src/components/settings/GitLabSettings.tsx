import { useEffect, useState } from "react";
import { Check, KeyRound, Loader2, Trash2 } from "lucide-react";
import { TokenHowTo } from "./TokenHowTo";
import { deleteGitlabToken, gitlabAuthenticatedUser, setGitlabToken } from "../../lib/tauri/commands";
import {
  GITLAB_COM,
  gitlabHostLabel,
  loadGitlabConnections,
  normalizeGitlabHost,
  saveGitlabConnections,
} from "../../lib/gitlabConnections";
import { pushErrorToast, useToastStore } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import type { GitlabConnection } from "../../types/domain";

/**
 * One personal access token per GitLab host — gitlab.com and any number of self-managed instances.
 *
 * Shaped like the GitHub form rather than the Azure one for two reasons: GitLab keys its tokens by
 * host, and its `/user` endpoint can say whose token it is, so the same validate-then-roll-back
 * flow applies. The host field carries more weight here, though: with self-managed GitLab the
 * hostname is the part that is easy to get wrong, and a token saved against the wrong one is what
 * would later look like "GitLab doesn't work".
 */
/** GitLab's personal access token page for whichever host is in the field. Self-managed instances
 * mount the same path, so one shape covers gitlab.com and every private install. */
function tokenPageUrl(host: string): string {
  const clean = normalizeGitlabHost(host) || GITLAB_COM;
  return `https://${clean}/-/user_settings/personal_access_tokens`;
}

export function GitLabSettings() {
  const t = useT();
  const [connections, setConnections] = useState<GitlabConnection[]>([]);
  const [host, setHost] = useState(GITLAB_COM);
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      setConnections(await loadGitlabConnections());
      setLoaded(true);
    })();
  }, []);

  const handleSave = async () => {
    const cleanHost = normalizeGitlabHost(host);
    if (!cleanHost || !token.trim()) return;
    setSaving(true);
    try {
      await setGitlabToken(cleanHost, token.trim());
      // Validates against this host and surfaces a bad token — or a hostname that isn't a GitLab
      // instance at all — immediately, rather than saving something that only fails later.
      const username = await gitlabAuthenticatedUser(cleanHost);
      const next = [
        ...connections.filter((c) => c.host.toLowerCase() !== cleanHost),
        { host: cleanHost, username },
      ];
      // The list is written *after* the token, and both together: auto-detection reads only this
      // list, so a token saved without it would leave GitLab remotes invisible to the linker.
      await saveGitlabConnections(next);
      setConnections(next);
      setHost(GITLAB_COM);
      setToken("");
      useToastStore.getState().pushToast(t("toast.gitlabConnected", { user: username }), "success");
    } catch (e) {
      // Roll back the token we just wrote so a failed validation doesn't leave a broken
      // connection behind.
      await deleteGitlabToken(cleanHost).catch(() => {});
      pushErrorToast(t("toast.gitlabSaveFailed", { error: String(e) }));
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async (removeHost: string) => {
    try {
      await deleteGitlabToken(removeHost);
      const next = connections.filter((c) => c.host.toLowerCase() !== removeHost.toLowerCase());
      await saveGitlabConnections(next);
      setConnections(next);
      useToastStore.getState().pushToast(t("toast.gitlabRemoved"), "info");
    } catch (e) {
      pushErrorToast(t("toast.gitlabRemoveFailed", { error: String(e) }));
    }
  };

  if (!loaded) return null;

  return (
    // No heading or hint of its own: the Integrations rail names the provider and its card already
    // carries the hint, so repeating either here would say the same thing twice.
    <section>
      {connections.length > 0 && (
        <div className="mb-3 space-y-2">
          {connections.map((conn) => (
            <div key={conn.host} className="flex items-center gap-3 rounded-lg border border-[var(--cf-border)] p-3">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]">
                <KeyRound size={15} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium">{gitlabHostLabel(conn.host)}</p>
                <p className="truncate text-[12px] text-[var(--cf-text-muted)]">
                  {conn.username ? `@${conn.username}` : "••••••••••••"}
                </p>
              </div>
              <span className="flex shrink-0 items-center gap-1 rounded-full bg-[color-mix(in_oklab,var(--cf-success)_16%,transparent)] px-2 py-0.5 text-[11px] font-medium text-[var(--cf-success)]">
                <Check size={11} /> {t("settings.connected")}
              </span>
              <button
                title={t("settings.remove")}
                onClick={() => handleRemove(conn.host)}
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
            {t("settings.gitlabHostLabel")}
          </label>
          <input
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder={GITLAB_COM}
            className="w-full rounded-md border border-[var(--cf-border)] bg-transparent px-2.5 py-1.5 text-[13px] outline-none focus:border-[var(--cf-accent)]"
          />
          <p className="mt-1 text-[11px] text-[var(--cf-text-muted)]">{t("settings.gitlabHostHint")}</p>
        </div>
        <div>
          <label className="mb-1 block text-[12px] font-medium text-[var(--cf-text-muted)]">
            {t("settings.personalAccessToken")}
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
            disabled={saving || !host.trim() || !token.trim()}
            onClick={handleSave}
            className="flex items-center gap-1.5 rounded-md bg-[var(--cf-accent)] px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-40"
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : <KeyRound size={13} />}
            {saving ? t("settings.savingToken") : t("settings.saveToken")}
          </button>
        </div>
      </div>

      <TokenHowTo
        title={t("settings.tokenHowTo")}
        steps={[
          t("settings.gitlabPatStep1"),
          t("settings.gitlabPatStep2"),
          t("settings.gitlabPatStep3"),
          t("settings.gitlabPatStep4"),
        ]}
        linkLabel={t("settings.gitlabPatOpenPage")}
        url={tokenPageUrl(host)}
      />
    </section>
  );
}
