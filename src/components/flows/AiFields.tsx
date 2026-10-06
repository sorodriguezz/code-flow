import { useEffect, useId, useState } from "react";
import { Cpu, Plus, RefreshCw, X } from "lucide-react";
import { ChatModelPicker } from "../ai/ChatModelPicker";
import { Checkbox } from "../common/Checkbox";
import { Select } from "../common/Select";
import { iconButtonClass } from "../common/Button";
import { fieldClass } from "../common/recipes";
import { Rows, asRows, str } from "./fieldRows";
import { flowsAiModels, flowsLocalModels, type FlowEngineChoice } from "../../lib/tauri/flowsCommands";
import { mcpList, type McpServer } from "../../lib/tauri/mcpCommands";
import { aiReadOnlyEngines, listChainTemplates, listWorkspaceAgents } from "../../lib/tauri/commands";
import { AI_PROVIDERS } from "../../lib/aiProviders";
import { SYSTEM_ACCOUNT, resolveAccount } from "../../lib/aiAccounts";
import type { TranslationKey } from "../../lib/i18n/translations";
import type { ChainTemplate, WorkspaceAgent } from "../../types/domain";
import { useAiAccountsStore } from "../../state/aiAccountsStore";
import { useAiProviderStore, useTaskProvider } from "../../state/aiProviderStore";
import { useT } from "../../state/languageStore";
import { useWorkspaceStore } from "../../state/workspaceStore";

/**
 * The AI nodes' fields — which engine answers, what it falls back on, the shape of its answer.
 *
 * **The engine is the node's, not the task's.** The picker is the same `ChatModelPicker` every AI
 * action in the app uses, in bound mode: a pick is written into the node (and so versioned and
 * exported with the flow), never into Settings' routing. Left empty, a node follows the "Flujos" row
 * of that routing — the chip then shows what that row resolves to, and says so.
 */

const CLI_IDS = ["claude", "codex", "gemini", "grok", "opencode", "cline"];

export function engineOf(value: unknown): FlowEngineChoice {
  const row = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const text = (v: unknown) => (typeof v === "string" ? v : "");
  return { provider: text(row.provider), model: text(row.model), account: text(row.account) };
}

/** The account a node's choice runs as, for the chip: `""` resolves the way the run will. */
function useShownAccount(provider: string, account: string, task: "flows" | "review" | "chat" | "fix" = "flows"): string | null {
  const accounts = useAiAccountsStore((s) => s.accounts);
  const taskPins = useAiAccountsStore((s) => s.taskPins);
  const workspaceDefaults = useAiAccountsStore((s) => s.workspaceDefaults);
  const providerDefaults = useAiAccountsStore((s) => s.providerDefaults);
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  if (account === SYSTEM_ACCOUNT) return null;
  if (account) return account;
  return resolveAccount({ accounts, taskPins, workspaceDefaults, providerDefaults }, provider, task, workspaceId);
}

/** The node's engine: the model picker, bound to the node. `task` is the routing row an automatic
 *  node follows — "Flujos", "Revisión de PR" for the PR analyzer, "Chat" for a Chat turn. */
export function EngineField({
  value,
  onChange,
  task = "flows",
}: {
  value: unknown;
  onChange: (next: unknown) => void;
  task?: "flows" | "review" | "chat" | "fix";
}) {
  const t = useT();
  const engine = engineOf(value);
  const routedProvider = useTaskProvider(task);
  const routedModel = useAiProviderStore((s) => s.taskModels[task] ?? s.model);
  const automatic = engine.provider === "";
  const provider = automatic ? routedProvider : engine.provider;
  const model = automatic ? routedModel : engine.model;
  const account = useShownAccount(provider, engine.account, task);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <ChatModelPicker
        liveModel={null}
        chatActive={false}
        task={task}
        bound={{ provider, model, account }}
        onPick={(nextProvider, nextModel, nextAccount) =>
          onChange({
            provider: nextProvider,
            model: nextModel,
            account: nextAccount ?? (nextProvider === engine.provider ? engine.account : ""),
          })
        }
      />
      {automatic ? (
        <span className="text-[11.5px] text-[var(--cf-text-faint)]">
          {t(
            task === "review"
              ? "flows.ai.automaticReview"
              : task === "chat"
                ? "flows.ai.automaticChat"
                : task === "fix"
                  ? "flows.ai.automaticFix"
                  : "flows.ai.automatic",
          )}
        </span>
      ) : (
        <button
          type="button"
          className="text-[11.5px] text-[var(--cf-text-muted)] hover:text-[var(--cf-text)] hover:underline"
          onClick={() => onChange({})}
        >
          {t("flows.ai.backToAutomatic")}
        </button>
      )}
    </div>
  );
}

/** What the node falls back on, in order — one per provider; the local model is one of them. */
export function EnginesField({ value, onChange }: { value: unknown; onChange: (next: unknown) => void }) {
  const t = useT();
  const rows = asRows(value).map(engineOf);
  const write = (next: FlowEngineChoice[]) => onChange(next);
  const seen = new Set<string>();
  const unused = CLI_IDS.find((id) => !rows.some((row) => row.provider === id) && AI_PROVIDERS.some((p) => p.id === id && p.available));
  return (
    <div className="flex flex-col gap-1.5">
      {rows.map((engine, index) => {
        const repeated = seen.has(engine.provider);
        seen.add(engine.provider);
        const set = (next: FlowEngineChoice) => write(rows.map((row, i) => (i === index ? next : row)));
        return (
          <div key={index} className="flex min-w-0 items-center gap-1.5">
            <span className="w-3 shrink-0 text-right font-mono text-[10.5px] text-[var(--cf-text-faint)]">{index + 1}</span>
            {engine.provider === "local" ? (
              <div className="flex min-w-0 flex-1 items-center gap-1.5">
                <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-[var(--cf-border)] px-1.5 py-px text-[10.5px] text-[var(--cf-text-muted)]">
                  <Cpu size={10} />
                  {t("flows.ai.localModel")}
                </span>
                <input
                  className={fieldClass({ size: "sm", className: "min-w-0 flex-1 font-mono text-[11.5px]" })}
                  value={engine.model}
                  placeholder={t("flows.ai.localModelDefault")}
                  aria-label={t("flows.ai.localModel")}
                  onChange={(event) => set({ ...engine, model: event.target.value })}
                />
              </div>
            ) : (
              <div className="min-w-0 flex-1">
                <ChatModelPicker
                  variant="tag"
                  liveModel={null}
                  chatActive={false}
                  task="flows"
                  bound={{
                    provider: engine.provider,
                    model: engine.model,
                    account: engine.account && engine.account !== SYSTEM_ACCOUNT ? engine.account : null,
                  }}
                  onPick={(provider, model, account) => set({ provider, model, account: account ?? "" })}
                />
              </div>
            )}
            {repeated && (
              <span className="shrink-0 text-[11px] text-[var(--cf-text-faint)]" title={t("flows.ai.repeatedHint")}>
                {t("flows.ai.repeated")}
              </span>
            )}
            <button
              type="button"
              className={iconButtonClass({ size: "xs" })}
              title={t("flows.param.removeRow")}
              aria-label={t("flows.param.removeRow")}
              onClick={() => write(rows.filter((_, i) => i !== index))}
            >
              <X size={12} />
            </button>
          </div>
        );
      })}
      <div className="flex flex-wrap gap-1">
        <button
          type="button"
          className="inline-flex h-6 w-fit items-center gap-1 rounded-md px-1.5 text-[12px] text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)] disabled:opacity-50"
          disabled={!unused}
          onClick={() => unused && write([...rows, { provider: unused, model: "", account: "" }])}
        >
          <Plus size={12} />
          {t("flows.ai.addFallback")}
        </button>
        <button
          type="button"
          className="inline-flex h-6 w-fit items-center gap-1 rounded-md px-1.5 text-[12px] text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)] disabled:opacity-50"
          disabled={rows.some((row) => row.provider === "local")}
          onClick={() => write([...rows, { provider: "local", model: "", account: "" }])}
        >
          <Cpu size={12} />
          {t("flows.ai.addLocal")}
        </button>
      </div>
    </div>
  );
}

const FIELD_TYPES = ["string", "number", "integer", "boolean", "list", "enum"] as const;

/** The fields an answer must have — the schema the node checks it against. */
export function AnswerFieldsEditor({ value, onChange }: { value: unknown; onChange: (next: unknown) => void }) {
  const t = useT();
  return (
    <Rows
      rows={asRows(value)}
      onChange={onChange}
      blank={() => ({ name: "", type: "string", description: "", required: true })}
      addLabel={t("flows.ai.addField")}
      render={(row, set) => (
        <div className="flex min-w-0 flex-1 flex-col gap-1 rounded-md bg-[var(--cf-sunken)] p-1.5">
          <div className="flex min-w-0 gap-1.5">
            <input
              className={fieldClass({ size: "sm", className: "min-w-0 flex-1 font-mono text-[11.5px]" })}
              value={str(row.name)}
              placeholder={t("flows.ai.fieldName")}
              aria-label={t("flows.ai.fieldName")}
              onChange={(event) => set({ ...row, name: event.target.value })}
            />
            <div className="w-[120px] shrink-0">
              <Select
                value={str(row.type) || "string"}
                onChange={(type) => set({ ...row, type })}
                options={FIELD_TYPES.map((type) => ({ value: type, label: t(`flows.ai.type.${type}` as TranslationKey) }))}
                size="sm"
              />
            </div>
          </div>
          {row.type === "enum" && (
            <input
              className={fieldClass({ size: "sm", className: "w-full text-[12px]" })}
              value={str(row.options)}
              placeholder={t("flows.ai.optionsPlaceholder")}
              aria-label={t("flows.ai.options")}
              onChange={(event) => set({ ...row, options: event.target.value })}
            />
          )}
          <input
            className={fieldClass({ size: "sm", className: "w-full text-[12px]" })}
            value={str(row.description)}
            placeholder={t("flows.ai.fieldDescription")}
            aria-label={t("flows.ai.fieldDescription")}
            onChange={(event) => set({ ...row, description: event.target.value })}
          />
          <label className="inline-flex items-center gap-1.5 text-[12px] text-[var(--cf-text-muted)]">
            <Checkbox checked={row.required !== false} onChange={(required) => set({ ...row, required })} />
            {t("flows.ai.required")}
          </label>
        </div>
      )}
    />
  );
}

/** What a classifier chooses from: a name, and what it means when that is not obvious. */
export function CategoriesEditor({ value, onChange }: { value: unknown; onChange: (next: unknown) => void }) {
  const t = useT();
  return (
    <Rows
      rows={asRows(value)}
      onChange={onChange}
      blank={() => ({ name: "", description: "" })}
      addLabel={t("flows.ai.addCategory")}
      render={(row, set) => (
        <>
          <input
            className={fieldClass({ size: "sm", className: "w-[130px] shrink-0 font-mono text-[11.5px]" })}
            value={str(row.name)}
            placeholder={t("flows.ai.categoryName")}
            aria-label={t("flows.ai.categoryName")}
            onChange={(event) => set({ ...row, name: event.target.value })}
          />
          <input
            className={fieldClass({ size: "sm", className: "min-w-0 flex-1 text-[12px]" })}
            value={str(row.description)}
            placeholder={t("flows.ai.categoryDescription")}
            aria-label={t("flows.ai.categoryDescription")}
            onChange={(event) => set({ ...row, description: event.target.value })}
          />
        </>
      )}
    />
  );
}

/** CodeFlow's own MCP servers the agent runs with, by name. */
export function McpServersField({ value, onChange }: { value: unknown; onChange: (next: unknown) => void }) {
  const t = useT();
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const [servers, setServers] = useState<McpServer[] | null>(null);
  useEffect(() => {
    if (!workspaceId) return;
    let alive = true;
    void mcpList(workspaceId)
      .then((rows) => alive && setServers(rows.filter((row) => row.enabled)))
      .catch(() => alive && setServers([]));
    return () => {
      alive = false;
    };
  }, [workspaceId]);
  if (servers === null) return null;
  if (servers.length === 0) return <span className="text-[12px] text-[var(--cf-text-muted)]">{t("flows.ai.noMcp")}</span>;
  const chosen = Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  return (
    <div className="flex flex-wrap gap-1">
      {servers.map((server) => {
        const on = chosen.includes(server.name);
        return (
          <button
            key={server.id}
            type="button"
            aria-pressed={on}
            className={`h-[24px] rounded-md px-2 font-mono text-[11.5px] transition-colors ${
              on
                ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)] shadow-[inset_0_0_0_1px_var(--cf-accent-line)]"
                : "text-[var(--cf-text-muted)] shadow-[inset_0_0_0_1px_var(--cf-border)] hover:bg-[var(--cf-hover)]"
            }`}
            onClick={() => onChange(on ? chosen.filter((name) => name !== server.name) : [...chosen, server.name])}
          >
            {server.name}
          </button>
        );
      })}
    </div>
  );
}

/** A model of the node's local server: typed, or picked from what the server lists. */
export function LocalModelField({
  value,
  onChange,
  server,
  url,
}: {
  value: unknown;
  onChange: (next: unknown) => void;
  server: string;
  url: string;
}) {
  const t = useT();
  const listId = useId();
  const [models, setModels] = useState<string[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => {
      void flowsLocalModels(server || "auto", url)
        .then((list) => {
          if (!alive) return;
          setModels(list);
          setProblem(null);
        })
        .catch((error) => alive && setProblem(String(error)));
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [server, url, tick]);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex min-w-0 items-center gap-1.5">
        <input
          list={listId}
          className={fieldClass({ size: "sm", className: "min-w-0 flex-1 font-mono text-[11.5px]" })}
          value={str(value)}
          placeholder={t("flows.ai.localModelDefault")}
          aria-label={t("flows.param.model")}
          onChange={(event) => onChange(event.target.value)}
        />
        <datalist id={listId}>
          {models.map((model) => (
            <option key={model} value={model} />
          ))}
        </datalist>
        <button
          type="button"
          className={iconButtonClass({ size: "sm" })}
          title={t("flows.ai.reloadModels")}
          aria-label={t("flows.ai.reloadModels")}
          onClick={() => setTick((n) => n + 1)}
        >
          <RefreshCw size={13} />
        </button>
      </div>
      {problem && <span className="text-[11.5px] text-[var(--cf-text-muted)]">{problem}</span>}
    </div>
  );
}

/** A model of a provider's API: typed, or picked from the list the provider gives with the node's
 *  credential — reread when the provider, its address or the credential changes. */
export function ApiModelField({
  value,
  onChange,
  provider,
  baseUrl,
  credentialId,
  purpose,
}: {
  value: unknown;
  onChange: (next: unknown) => void;
  provider: string;
  baseUrl: string;
  credentialId: string;
  purpose: "chat" | "embed";
}) {
  const t = useT();
  const listId = useId();
  const [models, setModels] = useState<string[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  // The hosted APIs list nothing without a key; a local or compatible server may not need one.
  const askable = !!credentialId || provider === "compatible" || provider === "ollama";
  useEffect(() => {
    if (!askable || (provider === "compatible" && !baseUrl.trim())) {
      setModels([]);
      setProblem(null);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      void flowsAiModels(provider, baseUrl, credentialId || null, purpose)
        .then((list) => {
          if (!alive) return;
          setModels(list);
          setProblem(null);
        })
        .catch((error) => alive && setProblem(String(error)));
    }, 300);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [askable, provider, baseUrl, credentialId, purpose, tick]);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex min-w-0 items-center gap-1.5">
        <input
          list={listId}
          className={fieldClass({ size: "sm", className: "min-w-0 flex-1 font-mono text-[11.5px]" })}
          value={str(value)}
          placeholder={askable ? t("flows.ai.pickModel") : t("flows.ai.modelNeedsKey")}
          aria-label={t("flows.param.apiModel")}
          onChange={(event) => onChange(event.target.value)}
        />
        <datalist id={listId}>
          {models.map((model) => (
            <option key={model} value={model} />
          ))}
        </datalist>
        <button
          type="button"
          className={iconButtonClass({ size: "sm" })}
          title={t("flows.ai.reloadModels")}
          aria-label={t("flows.ai.reloadModels")}
          disabled={!askable}
          onClick={() => setTick((n) => n + 1)}
        >
          <RefreshCw size={13} />
        </button>
      </div>
      {problem && <span className="text-[11.5px] text-[var(--cf-text-muted)]">{problem}</span>}
    </div>
  );
}

const agentCache = new Map<string, WorkspaceAgent[]>();

/** An agent of the workspace's roster. */
export function AgentPicker({ value, onChange }: { value: unknown; onChange: (next: unknown) => void }) {
  const t = useT();
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const [agents, setAgents] = useState<WorkspaceAgent[]>(() => (workspaceId ? agentCache.get(workspaceId) ?? [] : []));
  useEffect(() => {
    if (!workspaceId) return;
    let alive = true;
    void listWorkspaceAgents(workspaceId)
      .then((rows) => {
        agentCache.set(workspaceId, rows);
        if (alive) setAgents(rows);
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
        placeholder={t("flows.ai.pickAgent")}
        options={agents.filter((agent) => agent.enabled).map((agent) => ({ value: agent.id, label: agent.name }))}
        size="sm"
      />
    </div>
  );
}

const templateCache = new Map<string, ChainTemplate[]>();

/** A saved chain template of the workspace — the step kind; a hybrid task's setup does not run here. */
export function ChainTemplatePicker({ value, onChange }: { value: unknown; onChange: (next: unknown) => void }) {
  const t = useT();
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const [templates, setTemplates] = useState<ChainTemplate[]>(() => (workspaceId ? templateCache.get(workspaceId) ?? [] : []));
  useEffect(() => {
    if (!workspaceId) return;
    let alive = true;
    void listChainTemplates(workspaceId)
      .then((rows) => {
        templateCache.set(workspaceId, rows);
        if (alive) setTemplates(rows);
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
        placeholder={t("flows.ai.pickTemplate")}
        options={templates.filter((template) => template.kind !== "hybrid").map((template) => ({ value: template.id, label: template.name }))}
        size="sm"
      />
    </div>
  );
}

let readOnlyEngines: Promise<string[]> | null = null;

/** Whether "read only" is a limit `provider`'s CLI enforces, or only something it is asked. */
export function useEnforcesReadOnly(provider: string): boolean | null {
  const [engines, setEngines] = useState<string[] | null>(null);
  useEffect(() => {
    let alive = true;
    readOnlyEngines ??= aiReadOnlyEngines().catch(() => []);
    void readOnlyEngines.then((list) => alive && setEngines(list));
    return () => {
      alive = false;
    };
  }, []);
  return engines === null ? null : engines.includes(provider);
}

/** The line under an agent's access: what read-only really means on this engine, or what editing leaves behind. */
export function AccessHint({ params }: { params: Record<string, unknown> }) {
  const t = useT();
  const engine = engineOf(params.engine);
  const routedProvider = useTaskProvider("flows");
  const provider = engine.provider || routedProvider;
  const enforces = useEnforcesReadOnly(provider);
  const label = AI_PROVIDERS.find((p) => p.id === provider)?.label ?? provider;
  const editing = params.access === "edit";
  if (!editing && enforces === null) return null;
  const text = editing
    ? params.workIn === "temp" || !params.workIn
      ? t("flows.ai.editTemp")
      : t("flows.ai.editRestore")
    : enforces
      ? t("flows.ai.readOnlyEnforced", { engine: label })
      : t("flows.ai.readOnlyAsked", { engine: label });
  return <span className="text-[11.5px] leading-[1.4] text-[var(--cf-text-faint)]">{text}</span>;
}
