import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { AiWand } from "../common/AiGlyph";
import { buttonClass } from "../common/Button";
import { ThinkingOrb } from "../common/ThinkingOrb";
import { Select } from "../common/Select";
import { fieldClass } from "../common/recipes";
import { Rows, asRows, str } from "./fieldRows";
import { SmartInput } from "./ParamFields";
import { apiLoadTree } from "../../lib/tauri/apiCommands";
import { flowsAiTransformCode, flowsGetFlow, flowsTableCreate, flowsTablesList, type FlowTable, type FlowTransformCode } from "../../lib/tauri/flowsCommands";
import { serializeSpec } from "../../lib/flows/spec";
import { useFlowsStore } from "../../state/flowsStore";
import { promptAction } from "../../state/promptStore";
import type { TranslationKey } from "../../lib/i18n/translations";
import { useT } from "../../state/languageStore";
import { useWorkspaceStore } from "../../state/workspaceStore";

/**
 * The editors of the parameters the third round of nodes brought: a table of Flujos («Tabla de
 * datos»), a collection of the API client, the columns of «Datos de prueba», the rules of «Validar
 * datos», and the inputs a flow declares when it is called («Ejecutar flujo › Enviar entradas»).
 */

/** A table of the workspace, by name — a flow names its table, so an exported flow finds the
 *  same-named one where it is imported. A name with no table yet is fine: the first write makes it. */
export function FlowTablePicker({ value, onChange }: { value: unknown; onChange: (next: unknown) => void }) {
  const t = useT();
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const [tables, setTables] = useState<FlowTable[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (!workspaceId) return;
    let alive = true;
    flowsTablesList(workspaceId)
      .then((rows) => alive && setTables(rows))
      .catch((error) => alive && setProblem(String(error)));
    return () => {
      alive = false;
    };
  }, [workspaceId]);
  const current = str(value);
  const options = tables.map((table) => ({ value: table.name, label: t("flows.table.rowsCount", { name: table.name, count: table.rows }) }));
  if (current && !tables.some((table) => table.name === current)) {
    options.push({ value: current, label: t("flows.table.toBeCreated", { name: current }) });
  }
  const create = async () => {
    if (!workspaceId) return;
    const name = await promptAction(t("flows.table.newPrompt"), {
      placeholder: t("flows.table.newPlaceholder"),
      confirmLabel: t("flows.table.create"),
      validate: (text) => (text.trim().length > 64 ? t("flows.table.nameTooLong") : tables.some((table) => table.name === text.trim()) ? t("flows.table.nameTaken") : null),
    });
    if (!name) return;
    try {
      const table = await flowsTableCreate(workspaceId, name);
      setTables((rows) => [...rows, table].sort((a, b) => a.name.localeCompare(b.name)));
      onChange(table.name);
    } catch (error) {
      setProblem(String(error));
    }
  };
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <div className="w-[240px]">
          <Select value={current} onChange={onChange} options={options} placeholder={tables.length ? t("flows.table.pick") : t("flows.table.none")} size="sm" />
        </div>
        <button
          type="button"
          className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[12px] text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]"
          title={t("flows.table.newHint")}
          onClick={() => void create()}
        >
          <Plus size={12} />
          {t("flows.table.new")}
        </button>
      </div>
      {problem && <span className="text-[11.5px] text-[var(--cf-text-muted)]">{problem}</span>}
    </div>
  );
}

/** A collection of the API client. */
export function ApiCollectionPicker({ value, onChange }: { value: unknown; onChange: (next: unknown) => void }) {
  const t = useT();
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const [options, setOptions] = useState<{ value: string; label: string }[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (!workspaceId) return;
    let alive = true;
    apiLoadTree(workspaceId)
      .then((tree) => {
        if (!alive) return;
        const counts = new Map<string, number>();
        for (const request of tree.requests) if (request.protocol === "http") counts.set(request.collection_id, (counts.get(request.collection_id) ?? 0) + 1);
        setOptions(
          tree.collections
            .map((collection) => ({ value: collection.id, label: t("flows.app.collectionRequests", { name: collection.name, count: counts.get(collection.id) ?? 0 }) }))
            .sort((a, b) => a.label.localeCompare(b.label)),
        );
      })
      .catch((error) => alive && setProblem(String(error)));
    return () => {
      alive = false;
    };
  }, [workspaceId, t]);
  const current = str(value);
  const shown = current && !options.some((o) => o.value === current) ? [...options, { value: current, label: current }] : options;
  return (
    <div className="flex flex-col gap-1">
      <div className="max-w-[300px]">
        <Select value={current} onChange={onChange} options={shown} placeholder={options.length ? t("flows.app.pickCollection") : t("flows.app.noCollections")} size="sm" />
      </div>
      {problem && <span className="text-[11.5px] text-[var(--cf-text-muted)]">{problem}</span>}
    </div>
  );
}

/** What «Datos de prueba» can make, in the order the menu offers them (`textkit::fake_value`). */
export const FAKE_KINDS = [
  "fullName",
  "firstName",
  "lastName",
  "email",
  "username",
  "phone",
  "rut",
  "address",
  "city",
  "region",
  "country",
  "company",
  "jobTitle",
  "product",
  "price",
  "integer",
  "decimal",
  "boolean",
  "date",
  "datetime",
  "uuid",
  "word",
  "sentence",
  "paragraph",
  "url",
  "ip",
  "color",
] as const;

export function FakeFieldsEditor({ value, onChange }: { value: unknown; onChange: (next: unknown) => void }) {
  const t = useT();
  const options = FAKE_KINDS.map((kind) => ({ value: kind, label: t(`flows.fake.${kind}` as TranslationKey) }));
  return (
    <Rows
      rows={asRows(value)}
      onChange={onChange}
      blank={() => ({ name: "", kind: "fullName" })}
      addLabel={t("flows.fake.addField")}
      render={(row, set) => (
        <>
          <input
            className={fieldClass({ size: "sm", className: "w-[130px] shrink-0 font-mono text-[11.5px]" })}
            value={str(row.name)}
            placeholder={t("flows.param.fieldName")}
            aria-label={t("flows.param.fieldName")}
            onChange={(event) => set({ ...row, name: event.target.value })}
          />
          <div className="min-w-0 flex-1">
            <Select value={str(row.kind) || "fullName"} onChange={(kind) => set({ ...row, kind })} options={options} size="sm" />
          </div>
        </>
      )}
    />
  );
}

/** The checks «Validar datos» knows (`textkit::rule_error`); the ones after `takesArgument` need one. */
export const CHECKS = [
  "required",
  "isEmail",
  "isUrl",
  "isPhone",
  "isRut",
  "isNumber",
  "isInteger",
  "isDate",
  "isUuid",
  "isCard",
  "isIban",
  "matches",
  "minLength",
  "maxLength",
  "minValue",
  "maxValue",
  "oneOf",
] as const;

const takesArgument = (check: string) => ["matches", "minLength", "maxLength", "minValue", "maxValue", "oneOf"].includes(check);

export function ValidationRulesEditor({ value, onChange }: { value: unknown; onChange: (next: unknown) => void }) {
  const t = useT();
  const options = CHECKS.map((check) => ({ value: check, label: t(`flows.check.${check}` as TranslationKey) }));
  return (
    <Rows
      rows={asRows(value)}
      onChange={onChange}
      blank={() => ({ field: "", check: "required", arg: "" })}
      addLabel={t("flows.check.addRule")}
      render={(row, set) => (
        <>
          <input
            className={fieldClass({ size: "sm", className: "w-[120px] shrink-0 font-mono text-[11.5px]" })}
            value={str(row.field)}
            placeholder={t("flows.param.fieldName")}
            aria-label={t("flows.param.fieldName")}
            onChange={(event) => set({ ...row, field: event.target.value })}
          />
          <div className="w-[150px] shrink-0">
            <Select value={str(row.check) || "required"} onChange={(check) => set({ ...row, check })} options={options} size="sm" />
          </div>
          {takesArgument(str(row.check)) && (
            <input
              className={fieldClass({ size: "sm", className: "min-w-0 flex-1 text-[12px]" })}
              value={str(row.arg)}
              placeholder={t(`flows.check.arg.${str(row.check)}` as TranslationKey)}
              aria-label={t(`flows.check.arg.${str(row.check)}` as TranslationKey)}
              onChange={(event) => set({ ...row, arg: event.target.value })}
            />
          )}
        </>
      )}
    />
  );
}

type DeclaredField = { name: string; label?: string; type?: string; required?: boolean };

/** The fields the called flow's «Llamado por otro flujo» trigger declares, read from its spec. */
function useDeclaredFields(flowId: string): DeclaredField[] | null {
  const [fields, setFields] = useState<DeclaredField[] | null>(null);
  useEffect(() => {
    if (!flowId) {
      setFields(null);
      return;
    }
    let alive = true;
    flowsGetFlow(flowId)
      .then((row) => {
        if (!alive) return;
        try {
          const spec = JSON.parse(row?.spec ?? "{}") as { nodes?: { typeId?: string; type?: string; disabled?: boolean; params?: { fields?: unknown } }[] };
          const entry = (spec.nodes ?? []).find((node) => (node.typeId ?? node.type) === "trigger.subflow" && !node.disabled);
          setFields(asRows(entry?.params?.fields).map((field) => ({ name: str(field.name), label: str(field.label), type: str(field.type), required: field.required === true })).filter((f) => f.name));
        } catch {
          setFields([]);
        }
      })
      .catch(() => alive && setFields([]));
    return () => {
      alive = false;
    };
  }, [flowId]);
  return fields;
}

/** One value per input the called flow declares — each may be an expression over this node's item. */
export function SubflowInputsEditor({ value, onChange, flowId }: { value: unknown; onChange: (next: unknown) => void; flowId: string }) {
  const t = useT();
  const fields = useDeclaredFields(flowId);
  const values = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  if (!flowId) return <p className="text-[12px] text-[var(--cf-text-muted)]">{t("flows.subflow.pickFlowFirst")}</p>;
  if (fields === null) return null;
  if (fields.length === 0) return <p className="text-[12px] text-[var(--cf-text-muted)]">{t("flows.subflow.noInputs")}</p>;
  return (
    <div className="flex flex-col gap-1.5">
      {fields.map((field) => (
        <div key={field.name} className="flex min-w-0 items-center gap-1.5">
          <span className="w-[120px] shrink-0 truncate font-mono text-[11.5px] text-[var(--cf-text-muted)]" title={field.label || field.name}>
            {field.name}
            {field.required ? <span className="text-[var(--cf-danger)]"> *</span> : null}
          </span>
          <div className="min-w-0 flex-1">
            <SmartInput
              value={str(values[field.name])}
              onChange={(next) => onChange({ ...values, [field.name]: next })}
              placeholder={field.label || `{{ $json.${field.name} }}`}
              ariaLabel={field.name}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * «Generar código» of «Transformar con IA»: the node's engine writes the JavaScript from the
 * description and the node's input in the newest run, the app tries it on that input, and it lands
 * in the node's code — where it is read, and edited, before the flow runs it.
 */
export function TransformCodeButton({
  flowId,
  nodeId,
  params,
  setParam,
}: {
  flowId: string;
  nodeId: string;
  params: Record<string, unknown>;
  setParam?: (name: string, value: unknown) => void;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<FlowTransformCode | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const goal = str(params.transformGoal).trim();
  const hasCode = str(params.code).trim() !== "";
  const generate = async () => {
    if (!goal || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const draft = useFlowsStore.getState().draft;
      const answer = await flowsAiTransformCode(flowId, nodeId, draft ? serializeSpec(draft.spec) : null, `flow-transform-${crypto.randomUUID()}`);
      setParam?.("code", answer.code);
      setResult(answer);
    } catch (error) {
      setProblem(String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-1.5 flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <button type="button" className={buttonClass({ size: "sm" })} disabled={!goal || busy} onClick={() => void generate()} title={t("flows.transform.hint")}>
          {busy ? <ThinkingOrb size="sm" /> : <AiWand size={13} />}
          {busy ? t("flows.transform.writing") : hasCode ? t("flows.transform.regenerate") : t("flows.transform.generate")}
        </button>
      </div>
      {result && !busy && (
        <div className="rounded-[5px] bg-[var(--cf-sunken)] px-2 py-1.5 text-[11.5px] leading-[1.45] text-[var(--cf-text-muted)]">
          {result.summary && <div className="text-[var(--cf-text)]">{result.summary}</div>}
          {result.error ? (
            <div className="text-[var(--cf-danger)]">{t("flows.transform.failedTry", { error: result.error })}</div>
          ) : result.tested ? (
            <div>{t("flows.transform.tried", { input: result.inputCount, output: result.outputCount ?? 0 })}</div>
          ) : (
            <div>{t("flows.transform.untried")}</div>
          )}
        </div>
      )}
      {problem && <span className="text-[11.5px] text-[var(--cf-danger)]">{problem}</span>}
    </div>
  );
}
