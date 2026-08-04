import { useCallback, useEffect, useRef, useState } from "react";
import {
  Cloud,
  DatabaseBackup,
  Download,
  FolderOpen,
  KeyRound,
  RefreshCw,
  Upload,
} from "lucide-react";
import { motion } from "framer-motion";
import { ApiModal, Field, GhostButton, Row } from "../api/ApiModal";
import { Actions, Group, HelpLink, Note, Panel, Status } from "../api/settingsChrome";
import { Checkbox } from "../common/Checkbox";
import { Select } from "../common/Select";
import { DriveGuide, ICloudGuide, OneDriveGuide, SyncedFolderGuide } from "./backupGuides";
import { confirmAction } from "../../state/confirmStore";
import { pushErrorToast, useToastStore } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import {
  backupClearPassphrase,
  backupExportToFile,
  backupInspectConfigured,
  backupInspectDrive,
  backupInspectOneDrive,
  backupPassphraseMatches,
  backupPickAndInspect,
  backupPickFolder,
  backupRestoreDrive,
  backupRestoreFile,
  backupRestoreOneDrive,
  backupRevealFolder,
  backupRunNow,
  backupSaveDrive,
  backupSaveOneDrive,
  backupSaveSettings,
  backupSetPassphrase,
  backupState,
  formatBytes,
  onedriveConnect,
  onedriveDisconnect,
  onedriveStatus,
  passphraseStrength,
  writesToFolder,
  type BackupInfo,
  type BackupSettings as Settings,
  type BackupState,
  type BackupTarget,
  type RestoreReport,
  type SyncFolder,
} from "../../lib/tauri/backupCommands";
import {
  gdriveConnect,
  gdriveDisconnect,
  gdriveSetClientSecret,
  gdriveStatus,
  type DriveStatus,
} from "../../lib/tauri/apiCommands";
import { relaunch } from "@tauri-apps/plugin-process";
import type { TranslationKey } from "../../lib/i18n/translations";

/**
 * The whole-install backup, as one section of the app's own settings rather than a sub-tab of the
 * API client's.
 *
 * That move is the point of the feature: what used to travel was one workspace's collections; what
 * travels now is the install — every workspace, project, collection, database connection, prompt,
 * agent and setting, plus every credential in the OS store. Restore it on another
 * computer and that computer *is* this one, minus the history (see `backup/snapshot.rs` for the
 * table-by-table reasoning behind that line).
 *
 * Two things about the shape of this panel are deliberate:
 *
 * - **The password comes first, and nothing else works without it.** The file is encrypted whole,
 *   always — there is no "unencrypted backup" option, because a plaintext file holding every token
 *   the user owns is not a backup, it is a leak with a filename. So the password is the first group
 *   and everything below it is disabled until one is set.
 * - **The cloud guides are here, not in documentation.** Both destinations are bring-your-own, and
 *   neither is discoverable from the field that needs it.
 */

const MIN_PASSPHRASE = 8;

/** How often the scheduler considers writing. Offered as choices because a free number field here
 * invites a "1" that turns a background task into a foreground one. */
const INTERVALS: { value: string; labelKey: TranslationKey }[] = [
  { value: "15", labelKey: "backup.every15" },
  { value: "30", labelKey: "backup.every30" },
  { value: "60", labelKey: "backup.every60" },
  { value: "180", labelKey: "backup.every180" },
  { value: "360", labelKey: "backup.every360" },
  { value: "720", labelKey: "backup.every720" },
  { value: "1440", labelKey: "backup.every1440" },
];

const SYNC_LABELS: Record<SyncFolder["kind"], string> = {
  icloud: "iCloud Drive",
  onedrive: "OneDrive",
  dropbox: "Dropbox",
  "gdrive-desktop": "Google Drive",
};

/** A value the user reads rather than edits, and can click to open where it points. */
function PathReadout({ value, onReveal }: { value: string; onReveal?: () => void }) {
  const shared =
    "mb-1.5 block w-full truncate rounded border border-[var(--cf-border)] bg-black/[0.02] px-1.5 py-1 text-left font-mono text-[11px] text-[var(--cf-text-muted)] dark:bg-white/[0.03]";
  if (!onReveal) return <p className={shared} title={value}>{value}</p>;
  return (
    <button type="button" onClick={onReveal} title={value} className={`${shared} hover:text-[var(--cf-text)]`}>
      {value}
    </button>
  );
}

/**
 * Four segments, filled by [`passphraseStrength`]. Length-dominated on purpose — for a passphrase
 * fed to Argon2id it is worth far more than punctuation, and a meter that says otherwise teaches
 * the wrong habit.
 */
function StrengthMeter({ value }: { value: string }) {
  const t = useT();
  if (value === "") return null;
  const score = passphraseStrength(value);
  const labels: TranslationKey[] = [
    "backup.strengthTooShort",
    "backup.strengthWeak",
    "backup.strengthFair",
    "backup.strengthStrong",
  ];
  const colors = ["var(--cf-danger)", "var(--cf-warning)", "var(--cf-warning)", "var(--cf-success)"];
  return (
    <div className="mb-1.5 flex items-center gap-2">
      <div className="flex flex-1 gap-1">
        {[0, 1, 2, 3].map((segment) => (
          <motion.span
            key={segment}
            layout
            className="h-1 flex-1 rounded-full"
            style={{
              background: segment <= score && score > 0 ? colors[score] : "var(--cf-border)",
            }}
          />
        ))}
      </div>
      <span className="shrink-0 text-[10px]" style={{ color: colors[score] }}>
        {t(labels[score])}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Password
// ---------------------------------------------------------------------------

/**
 * Setting and changing the one password the backup depends on.
 *
 * Changing it asks for the current one first. Not ceremony: the scheduled backup writes with
 * whatever is stored, so a typo here would silently start sealing every future file with a password
 * the user doesn't know, and they would only find out on the day they needed to restore.
 */
function PassphraseGroup({ has, onChanged }: { has: boolean; onChanged: () => void }) {
  const t = useT();
  const pushToast = useToastStore((s) => s.pushToast);
  const [editing, setEditing] = useState(!has);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => setEditing(!has), [has]);

  const reset = () => {
    setCurrent("");
    setNext("");
    setConfirm("");
  };

  const tooShort = next.length > 0 && next.length < MIN_PASSPHRASE;
  const mismatch = confirm.length > 0 && confirm !== next;
  const canSave = next.length >= MIN_PASSPHRASE && confirm === next && (!has || current.length > 0);

  const save = async () => {
    setBusy(true);
    try {
      if (has && !(await backupPassphraseMatches(current))) {
        pushErrorToast(t("backup.currentWrong"));
        return;
      }
      await backupSetPassphrase(next);
      reset();
      setEditing(false);
      onChanged();
      pushToast(t("backup.passwordSaved"), "success");
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!(await confirmAction(t("backup.removePasswordConfirm")))) return;
    await backupClearPassphrase().catch((e: unknown) => pushErrorToast(String(e)));
    reset();
    onChanged();
  };

  if (has && !editing) {
    return (
      <Group title={t("backup.groupPassword")}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Status tone="success">{t("backup.passwordSet")}</Status>
          <Actions>
            <GhostButton onClick={() => setEditing(true)}>
              <KeyRound size={12} />
              {t("backup.changePassword")}
            </GhostButton>
            <GhostButton onClick={() => void remove()}>{t("backup.removePassword")}</GhostButton>
          </Actions>
        </div>
      </Group>
    );
  }

  return (
    <Group title={t("backup.groupPassword")}>
      <Note tone="warning">{t("backup.passwordWarning")}</Note>
      {has && (
        <Row label={t("backup.currentPassword")} wide>
          <Field type="password" value={current} onChange={setCurrent} />
        </Row>
      )}
      <Row label={t("backup.newPassword")} hint={t("backup.newPasswordHint")} wide>
        <Field
          type="password"
          value={next}
          placeholder={t("backup.passwordPlaceholder")}
          onChange={setNext}
        />
      </Row>
      <StrengthMeter value={next} />
      <Row label={t("backup.confirmPassword")} wide>
        <Field type="password" value={confirm} onChange={setConfirm} />
      </Row>
      {tooShort && <Note tone="warning">{t("backup.passwordTooShort", { n: String(MIN_PASSPHRASE) })}</Note>}
      {mismatch && <Note tone="warning">{t("backup.passwordMismatch")}</Note>}
      <Actions>
        <GhostButton onClick={() => void save()} disabled={!canSave || busy}>
          {t("common.save")}
        </GhostButton>
        {has && (
          <GhostButton
            onClick={() => {
              reset();
              setEditing(false);
            }}
          >
            {t("common.cancel")}
          </GhostButton>
        )}
      </Actions>
    </Group>
  );
}

// ---------------------------------------------------------------------------
// Google Drive
// ---------------------------------------------------------------------------

/**
 * The user's own Google OAuth client, and the consent flow that turns it into a connection.
 *
 * Moved here wholesale from the API client's settings, because the thing being uploaded is no
 * longer one workspace's requests. The credentials are still the user's own, from a Google Cloud
 * project they create: the backup reaches their Drive through their registration, with nothing of
 * ours in the path.
 */
function DriveConnection({
  clientId,
  account,
  onSave,
}: {
  clientId: string;
  account: string;
  onSave: (patch: { clientId?: string; account?: string }) => void;
}) {
  const t = useT();
  const [status, setStatus] = useState<DriveStatus>({ has_secret: false, connected: false });
  const [secret, setSecret] = useState("");
  const [connecting, setConnecting] = useState(false);

  const refresh = useCallback(() => {
    void gdriveStatus().then(setStatus).catch(() => {});
  }, []);
  useEffect(refresh, [refresh]);

  const saveSecret = async (value: string) => {
    setSecret(value);
    await gdriveSetClientSecret(value).catch((e: unknown) => pushErrorToast(String(e)));
    refresh();
  };

  const connect = async () => {
    setConnecting(true);
    try {
      const connected = await gdriveConnect(clientId);
      onSave({ account: connected.email });
      refresh();
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setConnecting(false);
    }
  };

  const disconnect = async () => {
    if (!(await confirmAction(t("backup.driveDisconnectConfirm")))) return;
    await gdriveDisconnect().catch((e: unknown) => pushErrorToast(String(e)));
    onSave({ account: "" });
    refresh();
  };

  return (
    <div className="mb-1">
      <Row label={t("backup.driveClientId")} wide>
        <Field
          mono
          value={clientId}
          placeholder="…apps.googleusercontent.com"
          onChange={(value) => onSave({ clientId: value })}
        />
      </Row>
      <Row label={t("backup.driveClientSecret")} wide>
        <Field
          type="password"
          value={secret}
          placeholder={status.has_secret ? t("backup.driveSecretStored") : ""}
          onChange={(value) => void saveSecret(value)}
        />
      </Row>
      <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
        {status.connected ? (
          <>
            <Status tone="success">
              {account === "" ? t("backup.driveConnected") : t("backup.driveConnectedAs", { email: account })}
            </Status>
            <GhostButton onClick={() => void disconnect()}>{t("backup.driveDisconnect")}</GhostButton>
          </>
        ) : (
          <>
            <Status tone="muted">{t("backup.driveNotConnected")}</Status>
            <GhostButton
              onClick={() => void connect()}
              disabled={connecting || clientId.trim() === "" || !status.has_secret}
            >
              <Cloud size={12} />
              {connecting ? t("backup.driveWaiting") : t("backup.driveConnect")}
            </GhostButton>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// OneDrive
// ---------------------------------------------------------------------------

/**
 * The user's own Entra ID app registration, and the consent flow that turns it into a connection.
 *
 * Deliberately one field where Drive needs two: registered as a public client, the whole of the
 * setup is the application id, and PKCE does the job the client secret was doing next door. So
 * there is nothing here to store in the credential store until the browser comes back.
 *
 * This is also the destination iCloud was asked to be and can't: Apple publishes no service API for
 * iCloud Drive, so that one stays a folder its sync daemon watches. This one signs in, and works on
 * Windows and macOS whether or not the OneDrive desktop client is installed at all.
 */
function OneDriveConnection({
  clientId,
  account,
  onSave,
}: {
  clientId: string;
  account: string;
  onSave: (patch: { clientId?: string; account?: string }) => void;
}) {
  const t = useT();
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);

  const refresh = useCallback(() => {
    void onedriveStatus().then(setConnected).catch(() => {});
  }, []);
  useEffect(refresh, [refresh]);

  const connect = async () => {
    setConnecting(true);
    try {
      const linked = await onedriveConnect(clientId);
      onSave({ account: linked.email });
      refresh();
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setConnecting(false);
    }
  };

  const disconnect = async () => {
    if (!(await confirmAction(t("backup.onedriveDisconnectConfirm")))) return;
    await onedriveDisconnect().catch((e: unknown) => pushErrorToast(String(e)));
    onSave({ account: "" });
    refresh();
  };

  return (
    <div className="mb-1">
      <Row label={t("backup.onedriveClientId")} hint={t("backup.onedriveClientIdHint")} wide>
        <Field
          mono
          value={clientId}
          placeholder="00000000-0000-0000-0000-000000000000"
          onChange={(value) => onSave({ clientId: value })}
        />
      </Row>
      <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
        {connected ? (
          <>
            <Status tone="success">
              {account === ""
                ? t("backup.onedriveConnected")
                : t("backup.onedriveConnectedAs", { email: account })}
            </Status>
            <GhostButton onClick={() => void disconnect()}>
              {t("backup.onedriveDisconnect")}
            </GhostButton>
          </>
        ) : (
          <>
            <Status tone="muted">{t("backup.onedriveNotConnected")}</Status>
            <GhostButton onClick={() => void connect()} disabled={connecting || clientId.trim() === ""}>
              <Cloud size={12} />
              {connecting ? t("backup.driveWaiting") : t("backup.onedriveConnect")}
            </GhostButton>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

/** Where the file being restored came from — which is also what decides how it is fetched. */
type RestoreSource = { kind: "file" | "drive" | "onedrive"; info: BackupInfo };

/**
 * The one destructive action in this panel, so it happens behind a dialog that says what is about
 * to happen to *this* machine — and shows what the file is before asking for the password, so the
 * prompt is about a file the user has already recognised.
 */
function RestoreModal({
  source,
  onClose,
  onDone,
}: {
  source: RestoreSource;
  onClose: () => void;
  onDone: (report: RestoreReport) => void;
}) {
  const t = useT();
  const [passphrase, setPassphrase] = useState("");
  const [replace, setReplace] = useState(true);
  const [busy, setBusy] = useState(false);

  const created = source.info.createdAt === "" ? "" : new Date(source.info.createdAt).toLocaleString();

  const run = async () => {
    if (!(await confirmAction(replace ? t("backup.replaceConfirm") : t("backup.mergeConfirm")))) return;
    setBusy(true);
    try {
      const report =
        source.kind === "drive"
          ? await backupRestoreDrive(passphrase, replace)
          : source.kind === "onedrive"
            ? await backupRestoreOneDrive(passphrase, replace)
            : await backupRestoreFile(source.info.path, passphrase, replace);
      onDone(report);
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ApiModal
      icon={Download}
      title={t("backup.restoreTitle")}
      subtitle={source.info.path}
      busy={busy}
      dismissOnBackdrop={false}
      onClose={onClose}
      footer={
        <div className="flex items-center justify-end gap-1.5">
          <GhostButton onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </GhostButton>
          <GhostButton onClick={() => void run()} disabled={busy || passphrase === ""}>
            <Download size={12} />
            {busy ? t("backup.restoring") : t("backup.restoreAction")}
          </GhostButton>
        </div>
      }
    >
      <div className="px-1 py-1">
        <div className="mb-3 rounded-md border border-[var(--cf-border)] px-2.5 py-2 text-[11px] text-[var(--cf-text-muted)]">
          <p>{t("backup.fileCreated", { at: created })}</p>
          <p>{t("backup.fileFrom", { os: source.info.os, version: source.info.appVersion })}</p>
          <p>{t("backup.fileSize", { size: formatBytes(source.info.bytes) })}</p>
        </div>

        <Row label={t("backup.password")} wide>
          <Field
            type="password"
            value={passphrase}
            placeholder={t("backup.passwordForFile")}
            onChange={setPassphrase}
          />
        </Row>

        <div className="mt-2 border-t border-[var(--cf-border)] pt-2">
          <label className="mb-1 flex items-center gap-2 text-[12px]">
            <Checkbox checked={replace} onChange={setReplace} />
            {t("backup.replace")}
          </label>
          <Note tone={replace ? "warning" : "muted"}>
            {replace ? t("backup.replaceHint") : t("backup.mergeHint")}
          </Note>
        </div>
      </div>
    </ApiModal>
  );
}

/**
 * What the restore actually did, and the one thing it can't do for you.
 *
 * The restart is not cosmetic: the import writes straight into SQLite under a running app whose
 * stores were loaded from the previous contents, so every open view is now showing a database that
 * no longer exists. Reloading each store in place would be a long list of calls with one of them
 * always missing; restarting is the version that can't be subtly wrong.
 */
function RestoreDoneModal({ report, onClose }: { report: RestoreReport; onClose: () => void }) {
  const t = useT();
  return (
    <ApiModal
      icon={DatabaseBackup}
      title={t("backup.restoredTitle")}
      dismissOnBackdrop={false}
      onClose={onClose}
      footer={
        <div className="flex items-center justify-end gap-1.5">
          <GhostButton onClick={onClose}>{t("backup.later")}</GhostButton>
          <GhostButton onClick={() => void relaunch()}>
            <RefreshCw size={12} />
            {t("backup.restartNow")}
          </GhostButton>
        </div>
      }
    >
      <div className="px-1 py-1 text-[12px]">
        <p className="mb-2">
          {t("backup.restoredCounts", {
            rows: String(report.rows),
            secrets: String(report.secrets),
          })}
        </p>
        <Note>{t("backup.restartHint")}</Note>

        {report.missingProjectPaths.length > 0 && (
          <div className="mt-2">
            <Note tone="warning">
              {t("backup.missingPaths", { n: String(report.missingProjectPaths.length) })}
            </Note>
            <ul className="max-h-28 overflow-y-auto">
              {report.missingProjectPaths.map((path) => (
                <li key={path} className="truncate font-mono text-[11px] text-[var(--cf-text-muted)]">
                  {path}
                </li>
              ))}
            </ul>
          </div>
        )}

        {report.failedSecrets.length > 0 && (
          <Note tone="warning">
            {t("backup.failedSecrets", { n: String(report.failedSecrets.length) })}
          </Note>
        )}
      </div>
    </ApiModal>
  );
}

// ---------------------------------------------------------------------------
// The section
// ---------------------------------------------------------------------------

export function BackupSettings() {
  const t = useT();
  const pushToast = useToastStore((s) => s.pushToast);

  const [state, setState] = useState<BackupState | null>(null);
  const [busy, setBusy] = useState(false);
  const [exportPassphrase, setExportPassphrase] = useState("");
  const [restoring, setRestoring] = useState<RestoreSource | null>(null);
  const [restored, setRestored] = useState<RestoreReport | null>(null);

  const load = useCallback(() => {
    void backupState()
      .then(setState)
      .catch((e: unknown) => pushErrorToast(String(e)));
  }, []);
  useEffect(load, [load]);

  // Settings are written on every toggle, and the panel has several. Debounced so dragging the
  // "keep copies" field doesn't mean one SQLite write per keystroke, and flushed on unmount so a
  // change made a moment before closing Settings isn't the one that gets lost.
  const pending = useRef<Settings | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const next = pending.current;
    pending.current = null;
    if (next) void backupSaveSettings(next).catch((e: unknown) => pushErrorToast(String(e)));
  }, []);
  useEffect(() => flush, [flush]);

  const patch = (changes: Partial<Settings>) => {
    setState((previous) => {
      if (!previous) return previous;
      const settings = { ...previous.settings, ...changes };
      pending.current = settings;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(flush, 400);
      return {
        ...previous,
        settings,
        destinationReady: destinationReady({ ...previous, settings }),
      };
    });
  };

  const patchDrive = (changes: { clientId?: string; account?: string }) => {
    setState((previous) => {
      if (!previous) return previous;
      const drive = { ...previous.drive, ...changes };
      void backupSaveDrive(drive).catch((e: unknown) => pushErrorToast(String(e)));
      return { ...previous, drive, destinationReady: destinationReady({ ...previous, drive }) };
    });
  };

  const patchOneDrive = (changes: { clientId?: string; account?: string }) => {
    setState((previous) => {
      if (!previous) return previous;
      const onedrive = { ...previous.onedrive, ...changes };
      void backupSaveOneDrive(onedrive).catch((e: unknown) => pushErrorToast(String(e)));
      return {
        ...previous,
        onedrive,
        destinationReady: destinationReady({ ...previous, onedrive }),
      };
    });
  };

  // One round trip, and it reads the credential store — which on macOS can be a prompt. The
  // subtitle stands in for the body meanwhile rather than a spinner, because the section's own
  // heading is the honest thing to show while its contents are on the way.
  if (!state) {
    return (
      <section>
        <h3 className="mb-1 text-sm font-semibold">{t("backup.title")}</h3>
        <p className="text-[13px] text-[var(--cf-text-muted)]">{t("backup.subtitle")}</p>
      </section>
    );
  }

  const { settings, drive, onedrive } = state;
  const ready = state.destinationReady && state.hasPassphrase;
  const usesFolder = writesToFolder(settings.target);

  const exportNow = async () => {
    setBusy(true);
    try {
      const result = await backupExportToFile(exportPassphrase);
      if (!result) return;
      setExportPassphrase("");
      pushToast(
        t("backup.exported", {
          path: result.path,
          size: formatBytes(result.contents.bytes),
        }),
        "success",
      );
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setBusy(false);
    }
  };

  const runNow = async () => {
    setBusy(true);
    try {
      const outcome = await backupRunNow();
      load();
      if (outcome.wrote) {
        pushToast(
          t("backup.done", { path: outcome.path, size: formatBytes(outcome.contents.bytes) }),
          "success",
        );
      } else {
        pushErrorToast(t(skipMessage(outcome.skipped)));
      }
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setBusy(false);
    }
  };

  const openFromFile = async () => {
    setBusy(true);
    try {
      const info = await backupPickAndInspect();
      if (info) setRestoring({ kind: "file", info });
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setBusy(false);
    }
  };

  const openFromDestination = async () => {
    setBusy(true);
    try {
      const kind = usesFolder ? "file" : settings.target === "onedrive" ? "onedrive" : "drive";
      const info =
        kind === "file"
          ? await backupInspectConfigured()
          : kind === "onedrive"
            ? await backupInspectOneDrive()
            : await backupInspectDrive();
      if (!info) {
        pushErrorToast(t("backup.noBackupThere"));
        return;
      }
      setRestoring({ kind, info });
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setBusy(false);
    }
  };

  const browse = async () => {
    const folder = await backupPickFolder().catch((e: unknown) => {
      pushErrorToast(String(e));
      return null;
    });
    if (folder) patch({ folder });
  };

  const lastBackup =
    settings.lastBackupAt === ""
      ? t("backup.never")
      : new Date(settings.lastBackupAt).toLocaleString();

  return (
    <section>
      <h3 className="mb-1 text-sm font-semibold">{t("backup.title")}</h3>
      <p className="mb-3 text-[13px] text-[var(--cf-text-muted)]">{t("backup.subtitle")}</p>

      <Panel>
        <Note>{t("backup.about")}</Note>
        <Note>{t("backup.aboutExcluded")}</Note>

        <PassphraseGroup has={state.hasPassphrase} onChanged={load} />

        <Group title={t("backup.groupManual")}>
          {!state.hasPassphrase ? (
            <Note tone="warning">{t("backup.needPasswordFirst")}</Note>
          ) : (
            <>
              <Row label={t("backup.exportPassword")} hint={t("backup.exportPasswordHint")} wide>
                <Field
                  type="password"
                  value={exportPassphrase}
                  placeholder={t("backup.passwordPlaceholder")}
                  onChange={setExportPassphrase}
                />
              </Row>
              <Actions>
                <GhostButton
                  onClick={() => void exportNow()}
                  disabled={busy || exportPassphrase.length < MIN_PASSPHRASE}
                >
                  <Upload size={12} />
                  {t("backup.exportNow")}
                </GhostButton>
                <GhostButton onClick={() => void openFromFile()} disabled={busy}>
                  <Download size={12} />
                  {t("backup.importFromFile")}
                </GhostButton>
              </Actions>
              <p className="mt-1.5 text-[11px] leading-snug text-[var(--cf-text-muted)]">
                {t("backup.manualHint")}
              </p>
            </>
          )}
        </Group>

        <Group title={t("backup.groupAutomatic")}>
          <Row label={t("backup.target")} hint={t("backup.targetHint")} wide>
            <Select
              size="sm"
              value={settings.target}
              onChange={(value) => patch({ target: value as BackupTarget })}
              options={[
                { value: "folder", label: t("backup.targetFolder") },
                { value: "icloud", label: t("backup.targetICloud") },
                { value: "gdrive", label: t("backup.targetDrive") },
                { value: "onedrive", label: t("backup.targetOneDrive") },
              ]}
              ariaLabel={t("backup.target")}
            />
          </Row>

          {usesFolder ? (
            <>
              <Row label={t("backup.folder")} hint={t("backup.folderHint")} wide>
                <GhostButton onClick={() => void browse()}>
                  <FolderOpen size={12} />
                  {t("backup.browse")}
                </GhostButton>
              </Row>
              {settings.folder !== "" && (
                <PathReadout
                  value={settings.folder}
                  onReveal={() =>
                    void backupRevealFolder(settings.folder).catch((e: unknown) =>
                      pushErrorToast(String(e)),
                    )
                  }
                />
              )}
              {/* Detected sync clients as one-click destinations. For Dropbox and the rest this is
                  the whole "integration", and it is enough: they are folders. OneDrive appears
                  here too — pointing at its synced folder is still the zero-setup route, and the
                  destination above is for reaching the account without the desktop client. */}
              {state.syncFolders.length > 0 && (
                <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
                  <span className="text-[11px] text-[var(--cf-text-muted)]">
                    {t("backup.quickPicks")}
                  </span>
                  {state.syncFolders.map((found) => (
                    <button
                      key={found.path}
                      type="button"
                      onClick={() => patch({ folder: `${found.path}/CodeFlow` })}
                      title={found.path}
                      className="rounded border border-[var(--cf-border)] px-1.5 py-[2px] text-[11px] text-[var(--cf-text-muted)] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]"
                    >
                      {SYNC_LABELS[found.kind]}
                    </button>
                  ))}
                </div>
              )}
              {settings.target === "icloud" && state.icloudFolder === "" && (
                <Note tone="warning">{t("backup.icloudMissing")}</Note>
              )}
            </>
          ) : settings.target === "onedrive" ? (
            <OneDriveConnection
              clientId={onedrive.clientId}
              account={onedrive.account}
              onSave={patchOneDrive}
            />
          ) : (
            <DriveConnection clientId={drive.clientId} account={drive.account} onSave={patchDrive} />
          )}

          <Row label={t("backup.interval")} hint={t("backup.intervalHint")} wide>
            <Select
              size="sm"
              value={String(settings.intervalMinutes)}
              onChange={(value) => patch({ intervalMinutes: Number(value) })}
              options={INTERVALS.map(({ value, labelKey }) => ({ value, label: t(labelKey) }))}
              ariaLabel={t("backup.interval")}
            />
          </Row>
          <Row label={t("backup.onExit")} hint={t("backup.onExitHint")}>
            <Checkbox checked={settings.onExit} onChange={(onExit) => patch({ onExit })} />
          </Row>
          <Row label={t("backup.keepCopies")} hint={t("backup.keepCopiesHint")}>
            <Field
              type="number"
              value={String(settings.keepCopies)}
              onChange={(value) => {
                const parsed = Number(value);
                patch({
                  keepCopies: Number.isFinite(parsed) ? Math.min(50, Math.max(0, Math.floor(parsed))) : 0,
                });
              }}
            />
          </Row>
          <Row label={t("backup.enabled")} hint={t("backup.enabledHint")}>
            <Checkbox
              checked={settings.enabled}
              disabled={!ready}
              onChange={(enabled) => patch({ enabled })}
            />
          </Row>
          {!ready && <Note tone="warning">{t("backup.notReady")}</Note>}

          <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
            <Status tone={settings.lastError !== "" ? "warning" : settings.lastBackupAt === "" ? "muted" : "success"}>
              {settings.lastError !== ""
                ? t("backup.lastError", { error: settings.lastError })
                : t("backup.lastAt", { at: lastBackup })}
            </Status>
            <Actions>
              <GhostButton onClick={() => void openFromDestination()} disabled={busy || !state.destinationReady}>
                <Download size={12} />
                {t("backup.restoreFromDestination")}
              </GhostButton>
              <GhostButton onClick={() => void runNow()} disabled={busy || !ready}>
                <RefreshCw size={12} />
                {t("backup.runNow")}
              </GhostButton>
            </Actions>
          </div>
          {settings.lastBackupPath !== "" && <PathReadout value={settings.lastBackupPath} />}
        </Group>

        <Group title={t("backup.groupGuides")}>
          <Note>{t("backup.guidesAbout")}</Note>
          <div className="flex flex-col gap-2">
            <SyncedFolderGuide />
            <ICloudGuide platform={state.platform} folder={state.icloudFolder} />
            <OneDriveGuide />
            <DriveGuide />
          </div>
          <div className="mt-2">
            <HelpLink url="https://www.google.com/drive/download/">
              {t("backup.guide.driveDesktopLink")}
            </HelpLink>
          </div>
        </Group>
      </Panel>

      {restoring && (
        <RestoreModal
          source={restoring}
          onClose={() => setRestoring(null)}
          onDone={(report) => {
            setRestoring(null);
            setRestored(report);
            load();
          }}
        />
      )}
      {restored && <RestoreDoneModal report={restored} onClose={() => setRestored(null)} />}
    </section>
  );
}

/**
 * Whether the chosen destination has the one piece it actually needs.
 *
 * Each target is asked only about its own: a folder for the two that write to one, a client id for
 * the two that sign in. Mirrors `destination_ready` in `backup/auto.rs` — the backend is what
 * decides, and this is only so the switch greys out before a run has to prove it.
 */
function destinationReady({ settings, drive, onedrive }: BackupState): boolean {
  if (settings.target === "gdrive") return drive.clientId.trim() !== "";
  if (settings.target === "onedrive") return onedrive.clientId.trim() !== "";
  return settings.folder.trim() !== "";
}

/** Why a run wrote nothing, as something the user can act on. */
function skipMessage(reason: string): TranslationKey {
  switch (reason) {
    case "unchanged":
      return "backup.skipUnchanged";
    case "no-destination":
      return "backup.skipNoDestination";
    case "no-password":
      return "backup.skipNoPassword";
    default:
      return "backup.skipDisabled";
  }
}
