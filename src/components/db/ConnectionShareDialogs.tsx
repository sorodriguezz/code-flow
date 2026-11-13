import { useEffect, useMemo, useState } from "react";
import { ClipboardPaste, KeyRound, Link2, Loader2, Share2, TriangleAlert } from "lucide-react";
import { ApiModal, GhostButton } from "../api/ApiModal";
import { buttonClass } from "../common/Button";
import { Checkbox } from "../common/Checkbox";
import { INPUT, Row } from "./dbChrome";
import { DriverGlyph } from "./DbLogo";
import { UNGROUPED, describeConnection, parseSpec, useDbStore } from "../../state/dbStore";
import { useDriverStore } from "../../state/driverStore";
import { pushErrorToast, useToastStore } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import { dbCopyShareLinkWithPassword, dbHasPassword } from "../../lib/tauri/dbCommands";
import { clipboardReadText } from "../../lib/tauri/commands";
import { writeClipboardText } from "../../lib/clipboard";
import { connectionDriverId, driverEngineInfo, effectiveDriver } from "../../lib/db/drivers";
import { decodeShareLink, encodeShareLink, importedConfig, sharePayload } from "../../lib/db/connectionShare";
import type { DbConnectionConfig, DbConnectionRow } from "../../types/database";

/**
 * Sending a connection to someone, and receiving one — see `lib/db/connectionShare` for the link.
 *
 * Both open from the database explorer (through `DatabaseView`) and from inside the connection
 * dialog, where they sit over it (`raised`) and the dialog holds its Escape while they are up.
 */

/** A row for `describeConnection` to read, for a config that has not been saved as one yet. */
function previewRow(config: DbConnectionConfig): DbConnectionRow {
  return {
    id: "",
    workspace_id: "",
    name: "",
    group_name: UNGROUPED,
    kind: config.kind,
    spec: JSON.stringify(config),
    color: "",
    sort_order: 0,
    created_at: "",
    updated_at: "",
    scope: "workspace",
  };
}

/** The connection as one card: its driver's mark, its name and where it points. */
function ConnectionCard({ name, config }: { name: string; config: DbConnectionConfig }) {
  const settings = useDriverStore((s) => s.settings);
  const driver = effectiveDriver(connectionDriverId(config), settings);
  return (
    <div className="flex items-center gap-3 rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface)] px-3 py-2.5">
      <DriverGlyph driver={driver} kind={config.kind} size={22} />
      <div className="min-w-0">
        <div className="truncate text-[13px] font-medium text-[var(--cf-text)]">{name}</div>
        <div className="truncate text-[11.5px] text-[var(--cf-text-muted)]">
          {describeConnection(previewRow(config))}
        </div>
      </div>
    </div>
  );
}

function Notice({ tone, children }: { tone: "warn" | "info"; children: React.ReactNode }) {
  const Icon = tone === "warn" ? TriangleAlert : KeyRound;
  return (
    <div
      className={`flex items-start gap-2 rounded-md px-2.5 py-2 text-[11.5px] leading-snug ${
        tone === "warn"
          ? "bg-[color-mix(in_oklab,var(--cf-warning)_14%,transparent)] text-[var(--cf-text)]"
          : "bg-[var(--cf-hover)] text-[var(--cf-text-muted)]"
      }`}
    >
      <Icon size={13} className={`mt-px shrink-0 ${tone === "warn" ? "text-[var(--cf-warning)]" : ""}`} />
      <span>{children}</span>
    </div>
  );
}

export function ShareConnectionDialog({
  row,
  unsaved = false,
  raised = false,
  onClose,
}: {
  row: DbConnectionRow;
  /** The connection dialog holds edits that aren't saved: the link carries the saved version. */
  unsaved?: boolean;
  raised?: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const config = useMemo(() => parseSpec(row), [row]);
  /** `null` while the keychain is being asked. */
  const [hasPassword, setHasPassword] = useState<boolean | null>(null);
  const [includePassword, setIncludePassword] = useState(false);
  const [copying, setCopying] = useState(false);

  useEffect(() => {
    void dbHasPassword(row.id)
      .then(setHasPassword)
      .catch(() => setHasPassword(false));
  }, [row.id]);

  const copy = async () => {
    if (!config) return;
    const payload = sharePayload(row.name, config);
    const toast = useToastStore.getState().pushToast;
    setCopying(true);
    try {
      if (includePassword) {
        await dbCopyShareLinkWithPassword(row.id, payload);
        toast(t("db.share.copiedWithPassword"), "success");
      } else {
        await writeClipboardText(encodeShareLink(payload));
        toast(t("db.share.copied"), "success");
      }
      onClose();
    } catch (error) {
      pushErrorToast(t("db.share.failed", { error: String(error) }));
    } finally {
      setCopying(false);
    }
  };

  return (
    <ApiModal
      icon={Share2}
      title={t("db.share.title")}
      width="max-w-md"
      raised={raised}
      busy={copying}
      onClose={onClose}
      footer={
        <div className="flex w-full items-center justify-end gap-2">
          <GhostButton onClick={onClose}>{t("common.cancel")}</GhostButton>
          <button
            onClick={() => void copy()}
            disabled={copying || !config || hasPassword === null}
            className={buttonClass({ variant: "primary" })}
          >
            {copying ? <Loader2 size={12} className="animate-spin" /> : <Link2 size={12} />}
            {t("db.share.copy")}
          </button>
        </div>
      }
    >
      <div className="space-y-3 p-4">
        <p className="text-[12px] leading-snug text-[var(--cf-text-muted)]">{t("db.share.hint")}</p>
        {config && <ConnectionCard name={row.name} config={config} />}

        <label
          className={`flex items-start gap-2.5 rounded-md px-1 py-1 ${
            hasPassword ? "cursor-pointer" : "cursor-default opacity-60"
          }`}
        >
          <Checkbox
            checked={includePassword}
            onChange={(checked) => setIncludePassword(checked)}
            disabled={!hasPassword}
          />
          <span className="min-w-0">
            <span className="block text-[12.5px] text-[var(--cf-text)]">{t("db.share.includePassword")}</span>
            <span className="block text-[11.5px] text-[var(--cf-text-muted)]">
              {hasPassword === false ? t("db.share.noStoredPassword") : t("db.share.includePasswordHint")}
            </span>
          </span>
        </label>

        {includePassword && <Notice tone="warn">{t("db.share.passwordWarning")}</Notice>}
        {unsaved && <Notice tone="info">{t("db.share.unsaved")}</Notice>}
      </div>
    </ApiModal>
  );
}

export function ImportConnectionDialog({
  initialText = "",
  group = UNGROUPED,
  raised = false,
  onImported,
  onClose,
}: {
  initialText?: string;
  group?: string;
  raised?: boolean;
  /** The new connection's id, once it is saved. */
  onImported?: (id: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [text, setText] = useState(initialText);
  const [fromClipboard, setFromClipboard] = useState(false);
  const [name, setName] = useState("");
  const [importing, setImporting] = useState(false);
  const settings = useDriverStore((s) => s.settings);

  // A link already on the clipboard fills the box by itself — that is where the person who was
  // sent one has it. Read natively: WebKit's own read would pop a "Paste" bubble over the dialog.
  useEffect(() => {
    if (initialText) return;
    void clipboardReadText()
      .then((clip) => {
        if (decodeShareLink(clip)) {
          setText((current) => (current ? current : clip));
          setFromClipboard(true);
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const shared = useMemo(() => decodeShareLink(text), [text]);
  const config = useMemo(() => (shared ? importedConfig(shared) : null), [shared]);
  useEffect(() => setName(shared?.name ?? ""), [shared?.name]);

  const driverId = config ? connectionDriverId(config) : "";
  const driver = config ? effectiveDriver(driverId, settings) : null;
  const label = config ? driverEngineInfo(driver, config.kind).label : "";

  const save = async () => {
    if (!shared || !config) return;
    setImporting(true);
    try {
      const store = useDbStore.getState();
      const finalName = name.trim() || shared.name.trim() || label;
      const row = await store.createConnection(config.kind, finalName, group);
      if (!row) return;
      const ok = await store.saveConnection(row, { ...config, id: row.id }, shared.password ?? null);
      if (!ok) return;
      useToastStore.getState().pushToast(t("db.share.imported", { name: finalName }), "success");
      onImported?.(row.id);
      onClose();
    } finally {
      setImporting(false);
    }
  };

  return (
    <ApiModal
      icon={ClipboardPaste}
      title={t("db.share.importTitle")}
      width="max-w-md"
      raised={raised}
      busy={importing}
      dismissOnBackdrop={false}
      onClose={onClose}
      footer={
        <div className="flex w-full items-center justify-end gap-2">
          <GhostButton onClick={onClose}>{t("common.cancel")}</GhostButton>
          <button
            onClick={() => void save()}
            disabled={importing || !config}
            className={buttonClass({ variant: "primary" })}
          >
            {importing && <Loader2 size={12} className="animate-spin" />}
            {t("db.share.import")}
          </button>
        </div>
      }
    >
      <div className="space-y-3 p-4">
        <Row
          label={t("db.share.linkLabel")}
          hint={fromClipboard && shared ? t("db.share.fromClipboard") : undefined}
        >
          <textarea
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setFromClipboard(false);
            }}
            autoFocus
            rows={3}
            spellCheck={false}
            placeholder="codeflow://connection?d=…"
            className={`${INPUT} resize-none break-all font-mono text-[11.5px]`}
          />
        </Row>

        {text.trim() !== "" && !shared && <Notice tone="warn">{t("db.share.invalid")}</Notice>}

        {shared && config && (
          <>
            <ConnectionCard name={name.trim() || shared.name} config={config} />
            <Row label={t("db.name")}>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={shared.name || label}
                className={INPUT}
              />
            </Row>
            <Notice tone="info">
              {shared.password ? t("db.share.carriesPassword") : t("db.share.noPassword")}
            </Notice>
            {!driver && <Notice tone="warn">{t("db.share.unknownDriver", { driver: driverId })}</Notice>}
            {config.startup_script.trim() !== "" && (
              <Notice tone="warn">{t("db.share.startupScript")}</Notice>
            )}
          </>
        )}
      </div>
    </ApiModal>
  );
}
