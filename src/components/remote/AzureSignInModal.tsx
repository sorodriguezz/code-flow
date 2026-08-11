import { useEffect, useState } from "react";
import { Check, Cloud, Loader2, RefreshCw, X } from "lucide-react";
import { useRemoteStore } from "../../state/remoteStore";
import { useT } from "../../state/languageStore";
import { pushErrorToast, useToastStore } from "../../state/toastStore";
import { remoteDiscoverAzure } from "../../lib/tauri/remoteCommands";
import type { DiscoveredHost } from "../../types/remote";

/**
 * Sign in once, and the accounts are simply there.
 *
 * **This is the half of Storage Explorer people actually mean.** Its trick was never a prettier
 * grid — it is that you never type an endpoint or paste a key: you are signed in, so your storage
 * accounts appear, across every subscription. That is Azure Resource Manager, a different API on a
 * different host, and [`remotes::cloud::arm`] is the only place in the app that speaks it.
 *
 * **The session is the Azure CLI's, and that is a deliberate limit, not an oversight.** A sign-in of
 * our own would need an Entra *app registration* — a client ID to run the device-code flow against.
 * Storage Explorer and `az` each use a first-party Microsoft one, and helping ourselves to either
 * would be claiming to be an application we are not. So this asks the CLI for a token, and says so
 * plainly when there isn't one rather than showing an empty list.
 *
 * **Nothing secret is fetched.** The rows are created for Entra, so the identity that listed the
 * accounts is the identity that will read the blobs. ARM would hand out the account keys for the
 * asking; not asking is the point — a key we never fetch is a key that cannot leak from here.
 */
export function AzureSignInModal({ onClose }: { onClose: () => void }) {
  const saveDraftAsHost = useRemoteStore((s) => s.saveDraftAsHost);
  const openAzure = useRemoteStore((s) => s.openAzure);
  const t = useT();

  const [found, setFound] = useState<DiscoveredHost[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [tenant, setTenant] = useState("");
  const [busy, setBusy] = useState(false);

  const discover = async () => {
    setFound(null);
    setFailure(null);
    try {
      const accounts = await remoteDiscoverAzure(tenant.trim());
      setFound(accounts);
      // Nothing pre-ticked: adding eleven accounts because the list arrived that way is not a
      // decision anybody made.
      setChosen([]);
    } catch (error) {
      setFailure(String(error));
    }
  };

  useEffect(() => {
    void discover();
    // Runs once. Re-discovering on every keystroke of the tenant box would be one ARM sweep per
    // character; the button beside it is what asks again.
  }, []);

  const add = async () => {
    if (chosen.length === 0 || busy) return;
    setBusy(true);
    let first: string | null = null;
    try {
      for (const entry of found ?? []) {
        if (!chosen.includes(entry.account.name)) continue;
        const row = await saveDraftAsHost(entry.spec, entry.account.name);
        if (row && !first) first = row.id;
      }
      useToastStore.getState().pushToast(t("remote.azAdded", { count: chosen.length }), "success");
      onClose();
      // Straight into the first one: the point of signing in was to look at something.
      if (first) openAzure(first);
    } catch (error) {
      pushErrorToast(String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 p-4" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="cf-fade-in flex max-h-[calc(100vh-4rem)] w-[560px] max-w-[92vw] flex-col overflow-hidden rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] shadow-[var(--cf-shadow)]"
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--cf-border)] px-4 py-3">
          <Cloud size={15} className="text-[var(--cf-accent)]" />
          <span className="flex-1 text-[13px] font-medium">{t("remote.azSignInTitle")}</span>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.close")}
            className="rounded p-0.5 text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
          >
            <X size={14} />
          </button>
        </div>

        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--cf-border)] px-4 py-2">
          <input
            value={tenant}
            onChange={(e) => setTenant(e.target.value)}
            placeholder={t("remote.azTenantHint")}
            spellCheck={false}
            className="min-w-0 flex-1 rounded-md border border-[var(--cf-border)] bg-transparent px-2 py-1 font-mono text-[11px] outline-none focus:border-[var(--cf-accent)]"
          />
          <button
            type="button"
            onClick={() => void discover()}
            className="flex shrink-0 items-center gap-1.5 rounded-md border border-[var(--cf-border)] px-2.5 py-1 text-[11px] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]"
          >
            <RefreshCw size={11} />
            {t("remote.azRediscover")}
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-2">
          {failure ? (
            <p className="whitespace-pre-wrap py-4 text-[12px] leading-relaxed text-[var(--cf-danger)]">
              {failure}
            </p>
          ) : found === null ? (
            <div className="flex items-center justify-center gap-2 py-8 text-[12px] text-[var(--cf-text-muted)]">
              <Loader2 size={14} className="animate-spin" />
              {t("remote.azDiscovering")}
            </div>
          ) : found.length === 0 ? (
            <p className="py-6 text-[12px] leading-relaxed text-[var(--cf-text-muted)]">
              {t("remote.azNoAccounts")}
            </p>
          ) : (
            found.map((entry) => {
              const picked = chosen.includes(entry.account.name);
              return (
                <button
                  key={`${entry.account.subscription}/${entry.account.name}`}
                  type="button"
                  onClick={() =>
                    setChosen((current) =>
                      picked
                        ? current.filter((name) => name !== entry.account.name)
                        : [...current, entry.account.name],
                    )
                  }
                  className={`flex w-full items-center gap-2.5 rounded-md border px-2.5 py-1.5 text-left transition-colors ${
                    picked
                      ? "border-[var(--cf-accent)] bg-[var(--cf-accent-soft)]"
                      : "border-transparent hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
                  }`}
                >
                  <span
                    className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                      picked
                        ? "border-[var(--cf-accent)] bg-[var(--cf-accent)] text-white"
                        : "border-[var(--cf-border)]"
                    }`}
                  >
                    {picked && <Check size={10} />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12px] text-[var(--cf-text)]">
                      {entry.account.name}
                    </span>
                    <span className="block truncate text-[10px] text-[var(--cf-text-muted)]">
                      {entry.account.subscription} · {entry.account.resource_group} ·{" "}
                      {entry.account.location}
                    </span>
                  </span>
                </button>
              );
            })
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2 border-t border-[var(--cf-border)] px-4 py-3">
          {/* Said out loud, because "signed in with Microsoft" usually means a key was fetched and
              stored somewhere, and here it deliberately does not. */}
          <span className="min-w-0 flex-1 text-[10px] leading-relaxed text-[var(--cf-text-muted)]">
            {t("remote.azSignInNote")}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-[12px] text-[var(--cf-text-muted)] hover:bg-black/[0.05] dark:hover:bg-white/[0.08]"
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            onClick={() => void add()}
            disabled={chosen.length === 0 || busy}
            className="flex items-center gap-1.5 rounded-md bg-[var(--cf-accent)] px-3 py-1.5 text-[12px] font-medium text-white hover:brightness-110 disabled:opacity-40"
          >
            {busy && <Loader2 size={12} className="animate-spin" />}
            {t("remote.azAddChosen", { count: chosen.length })}
          </button>
        </div>
      </div>
    </div>
  );
}
