import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  Clock,
  DatabaseBackup,
  Download,
  FolderOpen,
  KeyRound,
  ListChecks,
  RefreshCw,
  Upload,
  type LucideIcon,
} from "lucide-react";
import { motion } from "framer-motion";
import { ApiModal, Field, GhostButton, PrimaryButton, Row } from "../api/ApiModal";
import { ActivePill, ActiveUnderline } from "../common/ActivePill";
import { Actions, HelpLink, Note, SettingsHeader, Status } from "../api/settingsChrome";
import { Checkbox } from "../common/Checkbox";
import { BackupAutomatic } from "./BackupAutomatic";
import { DriveGuide, ICloudGuide, OneDriveGuide, SyncedFolderGuide } from "./backupGuides";
import { confirmAction } from "../../state/confirmStore";
import { pushErrorToast, useToastStore } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import { onBackupRunning } from "../../lib/tauri/events";
import {
  backupClearPassphrase,
  backupExportToFile,
  backupListAtDestination,
  backupPassphraseMatches,
  backupPickAndInspect,
  backupRestoreDrive,
  backupRestoreFile,
  backupRestoreOneDrive,
  backupResetAuto,
  backupRunNow,
  backupSaveDrive,
  backupSaveOneDrive,
  backupSaveSettings,
  backupSetPassphrase,
  backupState,
  destinationReady,
  formatBytes,
  INCLUDE_KEYS,
  passphraseStrength,
  writesToFolder,
  type BackupInclude,
  type BackupInfo,
  type BackupSettings as Settings,
  type BackupState,
  type RestoreReport,
} from "../../lib/tauri/backupCommands";
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

/** The lowest rung of [`passphraseStrength`] this panel will accept — "fair". */
const MIN_STRENGTH = 2;

type BackupTab = "content" | "password" | "backup" | "restore" | "guides";

/**
 * The five panes, in the order you would actually set this up: decide what goes in the file, give it
 * a password, then say how it gets written. Guides last, because they are the thing you read once
 * while choosing a destination and never again.
 *
 * `backup` and `restore` are one pane each, and that pairing is the point: restoring used to be two
 * buttons in two different tabs, each tucked beside the settings for writing a file. Writing and
 * reading are the two things that actually happen here — *how* a file gets written is a choice
 * inside the writing pane, not a second place to look for it.
 *
 * `hintKey` is optional because one pane doesn't need one: `backup` opens on its own two tabs, which
 * say what its two halves are more directly than a paragraph summarising both ever did.
 */
const TABS: { id: BackupTab; labelKey: TranslationKey; hintKey?: TranslationKey; icon: LucideIcon }[] = [
  { id: "content", labelKey: "backup.tabContent", hintKey: "backup.tabContentHint", icon: ListChecks },
  { id: "password", labelKey: "backup.tabPassword", hintKey: "backup.tabPasswordHint", icon: KeyRound },
  { id: "backup", labelKey: "backup.tabBackup", icon: Upload },
  { id: "restore", labelKey: "backup.tabRestore", icon: Download },
  { id: "guides", labelKey: "backup.tabGuides", hintKey: "backup.tabGuidesHint", icon: BookOpen },
];

/** The two halves of the "Back up" pane: one file written now, or the schedule that writes them. */
type BackupMode = "manual" | "automatic";

/**
 * They are two tabs rather than two groups stacked in one pane because they are two errands, and
 * only ever one at a time: "give me a copy right now" is a password and a button, while "keep this
 * computer backed up" is a destination, an interval and a retention count. Stacked, the second one
 * pushed the first's answer off the top of the pane, and the pane needed a paragraph above both to
 * explain what it was you were looking at.
 *
 * Manual comes first, and is where the pane opens: it is the errand you arrive with, and it works
 * before anything below it is set up.
 */
const MODES: { id: BackupMode; labelKey: TranslationKey; icon: LucideIcon }[] = [
  { id: "manual", labelKey: "backup.modeManual", icon: Upload },
  { id: "automatic", labelKey: "backup.modeAutomatic", icon: Clock },
];

/**
 * The meter and the advice, as one panel sitting under the field it judges.
 *
 * Both used to live in the `Row`: the advice as its `hint`, under the "Password" label. A `Row` is
 * `items-center` with the label in a flexible column, so a hint that grew to three lines grew the
 * column, and the label — and the field beside it — slid down to stay centred against it. The
 * feedback changes on every keystroke, so the title of the input it belongs to was drifting while
 * you typed into it.
 *
 * Out here it can't move anything: the panel is below the row, in the field's own column so it
 * lines up under what it is about, and the row above it is one line tall no matter what it says.
 *
 * The bars are length-dominated on purpose — for a passphrase fed to Argon2id, length is worth far
 * more than punctuation, and a meter that says otherwise teaches the wrong habit. The line beneath
 * them is advice rather than a second verdict: the bars already say "fair", and saying it twice in
 * two registers is how a panel starts feeling like it is nagging.
 */
function PassphraseFeedback({ value }: { value: string }) {
  const t = useT();
  const score = passphraseStrength(value);
  const empty = value === "";
  const labels: TranslationKey[] = [
    "backup.strengthTooShort",
    "backup.strengthWeak",
    "backup.strengthFair",
    "backup.strengthStrong",
  ];
  const colors = ["var(--cf-danger)", "var(--cf-warning)", "var(--cf-warning)", "var(--cf-success)"];
  // One rung, one thing to say. The two that can't be saved say what is missing; the two that can
  // say what it buys, because at that point instructing further is nagging.
  const advice: TranslationKey = empty
    ? "backup.adviceEmpty"
    : value.length < MIN_PASSPHRASE
      ? "backup.adviceShort"
      : score < MIN_STRENGTH
        ? "backup.adviceWeak"
        : score >= 3
          ? "backup.adviceStrong"
          : "backup.adviceFair";

  return (
    // Mirrors `Row`'s two columns so the panel starts exactly where the field does, with an empty
    // spacer standing in for the label.
    <div className="flex items-start gap-3 pb-1">
      <span className="min-w-0 flex-1" />
      <span className="w-[360px] max-w-[62%] shrink-0 rounded-md bg-black/[0.02] px-2 py-1.5 dark:bg-white/[0.03]">
        {/* Nothing typed yet is nothing to measure, so the bars stay away until there is. */}
        {!empty && (
          <span className="mb-1 flex items-center gap-2">
            <span className="flex flex-1 gap-1">
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
            </span>
            <span className="shrink-0 text-[10px] font-medium" style={{ color: colors[score] }}>
              {t(labels[score])}
            </span>
          </span>
        )}
        <span className="block text-[11px] leading-snug text-[var(--cf-text-muted)]">
          {t(advice, { n: String(Math.max(0, MIN_PASSPHRASE - value.length)) })}
        </span>
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

  const mismatch = confirm.length > 0 && confirm !== next;
  // Nothing below "fair" can be saved. Eight characters is the floor the *format* needs — the file
  // is meant to sit in someone's cloud storage, where the threat is an offline attack against a
  // copy of it, and `password` clears eight characters. Refusing the two weakest rungs is the one
  // moment this can be insisted on: after this the passphrase is what every future backup is sealed
  // with, and there is no recovery to fall back on.
  const strongEnough = passphraseStrength(next) >= MIN_STRENGTH;
  const canSave = strongEnough && confirm === next && (!has || current.length > 0);

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

  // Already set: the rail names this pane, so there is no heading to repeat here either.
  if (has && !editing) {
    return (
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
    );
  }

  return (
    <>
      {has && (
        <Row label={t("backup.currentPassword")} wide>
          <Field type="password" value={current} onChange={setCurrent} />
        </Row>
      )}
      {/* No `hint`: everything this row has to say about what was typed is in the panel below it,
          which is what keeps this row exactly one line tall while you type. */}
      <Row label={t("backup.newPassword")} wide>
        <Field type="password" value={next} onChange={setNext} />
      </Row>
      <PassphraseFeedback value={next} />
      <Row label={t("backup.confirmPassword")} wide>
        <Field type="password" value={confirm} onChange={setConfirm} />
      </Row>
      {mismatch && <Note tone="warning">{t("backup.passwordMismatch")}</Note>}
      <Actions>
        {/* Solid, not ghost. This is the one action the whole section is gated on, and as a ghost
            button it was grey text on the panel background — indistinguishable from the labels
            around it until you happened to hover it. `PrimaryButton` is the shape the app already
            uses for a primary action; Cancel stays a ghost so the pair reads as one choice. */}
        <PrimaryButton onClick={() => void save()} disabled={!canSave || busy}>
          {t("common.save")}
        </PrimaryButton>
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
    </>
  );
}

// ---------------------------------------------------------------------------
// What goes into the file
// ---------------------------------------------------------------------------

/**
 * One switch: name and checkbox on the line, the explanation folded away behind it.
 *
 * Collapsed by default, and that is the whole point of the row — nine groups each carrying two or
 * three lines of prose turned this pane into a wall you had to read past to reach the third
 * checkbox, when most visits are someone who already knows what they want toggling one thing. The
 * detail is still a click away for the visit where you don't.
 *
 * The disclosure and the checkbox are siblings rather than one nested in the other, and that is the
 * point: making the whole row toggle the switch would mean reading about a group costs you a change
 * to it, and nesting the box inside the expander would fire both on every click. The name expands,
 * the box checks, and neither can reach the other.
 */
function IncludeRow({
  label,
  detail,
  checked,
  onChange,
}: {
  label: string;
  detail: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="py-0.5">
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left text-[12px] text-[var(--cf-text)]"
        >
          {open ? (
            <ChevronDown size={12} className="shrink-0 text-[var(--cf-text-muted)]" />
          ) : (
            <ChevronRight size={12} className="shrink-0 text-[var(--cf-text-muted)]" />
          )}
          <span className="truncate">{label}</span>
        </button>
        <span className="shrink-0">
          <Checkbox checked={checked} onChange={onChange} />
        </span>
      </div>
      {open && (
        // Indented to the label rather than the chevron, so the text reads as belonging to the row
        // above it instead of starting a new one.
        <p className="mb-1 pl-[18px] pr-6 text-[11px] leading-snug text-[var(--cf-text-muted)]">
          {detail}
        </p>
      )}
    </div>
  );
}

/**
 * The per-group switches, one row each with what it covers and what turning it off costs.
 *
 * Nothing above the rows. This pane used to open with three stacked blocks — the tab's own hint,
 * "what travels", "what stays behind" — plus a fourth for what has no switch, and between them the
 * sentence about repositories appeared twice word for word while "what travels" listed exactly what
 * the switches below already say. Four paragraphs to reach the first checkbox. Each row now carries
 * its own explanation, which is where someone deciding about that row is already looking; the two
 * facts no row can state are the warnings and the closing line below.
 *
 * The rows are driven off `INCLUDE_KEYS` so a group added in Rust surfaces here by adding two
 * translation keys, rather than by anyone remembering to write another `<Row>`.
 */
function IncludeGroup({
  include,
  onChange,
}: {
  include: BackupInclude;
  onChange: (include: BackupInclude) => void;
}) {
  const t = useT();
  const count = INCLUDE_KEYS.filter((key) => include[key]).length;

  return (
    <>
      <div className="divide-y divide-[var(--cf-border)] border-y border-[var(--cf-border)]">
        {INCLUDE_KEYS.map((key) => (
          <IncludeRow
            key={key}
            label={t(`backup.include.${key}`)}
            detail={t(`backup.include.${key}Hint`)}
            checked={include[key]}
            onChange={(checked) => onChange({ ...include, [key]: checked })}
          />
        ))}
      </div>
      {!include.credentials && <Note tone="warning">{t("backup.includeNoCredentialsWarning")}</Note>}
      {include.agentWork && !include.conversations && (
        <Note tone="warning">{t("backup.includeAgentWorkNeedsConversations")}</Note>
      )}
      <p className="mt-1.5 text-[11px] leading-snug text-[var(--cf-text-muted)]">
        {count === INCLUDE_KEYS.length
          ? t("backup.includeAllHint")
          : t("backup.includePartialHint", { n: String(INCLUDE_KEYS.length - count) })}
      </p>
    </>
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
      // Opened from inside Settings, which is itself a `z-50` overlay — without this the dialog
      // lands underneath it and all the user sees is the screen going darker.
      raised
      onClose={onClose}
      footer={
        // `w-full`: the footer bar is a flex row and this is one item in it, so without a width to
        // fill, `justify-end` has nothing to push against and both buttons sat at the left.
        <div className="flex w-full items-center justify-end gap-1.5">
          <GhostButton onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </GhostButton>
          {/* Solid, and red when it is the replacing kind. This is the one button in the section
              that can destroy work, and it was a ghost — grey text, lighter than the Cancel beside
              it, indistinguishable from a label until you hovered it. */}
          <PrimaryButton onClick={() => void run()} disabled={busy || passphrase === ""} danger={replace}>
            <Download size={12} />
            {busy ? t("backup.restoring") : t("backup.restoreAction")}
          </PrimaryButton>
        </div>
      }
    >
      {/* Three questions in order, each with room around it: what this file is, the password for it,
          and what to do with what is already here. It used to be three stacked strips inside `p-1`
          — a bordered box of grey lines, a label and a field pushed to opposite edges of the
          dialog, and a checkbox whose meaning changed the sentence under it — which is a lot of
          decisions to read in the width of a paragraph. */}
      <div className="overflow-y-auto px-4 py-4">
        <dl className="rounded-lg border border-[var(--cf-border)] px-3 py-2.5">
          <FileFact label={t("backup.fileCreated")} value={created === "" ? "—" : created} />
          <FileFact
            label={t("backup.fileFrom")}
            value={`${source.info.os} · CodeFlow ${source.info.appVersion}`}
          />
          <FileFact label={t("backup.fileSize")} value={formatBytes(source.info.bytes)} />
        </dl>

        {/* Stacked rather than a `Row`. Label and field on opposite sides of a dialog this wide put
            a hand's width of nothing between the question and where you answer it. */}
        <label className="mt-4 block">
          <span className="mb-1.5 block text-[12px] text-[var(--cf-text)]">{t("backup.password")}</span>
          <Field
            type="password"
            value={passphrase}
            placeholder={t("backup.passwordForFile")}
            onChange={setPassphrase}
          />
        </label>

        {/* Two named choices instead of one checkbox.
            As a checkbox this was a single sentence — "leave this computer exactly like the
            backup" — whose *unticked* meaning was written nowhere except a hint that swapped
            underneath it as you clicked. Merging is not "not replacing"; it is the other half of
            the decision, and it deserves a name and a line of its own. */}
        <p className="mb-1.5 mt-4 text-[12px] text-[var(--cf-text)]">{t("backup.restoreModeTitle")}</p>
        <div className="flex flex-col gap-1.5">
          <RestoreChoice
            title={t("backup.modeMerge")}
            detail={t("backup.mergeHint")}
            selected={!replace}
            onSelect={() => setReplace(false)}
          />
          <RestoreChoice
            title={t("backup.modeReplace")}
            detail={t("backup.replaceHint")}
            selected={replace}
            danger
            onSelect={() => setReplace(true)}
          />
        </div>
      </div>
    </ApiModal>
  );
}

/** One line of what the file says about itself: term on the left, value on the right. */
function FileFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-[3px]">
      <dt className="shrink-0 text-[11px] text-[var(--cf-text-muted)]">{label}</dt>
      <dd className="min-w-0 truncate text-[12px] text-[var(--cf-text)]" title={value}>
        {value}
      </dd>
    </div>
  );
}

/**
 * Replace or merge, as one of two rows you pick between.
 *
 * A radio rather than a card grid: these are not two destinations, they are two answers to one
 * question, and stacked rows keep the consequence of each on the same line of sight as its name.
 * The replacing one goes red when chosen — not always, because a warning that is on screen before
 * you have chosen anything is decoration.
 */
function RestoreChoice({
  title,
  detail,
  selected,
  danger = false,
  onSelect,
}: {
  title: string;
  detail: string;
  selected: boolean;
  danger?: boolean;
  onSelect: () => void;
}) {
  const accent = danger ? "var(--cf-danger)" : "var(--cf-accent)";
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className="flex items-start gap-2.5 rounded-lg border p-2.5 text-left transition-colors"
      style={{
        borderColor: selected ? accent : "var(--cf-border)",
        background: selected ? `color-mix(in oklab, ${accent} 8%, transparent)` : "transparent",
      }}
    >
      <span
        className="mt-[3px] flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border"
        style={{ borderColor: selected ? accent : "var(--cf-border)" }}
      >
        {selected && <span className="h-1.5 w-1.5 rounded-full" style={{ background: accent }} />}
      </span>
      <span className="min-w-0">
        <span className="block text-[12px]" style={{ color: selected ? accent : "var(--cf-text)" }}>
          {title}
        </span>
        <span className="mt-0.5 block text-[11px] leading-snug text-[var(--cf-text-muted)]">
          {detail}
        </span>
      </span>
    </button>
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
      raised
      onClose={onClose}
      footer={
        <div className="flex w-full items-center justify-end gap-1.5">
          <GhostButton onClick={onClose}>{t("backup.later")}</GhostButton>
          <PrimaryButton onClick={() => void relaunch()}>
            <RefreshCw size={12} />
            {t("backup.restartNow")}
          </PrimaryButton>
        </div>
      }
    >
      <div className="overflow-y-auto px-4 py-4 text-[12px]">
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
  const [restoring, setRestoring] = useState<RestoreSource | null>(null);
  const [restored, setRestored] = useState<RestoreReport | null>(null);
  /** What is sitting at the destination. `null` until it has been looked for. */
  const [atDestination, setAtDestination] = useState<BackupInfo[] | null>(null);
  const [listing, setListing] = useState(false);
  const [tab, setTab] = useState<BackupTab>("content");
  const [mode, setMode] = useState<BackupMode>("manual");
  const activeTab = TABS.find((entry) => entry.id === tab) ?? TABS[0];

  // The five panes are nowhere near the same height — arriving at the password pane while scrolled
  // to the bottom of the guides left it starting somewhere in its middle. Same fix and same reason
  // for the layout effect as `ClaudeSettings`: land at the top before the frame is painted rather
  // than as a visible correction after it. `mode` is in here for the same reason: the scheduled
  // half is several times the height of the by-hand one, so switching back landed mid-pane.
  const paneRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    paneRef.current?.scrollTo({ top: 0 });
  }, [tab, mode]);

  const load = useCallback(() => {
    void backupState()
      .then(setState)
      .catch((e: unknown) => pushErrorToast(String(e)));
  }, []);
  useEffect(load, [load]);

  /**
   * Reads the destination, headers only — no password is involved in finding out what is there.
   *
   * Deferred until the Restore pane is actually opened: for Drive and OneDrive this is a network
   * round trip, and paying for it on every visit to Settings — nearly all of which are about
   * something else — would make opening the section wait on somebody's Wi-Fi.
   */
  const listDestination = useCallback(() => {
    setListing(true);
    backupListAtDestination()
      .then(setAtDestination)
      .catch((e: unknown) => {
        setAtDestination([]);
        pushErrorToast(String(e));
      })
      .finally(() => setListing(false));
  }, []);

  useEffect(() => {
    if (tab === "restore" && atDestination === null && !listing) listDestination();
  }, [tab, atDestination, listing, listDestination]);

  /**
   * Follows runs started anywhere, which in practice means the scheduler's.
   *
   * The button's own run is covered by `busy`, and this would be enough on its own — but a
   * scheduled backup landing while this panel is open used to be invisible: it wrote a new
   * timestamp and a new path into settings that this component had already read, so the summary sat
   * there showing the previous run until someone happened to reopen the section. Reloading on the
   * way *out* of a run is what keeps "last backup" a fact rather than a snapshot of when the panel
   * was opened.
   */
  useEffect(() => {
    const unlisten = onBackupRunning((running) => {
      setState((previous) => (previous ? { ...previous, running } : previous));
      if (!running) load();
    });
    return () => {
      void unlisten.then((off) => off());
    };
  }, [load]);

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
        destinationReady: destinationReady(settings, previous.drive.clientId, previous.onedrive.clientId),
      };
    });
  };

  /**
   * The same write without the debounce, and awaited.
   *
   * What the step-by-step setup commits through. The debounce is right for a checkbox that might be
   * clicked twice in a second; it is wrong for a Save that the pane redraws itself off, where a
   * 400ms window is long enough for the summary to appear before the settings behind it exist.
   */
  const commit = useCallback(async (settings: Settings) => {
    // Whatever the debounce was holding is superseded — this writes the whole object.
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    pending.current = null;
    // Written before the pane is redrawn off it, so a store that refuses leaves the wizard up with
    // the answers still in it rather than a summary of settings that were never saved.
    await backupSaveSettings(settings);
    setState((previous) =>
      previous
        ? {
            ...previous,
            settings,
            destinationReady: destinationReady(
              settings,
              previous.drive.clientId,
              previous.onedrive.clientId,
            ),
          }
        : previous,
    );
  }, []);

  /**
   * Forgets the scheduled setup and reloads, so the wizard comes back asking from the top.
   *
   * Here rather than in the pane that offers it because of the debounce: a switch flipped a moment
   * before pressing Reset is still sitting in `pending`, and would be written back over the reset
   * 400ms later. Cancelling it is bookkeeping only this component can do.
   */
  const resetAuto = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    pending.current = null;
    await backupResetAuto();
    setState(await backupState());
  }, []);

  const patchDrive = (changes: { clientId?: string; account?: string }) => {
    setState((previous) => {
      if (!previous) return previous;
      const drive = { ...previous.drive, ...changes };
      void backupSaveDrive(drive).catch((e: unknown) => pushErrorToast(String(e)));
      return {
        ...previous,
        drive,
        destinationReady: destinationReady(
          previous.settings,
          drive.clientId,
          previous.onedrive.clientId,
        ),
      };
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
        destinationReady: destinationReady(
          previous.settings,
          previous.drive.clientId,
          onedrive.clientId,
        ),
      };
    });
  };

  // One round trip, and it reads the credential store — which on macOS can be a prompt. The
  // subtitle stands in for the body meanwhile rather than a spinner, because the section's own
  // heading is the honest thing to show while its contents are on the way.
  if (!state) {
    return (
      <section>
        <SettingsHeader title={t("backup.title")} hint={t("backup.subtitle")} />
      </section>
    );
  }

  const { settings } = state;
  const usesFolder = writesToFolder(settings.target);

  const exportNow = async () => {
    setBusy(true);
    try {
      const result = await backupExportToFile();
      if (!result) return;
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

  /**
   * How a file from the destination is fetched back.
   *
   * A folder destination gives real paths, so each dated copy is restorable by name through the
   * ordinary file route. The two cloud ones keep a single file addressed by the account rather than
   * by a path, and have their own commands for it.
   */
  const destinationKind = usesFolder
    ? "file"
    : settings.target === "onedrive"
      ? "onedrive"
      : "drive";

  return (
    // The same frame as the AI assistant's settings, and for the same reason: five groups stacked
    // in one column made this the longest section in the window by a wide margin, so the guides at
    // the bottom were three screens below the destination they explain, and "back up now" scrolled
    // off the moment you went to check what was included. One rail, one pane, nothing stacked.
    <section className="flex h-full min-h-0 flex-col">
      <div className="shrink-0">
        <SettingsHeader title={t("backup.title")} hint={t("backup.subtitle")} />
      </div>

      <div className="flex min-h-0 flex-1 gap-4">
        {/* `layoutRoot` on a `motion.nav`, for the reason spelled out in `ApiSettingsBody`: the
            pill's before/after rects would otherwise be measured against a scroll position the
            arriving pane has just changed, and the slide would land as a jump. */}
        <motion.nav layoutRoot className="w-[168px] shrink-0 self-start">
          {TABS.map(({ id, labelKey, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              aria-current={tab === id ? "page" : undefined}
              title={t(labelKey)}
              className={`relative mb-0.5 flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-[12.5px] transition-colors ${
                tab === id
                  ? "text-[var(--cf-accent)]"
                  : "text-[var(--cf-text-muted)] hover:bg-black/[0.03] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.04]"
              }`}
            >
              {/* Its own `layoutId`, so the pill can't fly between this rail and another's. */}
              {tab === id && <ActivePill layoutId="cf-backup-settings-pill" />}
              <span className="relative flex min-w-0 flex-1 items-center gap-1.5">
                <Icon size={13} className="shrink-0" />
                <span className="truncate">{t(labelKey)}</span>
              </span>
            </button>
          ))}
        </motion.nav>

        {/* The one moving part. `overflow-y-scroll`, not `auto`: the app styles its scrollbars, so
            one is a real 10px of layout rather than an overlay. Letting it come and go as a pane
            grows past the height — which is exactly what expanding a row does — narrowed the
            content and shifted every row sideways, then shifted them back on collapse. Same
            reserved-gutter fix, and the same reason, as the settings column around it; the track is
            transparent and the thumb isn't drawn when there is nothing to scroll. `pb-6` because
            the pane ends where the dialog does, and a last row flush against that edge reads as cut
            off rather than as the end of the list. */}
        <div ref={paneRef} className="min-w-0 flex-1 overflow-y-scroll pb-6">
          <div className="rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-4">
            {/* The rail names the pane, so no heading is repeated here — but the hint says what the
                label cannot, which is why it stays for the panes that have one. */}
            {activeTab.hintKey && (
              <p className="mb-4 text-[11.5px] leading-snug text-[var(--cf-text-muted)]">
                {t(activeTab.hintKey)}
              </p>
            )}

            {tab === "content" && (
              <IncludeGroup include={settings.include} onChange={(include) => patch({ include })} />
            )}

            {tab === "password" && <PassphraseGroup has={state.hasPassphrase} onChanged={load} />}

            {/* Restoring lives in its own pane, so both halves of this one are about writing a file:
                by hand, or on a schedule — two tabs rather than two stacked groups, see `MODES`.
                The same underlined strip as the review section's sub-tabs, and the same `-mb-px` so
                the active rule sits *on* the rule under the row rather than above it. */}
            {/* One row, split in two. Sized to their labels these were a short pair huddled in the
                top-left corner of a wide pane, which reads as a leftover control rather than as the
                two halves this pane has; an equal share each makes the underline say which half of
                the pane you are in. No `gap`, so the two rules meet as one line. */}
            {tab === "backup" && (
              <div className="mb-3 flex border-b border-[var(--cf-border)]">
                {MODES.map(({ id, labelKey, icon: Icon }) => (
                  <button
                    key={id}
                    onClick={() => setMode(id)}
                    aria-current={mode === id ? "page" : undefined}
                    className={`relative -mb-px flex flex-1 items-center justify-center gap-1.5 px-2.5 pb-2.5 pt-1.5 text-[12.5px] ${
                      mode === id
                        ? "text-[var(--cf-accent)]"
                        : "text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
                    }`}
                  >
                    {mode === id && <ActiveUnderline layoutId="cf-backup-mode-underline" />}
                    <Icon size={13} />
                    {t(labelKey)}
                  </button>
                ))}
              </div>
            )}

            {tab === "backup" &&
              mode === "manual" &&
              (!state.hasPassphrase ? (
                <Note tone="warning">{t("backup.needPasswordFirst")}</Note>
              ) : (
                <>
                  {/* A button and a sentence, with nothing to fill in. The file is sealed with the
                      password already stored — the same one the scheduled run writes with — so the
                      field that used to be here was asking for something the app was holding, and
                      a typo in it produced a file whose password nobody would learn was wrong
                      until the day they needed to open it. */}
                  {/* Centred and given room above rather than left-aligned in an `Actions` row.
                      With the password field gone there is nothing for it to line up under, and a
                      lone button pinned to the left edge of an otherwise empty pane reads as the
                      leftovers of a form. The paragraph below stays left-aligned — three centred
                      lines are harder to read than three ragged-right ones. */}
                  {/* Disabled while *any* backup is being written, not just this one. Sealing is
                      Argon2 by design, and a by-hand export started on top of the scheduler's run
                      pays for it twice at once to produce two copies of the same payload. */}
                  <div className="mt-5 flex justify-center">
                    <PrimaryButton onClick={() => void exportNow()} disabled={busy || state.running}>
                      {busy ? (
                        <RefreshCw size={12} className="animate-spin" />
                      ) : (
                        <Upload size={12} />
                      )}
                      {busy ? t("backup.exporting") : t("backup.exportNow")}
                    </PrimaryButton>
                  </div>
                  <p className="mt-3 text-[11px] leading-snug text-[var(--cf-text-muted)]">
                    {t("backup.manualHint")}
                  </p>
                </>
              ))}

            {tab === "backup" && mode === "automatic" && (
              <BackupAutomatic
                state={state}
                busy={busy}
                onPatch={patch}
                onCommit={commit}
                onReset={resetAuto}
                onRunNow={runNow}
                onPatchDrive={patchDrive}
                onPatchOneDrive={patchOneDrive}
              />
            )}

            {/* Its own pane, because restoring is not the other half of backing up — it is the
                thing you come here for on a bad day, and it was previously two buttons sitting in
                two different tabs, each beside the settings for writing a file. Both routes end in
                the same confirmation, which is where the file says what it holds before anything
                is touched. */}
            {tab === "restore" && (
              <>
                {/* No group heading: the rail already says Restore, and the pane holds nothing
                    else for a title to distinguish it from.

                    Two routes to the same dialog, as two blocks with a rule between them, and both
                    built out of the same bar — picking a file from disk and picking one of the
                    copies already at the destination end in exactly the same place, so neither is
                    a corner button while the other is a list. */}
                <RestoreSection title={t("backup.importFromFile")}>
                  <RestoreRow
                    icon={FolderOpen}
                    title={t("backup.chooseFile")}
                    disabled={busy}
                    onClick={() => void openFromFile()}
                  />
                </RestoreSection>

                {/* What is at the destination, listed rather than opened.
                    The button that used to be here fetched the newest file and went straight to the
                    password prompt, which quietly decided the one thing worth deciding: the dated
                    copies exist because the newest backup is often not the one you want — you are
                    usually here because of something that went wrong recently, and the newest copy
                    is the one most likely to have it in. */}
                <RestoreSection
                  divided
                  title={t("backup.restoreFromDestination")}
                  action={
                    <GhostButton
                      onClick={listDestination}
                      disabled={listing || !state.destinationReady}
                      title={t("backup.refreshList")}
                    >
                      <RefreshCw size={12} className={listing ? "animate-spin" : ""} />
                      {t("backup.refreshList")}
                    </GhostButton>
                  }
                >
                  {!state.destinationReady ? (
                    <Note>{t("backup.restoreNoDestination")}</Note>
                  ) : listing && atDestination === null ? (
                    <p className="text-[11px] text-[var(--cf-text-muted)]">
                      {t("backup.lookingForBackups")}
                    </p>
                  ) : (atDestination?.length ?? 0) === 0 ? (
                    <Note>{t("backup.noBackupThere")}</Note>
                  ) : (
                    <ul className="flex flex-col gap-1.5">
                      {atDestination?.map((info) => (
                        <li key={info.path}>
                          <RestoreRow
                            icon={Download}
                            title={
                              info.createdAt === ""
                                ? t("backup.unknownDate")
                                : new Date(info.createdAt).toLocaleString()
                            }
                            subtitle={fileNameOf(info.path)}
                            aside={formatBytes(info.bytes)}
                            hoverTitle={info.path}
                            disabled={busy}
                            onClick={() => setRestoring({ kind: destinationKind, info })}
                          />
                        </li>
                      ))}
                    </ul>
                  )}
                </RestoreSection>
                {/* No warning line down here. It was saying what the dialog that opens next says
                    properly — which file, and a named choice between replacing and merging with the
                    consequence of each. Choosing something to look at is not the destructive step,
                    and a warning in front of a step that changes nothing is one people learn to
                    read past before reaching the one that matters. */}
              </>
            )}

            {tab === "guides" && (
              <div className="flex flex-col gap-2">
                <SyncedFolderGuide />
                <ICloudGuide platform={state.platform} folder={state.icloudFolder} />
                <OneDriveGuide />
                <DriveGuide />
                <div className="mt-1">
                  <HelpLink url="https://www.google.com/drive/download/">
                    {t("backup.guide.driveDesktopLink")}
                  </HelpLink>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

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
 * One route into the restore dialog: a title, the line explaining it, its button, and whatever the
 * route needs below.
 *
 * A `Row` did this before and was the wrong shape for it. `Row` is `items-center` with a fixed
 * column for the control, which centres a two-word button against a two-line sentence and leaves a
 * gap the width of a hand between them — fine for a setting, wrong for a heading with an action.
 * Here the button aligns to the top, beside the title it belongs to.
 */
function RestoreSection({
  title,
  action,
  divided = false,
  children,
}: {
  title: string;
  action?: ReactNode;
  /** Draws the rule and the space that separate this route from the one above it. */
  divided?: boolean;
  children?: ReactNode;
}) {
  return (
    <section className={divided ? "mt-5 border-t border-[var(--cf-border)] pt-4" : "pt-1"}>
      <div className="flex items-start justify-between gap-4">
        <p className="min-w-0 text-[12.5px] text-[var(--cf-text)]">{title}</p>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      {children && <div className="mt-2.5">{children}</div>}
    </section>
  );
}

/**
 * One pressable bar: an icon, what it is, and a chevron saying it opens something.
 *
 * Shared by both routes on purpose. Picking a file and picking one of the copies already at the
 * destination end in exactly the same dialog, so they are the same kind of act and should not be a
 * button in a corner in one case and a list row in the other.
 */
function RestoreRow({
  icon: Icon,
  title,
  subtitle,
  aside,
  hoverTitle,
  disabled,
  onClick,
}: {
  icon: LucideIcon;
  title: string;
  subtitle?: string;
  aside?: string;
  hoverTitle?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={hoverTitle}
      className="flex w-full items-center gap-2.5 rounded-lg border border-[var(--cf-border)] px-3 py-2.5 text-left transition-colors hover:border-[color-mix(in_oklab,var(--cf-accent)_50%,transparent)] hover:bg-black/[0.02] disabled:opacity-40 dark:hover:bg-white/[0.03]"
    >
      <Icon size={13} className="shrink-0 text-[var(--cf-text-muted)]" />
      <span className="min-w-0 flex-1">
        <span className="block text-[12px] text-[var(--cf-text)]">{title}</span>
        {subtitle && (
          <span className="mt-0.5 block truncate font-mono text-[10.5px] text-[var(--cf-text-muted)]">
            {subtitle}
          </span>
        )}
      </span>
      {aside && <span className="shrink-0 text-[11px] text-[var(--cf-text-muted)]">{aside}</span>}
      <ChevronRight size={13} className="shrink-0 text-[var(--cf-text-muted)]" />
    </button>
  );
}

/** The last segment of a path, for a list where every row shares the same folder. Both separators,
 * because a backup restored onto the other operating system carries the paths it was written with. */
function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
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
    case "busy":
      return "backup.skipBusy";
    default:
      return "backup.skipDisabled";
  }
}
