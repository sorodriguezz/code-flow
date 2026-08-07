import { useEffect, useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Copy,
  Database,
  FolderOpen,
  Link2,
  Loader2,
  Minus,
  Plug,
  Plus,
  RefreshCw,
  Search,
  Server,
  SlidersHorizontal,
  Trash2,
  XCircle,
} from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { ApiModal, GhostButton } from "../api/ApiModal";
import { Checkbox } from "../common/Checkbox";
import { EmptyState } from "../common/EmptyState";
import { Select, type SelectItems } from "../common/Select";
import { EngineGlyph } from "./dbChrome";
import { EngineMenu, menuAnchor } from "./EngineMenu";
import { UNGROUPED, parseSpec, redactUrl, useDbStore } from "../../state/dbStore";
import { dbHasPassword, dbSchemaCatalog } from "../../lib/tauri/dbCommands";
import { confirmAction } from "../../state/confirmStore";
import { useT } from "../../state/languageStore";
import type { TranslationKey } from "../../lib/i18n/translations";
import {
  DB_ENGINES,
  defaultConnectionConfig,
  engineInfo,
  type DbAuthMethod,
  type DbConnectionConfig,
  type DbConnectionRow,
  type DbKind,
  type DbSchemaGroup,
  type DbServerInfo,
  type DbSslMode,
} from "../../types/database";

/**
 * The connection dialog: every saved connection down the left, the selected one's settings on the
 * right.
 *
 * It used to be a single-connection sheet, opened once per connection from the tree. That is the
 * wrong shape for the job it is actually asked to do — "set up my databases" is a session, not one
 * edit, and doing it a sheet at a time meant closing and reopening the dialog to copy a host from
 * one connection to the next. The list makes the set the subject, which is also what makes the
 * dialog worth opening from the workspace itself and not only from a connection's own menu.
 *
 * What it is careful about, beyond the layout:
 *
 * **The engine is chosen before this opens.** It decides what every field below it means — the
 * default port, the word for "database", the shape of the URL — so it is asked by the menu the `+`
 * expands (see `EngineMenu`) and the dialog opens already dressed for the answer. The picker stays
 * on the General tab, because changing your mind about an existing connection is a real edit.
 *
 * **Fields or URL, never both.** They are alternatives — a pasted URI overrides every field — so
 * they are a two-mode switch rather than two sections where one silently wins. The old version
 * dimmed the fields when a URL was present, which left the user reading greyed-out boxes to work out
 * which half was live.
 *
 * **The password.** A saved one is never read back — there is no command that returns it — so the
 * box shows a "saved" placeholder and stays empty. Leaving it empty on save keeps whatever is in the
 * keychain; typing replaces it; the trash button removes it. That is the only model that doesn't
 * either lie about what is stored or make the user re-type a credential to change a port.
 *
 * **Unsaved edits are guarded on the way *out of a connection*, not on the way out of the dialog.**
 * Cancel and Escape discard, as they always have — that is what the words mean. But clicking another
 * connection in the list is not a discard, so that one asks.
 */

/** Shared with `Field` in `ApiModal`, so a local input styled here can't drift from the rest. */
const INPUT =
  "w-full rounded-md border border-[var(--cf-border)] bg-transparent px-2 py-1.5 text-[12px] text-[var(--cf-text)] outline-none transition-colors placeholder:text-[var(--cf-text-muted)] focus:border-[var(--cf-accent)] disabled:opacity-50";

type Mode = "fields" | "url";
type Tab = "general" | "options" | "ssh" | "schemas" | "advanced";

/** The three states the right-hand pane loads from an entry in the list. */
function editorState(row: DbConnectionRow | null, engine: DbKind | null) {
  const spec = row ? parseSpec(row) : null;
  return {
    name: row?.name ?? "",
    config: spec ?? defaultConnectionConfig(engine ?? "postgres"),
    // Opens on whichever half is actually in use, so editing a URL-based connection doesn't start
    // on a form of empty fields that aren't being used.
    mode: (spec?.url ? "url" : "fields") as Mode,
  };
}

/**
 * Whether two configs would connect to the same place.
 *
 * Field by field rather than a `JSON.stringify` comparison: one side comes from a form and the other
 * from `JSON.parse`, and their key order is only incidentally the same — a stringify would call a
 * connection dirty because its spec was written by an older build.
 */
function sameConfig(a: DbConnectionConfig, b: DbConnectionConfig) {
  return (
    a.kind === b.kind &&
    a.host === b.host &&
    a.port === b.port &&
    a.database === b.database &&
    a.user === b.user &&
    a.url === b.url &&
    a.ssl === b.ssl &&
    a.read_only === b.read_only &&
    a.connect_timeout_ms === b.connect_timeout_ms &&
    a.show_all_databases === b.show_all_databases &&
    a.object_filter === b.object_filter &&
    a.keep_alive_secs === b.keep_alive_secs &&
    a.auto_disconnect_secs === b.auto_disconnect_secs &&
    a.startup_script === b.startup_script &&
    a.ssl_ca_file === b.ssl_ca_file &&
    a.ssl_cert_file === b.ssl_cert_file &&
    a.ssl_key_file === b.ssl_key_file &&
    a.ssh_enabled === b.ssh_enabled &&
    a.ssh_host === b.ssh_host &&
    a.ssh_port === b.ssh_port &&
    a.ssh_user === b.ssh_user &&
    a.ssh_key_file === b.ssh_key_file &&
    a.auth_method === b.auth_method &&
    a.tenant_id === b.tenant_id &&
    a.schemas_filtered === b.schemas_filtered &&
    a.visible_schemas.length === b.visible_schemas.length &&
    a.visible_schemas.every((name, i) => b.visible_schemas[i] === name) &&
    a.options.length === b.options.length &&
    a.options.every(([key, value], i) => b.options[i]?.[0] === key && b.options[i]?.[1] === value)
  );
}

export function ConnectionModal({
  connectionId,
  newEngine,
  newGroup = "",
  onClose,
}: {
  /** The connection to open on. Ignored when `newEngine` is set. */
  connectionId: string | null;
  /** Set when the dialog was opened to create a connection, holding the engine already chosen. */
  newEngine: DbKind | null;
  /** Which folder a connection created here lands in — set when the dialog was opened from a
   * group's own menu. Empty is ungrouped, which is where every other entry point puts one. */
  newGroup?: string;
  onClose: () => void;
}) {
  const t = useT();
  const connections = useDbStore((s) => s.connections);
  const store = useDbStore.getState();

  /** The row being edited. `null` means the draft — the unsaved new connection, when one exists. */
  const [selected, setSelected] = useState<string | null>(
    newEngine ? null : connectionId ?? connections[0]?.id ?? null,
  );
  /** Non-null while an unsaved new connection sits at the bottom of the list. */
  const [draftEngine, setDraftEngine] = useState<DbKind | null>(newEngine);
  const [engineMenu, setEngineMenu] = useState<{ x: number; y: number } | null>(null);

  const first = useMemo(
    () => editorState(connections.find((c) => c.id === selected) ?? null, draftEngine),
    // Once, for the initial selection. Every later load goes through `load`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const [name, setName] = useState(first.name);
  const [config, setConfig] = useState<DbConnectionConfig>(first.config);
  const [mode, setMode] = useState<Mode>(first.mode);
  const [tab, setTab] = useState<Tab>("general");
  const [password, setPassword] = useState("");
  /** Whether the keychain already holds one. Decides the placeholder and whether "clear" is shown. */
  const [hasStored, setHasStored] = useState(false);
  const [passwordTouched, setPasswordTouched] = useState(false);
  const [testing, setTesting] = useState(false);
  const [outcome, setOutcome] = useState<
    { ok: true; info: DbServerInfo } | { ok: false; error: string } | null
  >(null);
  const [saving, setSaving] = useState(false);

  const engine = engineInfo(config.kind);
  const row = connections.find((c) => c.id === selected) ?? null;
  const savedSpec = row ? parseSpec(row) : null;

  useEffect(() => {
    if (!selected) return;
    void dbHasPassword(selected)
      .then(setHasStored)
      .catch(() => setHasStored(false));
    // Only for the connection the dialog opened on; `load` handles every later selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const patch = (partial: Partial<DbConnectionConfig>) => {
    setConfig((current) => ({ ...current, ...partial }));
    setOutcome(null);
  };

  /** Switching engine keeps what is engine-independent — a host and user typed before the switch. */
  const setKind = (kind: DbKind) => {
    const defaults = defaultConnectionConfig(kind);
    setConfig((current) => ({
      ...defaults,
      id: current.id,
      host: current.host,
      user: current.user || defaults.user,
      url: current.url,
      options: current.options,
      read_only: current.read_only,
      show_all_databases: current.show_all_databases,
      // How you reach the host and how long you hold it are true of the network and the machine,
      // not of the engine listening on it — a tunnel to a bastion survives realising you meant
      // MySQL rather than Postgres.
      keep_alive_secs: current.keep_alive_secs,
      auto_disconnect_secs: current.auto_disconnect_secs,
      ssl_ca_file: current.ssl_ca_file,
      ssl_cert_file: current.ssl_cert_file,
      ssl_key_file: current.ssl_key_file,
      ssh_enabled: current.ssh_enabled,
      ssh_host: current.ssh_host,
      ssh_port: current.ssh_port,
      ssh_user: current.ssh_user,
      ssh_key_file: current.ssh_key_file,
      // A port typed explicitly is kept; the engine's default (0) follows the new engine.
      port: current.port,
      database: current.database || defaults.database,
    }));
    setOutcome(null);
  };

  /**
   * The name to save when the box is left empty.
   *
   * `user@host/database` rather than the engine's name: a workspace with three Postgres connections
   * called "PostgreSQL", "PostgreSQL copy" and "PostgreSQL copy copy" is the outcome of defaulting to
   * the engine, and this is the one piece of information that tells them apart.
   */
  const derivedName = useMemo(() => {
    if (mode === "url" && config.url.trim()) {
      try {
        const url = new URL(config.url.trim().replace(/^jdbc:/, ""));
        return url.hostname || engine.label;
      } catch {
        return engine.label;
      }
    }
    const host = config.host.trim() || "localhost";
    const where = config.database.trim() ? `${host}/${config.database.trim()}` : host;
    return config.user.trim() ? `${config.user.trim()}@${where}` : where;
  }, [mode, config.url, config.host, config.database, config.user, engine.label]);

  /** What a connect will actually address, once defaults are filled in. */
  const target = useMemo(() => {
    // Named first, because a tunnel changes what "reachable" means: the host below is resolved on
    // the far side of it, and a name that only exists inside that network is then correct rather
    // than a typo.
    const via = config.ssh_enabled
      ? ` ${t("db.viaTunnel", { host: config.ssh_host.trim() || "ssh" })}`
      : "";
    if (mode === "url" && config.url.trim()) return `${redactUrl(config.url.trim())}${via}`;
    const port = config.port || engine.defaultPort;
    const where = `${config.host || "localhost"}:${port}`;
    const path = config.database ? `/${config.database}` : "";
    // IRIS is addressed by a JDBC URL, and showing it in full is what makes a connection still
    // pointed at the old REST port (52773) obvious before it is saved rather than after it fails.
    if (config.kind === "iris") return `jdbc:IRIS://${where}${path}${via}`;
    return `${where}${path}${via}`;
  }, [mode, config, engine.defaultPort, t]);

  /** What `save` would write, which is what "has this changed?" has to be asked about. */
  const pending = useMemo(
    () => ({ ...config, url: mode === "url" ? config.url : "" }),
    [config, mode],
  );

  const dirty = useMemo(() => {
    if (passwordTouched) return true;
    // A draft counts as dirty once it stops being the blank form its engine came with — so
    // clicking away from one you opened by accident doesn't ask about nothing.
    if (!row || !savedSpec) {
      return name.trim() !== "" || !sameConfig(pending, defaultConnectionConfig(config.kind));
    }
    return name.trim() !== row.name || !sameConfig(pending, savedSpec);
  }, [passwordTouched, row, savedSpec, name, pending, config.kind]);

  /** Points the right-hand pane at another entry, discarding whatever the old one held. */
  const load = (id: string | null, engineForDraft: DbKind | null) => {
    const next = editorState(connections.find((c) => c.id === id) ?? null, engineForDraft);
    setSelected(id);
    setDraftEngine(engineForDraft);
    setName(next.name);
    setConfig(next.config);
    setMode(next.mode);
    setPassword("");
    setPasswordTouched(false);
    setOutcome(null);
    setHasStored(false);
    if (id) {
      void dbHasPassword(id)
        .then(setHasStored)
        .catch(() => setHasStored(false));
    }
  };

  /** `load`, but it asks first when the pane holds work that isn't saved anywhere. */
  const select = async (id: string | null, engineForDraft: DbKind | null) => {
    if (id === selected && engineForDraft === draftEngine) return;
    if (dirty && !(await confirmAction(t("db.discardConnectionChanges")))) return;
    load(id, engineForDraft);
  };

  const test = async () => {
    setTesting(true);
    setOutcome(null);
    try {
      const info = await store.testConnection({
        ...config,
        id: selected ?? "",
        // The typed password wins; an untouched box means "use what's in the keychain", which the
        // backend resolves from the id.
        password: passwordTouched ? password : "",
        // The inactive half must not leak into the attempt: testing has to try exactly what the
        // dialog is showing.
        url: mode === "url" ? config.url : "",
      });
      setOutcome({ ok: true, info });
    } catch (e) {
      setOutcome({ ok: false, error: String(e) });
    } finally {
      setTesting(false);
    }
  };

  /** Writes the pane to the store. Returns the connection's id, or null when nothing was written. */
  const save = async (): Promise<string | null> => {
    setSaving(true);
    try {
      const finalName = name.trim() || derivedName;
      let saved = row;
      if (!saved) {
        saved = await store.createConnection(config.kind, finalName, newGroup);
        if (!saved) return null;
      }
      const ok = await store.saveConnection(
        { ...saved, name: finalName },
        { ...pending, id: saved.id, password: "" },
        // `null` means "leave the keychain alone" — which is what an untouched box means.
        passwordTouched ? password : null,
      );
      return ok ? saved.id : null;
    } finally {
      setSaving(false);
    }
  };

  /** Save and stay, so a session of edits doesn't cost a reopen per connection. */
  const apply = async () => {
    const id = await save();
    if (!id) return;
    setSelected(id);
    setDraftEngine(null);
    setName(name.trim() || derivedName);
    // The typed password is in the keychain now, so the box goes back to showing that.
    setPassword("");
    setPasswordTouched(false);
    void dbHasPassword(id)
      .then(setHasStored)
      .catch(() => setHasStored(false));
  };

  const saveAndClose = async () => {
    if (await save()) onClose();
  };

  /**
   * Clones the selected connection and lands on the copy.
   *
   * The copy carries the settings and not the password — the keychain entry belongs to the
   * connection that earned it, and a duplicate that silently inherited a credential would be a way
   * to hand production's password to a connection named "staging".
   */
  const clone = async () => {
    if (!row) return;
    if (dirty && !(await confirmAction(t("db.discardConnectionChanges")))) return;
    const copy = await store.duplicateConnection(row.id);
    if (copy) load(copy.id, null);
  };

  /** `−`: drops the draft, or deletes the saved connection after asking. */
  const remove = async () => {
    if (!row) {
      if (draftEngine === null) return;
      if (dirty && !(await confirmAction(t("db.discardConnectionChanges")))) return;
      load(connections[0]?.id ?? null, null);
      return;
    }
    if (!(await confirmAction(t("db.deleteConfirm", { name: row.name })))) return;
    await store.deleteConnection(row.id);
    load(connections.find((c) => c.id !== row.id)?.id ?? null, null);
  };

  const sslOptions = useMemo(
    () => [
      { value: "disable", label: t("db.ssl.disable") },
      { value: "require", label: t("db.ssl.require") },
      { value: "verify_full", label: t("db.ssl.verify") },
    ],
    [t],
  );

  const nothingSelected = !row && draftEngine === null;

  return (
    <ApiModal
      icon={Database}
      title={t("db.dataSources")}
      subtitle={nothingSelected ? undefined : engine.label}
      width="max-w-4xl"
      height="h-[78vh]"
      busy={saving}
      // A dozen fields and a password, none of it drafted anywhere: a click on the backdrop must not
      // be what throws it away. Close, Cancel and Escape stay.
      dismissOnBackdrop={false}
      onClose={onClose}
      footer={
        <div className="flex w-full items-center gap-2">
          <GhostButton onClick={() => void test()} disabled={testing || nothingSelected}>
            {testing ? <Loader2 size={12} className="animate-spin" /> : <Plug size={12} />}
            {t("db.testConnection")}
          </GhostButton>
          <div className="ml-auto flex items-center gap-2">
            <GhostButton onClick={onClose}>{t("common.cancel")}</GhostButton>
            <GhostButton onClick={() => void apply()} disabled={saving || nothingSelected || !dirty}>
              {t("db.apply")}
            </GhostButton>
            <button
              onClick={() => void saveAndClose()}
              disabled={saving || nothingSelected}
              className="rounded-md bg-[var(--cf-accent)] px-3 py-1.5 text-[12px] font-medium text-white hover:brightness-110 disabled:opacity-50"
            >
              {t("common.save")}
            </button>
          </div>
        </div>
      }
    >
      <div className="flex min-h-0 flex-1">
        {/* The set of connections, which is what makes this a dialog about the workspace's
            databases rather than about one of them. */}
        <aside className="flex w-56 shrink-0 flex-col border-r border-[var(--cf-border)]">
          <div className="flex shrink-0 items-center gap-0.5 border-b border-[var(--cf-border)] px-2 py-1.5">
            <span className="mr-auto truncate text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
              {t("db.connectionsHeading")}
            </span>
            <IconButton
              onClick={(e) => setEngineMenu(menuAnchor(e))}
              title={t("db.newConnection")}
            >
              <Plus size={13} />
            </IconButton>
            <IconButton onClick={() => void remove()} title={t("db.removeConnection")}>
              <Minus size={13} />
            </IconButton>
            <IconButton onClick={() => void clone()} title={t("db.duplicate")}>
              <Copy size={12} />
            </IconButton>
            {/* Ordering lives here rather than on the sidebar's own header: the order of the estate
                is something you set once while arranging it, not something the panel you browse
                databases from needs a permanent pair of buttons for. Arranging it is what this
                dialog is. The tree keeps the two ways that are about *one* row — its context menu
                and `Alt`+arrows — which is where a single nudge belongs. */}
            <IconButton
              onClick={() => selected && void store.moveConnection(selected, -1)}
              disabled={!store.canMoveConnection(selected, -1)}
              title={t("db.moveUp")}
            >
              <ArrowUp size={13} />
            </IconButton>
            <IconButton
              onClick={() => selected && void store.moveConnection(selected, 1)}
              disabled={!store.canMoveConnection(selected, 1)}
              title={t("db.moveDown")}
            >
              <ArrowDown size={13} />
            </IconButton>
          </div>

          <div className="min-h-0 flex-1 overflow-auto p-1">
            {connections.map((entry) => (
              <ConnectionRow
                key={entry.id}
                glyph={<EngineGlyph kind={entry.kind} />}
                name={entry.name}
                // The folder rides the host line, and only when there is one. This list is flat
                // while the tree is not, and moving is *within a folder* — so without naming it, a
                // connection stepping over a neighbour that happens to be filed elsewhere reads as
                // the arrows skipping a row.
                detail={[parseSpec(entry)?.host ?? "", entry.group_name.trim()]
                  .filter((part) => part !== UNGROUPED)
                  .join(" · ")}
                active={entry.id === selected}
                onClick={() => void select(entry.id, null)}
              />
            ))}
            {draftEngine !== null && (
              <ConnectionRow
                glyph={<EngineGlyph kind={draftEngine} />}
                name={name.trim() || derivedName}
                detail={t("db.draftConnection")}
                active={selected === null}
                onClick={() => void select(null, draftEngine)}
              />
            )}
          </div>
        </aside>

        {nothingSelected ? (
          <div className="min-h-0 flex-1">
            <EmptyState
              icon={Database}
              title={t("db.noConnections")}
              subtitle={t("db.noConnectionsHint")}
            />
          </div>
        ) : (
          // `min-w-0` for the same reason the panel needs it: the pane holds the pasted URL and the
          // target line, and without it their width becomes the pane's floor.
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {/* Name and engine sit above the tabs: both are true of the connection whichever tab is
                open, and burying the engine in one of them would hide what the other one means. */}
            <div className="shrink-0 border-b border-[var(--cf-border)] px-4 py-3">
              <div className="grid grid-cols-[1fr_180px] gap-3">
                <Row label={t("db.name")}>
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={derivedName}
                    className={INPUT}
                  />
                </Row>
                <Row label={t("db.engine")}>
                  <EnginePicker active={config.kind} onSelect={setKind} />
                </Row>
              </div>
            </div>

            <div className="flex shrink-0 gap-0.5 border-b border-[var(--cf-border)] px-2 pt-1.5">
              {(
                [
                  { id: "general", label: t("db.tab.general") },
                  { id: "options", label: t("db.tab.options") },
                  { id: "ssh", label: t("db.tab.ssh") },
                  { id: "schemas", label: t("db.tab.schemas") },
                  { id: "advanced", label: t("db.advanced") },
                ] as { id: Tab; label: string }[]
              ).map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => setTab(entry.id)}
                  aria-selected={tab === entry.id}
                  className={`-mb-px border-b-2 px-2.5 py-1.5 text-[12px] font-medium transition-colors ${
                    tab === entry.id
                      ? "border-[var(--cf-accent)] text-[var(--cf-text)]"
                      : "border-transparent text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
                  }`}
                >
                  {entry.label}
                </button>
              ))}
            </div>

            <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4">
              {tab === "general" ? (
                <>
                  {/* Fields or URL — alternatives, so only one is on screen. */}
                  <div>
                    <ModeSwitch
                      mode={mode}
                      onChange={(next) => {
                        setMode(next);
                        setOutcome(null);
                      }}
                    />

                    {mode === "url" ? (
                      <div className="mt-2">
                        <input
                          value={config.url}
                          onChange={(e) => patch({ url: e.target.value })}
                          placeholder={engine.urlPlaceholder}
                          spellCheck={false}
                          autoComplete="off"
                          className={`${INPUT} font-mono`}
                        />
                        <p className="mt-1 text-[11px] text-[var(--cf-text-muted)]">
                          {t("db.urlOverrides")}
                        </p>
                      </div>
                    ) : (
                      <div className="mt-2 space-y-2.5">
                        <div className="grid grid-cols-[1fr_104px] gap-2">
                          <Row label={t("db.host")}>
                            <input
                              value={config.host}
                              onChange={(e) => patch({ host: e.target.value })}
                              spellCheck={false}
                              autoComplete="off"
                              className={INPUT}
                            />
                          </Row>
                          <Row label={t("db.port")}>
                            <NumberInput
                              value={config.port}
                              onChange={(port) => patch({ port })}
                              placeholder={String(engine.defaultPort)}
                            />
                          </Row>
                        </div>

                        <div className="grid grid-cols-2 gap-2">
                          <Row label={engine.databaseLabel}>
                            <input
                              value={config.database}
                              onChange={(e) => patch({ database: e.target.value })}
                              placeholder={engine.databaseLabel}
                              spellCheck={false}
                              autoComplete="off"
                              className={INPUT}
                            />
                          </Row>
                          {/* Under a service principal this box is the application (client) ID —
                              the same question, so the same field rather than a second one that
                              would have to be kept in step with it. */}
                          <Row
                            label={
                              config.auth_method === "entra_service_principal"
                                ? t("db.clientId")
                                : t("db.user")
                            }
                          >
                            <input
                              value={config.user}
                              onChange={(e) => patch({ user: e.target.value })}
                              disabled={config.auth_method === "entra_cli"}
                              placeholder={
                                config.auth_method === "entra_cli" ? t("db.userFromAzureCli") : ""
                              }
                              spellCheck={false}
                              autoComplete="off"
                              className={INPUT}
                            />
                          </Row>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Only SQL Server: it is the one engine here that takes a Microsoft Entra ID
                      token, and an Azure SQL server set to Entra-only refuses SQL logins outright —
                      so for those users this control is the difference between the engine working
                      and being unreachable. */}
                  {config.kind === "sqlserver" && (
                    <Row label={t("db.authMethod")} hint={authHint(config.auth_method, t)}>
                      <Select
                        value={config.auth_method}
                        onChange={(auth_method) => {
                          patch({ auth_method: auth_method as DbAuthMethod });
                          setOutcome(null);
                        }}
                        options={[
                          { value: "password", label: t("db.authPassword") },
                          { value: "entra_cli", label: t("db.authEntraCli") },
                          { value: "entra_service_principal", label: t("db.authEntraApp") },
                        ]}
                        size="field"
                      />
                    </Row>
                  )}

                  {config.auth_method !== "password" && (
                    <Row
                      label={t("db.tenantId")}
                      hint={
                        config.auth_method === "entra_cli"
                          ? t("db.tenantIdOptionalHint")
                          : t("db.tenantIdHint")
                      }
                    >
                      <input
                        value={config.tenant_id}
                        onChange={(e) => patch({ tenant_id: e.target.value })}
                        placeholder="00000000-0000-0000-0000-000000000000"
                        spellCheck={false}
                        autoComplete="off"
                        className={`${INPUT} font-mono`}
                      />
                    </Row>
                  )}

                  {/* The CLI path stores nothing, so there is no password box to show — the whole
                      point is that the credential stays with `az`. */}
                  {config.auth_method !== "entra_cli" && (
                  <Row
                    label={
                      config.auth_method === "entra_service_principal"
                        ? t("db.clientSecret")
                        : t("db.password")
                    }
                    hint={hasStored && !passwordTouched ? t("db.passwordStored") : t("db.passwordHint")}
                  >
                    {/* No reveal button. It could never show the saved password — that one lives in
                        the OS keychain and is never read back into this dialog; the field holds
                        either nothing or what you are typing right now. So the eye offered to
                        uncover a row of dots that stood for a value the app deliberately does not
                        have, and on a connection you had just opened it did nothing at all. */}
                    <div className="relative flex items-center">
                      <input
                        type="password"
                        value={password}
                        onChange={(e) => {
                          setPassword(e.target.value);
                          setPasswordTouched(true);
                          setOutcome(null);
                        }}
                        placeholder={hasStored && !passwordTouched ? "••••••••" : ""}
                        autoComplete="new-password"
                        className={`${INPUT} ${hasStored ? "pr-8" : ""}`}
                      />
                      {hasStored && (
                        <div className="absolute right-1.5 flex items-center">
                          <IconButton
                            onClick={() => {
                              setPassword("");
                              setPasswordTouched(true);
                            }}
                            title={t("db.clearPassword")}
                          >
                            <Trash2 size={12} />
                          </IconButton>
                        </div>
                      )}
                    </div>
                  </Row>
                  )}
                </>
              ) : tab === "options" ? (
                <>
                  <Toggle
                    checked={config.read_only}
                    onChange={(read_only) => patch({ read_only })}
                    label={t("db.readOnly")}
                    hint={t("db.readOnlyHint")}
                  />
                  <Toggle
                    checked={config.show_all_databases}
                    onChange={(show_all_databases) => patch({ show_all_databases })}
                    label={t("db.showAllDatabases")}
                    hint={t("db.showAllDatabasesHint")}
                  />

                  <div className="grid grid-cols-3 gap-2">
                    <Row label={t("db.timeout")}>
                      <NumberInput
                        value={config.connect_timeout_ms}
                        onChange={(connect_timeout_ms) => patch({ connect_timeout_ms })}
                        placeholder="15000"
                      />
                    </Row>
                    <Row label={t("db.keepAlive")}>
                      <NumberInput
                        value={config.keep_alive_secs}
                        onChange={(keep_alive_secs) => patch({ keep_alive_secs })}
                        placeholder={t("db.off")}
                      />
                    </Row>
                    <Row label={t("db.autoDisconnect")}>
                      <NumberInput
                        value={config.auto_disconnect_secs}
                        onChange={(auto_disconnect_secs) => patch({ auto_disconnect_secs })}
                        placeholder={t("db.off")}
                      />
                    </Row>
                  </div>
                  <p className="text-[11px] leading-snug text-[var(--cf-text-muted)]">
                    {t("db.sessionTimersHint")}
                  </p>

                  <Row label={t("db.startupScript")} hint={t("db.startupScriptHint")}>
                    <textarea
                      value={config.startup_script}
                      onChange={(e) => patch({ startup_script: e.target.value })}
                      rows={4}
                      spellCheck={false}
                      placeholder={startupScriptExample(config.kind)}
                      className={`${INPUT} resize-y font-mono`}
                    />
                  </Row>
                </>
              ) : tab === "ssh" ? (
                <>
                  <Toggle
                    checked={config.ssh_enabled}
                    onChange={(ssh_enabled) => patch({ ssh_enabled })}
                    label={t("db.sshTunnel")}
                    hint={t("db.sshTunnelHint")}
                  />
                  {/* Said here rather than only at connect time: a URL names the host to reach
                      directly, which is the one thing a tunnel exists to avoid. */}
                  {config.ssh_enabled && mode === "url" && (
                    <p className="rounded-md border border-[var(--cf-warning)]/40 bg-[var(--cf-warning)]/[0.07] p-2.5 text-[11px] leading-snug text-[var(--cf-text)]">
                      {t("db.sshNeedsFields")}
                    </p>
                  )}
                  {config.ssh_enabled && (
                    <div className="space-y-2.5 border-l-2 border-[var(--cf-border)] pl-3">
                      <div className="grid grid-cols-[1fr_104px] gap-2">
                        <Row label={t("db.sshHost")}>
                          <input
                            value={config.ssh_host}
                            onChange={(e) => patch({ ssh_host: e.target.value })}
                            placeholder="bastion.example.com"
                            spellCheck={false}
                            autoComplete="off"
                            className={INPUT}
                          />
                        </Row>
                        <Row label={t("db.port")}>
                          <NumberInput
                            value={config.ssh_port}
                            onChange={(ssh_port) => patch({ ssh_port })}
                            placeholder="22"
                          />
                        </Row>
                      </div>
                      <Row label={t("db.user")} hint={t("db.sshUserHint")}>
                        <input
                          value={config.ssh_user}
                          onChange={(e) => patch({ ssh_user: e.target.value })}
                          spellCheck={false}
                          autoComplete="off"
                          className={INPUT}
                        />
                      </Row>
                      <FileRow
                        label={t("db.sshKey")}
                        hint={t("db.sshKeyHint")}
                        value={config.ssh_key_file}
                        onChange={(ssh_key_file) => patch({ ssh_key_file })}
                      />
                    </div>
                  )}

                  <div className="border-t border-[var(--cf-border)] pt-3">
                    <Row label={t("db.ssl.label")}>
                      <Select
                        value={config.ssl}
                        options={sslOptions}
                        onChange={(ssl) => patch({ ssl: ssl as DbSslMode })}
                        size="field"
                      />
                    </Row>
                  </div>
                  {config.ssl !== "disable" && (
                    <div className="space-y-2.5 border-l-2 border-[var(--cf-border)] pl-3">
                      <FileRow
                        label={t("db.sslCa")}
                        hint={t("db.sslCaHint")}
                        value={config.ssl_ca_file}
                        onChange={(ssl_ca_file) => patch({ ssl_ca_file })}
                      />
                      <FileRow
                        label={t("db.sslCert")}
                        hint={
                          config.kind === "mongodb" ? t("db.sslCertMongoHint") : t("db.sslCertHint")
                        }
                        value={config.ssl_cert_file}
                        onChange={(ssl_cert_file) => patch({ ssl_cert_file })}
                      />
                      {config.kind !== "mongodb" && (
                        <FileRow
                          label={t("db.sslKey")}
                          value={config.ssl_key_file}
                          onChange={(ssl_key_file) => patch({ ssl_key_file })}
                        />
                      )}
                      {config.kind === "iris" && (
                        <p className="text-[11px] leading-snug text-[var(--cf-warning)]">
                          {t("db.sslIrisNote")}
                        </p>
                      )}
                      {config.kind === "sqlserver" && (
                        <p className="text-[11px] leading-snug text-[var(--cf-text-muted)]">
                          {t("db.sslMssqlNote")}
                        </p>
                      )}
                    </div>
                  )}
                </>
              ) : tab === "schemas" ? (
                <SchemasTab
                  connectionId={selected}
                  visible={config.visible_schemas}
                  filtered={config.schemas_filtered}
                  objectFilter={config.object_filter}
                  onChange={patch}
                />
              ) : (
                <DriverOptions
                  options={config.options}
                  onChange={(options) => patch({ options })}
                  kind={config.kind}
                />
              )}
            </div>

            {/* Pinned under the tabs rather than inside one: what a connect will address, and how
                the last one went, are true of the connection and not of the tab you happen to be
                reading. The one line that catches a port left on the default, or a URL that quietly
                overrode the fields. */}
            <div className="shrink-0 space-y-2 border-t border-[var(--cf-border)] px-4 py-2.5">
              <p className="flex items-center gap-1.5 text-[11px] text-[var(--cf-text-muted)]">
                <Server size={11} className="shrink-0" />
                <span className="shrink-0 uppercase tracking-wide">{t("db.target")}</span>
                <span className="min-w-0 truncate font-mono text-[var(--cf-text)]">{target}</span>
              </p>

              {outcome && (
                <div
                  className={`max-h-32 overflow-auto rounded-lg border p-2.5 text-[12px] ${
                    outcome.ok
                      ? "border-[var(--cf-success)]/40 bg-[var(--cf-success)]/[0.07]"
                      : "border-[var(--cf-danger)]/40 bg-[var(--cf-danger)]/[0.07]"
                  }`}
                >
                  <p className="flex items-start gap-1.5">
                    {outcome.ok ? (
                      <CheckCircle2 size={13} className="mt-[2px] shrink-0 text-[var(--cf-success)]" />
                    ) : (
                      <XCircle size={13} className="mt-[2px] shrink-0 text-[var(--cf-danger)]" />
                    )}
                    <span className="min-w-0 break-words leading-snug text-[var(--cf-text)]">
                      {outcome.ok
                        ? [outcome.info.version, outcome.info.database, outcome.info.user]
                            .filter(Boolean)
                            .join(" · ")
                        : outcome.error}
                    </span>
                  </p>
                  {outcome.ok &&
                    outcome.info.notes.map((note) => (
                      <p
                        key={note}
                        className="mt-1.5 pl-5 text-[11px] leading-snug text-[var(--cf-text-muted)]"
                      >
                        {note}
                      </p>
                    ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {engineMenu && (
        <EngineMenu
          x={engineMenu.x}
          y={engineMenu.y}
          onPick={(kind) => void select(null, kind)}
          onClose={() => setEngineMenu(null)}
        />
      )}
    </ApiModal>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

/** A checkbox with its own label and explanation, which is the shape every switch here wants. */
function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  hint: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2">
      <Checkbox checked={checked} onChange={onChange} className="mt-[2px]" />
      <span>
        <span className="block text-[12px] text-[var(--cf-text)]">{label}</span>
        <span className="block text-[11px] leading-snug text-[var(--cf-text-muted)]">{hint}</span>
      </span>
    </label>
  );
}

/**
 * A path, with a picker beside it.
 *
 * Typed as well as picked: these files live in `~/.ssh` and `/etc/ssl`, which several platforms'
 * file dialogs hide, and a user who knows the path should not have to fight a dialog to use it.
 */
function FileRow({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const t = useT();
  const browse = async () => {
    const picked = await open({ multiple: false, directory: false });
    if (typeof picked === "string") onChange(picked);
  };
  return (
    <Row label={label} hint={hint}>
      <div className="flex items-center gap-1.5">
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          autoComplete="off"
          className={`${INPUT} font-mono`}
        />
        <GhostButton onClick={() => void browse()}>
          <FolderOpen size={12} />
          {t("db.browse")}
        </GhostButton>
        {value && (
          <IconButton onClick={() => onChange("")} title={t("db.clearFile")}>
            <Trash2 size={12} />
          </IconButton>
        )}
      </div>
    </Row>
  );
}

/** A starting point for the startup script, in the dialect the connection speaks. */
function startupScriptExample(kind: DbKind): string {
  switch (kind) {
    case "sqlserver":
      return "SET LOCK_TIMEOUT 5000;";
    case "iris":
      return "SET OPTION SUPPORT_DELIMITED_IDENTIFIERS = 1";
    case "mongodb":
      return "";
    default:
      return "SET search_path TO app, public;";
  }
}

/**
 * Which schemas the tree lists, and a name filter over what's inside them.
 *
 * A list of checkboxes with a select-all over it, because the number that matters is not two or
 * three — a warehouse has a hundred schemas and the only workable way through them is "take them
 * all, then untick the dozen I don't care about", or the reverse. So the header ticks and unticks
 * everything at once, the search box narrows what "everything" means while it is typed, and the
 * count says where you are without counting ticks.
 *
 * **Where the names come from.** The explorer's cache first, so the tab is instant and works on a
 * connection that is closed, behind a VPN or simply wrong — a tab that had to connect before it
 * could show anything would be useless in exactly the case you opened it to fix. `Load` asks the
 * server for the rest, and it has to be its own call (`dbSchemaCatalog`) rather than a tree
 * expansion: expanding applies the filter being edited, so a schema unticked once would never come
 * back. A name still missing can be typed — which is also how you pre-filter a connection you have
 * never opened.
 *
 * **Nothing ticked means everything shows.** That is the rule the backend applies, and the one that
 * makes the feature safe to discover: unticking your way to an empty tree takes a deliberate act,
 * and unticking everything undoes it rather than hiding the server.
 *
 * The selection is a set of names, matched case-insensitively against every database — the same
 * comparison the backend makes. It is not per-database, which is why a name known from more than
 * one shows them all rather than pretending you picked one of them.
 */
function SchemasTab({
  connectionId,
  visible,
  filtered: isFiltered,
  objectFilter,
  onChange,
}: {
  connectionId: string | null;
  visible: string[];
  /** Whether the list is being used as a filter at all. See `schemas_filtered`. */
  filtered: boolean;
  objectFilter: string;
  onChange: (partial: Partial<DbConnectionConfig>) => void;
}) {
  const t = useT();
  const children = useDbStore((s) => s.children);
  const [typed, setTyped] = useState("");
  const [query, setQuery] = useState("");
  /** What `Load` last read from the server. Kept here, not in the store: it is this tab's material. */
  const [catalog, setCatalog] = useState<DbSchemaGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // The tab is opened per connection, and a stale catalog would be a list of another server's
  // schemas — worse than an empty one.
  useEffect(() => {
    setCatalog([]);
    setLoadError(null);
    setQuery("");
  }, [connectionId]);

  /** Every schema name in play, and which databases each was seen in. */
  const known = useMemo(() => {
    const seen = new Map<string, Set<string>>();
    const note = (name: string, database: string | null) => {
      const where = seen.get(name) ?? new Set<string>();
      if (database) where.add(database);
      seen.set(name, where);
    };
    // Chosen names first: one that no longer exists on the server must still be visible, or it
    // would filter the tree from a row nobody can find to untick.
    for (const name of visible) note(name, null);
    if (connectionId) {
      for (const [key, nodes] of Object.entries(children)) {
        if (!key.startsWith(`${connectionId}|`)) continue;
        for (const node of nodes) {
          if (node.kind === "schema") note(node.name, node.database);
        }
      }
    }
    for (const group of catalog) {
      for (const name of group.schemas) note(name, group.database);
    }
    return [...seen.entries()]
      .map(([name, where]) => ({ name, databases: [...where].sort((a, b) => a.localeCompare(b)) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [children, connectionId, visible, catalog]);

  /** Only worth naming the database on each row when there is more than one to tell apart. */
  const manyDatabases = useMemo(
    () => new Set(known.flatMap((entry) => entry.databases)).size > 1,
    [known],
  );

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? known.filter((entry) => entry.name.toLowerCase().includes(needle)) : known;
  }, [known, query]);

  const chosen = useMemo(() => new Set(visible.map((name) => name.toLowerCase())), [visible]);
  const isChosen = (name: string) => chosen.has(name.toLowerCase());

  /**
   * Every change here turns the list into a filter.
   *
   * Which is what makes unticking the last box mean "show none" instead of quietly reverting to
   * "show all" — the two used to be the same value. Turning the filter back off is its own action,
   * the "show every schema" link above, so it can never happen by accident.
   */
  const choose = (names: string[]) => onChange({ visible_schemas: names, schemas_filtered: true });

  const toggle = (name: string) => {
    choose(
      isChosen(name)
        ? visible.filter((entry) => entry.toLowerCase() !== name.toLowerCase())
        : [...visible, name],
    );
  };

  /** The select-all, over whatever the search has left on screen. */
  const setAll = (on: boolean) => {
    const names = filtered.map((entry) => entry.name);
    if (on) {
      choose([...visible, ...names.filter((name) => !isChosen(name))]);
      return;
    }
    const dropped = new Set(names.map((name) => name.toLowerCase()));
    choose(visible.filter((name) => !dropped.has(name.toLowerCase())));
  };

  const shownChosen = filtered.filter((entry) => isChosen(entry.name)).length;
  const allShownChosen = filtered.length > 0 && shownChosen === filtered.length;

  const load = async () => {
    if (!connectionId) return;
    setLoading(true);
    setLoadError(null);
    try {
      setCatalog(await dbSchemaCatalog(connectionId));
    } catch (e) {
      setLoadError(String(e));
    } finally {
      setLoading(false);
      // This button is the single densest opener of sessions in the app: the catalog walks every
      // database on the server and each one it reaches is a session the registry keeps. Telling the
      // explorer means the dot lights up and its menu offers Disconnect — which is the only way to
      // hand those sessions back before the app quits.
      void useDbStore.getState().syncConnected();
    }
  };

  const add = () => {
    const name = typed.trim();
    if (!name || isChosen(name)) return;
    choose([...visible, name]);
    setTyped("");
  };

  return (
    <div className="space-y-3">
      <div>
        <span className="mb-1 flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
          {t("db.visibleSchemas")}
          {/* The way back out of the filter, offered whenever one is on — including when it is
              filtering to nothing, which is the state you most need a way out of. */}
          {isFiltered && (
            <button
              type="button"
              onClick={() => onChange({ visible_schemas: [], schemas_filtered: false })}
              className="font-normal normal-case tracking-normal text-[var(--cf-accent)] hover:underline"
            >
              {t("db.showAllSchemas")}
            </button>
          )}
        </span>
        <p
          className={`mb-2 text-[11px] leading-snug ${
            isFiltered && visible.length === 0
              ? "text-[var(--cf-warning)]"
              : "text-[var(--cf-text-muted)]"
          }`}
        >
          {!isFiltered
            ? t("db.allSchemasShown")
            : visible.length === 0
              ? t("db.noSchemasShown")
              : t("db.someSchemasShown")}
        </p>

        <div className="overflow-hidden rounded-md border border-[var(--cf-border)]">
          {/* The header is the select-all, sitting over the rows it governs the way the first row
              of a table of checkboxes does. */}
          <div className="flex items-center gap-2 border-b border-[var(--cf-border)] bg-black/[0.03] px-2 py-1.5 dark:bg-white/[0.04]">
            <label className="flex min-w-0 cursor-pointer items-center gap-2">
              <Checkbox
                checked={allShownChosen}
                indeterminate={!allShownChosen && shownChosen > 0}
                onChange={setAll}
                disabled={filtered.length === 0}
              />
              <span className="truncate text-[12px] text-[var(--cf-text)]">
                {query.trim() ? t("db.allMatchingSchemas") : t("db.allSchemas")}
              </span>
            </label>
            <span className="ml-auto shrink-0 tabular-nums text-[11px] text-[var(--cf-text-muted)]">
              {t("db.schemasChosen", { chosen: visible.length, total: known.length })}
            </span>
            <div className="relative w-[132px] shrink-0">
              <Search
                size={11}
                className="pointer-events-none absolute left-1.5 top-1/2 -translate-y-1/2 text-[var(--cf-text-muted)]"
              />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("db.filterSchemas")}
                spellCheck={false}
                aria-label={t("db.filterSchemas")}
                className="w-full rounded border border-[var(--cf-border)] bg-transparent py-[3px] pl-6 pr-1.5 text-[11.5px] text-[var(--cf-text)] outline-none placeholder:text-[var(--cf-text-muted)] focus:border-[var(--cf-accent)]"
              />
            </div>
            {/* Reading the full list costs a connection, so it is a button and not something the
                tab does on open. Unsaved connections have nothing to connect with — the settings
                are read from the row, not from this form. */}
            <IconButton
              onClick={() => void load()}
              disabled={!connectionId || loading}
              title={connectionId ? t("db.loadSchemas") : t("db.loadSchemasUnsaved")}
            >
              {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
            </IconButton>
          </div>

          {filtered.length === 0 ? (
            <p className="p-2.5 text-[11px] leading-snug text-[var(--cf-text-muted)]">
              {known.length > 0
                ? t("db.noSchemasMatch", { query: query.trim() })
                : connectionId
                  ? t("db.noSchemasKnown")
                  : t("db.loadSchemasUnsaved")}
            </p>
          ) : (
            <div className="max-h-52 space-y-0.5 overflow-auto p-1.5">
              {filtered.map((entry) => (
                <label
                  key={entry.name}
                  className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
                >
                  <Checkbox checked={isChosen(entry.name)} onChange={() => toggle(entry.name)} />
                  <span className="min-w-0 truncate text-[12px] text-[var(--cf-text)]">
                    {entry.name}
                  </span>
                  {manyDatabases && entry.databases.length > 0 && (
                    <span className="ml-auto min-w-0 shrink truncate text-[10.5px] text-[var(--cf-text-muted)]">
                      {entry.databases.join(", ")}
                    </span>
                  )}
                </label>
              ))}
            </div>
          )}

          {loadError && (
            <p className="flex items-start gap-1.5 border-t border-[var(--cf-border)] p-2 text-[11px] leading-snug text-[var(--cf-danger)]">
              <XCircle size={11} className="mt-[2px] shrink-0" />
              <span className="min-w-0 break-words">{loadError}</span>
            </p>
          )}
        </div>

        <div className="mt-1.5 flex items-center gap-1.5">
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
            placeholder={t("db.addSchemaPlaceholder")}
            spellCheck={false}
            className={INPUT}
          />
          <GhostButton onClick={add} disabled={!typed.trim()}>
            <Plus size={12} />
            {t("db.addSchema")}
          </GhostButton>
        </div>
      </div>

      <Row label={t("db.objectFilter")} hint={t("db.objectFilterHint")}>
        <input
          value={objectFilter}
          onChange={(e) => onChange({ object_filter: e.target.value })}
          placeholder={t("db.objectFilterPlaceholder")}
          spellCheck={false}
          className={INPUT}
        />
      </Row>
    </div>
  );
}

/** One entry in the dialog's list of connections. */
function ConnectionRow({
  glyph,
  name,
  detail,
  active,
  onClick,
}: {
  glyph: React.ReactNode;
  name: string;
  detail: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active}
      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left ${
        active
          ? "bg-[color-mix(in_oklab,var(--cf-accent)_16%,transparent)]"
          : "hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
      }`}
    >
      <span className="shrink-0">{glyph}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12px] text-[var(--cf-text)]">{name}</span>
        {detail && (
          <span className="block truncate text-[10.5px] text-[var(--cf-text-muted)]">{detail}</span>
        )}
      </span>
    </button>
  );
}

/**
 * The engine picker: a named list, the way a database tool names its drivers.
 *
 * A dropdown rather than the row of chips this used to be. Chips fit the short names and nothing
 * else — "SQL Server" and "IRIS" as chips are abbreviations of a choice that decides every field
 * below them, and the row had no room to say which engines exist and how well each is supported. As
 * a list each engine gets its full name, its glyph in its own brand hue, and a heading over the set,
 * and the closed trigger still shows the current engine, which is what the chips were protecting.
 *
 * It is the app's shared `Select`, so the menu is keyboard-navigable and portalled out of the
 * dialog's scroll container for free, and the glyphs ride its `leading` slot to keep their colour.
 */
function EnginePicker({
  active,
  onSelect,
}: {
  active: DbKind;
  onSelect: (kind: DbKind) => void;
}) {
  const t = useT();
  const options = useMemo<SelectItems>(
    () => [
      {
        label: t("db.engineGroup"),
        options: DB_ENGINES.map((entry) => ({
          value: entry.kind,
          label: entry.label,
          leading: <EngineGlyph kind={entry.kind} />,
        })),
      },
    ],
    [t],
  );

  return (
    <Select
      value={active}
      options={options}
      onChange={(kind) => onSelect(kind as DbKind)}
      size="field"
      ariaLabel={t("db.engine")}
    />
  );
}

/** Fields ⇄ URL. A two-item segmented control, because they are the same setting expressed twice. */
function ModeSwitch({ mode, onChange }: { mode: Mode; onChange: (mode: Mode) => void }) {
  const t = useT();
  const entries: { id: Mode; label: string; icon: typeof Link2 }[] = [
    { id: "fields", label: t("db.mode.fields"), icon: SlidersHorizontal },
    { id: "url", label: t("db.mode.url"), icon: Link2 },
  ];
  return (
    // A segmented control is a recessed track with a raised thumb, and it only reads that way if
    // the thumb is lighter than what surrounds it. This one painted the thumb `--cf-surface` — the
    // dialog's *own* background — over a track lightened with `white/6%`. On the light theme that
    // happens to work, because there the panel is the lightest surface there is. On the dark theme
    // it inverts: the selected half comes out the same colour as the dialog behind it, sunk into a
    // lighter track, so the option you had *not* picked was the one that looked picked.
    //
    // Both halves are now relative to the panel instead of to one theme: the track goes darker than
    // it (`black/…` in both), the thumb goes to `--cf-surface-raised`, which is a step above the
    // panel in either theme. The hairline is what carries the edge on dark, where a drop shadow
    // over a dark track is invisible.
    <div className="inline-flex gap-0.5 rounded-lg bg-black/[0.05] p-[3px] dark:bg-black/25">
      {entries.map((entry) => {
        const Icon = entry.icon;
        return (
          <button
            key={entry.id}
            type="button"
            onClick={() => onChange(entry.id)}
            aria-pressed={mode === entry.id}
            className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11.5px] font-medium transition-colors ${
              mode === entry.id
                ? "bg-[var(--cf-surface-raised)] text-[var(--cf-text)] shadow-sm ring-1 ring-inset ring-[var(--cf-border)]"
                : "text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
            }`}
          >
            <Icon size={11} className="opacity-70" />
            {entry.label}
          </button>
        );
      })}
    </div>
  );
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10.5px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
        {label}
      </span>
      {children}
      {hint && (
        <span className="mt-1 block text-[11px] leading-snug text-[var(--cf-text-muted)]">
          {hint}
        </span>
      )}
    </label>
  );
}

/**
 * What choosing each sign-in actually commits the user to — which is the part that isn't obvious
 * from the name, and the reason the CLI option is worth preferring: nothing is stored here, and
 * MFA and conditional access happen in Microsoft's own flow rather than in a box in this dialog.
 */
function authHint(method: DbAuthMethod, t: (key: TranslationKey) => string): string {
  if (method === "entra_cli") return t("db.authEntraCliHint");
  if (method === "entra_service_principal") return t("db.authEntraAppHint");
  return t("db.authPasswordHint");
}

/**
 * A number box without the stepper.
 *
 * `type="number"`'s spin buttons are two arrows nobody clicks that eat 20px of a 104px field and make
 * it look like a different control from the boxes beside it. `inputMode="numeric"` gets the phone
 * keypad and the numeric hints without them. Non-digits are dropped on the way in, and `0` is stored
 * for an empty box — which is what "use the engine's default" means throughout.
 */
function NumberInput({
  value,
  onChange,
  placeholder,
}: {
  value: number;
  onChange: (value: number) => void;
  placeholder?: string;
}) {
  return (
    <input
      type="text"
      inputMode="numeric"
      value={value === 0 ? "" : String(value)}
      onChange={(e) => onChange(Number(e.target.value.replace(/[^\d]/g, "")) || 0)}
      placeholder={placeholder}
      className={`${INPUT} tabular-nums`}
    />
  );
}

/** A borderless button sized to sit inside an input's padding. */
function IconButton({
  onClick,
  title,
  disabled,
  children,
}: {
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  title: string;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      disabled={disabled}
      className="flex h-5 w-5 items-center justify-center rounded text-[var(--cf-text-muted)] hover:bg-black/[0.06] hover:text-[var(--cf-text)] disabled:pointer-events-none disabled:opacity-40 dark:hover:bg-white/[0.1]"
    >
      {children}
    </button>
  );
}

/**
 * The engine-specific extras, as free key/value pairs.
 *
 * Free-form rather than a field per option: every engine has a long tail of connection parameters,
 * and a form offering only the ones we thought of would make the rest unreachable. The suggested
 * names are clickable, so the ones that actually come up cost one click instead of being typed from
 * memory.
 */
function DriverOptions({
  options,
  onChange,
  kind,
}: {
  options: [string, string][];
  onChange: (options: [string, string][]) => void;
  kind: DbKind;
}) {
  const t = useT();
  const suggestions: Record<DbKind, string[]> = {
    postgres: ["application_name"],
    supabase: ["application_name"],
    sqlserver: ["instance_name", "application_name"],
    // Properties of the InterSystems JDBC driver, spelled the way it names them (they are matched
    // case-insensitively, but suggesting the driver's own spelling keeps its docs searchable).
    // `SSL configuration name` is the one that matters in practice: it is how a server-side client
    // TLS configuration is selected.
    iris: ["SSL configuration name", "TransactionIsolationLevel", "NetworkTimeout"],
    mongodb: ["authSource", "application_name"],
  };
  const unused = suggestions[kind].filter(
    (suggestion) => !options.some(([key]) => key === suggestion),
  );

  return (
    <div>
      <span className="mb-1 block text-[10.5px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
        {t("db.driverOptions")}
      </span>
      <div className="space-y-1.5">
        {options.map(([key, value], index) => (
          <div key={index} className="flex items-center gap-1.5">
            <input
              value={key}
              onChange={(e) =>
                onChange(options.map((entry, i) => (i === index ? [e.target.value, entry[1]] : entry)))
              }
              placeholder={t("db.optionKey")}
              spellCheck={false}
              className={`${INPUT} font-mono`}
            />
            <input
              value={value}
              onChange={(e) =>
                onChange(options.map((entry, i) => (i === index ? [entry[0], e.target.value] : entry)))
              }
              placeholder={t("db.optionValue")}
              spellCheck={false}
              className={`${INPUT} font-mono`}
            />
            <IconButton
              onClick={() => onChange(options.filter((_, i) => i !== index))}
              title={t("db.delete")}
            >
              <Trash2 size={12} />
            </IconButton>
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-1.5">
          <GhostButton onClick={() => onChange([...options, ["", ""]])}>
            <Plus size={12} />
            {t("db.addOption")}
          </GhostButton>
          {unused.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              onClick={() => onChange([...options, [suggestion, ""]])}
              className="rounded-md border border-dashed border-[var(--cf-border)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--cf-text-muted)] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]"
            >
              + {suggestion}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
