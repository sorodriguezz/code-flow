import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  CheckCircle2,
  Coffee,
  Download,
  ExternalLink,
  FileArchive,
  FolderOpen,
  Loader2,
  Minus,
  Plus,
  RotateCcw,
  Search,
  Trash2,
} from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { GhostButton } from "../api/ApiModal";
import { INPUT, Row, dangerIconButtonClass } from "./dbChrome";
import { DriverGlyph } from "./DbLogo";
import { GROUP_LABELS } from "./DriverMenu";
import { Select } from "../common/Select";
import { buttonClass } from "../common/Button";
import { fieldClass } from "../common/recipes";
import { confirmAction } from "../../state/confirmStore";
import { pushErrorToast } from "../../state/toastStore";
import { openExternalUrl } from "../../lib/tauri/commands";
import { dbDriversReveal } from "../../lib/tauri/dbCommands";
import {
  DRIVER_CATALOG,
  JAVA_RELEASE,
  availableHere,
  catalogDriver,
  customDriverDef,
  driverDownloadSize,
  driverFileVersion,
  driverGroup,
  formatBytes,
  groupDrivers,
  isJvmDriver,
  searchDrivers,
  type DriverDef,
} from "../../lib/db/drivers";
import { allDrivers, driverReadiness, settingsFor, useDriverStore } from "../../state/driverStore";
import { useT } from "../../state/languageStore";
import { engineInfo, type DbDriverSettings, type DbUrlTemplate } from "../../types/database";

/**
 * The connection dialog's other half: the drivers, DataGrip's "Drivers" tab.
 *
 * A list down the left — searchable, under the same three headings the driver menu uses — and the
 * selected driver on the right: the class it loads, the files it needs (downloaded from here, or
 * added by hand), its URL templates, and under Advanced the properties every data source of it
 * starts with and the JVM it runs in.
 *
 * **Edits are drafts until Apply**, like every other edit in this dialog: the drafts live in the
 * dialog (`drafts`), so moving between drivers — or over to a data source and back — keeps them,
 * and Cancel throws them away. Downloading and deleting files are not edits but actions, and happen
 * at once.
 */
export function DriversView({
  selected,
  onSelect,
  drafts,
  onDraft,
  onCreateDataSource,
  usage,
}: {
  selected: string | null;
  onSelect: (driverId: string) => void;
  /** Unsaved changes, by driver id. */
  drafts: Record<string, DbDriverSettings>;
  onDraft: (settings: DbDriverSettings | { id: string; discard: true }) => void;
  onCreateDataSource: (driverId: string) => void;
  /** How many data sources use each driver. */
  usage: Record<string, number>;
}) {
  const t = useT();
  const settings = useDriverStore((s) => s.settings);
  const overview = useDriverStore((s) => s.overview);
  const [query, setQuery] = useState("");

  useEffect(() => {
    void useDriverStore.getState().load();
  }, []);

  /** Saved drivers, then any the user is adding and hasn't applied yet. */
  const drivers = useMemo(() => {
    const saved = allDrivers(settings);
    const unsaved = Object.values(drafts)
      .filter((draft) => draft.custom && !settings.some((entry) => entry.id === draft.id))
      .map(customDriverDef);
    return [...saved, ...unsaved].map((def) =>
      // A custom driver's name and URLs are drawn from its draft while it is being edited.
      def.custom && drafts[def.id] ? customDriverDef(drafts[def.id]) : def,
    );
  }, [settings, drafts]);

  const groups = useMemo(() => {
    if (query.trim()) {
      return [{ group: null, drivers: searchDrivers(drivers, query) }];
    }
    return groupDrivers(drivers);
  }, [drivers, query]);

  const def = drivers.find((entry) => entry.id === selected) ?? null;

  const addDriver = () => {
    const id = `custom-${crypto.randomUUID().slice(0, 8)}`;
    onDraft({ ...settingsFor(id, []), custom: true, name: t("db.drivers.newDriverName") });
    onSelect(id);
  };

  const removeDriver = async () => {
    if (!def?.custom) return;
    if (!(await confirmAction(t("db.drivers.removeConfirm", { name: def.name }), true, t("db.delete")))) return;
    onDraft({ id: def.id, discard: true });
    if (settings.some((entry) => entry.id === def.id)) {
      await useDriverStore.getState().deleteSettings(def.id);
    }
    onSelect(drivers.find((entry) => entry.id !== def.id)?.id ?? "postgresql");
  };

  return (
    <>
      <aside className="flex w-56 shrink-0 flex-col border-r border-[var(--cf-border)]">
        <div className="flex shrink-0 items-center gap-0.5 border-b border-[var(--cf-border)] px-2 py-1.5">
          <div className="relative min-w-0 flex-1">
            <Search
              size={11}
              className="pointer-events-none absolute left-1.5 top-1/2 -translate-y-1/2 text-[var(--cf-text-muted)]"
            />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("db.drivers.search")}
              spellCheck={false}
              aria-label={t("db.drivers.search")}
              className={fieldClass({ className: "w-full pl-6 pr-1.5" })}
            />
          </div>
          <ListButton onClick={addDriver} title={t("db.drivers.addDriver")}>
            <Plus size={13} />
          </ListButton>
          <ListButton onClick={() => void removeDriver()} title={t("db.drivers.removeDriver")} disabled={!def?.custom}>
            <Minus size={13} />
          </ListButton>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-1">
          {groups.map((entry) => (
            <div key={entry.group ?? "results"}>
              {entry.group && (
                <p className="px-2 pb-1 pt-2 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]">
                  {t(GROUP_LABELS[entry.group])}
                </p>
              )}
              {entry.drivers.map((driver) => {
                const ready = driverReadiness(driver, overview, settings);
                return (
                  <button
                    key={driver.id}
                    type="button"
                    onClick={() => onSelect(driver.id)}
                    aria-current={driver.id === selected}
                    className={`flex w-full items-center gap-2 rounded-md px-2 py-[5px] text-left ${
                      driver.id === selected
                        ? "bg-[color-mix(in_oklab,var(--cf-accent)_16%,transparent)]"
                        : "hover:bg-[var(--cf-hover)]"
                    } ${availableHere(driver) ? "" : "opacity-55"}`}
                  >
                    <DriverGlyph driver={driver} />
                    <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--cf-text)]">
                      {driver.name}
                      {drafts[driver.id] && <span className="text-[var(--cf-accent)]"> •</span>}
                    </span>
                    {ready.jvm && ready.files && ready.runtime && (
                      <CheckCircle2
                        size={11}
                        className="shrink-0 text-[var(--cf-success)]"
                        aria-label={t("db.drivers.downloaded")}
                      />
                    )}
                  </button>
                );
              })}
            </div>
          ))}
          {groups.every((entry) => entry.drivers.length === 0) && (
            <p className="px-2 py-3 text-[11.5px] text-[var(--cf-text-muted)]">
              {t("db.drivers.noMatch", { query: query.trim() })}
            </p>
          )}
        </div>

        {/* The backend creates the folder before opening it: until the first download there is
            none, and this used to hand the file manager a missing path and drop the refusal. */}
        <button
          type="button"
          onClick={() =>
            void dbDriversReveal().catch((error) =>
              pushErrorToast(t("db.drivers.showFolderFailed", { error: String(error) })),
            )
          }
          className="flex shrink-0 items-center gap-1.5 border-t border-[var(--cf-border)] px-3 py-1.5 text-left text-[11px] text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
        >
          <FolderOpen size={11} />
          {t("db.drivers.showFolder")}
        </button>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {def ? (
          <DriverPanel
            key={def.id}
            def={def}
            draft={drafts[def.id] ?? settingsFor(def.id, settings)}
            dirty={Boolean(drafts[def.id])}
            onChange={onDraft}
            onCreateDataSource={() => onCreateDataSource(def.id)}
            usage={usage[def.id] ?? 0}
          />
        ) : (
          <p className="p-6 text-[12px] text-[var(--cf-text-muted)]">{t("db.drivers.pick")}</p>
        )}
      </div>
    </>
  );
}

type DriverTab = "general" | "advanced";

function DriverPanel({
  def,
  draft,
  dirty,
  onChange,
  onCreateDataSource,
  usage,
}: {
  def: DriverDef;
  draft: DbDriverSettings;
  dirty: boolean;
  onChange: (settings: DbDriverSettings | { id: string; discard: true }) => void;
  onCreateDataSource: () => void;
  usage: number;
}) {
  const t = useT();
  const [tab, setTab] = useState<DriverTab>("general");
  const jvm = isJvmDriver(def);
  const patch = (partial: Partial<DbDriverSettings>) => onChange({ ...draft, ...partial });
  const catalogEntry = def.custom ? null : catalogDriver(def.id);
  const changed = !def.custom && (dirty || hasChanges(draft));

  return (
    <>
      <div className="flex shrink-0 items-center gap-3 border-b border-[var(--cf-border)] px-4 py-3">
        <DriverGlyph driver={def} size={28} />
        <div className="min-w-0 flex-1">
          {def.custom ? (
            <input
              value={draft.name}
              onChange={(e) => patch({ name: e.target.value })}
              aria-label={t("db.drivers.name")}
              className={`${INPUT} font-medium`}
            />
          ) : (
            <p className="truncate text-[14px] font-medium text-[var(--cf-text)]">{def.name}</p>
          )}
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-[var(--cf-text-muted)]">
            <span>{t(GROUP_LABELS[driverGroup(def)])}</span>
            {usage > 0 && (
              <span>· {usage === 1 ? t("db.drivers.usedByOne") : t("db.drivers.usedBy", { n: usage })}</span>
            )}
            {!availableHere(def) && <span className="text-[var(--cf-warning)]">· {t("db.drivers.windowsOnly")}</span>}
            {def.homepage && (
              <button
                type="button"
                onClick={() => void openExternalUrl(def.homepage!)}
                className="inline-flex items-center gap-0.5 text-[var(--cf-accent)] hover:underline"
              >
                · {t("db.drivers.homepage")}
                <ExternalLink size={9} />
              </button>
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={onCreateDataSource}
          disabled={!availableHere(def)}
          className={buttonClass({ variant: "primary" })}
        >
          <Plus size={12} />
          {t("db.drivers.createDataSource")}
        </button>
      </div>

      {jvm && (
        <div className="flex shrink-0 gap-0.5 border-b border-[var(--cf-border)] px-2 pt-1.5">
          {(["general", "advanced"] as const).map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              aria-selected={tab === id}
              className={`-mb-px border-b-2 px-2.5 py-1.5 text-[12px] font-medium transition-colors ${
                tab === id
                  ? "border-[var(--cf-accent)] text-[var(--cf-text)]"
                  : "border-transparent text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
              }`}
            >
              {t(id === "general" ? "db.drivers.tab.general" : "db.drivers.tab.advanced")}
            </button>
          ))}
          {changed && (
            <button
              type="button"
              onClick={() => onChange({ ...settingsFor(def.id, []) })}
              className="mb-1 ml-auto inline-flex items-center gap-1 rounded-md px-2 text-[11px] text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]"
            >
              <RotateCcw size={11} />
              {t("db.drivers.resetDriver")}
            </button>
          )}
        </div>
      )}

      <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4">
        {!jvm ? (
          <BuiltInDriver def={def} />
        ) : tab === "general" ? (
          <>
            {def.custom && (
              <Row label={t("db.drivers.basedOn")} hint={t("db.drivers.basedOnHint")}>
                <Select
                  value={draft.basedOn}
                  onChange={(basedOn) => patch({ basedOn })}
                  options={[
                    { value: "", label: t("db.drivers.basedOnNone") },
                    ...DRIVER_CATALOG.filter((entry) => entry.engine === "jdbc").map((entry) => ({
                      value: entry.id,
                      label: entry.name,
                    })),
                  ]}
                  size="field"
                />
              </Row>
            )}
            <Row
              label={t("db.drivers.class")}
              hint={catalogEntry?.class ? t("db.drivers.classHint", { class: catalogEntry.class }) : undefined}
            >
              <input
                value={draft.class}
                onChange={(e) => patch({ class: e.target.value })}
                placeholder={catalogEntry?.class ?? "com.example.jdbc.Driver"}
                spellCheck={false}
                autoComplete="off"
                className={`${INPUT} font-mono`}
              />
            </Row>
            <DriverFiles def={def} draft={draft} onChange={patch} />
            {/* Oracle and IRIS have sessions of their own, which build the URL from the
                connection's fields themselves — a template here would be one nothing reads. */}
            {def.engine === "jdbc" && (
              <UrlTemplates def={def} catalogEntry={catalogEntry} draft={draft} onChange={patch} />
            )}
            <RuntimeBox draft={draft} />
            {def.license && (
              <p className="text-[11px] leading-relaxed text-[var(--cf-text-muted)]">
                {t("db.drivers.licenseNote", { name: def.name })}{" "}
                <button
                  type="button"
                  onClick={() => void openExternalUrl(def.license!)}
                  className="inline-flex items-center gap-0.5 text-[var(--cf-accent)] hover:underline"
                >
                  {t("db.drivers.license")}
                  <ExternalLink size={9} />
                </button>
              </p>
            )}
          </>
        ) : (
          <>
            <Section title={t("db.drivers.properties")} hint={t("db.drivers.propertiesHint")}>
              {Object.entries(catalogEntry?.properties ?? {}).length > 0 && (
                <div className="mb-1.5 space-y-1">
                  {Object.entries(catalogEntry?.properties ?? {}).map(([key, value]) => (
                    <div key={key} className="flex items-center gap-1.5 text-[11.5px]">
                      <span className="w-1/2 truncate rounded-md bg-[var(--cf-hover)] px-2 py-1 font-mono text-[var(--cf-text-muted)]">
                        {key}
                      </span>
                      <span className="w-1/2 truncate rounded-md bg-[var(--cf-hover)] px-2 py-1 font-mono text-[var(--cf-text-muted)]">
                        {value}
                      </span>
                      <span className="w-[22px] shrink-0 text-center text-[10px] text-[var(--cf-text-faint)]" title={t("db.drivers.catalogValue")}>
                        ·
                      </span>
                    </div>
                  ))}
                </div>
              )}
              <PairsEditor
                pairs={draft.properties}
                onChange={(properties) => patch({ properties })}
                addLabel={t("db.drivers.addProperty")}
              />
            </Section>
            <Row label={t("db.drivers.vmOptions")} hint={t("db.drivers.vmOptionsHint")}>
              <input
                value={draft.vmOptions}
                onChange={(e) => patch({ vmOptions: e.target.value })}
                placeholder="-Xmx1g -Duser.timezone=UTC"
                spellCheck={false}
                autoComplete="off"
                className={`${INPUT} font-mono`}
              />
            </Row>
            <Section title={t("db.drivers.vmEnv")}>
              <PairsEditor
                pairs={draft.vmEnv}
                onChange={(vmEnv) => patch({ vmEnv })}
                addLabel={t("db.drivers.addVariable")}
              />
            </Section>
            <Row label={t("db.drivers.javaHome")} hint={t("db.drivers.javaHomeHint", { java: JAVA_RELEASE })}>
              <div className="flex items-center gap-1.5">
                <input
                  value={draft.javaHome}
                  onChange={(e) => patch({ javaHome: e.target.value })}
                  spellCheck={false}
                  autoComplete="off"
                  className={`${INPUT} font-mono`}
                />
                <GhostButton
                  onClick={() =>
                    void open({ directory: true, multiple: false }).then((picked) => {
                      if (typeof picked === "string") patch({ javaHome: picked });
                    })
                  }
                >
                  <FolderOpen size={12} />
                  {t("db.browse")}
                </GhostButton>
              </div>
            </Row>
          </>
        )}
      </div>
    </>
  );
}

/** Whether saved settings change anything — what makes "Reset to defaults" worth offering. */
function hasChanges(settings: DbDriverSettings): boolean {
  return (
    settings.class.trim() !== "" ||
    settings.files.length > 0 ||
    settings.urls.length > 0 ||
    settings.properties.length > 0 ||
    settings.vmOptions.trim() !== "" ||
    settings.vmEnv.length > 0 ||
    settings.javaHome.trim() !== ""
  );
}

/** A native driver: nothing to configure, nothing to download — said, so the absence of the
 *  JDBC sections doesn't read as something missing. */
function BuiltInDriver({ def }: { def: DriverDef }) {
  const t = useT();
  const engine = engineInfo(def.engine);
  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2.5 rounded-lg border border-[var(--cf-success)]/35 bg-[var(--cf-success)]/[0.06] p-3">
        <CheckCircle2 size={14} className="mt-[1px] shrink-0 text-[var(--cf-success)]" />
        <div className="min-w-0 text-[12px] leading-relaxed">
          <p className="font-medium text-[var(--cf-text)]">{t("db.drivers.builtIn")}</p>
          <p className="text-[var(--cf-text-muted)]">{t("db.drivers.builtInHint", { engine: engine.label })}</p>
        </div>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[12px]">
        {def.defaultPort > 0 && (
          <>
            <dt className="text-[var(--cf-text-muted)]">{t("db.port")}</dt>
            <dd className="font-mono text-[var(--cf-text)]">{def.defaultPort}</dd>
          </>
        )}
        {def.defaultUser && (
          <>
            <dt className="text-[var(--cf-text-muted)]">{t("db.user")}</dt>
            <dd className="font-mono text-[var(--cf-text)]">{def.defaultUser}</dd>
          </>
        )}
        {def.defaultDatabase && (
          <>
            <dt className="text-[var(--cf-text-muted)]">{engine.databaseLabel}</dt>
            <dd className="font-mono text-[var(--cf-text)]">{def.defaultDatabase}</dd>
          </>
        )}
      </dl>
    </div>
  );
}

/** The files a driver loads: the catalogue's, downloadable, and any the user added. */
function DriverFiles({
  def,
  draft,
  onChange,
}: {
  def: DriverDef;
  draft: DbDriverSettings;
  onChange: (partial: Partial<DbDriverSettings>) => void;
}) {
  const t = useT();
  const overview = useDriverStore((s) => s.overview);
  const settings = useDriverStore((s) => s.settings);
  const downloading = useDriverStore((s) => s.downloading.includes(def.id));
  const error = useDriverStore((s) => s.errors[def.id]);
  const progress = useDriverStore((s) => s.progress);
  const ready = driverReadiness(def, overview, settings);
  const catalogFiles = def.files ?? [];
  const status = ready.status;
  const missing = catalogFiles.filter((file) => !status?.files.find((entry) => entry.name === file.name)?.present);
  const presentCount = catalogFiles.length - missing.length;
  const version = catalogFiles[0] ? driverFileVersion(catalogFiles[0]) : "";

  const addFiles = async () => {
    const picked = await open({ multiple: true, filters: [{ name: "JAR", extensions: ["jar"] }] });
    const paths = Array.isArray(picked) ? picked : typeof picked === "string" ? [picked] : [];
    const added = paths.filter((path) => !draft.files.includes(path));
    if (added.length) onChange({ files: [...draft.files, ...added] });
  };

  const deleteFiles = async () => {
    if (!(await confirmAction(t("db.drivers.deleteFilesConfirm", { name: def.name }), true, t("db.delete")))) return;
    await useDriverStore.getState().deleteFiles(def.id);
  };

  const current = progress.filter((entry) => entry.driverId === def.id && entry.phase !== "done");

  return (
    <Section title={t("db.drivers.files")}>
      <div className="overflow-hidden rounded-md border border-[var(--cf-border)]">
        {catalogFiles.map((file) => {
          const present = status?.files.find((entry) => entry.name === file.name)?.present ?? false;
          const live = current.find((entry) => entry.item === file.name);
          return (
            <div key={file.name} className="flex items-center gap-2 border-b border-[var(--cf-border)] px-2.5 py-1.5 last:border-b-0">
              <FileArchive size={12} className="shrink-0 text-[var(--cf-text-muted)]" />
              <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-[var(--cf-text)]">{file.name}</span>
              <span className="shrink-0 tabular-nums text-[11px] text-[var(--cf-text-muted)]">
                {live?.phase === "downloading" && live.total
                  ? `${Math.round((live.done / live.total) * 100)}%`
                  : formatBytes(file.size)}
              </span>
              {present ? (
                <CheckCircle2 size={12} className="shrink-0 text-[var(--cf-success)]" aria-label={t("db.drivers.downloaded")} />
              ) : (
                <Download size={12} className="shrink-0 text-[var(--cf-text-faint)]" aria-label={t("db.drivers.notYetDownloaded")} />
              )}
            </div>
          );
        })}
        {draft.files.map((path) => (
          <div key={path} className="flex items-center gap-2 border-b border-[var(--cf-border)] px-2.5 py-1.5 last:border-b-0">
            <FileArchive size={12} className="shrink-0 text-[var(--cf-accent)]" />
            <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-[var(--cf-text)]" title={path}>
              {path}
            </span>
            <span className="shrink-0 text-[10.5px] text-[var(--cf-text-faint)]">{t("db.drivers.userFile")}</span>
            <button
              type="button"
              onClick={() => onChange({ files: draft.files.filter((entry) => entry !== path) })}
              title={t("db.delete")}
              aria-label={t("db.delete")}
              className={dangerIconButtonClass()}
            >
              <Trash2 size={11} />
            </button>
          </div>
        ))}
        {catalogFiles.length === 0 && draft.files.length === 0 && (
          <p className="px-2.5 py-2 text-[11.5px] leading-snug text-[var(--cf-text-muted)]">
            {def.manual ? t("db.drivers.manualFilesHint") : t("db.drivers.noFiles")}
          </p>
        )}
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        {missing.length > 0 && (
          <button
            type="button"
            onClick={() => void useDriverStore.getState().download(def.id)}
            disabled={downloading}
            className={buttonClass({ variant: "primary" })}
          >
            {downloading ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
            {t("db.drivers.downloadVersion", { version })}
            <span className="opacity-70">({formatBytes(driverDownloadSize({ ...def, files: missing }))})</span>
          </button>
        )}
        {missing.length === 0 && !ready.runtime && !draft.javaHome.trim() && (
          <button
            type="button"
            onClick={() => void useDriverStore.getState().download(def.id)}
            disabled={downloading}
            className={buttonClass({ variant: "primary" })}
          >
            {downloading ? <Loader2 size={12} className="animate-spin" /> : <Coffee size={12} />}
            {t("db.drivers.downloadRuntime", { java: JAVA_RELEASE })}
          </button>
        )}
        <GhostButton onClick={() => void addFiles()}>
          <Plus size={12} />
          {t("db.drivers.addFiles")}
        </GhostButton>
        {def.manual && (
          <GhostButton onClick={() => void openExternalUrl(def.manual!)}>
            <ExternalLink size={12} />
            {t("db.drivers.vendorDownloads")}
          </GhostButton>
        )}
        {presentCount > 0 && (
          <GhostButton onClick={() => void deleteFiles()} disabled={downloading}>
            <Trash2 size={12} />
            {t("db.drivers.deleteFiles")}
          </GhostButton>
        )}
      </div>
      {downloading && current.length > 0 && (
        <p className="mt-1 flex items-center gap-1.5 text-[11px] text-[var(--cf-text-muted)]">
          <Loader2 size={11} className="animate-spin" />
          <span className="truncate">{current[current.length - 1].item}</span>
        </p>
      )}
      {error && (
        <p className="mt-1.5 whitespace-pre-wrap break-words text-[11.5px] leading-snug text-[var(--cf-danger)]">
          {error}
        </p>
      )}
    </Section>
  );
}

/** The catalogue's URL templates, read-only, and the user's own before them. */
function UrlTemplates({
  def,
  catalogEntry,
  draft,
  onChange,
}: {
  def: DriverDef;
  catalogEntry: DriverDef | null;
  draft: DbDriverSettings;
  onChange: (partial: Partial<DbDriverSettings>) => void;
}) {
  const t = useT();
  const setUrl = (index: number, url: DbUrlTemplate) =>
    onChange({ urls: draft.urls.map((entry, i) => (i === index ? url : entry)) });

  return (
    <Section title={t("db.drivers.urlTemplates")} hint={t("db.drivers.templateHint")}>
      <div className="space-y-1.5">
        {draft.urls.map((url, index) => (
          <div key={index} className="flex items-center gap-1.5">
            <input
              value={url.name}
              onChange={(e) => setUrl(index, { ...url, name: e.target.value })}
              placeholder={t("db.drivers.templateName")}
              spellCheck={false}
              className={`${INPUT} w-32 shrink-0`}
            />
            <input
              value={url.template}
              onChange={(e) => setUrl(index, { ...url, template: e.target.value })}
              placeholder="jdbc:…://{host}[:{port}]/{database}"
              spellCheck={false}
              className={`${INPUT} font-mono`}
            />
            <button
              type="button"
              onClick={() => onChange({ urls: draft.urls.filter((_, i) => i !== index) })}
              title={t("db.delete")}
              aria-label={t("db.delete")}
              className={dangerIconButtonClass()}
            >
              <Trash2 size={12} />
            </button>
          </div>
        ))}
        {(catalogEntry?.urls ?? []).map((url) => (
          <div key={url.name} className="flex items-center gap-1.5 text-[11.5px]">
            <span className="w-32 shrink-0 truncate rounded-md bg-[var(--cf-hover)] px-2 py-1 text-[var(--cf-text-muted)]">
              {url.name}
            </span>
            <span className="min-w-0 flex-1 truncate rounded-md bg-[var(--cf-hover)] px-2 py-1 font-mono text-[var(--cf-text-muted)]" title={url.template}>
              {url.template}
            </span>
            <span className="w-[22px] shrink-0" />
          </div>
        ))}
        <GhostButton
          onClick={() =>
            onChange({
              urls: [
                ...draft.urls,
                { name: def.custom ? "default" : t("db.drivers.customTemplate"), template: catalogEntry?.urls?.[0]?.template ?? "" },
              ],
            })
          }
        >
          <Plus size={12} />
          {t("db.drivers.addTemplate")}
        </GhostButton>
      </div>
    </Section>
  );
}

/** The Java runtime the driver runs on: the shared download, or a Java home of the user's own. */
function RuntimeBox({ draft }: { draft: DbDriverSettings }) {
  const t = useT();
  const runtime = useDriverStore((s) => s.overview?.runtime ?? null);
  const deleting = useDriverStore((s) => s.downloading.length > 0);

  const remove = async () => {
    if (!(await confirmAction(t("db.drivers.deleteRuntimeConfirm"), true, t("db.delete")))) return;
    await useDriverStore.getState().deleteRuntime();
  };

  return (
    <Section title={t("db.drivers.runtime")}>
      <div className="flex items-center gap-2 rounded-md border border-[var(--cf-border)] px-2.5 py-2 text-[12px]">
        <Coffee size={13} className="shrink-0 text-[var(--cf-text-muted)]" />
        <span className="min-w-0 flex-1 leading-snug text-[var(--cf-text)]">
          {draft.javaHome.trim()
            ? t("db.drivers.runtimeCustom", { path: draft.javaHome.trim() })
            : runtime?.ready
              ? t("db.drivers.runtimeReady", { java: runtime.java, release: runtime.release ?? "" })
              : t("db.drivers.runtimeMissing", { java: runtime?.java ?? JAVA_RELEASE })}
        </span>
        {!draft.javaHome.trim() && runtime?.ready && (
          <GhostButton onClick={() => void remove()} disabled={deleting}>
            <Trash2 size={12} />
            {t("db.drivers.deleteRuntime")}
          </GhostButton>
        )}
      </div>
    </Section>
  );
}

/** Key/value rows: connection properties, environment variables. */
function PairsEditor({
  pairs,
  onChange,
  addLabel,
}: {
  pairs: [string, string][];
  onChange: (pairs: [string, string][]) => void;
  addLabel: string;
}) {
  const t = useT();
  return (
    <div className="space-y-1.5">
      {pairs.map(([key, value], index) => (
        <div key={index} className="flex items-center gap-1.5">
          <input
            value={key}
            onChange={(e) => onChange(pairs.map((entry, i) => (i === index ? [e.target.value, entry[1]] : entry)))}
            placeholder={t("db.optionKey")}
            spellCheck={false}
            className={`${INPUT} font-mono`}
          />
          <input
            value={value}
            onChange={(e) => onChange(pairs.map((entry, i) => (i === index ? [entry[0], e.target.value] : entry)))}
            placeholder={t("db.optionValue")}
            spellCheck={false}
            className={`${INPUT} font-mono`}
          />
          <button
            type="button"
            onClick={() => onChange(pairs.filter((_, i) => i !== index))}
            title={t("db.delete")}
            aria-label={t("db.delete")}
            className={dangerIconButtonClass()}
          >
            <Trash2 size={12} />
          </button>
        </div>
      ))}
      <GhostButton onClick={() => onChange([...pairs, ["", ""]])}>
        <Plus size={12} />
        {addLabel}
      </GhostButton>
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <span className="mb-[5px] block text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]">
        {title}
      </span>
      {hint && <p className="mb-1.5 text-[11px] leading-snug text-[var(--cf-text-muted)]">{hint}</p>}
      {children}
    </div>
  );
}

function ListButton({
  onClick,
  title,
  disabled,
  children,
}: {
  onClick: () => void;
  title: string;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      disabled={disabled}
      className="inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-[var(--cf-press)] hover:text-[var(--cf-text)] disabled:pointer-events-none disabled:opacity-40"
    >
      {children}
    </button>
  );
}
