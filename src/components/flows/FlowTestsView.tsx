import { useCallback, useEffect, useMemo, useState } from "react";
import { FlaskConical, Pencil, Play, Plus, Trash2, X } from "lucide-react";
import { Button, iconButtonClass } from "../common/Button";
import { Segmented } from "../common/Segmented";
import { Select } from "../common/Select";
import { fieldClass } from "../common/recipes";
import { confirmAction } from "../../state/confirmStore";
import { pushErrorToast } from "../../state/toastStore";
import { useFlowRunsStore } from "../../state/flowRunsStore";
import { useFlowsStore } from "../../state/flowsStore";
import { useLanguageStore, useT } from "../../state/languageStore";
import { LOOP_TYPE } from "../../lib/flows/spec";
import { flowsTestDelete, flowsTestSave, flowsTestsList, flowsTestsRun, type FlowRunNodeRow, type FlowTest } from "../../lib/tauri/flowsCommands";

type Draft = { id: string; name: string; nodeId: string; input: string; expected: string; matchMode: FlowTest["matchMode"] };

const pretty = (value: unknown) => JSON.stringify(value ?? {}, null, 2);

/**
 * «Pruebas»: a flow's tests — an input to start it with, and what its output must hold. Each runs
 * the flow for real from its trigger (pins do not stand in) and compares the last node's first item
 * (`flows::testing`). «Ejecuciones › Guardar como prueba» makes one from a run that went right.
 */
export function FlowTestsView() {
  const t = useT();
  const language = useLanguageStore((s) => s.language);
  const flowId = useFlowsStore((s) => s.draft?.id ?? "");
  const nodes = useFlowsStore((s) => s.draft?.spec.nodes);
  const triggers = useMemo(() => (nodes ?? []).filter((node) => node.type.startsWith("trigger.") && !node.disabled), [nodes]);
  const [tests, setTests] = useState<FlowTest[]>([]);
  const [running, setRunning] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<Draft | null>(null);

  const load = useCallback(async () => {
    if (!flowId) return;
    try {
      setTests(await flowsTestsList(flowId));
    } catch (error) {
      pushErrorToast(String(error));
    }
  }, [flowId]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (ids: string[] | null) => {
    const marked = new Set(ids ?? tests.map((test) => test.id));
    setRunning(marked);
    try {
      await useFlowsStore.getState().flush({ interactive: true });
      await flowsTestsRun(flowId, ids);
    } catch (error) {
      pushErrorToast(String(error));
    } finally {
      setRunning(new Set());
      void load();
    }
  };

  const save = async () => {
    if (!editing) return;
    let input: unknown;
    let expected: unknown;
    try {
      input = JSON.parse(editing.input || "{}");
      expected = JSON.parse(editing.expected || "{}");
    } catch {
      pushErrorToast(t("flows.tests.notJson"));
      return;
    }
    try {
      await flowsTestSave({
        id: editing.id,
        flowId,
        name: editing.name,
        input,
        nodeId: editing.nodeId,
        expected,
        matchMode: editing.matchMode,
        sortOrder: 0,
        lastStatus: "",
        lastDetail: "",
        lastRunAt: "",
      });
      setEditing(null);
      void load();
    } catch (error) {
      pushErrorToast(String(error));
    }
  };

  const remove = async (test: FlowTest) => {
    if (!(await confirmAction(t("flows.tests.deleteConfirm", { name: test.name }), true, t("flows.tests.delete")))) return;
    await flowsTestDelete(test.id).catch((error) => pushErrorToast(String(error)));
    void load();
  };

  const passed = tests.filter((test) => test.lastStatus === "passed").length;
  const failed = tests.filter((test) => test.lastStatus === "failed").length;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-tour="flows-tests">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--cf-border)] px-3">
        <span className="text-[12px] font-semibold">{t("flows.tests.title")}</span>
        <span className="text-[11px] tabular-nums text-[var(--cf-text-faint)]">
          {tests.length > 0 && (passed || failed) ? t("flows.tests.summary", { passed, failed, total: tests.length }) : tests.length}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          className={iconButtonClass({ size: "sm" })}
          title={t("flows.tests.new")}
          aria-label={t("flows.tests.new")}
          onClick={() => setEditing({ id: "", name: "", nodeId: triggers[0]?.id ?? "", input: "{\n  \n}", expected: "{\n  \n}", matchMode: "contains" })}
        >
          <Plus size={14} />
        </button>
        <Button size="sm" disabled={tests.length === 0 || running.size > 0} onClick={() => void run(null)}>
          <Play size={12} />
          {t("flows.tests.runAll")}
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {tests.map((test) => {
          const busy = running.has(test.id);
          const color = test.lastStatus === "passed" ? "var(--cf-success)" : test.lastStatus === "failed" ? "var(--cf-danger)" : "var(--cf-text-faint)";
          return (
            <div key={test.id} className="group flex items-start gap-2.5 rounded-md px-2 py-1.5 hover:bg-[var(--cf-hover)]">
              <span className="mt-[5px] h-2 w-2 shrink-0 rounded-full" style={{ background: busy ? "var(--cf-accent)" : color }} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 truncate text-[12.5px] font-medium text-[var(--cf-text)]">{test.name}</span>
                  <span className="shrink-0 text-[11px] text-[var(--cf-text-faint)]">{t(`flows.tests.mode.${test.matchMode}` as "flows.tests.mode.contains")}</span>
                </div>
                <div className="truncate text-[11.5px] text-[var(--cf-text-muted)]" title={test.lastDetail}>
                  {busy
                    ? t("flows.tests.running")
                    : test.lastRunAt
                      ? `${new Date(test.lastRunAt).toLocaleString(language)} · ${test.lastDetail}`
                      : t("flows.tests.neverRun")}
                </div>
              </div>
              <span className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100">
                <button type="button" className={iconButtonClass({ size: "xs" })} title={t("flows.tests.run")} aria-label={t("flows.tests.run")} disabled={running.size > 0} onClick={() => void run([test.id])}>
                  <Play size={11} />
                </button>
                <button
                  type="button"
                  className={iconButtonClass({ size: "xs" })}
                  title={t("flows.tests.edit")}
                  aria-label={t("flows.tests.edit")}
                  onClick={() => setEditing({ id: test.id, name: test.name, nodeId: test.nodeId, input: pretty(test.input), expected: pretty(test.expected), matchMode: test.matchMode })}
                >
                  <Pencil size={11} />
                </button>
                <button type="button" className={iconButtonClass({ size: "xs" })} title={t("flows.tests.delete")} aria-label={t("flows.tests.delete")} onClick={() => void remove(test)}>
                  <Trash2 size={11} />
                </button>
              </span>
            </div>
          );
        })}
        {tests.length === 0 && (
          <p className="flex items-center gap-1.5 px-2 py-3 text-[12px] text-[var(--cf-text-muted)]">
            <FlaskConical size={13} />
            {t("flows.tests.none")}
          </p>
        )}
      </div>
      {editing && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 p-4" onMouseDown={(event) => event.target === event.currentTarget && setEditing(null)}>
          <div className="flex max-h-[calc(100%-32px)] w-[min(620px,100%)] flex-col gap-2.5 overflow-y-auto rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-3 shadow-[var(--cf-shadow)]">
            <div className="flex items-center gap-2">
              <span className="flex-1 text-[13px] font-semibold">{editing.id ? t("flows.tests.edit") : t("flows.tests.new")}</span>
              <button type="button" className={iconButtonClass({ size: "sm" })} aria-label={t("flows.tables.cancel")} onClick={() => setEditing(null)}>
                <X size={14} />
              </button>
            </div>
            <input
              className={fieldClass({ size: "sm" })}
              value={editing.name}
              placeholder={t("flows.tests.name")}
              aria-label={t("flows.tests.name")}
              onChange={(event) => setEditing({ ...editing, name: event.target.value })}
            />
            <div className="flex items-center gap-2">
              <span className="w-[110px] shrink-0 text-[12px] text-[var(--cf-text-muted)]">{t("flows.tests.trigger")}</span>
              <div className="min-w-0 flex-1">
                <Select
                  value={editing.nodeId}
                  onChange={(nodeId) => setEditing({ ...editing, nodeId })}
                  options={[{ value: "", label: t("flows.tests.firstTrigger") }, ...triggers.map((node) => ({ value: node.id, label: node.name }))]}
                  size="sm"
                />
              </div>
            </div>
            <label className="flex flex-col gap-1 text-[12px] text-[var(--cf-text-muted)]">
              {t("flows.tests.input")}
              <textarea
                className={fieldClass({ className: "h-[120px] resize-y py-2 font-mono text-[12px] leading-[1.5]" })}
                value={editing.input}
                spellCheck={false}
                onChange={(event) => setEditing({ ...editing, input: event.target.value })}
              />
            </label>
            <div className="flex items-center gap-2">
              <span className="w-[110px] shrink-0 text-[12px] text-[var(--cf-text-muted)]">{t("flows.tests.compare")}</span>
              <Segmented
                options={[
                  { value: "contains", label: t("flows.tests.mode.contains") },
                  { value: "equals", label: t("flows.tests.mode.equals") },
                  { value: "runs", label: t("flows.tests.mode.runs") },
                ]}
                value={editing.matchMode}
                onChange={(matchMode) => setEditing({ ...editing, matchMode })}
                layoutId="flows-test-mode"
                size="sm"
                ariaLabel={t("flows.tests.compare")}
              />
            </div>
            {editing.matchMode !== "runs" && (
              <label className="flex flex-col gap-1 text-[12px] text-[var(--cf-text-muted)]">
                {t("flows.tests.expected")}
                <textarea
                  className={fieldClass({ className: "h-[140px] resize-y py-2 font-mono text-[12px] leading-[1.5]" })}
                  value={editing.expected}
                  spellCheck={false}
                  onChange={(event) => setEditing({ ...editing, expected: event.target.value })}
                />
              </label>
            )}
            <p className="text-[11.5px] leading-snug text-[var(--cf-text-faint)]">{t("flows.tests.hint")}</p>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                {t("flows.tables.cancel")}
              </Button>
              <Button size="sm" variant="primary" disabled={!editing.name.trim()} onClick={() => void save()}>
                {t("flows.tables.save")}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

type RunNode = Pick<FlowRunNodeRow, "nodeId" | "nodeType" | "status" | "seq" | "finishedAt">;

/**
 * The node whose main output a run answered with — what an Execute flow node receives and what a
 * test compares (`engine::execute`'s `last_output`): the last one to *finish* successfully, the
 * trigger included, whether or not it put anything out. An IF whose items all went to its false
 * branch answers with nothing, even when a node before it had items.
 *
 * Finishing order is `finishedAt`; two that finished in the same millisecond go by start order,
 * which is right whenever one fed the other. Reused and pinned output never answers, and nor does a
 * decided wait a restart picked up (it has no `finishedAt`).
 */
export function answeringNode<T extends RunNode>(nodes: T[]): T | null {
  let found: T | null = null;
  for (const node of nodes) {
    if (node.status !== "success" || !node.finishedAt) continue;
    const at = found?.finishedAt ?? "";
    if (!found || node.finishedAt > at || (node.finishedAt === at && node.seq > found.seq)) found = node;
  }
  return found;
}

/** Makes a test from a finished run: its trigger's input, and the first item of what the run
 *  answered with (`answeringNode`) as what the output must contain — or, when it answered with
 *  nothing, only that it runs. */
export async function testFromRun(
  flowId: string,
  run: { id: string; triggerNode: string; startedAt: string },
  nodes: RunNode[],
  name: string,
  readNode: (runId: string, nodeId: string) => Promise<{ outputs: unknown[][] } | null>,
): Promise<FlowTest> {
  const trigger = await readNode(run.id, run.triggerNode);
  const items = trigger?.outputs?.[0] ?? [];
  const input = items.length === 1 ? items[0] : items;
  const last = answeringNode(nodes);
  // A loop's last report hands its list on through «done», its second output; the first — the one a
  // run answers with — is empty by then (its stored record holds every batch there instead).
  const produced = last && last.nodeType !== LOOP_TYPE ? ((await readNode(run.id, last.nodeId))?.outputs?.[0] ?? []) : [];
  const expected = produced[0] ?? {};
  const saved = await flowsTestSave({
    id: "",
    flowId,
    name,
    input,
    nodeId: run.triggerNode,
    expected,
    matchMode: produced.length > 0 ? "contains" : "runs",
    sortOrder: 0,
    lastStatus: "",
    lastDetail: "",
    lastRunAt: "",
  });
  useFlowRunsStore.getState().setPane("tests");
  return saved;
}
