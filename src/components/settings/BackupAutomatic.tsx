import { useCallback, useEffect, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Cloud,
  CloudUpload,
  FolderOpen,
  FolderSync,
  HardDrive,
  Pencil,
  RefreshCw,
  RotateCcw,
  type LucideIcon,
} from "lucide-react";
import { Field, GhostButton, PrimaryButton, Row } from "../api/ApiModal";
import { Actions, Note, Status, type Tone } from "../api/settingsChrome";
import { Checkbox } from "../common/Checkbox";
import { Select } from "../common/Select";
import { confirmAction } from "../../state/confirmStore";
import { pushErrorToast } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import {
  backupPickFolder,
  backupRevealFolder,
  destinationReady,
  onedriveConnect,
  onedriveDisconnect,
  onedriveStatus,
  writesToFolder,
  type BackupSettings as Settings,
  type BackupState,
  type BackupTarget,
  type SyncFolder,
} from "../../lib/tauri/backupCommands";
import {
  gdriveConnect,
  gdriveDisconnect,
  gdriveSetClientSecret,
  gdriveStatus,
  type DriveStatus,
} from "../../lib/tauri/apiCommands";
import type { TranslationKey } from "../../lib/i18n/translations";

/**
 * The scheduled backup, as a setup you are walked through once and a summary you read afterwards.
 *
 * It used to be one long form: a destination select, a folder picker, an interval, two checkboxes
 * and a switch, all live and all writing on every keystroke. That shape asks everything at once and
 * answers nothing — the switch that turns the whole thing on sat at the bottom, greyed out, and
 * nothing on screen said which of the fields above it was the reason.
 *
 * So it is three questions in order, and then it gets out of the way:
 *
 * - **Where** — the four destinations as cards, because this is a choice between four *kinds* of
 *   place and a dropdown makes it look like a preference.
 * - **The destination itself** — a folder to pick, or an account to sign in to. Which one you get
 *   is decided by the previous answer, which is why it is a step rather than a section that
 *   changes shape under you.
 * - **How often**, plus whether to write one on the way out.
 *
 * There is no "do you want this automatic" question anywhere in it. This is the automatic backup;
 * finishing the setup is the answer, and asking again at the end was a switch whose only job was to
 * undo the four screens you had just filled in.
 *
 * Afterwards the pane is a summary: what it will do, when it last did it, and four things you can
 * press. The wizard comes back on Edit, and comes back for good on Reset.
 */

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

/** The four kinds of place a backup can live, as the cards the first step is made of. */
const TARGETS: {
  id: BackupTarget;
  labelKey: TranslationKey;
  hintKey: TranslationKey;
  icon: LucideIcon;
}[] = [
  { id: "folder", labelKey: "backup.targetFolder", hintKey: "backup.targetFolderHint", icon: FolderOpen },
  { id: "icloud", labelKey: "backup.targetICloud", hintKey: "backup.targetICloudHint", icon: Cloud },
  { id: "gdrive", labelKey: "backup.targetDrive", hintKey: "backup.targetDriveHint", icon: HardDrive },
  {
    id: "onedrive",
    labelKey: "backup.targetOneDrive",
    hintKey: "backup.targetOneDriveHint",
    icon: CloudUpload,
  },
];

type Step = "where" | "destination" | "schedule";

/**
 * `hintKey` is optional, and the destination step goes without one. The other two are asked in the
 * abstract — a row of cards, a set of intervals — and a line saying what the question is for earns
 * its space. This one is a folder picker or a sign-in form, which say what they are by being on
 * screen; the sentence above them was narrating what you could already see.
 */
const STEPS: { id: Step; labelKey: TranslationKey; hintKey?: TranslationKey }[] = [
  { id: "where", labelKey: "backup.stepWhere", hintKey: "backup.stepWhereHint" },
  { id: "destination", labelKey: "backup.stepDestination" },
  { id: "schedule", labelKey: "backup.stepSchedule", hintKey: "backup.stepScheduleHint" },
];

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

// ---------------------------------------------------------------------------
// Google Drive
// ---------------------------------------------------------------------------

/**
 * The user's own Google OAuth client, and the consent flow that turns it into a connection.
 *
 * The credentials are the user's own, from a Google Cloud project they create: the backup reaches
 * their Drive through their registration, with nothing of ours in the path.
 *
 * Unlike the rest of this step it saves as you type rather than on Save — the client id and secret
 * are a connection, not a destination, and the consent flow in the middle of them needs them
 * stored before it can be started.
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
      {/* No hint, like Drive's two fields next door. What you paste in here is named by the label
          and shaped by the placeholder, and the guides tab is where the app explains where an
          application id comes from. */}
      <Row label={t("backup.onedriveClientId")} wide>
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
// The summary
// ---------------------------------------------------------------------------

/** One answer to "where", in the first step's grid. */
function TargetCard({
  icon: Icon,
  label,
  hint,
  selected,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  hint: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={`relative flex items-start gap-2 rounded-lg border p-3 text-left transition-colors ${
        selected
          ? "border-[var(--cf-accent)] bg-[var(--cf-accent-soft)]"
          : "border-[var(--cf-border)] hover:border-[color-mix(in_oklab,var(--cf-accent)_50%,transparent)]"
      }`}
    >
      <Icon
        size={15}
        className={`mt-[1px] shrink-0 ${selected ? "text-[var(--cf-accent)]" : "text-[var(--cf-text-muted)]"}`}
      />
      <span className="min-w-0 pr-4">
        <span className="block text-[12.5px] text-[var(--cf-text)]">{label}</span>
        <span className="mt-0.5 block text-[11px] leading-snug text-[var(--cf-text-muted)]">{hint}</span>
      </span>
      {selected && <Check size={13} className="absolute right-2 top-2.5 text-[var(--cf-accent)]" />}
    </button>
  );
}

/** One fact from the finished setup: a label and the answer, on one line. */
function SummaryRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline gap-3 py-[3px]">
      <span className="shrink-0 text-[11px] text-[var(--cf-text-muted)]">{label}</span>
      <span
        className={`min-w-0 flex-1 truncate text-right text-[12px] text-[var(--cf-text)] ${
          mono ? "font-mono text-[11px]" : ""
        }`}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The pane
// ---------------------------------------------------------------------------

export function BackupAutomatic({
  state,
  busy,
  onPatch,
  onCommit,
  onReset,
  onRunNow,
  onPatchDrive,
  onPatchOneDrive,
}: {
  state: BackupState;
  /** True while an export or a run is in flight — the buttons that start one are disabled. */
  busy: boolean;
  /** The panel's debounced write. For the one switch that is edited outside the wizard. */
  onPatch: (changes: Partial<Settings>) => void;
  /** An immediate, awaited write of the whole object. What the wizard commits through, where a
   * debounce would race the redraw that follows it. */
  onCommit: (settings: Settings) => Promise<void>;
  /** Forgets the setup and reloads. Resolves once this pane's `state` is the reset one, so the
   * summary doesn't flash back for a frame before the wizard replaces it. */
  onReset: () => Promise<void>;
  onRunNow: () => Promise<void>;
  onPatchDrive: (patch: { clientId?: string; account?: string }) => void;
  onPatchOneDrive: (patch: { clientId?: string; account?: string }) => void;
}) {
  const t = useT();
  const { settings, drive, onedrive, running } = state;

  /**
   * The settings being edited, or `null` when the stored ones are what is on screen.
   *
   * Nothing is written until Save. Every other pane in this section writes as you type, and that is
   * right for a checkbox — but here the answers are load-bearing for each other, and a half-filled
   * wizard that had already switched the destination would be a scheduled backup pointed at
   * somewhere the user never finished choosing.
   */
  const [draft, setDraft] = useState<Settings | null>(null);
  const [step, setStep] = useState<Step>("where");
  const [saving, setSaving] = useState(false);
  /**
   * Where the backup was going when Edit was pressed.
   *
   * The folder and the target are in the draft and could be compared against the stored settings
   * directly, but the account cannot: signing in to a different Google or Microsoft account is a
   * connection, and connections save the moment they happen. By the time Save is pressed the old
   * account is already gone from `state`, so the only way to notice the destination moved is to
   * have written down where it was.
   */
  const [opened, setOpened] = useState<{ target: BackupTarget; folder: string; account: string } | null>(
    null,
  );

  // Unfinished setup *is* the wizard: there is nothing to summarise yet. Derived rather than
  // latched into an effect, so a reset — which is a write, not a click in here — puts the wizard
  // back by itself.
  const configured = settings.setupDone;
  const editing = draft !== null || !configured;
  const working = draft ?? settings;

  /**
   * Whether "where" has been answered, rather than merely having a value.
   *
   * `settings.target` is never empty — it is "a folder" from the moment the pane loads — so the
   * first step used to open with a card already ticked, telling a first-time user they had chosen
   * something they had not. `draft` is the answer: it is null until this pass through the wizard
   * edits something, and the only edit reachable from step one is picking a card. Editing a
   * finished setup the stored target *is* a real answer, so `configured` shows it ticked.
   */
  const targetPicked = configured || draft !== null;

  const ready = destinationReady(working, drive.clientId, onedrive.clientId);
  const usesFolder = writesToFolder(working.target);
  const stepIndex = STEPS.findIndex((entry) => entry.id === step);
  const activeStep = STEPS[stepIndex] ?? STEPS[0];

  /**
   * The synced folders found on this machine, as cards in the first step.
   *
   * iCloud is filtered out: it has a card of its own already, and picking it fills in this same
   * path (see [`chooseTarget`]) — two cards ticking the same folder is not a second option. The
   * others are genuinely a second route rather than a duplicate: OneDrive's card signs in to the
   * account, this one writes into the folder its desktop client is already syncing, and either can
   * be the right answer depending on whether that client is installed.
   */
  const detected = state.syncFolders.filter((found) => found.kind !== "icloud");
  /** Inside a `CodeFlow` folder rather than loose at the root of someone's Dropbox. */
  const presetOf = (found: SyncFolder) => `${found.path}/CodeFlow`;
  const activeSync =
    targetPicked && working.target === "folder"
      ? detected.find((found) => working.folder === presetOf(found))
      : undefined;

  const edit = (changes: Partial<Settings>) => setDraft({ ...working, ...changes });

  /**
   * Picking a card in step one, with iCloud's destination filled in on the way past.
   *
   * iCloud writes to a folder like any other — the backend has no Apple API to talk to, so
   * `target: "icloud"` and `target: "folder"` differ only in what this panel says about them. That
   * makes the card a promise the next step wouldn't keep: choosing "iCloud Drive" and landing on an
   * empty folder picker is the option not doing the one thing it names. So the folder iCloud syncs
   * on this machine is filled in here, and step two is left as the place to change it.
   */
  const chooseTarget = (target: BackupTarget) =>
    edit(
      target === "icloud" && state.icloudFolder !== ""
        ? { target, folder: `${state.icloudFolder}/CodeFlow` }
        : { target },
    );

  /** The signed-in account a target writes to, or empty for the two that write to a folder. */
  const accountFor = (target: BackupTarget) =>
    target === "onedrive" ? onedrive.account : target === "gdrive" ? drive.account : "";

  const openWizard = () => {
    setDraft(settings);
    setOpened({
      target: settings.target,
      folder: settings.folder,
      account: accountFor(settings.target),
    });
    setStep("where");
  };

  /**
   * Commits the wizard.
   *
   * The destination question is asked here rather than at the moment it is picked, because up to
   * this point nothing has moved: changing your mind twice inside the wizard should cost nothing,
   * and a warning that fires on a dropdown is one people learn to click past.
   */
  const save = async () => {
    const before = opened ?? {
      target: settings.target,
      folder: settings.folder,
      account: accountFor(settings.target),
    };
    const moved =
      working.target !== before.target ||
      working.folder !== before.folder ||
      accountFor(working.target) !== before.account;
    if (configured && moved) {
      const confirmed = await confirmAction(
        t("backup.moveConfirm"),
        false,
        t("backup.moveConfirmAction"),
      );
      if (!confirmed) return;
    }
    setSaving(true);
    try {
      await onCommit({
        ...working,
        // Finishing the setup is the answer to "do you want this automatic". A later edit leaves
        // the switch alone — someone who turned it off and came back to change the interval did
        // not ask for it to be turned on again.
        enabled: configured ? working.enabled : true,
        setupDone: true,
        // Three things that are about the *old* place, cleared together when the backup moves.
        // `lastHash` is the important one: a new destination is empty but the payload has not
        // changed, so without clearing the digest the next run would skip as "unchanged" and the
        // new place would stay empty until something else in the app happened to change. The files
        // already written are left exactly where they are.
        ...(moved ? { lastHash: "", lastError: "", driveFileId: "" } : {}),
      });
      setDraft(null);
      setOpened(null);
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    if (!(await confirmAction(t("backup.resetConfirm"), true, t("backup.resetAction")))) return;
    try {
      await onReset();
      setDraft(null);
      setOpened(null);
      setStep("where");
    } catch (e) {
      pushErrorToast(String(e));
    }
  };

  const browse = async () => {
    const folder = await backupPickFolder().catch((e: unknown) => {
      pushErrorToast(String(e));
      return null;
    });
    if (folder) edit({ folder });
  };

  // -------------------------------------------------------------------------
  // The summary
  // -------------------------------------------------------------------------

  if (!editing) {
    const target = TARGETS.find((entry) => entry.id === settings.target) ?? TARGETS[0];
    const interval = INTERVALS.find((entry) => entry.value === String(settings.intervalMinutes));
    const account = settings.target === "onedrive" ? onedrive.account : drive.account;
    const where = writesToFolder(settings.target)
      ? settings.folder
      : account === ""
        ? t("backup.summaryNoAccount")
        : account;
    const runnable = state.destinationReady && state.hasPassphrase;
    const lastAt =
      settings.lastBackupAt === "" ? t("backup.never") : new Date(settings.lastBackupAt).toLocaleString();
    const status: { tone: Tone; text: string } = running
      ? { tone: "accent", text: t("backup.runningNow") }
      : settings.lastError !== ""
        ? { tone: "warning", text: t("backup.lastError", { error: settings.lastError }) }
        : settings.lastBackupAt === ""
          ? { tone: "muted", text: t("backup.lastAt", { at: lastAt }) }
          : { tone: "success", text: t("backup.lastAt", { at: lastAt }) };

    return (
      <>
        <Row label={t("backup.enabled")} hint={t("backup.enabledHint")}>
          <Checkbox
            checked={settings.enabled}
            disabled={!runnable}
            onChange={(enabled) => onPatch({ enabled })}
          />
        </Row>
        {!runnable && <Note tone="warning">{t("backup.notReady")}</Note>}

        <div className="my-2 rounded-lg border border-[var(--cf-border)] px-3 py-2">
          <SummaryRow label={t("backup.target")} value={t(target.labelKey)} />
          <SummaryRow label={t("backup.summaryWhere")} value={where} mono={writesToFolder(settings.target)} />
          <SummaryRow
            label={t("backup.interval")}
            value={interval ? t(interval.labelKey) : String(settings.intervalMinutes)}
          />
          <SummaryRow
            label={t("backup.onExit")}
            value={settings.onExit ? t("common.yes") : t("common.no")}
          />
          <SummaryRow label={t("backup.keepCopies")} value={String(settings.keepCopies)} />
        </div>

        {/* Pulsing while a run is in flight — the same dot the rest of the app uses for a state
            that is in motion. It goes back to the timestamp on its own when the run finishes, which
            is the point: the line is what the backup is doing, not what it was doing when this
            panel happened to open. */}
        <Status tone={status.tone} pulse={running}>
          {status.text}
        </Status>
        {settings.lastBackupPath !== "" && (
          <div className="mt-1.5">
            <PathReadout value={settings.lastBackupPath} />
          </div>
        )}

        {/* Reset is pushed to its own end of the row rather than lined up with the other three:
            it is the only one here that throws away an answer, and a button that undoes the setup
            should not sit shoulder to shoulder with the one that edits it. */}
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          {/* `state.running` covers the scheduler's runs as well as this button's, so a backup that
              started on the ticker while settings were open shows here rather than leaving a
              pressable button in front of a run already under way. */}
          <Actions>
            <PrimaryButton onClick={() => void onRunNow()} disabled={busy || running || !runnable}>
              <RefreshCw size={12} className={running ? "animate-spin" : ""} />
              {running ? t("backup.runningNow") : t("backup.runNow")}
            </PrimaryButton>
            <GhostButton onClick={openWizard}>
              <Pencil size={12} />
              {t("backup.edit")}
            </GhostButton>
          </Actions>
          <GhostButton onClick={() => void reset()} disabled={running} title={t("backup.resetHint")}>
            <RotateCcw size={12} />
            {t("backup.reset")}
          </GhostButton>
        </div>
      </>
    );
  }

  // -------------------------------------------------------------------------
  // The wizard
  // -------------------------------------------------------------------------

  // Editing an existing setup, any step is one click away — that is what Edit is for. Filling one
  // in for the first time, only the steps already answered are, so Next stays the way forward.
  const canJump = (index: number) => configured || index <= stepIndex;

  return (
    <>
      {/* A third of the row each, so the three steps read as a track with a position on it rather
          than as three buttons that happen to be in a row. */}
      <ol className="mb-3 flex items-stretch gap-1">
        {STEPS.map(({ id, labelKey }, index) => {
          const active = id === step;
          const reachable = canJump(index);
          return (
            <li key={id} className="min-w-0 flex-1">
              <button
                type="button"
                disabled={!reachable}
                onClick={() => setStep(id)}
                aria-current={active ? "step" : undefined}
                className={`flex w-full items-center justify-center gap-1.5 rounded-md px-2 py-1 text-[12px] transition-colors ${
                  active
                    ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
                    : reachable
                      ? "text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
                      : "text-[var(--cf-text-muted)]/50"
                }`}
              >
                <span
                  className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-medium ${
                    active
                      ? "bg-[var(--cf-accent)] text-white"
                      : "border border-[var(--cf-border)] text-[var(--cf-text-muted)]"
                  }`}
                >
                  {index + 1}
                </span>
                <span className="truncate">{t(labelKey)}</span>
              </button>
            </li>
          );
        })}
      </ol>

      {activeStep.hintKey && (
        <p className="mb-3 text-[11.5px] leading-snug text-[var(--cf-text-muted)]">
          {t(activeStep.hintKey)}
        </p>
      )}

      {/* Step 1 — the places, as cards. A dropdown made this look like a preference among
          near-identical options; they are not, and the difference between "a folder something else
          syncs" and "an account this signs in to" is the whole decision.

          The synced folders found on this machine are cards here too, in their own group. They used
          to be a row of chips in step two, offered only once you had already answered "a folder" —
          which put the easiest destinations in the app behind the most general answer, and put a
          Dropbox suggestion in front of someone who had just said they wanted to choose the folder
          themselves. They are answers to *where*, so they belong to the question. */}
      {step === "where" && (
        <>
          {detected.length > 0 && (
            <>
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
                {t("backup.foundHere")}
              </p>
              <div className="mb-3 grid grid-cols-2 gap-2">
                {detected.map((found) => (
                  <TargetCard
                    key={found.path}
                    icon={FolderSync}
                    label={SYNC_LABELS[found.kind]}
                    hint={t("backup.syncFolderHint", { name: SYNC_LABELS[found.kind] })}
                    selected={found.path === activeSync?.path}
                    onClick={() => edit({ target: "folder", folder: presetOf(found) })}
                  />
                ))}
              </div>
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
                {t("backup.otherPlaces")}
              </p>
            </>
          )}
          <div className="grid grid-cols-2 gap-2">
            {TARGETS.map(({ id, labelKey, hintKey, icon }) => (
              <TargetCard
                key={id}
                icon={icon}
                label={t(labelKey)}
                hint={t(hintKey)}
                // "A folder" means *this* one only while it isn't one of the found ones, or picking
                // Dropbox above would leave two cards ticked saying the same thing.
                selected={targetPicked && working.target === id && !(id === "folder" && activeSync)}
                onClick={() => chooseTarget(id)}
              />
            ))}
          </div>
        </>
      )}

      {/* Step 2 — the destination itself, which is a different question for each answer above. */}
      {step === "destination" && (
        <>
          {usesFolder ? (
            <>
              <Row label={t("backup.folder")} wide>
                <GhostButton onClick={() => void browse()}>
                  <FolderOpen size={12} />
                  {t("backup.browse")}
                </GhostButton>
              </Row>
              {working.folder !== "" && (
                <PathReadout
                  value={working.folder}
                  onReveal={() =>
                    void backupRevealFolder(working.folder).catch((e: unknown) =>
                      pushErrorToast(String(e)),
                    )
                  }
                />
              )}
              {/* No shortcuts to the synced folders here. They are cards in the previous step now —
                  offering them again to someone who has just chosen to pick the folder themselves
                  is second-guessing the answer they came from. */}
              {working.target === "icloud" && state.icloudFolder === "" && (
                <Note tone="warning">{t("backup.icloudMissing")}</Note>
              )}
            </>
          ) : working.target === "onedrive" ? (
            <OneDriveConnection
              clientId={onedrive.clientId}
              account={onedrive.account}
              onSave={onPatchOneDrive}
            />
          ) : (
            <DriveConnection clientId={drive.clientId} account={drive.account} onSave={onPatchDrive} />
          )}
          {/* No "choose a destination to carry on" note. Next is already disabled until there is
              one, and a line repeating that is the panel telling you what the greyed-out button in
              the corner has just told you. */}
        </>
      )}

      {/* Step 3 — the schedule. No "enabled" switch: finishing this is what turns it on. */}
      {step === "schedule" && (
        <>
          <Row label={t("backup.interval")} wide>
            <Select
              size="sm"
              value={String(working.intervalMinutes)}
              onChange={(value) => edit({ intervalMinutes: Number(value) })}
              options={INTERVALS.map(({ value, labelKey }) => ({ value, label: t(labelKey) }))}
              ariaLabel={t("backup.interval")}
            />
          </Row>
          <Row label={t("backup.onExit")}>
            <Checkbox checked={working.onExit} onChange={(onExit) => edit({ onExit })} />
          </Row>
          {/* The one line kept out of the three that used to sit in the label column, and it is
              under the input rather than beside the title because it is about the *value* — what
              typing nothing in particular gets you. Spelled "zero" and not "0": in this typeface,
              at this size, a lone digit zero in a sentence reads as a capital O. */}
          <Row label={t("backup.keepCopies")}>
            <span className="block w-full">
              <Field
                type="number"
                value={String(working.keepCopies)}
                onChange={(value) => {
                  const parsed = Number(value);
                  edit({
                    keepCopies: Number.isFinite(parsed) ? Math.min(50, Math.max(0, Math.floor(parsed))) : 0,
                  });
                }}
              />
              <span className="mt-1 block text-[11px] leading-snug text-[var(--cf-text-muted)]">
                {t("backup.keepCopiesZero")}
              </span>
            </span>
          </Row>
          {!state.hasPassphrase && <Note tone="warning">{t("backup.needPasswordFirst")}</Note>}
        </>
      )}

      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-[var(--cf-border)] pt-3">
        <GhostButton
          onClick={() => setStep(STEPS[Math.max(0, stepIndex - 1)].id)}
          disabled={stepIndex === 0}
        >
          <ArrowLeft size={12} />
          {t("backup.back")}
        </GhostButton>

        <Actions>
          {/* Cancel only exists once there is something to go back *to*. During the first setup
              there is no summary behind this pane, so a Cancel would land on nothing. */}
          {configured && (
            <GhostButton
              onClick={() => {
                setDraft(null);
                setOpened(null);
              }}
              disabled={saving}
            >
              {t("common.cancel")}
            </GhostButton>
          )}
          {stepIndex < STEPS.length - 1 ? (
            <PrimaryButton
              onClick={() => setStep(STEPS[stepIndex + 1].id)}
              // Nothing ticked means the question is still open, and carrying on would answer it
              // with the stored default on the user's behalf — the very thing the blank grid is
              // there to stop.
              disabled={(step === "where" && !targetPicked) || (step === "destination" && !ready)}
            >
              {t("backup.next")}
              <ArrowRight size={12} />
            </PrimaryButton>
          ) : (
            <PrimaryButton onClick={() => void save()} disabled={saving || !ready}>
              <Check size={12} />
              {configured ? t("common.save") : t("backup.finish")}
            </PrimaryButton>
          )}
          {/* Editing, Save is reachable from any step — jumping to step two to repoint the folder
              and then having to walk to the end to keep it is the thing Edit exists to avoid. */}
          {configured && stepIndex < STEPS.length - 1 && (
            <GhostButton onClick={() => void save()} disabled={saving || !ready}>
              <Check size={12} />
              {t("common.save")}
            </GhostButton>
          )}
        </Actions>
      </div>
    </>
  );
}
