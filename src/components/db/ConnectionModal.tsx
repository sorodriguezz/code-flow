import { useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Database,
  Eye,
  EyeOff,
  Info,
  Link2,
  Loader2,
  Plug,
  Plus,
  Server,
  SlidersHorizontal,
  Trash2,
  XCircle,
} from "lucide-react";
import { ApiModal, GhostButton } from "../api/ApiModal";
import { Checkbox } from "../common/Checkbox";
import { Select, type SelectItems } from "../common/Select";
import { EngineGlyph } from "./dbChrome";
import { parseSpec, redactUrl, useDbStore } from "../../state/dbStore";
import { dbHasPassword } from "../../lib/tauri/dbCommands";
import { useT } from "../../state/languageStore";
import {
  DB_ENGINES,
  defaultConnectionConfig,
  engineInfo,
  type DbConnectionConfig,
  type DbKind,
  type DbServerInfo,
  type DbSslMode,
} from "../../types/database";

/**
 * The connection dialog.
 *
 * The layout is the design here. A database connection has a dozen settings and only four of them
 * are ever typed, so the dialog is built in three tiers: the engine, the four fields that matter,
 * and everything else behind a disclosure. The first version put all twelve in one column, which
 * made a 1300px-tall sheet where the important box and the one nobody touches looked equally
 * important.
 *
 * Two more things it is careful about:
 *
 * **Fields or URL, never both.** They are alternatives — a pasted URI overrides every field — so
 * they are a two-mode switch rather than two sections where one silently wins. The old version dimmed
 * the fields when a URL was present, which left the user reading greyed-out boxes to work out which
 * half was live.
 *
 * **The password.** A saved one is never read back — there is no command that returns it — so the box
 * shows a "saved" placeholder and stays empty. Leaving it empty on save keeps whatever is in the
 * keychain; typing replaces it; the trash button removes it. That is the only model that doesn't
 * either lie about what is stored or make the user re-type a credential to change a port.
 */

/** Shared with `Field` in `ApiModal`, so a local input styled here can't drift from the rest. */
const INPUT =
  "w-full rounded-md border border-[var(--cf-border)] bg-transparent px-2 py-1.5 text-[12px] text-[var(--cf-text)] outline-none transition-colors placeholder:text-[var(--cf-text-muted)] focus:border-[var(--cf-accent)] disabled:opacity-50";

type Mode = "fields" | "url";

export function ConnectionModal({
  connectionId,
  onClose,
}: {
  connectionId: string | null;
  onClose: () => void;
}) {
  const t = useT();
  const row = useDbStore((s) => s.connections.find((c) => c.id === connectionId) ?? null);
  const store = useDbStore.getState();

  const [name, setName] = useState(row?.name ?? "");
  const [config, setConfig] = useState<DbConnectionConfig>(
    () => (row ? parseSpec(row) : null) ?? defaultConnectionConfig("postgres"),
  );
  // Opens on whichever half is actually in use, so editing a URL-based connection doesn't start on
  // a form of empty fields that aren't being used.
  const [mode, setMode] = useState<Mode>(() =>
    (row ? parseSpec(row)?.url : "") ? "url" : "fields",
  );
  const [advanced, setAdvanced] = useState(false);
  const [password, setPassword] = useState("");
  const [revealPassword, setRevealPassword] = useState(false);
  /** Whether the keychain already holds one. Decides the placeholder and whether "clear" is shown. */
  const [hasStored, setHasStored] = useState(false);
  const [passwordTouched, setPasswordTouched] = useState(false);
  const [testing, setTesting] = useState(false);
  const [outcome, setOutcome] = useState<
    { ok: true; info: DbServerInfo } | { ok: false; error: string } | null
  >(null);
  const [saving, setSaving] = useState(false);

  const engine = engineInfo(config.kind);

  useEffect(() => {
    if (!connectionId) return;
    void dbHasPassword(connectionId)
      .then(setHasStored)
      .catch(() => setHasStored(false));
  }, [connectionId]);

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
      // A port typed explicitly is kept; the engine's default (0) follows the new engine.
      port: current.port,
      database: current.database || defaults.database,
    }));
    setOutcome(null);
  };

  const patch = (partial: Partial<DbConnectionConfig>) => {
    setConfig((current) => ({ ...current, ...partial }));
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
    if (mode === "url" && config.url.trim()) return redactUrl(config.url.trim());
    const port = config.port || engine.defaultPort;
    const scheme = config.kind === "iris" ? (config.ssl === "disable" ? "http" : "https") : "";
    const where = `${config.host || "localhost"}:${port}`;
    const path = config.database ? `/${config.database}` : "";
    return scheme ? `${scheme}://${where}${path}` : `${where}${path}`;
  }, [mode, config, engine.defaultPort]);

  const test = async () => {
    setTesting(true);
    setOutcome(null);
    try {
      const info = await store.testConnection({
        ...config,
        id: connectionId ?? "",
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

  const save = async () => {
    setSaving(true);
    try {
      const finalName = name.trim() || derivedName;
      let saved = row;
      if (!saved) {
        saved = await store.createConnection(config.kind, finalName);
        if (!saved) return;
      }
      const ok = await store.saveConnection(
        { ...saved, name: finalName },
        {
          ...config,
          id: saved.id,
          password: "",
          url: mode === "url" ? config.url : "",
        },
        // `null` means "leave the keychain alone" — which is what an untouched box means.
        passwordTouched ? password : null,
      );
      if (ok) onClose();
    } finally {
      setSaving(false);
    }
  };

  const sslOptions = useMemo(
    () => [
      { value: "disable", label: t("db.ssl.disable") },
      { value: "require", label: t("db.ssl.require") },
      { value: "verify_full", label: t("db.ssl.verify") },
    ],
    [t],
  );

  return (
    <ApiModal
      icon={Database}
      title={connectionId ? t("db.editConnection") : t("db.newConnection")}
      subtitle={engine.label}
      width="max-w-xl"
      busy={saving}
      // A dozen fields and a password, none of it drafted anywhere: a click on the backdrop must not
      // be what throws it away. Close, Cancel and Escape stay.
      dismissOnBackdrop={false}
      onClose={onClose}
      footer={
        <div className="flex w-full items-center gap-2">
          <GhostButton onClick={() => void test()} disabled={testing}>
            {testing ? <Loader2 size={12} className="animate-spin" /> : <Plug size={12} />}
            {t("db.testConnection")}
          </GhostButton>
          <div className="ml-auto flex items-center gap-2">
            <GhostButton onClick={onClose}>{t("common.cancel")}</GhostButton>
            <button
              onClick={() => void save()}
              disabled={saving}
              className="rounded-md bg-[var(--cf-accent)] px-3 py-1.5 text-[12px] font-medium text-white hover:brightness-110 disabled:opacity-50"
            >
              {t("common.save")}
            </button>
          </div>
        </div>
      }
    >
      {/* `ApiModal`'s body is a bare flex column — each modal brings its own padding and its own
          scroll container. Without them the form sits flush against the frame and a tall one
          overflows the sheet instead of scrolling inside it. */}
      <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4">
        <Row label={t("db.engine")}>
          <EnginePicker active={config.kind} onSelect={setKind} />
        </Row>

        <Row label={t("db.name")}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={derivedName}
            className={INPUT}
          />
        </Row>

        {/* Fields or URL — alternatives, so only one is on screen. */}
        <div>
          <ModeSwitch mode={mode} onChange={(next) => { setMode(next); setOutcome(null); }} />

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
                <Row label={t("db.user")}>
                  <input
                    value={config.user}
                    onChange={(e) => patch({ user: e.target.value })}
                    spellCheck={false}
                    autoComplete="off"
                    className={INPUT}
                  />
                </Row>
              </div>
            </div>
          )}
        </div>

        <Row
          label={t("db.password")}
          hint={hasStored && !passwordTouched ? t("db.passwordStored") : t("db.passwordHint")}
        >
          <div className="relative flex items-center">
            <input
              type={revealPassword ? "text" : "password"}
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setPasswordTouched(true);
                setOutcome(null);
              }}
              placeholder={hasStored && !passwordTouched ? "••••••••" : ""}
              autoComplete="new-password"
              className={`${INPUT} ${hasStored ? "pr-14" : "pr-8"}`}
            />
            <div className="absolute right-1.5 flex items-center gap-0.5">
              <IconButton
                onClick={() => setRevealPassword((current) => !current)}
                title={revealPassword ? t("db.hidePassword") : t("db.showPassword")}
              >
                {revealPassword ? <EyeOff size={12} /> : <Eye size={12} />}
              </IconButton>
              {hasStored && (
                <IconButton
                  onClick={() => {
                    setPassword("");
                    setPasswordTouched(true);
                  }}
                  title={t("db.clearPassword")}
                >
                  <Trash2 size={12} />
                </IconButton>
              )}
            </div>
          </div>
        </Row>

        {/* Everything nobody types. Collapsed by default: the four boxes above are the connection,
            and these are the exceptions to it. */}
        <div className="rounded-lg border border-[var(--cf-border)]">
          <button
            type="button"
            onClick={() => setAdvanced((current) => !current)}
            aria-expanded={advanced}
            className="flex w-full items-center gap-1.5 px-2.5 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
          >
            {advanced ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <SlidersHorizontal size={12} />
            {t("db.advanced")}
            {/* A summary while it is closed, so a non-default setting isn't hidden by the fold. */}
            {!advanced && (
              <span className="ml-auto min-w-0 truncate font-normal normal-case tracking-normal">
                {[
                  sslOptions.find((option) => option.value === config.ssl)?.label,
                  config.read_only ? t("db.readOnly") : null,
                  config.options.filter(([key]) => key).length > 0
                    ? t("db.optionsN", { n: String(config.options.filter(([key]) => key).length) })
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            )}
          </button>

          {advanced && (
            <div className="space-y-3 border-t border-[var(--cf-border)] p-2.5">
              <div className="grid grid-cols-2 gap-2">
                <Row label={t("db.ssl.label")}>
                  <Select
                    value={config.ssl}
                    options={sslOptions}
                    onChange={(ssl) => patch({ ssl: ssl as DbSslMode })}
                    size="md"
                  />
                </Row>
                <Row label={t("db.timeout")}>
                  <NumberInput
                    value={config.connect_timeout_ms}
                    onChange={(connect_timeout_ms) => patch({ connect_timeout_ms })}
                    placeholder="15000"
                  />
                </Row>
              </div>

              <label className="flex cursor-pointer items-start gap-2">
                <Checkbox
                  checked={config.read_only}
                  onChange={(read_only) => patch({ read_only })}
                  className="mt-[2px]"
                />
                <span>
                  <span className="block text-[12px] text-[var(--cf-text)]">
                    {t("db.readOnly")}
                  </span>
                  <span className="block text-[11px] leading-snug text-[var(--cf-text-muted)]">
                    {t("db.readOnlyHint")}
                  </span>
                </span>
              </label>

              <DriverOptions
                options={config.options}
                onChange={(options) => patch({ options })}
                kind={config.kind}
              />
            </div>
          )}
        </div>

        {config.kind === "iris" && (
          <p className="flex items-start gap-1.5 rounded-lg border border-[var(--cf-border)] bg-black/[0.02] p-2.5 text-[11px] leading-snug text-[var(--cf-text-muted)] dark:bg-white/[0.03]">
            <Info size={12} className="mt-[1px] shrink-0" />
            {t("db.irisNote")}
          </p>
        )}

        {/* What a connect will actually address. The one line that catches a port left on the
            default, or a URL that quietly overrode the fields. */}
        <p className="flex items-center gap-1.5 text-[11px] text-[var(--cf-text-muted)]">
          <Server size={11} className="shrink-0" />
          <span className="shrink-0 uppercase tracking-wide">{t("db.target")}</span>
          <span className="min-w-0 truncate font-mono text-[var(--cf-text)]">{target}</span>
        </p>

        {outcome && (
          <div
            className={`rounded-lg border p-2.5 text-[12px] ${
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
    </ApiModal>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

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
      size="md"
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
    <div className="inline-flex gap-0.5 rounded-lg bg-black/[0.04] p-0.5 dark:bg-white/[0.06]">
      {entries.map((entry) => {
        const Icon = entry.icon;
        return (
          <button
            key={entry.id}
            type="button"
            onClick={() => onChange(entry.id)}
            aria-pressed={mode === entry.id}
            className={`relative flex items-center gap-1.5 rounded-[6px] px-2.5 py-1 text-[11.5px] font-medium transition-colors ${
              mode === entry.id
                ? "bg-[var(--cf-surface)] text-[var(--cf-text)] shadow-[var(--cf-shadow)]"
                : "text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
            }`}
          >
            <Icon size={11} />
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
  children,
}: {
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className="flex h-5 w-5 items-center justify-center rounded text-[var(--cf-text-muted)] hover:bg-black/[0.06] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.1]"
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
    // `path` is for a deployment that mounts IRIS under a gateway prefix rather than at the root.
    iris: ["path"],
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
