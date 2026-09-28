import { parse as parseYaml, parseAllDocuments } from "yaml";
import type { BranchInfo, PipelineVariable } from "../../types/domain";

/**
 * The "Run pipeline" form, worked out from the pipeline's own file.
 *
 * Each host declares what a hand-started run may be given in a different place and a different
 * shape, and none of them serves the declaration through its API in a form worth using:
 *
 *  - **GitHub** — `on.workflow_dispatch.inputs` in the workflow file. Five types: `string`,
 *    `boolean`, `choice`, `number`, `environment`. Whether the workflow can be dispatched *at all* is
 *    also only in the file, which is why the dialog reads every workflow before listing it.
 *  - **GitLab** — two things. The top-level `variables:` that carry a `description` are the ones
 *    GitLab's own "Run pipeline" page pre-fills (with `options:` as a dropdown); and a `spec:inputs`
 *    header, in its own YAML document before a `---`, declares typed inputs.
 *  - **Azure** — the runtime `parameters:` list at the top of the pipeline: `string`, `number`,
 *    `boolean`, `values:` for a dropdown, and a family of structured types (`object`, `stepList`…)
 *    whose value is YAML.
 *
 * All three collapse into one field model, [`RunField`], so the form is drawn once. Parsing never
 * throws: a file that isn't what we expected is an answer (`invalid`), and the dialog then says it
 * couldn't read the inputs instead of guessing at them.
 */

/** How a field is drawn and what it sends. `yaml` is a structured value typed as YAML text. */
export type RunFieldType = "string" | "boolean" | "choice" | "number" | "environment" | "yaml";

export interface RunField {
  /** The key the host takes. */
  name: string;
  /** What the host's own form would say about it, when the file says anything. Shown as a hint. */
  description: string | null;
  type: RunFieldType;
  /** A value has to be given — no default, and the host refuses a run without one. */
  required: boolean;
  /** The form's starting value: the default as text (`"true"`/`"false"` for a boolean). */
  initial: string;
  /** The allowed values, for `choice`. Empty for an `environment`, whose options the repository
   *  supplies at render time. */
  options: string[];
}

/** One GitLab variable the file pre-fills, the way GitLab's own "Run pipeline" page does. */
export interface PrefilledVariable {
  key: string;
  value: string;
  description: string | null;
  /** `options:` — the value then comes from a dropdown. */
  options: string[];
}

export type DispatchSpec =
  /** The workflow declares `workflow_dispatch`; `fields` may be empty. */
  | { kind: "dispatch"; fields: RunField[] }
  /** A workflow, readable, that cannot be started by hand. */
  | { kind: "none" }
  /** Not YAML, or not a workflow. */
  | { kind: "invalid" };

export interface GitlabRunSpec {
  variables: PrefilledVariable[];
  inputs: RunField[];
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A scalar default as the text a field holds. Objects and arrays become YAML-ish JSON. */
function asText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/** `true`, `"true"` and `"TRUE"` are all a yes. GitHub accepts either spelling in the file. */
function asBooleanText(value: unknown): string {
  if (value === true) return "true";
  if (typeof value === "string" && value.trim().toLowerCase() === "true") return "true";
  return "false";
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function parseDocument(text: string): unknown {
  try {
    return parseYaml(text);
  } catch {
    return undefined;
  }
}

/**
 * The `on:` of a workflow, whichever key the parser filed it under.
 *
 * The `yaml` package reads YAML 1.2, where `on` is a string. A YAML 1.1 reader turns an unquoted
 * `on` into `true` — the famous trap — and a file that was round-tripped through one arrives here
 * keyed `"true"`. Both are the trigger block.
 */
function triggersOf(doc: Json): unknown {
  return doc.on ?? doc["true"];
}

/**
 * Reads `workflow_dispatch` and its inputs out of a GitHub workflow file.
 *
 * The trigger can be written three ways and all three are dispatchable: `on: workflow_dispatch`,
 * `on: [push, workflow_dispatch]`, and a mapping with a `workflow_dispatch:` key — whose value may
 * be empty (`workflow_dispatch:` alone is YAML `null`, and means "no inputs").
 */
export function parseDispatchInputs(yamlText: string): DispatchSpec {
  const doc = parseDocument(yamlText);
  if (!isObject(doc) || !isObject(doc.jobs) || triggersOf(doc) === undefined) return { kind: "invalid" };

  const on = triggersOf(doc);
  if (on === "workflow_dispatch") return { kind: "dispatch", fields: [] };
  if (Array.isArray(on)) {
    return on.includes("workflow_dispatch") ? { kind: "dispatch", fields: [] } : { kind: "none" };
  }
  if (!isObject(on) || !("workflow_dispatch" in on)) return { kind: "none" };

  const dispatch = on.workflow_dispatch;
  const inputs = isObject(dispatch) && isObject(dispatch.inputs) ? dispatch.inputs : {};
  const fields: RunField[] = [];
  for (const [name, raw] of Object.entries(inputs)) {
    // `name:` with nothing under it is a legal, untyped, optional string input.
    const spec = isObject(raw) ? raw : {};
    const declared = typeof spec.type === "string" ? spec.type.trim().toLowerCase() : "string";
    const required = spec.required === true || spec.required === "true";
    const description = textOrNull(spec.description);

    if (declared === "boolean") {
      fields.push({ name, description, type: "boolean", required, initial: asBooleanText(spec.default), options: [] });
      continue;
    }
    if (declared === "choice") {
      const options = Array.isArray(spec.options) ? spec.options.map(asText).filter((o) => o !== "") : [];
      const fallback = asText(spec.default);
      // GitHub's own form starts a choice on its default, or on the first option when there is none.
      const initial = options.includes(fallback) ? fallback : (options[0] ?? "");
      fields.push({ name, description, type: "choice", required, initial, options });
      continue;
    }
    if (declared === "number") {
      fields.push({ name, description, type: "number", required, initial: asText(spec.default), options: [] });
      continue;
    }
    if (declared === "environment") {
      fields.push({ name, description, type: "environment", required, initial: asText(spec.default), options: [] });
      continue;
    }
    // `string`, and any type GitHub adds after this was written: text is what every input is on the
    // wire, so a text box is the one control that can't send something the workflow won't accept.
    fields.push({ name, description, type: "string", required, initial: asText(spec.default), options: [] });
  }
  return { kind: "dispatch", fields };
}

/**
 * The typed inputs of a GitLab `spec:inputs` header.
 *
 * An input with no `default` is mandatory — that is GitLab's rule, not a guess. `options:` makes a
 * dropdown; `array` is structured, so it is typed as YAML.
 */
function gitlabInputs(spec: unknown): RunField[] {
  if (!isObject(spec) || !isObject(spec.inputs)) return [];
  const fields: RunField[] = [];
  for (const [name, raw] of Object.entries(spec.inputs)) {
    const input = isObject(raw) ? raw : {};
    const declared = typeof input.type === "string" ? input.type.trim().toLowerCase() : "string";
    const required = !("default" in input);
    const description = textOrNull(input.description);
    const options = Array.isArray(input.options) ? input.options.map(asText) : [];
    if (declared === "boolean") {
      fields.push({ name, description, type: "boolean", required: false, initial: asBooleanText(input.default), options: [] });
    } else if (declared === "array") {
      fields.push({ name, description, type: "yaml", required, initial: required ? "" : JSON.stringify(input.default ?? []), options: [] });
    } else if (options.length > 0) {
      const fallback = asText(input.default);
      fields.push({ name, description, type: "choice", required, initial: options.includes(fallback) ? fallback : (options[0] ?? ""), options });
    } else {
      fields.push({ name, description, type: declared === "number" ? "number" : "string", required, initial: asText(input.default), options: [] });
    }
  }
  return fields;
}

/**
 * What GitLab's own "Run pipeline" page would show for this `.gitlab-ci.yml`.
 *
 * Only variables with a `description` are pre-filled — GitLab's rule, and a sensible one: a
 * top-level variable without one is configuration, not a question for the person pressing Run. The
 * file can be two YAML documents (a `spec:` header, `---`, the configuration), which a single-document
 * parse refuses outright; hence `parseAllDocuments`.
 */
export function parseGitlabRunSpec(yamlText: string): GitlabRunSpec | null {
  let docs: unknown[];
  try {
    const list = [...parseAllDocuments(yamlText)];
    // `parseAllDocuments` reports errors on the documents rather than throwing them.
    if (list.some((doc) => doc.errors.length > 0)) return null;
    docs = list.map((doc) => doc.toJS() as unknown);
  } catch {
    return null;
  }
  if (docs.length === 0 || !docs.every((doc) => doc === null || isObject(doc))) return null;

  let inputs: RunField[] = [];
  const variables: PrefilledVariable[] = [];
  for (const doc of docs) {
    if (!isObject(doc)) continue;
    if (isObject(doc.spec)) inputs = gitlabInputs(doc.spec);
    if (!isObject(doc.variables)) continue;
    for (const [key, raw] of Object.entries(doc.variables)) {
      if (!isObject(raw)) continue;
      const description = textOrNull(raw.description);
      if (description === null) continue;
      const options = Array.isArray(raw.options) ? raw.options.map(asText) : [];
      const value = asText(raw.value);
      variables.push({ key, value: options.length > 0 && !options.includes(value) ? (options[0] ?? "") : value, description, options });
    }
  }
  return { variables, inputs };
}

/** Azure's structured parameter types: their value is YAML, not a scalar. */
const AZURE_STRUCTURED = new Set([
  "object",
  "step",
  "steplist",
  "job",
  "joblist",
  "deployment",
  "deploymentlist",
  "stage",
  "stagelist",
]);

/**
 * The runtime `parameters:` of an Azure pipeline file.
 *
 * Azure's rule is that a parameter always has a value: one without a `default` must be given one
 * at queue time, so it is `required` here. `values:` restricts it to a dropdown. The structured
 * types (`object`, `stepList`, …) take YAML, and are sent only when edited — see [`runValues`].
 *
 * A `parameters:` *mapping* rather than a list is a template's parameters, not a pipeline's; there
 * is nothing a person can set from the Run dialog, so it reads as none.
 */
export function parseAzureParameters(yamlText: string): RunField[] | null {
  const doc = parseDocument(yamlText);
  if (doc === undefined) return null;
  if (!isObject(doc)) return doc === null ? [] : null;
  const list = doc.parameters;
  if (!Array.isArray(list)) return [];

  const fields: RunField[] = [];
  for (const raw of list) {
    if (!isObject(raw) || typeof raw.name !== "string" || raw.name.trim() === "") continue;
    const name = raw.name.trim();
    const declared = typeof raw.type === "string" ? raw.type.trim().toLowerCase() : "string";
    const hasDefault = "default" in raw;
    const description = textOrNull(raw.displayName);
    const values = Array.isArray(raw.values) ? raw.values.map(asText) : [];

    if (declared === "boolean") {
      fields.push({ name, description, type: "boolean", required: false, initial: asBooleanText(raw.default), options: [] });
    } else if (AZURE_STRUCTURED.has(declared)) {
      fields.push({
        name,
        description,
        type: "yaml",
        required: !hasDefault,
        initial: hasDefault ? JSON.stringify(raw.default) : "",
        options: [],
      });
    } else if (values.length > 0) {
      const fallback = asText(raw.default);
      fields.push({ name, description, type: "choice", required: !hasDefault, initial: values.includes(fallback) ? fallback : (values[0] ?? ""), options: values });
    } else {
      fields.push({ name, description, type: declared === "number" ? "number" : "string", required: !hasDefault, initial: asText(raw.default), options: [] });
    }
  }
  return fields;
}

/** A custom pipeline a `bitbucket-pipelines.yml` declares — what Bitbucket lets a person start by
 *  name — and the variables it asks for before it runs. */
export interface BitbucketCustomPipeline {
  name: string;
  variables: PrefilledVariable[];
}

/**
 * The custom pipelines of a `bitbucket-pipelines.yml`.
 *
 * Bitbucket's shape: `pipelines.custom` maps each name to the list of what it runs, and a list that
 * opens with a `variables:` entry asks for those before starting — each a `name`, with an optional
 * `default`, `allowed-values` (a dropdown) and `description`. The other pipelines — `default`,
 * `branches`, `tags`, `pull-requests` — are not listed: the ref picks among them, which is what the
 * dialog's branch pipeline runs.
 *
 * `null` for text that isn't YAML or has no `pipelines:` mapping; an empty list for a file with no
 * custom pipelines.
 */
export function parseBitbucketPipelines(yamlText: string): BitbucketCustomPipeline[] | null {
  const doc = parseDocument(yamlText);
  if (!isObject(doc) || !isObject(doc.pipelines)) return null;
  const custom = doc.pipelines.custom;
  if (!isObject(custom)) return [];

  const pipelines: BitbucketCustomPipeline[] = [];
  for (const [name, body] of Object.entries(custom)) {
    if (name.trim() === "") continue;
    const entries: unknown[] = Array.isArray(body) ? body : [];
    const declared = entries.find((entry): entry is Json => isObject(entry) && Array.isArray(entry.variables));
    const variables: PrefilledVariable[] = [];
    for (const raw of declared && Array.isArray(declared.variables) ? declared.variables : []) {
      if (!isObject(raw) || typeof raw.name !== "string" || raw.name.trim() === "") continue;
      const allowed = raw["allowed-values"];
      const options = Array.isArray(allowed) ? allowed.map(asText) : [];
      const value = asText(raw.default);
      variables.push({
        key: raw.name.trim(),
        value: options.length > 0 && !options.includes(value) ? (options[0] ?? "") : value,
        description: textOrNull(raw.description),
        options,
      });
    }
    pipelines.push({ name, variables });
  }
  return pipelines;
}

/** What is wrong with a field's value, as a key the dialog translates. */
export type FieldProblem = "required" | "number" | "choice" | "yaml";

/**
 * Checks every field before anything is sent.
 *
 * The hosts check too, but after the request, and in their own words: GitHub's "Unexpected value"
 * names the input and not the rule, and Azure's names neither. A rule stated under the field while
 * there is still a cursor in it is the whole reason this runs on every keystroke.
 */
export function validateFields(fields: RunField[], values: Record<string, string>): Record<string, FieldProblem> {
  const problems: Record<string, FieldProblem> = {};
  for (const field of fields) {
    const value = (values[field.name] ?? field.initial).trim();
    if (value === "") {
      if (field.required) problems[field.name] = "required";
      continue;
    }
    if (field.type === "number" && !Number.isFinite(Number(value))) problems[field.name] = "number";
    if (field.type === "choice" && field.options.length > 0 && !field.options.includes(value)) {
      problems[field.name] = "choice";
    }
    if (field.type === "yaml") {
      try {
        parseYaml(value);
      } catch {
        problems[field.name] = "yaml";
      }
    }
  }
  return problems;
}

/**
 * The field values as the request carries them, typed.
 *
 * Booleans and numbers go typed — GitLab's `spec:inputs` check their types, and GitHub and Azure
 * turn them back into text on the Rust side. A structured (`yaml`) value is sent parsed, and only
 * when it was edited: left as the file wrote it, the file's own default applies, which is exactly
 * what it would have been — minus a round trip through a text box that could only lose formatting.
 * An empty optional field is left out for the same reason: the host's default is what "empty" means.
 */
export function runValues(fields: RunField[], values: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const raw = values[field.name] ?? field.initial;
    const value = raw.trim();
    if (field.type === "boolean") {
      out[field.name] = value === "true";
      continue;
    }
    if (value === "" && !field.required) continue;
    if (field.type === "number") {
      out[field.name] = Number(value);
    } else if (field.type === "yaml") {
      if (raw === field.initial) continue;
      try {
        out[field.name] = parseYaml(value) as unknown;
      } catch {
        out[field.name] = value;
      }
    } else {
      out[field.name] = raw;
    }
  }
  return out;
}

/** One row of the variables editor. `id` is only for React's keys and the problem map. */
export interface VariableRow {
  id: string;
  key: string;
  value: string;
  masked: boolean;
  /**
   * The default a declared row started from — a GitLab pre-filled variable, an Azure overridable
   * one. A row still holding it is not sent: see [`variablesToSend`].
   */
  initial?: string;
}

export type VariableProblem = "name" | "duplicate" | "empty";

/**
 * The rules each host applies to a variable's name, stated before the request instead of after.
 *
 * GitLab takes letters, digits and `_`; Azure adds `.`. A row that is completely empty is simply
 * skipped — a trailing blank row is how the editor offers "add another" — but a row with a value and
 * no name is a mistake.
 */
export function validateVariables(rows: VariableRow[], provider: string): Record<string, VariableProblem> {
  const problems: Record<string, VariableProblem> = {};
  const allowed = provider === "azure" ? /^[A-Za-z0-9_.]+$/ : /^[A-Za-z0-9_]+$/;
  const seen = new Set<string>();
  for (const row of rows) {
    const key = row.key.trim();
    if (key === "") {
      if (row.value !== "") problems[row.id] = "empty";
      continue;
    }
    // A declared row left at its default is not sent (see `variablesToSend`), and its name is the
    // host's own — not something to hold the Run button over.
    if (row.initial !== undefined && row.value === row.initial) {
      seen.add(key.toLowerCase());
      continue;
    }
    if (!allowed.test(key)) {
      problems[row.id] = "name";
      continue;
    }
    const folded = key.toLowerCase();
    if (seen.has(folded)) problems[row.id] = "duplicate";
    seen.add(folded);
  }
  return problems;
}

/**
 * The rows as the request carries them: named ones only, names trimmed — and a declared row only
 * once it has been changed.
 *
 * Left at its default, a declared variable is the host's own default already, and sending it back
 * can only do harm: an Azure secret comes out of the API *empty* (the server never returns a
 * secret's value), so echoing it would run the pipeline with the secret blanked out.
 */
export function variablesToSend(rows: VariableRow[]): PipelineVariable[] {
  return rows
    .filter((row) => row.key.trim() !== "")
    .filter((row) => row.initial === undefined || row.value !== row.initial)
    .map((row) => ({ key: row.key.trim(), value: row.value, masked: row.masked }));
}

/** What a masked value is shown as, wherever the value itself must not be. */
export const MASK = "••••••";

/**
 * The lines the confirmation lists under "Run X on main?": every input and variable, the masked ones
 * as [`MASK`]. The confirmation is the last look before an outward action, so it shows what will be
 * sent rather than what the form happens to display.
 */
export function confirmationLines(
  fields: RunField[],
  values: Record<string, string>,
  variables: PipelineVariable[],
): string[] {
  const lines: string[] = [];
  const typed = runValues(fields, values);
  for (const field of fields) {
    if (!(field.name in typed)) continue;
    const value = typed[field.name];
    lines.push(`${field.name} = ${typeof value === "string" ? value : JSON.stringify(value)}`);
  }
  for (const variable of variables) {
    lines.push(`${variable.key} = ${variable.masked ? MASK : variable.value}`);
  }
  return lines;
}

export interface RefChoices {
  branches: string[];
  tags: string[];
}

/**
 * The refs the picker offers: the branches the remote knows, then the tags.
 *
 * The *remote's* branches, because the run happens on the host — a branch that exists only here is
 * one the host will answer "no such ref" to. They arrive as `origin/feature/x` and are offered as
 * `feature/x`, which is what every host takes. The checked-out branch is kept even when the
 * remote-tracking list doesn't have it (a push the local refs haven't caught up with), and it goes
 * first, then the default branch: the two a person is almost always about to pick.
 */
export function refChoices(
  branches: BranchInfo[],
  current: string | null,
  defaultBranch: string | null,
  tags: string[],
): RefChoices {
  const remote = new Set<string>();
  for (const branch of branches) {
    if (!branch.is_remote) continue;
    const slash = branch.name.indexOf("/");
    const short = slash >= 0 ? branch.name.slice(slash + 1) : branch.name;
    if (short === "" || short === "HEAD") continue;
    remote.add(short);
  }
  const ordered: string[] = [];
  for (const first of [current, defaultBranch]) {
    if (first && !ordered.includes(first)) ordered.push(first);
  }
  for (const name of [...remote].sort((a, b) => a.localeCompare(b))) {
    if (!ordered.includes(name)) ordered.push(name);
  }
  return { branches: ordered, tags: [...new Set(tags)].sort((a, b) => b.localeCompare(a, undefined, { numeric: true })) };
}
