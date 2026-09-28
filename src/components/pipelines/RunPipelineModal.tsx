import { useEffect, useMemo, useRef, useState } from "react";
import { Info, Play } from "lucide-react";
import {
  listTags,
  pipelineDefinitionFile,
  pipelineLaunchContext,
  readFileText,
} from "../../lib/tauri/commands";
import { useCiStore } from "../../state/ciStore";
import { useConfirmStore } from "../../state/confirmStore";
import { useT } from "../../state/languageStore";
import { useRepoStore } from "../../state/repoStore";
import { pushErrorToast, pushSuccessToast } from "../../state/toastStore";
import { ApiModal, GhostButton, PrimaryButton } from "../api/ApiModal";
import { Checkbox } from "../common/Checkbox";
import { chipClass, fieldClass } from "../common/recipes";
import { Select, type SelectItems } from "../common/Select";
import { Skeleton } from "../common/Skeleton";
import { Tooltip } from "../common/Tooltip";
import { VariablesEditor, newRowId, type EditorRow } from "./VariablesEditor";
import {
  confirmationLines,
  parseAzureParameters,
  parseBitbucketPipelines,
  parseDispatchInputs,
  parseGitlabRunSpec,
  refChoices,
  runValues,
  validateFields,
  validateVariables,
  variablesToSend,
  type FieldProblem,
  type RunField,
} from "./runInputs";
import type { TranslationKey } from "../../lib/i18n/translations";
import type { PipelineDefinition, PipelineLaunchContext } from "../../types/domain";

/**
 * What a definition can be given, at one ref.
 *
 * `unreadable` is not an error: the file could not be read from the working copy or from the host
 * (a classic Azure definition has none; a token without contents access can't fetch it), and the
 * run then goes with the file's own defaults — the dialog says so rather than inventing a form.
 * `not-dispatchable` is GitHub's alone: the workflow at this ref has no `workflow_dispatch`, and
 * GitHub would refuse the run.
 */
type Spec =
  | { status: "loading" }
  | { status: "ready"; fields: RunField[]; prefilled: EditorRow[]; source: "local" | "host" | null }
  | { status: "unreadable" }
  | { status: "not-dispatchable" };

const PROBLEM: Record<FieldProblem, TranslationKey> = {
  required: "pipelines.fieldRequired",
  number: "pipelines.fieldNumber",
  choice: "pipelines.fieldChoice",
  yaml: "pipelines.fieldYaml",
};

/** The definition ids a Bitbucket launch context uses — the mirror of `ci::bitbucket`'s
 *  `BRANCH_DEFINITION` and `CUSTOM_PREFIX`. The ref picks the branch pipeline; a custom one is named. */
const BITBUCKET_BRANCH = "branch";
const BITBUCKET_CUSTOM = "custom:";

/**
 * The custom pipelines a Bitbucket repository declares, added beside the branch pipeline the backend
 * lists — read out of `bitbucket-pipelines.yml`, the working copy first and the host's copy on the
 * default branch as the fallback, the same order a spec is read in. A file that can't be read leaves
 * the branch pipeline alone, which is still a run.
 */
async function withBitbucketCustomPipelines(
  context: PipelineLaunchContext,
  projectId: string,
  localPath: string,
  atRef: string | null,
  branchLabel: string,
): Promise<PipelineLaunchContext> {
  const base = context.definitions.find((definition) => definition.id === BITBUCKET_BRANCH);
  if (!base?.path) return context;
  const path = base.path;
  const text =
    (await readFileText(localPath, path).catch(() => null)) ??
    (await pipelineDefinitionFile(projectId, path, atRef).catch(() => null));
  const custom = text ? (parseBitbucketPipelines(text) ?? []) : [];
  return {
    ...context,
    definitions: [
      { ...base, name: branchLabel },
      ...custom.map((pipeline) => ({ ...base, id: `${BITBUCKET_CUSTOM}${pipeline.name}`, name: `custom: ${pipeline.name}` })),
    ],
  };
}

/** Reads one file's text into a spec, or `null` when the text isn't the file we expected — the
 *  caller then tries the next place it could come from. */
function specFrom(definition: PipelineDefinition, text: string): Spec | null {
  const provider = definition.provider;
  if (provider === "github") {
    const parsed = parseDispatchInputs(text);
    if (parsed.kind === "invalid") return null;
    if (parsed.kind === "none") return { status: "not-dispatchable" };
    return { status: "ready", fields: parsed.fields, prefilled: [], source: null };
  }
  if (provider === "gitlab") {
    const parsed = parseGitlabRunSpec(text);
    if (!parsed) return null;
    return {
      status: "ready",
      fields: parsed.inputs,
      prefilled: parsed.variables.map((variable) => ({
        id: newRowId(),
        key: variable.key,
        value: variable.value,
        initial: variable.value,
        masked: false,
        fixed: true,
        options: variable.options,
        description: variable.description,
      })),
      source: null,
    };
  }
  if (provider === "bitbucket") {
    const pipelines = parseBitbucketPipelines(text);
    if (!pipelines) return null;
    if (!definition.id.startsWith(BITBUCKET_CUSTOM)) return { status: "ready", fields: [], prefilled: [], source: null };
    const custom = pipelines.find((pipeline) => pipeline.name === definition.id.slice(BITBUCKET_CUSTOM.length));
    // Not in this ref's file: the next place to read it from may have it.
    if (!custom) return null;
    return {
      status: "ready",
      fields: [],
      prefilled: custom.variables.map((variable) => ({
        id: newRowId(),
        key: variable.key,
        value: variable.value,
        // No `initial`, unlike GitLab's pre-filled rows: every declared Bitbucket variable is sent,
        // defaults included, so the run gets exactly what the confirmation lists. A default here
        // is the file's, never a secret the API blanked.
        masked: false,
        fixed: true,
        options: variable.options,
        description: variable.description,
      })),
      source: null,
    };
  }
  const parsed = parseAzureParameters(text);
  if (!parsed) return null;
  return { status: "ready", fields: parsed, prefilled: [], source: null };
}

/**
 * Starts a run by hand: pick the pipeline, the ref, fill in what it declares, run.
 *
 * **Where the form comes from.** The pipeline's own file — the working copy first, the host's copy
 * as the fallback. The order flips when the ref picked is not the one checked out: the working copy
 * then holds some *other* commit's idea of the inputs, and the host's copy at that ref is the one
 * the run will actually read. The badge next to the inputs says which was used, the same way the
 * graph's badge says where its columns came from.
 *
 * **Behind a confirmation naming the ref.** Starting a pipeline is an outward action — it spends
 * runner minutes and can deploy — so the last step lists exactly what will be sent, hidden values
 * as `••••••`.
 */
export function RunPipelineModal({
  projectId,
  localPath,
  onClose,
}: {
  projectId: string;
  localPath: string;
  onClose: () => void;
}) {
  const t = useT();
  const branches = useRepoStore((s) => s.branches);
  const currentBranch = useRepoStore((s) => s.status?.current_branch ?? null);
  const startRun = useCiStore((s) => s.startRun);

  const [context, setContext] = useState<PipelineLaunchContext | null>(null);
  const [contextError, setContextError] = useState("");
  /** GitHub only: which workflows declare `workflow_dispatch`, once every file has been read. */
  const [dispatchable, setDispatchable] = useState<Set<string> | null>(null);
  const [tags, setTags] = useState<string[]>([]);
  const [definitionId, setDefinitionId] = useState("");
  const [ref, setRef] = useState("");
  const [spec, setSpec] = useState<Spec>({ status: "loading" });
  const [values, setValues] = useState<Record<string, string>>({});
  const [rows, setRows] = useState<EditorRow[]>([]);
  const [submitting, setSubmitting] = useState(false);
  /** Specs already read, by `${definition}@${ref}` — switching back and forth costs nothing. */
  const specs = useRef(new Map<string, Spec>());

  useEffect(() => {
    let cancelled = false;
    void pipelineLaunchContext(projectId)
      .then(async (fetched) => {
        const loaded =
          fetched.provider === "bitbucket"
            ? await withBitbucketCustomPipelines(
                fetched,
                projectId,
                localPath,
                currentBranch ?? fetched.default_branch ?? null,
                t("pipelines.runBitbucketBranch"),
              )
            : fetched;
        if (cancelled) return;
        setContext(loaded);
        setRef(currentBranch ?? loaded.default_branch ?? "");
      })
      .catch((e: unknown) => {
        if (!cancelled) setContextError(String(e));
      });
    // Tags are offered alongside branches; a repository without any simply offers none.
    void listTags(localPath)
      .then((found) => {
        if (!cancelled) setTags(found.map((tag) => tag.name));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // `currentBranch` is read once, as the starting ref — a checkout while the dialog is open must
    // not move the ref the user may already have picked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, localPath]);

  const provider = context?.provider ?? "github";

  /**
   * Reads a definition's file at a ref: working copy and host in the order the ref calls for.
   * Cached per definition and ref.
   */
  const readSpec = async (definition: PipelineDefinition, atRef: string): Promise<Spec> => {
    const key = `${definition.id}@${atRef}`;
    const known = specs.current.get(key);
    if (known) return known;
    let found: Spec = { status: "unreadable" };
    if (!definition.path || (definition.provider === "bitbucket" && definition.id === BITBUCKET_BRANCH)) {
      // A classic Azure definition, or a GitLab config living in another project: nothing to read,
      // and nothing wrong — the run takes the defaults stored with it. Bitbucket's branch pipeline
      // asks nothing at all: the ref decides which pipeline runs.
      found = { status: "ready", fields: [], prefilled: [], source: null };
    } else {
      const path = definition.path;
      const localFirst = atRef === "" || atRef === currentBranch;
      const order: ("local" | "host")[] = localFirst ? ["local", "host"] : ["host", "local"];
      for (const source of order) {
        const text =
          source === "local"
            ? await readFileText(localPath, path).catch(() => null)
            : await pipelineDefinitionFile(projectId, path, atRef || null).catch(() => null);
        if (text === null) continue;
        const read = specFrom(definition, text);
        if (!read) continue;
        found = read.status === "ready" ? { ...read, source } : read;
        break;
      }
    }
    specs.current.set(key, found);
    return found;
  };

  // GitHub lists every workflow; only the file says which can be started by hand. Each one is read
  // once (working copy, then the default branch on the host), and the ones that can't be read at
  // all are kept: GitHub will say whether they can be dispatched, and dropping them would hide every
  // workflow from a token that can run workflows but not read files.
  useEffect(() => {
    if (!context) return;
    let cancelled = false;
    if (context.provider !== "github") {
      setDispatchable(new Set(context.definitions.map((definition) => definition.id)));
      return;
    }
    void Promise.all(
      context.definitions.map(async (definition) => {
        const read = await readSpec(definition, currentBranch ?? context.default_branch ?? "");
        return read.status === "not-dispatchable" ? null : definition.id;
      }),
    ).then((ids) => {
      if (!cancelled) setDispatchable(new Set(ids.filter((id): id is string => id !== null)));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context]);

  const definitions = useMemo(
    () => (context && dispatchable ? context.definitions.filter((d) => dispatchable.has(d.id)) : []),
    [context, dispatchable],
  );

  // The first startable definition is picked for you; a definition that vanished (it can't happen
  // mid-dialog, but a stale id is cheap to guard) falls back the same way.
  useEffect(() => {
    if (definitions.length === 0) return;
    if (!definitions.some((definition) => definition.id === definitionId)) setDefinitionId(definitions[0].id);
  }, [definitions, definitionId]);

  const definition = definitions.find((candidate) => candidate.id === definitionId) ?? null;

  // A different pipeline starts from its own defaults: an input called `environment` in one workflow
  // says nothing about the one called that in another. The declared variables of an Azure
  // definition are rows from the start, their names fixed.
  useEffect(() => {
    if (!definition) return;
    setValues({});
    setRows(
      definition.variables.map((variable) => ({
        id: newRowId(),
        key: variable.name,
        value: variable.value,
        // Untouched, it isn't sent — which is what keeps a secret (always empty here) from being
        // overridden with nothing. See `variablesToSend`.
        initial: variable.value,
        masked: variable.secret,
        fixed: true,
      })),
    );
  }, [definition]);

  useEffect(() => {
    if (!definition) return;
    let cancelled = false;
    setSpec({ status: "loading" });
    void readSpec(definition, ref).then((read) => {
      if (cancelled) return;
      setSpec(read);
      if (read.status !== "ready") return;
      // What the user already typed survives a change of ref; what the new file doesn't declare goes.
      setValues((previous) =>
        Object.fromEntries(read.fields.map((field) => [field.name, previous[field.name] ?? field.initial])),
      );
      if (read.prefilled.length > 0) {
        setRows((previous) => {
          const typed = previous.filter((row) => !read.prefilled.some((pre) => pre.key === row.key));
          const merged = read.prefilled.map((pre) => {
            const earlier = previous.find((row) => row.key === pre.key);
            return earlier ? { ...pre, value: earlier.value, masked: earlier.masked } : pre;
          });
          return [...merged, ...typed];
        });
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [definition, ref]);

  const choices = useMemo(
    () => refChoices(branches, currentBranch, context?.default_branch ?? null, tags),
    [branches, currentBranch, context?.default_branch, tags],
  );
  const refOptions = useMemo<SelectItems>(() => {
    const items: SelectItems = [
      { label: t("pipelines.runBranches"), options: choices.branches.map((name) => ({ value: name, label: name })) },
    ];
    if (choices.tags.length > 0) {
      items.push({ label: t("pipelines.runTags"), options: choices.tags.map((name) => ({ value: name, label: name })) });
    }
    return items;
  }, [choices, t]);

  const fields = spec.status === "ready" ? spec.fields : [];
  const problems = validateFields(fields, values);
  const variableProblems = validateVariables(rows, provider);
  // GitHub takes inputs only; a Bitbucket pipeline takes variables only when it is a custom one —
  // the branch pipeline is whatever the ref's push would run, with no questions to ask.
  const takesVariables =
    provider !== "github" && !(provider === "bitbucket" && !(definition?.id.startsWith(BITBUCKET_CUSTOM) ?? false));
  // Nor does Bitbucket declare typed inputs, so its section only appears to say the file couldn't be read.
  const showInputs = provider !== "bitbucket" || spec.status !== "ready";
  const ready =
    definition !== null &&
    ref.trim() !== "" &&
    (spec.status === "ready" || spec.status === "unreadable") &&
    Object.keys(problems).length === 0 &&
    Object.keys(variableProblems).length === 0 &&
    !submitting;

  const run = async () => {
    if (!ready || !definition || !context) return;
    const variables = takesVariables ? variablesToSend(rows) : [];
    const lines = confirmationLines(fields, values, variables);
    const confirmed = await useConfirmStore.getState().ask({
      message: t("pipelines.runConfirm", { name: definition.name, ref }),
      danger: false,
      confirmLabel: t("pipelines.runStart"),
      items: lines.length > 0 ? lines : undefined,
    });
    if (!confirmed) return;
    setSubmitting(true);
    try {
      const runId = await startRun(
        projectId,
        context.provider,
        { definition_id: definition.id, ref, inputs: runValues(fields, values), variables },
        definition.path,
      );
      pushSuccessToast(t(runId ? "pipelines.runStarted" : "pipelines.runStartedUnseen", { name: definition.name, ref }));
      onClose();
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const loadingList = !contextError && (!context || !dispatchable);

  return (
    <ApiModal
      icon={Play}
      title={t("pipelines.runTitle")}
      width="max-w-lg"
      busy={submitting}
      dismissOnBackdrop={false}
      onClose={onClose}
      footer={
        <>
          <span className="min-w-0 flex-1" />
          <GhostButton onClick={onClose}>{t("common.cancel")}</GhostButton>
          <PrimaryButton onClick={() => void run()} disabled={!ready}>
            {t("pipelines.runStart")}
          </PrimaryButton>
        </>
      }
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3">
        {contextError ? (
          <p className="text-[12px] text-[var(--cf-danger)]">{contextError}</p>
        ) : loadingList ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-[30px] rounded-md" />
            <Skeleton className="h-[30px] rounded-md" />
          </div>
        ) : definitions.length === 0 ? (
          <Tooltip label={t("pipelines.runNone")} description={t("pipelines.runNoneHint")}>
            <span className="block text-[12px] text-[var(--cf-text-muted)]">{t("pipelines.runNone")}</span>
          </Tooltip>
        ) : (
          <>
            {definitions.length > 1 && (
              <Row label={t("pipelines.runDefinition")}>
                <Select
                  size="field"
                  value={definitionId}
                  onChange={setDefinitionId}
                  options={definitions.map((d) => ({ value: d.id, label: d.name }))}
                  ariaLabel={t("pipelines.runDefinition")}
                />
              </Row>
            )}
            <Row label={t("pipelines.runRef")}>
              <Select
                size="field"
                value={ref}
                onChange={setRef}
                options={refOptions}
                ariaLabel={t("pipelines.runRef")}
              />
            </Row>

            {showInputs && (
              <Section
                title={t(provider === "azure" ? "pipelines.runParameters" : "pipelines.runInputs")}
                badge={
                  spec.status === "ready" && spec.source !== null ? (
                    <Tooltip
                      label={spec.source === "local" ? t("pipelines.runSourceLocal") : t("pipelines.runSourceHost", { ref })}
                      description={t(spec.source === "local" ? "pipelines.runSourceLocalHint" : "pipelines.runSourceHostHint")}
                    >
                      <span className={chipClass("neutral", "h-[18px] px-1.5 text-[10.5px]")}>
                        {spec.source === "local" ? t("pipelines.runSourceLocal") : t("pipelines.runSourceHost", { ref })}
                      </span>
                    </Tooltip>
                  ) : null
                }
              >
                {spec.status === "loading" ? (
                  <Skeleton className="h-[30px] rounded-md" />
                ) : spec.status === "not-dispatchable" ? (
                  <p className="text-[12px] text-[var(--cf-danger)]">{t("pipelines.runNotDispatchable", { ref })}</p>
                ) : spec.status === "unreadable" ? (
                  <p className="text-[12px] text-[var(--cf-text-muted)]">{t("pipelines.runUnreadable")}</p>
                ) : fields.length === 0 ? null : (
                  <div className="flex flex-col gap-2">
                    {fields.map((field) => (
                      <FieldRow
                        key={field.name}
                        field={field}
                        value={values[field.name] ?? field.initial}
                        environments={context?.environments ?? []}
                        problem={problems[field.name] ? t(PROBLEM[problems[field.name]]) : null}
                        onChange={(value) => setValues((previous) => ({ ...previous, [field.name]: value }))}
                      />
                    ))}
                  </div>
                )}
              </Section>
            )}

            {takesVariables && (
              <Section title={t("pipelines.runVariables")}>
                <VariablesEditor rows={rows} onChange={setRows} provider={provider} />
              </Section>
            )}
          </>
        )}
      </div>
    </ApiModal>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium text-[var(--cf-text-muted)]">{label}</span>
      {children}
    </label>
  );
}

function Section({
  title,
  badge,
  children,
}: {
  title: string;
  badge?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className="text-[10.5px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
          {title}
        </span>
        {badge}
      </div>
      {children}
    </div>
  );
}

/** One declared input: its name (and the file's description, in the tooltip), the control its type
 *  calls for, and the rule it breaks, if it breaks one. */
function FieldRow({
  field,
  value,
  environments,
  problem,
  onChange,
}: {
  field: RunField;
  value: string;
  environments: string[];
  problem: string | null;
  onChange: (value: string) => void;
}) {
  const options = field.type === "environment" ? environments : field.options;
  const name = (
    <span className="flex min-w-0 items-center gap-1 text-[12px] font-medium">
      <span className="truncate font-mono">{field.name}</span>
      {field.required && <span className="text-[var(--cf-danger)]">*</span>}
      {field.description && (
        <Tooltip label={field.name} description={field.description}>
          <Info size={11} className="shrink-0 text-[var(--cf-text-muted)]" />
        </Tooltip>
      )}
    </span>
  );

  if (field.type === "boolean") {
    return (
      <label className="flex items-center gap-2">
        <Checkbox checked={value === "true"} onChange={(checked) => onChange(checked ? "true" : "false")} />
        {name}
      </label>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      {name}
      {(field.type === "choice" || field.type === "environment") && options.length > 0 ? (
        <Select
          size="field"
          value={value}
          onChange={onChange}
          options={[
            // An environment with no default starts empty; the empty choice is what "required"
            // then complains about, instead of the first environment being picked silently.
            ...(field.type === "environment" && !options.includes(value) ? [{ value: "", label: "—" }] : []),
            ...options.map((option) => ({ value: option, label: option })),
          ]}
          ariaLabel={field.name}
        />
      ) : field.type === "yaml" ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={3}
          spellCheck={false}
          aria-label={field.name}
          className={fieldClass({ className: "h-auto w-full resize-y py-1.5 font-mono text-[12px]" })}
        />
      ) : (
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          inputMode={field.type === "number" ? "decimal" : undefined}
          spellCheck={false}
          autoComplete="off"
          aria-label={field.name}
          aria-invalid={problem ? true : undefined}
          className={fieldClass({ className: "w-full" })}
        />
      )}
      {problem && <p className="text-[11px] text-[var(--cf-danger)]">{problem}</p>}
    </div>
  );
}
