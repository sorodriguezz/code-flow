import { useEffect, useId, useState } from "react";
import { Check, KeyRound, Loader2, Trash2 } from "lucide-react";
import { TokenHowTo } from "./TokenHowTo";
import { buttonClass } from "../common/Button";
import { chipClass, fieldClass } from "../common/recipes";
import { Tooltip } from "../common/Tooltip";
import { deleteLinearToken, linearWhoami, setLinearToken } from "../../lib/tauri/commands";
import { loadLinearConnections, saveLinearConnections, type LinearConnection } from "../../lib/linearConnections";
import { pushErrorToast, useToastStore } from "../../state/toastStore";
import { useT } from "../../state/languageStore";

/**
 * The connected Linear organisations, and the form that adds one — monday's shape: one field, and
 * saving asks Linear whose key it is before anything is stored, so a key that cannot reach Linear is
 * refused here rather than at the first publish.
 */
const LINEAR_KEY_PAGE = "https://linear.app/settings/account/security";

export function LinearSettings() {
  const t = useT();
  const [connections, setConnections] = useState<LinearConnection[]>([]);
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const fieldId = useId();

  useEffect(() => {
    (async () => {
      setConnections(await loadLinearConnections());
      setLoaded(true);
    })();
  }, []);

  const handleSave = async () => {
    if (!token.trim()) return;
    setSaving(true);
    try {
      // Before the keychain, not after: the organisation it answers with is the key the API key is
      // filed under, so there is nothing to save until this succeeds.
      const account = await linearWhoami(token.trim());
      await setLinearToken(account.key, token.trim());
      const next = [...connections.filter((c) => c.key !== account.key), { key: account.key, name: account.name }];
      await saveLinearConnections(next);
      setConnections(next);
      setToken("");
      useToastStore.getState().pushToast(t("toast.linearConnected", { account: account.name || account.key }), "success");
    } catch (e) {
      pushErrorToast(t("toast.linearSaveFailed", { error: String(e) }));
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async (key: string) => {
    try {
      await deleteLinearToken(key);
      const next = connections.filter((c) => c.key !== key);
      await saveLinearConnections(next);
      setConnections(next);
      useToastStore.getState().pushToast(t("toast.linearRemoved"), "info");
    } catch (e) {
      pushErrorToast(t("toast.linearRemoveFailed", { error: String(e) }));
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
              key={conn.key}
              className="flex items-center gap-3 rounded-lg border border-[var(--cf-border)] p-3"
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]">
                <KeyRound size={15} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium">{conn.name || conn.key}</p>
                <p className="truncate text-[12px] text-[var(--cf-text-muted)]">linear.app/{conn.key}</p>
              </div>
              <span className={chipClass("ok")}>
                <Check size={12} /> {t("settings.connected")}
              </span>
              <Tooltip label={t("settings.remove")}>
                <button
                  type="button"
                  aria-label={t("settings.remove")}
                  onClick={() => handleRemove(conn.key)}
                  className="inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md text-[var(--cf-text-muted)] transition-colors duration-100 hover:bg-[color-mix(in_oklab,var(--cf-danger)_10%,transparent)] hover:text-[var(--cf-danger)] disabled:pointer-events-none disabled:opacity-40"
                >
                  <Trash2 size={14} />
                </button>
              </Tooltip>
            </div>
          ))}
        </div>
      )}

      <div className="space-y-3">
        <div>
          <label
            htmlFor={`${fieldId}-token`}
            className="mb-1 block text-[12px] font-medium text-[var(--cf-text-muted)]"
          >
            {t("settings.linearToken")}
          </label>
          <input
            id={`${fieldId}-token`}
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            className={fieldClass({ className: "w-full font-mono" })}
          />
        </div>

        <div className="pt-1">
          <button
            type="button"
            disabled={saving || !token.trim()}
            onClick={handleSave}
            className={buttonClass({ variant: "primary", size: "sm" })}
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : <KeyRound size={13} />}
            {saving ? t("settings.linearVerifying") : t("settings.saveToken")}
          </button>
        </div>
      </div>

      <TokenHowTo
        title={t("settings.apiTokenHowTo")}
        steps={[t("settings.linearTokenStep1"), t("settings.linearTokenStep2"), t("settings.linearTokenStep3")]}
        linkLabel={t("settings.linearTokenOpenPage")}
        url={LINEAR_KEY_PAGE}
      />
    </section>
  );
}
