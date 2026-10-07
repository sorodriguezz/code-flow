import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { CircleAlert, CircleHelp, Copy, Globe, Pencil, Pin, PinOff, Play, Radio, X } from "lucide-react";
import { Button, iconButtonClass } from "../common/Button";
import { Checkbox } from "../common/Checkbox";
import { Select } from "../common/Select";
import { fieldClass, underlineStripClass, underlineTabClass } from "../common/recipes";
import { AiGlyph, type AiGlyphName } from "../common/AiGlyph";
import { AssistContext, type FlowAssist } from "./assist";
import { DataModeSwitch, FieldDragGhost, ItemsView, type DataMode } from "./DataView";
import { ParamFields } from "./ParamFields";
import { familyColor, nodeIcon } from "../../lib/flows/nodeIcons";
import {
  RUNS_THROUGH,
  baseOutputCount,
  hasErrorOutput,
  inputCount,
  outputCount,
  portLabels,
  portText,
  renameNode,
  setNodeParam,
  setNodeSettings,
  type FlowNodeSpec,
} from "../../lib/flows/spec";
import {
  flowsCliCommand,
  flowsRunNodeData,
  type FlowNodeData,
  type FlowNodeDescriptor,
  type FlowRunNodeRow,
} from "../../lib/tauri/flowsCommands";
import type { TranslationKey } from "../../lib/i18n/translations";
import { useFlowRunsStore } from "../../state/flowRunsStore";
import { useFlowsStore } from "../../state/flowsStore";
import { useFlowVaultStore } from "../../state/flowVaultStore";
import { useLanguageStore, useT } from "../../state/languageStore";
import { pushErrorToast, pushSuccessToast } from "../../state/toastStore";

/**
 * A node, opened: what came in on the left, what it is told in the middle, what came out on the
 * right — n8n's three columns, because the job is the same one: look at real data, shape the next
 * step around it, test the step, repeat.
 *
 * Data is the newest run's (pinned output wins on the right). Fields on the left drag into the
 * parameters, and every field suggests what can be written in it — from this data, handed down as
 * `AssistContext`: the input, the other nodes (their output fetched when an expression names them)
 * and the variables. "Probar paso" saves the flow and runs this node on its last input — or, when
 * there is none, everything up to it.
 */

const AI_GLYPHS = new Set<string>(["bot", "cpu", "list-checks", "file-braces", "message-square-text", "eye", "scan-eye", "messages-square", "pencil", "brain-circuit", "binary", "database-zap", "wand", "reply", "scan-search", "audio-lines", "columns-3", "image-plus", "volume-2", "shield-alert", "wand-sparkles"]);
const DATA_LIMIT = 200;
/** Stable empties, so what is handed to the fields only changes when the data does. */
const NO_PORTS: unknown[][] = [];
const NO_ITEMS: unknown[] = [];

const dataCache = new Map<string, FlowNodeData | null>();

/** A node's data in a run, fetched once per finished state. */
function useNodeData(runId: string | null, node: FlowRunNodeRow | undefined): { data: FlowNodeData | null; loading: boolean } {
  const key = runId && node && node.status !== "running" ? `${runId}/${node.nodeId}/${node.status}/${node.finishedAt ?? ""}` : null;
  const [state, setState] = useState<{ key: string | null; data: FlowNodeData | null }>({ key: null, data: null });
  useEffect(() => {
    if (!key || !runId || !node) return;
    if (dataCache.has(key)) {
      setState({ key, data: dataCache.get(key) ?? null });
      return;
    }
    let alive = true;
    void flowsRunNodeData(runId, node.nodeId, DATA_LIMIT)
      .then((data) => {
        dataCache.set(key, data);
        if (alive) setState({ key, data });
      })
      .catch(() => alive && setState({ key, data: null }));
    return () => {
      alive = false;
    };
  }, [key, runId, node]);
  return { data: state.key === key ? state.data : null, loading: !!key && state.key !== key };
}

function portName(label: string, t: ReturnType<typeof useT>): string {
  return portText(label, (key) => t(key as TranslationKey));
}

function PortTabs({ labels, counts, active, onChange }: { labels: string[]; counts: number[]; active: number; onChange: (port: number) => void }) {
  if (labels.length <= 1) return null;
  return (
    <div className={`${underlineStripClass} h-8 px-3`}>
      {labels.map((label, index) => (
        <button key={index} type="button" className={underlineTabClass(active === index)} onClick={() => onChange(index)}>
          {label}
          <span className="text-[11px] tabular-nums text-[var(--cf-text-faint)]">{counts[index] ?? 0}</span>
          {active === index && <span className="absolute inset-x-0 -bottom-px h-[2px] rounded bg-[var(--cf-accent)]" />}
        </button>
      ))}
    </div>
  );
}

function PanelHead({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--cf-border)] px-3">
      <span className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]">{title}</span>
      {children}
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="flex flex-1 flex-col items-center justify-center gap-2.5 px-6 text-center text-[12px] text-[var(--cf-text-muted)]">{children}</div>;
}

/** The one thing worth knowing about a node beyond what it does — only where there is one. */
function nodeTip(type: string, params: Record<string, unknown>, t: (key: TranslationKey) => string): string {
  if (type === "logic.wait" && params.mode === "webhook") return t("flows.help.waitWebhook");
  if (type === "logic.loop") return t("flows.help.loop");
  if (type === "logic.approval") return t("flows.help.approval");
  if (type === "trigger.phone") return t("flows.help.phone");
  if (type === "ai.prReview") return t("flows.help.prReview");
  if (type === "trigger.manual") return t("flows.help.manualForm");
  if (type === "ai.chat") return t("flows.help.chat");
  if (type === "data.dbml") return t("flows.help.dbml");
  if (type === "app.apiRequest") return t("flows.help.apiRequest");
  if (type === "transform.changes") return t("flows.help.changes");
  if (type === "transform.template") return t("flows.help.template");
  if (type === "transform.sql") return t("flows.help.sql");
  if (type === "net.check") return t("flows.help.check");
  if (type === "net.google") return t("flows.help.google");
  if (type === "trigger.github") return t("flows.help.github");
  if (type === "trigger.email" || type === "net.imap") return t("flows.help.email");
  if (type === "net.queue") return t("flows.help.queue");
  if ((type === "ai.local" || type === "ai.api") && Array.isArray(params.toolFlows) && params.toolFlows.length > 0) return t("flows.help.tools");
  if (type === "ai.api") return t("flows.help.apiChat");
  if (type === "ai.vectors") return t("flows.help.vectors");
  if (type === "app.prDecide") return t("flows.help.prDecide");
  if (type === "app.prMemory") return t("flows.help.prMemory");
  if (type === "ai.prFix") return t("flows.help.prFix");
  if (type === "ai.prReply") return t("flows.help.prReply");
  if (type === "trigger.form") return t("flows.help.form");
  if (type === "trigger.chat") return t("flows.help.chatTrigger");
  if (type === "trigger.context") return t("flows.help.context");
  if (type === "trigger.clipboard") return t("flows.help.clipboard");
  if (type === "trigger.subflow" && params.publishAsNode === true) return t("flows.help.publishedNode");
  if (type === "ai.transform") return t("flows.help.transform");
  if (type === "ai.guard") return t("flows.help.guard");
  if (type === "data.table") return t("flows.help.table");
  if (type === "logic.assert") return t("flows.help.assert");
  if (type === "app.runData") return t("flows.help.runData");
  if (type === "net.browser") return t("flows.help.browser");
  return "";
}

export default function NodeInspector({ nodeId, onClose }: { nodeId: string; onClose: () => void }) {
  const t = useT();
  const flowId = useFlowsStore((s) => s.draft?.id ?? "");
  const node = useFlowsStore((s) => s.draft?.spec.nodes.find((n) => n.id === nodeId) ?? null);
  const connections = useFlowsStore((s) => s.draft?.spec.connections ?? []);
  const catalogMap = useFlowsStore((s) => s.catalogMap);
  const live = useFlowRunsStore((s) => s.current[flowId]);
  const pinned = useFlowRunsStore((s) => s.pins[flowId]?.[nodeId]);
  const running = live?.run.status === "running";
  const [tab, setTab] = useState<"params" | "settings">("params");
  const [inMode, setInMode] = useState<DataMode>("schema");
  const [outMode, setOutMode] = useState<DataMode>("table");
  const [inPort, setInPort] = useState(0);
  const [outPort, setOutPort] = useState(0);
  const [naming, setNaming] = useState<string | null>(null);
  const [editingPin, setEditingPin] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Escape inside an editor, or in a field whose suggestions are open, is that field's own.
      const own = event.target instanceof HTMLElement && (event.target.closest(".monaco-editor") || event.target.getAttribute("aria-expanded") === "true");
      if (event.key === "Escape" && !own) {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const descriptor = node ? catalogMap.get(node.type) : undefined;
  const record = live?.nodes[nodeId];
  const own = useNodeData(live?.run.id ?? null, record);

  // A node that has not run reads its input from what its parents gave, port by port.
  const parentLinks = useMemo(() => connections.filter((c) => c.to === nodeId), [connections, nodeId]);
  const [parentData, setParentData] = useState<{ key: string; ports: unknown[][]; counts: number[] } | null>(null);
  const parentKey = live
    ? `${live.run.id}/${parentLinks.map((c) => `${c.from}:${c.out}>${c.in}:${live.nodes[c.from]?.status ?? ""}`).join(",")}`
    : "";
  useEffect(() => {
    if (!live || !descriptor || record?.status === "success" || record?.status === "error" || parentLinks.length === 0) return;
    let alive = true;
    const ports: unknown[][] = Array.from({ length: Math.max(node ? inputCount(node, descriptor) : descriptor.inputs, 1) }, () => []);
    const counts = ports.map(() => 0);
    void Promise.all(
      parentLinks.map(async (link) => {
        const parent = live.nodes[link.from];
        if (!parent || parent.status === "running") return;
        const data = await flowsRunNodeData(live.run.id, link.from, DATA_LIMIT).catch(() => null);
        if (!data) return;
        ports[link.in]?.push(...(data.outputs[link.out] ?? []));
        counts[link.in] = (counts[link.in] ?? 0) + (data.outputCounts[link.out] ?? 0);
      }),
    ).then(() => alive && setParentData({ key: parentKey, ports, counts }));
    return () => {
      alive = false;
    };
    // `parentKey` captures everything the fetch depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parentKey, descriptor, record?.status]);

  const inputs: unknown[][] =
    own.data && (record?.status === "success" || record?.status === "error")
      ? own.data.inputs
      : parentData?.key === parentKey
        ? parentData.ports
        : NO_PORTS;

  // What the fields suggest. Another node's output is fetched the first time an expression names
  // it (`want`), from the newest run — or its pinned output — and forgotten when a new run starts.
  const flowNodes = useFlowsStore((s) => s.draft?.spec.nodes);
  // By names alone, so typing in a parameter (a new spec each keystroke) leaves the suggestions be.
  const nodeNames = (flowNodes ?? []).map((n) => `${n.id}\u0001${n.name}`).join("\u0002");
  const variables = useFlowVaultStore((s) => s.variables);
  const [nodeOutputs, setNodeOutputs] = useState<Record<string, unknown[]>>({});
  const asked = useRef(new Set<string>());
  const runId = live?.run.id;
  useEffect(() => {
    asked.current.clear();
    setNodeOutputs({});
  }, [runId]);
  const want = useCallback(
    (name: string) => {
      if (asked.current.has(name)) return;
      asked.current.add(name);
      const target = useFlowsStore.getState().draft?.spec.nodes.find((n) => n.name === name);
      if (!target) return;
      const keep = (list: unknown[]) => setNodeOutputs((current) => ({ ...current, [name]: list }));
      const pin = useFlowRunsStore.getState().pins[flowId]?.[target.id];
      if (pin) return keep(pin[0] ?? []);
      const run = useFlowRunsStore.getState().current[flowId];
      const status = run?.nodes[target.id]?.status;
      if (!run || (status !== "success" && status !== "error")) return;
      void flowsRunNodeData(run.run.id, target.id, 20)
        .then((data) => keep(data?.outputs[0] ?? []))
        .catch(() => {});
    },
    [flowId],
  );
  const assist = useMemo<FlowAssist>(() => {
    // The nodes upstream first, nearest first: those are the ones an expression here can read.
    const distance = new Map<string, number>([[nodeId, 0]]);
    const queue = [nodeId];
    while (queue.length) {
      const id = queue.shift() as string;
      for (const link of connections) {
        if (link.to === id && !distance.has(link.from)) {
          distance.set(link.from, (distance.get(id) ?? 0) + 1);
          queue.push(link.from);
        }
      }
    }
    const others = nodeNames
      .split("\u0002")
      .filter(Boolean)
      .map((entry) => {
        const [id, name] = entry.split("\u0001");
        return { id, name };
      })
      .filter((n) => n.id !== nodeId);
    others.sort((a, b) => (distance.get(a.id) ?? Infinity) - (distance.get(b.id) ?? Infinity));
    return {
      data: {
        input: inputs.find((port) => port.length > 0) ?? NO_ITEMS,
        nodes: others.map((n) => ({ name: n.name, output: nodeOutputs[n.name] })),
        vars: Object.fromEntries(variables.map((v) => [v.name, v.value])),
      },
      want,
    };
  }, [inputs, nodeNames, connections, nodeId, nodeOutputs, variables, want]);

  if (!node || !descriptor) return null;

  const isTrigger = descriptor.family === "trigger";
  const inputCounts =
    own.data && (record?.status === "success" || record?.status === "error") ? own.data.inputCounts : parentData?.key === parentKey ? parentData.counts : [];
  const outputs: unknown[][] = pinned ?? own.data?.outputs ?? [];
  const outputCounts = pinned ? pinned.map((port) => port.length) : own.data?.outputCounts ?? [];

  const labels = portLabels(node, descriptor);
  const inputTotal = inputCount(node, descriptor);
  const inputLabels =
    labels.inputs.length > 0 ? labels.inputs.map((l) => portName(l, t)) : inputTotal > 1 ? Array.from({ length: inputTotal }, (_, i) => String(i + 1)) : [""];
  const ports = outputCount(node, descriptor);
  const baseOutputs = baseOutputCount(node, descriptor);
  const outputLabels = Array.from({ length: ports }, (_, index) => {
    if (hasErrorOutput(node, descriptor) && index === baseOutputs) return t("flows.port.error");
    const label = labels.outputs[index];
    return label ? portName(label, t) : ports > 1 ? String(index + 1) : "";
  });

  const edit = (next: ReturnType<typeof setNodeParam> | null) => {
    if (next) useFlowsStore.getState().edit(next);
  };
  const spec = () => useFlowsStore.getState().draft?.spec ?? null;

  const testStep = async () => {
    await useFlowsStore.getState().flush();
    void useFlowRunsStore.getState().start(flowId, { kind: "step", node: nodeId });
  };
  const runUpTo = async () => {
    await useFlowsStore.getState().flush();
    void useFlowRunsStore.getState().start(flowId, { kind: "upTo", node: nodeId });
  };

  const pinCurrent = async () => {
    if (!live) return;
    const full = await flowsRunNodeData(live.run.id, nodeId, 5000).catch(() => null);
    if (full) void useFlowRunsStore.getState().pin(flowId, nodeId, full.outputs);
  };
  const savePinned = () => {
    if (editingPin === null) return;
    try {
      const parsed: unknown = JSON.parse(editingPin);
      const list = Array.isArray(parsed) ? parsed : [parsed];
      if (!list.every((item) => item && typeof item === "object" && !Array.isArray(item))) throw new Error(t("flows.inspector.pinObjects"));
      const next: unknown[][] = Array.from({ length: Math.max(ports, 1) }, (_, index) => (index === outPort ? list : pinned?.[index] ?? []));
      void useFlowRunsStore.getState().pin(flowId, nodeId, next);
      setEditingPin(null);
    } catch (error) {
      pushErrorToast(String(error instanceof Error ? error.message : error));
    }
  };

  const Icon = nodeIcon(descriptor.icon);
  const settings = node.settings ?? {};
  const setSetting = (change: Record<string, unknown>) => {
    const doc = spec();
    if (doc) useFlowsStore.getState().edit(setNodeSettings(doc, catalogMap, nodeId, change));
  };

  const status = record?.status;
  return (
    <div
      className="absolute inset-2 z-30 flex min-h-0 flex-col overflow-hidden rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface)] shadow-[var(--cf-shadow)]"
      role="dialog"
      aria-label={node.name}
      data-tour="flows-inspector"
    >
      <header className="flex h-12 shrink-0 items-center gap-2.5 border-b border-[var(--cf-border)] pl-3 pr-2" style={{ "--node-color": familyColor(descriptor.family) } as CSSProperties}>
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] bg-[color-mix(in_oklab,var(--node-color)_14%,var(--cf-surface))] text-[var(--node-color)]">
          {descriptor.family === "ai" && AI_GLYPHS.has(descriptor.icon) ? <AiGlyph name={descriptor.icon as AiGlyphName} size={16} /> : <Icon size={16} />}
        </span>
        {naming === null ? (
          <button
            type="button"
            className="group flex min-w-0 items-center gap-1.5 rounded-md px-1 text-[14px] font-semibold hover:bg-[var(--cf-hover)]"
            onClick={() => setNaming(node.name)}
            title={t("flows.rename")}
          >
            <span className="truncate">{node.name}</span>
            <Pencil size={12} className="shrink-0 text-[var(--cf-text-faint)] opacity-0 group-hover:opacity-100" />
          </button>
        ) : (
          <input
            autoFocus
            value={naming}
            className={fieldClass({ size: "sm", className: "w-64 font-semibold" })}
            onChange={(event) => setNaming(event.target.value)}
            onBlur={() => {
              const doc = spec();
              const next = doc ? renameNode(doc, nodeId, naming) : null;
              if (next && naming.trim() !== node.name) edit(next);
              else if (!next && naming.trim() && naming.trim() !== node.name) pushErrorToast(t("flows.nameTaken", { name: naming.trim() }));
              setNaming(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") (event.target as HTMLInputElement).blur();
              if (event.key === "Escape") {
                event.stopPropagation();
                setNaming(null);
              }
            }}
          />
        )}
        <span className="min-w-0 truncate text-[12px] text-[var(--cf-text-faint)]">{t(`flows.node.${node.type}` as TranslationKey)}</span>
        {/* The node's help: what it does, and where it has one, the one thing worth knowing to use it. */}
        <span
          className="shrink-0 text-[var(--cf-text-faint)] hover:text-[var(--cf-text-muted)]"
          title={[t(`flows.nodeDesc.${node.type}` as TranslationKey), nodeTip(node.type, node.params, t)].filter(Boolean).join("\n\n")}
          aria-label={t(`flows.nodeDesc.${node.type}` as TranslationKey)}
        >
          <CircleHelp size={13} />
        </span>
        <span className="flex-1" />
        {descriptor.milestone > RUNS_THROUGH && <span className="text-[11.5px] text-[var(--cf-text-muted)]">{t("flows.inspector.later", { n: descriptor.milestone })}</span>}
        <Button variant="primary" size="sm" onClick={() => void testStep()} disabled={running || descriptor.milestone > RUNS_THROUGH} data-tour="flows-test-step">
          <Play size={12} />
          {isTrigger ? t("flows.inspector.runTrigger") : t("flows.inspector.testStep")}
        </Button>
        <button type="button" className={iconButtonClass({ size: "sm" })} onClick={onClose} title={t("common.close")} aria-label={t("common.close")}>
          <X size={15} />
        </button>
      </header>

      <div
        className={`grid min-h-0 flex-1 ${
          isTrigger ? "grid-cols-[minmax(380px,1.3fr)_minmax(0,1fr)]" : "grid-cols-[minmax(0,0.85fr)_minmax(400px,1.35fr)_minmax(0,0.85fr)]"
        }`}
      >
        {!isTrigger && (
          <section className="flex min-h-0 min-w-0 flex-col border-r border-[var(--cf-border)] bg-[color-mix(in_oklab,var(--cf-sunken)_45%,var(--cf-surface))]">
            <PanelHead title={t("flows.inspector.input")}>
              {inputs.some((port) => port.length > 0) && <DataModeSwitch mode={inMode} onChange={setInMode} />}
            </PanelHead>
            <PortTabs labels={inputLabels} counts={inputCounts} active={inPort} onChange={setInPort} />
            {inputs.some((port) => port.length > 0) ? (
              <ItemsView items={inputs[inPort] ?? []} total={inputCounts[inPort] ?? 0} mode={inMode} fieldDrag />
            ) : (
              <Empty>
                <span>{parentLinks.length === 0 ? t("flows.inspector.noParents") : t("flows.inspector.noInput")}</span>
                {parentLinks.length > 0 && (
                  <Button size="sm" onClick={() => void runUpTo()} disabled={running}>
                    <Play size={12} />
                    {t("flows.inspector.runPrevious")}
                  </Button>
                )}
              </Empty>
            )}
          </section>
        )}

        <section className="flex min-h-0 min-w-0 flex-col border-r border-[var(--cf-border)]">
          <div className={`${underlineStripClass} h-10`}>
            {(["params", "settings"] as const).map((name) => (
              <button key={name} type="button" className={underlineTabClass(tab === name)} onClick={() => setTab(name)}>
                {t(name === "params" ? "flows.inspector.params" : "flows.inspector.settings")}
                {tab === name && <span className="absolute inset-x-0 -bottom-px h-[2px] rounded bg-[var(--cf-accent)]" />}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3.5">
            {tab === "params" && isTrigger && node.type !== "trigger.manual" && <TriggerInfo flowId={flowId} node={node} />}
            {tab === "params" ? (
              <AssistContext.Provider value={assist}>
                <ParamFields
                  specs={descriptor.params}
                  params={node.params ?? {}}
                  flowId={flowId}
                  nodeId={nodeId}
                  typeId={node.type}
                  onChange={(name, value) => {
                    const doc = spec();
                    if (doc) edit(setNodeParam(doc, nodeId, name, value, catalogMap));
                  }}
                />
              </AssistContext.Provider>
            ) : (
              <NodeSettingsForm node={node} descriptor={descriptor} settings={settings} onChange={setSetting} />
            )}
          </div>
        </section>

        <section className="flex min-h-0 min-w-0 flex-col bg-[color-mix(in_oklab,var(--cf-sunken)_45%,var(--cf-surface))]">
          <PanelHead title={t("flows.inspector.output")}>
            {pinned && (
              <span className="inline-flex items-center gap-1 rounded-[5px] bg-[var(--cf-accent-soft)] px-1.5 py-[1px] text-[11px] font-medium text-[var(--cf-accent)]">
                <Pin size={11} />
                {t("flows.inspector.pinned")}
              </span>
            )}
            {outputs.some((port) => port.length > 0) && editingPin === null && <DataModeSwitch mode={outMode} onChange={setOutMode} />}
            {pinned ? (
              <>
                <button type="button" className={iconButtonClass({ size: "sm" })} title={t("flows.inspector.editPinned")} aria-label={t("flows.inspector.editPinned")} onClick={() => setEditingPin(JSON.stringify(pinned[outPort] ?? [], null, 2))}>
                  <Pencil size={13} />
                </button>
                <button type="button" className={iconButtonClass({ size: "sm" })} title={t("flows.inspector.unpin")} aria-label={t("flows.inspector.unpin")} onClick={() => void useFlowRunsStore.getState().unpin(flowId, nodeId)}>
                  <PinOff size={13} />
                </button>
              </>
            ) : (
              <>
                {own.data && outputs.some((port) => port.length > 0) && (
                  <button type="button" className={iconButtonClass({ size: "sm" })} title={t("flows.inspector.pin")} aria-label={t("flows.inspector.pin")} onClick={() => void pinCurrent()}>
                    <Pin size={13} />
                  </button>
                )}
                <button type="button" className={iconButtonClass({ size: "sm" })} title={t("flows.inspector.writePinned")} aria-label={t("flows.inspector.writePinned")} onClick={() => setEditingPin("[\n  {}\n]")}>
                  <Pencil size={13} />
                </button>
              </>
            )}
          </PanelHead>
          {editingPin !== null ? (
            <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
              <textarea
                value={editingPin}
                spellCheck={false}
                onChange={(event) => setEditingPin(event.target.value)}
                className={fieldClass({ className: "h-auto min-h-0 flex-1 resize-none py-2 font-mono text-[11.5px] leading-[1.5]" })}
              />
              <div className="flex justify-end gap-2">
                <Button size="sm" onClick={() => setEditingPin(null)}>
                  {t("common.cancel")}
                </Button>
                <Button size="sm" variant="primary" onClick={savePinned}>
                  <Pin size={12} />
                  {t("flows.inspector.savePinned")}
                </Button>
              </div>
            </div>
          ) : (
            <>
              {status === "error" && record?.error && !pinned && (
                <div className="m-3 mb-0 flex gap-2 rounded-lg bg-[color-mix(in_oklab,var(--cf-danger)_10%,transparent)] px-3 py-2 text-[12px] text-[var(--cf-danger)]">
                  <CircleAlert size={14} className="mt-[1px] shrink-0" />
                  <span className="min-w-0 whitespace-pre-wrap break-words font-mono text-[11.5px]">{record.error}</span>
                </div>
              )}
              <PortTabs labels={outputLabels} counts={outputCounts} active={outPort} onChange={setOutPort} />
              {outputs.some((port) => port.length > 0) ? (
                <ItemsView items={outputs[outPort] ?? []} total={outputCounts[outPort] ?? 0} mode={outMode} />
              ) : (
                <Empty>
                  {status === "running" ? (
                    <span>{t("flows.inspector.running")}</span>
                  ) : status === "skipped" ? (
                    <span>{t("flows.inspector.skipped")}</span>
                  ) : status === "success" || status === "error" ? (
                    <span>{t("flows.inspector.noOutput")}</span>
                  ) : (
                    <>
                      <span>{t("flows.inspector.notRun")}</span>
                      <Button size="sm" onClick={() => void testStep()} disabled={running || descriptor.milestone > RUNS_THROUGH}>
                        <Play size={12} />
                        {isTrigger ? t("flows.inspector.runTrigger") : t("flows.inspector.testStep")}
                      </Button>
                    </>
                  )}
                </Empty>
              )}
            </>
          )}
        </section>
      </div>
      <FieldDragGhost />
    </div>
  );
}

/**
 * What a trigger is doing right now: listening (with its webhook URL or its next run) when the flow
 * is active, or that it needs the flow switched on to listen at all.
 */
function TriggerInfo({ flowId, node }: { flowId: string; node: FlowNodeSpec }) {
  const t = useT();
  const language = useLanguageStore((s) => s.language);
  const active = useFlowsStore((s) => s.flows.find((flow) => flow.id === flowId)?.active ?? false);
  const view = useFlowRunsStore((s) => s.triggers.find((flow) => flow.flowId === flowId)?.triggers.find((tr) => tr.nodeId === node.id));
  const listening = active && !!view;
  return (
    <div
      className={`mb-3.5 flex flex-col gap-1 rounded-lg px-3 py-2 text-[12px] ${
        listening ? "bg-[color-mix(in_oklab,var(--cf-success)_9%,transparent)]" : "bg-[var(--cf-sunken)]"
      }`}
    >
      <span className="flex items-center gap-1.5 font-medium" style={{ color: listening ? "var(--cf-success)" : "var(--cf-text-muted)" }}>
        <Radio size={13} />
        {listening ? t("flows.trigger.listening") : t("flows.trigger.inactive")}
      </span>
      {listening && view?.url && (
        <span className="flex min-w-0 items-center gap-1.5">
          <code className="min-w-0 flex-1 truncate text-[11.5px]">{view.url}</code>
          <button
            type="button"
            className={iconButtonClass({ size: "xs" })}
            title={t("flows.schedule.copyUrl")}
            aria-label={t("flows.schedule.copyUrl")}
            onClick={() => void navigator.clipboard?.writeText(view.url ?? "").then(() => pushSuccessToast(t("flows.schedule.copied")))}
          >
            <Copy size={12} />
          </button>
        </span>
      )}
      {listening && view?.publicUrl && (
        // The same webhook on the internet, through the tunnel opened in Programación.
        <span className="flex min-w-0 items-center gap-1.5">
          <Globe size={11} className="shrink-0 text-[var(--cf-text-muted)]" />
          <code className="min-w-0 flex-1 truncate text-[11.5px]">{view.publicUrl}</code>
          <button
            type="button"
            className={iconButtonClass({ size: "xs" })}
            title={t("flows.tunnel.copyPublic")}
            aria-label={t("flows.tunnel.copyPublic")}
            onClick={() => void navigator.clipboard?.writeText(view.publicUrl ?? "").then(() => pushSuccessToast(t("flows.schedule.copied")))}
          >
            <Copy size={12} />
          </button>
        </span>
      )}
      {listening && node.type === "trigger.link" && view?.detail && <LinkCommand name={view.detail.replace(/^codeflow --flow /, "")} />}
      {listening && view?.next && (
        <span className="text-[var(--cf-text-muted)]">
          {t("flows.trigger.next", { at: new Date(view.next).toLocaleString(language, { weekday: "short", hour: "2-digit", minute: "2-digit" }) })}
        </span>
      )}
      {view?.problem && <span className="text-[var(--cf-danger)]">{view.problem}</span>}
    </div>
  );
}

/** The exact command line that starts this flow — this build's own executable, for a terminal, a
 *  git hook or a launcher (Raycast, Alfred, Atajos). */
function LinkCommand({ name }: { name: string }) {
  const t = useT();
  const [command, setCommand] = useState("");
  useEffect(() => {
    let alive = true;
    void flowsCliCommand(name).then((text) => alive && setCommand(text)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [name]);
  if (!command) return null;
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <code className="min-w-0 flex-1 truncate text-[11.5px]" title={command}>{command}</code>
      <button
        type="button"
        className={iconButtonClass({ size: "xs" })}
        title={t("flows.link.copy")}
        aria-label={t("flows.link.copy")}
        onClick={() => void navigator.clipboard?.writeText(command).then(() => pushSuccessToast(t("flows.schedule.copied")))}
      >
        <Copy size={12} />
      </button>
    </span>
  );
}

function NodeSettingsForm({
  node,
  descriptor,
  settings,
  onChange,
}: {
  node: FlowNodeSpec;
  descriptor: FlowNodeDescriptor;
  settings: Record<string, unknown>;
  onChange: (change: Record<string, unknown>) => void;
}) {
  const t = useT();
  const isTrigger = descriptor.family === "trigger";
  const number = (key: string, fallback: number) => (typeof settings[key] === "number" ? (settings[key] as number) : fallback);
  const terminal = node.type === "logic.stop" || node.type === "logic.noop";
  const row = (label: string, control: ReactNode, hint?: string) => (
    <div className="flex flex-col gap-1">
      <span className="text-[12px] font-medium text-[var(--cf-text-muted)]">{label}</span>
      {control}
      {hint && <span className="text-[11.5px] text-[var(--cf-text-faint)]">{hint}</span>}
    </div>
  );
  const check = (key: string, label: string) => (
    <label className="flex items-center gap-2 text-[12.5px] text-[var(--cf-text)]">
      <Checkbox checked={settings[key] === true} onChange={(checked) => onChange({ [key]: checked })} />
      {label}
    </label>
  );
  if (isTrigger) return <p className="text-[12px] text-[var(--cf-text-muted)]">{t("flows.settings.trigger")}</p>;
  return (
    <div className="flex flex-col gap-4">
      {check("retryOnFail", t("flows.settings.retryOnFail"))}
      {settings.retryOnFail === true && (
        <div className="ml-6 grid grid-cols-2 gap-3">
          {row(
            t("flows.settings.maxTries"),
            <input type="number" min={2} max={10} className={fieldClass({ size: "sm" })} value={number("maxTries", 3)} onChange={(e) => onChange({ maxTries: Number(e.target.value) || 3 })} />,
          )}
          {row(
            t("flows.settings.waitBetweenTries"),
            <input type="number" min={0} className={fieldClass({ size: "sm" })} value={number("waitBetweenTries", 1000)} onChange={(e) => onChange({ waitBetweenTries: Math.max(0, Number(e.target.value) || 0) })} />,
          )}
        </div>
      )}
      {row(
        t("flows.settings.timeoutSec"),
        <input
          type="number"
          min={0}
          className={fieldClass({ size: "sm", className: "w-40" })}
          value={number("timeoutSec", 0) || ""}
          placeholder={t("flows.settings.noLimit")}
          onChange={(e) => onChange({ timeoutSec: Number(e.target.value) || undefined })}
        />,
      )}
      {!terminal &&
        row(
          t("flows.settings.onError"),
          <div className="max-w-[300px]">
            <Select
              value={typeof settings.onError === "string" ? settings.onError : "stop"}
              onChange={(value) => onChange({ onError: value === "stop" ? undefined : value })}
              options={[
                { value: "stop", label: t("flows.settings.onErrorStop") },
                { value: "continue", label: t("flows.settings.onErrorContinue") },
                { value: "errorOutput", label: t("flows.settings.onErrorOutput") },
              ]}
              size="sm"
            />
          </div>,
          settings.onError === "errorOutput" ? t("flows.settings.onErrorOutputHint") : undefined,
        )}
      {check("executeOnce", t("flows.settings.executeOnce"))}
      {!terminal && check("alwaysOutputData", t("flows.settings.alwaysOutputData"))}
    </div>
  );
}
