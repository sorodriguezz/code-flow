import { useEffect, useMemo, useState } from "react";
import { ArrowLeftRight, Minus, Pencil, Plus } from "lucide-react";
import { iconButtonClass } from "../common/Button";
import { Segmented } from "../common/Segmented";
import { Tooltip } from "../common/Tooltip";
import { fieldClass } from "../common/recipes";
import { diffSchemas, type DiffStatus, type SchemaDiff } from "../../lib/dbml/diff";
import { migrationSql, type MigrationDialect } from "../../lib/dbml/migration";
import type { DbmlSchema } from "../../lib/dbml/types";
import { quickDiffBase, readFileText } from "../../lib/tauri/commands";
import { diagramsListVersions, diagramsVersionContent } from "../../lib/tauri/diagramsCommands";
import type { DocVersion } from "../../types/notes";
import { CopyButton } from "./CopyButton";
import { TOOL_AREA, TOOL_BTN, ToolClose } from "./toolChrome";
import { useDiagramsStore } from "../../state/diagramsStore";
import { useLanguageStore, useT } from "../../state/languageStore";
import { useWorkspaceStore } from "../../state/workspaceStore";

/**
 * This schema against another one — and the SQL that would take a database from one to the other.
 *
 * The question is "what would this migration do", and a text diff cannot answer it: two documents
 * that declare the same thing in a different order, or with the settings written the other way
 * round, produce pages of red and green and no information. `diffSchemas` compares the *models*, so
 * what is listed here is only what actually changed about the database, and `migrationSql` writes
 * that list as `ALTER` statements.
 *
 * **The other side does not have to be pasted any more.** A diagram linked to a repository file can
 * be compared with that file as it is on disk and as it is at `HEAD` — "what have I changed since
 * the last commit" is the comparison people actually want before writing a migration — and any
 * diagram with the one it was at a saved version. Choosing one loads its text into the box, where
 * it can still be edited.
 *
 * The other side is the **before** by default — you are usually comparing what is deployed against
 * what you are writing — and the swap button is there because the other reading is just as common
 * when reviewing somebody else's change.
 */

type Source = "paste" | "disk" | "head" | "version";

export function DbmlDiffPanel({
  diagramId,
  schema,
  parse,
  onClose,
}: {
  diagramId: string;
  schema: DbmlSchema;
  /** The parser, handed down so the heavy chunk stays owned by the workbench. */
  parse: (source: string) => DbmlSchema;
  /** Closes the tool. This panel has no row of actions of its own, so it sits in the corner the
   *  other two put it in — top right, over the list rather than beside a verb. */
  onClose: () => void;
}) {
  const t = useT();
  const language = useLanguageStore((s) => s.language);
  const [other, setOther] = useState("");
  const [swapped, setSwapped] = useState(false);
  const [source, setSource] = useState<Source>("paste");
  const [loading, setLoading] = useState(false);
  const [sourceError, setSourceError] = useState("");
  const [versions, setVersions] = useState<DocVersion[] | null>(null);
  const [versionId, setVersionId] = useState("");
  const [view, setView] = useState<"changes" | "sql">("changes");
  const [dialect, setDialect] = useState<MigrationDialect>("postgresql");

  // Where the linked file lives, when there is one: its repository's checkout and its path in it.
  const originPath = useDiagramsStore(
    (s) => s.diagrams.find((d) => d.id === diagramId)?.origin_path ?? "",
  );
  const originProjectId = useDiagramsStore(
    (s) => s.diagrams.find((d) => d.id === diagramId)?.origin_project_id ?? "",
  );
  const repoPath = useWorkspaceStore(
    (s) =>
      Object.values(s.projectsByWorkspace)
        .flat()
        .find((project) => project.id === originProjectId)?.local_path ?? "",
  );
  const linked = originPath !== "" && repoPath !== "";

  /** Loads a source's text into the box. A failure is said in place; the box keeps what it had. */
  const load = async (next: Source, version = versionId) => {
    setSource(next);
    setSourceError("");
    if (next === "paste") return;
    setLoading(true);
    try {
      let text: string | null = null;
      if (next === "disk") text = await readFileText(repoPath, originPath);
      else if (next === "head") {
        text = await quickDiffBase(repoPath, originPath, true);
        if (text === null) setSourceError(t("dbml.diff.notInHead"));
      } else {
        const list = versions ?? (await diagramsListVersions(diagramId));
        setVersions(list);
        const chosen = version || list[0]?.id || "";
        setVersionId(chosen);
        if (!chosen) setSourceError(t("dbml.diff.noVersions"));
        else text = await diagramsVersionContent(chosen);
      }
      if (text !== null) setOther(text);
    } catch (error) {
      setSourceError(String(error));
    } finally {
      setLoading(false);
    }
  };

  // Asked for from elsewhere — the "changed on disk" question's Compare. Taken once, then cleared.
  const request = useDiagramsStore((s) => s.compareRequest);
  useEffect(() => {
    if (!request || request.diagramId !== diagramId) return;
    useDiagramsStore.getState().clearCompareRequest();
    setSwapped(false);
    void load(request.source);
    // `load` reads the state it sets; running it once per request is the intent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request, diagramId]);

  const otherSchema = useMemo(() => (other.trim() ? parse(other) : null), [other, parse]);
  const [before, after] = otherSchema
    ? swapped
      ? [schema, otherSchema]
      : [otherSchema, schema]
    : [null, null];
  const diff = useMemo<SchemaDiff | null>(
    () => (before && after ? diffSchemas(before, after) : null),
    [before, after],
  );
  const sql = useMemo(
    () => (view === "sql" && before && after ? migrationSql(before, after, dialect) : ""),
    [view, before, after, dialect],
  );

  const sources: { value: Source; label: string; title: string; disabled?: boolean }[] = [
    { value: "paste", label: t("dbml.diff.sourcePaste"), title: t("dbml.diff.sourcePasteHint") },
    { value: "disk", label: t("dbml.diff.sourceDisk"), title: linked ? originPath : t("dbml.diff.notLinked"), disabled: !linked },
    { value: "head", label: "HEAD", title: linked ? t("dbml.diff.sourceHeadHint") : t("dbml.diff.notLinked"), disabled: !linked },
    { value: "version", label: t("dbml.diff.sourceVersion"), title: t("dbml.diff.sourceVersionHint") },
  ];

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-h-0 w-[38%] shrink-0 flex-col gap-2 border-r border-[var(--cf-border)] p-3">
        <div className="flex shrink-0 items-center gap-1.5">
          <span className="text-[13px] font-medium text-[var(--cf-text)]">{t("dbml.diff.other")}</span>
          <span className="flex-1" />
          {/* A toggle, and drawn as one: lit while the other side is the *after*. It used to look
              the same either way, so which reading the list was in had to be remembered. */}
          <Tooltip label={t("dbml.diff.swap")}>
            <button
              type="button"
              onClick={() => setSwapped((current) => !current)}
              aria-label={t("dbml.diff.swap")}
              aria-pressed={swapped}
              className={iconButtonClass({ size: "md", active: swapped })}
            >
              <ArrowLeftRight size={15} />
            </button>
          </Tooltip>
        </div>
        <Segmented
          size="sm"
          full
          layoutId={`dbml-diff-source-${diagramId}`}
          value={source}
          onChange={(next) => void load(next)}
          options={sources}
          ariaLabel={t("dbml.diff.other")}
        />
        {source === "version" && versions && versions.length > 0 && (
          <select
            value={versionId}
            onChange={(event) => {
              setVersionId(event.target.value);
              void load("version", event.target.value);
            }}
            className={fieldClass({ size: "sm", className: "w-full" })}
            aria-label={t("dbml.diff.sourceVersion")}
          >
            {versions.map((version) => (
              <option key={version.id} value={version.id}>
                {new Date(version.created_at).toLocaleString(language)}
              </option>
            ))}
          </select>
        )}
        {sourceError && <p className="text-[11.5px] text-[var(--cf-warning)]">{sourceError}</p>}
        <textarea
          value={other}
          onChange={(event) => {
            setOther(event.target.value);
            // Edited by hand, it is no longer the file, HEAD or the version it was loaded from.
            if (source !== "paste") setSource("paste");
          }}
          spellCheck={false}
          disabled={loading}
          placeholder={t("dbml.diff.placeholder")}
          className={`${TOOL_AREA} min-h-0 flex-1 resize-none font-mono leading-relaxed`}
        />
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-2 px-3 pt-2 pr-12">
          <Segmented
            size="sm"
            layoutId={`dbml-diff-view-${diagramId}`}
            value={view}
            onChange={setView}
            options={[
              { value: "changes", label: t("dbml.diff.viewChanges") },
              { value: "sql", label: t("dbml.diff.viewSql"), title: t("dbml.diff.viewSqlHint") },
            ]}
          />
          {view === "sql" && (
            <>
              <Segmented
                size="sm"
                layoutId={`dbml-diff-dialect-${diagramId}`}
                value={dialect}
                onChange={setDialect}
                options={[
                  { value: "postgresql", label: "PostgreSQL" },
                  { value: "mysql", label: "MySQL" },
                ]}
              />
              <span className="flex-1" />
              {sql && <CopyButton text={sql} className={TOOL_BTN} />}
            </>
          )}
        </div>
        <div className="absolute right-3 top-2 z-10">
          <ToolClose onClose={onClose} />
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-3">
          {diff === null ? (
            <p className="text-[12px] text-[var(--cf-text-muted)]">{t("dbml.diff.empty")}</p>
          ) : !diff.changed ? (
            <p className="text-[12px] text-[var(--cf-success)]">{t("dbml.diff.noChanges")}</p>
          ) : view === "sql" ? (
            <pre className="whitespace-pre font-mono text-[11.5px] leading-relaxed text-[var(--cf-text)]">{sql}</pre>
          ) : (
            <Changes diff={diff} />
          )}
        </div>
      </div>
    </div>
  );
}

function Changes({ diff }: { diff: SchemaDiff }) {
  const t = useT();
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[12px] text-[var(--cf-text-muted)]">
        {t("dbml.diff.summary", {
          added: String(diff.counts.added),
          modified: String(diff.counts.modified),
          removed: String(diff.counts.removed),
        })}
      </p>

      <Group label={t("dbml.diff.tables")}>
        {diff.tables
          .filter((table) => table.status !== "unchanged")
          .map((table) => (
            <div key={table.id} className="rounded-lg border border-[var(--cf-border)] px-2.5 py-2">
              <div className="flex items-center gap-1.5">
                <StatusMark status={table.status} />
                <span className="font-mono text-[12px] font-semibold">{table.name}</span>
                <span className="text-[11px] text-[var(--cf-text-faint)]">
                  {t(`dbml.diff.${table.status}` as "dbml.diff.added")}
                </span>
              </div>
              {table.fields
                .filter((field) => field.status !== "unchanged")
                .map((field) => (
                  <div key={field.name} className="mt-1 flex items-baseline gap-1.5 pl-5">
                    <StatusMark status={field.status} />
                    <span className="font-mono text-[12px]">{field.name}</span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--cf-text-muted)]">
                      {field.changes
                        .map((change) => `${change.property}: ${change.before} → ${change.after}`)
                        .join(" · ")}
                    </span>
                  </div>
                ))}
            </div>
          ))}
      </Group>

      {diff.enums.some((entry) => entry.status !== "unchanged") && (
        <Group label={t("dbml.diff.enums")}>
          {diff.enums
            .filter((entry) => entry.status !== "unchanged")
            .map((entry) => (
              <div key={entry.id} className="flex items-baseline gap-1.5">
                <StatusMark status={entry.status} />
                <span className="font-mono text-[12px]">{entry.name}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--cf-text-muted)]">
                  {[
                    ...entry.added.map((value) => `+${value}`),
                    ...entry.removed.map((value) => `−${value}`),
                  ].join(" ")}
                </span>
              </div>
            ))}
        </Group>
      )}

      {diff.refs.length > 0 && (
        <Group label={t("dbml.diff.relations")}>
          {diff.refs.map((ref) => (
            <div key={`${ref.status}-${ref.key}`} className="flex items-baseline gap-1.5">
              <StatusMark status={ref.status} />
              <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{ref.key}</span>
            </div>
          ))}
        </Group>
      )}
    </div>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]">
        {label}
      </h3>
      {children}
    </section>
  );
}

/** The one-glyph statement of what happened, in the colour the rest of the app uses for it. */
function StatusMark({ status }: { status: DiffStatus }) {
  if (status === "added") return <Plus size={13} className="shrink-0 text-[var(--cf-success)]" />;
  if (status === "removed") return <Minus size={13} className="shrink-0 text-[var(--cf-danger)]" />;
  if (status === "modified") return <Pencil size={12} className="shrink-0 text-[var(--cf-warning)]" />;
  return <span className="w-[13px] shrink-0" />;
}
