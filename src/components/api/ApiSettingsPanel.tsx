import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Cloud,
  Info,
  DatabaseBackup,
  Download,
  Network,
  Plus,
  RefreshCw,
  Settings2,
  Share2,
  ShieldCheck,
  Trash2,
  Upload,
  Waypoints,
  type LucideIcon,
} from "lucide-react";
import { Checkbox } from "../common/Checkbox";
import { Select } from "../common/Select";
import { ActivePill } from "../common/ActivePill";
import { Field, GhostButton, Row } from "./ApiModal";
import { Actions, Group, HelpLink, Note, Panel, Status } from "./settingsChrome";
import { CollaborationPanel } from "./CollaborationPanel";
import { ensureApiStoreLoaded, useApiStore } from "../../state/apiStore";
import { useCollabStore } from "../../state/collabStore";
import { useUiStore } from "../../state/uiStore";
import type { ApiSettingsTab } from "../../state/apiModalStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { confirmAction } from "../../state/confirmStore";
import { pushErrorToast, useToastStore } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import {
  apiDeleteBackupPassphrase,
  apiExportAll,
  apiGetBackupPassphrase,
  apiImportAll,
  apiPickFile,
  apiReadTextFile,
  apiSaveFile,
  apiSetBackupPassphrase,
  gdriveConnect,
  gdriveDisconnect,
  gdriveDownload,
  gdriveFindFile,
  gdriveSetClientSecret,
  gdriveStatus,
  type DriveStatus,
} from "../../lib/tauri/apiCommands";
import {
  backupFileName,
  backupIsEncrypted,
  BackupPassphraseError,
  buildBackupFile,
  DRIVE_BACKUP_NAME,
  openBackupFile,
} from "../../lib/api/backup";
import { backupDestinationReady, runBackup } from "../../lib/api/autoBackup";
import type { ClientCert } from "../../types/api";
import type { TranslationKey } from "../../lib/i18n/translations";

const CERT_EXTENSIONS = ["p12", "pfx", "pem", "crt", "cer"];
const KEY_EXTENSIONS = ["pem", "key"];

/**
 * The consoles the bring-your-own credentials come from.
 */
const HELP_URLS = {
  googleCredentials: "https://console.cloud.google.com/apis/credentials",
  googleDriveApi: "https://console.cloud.google.com/apis/library/drive.googleapis.com",
  googleDesktopAppDocs: "https://developers.google.com/identity/protocols/oauth2/native-app",
} as const;

function newCertId(): string {
  return `cert-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Every numeric field here is a non-negative integer, and a half-typed one must not clear it. */
function number(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

/** A value the user reads rather than edits — a path, a token, an account. */
function Readout({ value, title }: { value: string; title?: string }) {
  return (
    <p
      title={title ?? value}
      className="mb-1.5 truncate rounded border border-[var(--cf-border)] bg-black/[0.02] px-1.5 py-1 font-mono text-[11px] text-[var(--cf-text-muted)] dark:bg-white/[0.03]"
    >
      {value}
    </p>
  );
}

/** A path field with a native picker beside it, used by all four certificate slots. */
function PathField({
  value,
  extensions,
  placeholder,
  onChange,
}: {
  value: string;
  extensions: string[];
  placeholder: string;
  onChange: (value: string) => void;
}) {
  const t = useT();
  const browse = async () => {
    const path = await apiPickFile(extensions).catch((e: unknown) => {
      pushErrorToast(String(e));
      return null;
    });
    if (path) onChange(path);
  };
  return (
    <div className="flex items-center gap-1.5">
      <Field mono value={value} placeholder={placeholder} onChange={onChange} />
      <GhostButton onClick={() => void browse()}>{t("api.settings.browse")}</GhostButton>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The panels, one per tab
// ---------------------------------------------------------------------------

function NetworkPanel() {
  const t = useT();
  const settings = useApiStore((s) => s.settings);
  const updateSettings = useApiStore((s) => s.updateSettings);

  return (
    <Panel>
      <Row label={t("api.settings.timeout")}>
        <Field
          type="number"
          value={String(settings.timeoutMs)}
          onChange={(value) => void updateSettings({ timeoutMs: number(value, settings.timeoutMs) })}
        />
      </Row>
      <Row label={t("api.settings.followRedirects")}>
        <Checkbox
          checked={settings.followRedirects}
          onChange={(followRedirects) => void updateSettings({ followRedirects })}
        />
      </Row>
      <Row label={t("api.settings.maxRedirects")}>
        <Field
          type="number"
          disabled={!settings.followRedirects}
          value={String(settings.maxRedirects)}
          onChange={(value) =>
            void updateSettings({ maxRedirects: number(value, settings.maxRedirects) })
          }
        />
      </Row>
      <Row label={t("api.settings.verifySsl")}>
        <Checkbox
          checked={settings.verifySsl}
          onChange={(verifySsl) => void updateSettings({ verifySsl })}
        />
      </Row>

      {/* Shown rather than hidden: the field exists in `ApiSettings` and in the per-request
          overrides, so leaving it out entirely would read as an oversight instead of a limit. */}
      <div className="flex items-center gap-3 py-1 opacity-60">
        <span className="min-w-0 flex-1">
          <span className="block text-[12px] text-[var(--cf-text)]">
            {t("api.settings.keepAuthOnRedirect")}
          </span>
          <span className="flex items-start gap-1 text-[11px] leading-snug text-[var(--cf-text-muted)]">
            <Info size={11} className="mt-[2px] shrink-0" />
            {t("api.settings.keepAuthUnavailable")}
          </span>
        </span>
        <span className="flex w-[180px] shrink-0 justify-end">
          <Checkbox checked={false} disabled onChange={() => {}} />
        </span>
      </div>

      <Row label={t("api.settings.sendCookies")}>
        <Checkbox
          checked={settings.sendCookies}
          onChange={(sendCookies) => void updateSettings({ sendCookies })}
        />
      </Row>
    </Panel>
  );
}

function ProxyPanel() {
  const t = useT();
  const settings = useApiStore((s) => s.settings);
  const updateSettings = useApiStore((s) => s.updateSettings);

  return (
    <Panel>
      <Row label={t("api.settings.proxyEnabled")}>
        <Checkbox
          checked={settings.proxyEnabled}
          onChange={(proxyEnabled) => void updateSettings({ proxyEnabled })}
        />
      </Row>
      <Row label={t("api.settings.proxyUrl")} wide>
        <Field
          mono
          disabled={!settings.proxyEnabled}
          value={settings.proxyUrl}
          placeholder="http://127.0.0.1:8080"
          onChange={(proxyUrl) => void updateSettings({ proxyUrl })}
        />
      </Row>
    </Panel>
  );
}

function CertificatesPanel() {
  const t = useT();
  const settings = useApiStore((s) => s.settings);
  const updateSettings = useApiStore((s) => s.updateSettings);

  const patchCert = (id: string, patch: Partial<ClientCert>) =>
    void updateSettings({
      clientCerts: settings.clientCerts.map((cert) => (cert.id === id ? { ...cert, ...patch } : cert)),
    });

  const addCert = () =>
    void updateSettings({
      clientCerts: [
        ...settings.clientCerts,
        { id: newCertId(), host: "", certPath: "", keyPath: "", passphrase: "" },
      ],
    });

  const removeCert = (id: string) =>
    void updateSettings({ clientCerts: settings.clientCerts.filter((cert) => cert.id !== id) });

  return (
    <Panel>
      <div className="mb-2">
        <label className="mb-1 block text-[11px] font-medium text-[var(--cf-text-muted)]">
          {t("api.settings.caCert")}
        </label>
        <PathField
          value={settings.caCertPath}
          extensions={["pem", "crt", "cer"]}
          placeholder="ca-bundle.pem"
          onChange={(caCertPath) => void updateSettings({ caCertPath })}
        />
      </div>

      <div className="mb-1 flex items-center">
        <span className="mr-auto text-[11px] font-medium text-[var(--cf-text-muted)]">
          {t("api.settings.clientCerts")}
        </span>
        <GhostButton onClick={addCert}>
          <Plus size={12} />
          {t("api.settings.addCert")}
        </GhostButton>
      </div>

      {settings.clientCerts.length === 0 ? (
        <p className="py-1 text-[11px] text-[var(--cf-text-muted)]">{t("api.settings.noCerts")}</p>
      ) : (
        settings.clientCerts.map((cert) => (
          <div key={cert.id} className="mb-2 rounded-md border border-[var(--cf-border)] p-2">
            <div className="mb-1.5 flex items-center gap-2">
              <Field
                mono
                value={cert.host}
                placeholder={t("api.settings.certHost")}
                onChange={(host) => patchCert(cert.id, { host })}
              />
              <button
                onClick={() => removeCert(cert.id)}
                title={t("api.settings.removeCert")}
                className="shrink-0 rounded p-1 text-[var(--cf-text-muted)] hover:text-[var(--cf-danger)]"
              >
                <Trash2 size={12} />
              </button>
            </div>
            <div className="mb-1.5">
              <PathField
                value={cert.certPath}
                extensions={CERT_EXTENSIONS}
                placeholder={t("api.settings.certFile")}
                onChange={(certPath) => patchCert(cert.id, { certPath })}
              />
            </div>
            <div className="mb-1.5">
              <PathField
                value={cert.keyPath}
                extensions={KEY_EXTENSIONS}
                placeholder={t("api.settings.keyFile")}
                onChange={(keyPath) => patchCert(cert.id, { keyPath })}
              />
            </div>
            <Field
              type="password"
              value={cert.passphrase}
              placeholder={t("api.settings.passphrase")}
              onChange={(passphrase) => patchCert(cert.id, { passphrase })}
            />
          </div>
        ))
      )}
    </Panel>
  );
}

function GeneralPanel() {
  const t = useT();
  const settings = useApiStore((s) => s.settings);
  const updateSettings = useApiStore((s) => s.updateSettings);
  const clearHistory = useApiStore((s) => s.clearHistory);
  const clearCookies = useApiStore((s) => s.clearCookies);
  const historyCount = useApiStore((s) => s.history.length);
  const cookieCount = useApiStore((s) => s.cookies.length);
  const pushToast = useToastStore((s) => s.pushToast);

  const wipeHistory = async () => {
    if (!(await confirmAction(t("api.settings.clearHistoryConfirm")))) return;
    await clearHistory();
  };

  const wipeCookies = async () => {
    if (!(await confirmAction(t("api.cookie.clearAllConfirm")))) return;
    await clearCookies();
    pushToast(t("api.toast.cookieCleared"), "success");
  };

  return (
    <Panel>
      <Row label={t("api.settings.maxResponse")}>
        <Field
          type="number"
          value={String(settings.maxResponseBytes)}
          onChange={(value) =>
            void updateSettings({ maxResponseBytes: number(value, settings.maxResponseBytes) })
          }
        />
      </Row>
      <Row label={t("api.settings.prettyPrint")}>
        <Checkbox
          checked={settings.prettyPrint}
          onChange={(prettyPrint) => void updateSettings({ prettyPrint })}
        />
      </Row>
      <Row label={t("api.settings.saveHistory")}>
        <Checkbox
          checked={settings.saveHistory}
          onChange={(saveHistory) => void updateSettings({ saveHistory })}
        />
      </Row>
      <Row label={t("api.settings.historyLimit")}>
        <Field
          type="number"
          disabled={!settings.saveHistory}
          value={String(settings.historyLimit)}
          onChange={(value) =>
            void updateSettings({ historyLimit: number(value, settings.historyLimit) })
          }
        />
      </Row>

      {/* Every control above is stored under the one global `api_settings` key; the two buttons
          below empty only the current workspace's history and jar — as do the counts that
          disable them. Saying so is cheaper than the support question. */}
      <div className="mt-2 border-t border-[var(--cf-border)] pt-2">
        <p className="mb-1.5 flex items-start gap-1 text-[11px] leading-snug text-[var(--cf-text-muted)]">
          <Info size={11} className="mt-[2px] shrink-0" />
          {t("api.settings.workspaceScope")}
        </p>
        <div className="flex items-center gap-2">
          <GhostButton onClick={() => void wipeHistory()} disabled={historyCount === 0}>
            <Trash2 size={12} />
            {t("api.settings.clearHistory")}
          </GhostButton>
          <GhostButton onClick={() => void wipeCookies()} disabled={cookieCount === 0}>
            <Trash2 size={12} />
            {t("api.settings.clearCookies")}
          </GhostButton>
        </div>
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------

/**
 * Export/import of every workspace's API data, plus the destination the automatic backup keeps up
 * to date. See `lib/api/backup.ts` for what travels and what a passphrase changes; the passphrase
 * itself lives in the OS credential store, never in `api_settings`.
 */
function BackupPanel() {
  const t = useT();
  const settings = useApiStore((s) => s.settings);
  const updateSettings = useApiStore((s) => s.updateSettings);
  const pushToast = useToastStore((s) => s.pushToast);

  const [passphrase, setPassphrase] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [replace, setReplace] = useState(false);
  const [busy, setBusy] = useState(false);

  // Recomputed on every render rather than memoised: it reads the same store slice this component
  // already subscribes to, so it is never stale and never worth a dependency list.
  const ready = backupDestinationReady();

  // Whether anything here is also synced with a team — it changes what a `replace` restore does,
  // because the wipe it performs travels to everyone as a pile of deletions.
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const shared = useCollabStore((s) =>
    s.shares.some((share) => share.workspace_id === workspaceId),
  );

  useEffect(() => {
    void apiGetBackupPassphrase()
      .then((stored) => setPassphrase(stored ?? ""))
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  // Debounced so typing a passphrase isn't one credential-store write per keystroke. Gated on
  // `loaded` so the empty initial state can't wipe the stored one before it has been read back.
  useEffect(() => {
    if (!loaded) return;
    const timer = setTimeout(() => {
      const write = passphrase === "" ? apiDeleteBackupPassphrase() : apiSetBackupPassphrase(passphrase);
      void write.catch((e: unknown) => pushErrorToast(String(e)));
    }, 600);
    return () => clearTimeout(timer);
  }, [passphrase, loaded]);

  /** The passphrase a write should use — `""` means the stripped-plaintext form. */
  const sealWith = (): string => {
    if (!settings.backupEncrypt) return "";
    if (passphrase === "") throw new Error(t("api.backup.setPassphraseFirst"));
    return passphrase;
  };

  const writeThroughDialog = async (remember: boolean) => {
    setBusy(true);
    try {
      const text = await buildBackupFile(await apiExportAll(), sealWith());
      const path = await apiSaveFile(backupFileName(), text);
      if (!path) return;
      const now = new Date().toISOString();
      await updateSettings(remember ? { backupPath: path, lastBackupAt: now } : { lastBackupAt: now });
      pushToast(t("api.backup.done", { path }), "success");
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setBusy(false);
    }
  };

  const backupNow = async () => {
    setBusy(true);
    try {
      const path = await runBackup();
      if (path) pushToast(t("api.backup.done", { path }), "success");
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setBusy(false);
    }
  };

  /** Restores from an already-read backup, whether it came off the disk or out of Drive. */
  const applyBackup = async (text: string) => {
    const encrypted = backupIsEncrypted(text);
    if (encrypted && passphrase === "") {
      pushErrorToast(t("api.backup.needPassphrase"));
      return;
    }
    if (!(await confirmAction(replace ? t("api.backup.replaceConfirm") : t("api.backup.mergeConfirm")))) {
      return;
    }

    const payload = await openBackupFile(text, encrypted ? passphrase : "");
    const summary = await apiImportAll(payload, replace);

    // The import writes straight to SQLite, and it can have created workspaces this session has
    // never seen — so both the workspace list and this workspace's tree have to be re-read.
    await useWorkspaceStore.getState().loadWorkspaces();
    await useApiStore.getState().reloadTree();
    await useApiStore.getState().reloadEnvironments();

    pushToast(
      t("api.backup.imported", {
        collections: String(summary.collections),
        requests: String(summary.requests),
        environments: String(summary.environments),
      }),
      "success",
    );
  };

  /** One place to turn a failed restore into a sentence, since two buttons can start one. */
  const runRestore = async (read: () => Promise<string>) => {
    setBusy(true);
    try {
      await applyBackup(await read());
    } catch (e) {
      pushErrorToast(
        e instanceof BackupPassphraseError && e.wrong ? t("api.backup.wrongPassphrase") : String(e),
      );
    } finally {
      setBusy(false);
    }
  };

  const importFromFile = async () => {
    const path = await apiPickFile(["json"]).catch((e: unknown) => {
      pushErrorToast(String(e));
      return null;
    });
    if (path) await runRestore(() => apiReadTextFile(path));
  };

  const importFromDrive = () =>
    runRestore(async () => {
      const fileId =
        settings.driveFileId || (await gdriveFindFile(settings.driveClientId, DRIVE_BACKUP_NAME));
      if (!fileId) throw new Error(t("api.backup.driveNoFile"));
      if (fileId !== settings.driveFileId) await updateSettings({ driveFileId: fileId });
      return gdriveDownload(settings.driveClientId, fileId);
    });

  const lastBackup =
    settings.lastBackupAt === ""
      ? t("api.backup.never")
      : new Date(settings.lastBackupAt).toLocaleString();

  return (
    <Panel>
      <Note>{t("api.backup.about")}</Note>

      <Group title={t("api.backup.groupEncryption")}>
        <Row label={t("api.backup.encrypt")} hint={t("api.backup.encryptHint")}>
          <Checkbox
            checked={settings.backupEncrypt}
            onChange={(backupEncrypt) => void updateSettings({ backupEncrypt })}
          />
        </Row>
        <Row label={t("api.backup.passphrase")} hint={t("api.backup.passphraseHint")} wide>
          <Field
            type="password"
            disabled={!settings.backupEncrypt}
            value={passphrase}
            placeholder={t("api.backup.passphrasePlaceholder")}
            onChange={setPassphrase}
          />
        </Row>
      </Group>

      <Group title={t("api.backup.groupManual")}>
        <Actions>
          <GhostButton onClick={() => void writeThroughDialog(false)} disabled={busy}>
            <Upload size={12} />
            {t("api.backup.exportNow")}
          </GhostButton>
          <GhostButton onClick={() => void importFromFile()} disabled={busy}>
            <Download size={12} />
            {t("api.backup.import")}
          </GhostButton>
          <label className="ml-1 flex items-center gap-1.5 text-[11px] text-[var(--cf-text-muted)]">
            <Checkbox checked={replace} onChange={setReplace} />
            {t("api.backup.replace")}
          </label>
        </Actions>
        <p className="mt-1.5 text-[11px] leading-snug text-[var(--cf-text-muted)]">
          {replace ? t("api.backup.replaceHint") : t("api.backup.mergeHint")}
        </p>
        {/* Restoring into a workspace that is also shared goes wrong in two different ways, and
            which one depends on the checkbox above — so the warning has to say which. */}
        {shared && (
          <Note tone="warning">
            {replace ? t("api.backup.replaceSharedWarning") : t("api.backup.mergeSharedWarning")}
          </Note>
        )}
      </Group>

      <Group title={t("api.backup.groupAutomatic")}>
        <Row label={t("api.backup.target")} hint={t("api.backup.targetHint")} wide>
          <Select
            size="sm"
            value={settings.backupTarget}
            onChange={(value) =>
              void updateSettings({ backupTarget: value === "drive" ? "drive" : "local" })
            }
            options={[
              { value: "local", label: t("api.backup.targetLocal") },
              { value: "drive", label: t("api.backup.targetDrive") },
            ]}
            ariaLabel={t("api.backup.target")}
          />
        </Row>

        {settings.backupTarget === "local" ? (
          <>
            <Row label={t("api.backup.destination")} hint={t("api.backup.destinationHint")} wide>
              <GhostButton onClick={() => void writeThroughDialog(true)} disabled={busy}>
                {t("api.settings.browse")}
              </GhostButton>
            </Row>
            {settings.backupPath !== "" && <Readout value={settings.backupPath} />}
          </>
        ) : (
          <DriveConnection busy={busy} onRestore={() => void importFromDrive()} />
        )}

        <Row label={t("api.backup.auto")} hint={t("api.backup.autoHint")}>
          <Checkbox
            checked={settings.autoBackup}
            disabled={!ready}
            onChange={(autoBackup) => void updateSettings({ autoBackup })}
          />
        </Row>

        {/* Two machines writing one destination don't merge — the file is whatever the last one
            wrote. Worth saying where the destination is chosen, not in a doc nobody opens. */}
        {settings.autoBackup && <Note>{t("api.backup.oneWriterWarning")}</Note>}

        <div className="mt-1 flex items-center justify-between gap-2">
          <Status tone={settings.lastBackupAt === "" ? "muted" : "success"}>
            {t("api.backup.lastAt", { at: lastBackup })}
          </Status>
          <GhostButton onClick={() => void backupNow()} disabled={busy || !ready}>
            <RefreshCw size={12} />
            {t("api.backup.runNow")}
          </GhostButton>
        </div>
      </Group>
    </Panel>
  );
}

/**
 * The user's own Google OAuth client, and the consent flow that turns it into a connection.
 *
 * The credentials are theirs, from a Google Cloud project they create: the backup goes to their
 * Drive through their own registration, with nothing of ours in the path. The price is the setup
 * described in `api.backup.driveSetup`, which is why the fields are spelled out rather than hidden
 * behind a single "Connect" button that would fail with an opaque error.
 */
function DriveConnection({ busy, onRestore }: { busy: boolean; onRestore: () => void }) {
  const t = useT();
  const settings = useApiStore((s) => s.settings);
  const updateSettings = useApiStore((s) => s.updateSettings);

  const [status, setStatus] = useState<DriveStatus>({ has_secret: false, connected: false });
  const [secret, setSecret] = useState("");
  const [connecting, setConnecting] = useState(false);

  const refresh = () => void gdriveStatus().then(setStatus).catch(() => {});
  useEffect(refresh, []);

  const saveSecret = async (value: string) => {
    setSecret(value);
    await gdriveSetClientSecret(value).catch((e: unknown) => pushErrorToast(String(e)));
    refresh();
  };

  const connect = async () => {
    setConnecting(true);
    try {
      const account = await gdriveConnect(settings.driveClientId);
      await updateSettings({ driveAccount: account.email });
      refresh();
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setConnecting(false);
    }
  };

  const disconnect = async () => {
    if (!(await confirmAction(t("api.backup.driveDisconnectConfirm")))) return;
    await gdriveDisconnect().catch((e: unknown) => pushErrorToast(String(e)));
    // The file id is scoped to the account that was connected; keeping it would make the next
    // connection try to overwrite a file it may no longer be allowed to see.
    await updateSettings({ driveAccount: "", driveFileId: "" });
    refresh();
  };

  return (
    <div className="mb-1">
      <Note>{t("api.backup.driveSetup")}</Note>
      {/* In the order the setup actually happens: turn the API on, then create the client. */}
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <HelpLink url={HELP_URLS.googleDriveApi}>{t("api.backup.driveHelpEnable")}</HelpLink>
        <HelpLink url={HELP_URLS.googleCredentials}>{t("api.backup.driveHelpCreate")}</HelpLink>
        <HelpLink url={HELP_URLS.googleDesktopAppDocs}>{t("api.backup.driveHelpDocs")}</HelpLink>
      </div>

      <Row label={t("api.backup.driveClientId")} wide>
        <Field
          mono
          value={settings.driveClientId}
          placeholder="…apps.googleusercontent.com"
          onChange={(driveClientId) => void updateSettings({ driveClientId })}
        />
      </Row>
      <Row label={t("api.backup.driveClientSecret")} wide>
        <Field
          type="password"
          value={secret}
          placeholder={status.has_secret ? t("api.backup.driveSecretStored") : ""}
          onChange={(value) => void saveSecret(value)}
        />
      </Row>

      <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
        {status.connected ? (
          <>
            <Status tone="success">
              {settings.driveAccount === ""
                ? t("api.backup.driveConnected")
                : t("api.backup.driveConnectedAs", { email: settings.driveAccount })}
            </Status>
            <Actions>
              <GhostButton onClick={onRestore} disabled={busy}>
                <Download size={12} />
                {t("api.backup.driveRestore")}
              </GhostButton>
              <GhostButton onClick={() => void disconnect()}>
                {t("api.backup.driveDisconnect")}
              </GhostButton>
            </Actions>
          </>
        ) : (
          <>
            <Status tone="muted">{t("api.backup.driveNotConnected")}</Status>
            <GhostButton
              onClick={() => void connect()}
              disabled={connecting || settings.driveClientId.trim() === "" || !status.has_secret}
            >
              <Cloud size={12} />
              {connecting ? t("api.backup.driveWaiting") : t("api.backup.driveConnect")}
            </GhostButton>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

const TABS: { id: ApiSettingsTab; labelKey: TranslationKey; icon: LucideIcon; beta?: boolean }[] = [
  { id: "network", labelKey: "api.settings.network", icon: Network },
  { id: "proxy", labelKey: "api.settings.proxy", icon: Waypoints },
  { id: "certificates", labelKey: "api.settings.certificates", icon: ShieldCheck },
  { id: "general", labelKey: "settings.general", icon: Settings2 },
  { id: "backup", labelKey: "api.backup.title", icon: DatabaseBackup, beta: true },
  { id: "collab", labelKey: "api.collab.title", icon: Share2 },
];

/**
 * The settings themselves, without the modal around them, so the `api` section of the main
 * Settings window shows exactly the same controls instead of a second copy that drifts.
 *
 * Behind sub-tabs rather than stacked: five groups down one scroll meant the backup controls — the
 * ones a new user has to find — sat below three screens of transport tuning nobody edits twice.
 */
export function ApiSettingsBody() {
  const t = useT();
  // Which sub-tab to land on comes from whoever opened the window: "share this collection" asks for
  // the collaboration one, and anything that just wants "settings" asks for nothing and gets the
  // first tab.
  const initialTab = useUiStore((s) => s.apiSettingsTab);
  // Reachable from the Settings window before the API view has ever been opened, in which case
  // the store still holds its defaults — and writing one back would overwrite what's on disk.
  useEffect(() => {
    void ensureApiStoreLoaded();
  }, []);

  const [tab, setTab] = useState<ApiSettingsTab>(initialTab ?? "network");

  // Initial state alone would only be read on mount, and a caller that asks for a tab while this
  // is already on screen would be silently ignored.
  useEffect(() => {
    if (initialTab) setTab(initialTab);
  }, [initialTab]);

  // The scrolling happens in the settings pane around this body, and the six panes are nowhere
  // near the same height — switching from a tall one that had been scrolled down handed the next
  // one a viewport starting somewhere in its middle, and the browser then clamped that offset
  // against the new, shorter content while the rail's pill was still sliding. Back to the top on
  // every switch, in a layout effect so it lands before the frame is painted rather than as a
  // visible correction after it.
  const bodyRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    bodyRef.current?.closest("[data-settings-scroll]")?.scrollTo({ top: 0 });
  }, [tab]);

  return (
    <div ref={bodyRef} className="flex gap-4">
      {/* A rail rather than a strip across the top.
          Six sub-tabs with Spanish labels in a 576px column already wrapped, and the wrap put
          "Colaboración" — the one most used right now — alone on a second line; a "beta" badge was
          all it took to tip it over. Down the side there is nothing to wrap: a seventh tab, a
          longer translation or another badge all just make the list one row taller. It is also the
          shape the settings window around it already uses, which is why a nested nav reads as part
          of the same furniture instead of as a second idea. */}
      <nav className="sticky top-0 w-[168px] shrink-0 self-start">
        {TABS.map(({ id, labelKey, icon: Icon, beta }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            aria-current={tab === id ? "page" : undefined}
            title={t(labelKey)}
            // Colour and the pill carry the selection; no weight change, for the same reason the
            // outer nav avoids one — bolding re-measures the label and reflows the row.
            className={`relative mb-0.5 flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-[12.5px] transition-colors ${
              tab === id
                ? "text-[var(--cf-accent)]"
                : "text-[var(--cf-text-muted)] hover:bg-black/[0.03] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.04]"
            }`}
          >
            {tab === id && <ActivePill layoutId="cf-api-settings-pill" />}
            {/* Above the pill, which covers the whole button. */}
            <span className="relative flex min-w-0 flex-1 items-center gap-1.5">
              <Icon size={13} className="shrink-0" />
              <span className="truncate">{t(labelKey)}</span>
              {/* Says "this one has not been through as many hands as the rest yet" — sized and
                  coloured to be read once and then ignored, not to compete with the label. */}
              {beta && (
                <span className="ml-auto shrink-0 rounded bg-[color-mix(in_oklab,var(--cf-warning)_18%,transparent)] px-1 py-[1px] text-[9px] font-bold uppercase tracking-wide text-[var(--cf-warning)]">
                  {t("common.beta")}
                </span>
              )}
            </span>
          </button>
        ))}
      </nav>

      <div className="min-w-0 flex-1">
        {tab === "network" && <NetworkPanel />}
        {tab === "proxy" && <ProxyPanel />}
        {tab === "certificates" && <CertificatesPanel />}
        {tab === "general" && <GeneralPanel />}
        {tab === "backup" && <BackupPanel />}
        {tab === "collab" && <CollaborationPanel />}
      </div>
    </div>
  );
}
