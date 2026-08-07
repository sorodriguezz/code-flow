import { useEffect, useState } from "react";
import { Check, KeyRound, Loader2, Trash2 } from "lucide-react";
import { TokenHowTo } from "./TokenHowTo";
import { deleteMondayToken, mondayWhoami, setMondayToken } from "../../lib/tauri/commands";
import {
  loadMondayConnections,
  saveMondayConnections,
  type MondayConnection,
} from "../../lib/mondayConnections";
import { pushErrorToast, useToastStore } from "../../state/toastStore";
import { useT } from "../../state/languageStore";

/**
 * The connected monday.com accounts, and the form that adds one.
 *
 * One field, and that is the whole point: every monday customer talks to the same API endpoint, so
 * there is no host to ask for. The token identifies the account by itself — which is why saving one
 * **calls monday first** and asks who it belongs to. Two things come out of that round trip: the
 * account slug, which becomes the keychain key and the subdomain every item link is built from, and
 * a verification that the token works at all. A token that can't reach monday is rejected here,
 * where the user is still looking at the field, rather than at the first publish.
 */
/** The docs rather than the token page, and deliberately: monday files the personal token under
 * the account's own subdomain, which is exactly the thing this form does not know yet — the whole
 * reason saving one calls monday to ask who it belongs to. */
const MONDAY_TOKEN_PAGE = "https://developer.monday.com/api-reference/docs/authentication";

export function MondaySettings() {
  const t = useT();
  const [connections, setConnections] = useState<MondayConnection[]>([]);
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      setConnections(await loadMondayConnections());
      setLoaded(true);
    })();
  }, []);

  const handleSave = async () => {
    if (!token.trim()) return;
    setSaving(true);
    try {
      // Before the keychain, not after: the slug it answers with is the key the token is filed
      // under, so there is nothing to save until this succeeds.
      const account = await mondayWhoami(token.trim());
      await setMondayToken(account.slug, token.trim());
      const next = [
        ...connections.filter((c) => c.slug !== account.slug),
        { slug: account.slug, name: account.name },
      ];
      await saveMondayConnections(next);
      setConnections(next);
      setToken("");
      useToastStore
        .getState()
        .pushToast(t("toast.mondayConnected", { account: account.name || account.slug }), "success");
    } catch (e) {
      pushErrorToast(t("toast.mondaySaveFailed", { error: String(e) }));
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async (slug: string) => {
    try {
      await deleteMondayToken(slug);
      const next = connections.filter((c) => c.slug !== slug);
      await saveMondayConnections(next);
      setConnections(next);
      useToastStore.getState().pushToast(t("toast.mondayRemoved"), "info");
    } catch (e) {
      pushErrorToast(t("toast.mondayRemoveFailed", { error: String(e) }));
    }
  };

  if (!loaded) return null;

  return (
    // No heading of its own: the rail names the product and the card around this form carries the
    // hint — the same arrangement as the four forms beside it.
    <section>
      {connections.length > 0 && (
        <div className="mb-3 space-y-2">
          {connections.map((conn) => (
            <div
              key={conn.slug}
              className="flex items-center gap-3 rounded-lg border border-[var(--cf-border)] p-3"
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]">
                <KeyRound size={15} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium">{conn.name || conn.slug}</p>
                {/* The subdomain, because that is what identifies the account and what every item
                    link is built from — the display name above is only a label. */}
                <p className="truncate text-[12px] text-[var(--cf-text-muted)]">
                  {conn.slug}.monday.com
                </p>
              </div>
              <span className="flex shrink-0 items-center gap-1 rounded-full bg-[color-mix(in_oklab,var(--cf-success)_16%,transparent)] px-2 py-0.5 text-[11px] font-medium text-[var(--cf-success)]">
                <Check size={11} /> {t("settings.connected")}
              </span>
              <button
                title={t("settings.remove")}
                onClick={() => handleRemove(conn.slug)}
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
            {t("settings.mondayToken")}
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
            disabled={saving || !token.trim()}
            onClick={handleSave}
            className="flex items-center gap-1.5 rounded-md bg-[var(--cf-accent)] px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-40"
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : <KeyRound size={13} />}
            {saving ? t("settings.mondayVerifying") : t("settings.saveToken")}
          </button>
        </div>
      </div>

      <TokenHowTo
        title={t("settings.apiTokenHowTo")}
        steps={[
          t("settings.mondayTokenStep1"),
          t("settings.mondayTokenStep2"),
          t("settings.mondayTokenStep3"),
          t("settings.mondayTokenStep4"),
        ]}
        linkLabel={t("settings.mondayTokenOpenPage")}
        url={MONDAY_TOKEN_PAGE}
      />
    </section>
  );
}
