import { createContext, lazy, Suspense, useContext, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useConnectors } from "../../lib/flows/connectorList";
import { CircleHelp, FolderOpen, KeyRound } from "lucide-react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { Checkbox } from "../common/Checkbox";
import { Select, type SelectOption } from "../common/Select";
import { iconButtonClass } from "../common/Button";
import { fieldClass } from "../common/recipes";
import { AssistList, useFlowAssist } from "./assist";
import { ConnectStatusLine, CredentialConnect, CredentialTestButton, type ConnectPlan, type ConnectStatus } from "./CredentialConnect";
import { LookupButton, labelFor } from "./ConnectorLookup";
import { OAUTH_CONSOLE, OAUTH_SCOPES } from "../../lib/flows/oauthScopes";
import { autoClose, complete, dropText, expressionAt, type AssistDialect, type AssistField, type Completion } from "../../lib/flows/exprAssist";
import { releasedOver, useFlowFieldDragStore } from "../../state/flowFieldDragStore";
import { ExtractRulesEditor, FormFieldsEditor } from "./RunForm";
import { Rows, asRows, str, type Row } from "./fieldRows";
import {
  AccessHint,
  AgentPicker,
  AnswerFieldsEditor,
  CategoriesEditor,
  ChainTemplatePicker,
  EngineField,
  EnginesField,
  LocalModelField,
  ApiModelField,
  McpServersField,
} from "./AiFields";
import { DbConnectionPicker, NotePicker, RemoteHostPicker, VaultItemPicker, ApiEnvironmentPicker, ApiRequestPicker } from "./AppFields";
import { visible } from "../../lib/flows/paramVisibility";
import { serializeSpec } from "../../lib/flows/spec";
import {
  CONNECTOR_CREDENTIALS,
  flowsConnectorTest,
  flowsPreviewExpression,
  type FlowConnector,
  type FlowConnectorCall,
  type FlowLabel,
  type FlowParamSpec,
  type FlowPreview,
} from "../../lib/tauri/flowsCommands";
import type { TranslationKey } from "../../lib/i18n/translations";
import { listServices } from "../../lib/tauri/services";
import type { ServiceRow } from "../../types/services";
import { useFlowsStore } from "../../state/flowsStore";
import { useFlowVaultStore } from "../../state/flowVaultStore";
import { useLanguageStore, useT } from "../../state/languageStore";
import { useWorkspaceStore } from "../../state/workspaceStore";

const CodeField = lazy(() => import("./CodeField"));

/**
 * A node's parameters as a form, drawn from the node type's declaration (`flows::params`).
 *
 * **Fixed or expression.** A value that starts with `=` is an expression (n8n's convention, which is
 * also what the engine reads): `fx` beside a field switches it, typing `{{` switches it on its own,
 * and a field dragged in from the input panel lands as `{{ $json.campo }}` in expression mode. An
 * expression shows what it evaluates to underneath, against the node's input in the newest run.
 */

export const isExpression = (value: unknown): value is string => typeof value === "string" && value.startsWith("=");

/** Where an expression's preview is evaluated — the node the form belongs to. Set by `ParamFields`,
 *  so a field nested in a list (a condition, an assignment) previews like a top-level one. */
const PreviewContext = createContext<{ flowId: string; nodeId: string } | null>(null);

const OPERATORS = [
  "equals",
  "notEquals",
  "contains",
  "notContains",
  "startsWith",
  "endsWith",
  "regex",
  "gt",
  "gte",
  "lt",
  "lte",
  "exists",
  "notExists",
  "empty",
  "notEmpty",
  "isTrue",
  "isFalse",
  "lengthEquals",
  "lengthGt",
  "lengthLt",
  "notStartsWith",
  "notEndsWith",
  "notRegex",
  "isNumber",
  "isDate",
  "isArray",
  "isObject",
] as const;

/** Operators that look at the left side only. */
export const UNARY = new Set(["exists", "notExists", "empty", "notEmpty", "isTrue", "isFalse", "isNumber", "isDate", "isArray", "isObject"]);

const ASSIGNMENT_TYPES = ["auto", "string", "number", "boolean", "array", "object"];
const AGGREGATIONS = ["count", "countUnique", "sum", "avg", "min", "max", "first", "last", "concat", "list"];

/** How a text box is read: text with `{{ }}` expressions in it. */
const EXPRESSION_FIELD: AssistField = { dialect: "expression", expressions: true };

/**
 * A text field that holds a fixed value or an expression. `value` is what is stored — `=` and all —
 * and the field shows it without the `=`.
 *
 * **It helps write the expression** (the user's ask, 2026-10-06: "muy texto libre todo"). Typing
 * `{{` closes the braces around the caret, and inside them a list offers what fits there — the
 * input's fields after `$json.`, the nodes, `$vars`, what a value can do — from `exprAssist`, with
 * the data the inspector hands down (`AssistContext`). ⌃Space or ⌘I asks for it anywhere, opening
 * braces first if the caret is outside them. A field dragged from the input lands at the caret
 * (`flowFieldDragStore`), bare inside braces and wrapped in them outside.
 */
export function SmartInput({
  value,
  onChange,
  placeholder,
  multiline = false,
  mono = false,
  className = "",
  ariaLabel,
  literal = false,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  multiline?: boolean;
  mono?: boolean;
  className?: string;
  ariaLabel?: string;
  /** A field the engine reads as written (no `fx`): `{{` stays text, and nothing is suggested or dropped. */
  literal?: boolean;
}) {
  const field = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const [over, setOver] = useState(false);
  const preview = useContext(PreviewContext);
  const context = useFlowAssist();
  const assist = literal ? null : context;
  const dragging = useFlowFieldDragStore((s) => s.drag);
  const drag = literal ? null : dragging;
  const expression = !literal && isExpression(value);
  const shown = expression ? value.slice(1) : value;
  const write = (text: string) => onChange(expression || (!literal && text.includes("{{")) ? `=${text}` : text);
  /** The open suggestions, and the caret they were worked out for. */
  const [list, setList] = useState<{ completion: Completion; active: number; caret: number } | null>(null);
  /** Where the caret goes once a change this field made is on screen — and whether to ask again there. */
  const caretAfter = useRef<{ at: number; again: boolean } | null>(null);

  const suggest = (text: string, caret: number) => {
    const completion = assist ? complete(text, caret, EXPRESSION_FIELD, assist.data) : null;
    if (completion?.wants) assist?.want(completion.wants);
    setList(completion && (completion.items.length > 0 || completion.noInput) ? { completion, active: 0, caret } : null);
  };

  useLayoutEffect(() => {
    const el = field.current;
    const after = caretAfter.current;
    if (!el || !after) return;
    caretAfter.current = null;
    el.setSelectionRange(after.at, after.at);
    if (after.again) suggest(el.value, after.at);
    // `suggest` reads the render's own values; the text is what this waits for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown]);

  // A node's output arriving (asked for by `want`) sharpens a list that is open.
  useEffect(() => {
    const el = field.current;
    if (list && el) suggest(el.value, el.selectionStart ?? el.value.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assist?.data]);

  // While a field is being dragged: light up under the pointer, and take it if let go here.
  useEffect(() => {
    if (!drag) {
      setOver(false);
      return;
    }
    const drop = (event: PointerEvent) => {
      const el = field.current;
      if (!el || !releasedOver(el, event)) return;
      const focused = document.activeElement === el;
      const at = focused ? el.selectionStart ?? shown.length : shown.length;
      const end = focused ? el.selectionEnd ?? at : at;
      const dropped = dropText(drag.path, EXPRESSION_FIELD, shown, at);
      useFlowFieldDragStore.getState().end();
      if (!dropped) return;
      // Braces dropped against a word would weld onto it.
      const pad = dropped.expression && at > 0 && /\S/.test(shown[at - 1]) ? " " : "";
      caretAfter.current = { at: at + pad.length + dropped.insert.length, again: false };
      onChange(`=${shown.slice(0, at)}${pad}${dropped.insert}${shown.slice(end)}`);
      el.focus();
    };
    window.addEventListener("pointerup", drop, true);
    return () => window.removeEventListener("pointerup", drop, true);
  }, [drag, shown, onChange]);

  const accept = (index: number) => {
    const suggestion = list?.completion.items[index];
    if (!list || !suggestion) return;
    const text = field.current?.value ?? shown;
    const from = suggestion.from ?? list.completion.from;
    const to = suggestion.to ?? list.completion.to;
    caretAfter.current = { at: from + (suggestion.caret ?? suggestion.insert.length), again: !!suggestion.again };
    setList(null);
    write(text.slice(0, from) + suggestion.insert + text.slice(to));
  };

  /** ⌃Space / ⌘I: the list where the caret is — inside braces, opened there first if need be. */
  const ask = () => {
    const el = field.current;
    if (!assist) return;
    const at = el?.selectionStart ?? shown.length;
    if (expressionAt(shown, at)) {
      suggest(shown, at);
      return;
    }
    caretAfter.current = { at: at + 3, again: true };
    write(`${shown.slice(0, at)}{{  }}${shown.slice(el?.selectionEnd ?? at)}`);
  };

  const props = {
    ref: field,
    value: shown,
    placeholder,
    spellCheck: false,
    "aria-label": ariaLabel,
    role: "combobox",
    "aria-autocomplete": "list" as const,
    "aria-expanded": list !== null,
    onChange: (event: { target: HTMLInputElement | HTMLTextAreaElement }) => {
      let text = event.target.value;
      let caret = event.target.selectionStart ?? text.length;
      // One character typed that makes `{{`: its `}}` comes with it.
      const closed = assist && text.length === shown.length + 1 ? autoClose(text, caret) : null;
      if (closed) {
        text = closed.text;
        caret = closed.caret;
        caretAfter.current = { at: caret, again: false };
      }
      write(text);
      suggest(text, caret);
    },
    onKeyDown: (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const count = list?.completion.items.length ?? 0;
      if (list && count > 0 && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
        event.preventDefault();
        setList({ ...list, active: (list.active + (event.key === "ArrowDown" ? 1 : count - 1)) % count });
      } else if (list && count > 0 && (event.key === "Enter" || event.key === "Tab")) {
        event.preventDefault();
        accept(list.active);
      } else if (list && event.key === "Escape") {
        event.preventDefault();
        setList(null);
      } else if ((event.ctrlKey && event.key === " ") || (event.metaKey && event.key.toLowerCase() === "i")) {
        event.preventDefault();
        ask();
      }
    },
    // The caret moved by a click or an arrow: the list follows it, or goes. Only a real move — React
    // also fires this on keys that move nothing (an Escape, an arrow inside the list), and asking
    // again there would reopen a list just closed or put its highlight back on the first row. Read
    // from the field itself: this can fire before the render that carries a keystroke's text.
    onSelect: () => {
      const el = field.current;
      const caret = el?.selectionStart ?? null;
      if (list && el && caret !== null && caret !== list.caret && !caretAfter.current) suggest(el.value, caret);
    },
    onBlur: () => setList(null),
    onPointerEnter: () => drag && setOver(true),
    onPointerMove: () => drag && !over && setOver(true),
    onPointerLeave: () => setOver(false),
    className: fieldClass({
      size: "sm",
      className: `w-full ${multiline ? "h-auto min-h-[64px] resize-y py-1.5 leading-[1.45]" : ""} ${
        expression || mono ? "font-mono text-[11.5px]" : ""
      } ${expression ? "cf-flow-expr" : ""} ${over ? "cf-flow-drop" : ""} ${className}`,
    }),
  };
  const control = multiline ? <textarea rows={3} {...props} /> : <input {...props} />;
  const suggestions = list && (
    <AssistList
      anchor={field.current}
      completion={list.completion}
      active={list.active}
      onPick={accept}
      onHover={(active) => setList({ ...list, active })}
    />
  );
  // One shape whether or not it is an expression: typing `{{` turns it into one, and a control that
  // moved to another parent would be a new element — the caret and the focus gone mid-word.
  return (
    <div className="flex min-w-0 flex-col">
      {control}
      {suggestions}
      {expression && preview && <ExpressionPreview flowId={preview.flowId} nodeId={preview.nodeId} expression={value} />}
    </div>
  );
}

/** The `fx` switch beside a field that may be an expression. */
function ExpressionToggle({ value, onChange }: { value: unknown; onChange: (next: unknown) => void }) {
  const t = useT();
  const on = isExpression(value);
  return (
    <button
      type="button"
      className={`h-[20px] shrink-0 rounded-[5px] px-1.5 font-mono text-[10.5px] font-semibold transition-colors ${
        on
          ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
          : "text-[var(--cf-text-faint)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text-muted)]"
      }`}
      title={on ? t("flows.param.toFixed") : t("flows.param.toExpression")}
      aria-pressed={on}
      onClick={() => {
        if (on) {
          onChange((value as string).slice(1));
        } else {
          const text = value === undefined || value === null ? "" : typeof value === "string" ? value : JSON.stringify(value);
          onChange(`=${text}`);
        }
      }}
    >
      fx
    </button>
  );
}

/** What an expression evaluates to, against the node's input in the newest run. */
function ExpressionPreview({ flowId, nodeId, expression }: { flowId: string; nodeId: string; expression: string }) {
  const t = useT();
  const [result, setResult] = useState<FlowPreview | null>(null);
  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => {
      const draft = useFlowsStore.getState().draft;
      void flowsPreviewExpression(flowId, nodeId, expression, 0, draft ? serializeSpec(draft.spec) : null)
        .then((answer) => alive && setResult(answer))
        .catch((error) => alive && setResult({ ok: false, error: String(error), items: 0 }));
    }, 350);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [flowId, nodeId, expression]);
  if (!result) return null;
  const text = result.ok
    ? typeof result.value === "string"
      ? result.value
      : JSON.stringify(result.value)
    : result.error ?? "";
  return (
    <div
      className={`mt-1 max-h-[90px] overflow-auto whitespace-pre-wrap break-all rounded-[5px] px-1.5 py-1 font-mono text-[11px] leading-[1.45] ${
        result.ok ? "bg-[var(--cf-sunken)] text-[var(--cf-text-muted)]" : "bg-[color-mix(in_oklab,var(--cf-danger)_10%,transparent)] text-[var(--cf-danger)]"
      }`}
      title={result.items === 0 ? t("flows.param.previewNoInput") : undefined}
    >
      {text === "" ? <span className="italic opacity-70">{t("flows.param.previewEmpty")}</span> : text}
    </div>
  );
}

function OperatorSelect({ value, onChange }: { value: string; onChange: (op: string) => void }) {
  const t = useT();
  const options: SelectOption[] = OPERATORS.map((op) => ({ value: op, label: t(`flows.op.${op}` as TranslationKey) }));
  return (
    <div className="w-[132px] shrink-0">
      <Select value={value || "equals"} onChange={onChange} options={options} size="sm" />
    </div>
  );
}

function ConditionsEditor({ value, onChange }: { value: unknown; onChange: (next: unknown) => void }) {
  const t = useT();
  const spec = (value && typeof value === "object" ? value : {}) as Row;
  const rows = asRows(spec.conditions);
  const update = (change: Row) => onChange({ ...spec, ...change });
  return (
    <div className="flex flex-col gap-2">
      <Rows
        rows={rows}
        onChange={(conditions) => update({ conditions })}
        blank={() => ({ left: "", op: "equals", right: "" })}
        addLabel={t("flows.param.addCondition")}
        render={(row, set) => (
          <div className="flex min-w-0 flex-1 flex-col gap-1 rounded-md bg-[var(--cf-sunken)] p-1.5">
            <SmartInput value={str(row.left)} onChange={(left) => set({ ...row, left })} placeholder="{{ $json.status }}" ariaLabel={t("flows.param.left")} />
            <div className="flex min-w-0 gap-1.5">
              <OperatorSelect value={str(row.op)} onChange={(op) => set({ ...row, op })} />
              {!UNARY.has(str(row.op)) && (
                <div className="min-w-0 flex-1">
                  <SmartInput value={str(row.right)} onChange={(right) => set({ ...row, right })} ariaLabel={t("flows.param.right")} />
                </div>
              )}
            </div>
          </div>
        )}
      />
      <div className="flex items-center gap-3 text-[12px] text-[var(--cf-text-muted)]">
        {rows.length > 1 && (
          <div className="w-[120px]">
            <Select
              value={spec.combinator === "or" ? "or" : "and"}
              onChange={(combinator) => update({ combinator })}
              options={[
                { value: "and", label: t("flows.param.all") },
                { value: "or", label: t("flows.param.any") },
              ]}
              size="sm"
            />
          </div>
        )}
        <label className="inline-flex items-center gap-1.5">
          <Checkbox checked={spec.ignoreCase === true} onChange={(ignoreCase) => update({ ignoreCase })} />
          {t("flows.param.ignoreCase")}
        </label>
      </div>
    </div>
  );
}

function RulesEditor({ value, onChange }: { value: unknown; onChange: (next: unknown) => void }) {
  const t = useT();
  return (
    <Rows
      rows={asRows(value)}
      onChange={onChange}
      blank={() => ({ output: 0, left: "", op: "equals", right: "" })}
      addLabel={t("flows.param.addRule")}
      render={(row, set) => (
        <div className="flex min-w-0 flex-1 flex-col gap-1 rounded-md bg-[var(--cf-sunken)] p-1.5">
          <div className="flex min-w-0 gap-1.5">
            <div className="w-[64px] shrink-0">
              <Select
                value={String(Number(row.output) || 0)}
                onChange={(output) => set({ ...row, output: Number(output) })}
                options={[0, 1, 2].map((n) => ({ value: String(n), label: `→ ${n + 1}` }))}
                size="sm"
              />
            </div>
            <div className="min-w-0 flex-1">
              <SmartInput value={str(row.left)} onChange={(left) => set({ ...row, left })} placeholder="{{ $json.type }}" />
            </div>
          </div>
          <div className="flex min-w-0 gap-1.5">
            <OperatorSelect value={str(row.op)} onChange={(op) => set({ ...row, op })} />
            {!UNARY.has(str(row.op)) && (
              <div className="min-w-0 flex-1">
                <SmartInput value={str(row.right)} onChange={(right) => set({ ...row, right })} />
              </div>
            )}
          </div>
        </div>
      )}
    />
  );
}

function KeyValueEditor({ value, onChange, keyPlaceholder }: { value: unknown; onChange: (next: unknown) => void; keyPlaceholder?: string }) {
  const t = useT();
  return (
    <Rows
      rows={asRows(value)}
      onChange={onChange}
      blank={() => ({ name: "", value: "" })}
      addLabel={t("flows.param.addPair")}
      render={(row, set) => (
        <>
          <div className="w-[38%] shrink-0">
            <SmartInput value={str(row.name)} onChange={(name) => set({ ...row, name })} placeholder={keyPlaceholder ?? t("flows.param.keyName")} mono />
          </div>
          <div className="min-w-0 flex-1">
            <SmartInput value={str(row.value)} onChange={(next) => set({ ...row, value: next })} placeholder={t("flows.param.keyValue")} />
          </div>
        </>
      )}
    />
  );
}

function AssignmentsEditor({ value, onChange }: { value: unknown; onChange: (next: unknown) => void }) {
  const t = useT();
  return (
    <Rows
      rows={asRows(value)}
      onChange={onChange}
      blank={() => ({ name: "", type: "auto", value: "" })}
      addLabel={t("flows.param.addField")}
      render={(row, set) => (
        <div className="flex min-w-0 flex-1 flex-col gap-1 rounded-md bg-[var(--cf-sunken)] p-1.5">
          <div className="flex min-w-0 gap-1.5">
            <div className="min-w-0 flex-1">
              <SmartInput value={str(row.name)} onChange={(name) => set({ ...row, name })} placeholder={t("flows.param.fieldName")} mono />
            </div>
            <div className="w-[96px] shrink-0">
              <Select
                value={str(row.type) || "auto"}
                onChange={(type) => set({ ...row, type })}
                options={ASSIGNMENT_TYPES.map((type) => ({ value: type, label: t(`flows.type.${type}` as TranslationKey) }))}
                size="sm"
              />
            </div>
          </div>
          <SmartInput value={str(row.value)} onChange={(next) => set({ ...row, value: next })} placeholder={t("flows.param.keyValue")} />
        </div>
      )}
    />
  );
}

function SortKeysEditor({ value, onChange }: { value: unknown; onChange: (next: unknown) => void }) {
  const t = useT();
  return (
    <Rows
      rows={asRows(value)}
      onChange={onChange}
      blank={() => ({ field: "", order: "asc" })}
      addLabel={t("flows.param.addSortKey")}
      render={(row, set) => (
        <>
          <div className="min-w-0 flex-1">
            <SmartInput value={str(row.field)} onChange={(field) => set({ ...row, field })} placeholder={t("flows.param.fieldName")} mono />
          </div>
          <div className="w-[120px] shrink-0">
            <Select
              value={row.order === "desc" ? "desc" : "asc"}
              onChange={(order) => set({ ...row, order })}
              options={[
                { value: "asc", label: t("flows.param.ascending") },
                { value: "desc", label: t("flows.param.descending") },
              ]}
              size="sm"
            />
          </div>
        </>
      )}
    />
  );
}

function AggregationsEditor({ value, onChange }: { value: unknown; onChange: (next: unknown) => void }) {
  const t = useT();
  return (
    <Rows
      rows={asRows(value)}
      onChange={onChange}
      blank={() => ({ op: "sum", field: "", as: "" })}
      addLabel={t("flows.param.addAggregation")}
      render={(row, set) => (
        <>
          <div className="w-[118px] shrink-0">
            <Select
              value={str(row.op) || "count"}
              onChange={(op) => set({ ...row, op })}
              options={AGGREGATIONS.map((op) => ({ value: op, label: t(`flows.agg.${op}` as TranslationKey) }))}
              size="sm"
            />
          </div>
          <div className="min-w-0 flex-1">
            <SmartInput value={str(row.field)} onChange={(field) => set({ ...row, field })} placeholder={t("flows.param.fieldName")} mono />
          </div>
          <div className="w-[28%] shrink-0">
            <SmartInput value={str(row.as)} onChange={(as) => set({ ...row, as })} placeholder={t("flows.param.as")} mono />
          </div>
        </>
      )}
    />
  );
}

function StringsEditor({ value, onChange, placeholder }: { value: unknown; onChange: (next: unknown) => void; placeholder?: string }) {
  const t = useT();
  const rows = Array.isArray(value) ? value.map(str) : [];
  return (
    <Rows
      rows={rows}
      onChange={onChange}
      blank={() => ""}
      addLabel={t("flows.param.addEntry")}
      render={(row, set) => (
        <div className="min-w-0 flex-1">
          <SmartInput value={row} onChange={set} placeholder={placeholder} mono />
        </div>
      )}
    />
  );
}

/**
 * A node's credential: picked from the workspace's, or — with a `plan`, when there is none yet —
 * made right here (`CredentialConnect`), and tried with "Probar" when the service can say who it is.
 */
function CredentialPicker({ value, kinds, onChange, plan }: { value: unknown; kinds: string[]; onChange: (next: unknown) => void; plan?: ConnectPlan }) {
  const t = useT();
  const credentials = useFlowVaultStore((s) => s.credentials);
  /** What a connection or a test said — about the credential it names, shown only while that one is chosen. */
  const [status, setStatus] = useState<(ConnectStatus & { id: string }) | null>(null);
  const usable = credentials.filter((credential) => kinds.includes(credential.kind));
  const options: SelectOption[] = [
    { value: "", label: t("flows.param.noCredential") },
    ...usable.map((credential) => ({ value: credential.id, label: `${credential.name} · ${t(`flows.cred.${credential.kind}` as TranslationKey)}` })),
  ];
  const missing = typeof value === "string" && value !== "" && !usable.some((credential) => credential.id === value);
  const chosen = missing ? "" : str(value);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <div className="min-w-0 flex-1">
          <Select value={chosen} onChange={onChange} options={options} size="sm" />
        </div>
        {plan && chosen && <CredentialTestButton plan={plan} credentialId={chosen} onStatus={(next) => setStatus(next && { ...next, id: chosen })} />}
        <button
          type="button"
          className={iconButtonClass({ size: "sm" })}
          title={t("flows.vault.manageCredentials")}
          aria-label={t("flows.vault.manageCredentials")}
          onClick={() => useFlowVaultStore.getState().openDialog("credentials")}
        >
          <KeyRound size={14} />
        </button>
      </div>
      {missing && <span className="text-[11.5px] text-[var(--cf-danger)]">{t("flows.issue.credentialGone")}</span>}
      {plan && !chosen && (
        <CredentialConnect
          plan={plan}
          onConnected={(id, connected) => {
            onChange(id);
            setStatus(connected && { ...connected, id });
          }}
        />
      )}
      {status && status.id === chosen && <ConnectStatusLine status={status} />}
    </div>
  );
}

/**
 * How a node's credential is made in place, when it can be: a connector says how it signs in
 * (`authHint`, `tokenUrl`, `oauth`, `test`); the Google and Microsoft nodes sign an account in.
 */
function credentialPlan(
  typeId: string | undefined,
  connector: FlowConnector | undefined,
  call: Record<string, unknown>,
  say: (label: FlowLabel) => string,
  t: (key: TranslationKey) => string,
): ConnectPlan | undefined {
  if (typeId === "net.connector") {
    if (!connector || connector.auth === "none") return undefined;
    const kind = connector.oauth ? "oauth2" : (CONNECTOR_CREDENTIALS[connector.auth][0] as ConnectPlan["kind"]);
    const id = connector.id;
    return {
      service: connector.name,
      kind,
      hint: say(connector.authHint),
      tokenUrl: connector.tokenUrl,
      userLabel: connector.userLabel ? say(connector.userLabel) : undefined,
      secretLabel: connector.secretLabel ? say(connector.secretLabel) : undefined,
      provider: connector.oauth?.provider,
      scopes: connector.oauth?.scopes,
      test: connector.test ? (credential) => flowsConnectorTest(id, credential, call) : undefined,
    };
  }
  const provider = typeId === "net.microsoft" ? "microsoft" : typeId === "net.google" || typeId === "trigger.google" ? "google" : null;
  if (!provider) return undefined;
  return {
    service: provider === "google" ? "Google" : "Microsoft 365",
    kind: "oauth2",
    hint: t(`flows.vault.oauthHint.${provider}` as TranslationKey),
    tokenUrl: OAUTH_CONSOLE[provider],
    provider,
    scopes: OAUTH_SCOPES[provider],
  };
}

function FolderField({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  const t = useT();
  return (
    <div className="flex items-center gap-1.5">
      <div className="min-w-0 flex-1">
        <SmartInput value={value} onChange={onChange} placeholder={t("flows.param.cwdPlaceholder")} mono />
      </div>
      <button
        type="button"
        className={iconButtonClass({ size: "sm" })}
        title={t("flows.param.pickFolder")}
        aria-label={t("flows.param.pickFolder")}
        onClick={() =>
          void openDialog({ directory: true, multiple: false }).then((picked) => {
            if (typeof picked === "string") onChange(picked);
          })
        }
      >
        <FolderOpen size={14} />
      </button>
    </div>
  );
}

/** A file on this computer: written or pasted, or picked in the system's dialog — "save as" when
 *  the node writes it there, an open dialog when it reads it. */
function FileField({ value, onChange, placeholder, saving }: { value: string; onChange: (next: string) => void; placeholder: string; saving: boolean }) {
  const t = useT();
  const label = saving ? t("flows.param.pickSaveFile") : t("flows.param.pickFile");
  const pick = async () => {
    // Where the dialog opens: the file already written, when it is a full path.
    const start = /^(\/|[A-Za-z]:[\\/])/.test(value.trim()) ? value.trim() : undefined;
    const picked = saving ? await saveDialog({ defaultPath: start }) : await openDialog({ directory: false, multiple: false, defaultPath: start });
    if (typeof picked === "string") onChange(picked);
  };
  return (
    <div className="flex items-center gap-1.5">
      <div className="min-w-0 flex-1">
        <SmartInput value={value} onChange={onChange} placeholder={placeholder} mono />
      </div>
      <button type="button" className={iconButtonClass({ size: "sm" })} title={label} aria-label={label} onClick={() => void pick()}>
        <FolderOpen size={14} />
      </button>
    </div>
  );
}

/** Any number of options, as toggles in a row — the weekdays of a schedule, a watcher's events. */
function MultiSelectField({ value, options, onChange }: { value: unknown; options: string[]; onChange: (next: unknown) => void }) {
  const t = useT();
  const chosen = Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  return (
    <div className="flex flex-wrap gap-1">
      {options.map((option) => {
        const on = chosen.includes(option);
        return (
          <button
            key={option}
            type="button"
            aria-pressed={on}
            className={`h-[24px] rounded-md px-2 text-[12px] font-medium transition-colors ${
              on
                ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)] shadow-[inset_0_0_0_1px_var(--cf-accent-line)]"
                : "text-[var(--cf-text-muted)] shadow-[inset_0_0_0_1px_var(--cf-border)] hover:bg-[var(--cf-hover)]"
            }`}
            onClick={() => onChange(on ? chosen.filter((c) => c !== option) : options.filter((o) => o === option || chosen.includes(o)))}
          >
            {t(`flows.opt.${option}` as TranslationKey)}
          </button>
        );
      })}
    </div>
  );
}

/** A repository of the workspace on screen. */
function ProjectPicker({ value, onChange }: { value: unknown; onChange: (next: unknown) => void }) {
  const t = useT();
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const projects = useWorkspaceStore((s) => (workspaceId ? s.projectsByWorkspace[workspaceId] : undefined)) ?? [];
  return (
    <div className="max-w-[300px]">
      <Select
        value={str(value)}
        onChange={onChange}
        placeholder={t("flows.param.pickProject")}
        options={projects.map((project) => ({ value: project.id, label: project.name }))}
        size="sm"
      />
    </div>
  );
}

/** Another flow of the workspace — one, or several. */
function FlowPicker({ value, multiple, onChange }: { value: unknown; multiple: boolean; onChange: (next: unknown) => void }) {
  const t = useT();
  const flows = useFlowsStore((s) => s.flows);
  const current = useFlowsStore((s) => s.draft?.id ?? "");
  const others = flows.filter((flow) => flow.id !== current || !multiple);
  if (!multiple) {
    return (
      <div className="max-w-[300px]">
        <Select
          value={str(value)}
          onChange={onChange}
          placeholder={t("flows.param.pickFlow")}
          options={others.map((flow) => ({ value: flow.id, label: flow.name }))}
          size="sm"
        />
      </div>
    );
  }
  const chosen = Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  return (
    <div className="flex max-h-[160px] flex-col gap-1 overflow-y-auto rounded-md border border-[var(--cf-border)] p-1.5">
      {others.length === 0 && <span className="px-1 text-[12px] text-[var(--cf-text-muted)]">{t("flows.param.noOtherFlows")}</span>}
      {others.map((flow) => (
        <label key={flow.id} className="flex items-center gap-2 rounded px-1 py-0.5 text-[12.5px] hover:bg-[var(--cf-hover)]">
          <Checkbox
            checked={chosen.includes(flow.id)}
            onChange={(on) => onChange(on ? [...chosen, flow.id] : chosen.filter((id) => id !== flow.id))}
          />
          <span className="min-w-0 truncate">{flow.name}</span>
        </label>
      ))}
    </div>
  );
}

const serviceCache = new Map<string, ServiceRow[]>();

/** A service of the workspace — the bottom dock's. */
function ServicePicker({ value, onChange }: { value: unknown; onChange: (next: unknown) => void }) {
  const t = useT();
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const [services, setServices] = useState<ServiceRow[]>(() => (workspaceId ? serviceCache.get(workspaceId) ?? [] : []));
  useEffect(() => {
    if (!workspaceId) return;
    let alive = true;
    void listServices(workspaceId)
      .then((rows) => {
        serviceCache.set(workspaceId, rows);
        if (alive) setServices(rows);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [workspaceId]);
  return (
    <div className="max-w-[300px]">
      <Select
        value={str(value)}
        onChange={onChange}
        placeholder={t("flows.param.pickService")}
        options={services.map((service) => ({ value: service.id, label: service.name }))}
        size="sm"
      />
    </div>
  );
}

function asCall(value: unknown): FlowConnectorCall {
  const record = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const fields = record.fields && typeof record.fields === "object" && !Array.isArray(record.fields) ? (record.fields as Record<string, unknown>) : {};
  return { connector: str(record.connector), operation: str(record.operation), fields };
}

/** The "Conector" node's call: the service, what to do with it, and that action's own fields —
 *  each one fixed or an expression, like any field. Nothing secret is ever one of them: the token
 *  is the credential below. */
function ConnectorField({
  value,
  onChange,
  credential,
  credentialRow,
}: {
  value: unknown;
  onChange: (next: unknown) => void;
  credential: string;
  /** The node's credential, drawn right under the service — a list of teams or channels needs it first. */
  credentialRow?: (connector: FlowConnector) => ReactNode;
}) {
  const t = useT();
  const language = useLanguageStore((s) => s.language);
  const connectors = useConnectors();
  const call = asCall(value);
  const connector = connectors.find((c) => c.id === call.connector);
  const operation = connector?.operations.find((o) => o.id === call.operation);
  const say = (label: FlowLabel) => (language === "es" ? label.es : label.en);
  const fieldsOf = (c: FlowConnector | undefined, operationId: string) => {
    const chosen = c?.operations.find((o) => o.id === operationId);
    return c && chosen ? [...(c.siteField ? [c.siteField] : []), ...chosen.fields] : [];
  };
  const fields = fieldsOf(connector, call.operation);
  const setField = (name: string, next: unknown) => onChange({ ...call, fields: { ...call.fields, [name]: next } });
  // Another action keeps what the two have in common (the channel, the site) and drops the rest.
  const pickOperation = (id: string) => {
    const names = new Set(fieldsOf(connector, id).map((field) => field.name));
    onChange({ ...call, operation: id, fields: Object.fromEntries(Object.entries(call.fields).filter(([name]) => names.has(name))) });
  };
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-1.5">
        {/* Wide enough to tell "Microsoft Teams" from "Microsoft Teams Webhook" closed. */}
        <div className="w-[188px] shrink-0">
          <Select
            value={call.connector}
            onChange={(id) => onChange({ connector: id, operation: connectors.find((c) => c.id === id)?.operations[0]?.id ?? "", fields: {} })}
            options={connectors.map((c) => ({ value: c.id, label: c.name }))}
            size="sm"
            ariaLabel={t("flows.connector.service")}
          />
        </div>
        <div className="min-w-0 flex-1">
          <Select
            value={operation ? call.operation : ""}
            onChange={pickOperation}
            options={(connector?.operations ?? []).map((o) => ({ value: o.id, label: say(o.name) }))}
            size="sm"
            ariaLabel={t("flows.connector.action")}
          />
        </div>
        {connector && (
          <span className="flex shrink-0 text-[var(--cf-text-faint)]" title={say(connector.authHint)} aria-label={say(connector.authHint)}>
            <CircleHelp size={14} />
          </span>
        )}
      </div>
      {connector && connector.auth !== "none" && credentialRow?.(connector)}
      {fields.map((field) => {
        const current = call.fields[field.name];
        const fixed = typeof current === "string" && !current.startsWith("=") ? current.trim() : "";
        // The name behind an id the list gave — "Ingeniería" for `9cfb…`.
        const known = field.lookup && connector ? labelFor(connector.id, field.name, fixed) : undefined;
        const needs = field.lookup?.needs ?? [];
        const unfilled = needs.filter((name) => {
          const need = call.fields[name];
          return typeof need !== "string" || need.trim() === "" || need.startsWith("=");
        });
        const blocked =
          connector && connector.auth !== "none" && !connector.authOptional && !credential
            ? t("flows.lookup.needsCredential", { service: connector.name })
            : unfilled.length
              ? t("flows.lookup.needs", { fields: unfilled.map((name) => say(fields.find((f) => f.name === name)?.label ?? { es: name, en: name })).join(", ") })
              : null;
        return (
          <div key={field.name} className="flex flex-col gap-1">
            <div className="flex min-h-[20px] items-center gap-1.5">
              <span className="min-w-0 shrink-0 truncate text-[12px] text-[var(--cf-text-muted)]">
                {say(field.label)}
                {field.required && <span className="text-[var(--cf-text-faint)]"> *</span>}
              </span>
              <span className="min-w-0 flex-1 truncate text-right text-[11.5px] text-[var(--cf-text-faint)]" title={known}>
                {known}
              </span>
              <ExpressionToggle value={current} onChange={(next) => setField(field.name, next)} />
            </div>
            <div className="flex items-start gap-1.5">
              <div className="min-w-0 flex-1">
                <SmartInput
                  value={str(current)}
                  onChange={(next) => setField(field.name, next)}
                  multiline={field.multiline}
                  mono={field.json}
                  placeholder={field.placeholder}
                  ariaLabel={say(field.label)}
                />
              </div>
              {field.lookup && connector && operation && (
                <LookupButton
                  connector={connector.id}
                  operation={operation.id}
                  field={field.name}
                  credential={credential}
                  fields={call.fields}
                  needs={needs}
                  blocked={blocked}
                  onPick={(choice) => onChange({ ...call, fields: { ...call.fields, ...(choice.fills ?? {}), [field.name]: choice.value } })}
                />
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** `{{` holding a `$` name: what turns code the engine resolves into an expression. */
const OPENS_EXPRESSION = /\{\{\s*\$/;

/**
 * How a code field is read, for its suggestions and for a field dropped on it: the scripts that get
 * the items as variables in their own language, the template in Jinja, the SQL node's table — and
 * every other code the engine resolves as text with `{{ }}` in it. `null`: a field that is neither
 * (a JSON Schema), where neither helps.
 */
function codeDialect(typeId: string | undefined, spec: FlowParamSpec): AssistDialect | null {
  if (typeId === "transform.template" && spec.name === "template") return "jinja";
  if (typeId === "code.js" && spec.name === "code") return "js";
  if (typeId === "code.python" && spec.name === "code") return "python";
  if (typeId === "code.node" && spec.name === "code") return "node";
  if (typeId === "transform.sql" && spec.name === "itemsQuery") return "sql";
  return spec.expr ? "expression" : null;
}

/** One parameter: its label, the `fx` switch, the editor its kind calls for, and its preview. */
function ParamField({
  spec,
  value,
  onChange,
  flowId,
  nodeId,
  params,
  typeId,
  credentialKinds,
  connector,
  setParam,
}: {
  spec: FlowParamSpec;
  value: unknown;
  onChange: (next: unknown) => void;
  flowId: string;
  nodeId: string;
  /** The node's other values — a field that depends on a sibling (the local model on its server). */
  params: Record<string, unknown>;
  typeId?: string;
  /** Narrower credential kinds than the declaration's — those of the connector a call names. */
  credentialKinds?: string[];
  /** The connector a Conector node's call names — how its credential is made in place. */
  connector?: FlowConnector;
  /** Sets a sibling parameter — the Conector's call draws its credential, which is a parameter of its own. */
  setParam?: (name: string, value: unknown) => void;
}) {
  const t = useT();
  const language = useLanguageStore((s) => s.language);
  const sayLabel = (text: FlowLabel) => (language === "es" ? text.es : text.en);
  const kind = spec.kind;
  // A literal field is read as written: a template may well open with `===`, and that `=` is text.
  const expression = isExpression(value) && (spec.expr || kind.type !== "code");
  const label = t(`flows.param.${spec.name}` as TranslationKey);
  let editor: ReactNode;
  if (expression && kind.type !== "code") {
    editor = <SmartInput value={value} onChange={onChange} multiline={kind.type === "text" && kind.multiline} ariaLabel={label} />;
  } else {
    switch (kind.type) {
      case "text":
        editor = (
          <SmartInput value={str(value)} onChange={onChange} multiline={kind.multiline} placeholder={kind.placeholder} ariaLabel={label} literal={!spec.expr} />
        );
        break;
      case "code": {
        const text = str(value);
        const dialect = codeDialect(typeId, spec);
        editor = (
          <Suspense fallback={<div className="h-[220px] rounded-md border border-[var(--cf-field-border)]" />}>
            <CodeField
              bufferKey={`${flowId}/${nodeId}/${spec.name}`}
              lang={kind.lang}
              value={expression ? text.slice(1) : text}
              assist={dialect ? { dialect, expressions: spec.expr } : null}
              // `{{ $…` written (or dropped) into code the engine resolves makes it an expression —
              // the rule the AI builder's `marked()` follows, so `{{.Names}}` stays a literal.
              onChange={(next) => onChange(expression || (spec.expr && OPENS_EXPRESSION.test(next)) ? `=${next}` : next)}
            />
          </Suspense>
        );
        break;
      }
      case "number":
        editor = (
          <input
            type="number"
            className={fieldClass({ size: "sm", className: "w-40" })}
            value={typeof value === "number" ? value : str(value)}
            min={kind.min ?? undefined}
            max={kind.max ?? undefined}
            aria-label={label}
            onChange={(event) => onChange(event.target.value === "" ? undefined : Number(event.target.value))}
          />
        );
        break;
      case "boolean":
        // A switch reads as one line: the box and its label together, the `fx` at the end.
        return (
          <div className="flex min-h-[24px] items-center gap-2">
            <label className="flex min-w-0 flex-1 items-center gap-2 text-[12.5px] text-[var(--cf-text)]">
              <Checkbox checked={value === true} onChange={(checked) => onChange(checked)} />
              <span className="min-w-0 truncate">{label}</span>
            </label>
            {spec.expr && <ExpressionToggle value={value} onChange={onChange} />}
          </div>
        );
      case "select":
        editor = (
          <div className="max-w-[260px]">
            <Select
              value={str(value)}
              onChange={onChange}
              options={kind.options.map((option) => ({ value: option, label: kind.raw ? option : t(`flows.opt.${option}` as TranslationKey) }))}
              size="sm"
              ariaLabel={label}
            />
          </div>
        );
        break;
      case "keyValue":
        editor = <KeyValueEditor value={value} onChange={onChange} />;
        break;
      case "conditions":
        editor = <ConditionsEditor value={value} onChange={onChange} />;
        break;
      case "rules":
        editor = <RulesEditor value={value} onChange={onChange} />;
        break;
      case "assignments":
        editor = <AssignmentsEditor value={value} onChange={onChange} />;
        break;
      case "sortKeys":
        editor = <SortKeysEditor value={value} onChange={onChange} />;
        break;
      case "aggregations":
        editor = <AggregationsEditor value={value} onChange={onChange} />;
        break;
      case "strings":
        editor = <StringsEditor value={value} onChange={onChange} />;
        break;
      case "folder":
        editor = <FolderField value={str(value)} onChange={onChange} />;
        break;
      case "file":
        editor = (
          <FileField
            value={str(value)}
            onChange={onChange}
            placeholder={kind.placeholder}
            saving={kind.save.includes("*") || kind.save.includes(str(params.operation))}
          />
        );
        break;
      case "credential":
        editor = (
          <CredentialPicker
            value={value}
            kinds={credentialKinds ?? kind.kinds}
            onChange={onChange}
            plan={credentialPlan(typeId, connector, asCall(params.call).fields, sayLabel, t)}
          />
        );
        break;
      case "multiSelect":
        editor = <MultiSelectField value={value} options={kind.options} onChange={onChange} />;
        break;
      case "project":
        editor = <ProjectPicker value={value} onChange={onChange} />;
        break;
      case "flows":
        editor = <FlowPicker value={value} multiple={kind.multiple} onChange={onChange} />;
        break;
      case "service":
        editor = <ServicePicker value={value} onChange={onChange} />;
        break;
      case "engine":
        // The PR analyzer follows its own routing row, "Revisión de PR", while left automatic.
        editor = (
          <EngineField
            value={value}
            onChange={onChange}
            task={typeId === "ai.prReview" ? "review" : typeId === "ai.chat" || typeId === "ai.prReply" ? "chat" : typeId === "ai.prFix" ? "fix" : "flows"}
          />
        );
        break;
      case "engines":
        editor = <EnginesField value={value} onChange={onChange} />;
        break;
      case "outputFields":
        editor = <AnswerFieldsEditor value={value} onChange={onChange} />;
        break;
      case "formFields":
        editor = <FormFieldsEditor value={value} onChange={onChange} />;
        break;
      case "extractRules":
        editor = <ExtractRulesEditor value={value} onChange={onChange} />;
        break;
      case "categories":
        editor = <CategoriesEditor value={value} onChange={onChange} />;
        break;
      case "mcpServers":
        editor = <McpServersField value={value} onChange={onChange} />;
        break;
      case "localModel":
        editor = <LocalModelField value={value} onChange={onChange} server={str(params.server ?? "auto")} url={str(params.url)} />;
        break;
      case "apiModel":
        editor =
          kind.purpose === "embed" ? (
            <ApiModelField value={value} onChange={onChange} purpose="embed" provider={str(params.embedProvider ?? "openaiApi")} baseUrl={str(params.embedUrl)} credentialId={str(params.credential)} />
          ) : (
            <ApiModelField value={value} onChange={onChange} purpose="chat" provider={str(params.apiProvider ?? "openaiApi")} baseUrl={str(params.baseUrl)} credentialId={str(params.credential)} />
          );
        break;
      case "agent":
        editor = <AgentPicker value={value} onChange={onChange} />;
        break;
      case "chainTemplate":
        editor = <ChainTemplatePicker value={value} onChange={onChange} />;
        break;
      case "dbConnection":
        editor = <DbConnectionPicker value={value} onChange={onChange} kinds={kind.kinds} />;
        break;
      case "remoteHost":
        editor = <RemoteHostPicker value={value} onChange={onChange} kinds={kind.kinds} />;
        break;
      case "note":
        editor = <NotePicker value={value} onChange={onChange} />;
        break;
      case "vaultItem":
        editor = <VaultItemPicker value={value} onChange={onChange} />;
        break;
      case "apiRequest":
        editor = <ApiRequestPicker value={value} onChange={onChange} />;
        break;
      case "apiEnvironment":
        editor = <ApiEnvironmentPicker value={value} onChange={onChange} />;
        break;
      case "connector":
        editor = (
          <ConnectorField
            value={value}
            onChange={onChange}
            credential={str(params.credential)}
            credentialRow={(chosen) => (
              <div className="flex flex-col gap-1">
                <span className="text-[12px] text-[var(--cf-text-muted)]">{t("flows.param.credential")}</span>
                <CredentialPicker
                  value={params.credential}
                  kinds={CONNECTOR_CREDENTIALS[chosen.auth]}
                  onChange={(next) => setParam?.("credential", next)}
                  plan={credentialPlan(typeId, chosen, asCall(value).fields, sayLabel, t)}
                />
              </div>
            )}
          />
        );
        break;
    }
  }
  return (
    <div className="flex flex-col gap-1">
      <div className="flex min-h-[20px] items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-[var(--cf-text-muted)]">{label}</span>
        {spec.expr && <ExpressionToggle value={value} onChange={onChange} />}
      </div>
      {editor}
      {expression && kind.type === "code" && <ExpressionPreview flowId={flowId} nodeId={nodeId} expression={value} />}
      {typeId === "ai.agent" && spec.name === "access" && <AccessHint params={params} />}
    </div>
  );
}

export function ParamFields({
  specs,
  params,
  onChange,
  flowId,
  nodeId,
  typeId,
}: {
  specs: FlowParamSpec[];
  params: Record<string, unknown>;
  onChange: (name: string, value: unknown) => void;
  flowId: string;
  nodeId: string;
  /** The node's type, for the few hints that belong to one (an agent's access). */
  typeId?: string;
}) {
  const t = useT();
  // A connector call decides which credentials fit, and whether one is asked for at all.
  const connectors = useConnectors(typeId === "net.connector");
  const callSpec = typeId === "net.connector" ? specs.find((spec) => spec.name === "call") : undefined;
  const connector = callSpec ? connectors.find((c) => c.id === asCall(params.call ?? callSpec.default).connector) : undefined;
  if (specs.length === 0) {
    return <p className="text-[12px] text-[var(--cf-text-muted)]">{t("flows.param.none")}</p>;
  }
  return (
    <PreviewContext.Provider value={{ flowId, nodeId }}>
    <div className="flex flex-col gap-3.5">
      {specs
        .filter((spec) => visible(spec, params, specs))
        // The Conector draws its credential under the service it signs into (`ConnectorField`).
        .filter((spec) => !(typeId === "net.connector" && spec.name === "credential"))
        .map((spec) => (
          <ParamField
            key={spec.name}
            spec={spec}
            value={params[spec.name] ?? spec.default}
            onChange={(next) => onChange(spec.name, next)}
            flowId={flowId}
            nodeId={nodeId}
            params={params}
            typeId={typeId}
            credentialKinds={connector && spec.name === "credential" ? CONNECTOR_CREDENTIALS[connector.auth] : undefined}
            connector={connector}
            setParam={onChange}
          />
        ))}
    </div>
    </PreviewContext.Provider>
  );
}
