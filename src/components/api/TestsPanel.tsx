import { useState } from "react";
import { CheckCircle2, Plus, Trash2, XCircle } from "lucide-react";
import { ScriptsPanel } from "./ScriptsPanel";
import { buttonClass, iconButtonClass } from "../common/Button";
import { Checkbox } from "../common/Checkbox";
import { Segmented } from "../common/Segmented";
import { Select } from "../common/Select";
import { fieldClass } from "../common/recipes";
import { AiSparkles } from "../common/AiGlyph";
import { ThinkingOrb } from "../common/ThinkingOrb";
import { ChatModelPicker } from "../ai/ChatModelPicker";
import { useApiStore } from "../../state/apiStore";
import { useApiRuntimeStore } from "../../state/apiRuntimeStore";
import { useApiAiStore } from "../../state/apiAiStore";
import { useT } from "../../state/languageStore";
import { pushErrorToast, pushSuccessToast } from "../../state/toastStore";
import { ASSERTION_OPERATORS, ASSERTION_SOURCES, evaluateAssertions, newAssertion, UNARY_OPERATORS } from "../../lib/api/assertions";
import { exchangeForAi, secretValues, stripFence } from "../../lib/api/aiPayload";
import type { TranslationKey } from "../../lib/i18n/translations";
import type { ApiAssertion, AssertionOperator, AssertionSource } from "../../types/api";

type View = "asserts" | "script";

const SOURCE_LABELS: Record<AssertionSource, TranslationKey> = {
  status: "api.assert.src.status",
  time: "api.assert.src.time",
  size: "api.assert.src.size",
  header: "api.assert.src.header",
  body: "api.assert.src.body",
  jsonpath: "api.assert.src.jsonpath",
};

const OPERATOR_LABELS: Record<AssertionOperator, TranslationKey> = {
  eq: "api.assert.op.eq",
  neq: "api.assert.op.neq",
  lt: "api.assert.op.lt",
  lte: "api.assert.op.lte",
  gt: "api.assert.op.gt",
  gte: "api.assert.op.gte",
  contains: "api.assert.op.contains",
  notContains: "api.assert.op.notContains",
  exists: "api.assert.op.exists",
  notExists: "api.assert.op.notExists",
  matches: "api.assert.op.matches",
  isType: "api.assert.op.isType",
};

function newId(): string {
  return `assert-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * The request's Tests tab: the no-code asserts and the post-response script, side by side as two
 * views of one question — "is this response right?" — and «Generar con IA», which writes the script
 * from the response last received.
 */
export function TestsPanel({ tabId }: { tabId: string }) {
  const t = useT();
  const [views, setViews] = useState<Record<string, View>>({});
  const assertions = useApiStore((s) => s.openTabs.find((tab) => tab.id === tabId)?.draft.assertions);
  const hasResponse = useApiRuntimeStore((s) => {
    const response = s.responses[tabId];
    return !!response && response.error === null;
  });
  const busyKey = `tests:${tabId}`;
  const generating = useApiAiStore((s) => !!s.busy[busyKey]);
  const view: View = views[tabId] ?? ((assertions?.length ?? 0) > 0 ? "asserts" : "script");
  const setView = (next: View) => setViews((all) => ({ ...all, [tabId]: next }));

  const generate = async () => {
    const store = useApiStore.getState();
    const tab = store.openTabs.find((entry) => entry.id === tabId);
    const response = useApiRuntimeStore.getState().responses[tabId];
    if (!tab || !response || response.error) return;
    const ctx = store.variableContext(tab.collectionId);
    const payload = exchangeForAi(response, secretValues([ctx.environment, ctx.collection, ctx.global]), {
      name: tab.name,
      description: tab.draft.description,
    });
    try {
      const answer = await useApiAiStore.getState().run(busyKey, "tests", payload, tab.name || response.sent.url);
      if (answer === null) return;
      const code = stripFence(answer);
      if (!/pm\.test\s*\(/.test(code)) {
        pushErrorToast(t("api.ai.testsEmpty"));
        return;
      }
      const current = useApiStore.getState().openTabs.find((entry) => entry.id === tabId);
      if (!current) return;
      const script = current.draft.postScript.replace(/\s*$/, "");
      // Into the draft, not through the editor: written by a model that read a server's answer, so
      // it is not "authored" — the next send asks before running it, like an imported script.
      useApiStore.getState().updateDraft(tabId, {
        postScript: `${script}${script ? "\n\n" : ""}// ${t("api.ai.testsHeader")}\n${code}\n`,
      });
      setView("script");
      pushSuccessToast(t("api.ai.testsAdded"));
    } catch (e) {
      pushErrorToast(String(e instanceof Error ? e.message : e));
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--cf-border)] px-3 py-1.5">
        <Segmented
          size="sm"
          layoutId="cf-api-tests-view"
          ariaLabel={t("api.tab.tests")}
          value={view}
          onChange={setView}
          options={[
            { value: "asserts", label: (assertions?.length ?? 0) > 0 ? `${t("api.assert.view")} · ${assertions?.length}` : t("api.assert.view") },
            { value: "script", label: t("api.assert.script") },
          ]}
        />
        <div className="flex-1" />
        <ChatModelPicker
          task="api"
          variant="split"
          liveModel={null}
          chatActive={false}
          title={hasResponse ? t("api.ai.testsHint") : t("api.ai.testsNeedResponse")}
          action={{
            icon: generating ? <ThinkingOrb size="sm" /> : <AiSparkles size={13} />,
            label: t("api.ai.tests"),
            onClick: () => void generate(),
            disabled: generating || !hasResponse,
            title: hasResponse ? undefined : t("api.ai.testsNeedResponse"),
          }}
        />
      </div>
      <div className="min-h-0 flex-1">{view === "asserts" ? <AssertionsTable tabId={tabId} /> : <ScriptsPanel tabId={tabId} kind="post" />}</div>
    </div>
  );
}

function AssertionsTable({ tabId }: { tabId: string }) {
  const t = useT();
  const rows = useApiStore((s) => s.openTabs.find((tab) => tab.id === tabId)?.draft.assertions) ?? [];
  const response = useApiRuntimeStore((s) => s.responses[tabId] ?? null);
  const live = response && response.error === null ? response : null;

  const write = (next: ApiAssertion[]) => useApiStore.getState().updateDraft(tabId, { assertions: next });
  const patch = (id: string, change: Partial<ApiAssertion>) => write(rows.map((row) => (row.id === id ? { ...row, ...change } : row)));
  const add = (source: AssertionSource = "status") => write([...rows, newAssertion(newId(), source)]);

  return (
    <div className="h-full overflow-auto px-3 py-2">
      {rows.length === 0 ? (
        <div className="flex flex-col items-start gap-2 py-2 text-[12px] text-[var(--cf-text-muted)]">
          <p>{t("api.assert.empty")}</p>
          <div className="flex flex-wrap gap-1.5">
            {(["status", "time", "jsonpath", "header"] as AssertionSource[]).map((source) => (
              <button key={source} type="button" onClick={() => add(source)} className={buttonClass({ variant: "secondary", size: "sm" })}>
                <Plus size={12} />
                {t(SOURCE_LABELS[source])}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          {rows.map((row) => {
            const result = live && row.enabled ? evaluateAssertions([row], live)[0] : undefined;
            const needsProperty = row.source === "header" || row.source === "jsonpath";
            const unary = UNARY_OPERATORS.includes(row.operator);
            return (
              <div key={row.id} className={`flex items-center gap-1.5 ${row.enabled ? "" : "opacity-50"}`}>
                <Checkbox checked={row.enabled} onChange={(enabled) => patch(row.id, { enabled })} />
                <div className="w-[118px] shrink-0">
                  <Select
                    size="compact"
                    value={row.source}
                    onChange={(source) =>
                      patch(row.id, { source: source as AssertionSource, property: source === "jsonpath" && !row.property ? "$." : row.property })
                    }
                    options={ASSERTION_SOURCES.map((source) => ({ value: source, label: t(SOURCE_LABELS[source]) }))}
                    ariaLabel={t("api.assert.source")}
                  />
                </div>
                {needsProperty && (
                  <input
                    value={row.property}
                    spellCheck={false}
                    onChange={(e) => patch(row.id, { property: e.target.value })}
                    placeholder={row.source === "header" ? "Content-Type" : "$.data.id"}
                    aria-label={t("api.assert.property")}
                    className={fieldClass({ size: "sm", className: "w-[180px] min-w-0 font-mono" })}
                  />
                )}
                <div className="w-[128px] shrink-0">
                  <Select
                    size="compact"
                    value={row.operator}
                    onChange={(operator) => patch(row.id, { operator: operator as AssertionOperator })}
                    options={ASSERTION_OPERATORS.map((operator) => ({ value: operator, label: t(OPERATOR_LABELS[operator]) }))}
                    ariaLabel={t("api.assert.operator")}
                  />
                </div>
                {!unary && (
                  <input
                    value={row.expected}
                    spellCheck={false}
                    onChange={(e) => patch(row.id, { expected: e.target.value })}
                    placeholder={row.operator === "isType" ? "string · number · array…" : t("api.assert.expected")}
                    aria-label={t("api.assert.expected")}
                    className={fieldClass({ size: "sm", className: "min-w-0 flex-1 font-mono" })}
                  />
                )}
                {unary && <div className="flex-1" />}
                <span className="flex w-5 shrink-0 justify-center" title={result ? (result.passed ? t("api.assert.passing") : (result.error ?? "")) : t("api.assert.noResponse")}>
                  {result &&
                    (result.passed ? (
                      <CheckCircle2 size={14} className="text-[var(--cf-success)]" />
                    ) : (
                      <XCircle size={14} className="text-[var(--cf-danger)]" />
                    ))}
                </span>
                <button
                  type="button"
                  onClick={() => write(rows.filter((candidate) => candidate.id !== row.id))}
                  aria-label={t("api.assert.remove")}
                  className={iconButtonClass({ size: "sm" })}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            );
          })}
          <button type="button" onClick={() => add("jsonpath")} className={buttonClass({ variant: "ghost", size: "sm", className: "mt-1 self-start" })}>
            <Plus size={12} />
            {t("api.assert.add")}
          </button>
        </div>
      )}
    </div>
  );
}
