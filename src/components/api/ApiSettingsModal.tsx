import { useEffect, useState, type ReactNode } from "react";
import {
  ClipboardCopy,
  Cloud,
  DatabaseBackup,
  Download,
  ExternalLink,
  Info,
  Network,
  Plus,
  RefreshCw,
  Settings2,
  Share2,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  Upload,
  Waypoints,
  type LucideIcon,
} from "lucide-react";
import { Checkbox } from "../common/Checkbox";
import { Select } from "../common/Select";
import { ActiveUnderline } from "../common/ActivePill";
import { ApiModal, Field, GhostButton, Row } from "./ApiModal";
import { ensureApiStoreLoaded, useApiStore } from "../../state/apiStore";
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
  supabaseCheck,
  supabaseHasKey,
  supabaseInstallSql,
  supabaseJoin,
  supabaseLeave,
  supabasePull,
  supabaseRotate,
  supabaseSetAnonKey,
  supabaseShare,
  supabaseShareToken,
  type DriveStatus,
  type SupabaseCheck,
} from "../../lib/tauri/apiCommands";
import { openExternalUrl } from "../../lib/tauri/commands";
import { decodeInvite, encodeInvite, resetCursor, syncNow } from "../../lib/api/sync";
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
 * The consoles the bring-your-own credentials come from. `project/_/` is Supabase's own placeholder
 * for "whichever project is selected", so these land on the right page without knowing its ref.
 */
const HELP_URLS = {
  googleCredentials: "https://console.cloud.google.com/apis/credentials",
  googleDriveApi: "https://console.cloud.google.com/apis/library/drive.googleapis.com",
  googleDesktopAppDocs: "https://developers.google.com/identity/protocols/oauth2/native-app",
  supabaseNewProject: "https://supabase.com/dashboard/new",
  supabaseApiSettings: "https://supabase.com/dashboard/project/_/settings/api",
  supabaseSqlEditor: "https://supabase.com/dashboard/project/_/sql/new",
} as const;

function newCertId(): string {
  return `cert-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** One tab's worth of settings. The tab above already names it, so there is no heading here. */
function Panel({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border border-[var(--cf-border)] px-3 py-2">{children}</div>;
}

/** Every numeric field here is a non-negative integer, and a half-typed one must not clear it. */
function number(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

// ---------------------------------------------------------------------------
// Shared bits for the two panels that are less "settings" than "a thing with a state"
// ---------------------------------------------------------------------------

/** A titled block inside a panel — the backup and collaboration tabs are each several of these. */
function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-3 border-t border-[var(--cf-border)] pt-2.5 first:mt-0 first:border-0 first:pt-0">
      <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
        {title}
      </h4>
      {children}
    </section>
  );
}

type Tone = "muted" | "warning" | "success";

const TONE_TEXT: Record<Tone, string> = {
  muted: "text-[var(--cf-text-muted)]",
  warning: "text-[var(--cf-warning)]",
  success: "text-[var(--cf-success)]",
};

/**
 * An explanatory line. `warning` is reserved for the two places where the honest answer is "this
 * can lose your work" — spending it on ordinary guidance is what makes real warnings invisible.
 */
function Note({ tone = "muted", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <p className={`mb-1.5 flex items-start gap-1.5 text-[11px] leading-snug ${TONE_TEXT[tone]}`}>
      {tone === "warning" ? (
        <TriangleAlert size={11} className="mt-[2px] shrink-0" />
      ) : (
        <Info size={11} className="mt-[2px] shrink-0" />
      )}
      <span>{children}</span>
    </p>
  );
}

/** Connected / not connected, as a dot and a sentence rather than a paragraph to parse. */
function Status({ tone, children }: { tone: Tone; children: ReactNode }) {
  const dot = {
    muted: "bg-[var(--cf-text-muted)]",
    warning: "bg-[var(--cf-warning)]",
    success: "bg-[var(--cf-success)]",
  }[tone];
  return (
    <span className={`flex min-w-0 items-center gap-1.5 text-[11px] ${TONE_TEXT[tone]}`}>
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
      <span className="truncate">{children}</span>
    </span>
  );
}

/** A row of buttons, spaced and wrapping the same way everywhere. */
function Actions({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-1.5">{children}</div>;
}

/**
 * Where to get the credentials the field above is asking for.
 *
 * Both integrations are bring-your-own, which means the setup happens in someone else's console
 * before this panel is any use at all. A field labelled "Client ID" with no way to find out where a
 * client id comes from is where that setup stalls.
 */
function HelpLink({ url, children }: { url: string; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={() => void openExternalUrl(url).catch((e: unknown) => pushErrorToast(String(e)))}
      title={url}
      className="inline-flex items-center gap-1 rounded text-[11px] text-[var(--cf-accent)] hover:underline"
    >
      {children}
      <ExternalLink size={10} className="shrink-0" />
    </button>
  );
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

export function ApiSettingsModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  return (
    <ApiModal icon={Settings2} title={t("api.settings.title")} width="max-w-2xl" onClose={onClose}>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        <ApiSettingsBody />
      </div>
    </ApiModal>
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

  // Whether this workspace is also synced — it changes what a `replace` restore actually does.
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const [shared, setShared] = useState(false);
  useEffect(() => {
    if (!workspaceId) return;
    void supabaseShareToken(workspaceId)
      .then((token) => setShared(token !== null))
      .catch(() => {});
  }, [workspaceId]);

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

/**
 * Shared workspaces on the user's own Supabase project.
 *
 * The security model is the share token, not an account: whoever holds the invitation code can
 * read and write the workspace. That is the "anyone with the link works on this with me" model the
 * panel is for, so the code is presented as the credential it is rather than as a harmless link.
 */
function CollaborationPanel() {
  const t = useT();
  const settings = useApiStore((s) => s.settings);
  const updateSettings = useApiStore((s) => s.updateSettings);
  const pushToast = useToastStore((s) => s.pushToast);
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const workspaceName = useWorkspaceStore((s) => {
    const id = s.activeWorkspaceId;
    return s.workspaces.find((w) => w.id === id)?.name ?? "";
  });

  const [anonKey, setAnonKey] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [check, setCheck] = useState<SupabaseCheck | null>(null);
  const [joinCode, setJoinCode] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = () => {
    void supabaseHasKey().then(setHasKey).catch(() => {});
    if (workspaceId) void supabaseShareToken(workspaceId).then(setToken).catch(() => {});
  };
  useEffect(refresh, [workspaceId]);

  const guard = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setBusy(false);
    }
  };

  const saveKey = async (value: string) => {
    setAnonKey(value);
    await supabaseSetAnonKey(value).catch((e: unknown) => pushErrorToast(String(e)));
    refresh();
  };

  const test = () =>
    guard(async () => {
      if (!workspaceId) return;
      setCheck(await supabaseCheck(settings.supabaseUrl, workspaceId));
    });

  const copySql = () =>
    guard(async () => {
      await navigator.clipboard.writeText(await supabaseInstallSql());
      pushToast(t("api.collab.sqlCopied"), "success");
    });

  const startSharing = () =>
    guard(async () => {
      if (!workspaceId) return;
      const shared = await supabaseShare(settings.supabaseUrl, workspaceId, workspaceName);
      setToken(shared.share_token);
      // The first push is what makes the invitation useful: a guest joining an empty workspace
      // would see nothing and reasonably conclude it was broken.
      await syncNow();
      pushToast(t("api.collab.sharingStarted"), "success");
    });

  const copyInvite = () =>
    guard(async () => {
      if (!token) return;
      // The stored key is write-only from here — the credential store hands it to the backend, not
      // to this panel — so building an invitation needs it typed in this session at least once.
      if (anonKey === "") {
        pushErrorToast(t("api.collab.needKeyForInvite"));
        return;
      }
      await navigator.clipboard.writeText(
        encodeInvite({ url: settings.supabaseUrl, key: anonKey, token, name: workspaceName }),
      );
      pushToast(t("api.collab.inviteCopied"), "success");
    });

  const join = () =>
    guard(async () => {
      const invite = decodeInvite(joinCode);
      await supabaseSetAnonKey(invite.key);
      await updateSettings({ supabaseUrl: invite.url });
      const shared = await supabaseJoin(invite.url, invite.token);

      // Joining can create a workspace this machine has never seen, so the list has to be re-read
      // before it can be switched to.
      await supabasePull(invite.url, shared.id, shared.name, "");
      await useWorkspaceStore.getState().loadWorkspaces();
      await useWorkspaceStore.getState().setActiveWorkspace(shared.id);

      setJoinCode("");
      refresh();
      pushToast(t("api.collab.joined", { name: shared.name }), "success");
    });

  const rotate = () =>
    guard(async () => {
      if (!workspaceId) return;
      if (!(await confirmAction(t("api.collab.rotateConfirm")))) return;
      setToken(await supabaseRotate(settings.supabaseUrl, workspaceId));
      pushToast(t("api.collab.rotated"), "success");
    });

  const leave = () =>
    guard(async () => {
      if (!workspaceId) return;
      if (!(await confirmAction(t("api.collab.leaveConfirm")))) return;
      await supabaseLeave(workspaceId);
      await resetCursor(workspaceId);
      setToken(null);
      refresh();
    });

  const sync = () =>
    guard(async () => {
      const result = await syncNow();
      if (result === null) {
        pushToast(t("api.collab.notShared"), "info");
        return;
      }
      pushToast(
        t("api.collab.synced", {
          applied: String(result.applied.collections + result.applied.requests),
          deleted: String(result.deleted),
        }),
        "success",
      );
    });

  const configured = settings.supabaseUrl.trim() !== "" && hasKey;

  return (
    <Panel>
      <Note>{t("api.collab.about")}</Note>

      <Group title={t("api.collab.groupProject")}>
        {/* Create the project, copy its two values, then run the script — the three steps below,
            in that order, each landing on the page they happen on. */}
        <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
          <HelpLink url={HELP_URLS.supabaseNewProject}>{t("api.collab.helpNewProject")}</HelpLink>
          <HelpLink url={HELP_URLS.supabaseApiSettings}>{t("api.collab.helpApiKeys")}</HelpLink>
          <HelpLink url={HELP_URLS.supabaseSqlEditor}>{t("api.collab.helpSqlEditor")}</HelpLink>
        </div>

        <Row label={t("api.collab.projectUrl")} wide>
          <Field
            mono
            value={settings.supabaseUrl}
            placeholder="https://xxxx.supabase.co"
            onChange={(supabaseUrl) => void updateSettings({ supabaseUrl })}
          />
        </Row>
        <Row label={t("api.collab.anonKey")} hint={t("api.collab.anonKeyHint")} wide>
          <Field
            type="password"
            value={anonKey}
            placeholder={hasKey ? t("api.collab.keyStored") : ""}
            onChange={(value) => void saveKey(value)}
          />
        </Row>

        <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
          {check ? (
            <Status
              tone={!check.reachable || !check.schema_installed ? "warning" : "success"}
            >
              {!check.reachable
                ? t("api.collab.unreachable")
                : !check.schema_installed
                  ? t("api.collab.schemaMissing")
                  : check.workspace_name !== ""
                    ? t("api.collab.checkShared", { name: check.workspace_name })
                    : t("api.collab.checkReady")}
            </Status>
          ) : (
            <Status tone="muted">{t("api.collab.untested")}</Status>
          )}
          <Actions>
            <GhostButton onClick={copySql} disabled={busy}>
              <ClipboardCopy size={12} />
              {t("api.collab.copySql")}
            </GhostButton>
            <GhostButton onClick={test} disabled={busy || !configured}>
              <RefreshCw size={12} />
              {t("api.collab.test")}
            </GhostButton>
          </Actions>
        </div>
      </Group>

      <Group title={t("api.collab.thisWorkspace", { name: workspaceName })}>
        {token === null ? (
          <>
            <p className="mb-1.5 text-[11px] leading-snug text-[var(--cf-text-muted)]">
              {t("api.collab.shareHint")}
            </p>
            <Actions>
              <GhostButton onClick={startSharing} disabled={busy || !configured}>
                <Share2 size={12} />
                {t("api.collab.share")}
              </GhostButton>
            </Actions>
          </>
        ) : (
          <>
            <div className="mb-1.5">
              <Status tone="success">{t("api.collab.sharingActive")}</Status>
            </div>
            <Note tone="warning">{t("api.collab.tokenIsACredential")}</Note>
            <Actions>
              <GhostButton onClick={copyInvite} disabled={busy}>
                <ClipboardCopy size={12} />
                {t("api.collab.copyInvite")}
              </GhostButton>
              <GhostButton onClick={sync} disabled={busy}>
                <RefreshCw size={12} />
                {t("api.collab.syncNow")}
              </GhostButton>
              <GhostButton onClick={rotate} disabled={busy}>
                {t("api.collab.rotate")}
              </GhostButton>
              <GhostButton onClick={leave} disabled={busy}>
                {t("api.collab.leave")}
              </GhostButton>
            </Actions>
            <Row label={t("api.collab.auto")} hint={t("api.collab.autoHint")}>
              <Checkbox
                checked={settings.syncAuto}
                onChange={(syncAuto) => void updateSettings({ syncAuto })}
              />
            </Row>
            {/* The two things a teammate needs to know before trusting this: what never leaves
                the machine, and what happens when two people edit the same request. */}
            <Note>{t("api.collab.secretsNote")}</Note>
            <Note>{t("api.collab.conflictNote")}</Note>
          </>
        )}
      </Group>

      <Group title={t("api.collab.joinTitle")}>
        <div className="flex items-center gap-1.5">
          <Field
            mono
            value={joinCode}
            placeholder={t("api.collab.joinPlaceholder")}
            onChange={setJoinCode}
          />
          <GhostButton onClick={join} disabled={busy || joinCode.trim() === ""}>
            {t("api.collab.join")}
          </GhostButton>
        </div>
        <p className="mt-1.5 text-[11px] leading-snug text-[var(--cf-text-muted)]">
          {t("api.collab.joinHint")}
        </p>
      </Group>
    </Panel>
  );
}

// ---------------------------------------------------------------------------

type TabId = "network" | "proxy" | "certificates" | "general" | "backup" | "collab";

const TABS: { id: TabId; labelKey: TranslationKey; icon: LucideIcon }[] = [
  { id: "network", labelKey: "api.settings.network", icon: Network },
  { id: "proxy", labelKey: "api.settings.proxy", icon: Waypoints },
  { id: "certificates", labelKey: "api.settings.certificates", icon: ShieldCheck },
  { id: "general", labelKey: "settings.general", icon: Settings2 },
  { id: "backup", labelKey: "api.backup.title", icon: DatabaseBackup },
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
  // Reachable from the Settings window before the API view has ever been opened, in which case
  // the store still holds its defaults — and writing one back would overwrite what's on disk.
  useEffect(() => {
    void ensureApiStoreLoaded();
  }, []);

  const [tab, setTab] = useState<TabId>("network");

  return (
    <>
      <div className="mb-3 flex flex-wrap gap-1 border-b border-[var(--cf-border)]">
        {TABS.map(({ id, labelKey, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            // No weight change on select: bolding re-measures the label and shoves every tab to
            // its right along by a few pixels.
            className={`relative -mb-px flex items-center gap-1.5 px-2.5 py-1.5 text-[12.5px] ${
              tab === id
                ? "text-[var(--cf-accent)]"
                : "text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
            }`}
          >
            {tab === id && <ActiveUnderline layoutId="cf-api-settings-tab-underline" />}
            <Icon size={13} />
            {t(labelKey)}
          </button>
        ))}
      </div>

      {tab === "network" && <NetworkPanel />}
      {tab === "proxy" && <ProxyPanel />}
      {tab === "certificates" && <CertificatesPanel />}
      {tab === "general" && <GeneralPanel />}
      {tab === "backup" && <BackupPanel />}
      {tab === "collab" && <CollaborationPanel />}
    </>
  );
}
