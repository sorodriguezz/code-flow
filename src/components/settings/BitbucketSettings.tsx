import { useEffect, useId, useState } from "react";
import { AlertTriangle, Check, KeyRound, Loader2, Trash2 } from "lucide-react";
import { TokenHowTo } from "./TokenHowTo";
import { buttonClass } from "../common/Button";
import { chipClass, fieldClass } from "../common/recipes";
import { Segmented } from "../common/Segmented";
import { Tooltip } from "../common/Tooltip";
import {
  bitbucketCheckWorkspace,
  bitbucketVerifyCredential,
  deleteBitbucketCredential,
  setBitbucketCredential,
} from "../../lib/tauri/commands";
import {
  bitbucketTokenPageUrl,
  loadBitbucketConnections,
  normalizeBitbucketWorkspace,
  saveBitbucketConnections,
} from "../../lib/bitbucketConnections";
import { pushErrorToast, useToastStore } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import type { BitbucketCheck, BitbucketConnection, BitbucketCredential } from "../../types/domain";

type Kind = BitbucketConnection["kind"];

/** What the last check of a saved connection found — or why it couldn't run — and `null` while it
 *  is running. */
type Health = { check: BitbucketCheck } | { error: string } | null;

/**
 * One credential per Bitbucket workspace — an Atlassian API token (the successor to the app
 * passwords Atlassian is retiring, which needs the e-mail of its account) or a workspace, project or
 * repository access token.
 *
 * Shaped like the Azure form rather than the GitLab one, for the same two reasons: the credential is
 * checked **before** it is stored, so a bad token never overwrites a good one, and every saved row is
 * checked again on open, so its badge reports the connection rather than the record of one. The
 * check says more than Azure's does — which scopes are missing — because a Bitbucket token's scopes
 * are fixed when it is created, and a token without the pipeline scope is otherwise a mystery that
 * surfaces only in the Pipelines tab.
 */
export function BitbucketSettings() {
  const t = useT();
  const [connections, setConnections] = useState<BitbucketConnection[]>([]);
  const [kind, setKind] = useState<Kind>("api_token");
  const [workspace, setWorkspace] = useState("");
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  /** Why the last attempt didn't connect — kept on the form, where it is fixed, as Azure's is. */
  const [error, setError] = useState<string | null>(null);
  const [health, setHealth] = useState<Record<string, Health>>({});
  const fieldId = useId();

  const checkWorkspace = (checked: string) => {
    setHealth((prev) => ({ ...prev, [checked]: null }));
    bitbucketCheckWorkspace(checked)
      .then((check) => setHealth((prev) => ({ ...prev, [checked]: { check } })))
      .catch((e: unknown) => setHealth((prev) => ({ ...prev, [checked]: { error: String(e) } })));
  };

  useEffect(() => {
    (async () => {
      const saved = await loadBitbucketConnections();
      setConnections(saved);
      // One Atlassian account is routinely connected to several workspaces, each needing its own
      // row — so the e-mail of the last API token is offered again rather than typed again.
      const lastEmail = [...saved].reverse().find((c) => c.kind === "api_token" && c.email)?.email;
      if (lastEmail) setEmail(lastEmail);
      setLoaded(true);
      // Concurrently and unawaited: the form is usable while these land.
      for (const conn of saved) checkWorkspace(conn.workspace);
    })();
  }, []);

  const cleanWorkspace = normalizeBitbucketWorkspace(workspace);
  const complete = cleanWorkspace !== "" && token.trim() !== "" && (kind === "access_token" || email.trim() !== "");

  /** Verify, then save — never the other way round. See the component's note. */
  const handleSave = async () => {
    if (!complete) return;
    setSaving(true);
    setError(null);
    const credential: BitbucketCredential =
      kind === "api_token" ? { kind, email: email.trim(), token: token.trim() } : { kind, token: token.trim() };
    try {
      const check = await bitbucketVerifyCredential(cleanWorkspace, credential);
      await setBitbucketCredential(cleanWorkspace, credential);
      const entry: BitbucketConnection = {
        workspace: cleanWorkspace,
        kind,
        email: credential.kind === "api_token" ? credential.email : null,
        user: check.user,
      };
      const next = [...connections.filter((c) => c.workspace !== cleanWorkspace), entry];
      // The list is written after the credential, and both together: auto-linking reads only this
      // list, so a credential saved without it would leave the workspace's remotes unrecognised.
      await saveBitbucketConnections(next);
      setConnections(next);
      // Seeded from the check that just ran: same answer, one fewer round trip.
      setHealth((prev) => ({ ...prev, [cleanWorkspace]: { check } }));
      setWorkspace("");
      setToken("");
      const push = useToastStore.getState().pushToast;
      if (check.missing.length > 0) {
        // Saved regardless: what it can do works, and the row keeps saying what it can't.
        push(t("toast.bitbucketMissingScopes", { scopes: check.missing.join(", ") }), "info");
      } else if (check.user) {
        push(t("toast.bitbucketConnected", { workspace: cleanWorkspace, user: check.user }), "success");
      } else {
        push(t("toast.bitbucketConnectedAnonymous", { workspace: cleanWorkspace }), "success");
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async (removed: string) => {
    try {
      await deleteBitbucketCredential(removed);
      const next = connections.filter((c) => c.workspace !== removed);
      await saveBitbucketConnections(next);
      setConnections(next);
      useToastStore.getState().pushToast(t("toast.bitbucketRemoved"), "info");
    } catch (e) {
      pushErrorToast(t("toast.bitbucketRemoveFailed", { error: String(e) }));
    }
  };

  if (!loaded) return null;

  const kindLabel = (value: Kind) =>
    value === "api_token" ? t("settings.bitbucketAuthApiToken") : t("settings.bitbucketAuthAccessToken");

  return (
    // No heading or hint of its own, for the reason given in `GitHubSettings`: the rail names the
    // provider and the card around this form carries the hint.
    <section>
      {connections.length > 0 && (
        <div className="mb-3 space-y-2">
          {connections.map((conn) => {
            const state = health[conn.workspace];
            const failed = state !== undefined && state !== null && "error" in state;
            const check = state && "check" in state ? state.check : null;
            const who = check?.user || conn.user || conn.email || kindLabel(conn.kind);
            return (
              <div
                key={conn.workspace}
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
                  <p className="truncate font-mono text-[13px] font-medium">{conn.workspace}</p>
                  {failed ? (
                    <p className="select-text break-words text-[12px] leading-snug text-[var(--cf-danger)]">
                      {state.error}
                    </p>
                  ) : (
                    <p className="truncate text-[12px] text-[var(--cf-text-muted)]" title={kindLabel(conn.kind)}>
                      {who}
                    </p>
                  )}
                </div>
                {state === undefined || state === null ? (
                  <span className={chipClass("neutral")}>
                    <Loader2 size={12} className="animate-spin" /> {t("settings.adoChecking")}
                  </span>
                ) : failed ? (
                  <Tooltip label={t("settings.adoRecheck")}>
                    <button
                      type="button"
                      onClick={() => checkWorkspace(conn.workspace)}
                      aria-description={t("settings.adoRecheck")}
                      className={chipClass(
                        "bad",
                        "h-[22px] transition-colors duration-100 hover:bg-[color-mix(in_oklab,var(--cf-danger)_22%,transparent)]",
                      )}
                    >
                      <AlertTriangle size={12} /> {t("settings.adoNotWorking")}
                    </button>
                  </Tooltip>
                ) : check && check.missing.length > 0 ? (
                  // Pressable for the same reason the failed chip is: after recreating a token with
                  // the missing scopes, checking again is the next thing anyone does.
                  <Tooltip
                    label={t("settings.bitbucketMissingScopesList", { scopes: check.missing.join(", ") })}
                    description={
                      check.unverified.length > 0
                        ? t("settings.bitbucketUnverifiedScopes", { scopes: check.unverified.join(", ") })
                        : undefined
                    }
                  >
                    <button
                      type="button"
                      onClick={() => checkWorkspace(conn.workspace)}
                      aria-description={t("settings.adoRecheck")}
                      className={chipClass("warn", "h-[22px]")}
                    >
                      <AlertTriangle size={12} /> {t("settings.bitbucketMissingScopes")}
                    </button>
                  </Tooltip>
                ) : (
                  // The test, on demand: every chip here re-runs the check, so a token recreated with
                  // more scopes, or one about to expire, can be asked about without a restart.
                  <Tooltip
                    label={t("settings.adoRecheck")}
                    description={
                      check && check.unverified.length > 0
                        ? t("settings.bitbucketUnverifiedScopes", { scopes: check.unverified.join(", ") })
                        : undefined
                    }
                  >
                    <button
                      type="button"
                      onClick={() => checkWorkspace(conn.workspace)}
                      aria-description={t("settings.adoRecheck")}
                      className={chipClass("ok", "h-[22px]")}
                    >
                      <Check size={12} /> {t("settings.connected")}
                    </button>
                  </Tooltip>
                )}
                <Tooltip label={t("settings.remove")}>
                  <button
                    type="button"
                    aria-label={t("settings.remove")}
                    onClick={() => void handleRemove(conn.workspace)}
                    className="inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md text-[var(--cf-text-muted)] transition-colors duration-100 hover:bg-[color-mix(in_oklab,var(--cf-danger)_10%,transparent)] hover:text-[var(--cf-danger)] disabled:pointer-events-none disabled:opacity-40"
                  >
                    <Trash2 size={14} />
                  </button>
                </Tooltip>
              </div>
            );
          })}
        </div>
      )}

      <div className="space-y-3">
        <Segmented
          layoutId="cf-bitbucket-auth-kind"
          value={kind}
          onChange={(value) => {
            setKind(value);
            setError(null);
          }}
          options={[
            { value: "api_token", label: t("settings.bitbucketAuthApiToken") },
            { value: "access_token", label: t("settings.bitbucketAuthAccessToken") },
          ]}
          size="sm"
        />
        <div>
          <label
            htmlFor={`${fieldId}-workspace`}
            className="mb-1 block text-[12px] font-medium text-[var(--cf-text-muted)]"
          >
            {t("settings.bitbucketWorkspace")}
          </label>
          <input
            id={`${fieldId}-workspace`}
            value={workspace}
            onChange={(e) => setWorkspace(e.target.value)}
            placeholder={t("settings.bitbucketWorkspacePlaceholder")}
            spellCheck={false}
            autoComplete="off"
            className={fieldClass({ className: "w-full font-mono" })}
          />
        </div>
        {kind === "api_token" && (
          <div>
            <label
              htmlFor={`${fieldId}-email`}
              className="mb-1 block text-[12px] font-medium text-[var(--cf-text-muted)]"
            >
              {t("settings.bitbucketEmail")}
            </label>
            <input
              id={`${fieldId}-email`}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              spellCheck={false}
              autoComplete="off"
              className={fieldClass({ className: "w-full" })}
            />
          </div>
        )}
        <div>
          <label
            htmlFor={`${fieldId}-token`}
            className="mb-1 block text-[12px] font-medium text-[var(--cf-text-muted)]"
          >
            {t("settings.bitbucketToken")}
          </label>
          <input
            id={`${fieldId}-token`}
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            className={fieldClass({ className: "w-full font-mono" })}
          />
        </div>

        {error && (
          <div className="flex items-start gap-2 rounded-md border border-[var(--cf-danger)]/30 bg-[color-mix(in_oklab,var(--cf-danger)_8%,transparent)] px-2.5 py-2">
            <AlertTriangle size={13} className="mt-0.5 shrink-0 text-[var(--cf-danger)]" />
            <div className="min-w-0 flex-1">
              <p className="text-[12px] font-medium text-[var(--cf-danger)]">{t("settings.adoVerifyFailed")}</p>
              <p className="mt-0.5 select-text break-words text-[12px] leading-snug text-[var(--cf-text-muted)]">
                {error}
              </p>
            </div>
          </div>
        )}

        <div className="pt-1">
          <button
            type="button"
            disabled={saving || !complete}
            onClick={() => void handleSave()}
            className={buttonClass({ variant: "primary", size: "sm" })}
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : <KeyRound size={13} />}
            {saving ? t("settings.adoVerifying") : t("settings.saveToken")}
          </button>
        </div>
      </div>

      <TokenHowTo
        title={t(kind === "api_token" ? "settings.apiTokenHowTo" : "settings.accessTokenHowTo")}
        steps={
          kind === "api_token"
            ? [
                t("settings.bitbucketApiTokenStep1"),
                t("settings.bitbucketApiTokenStep2"),
                t("settings.bitbucketApiTokenStep3"),
                t("settings.bitbucketApiTokenStep4"),
              ]
            : [
                t("settings.bitbucketAccessTokenStep1"),
                t("settings.bitbucketAccessTokenStep2"),
                t("settings.bitbucketAccessTokenStep3"),
                t("settings.bitbucketAccessTokenStep4"),
              ]
        }
        linkLabel={t(kind === "api_token" ? "settings.bitbucketApiTokenOpenPage" : "settings.bitbucketAccessTokenOpenPage")}
        url={bitbucketTokenPageUrl(kind, workspace)}
      />
    </section>
  );
}
