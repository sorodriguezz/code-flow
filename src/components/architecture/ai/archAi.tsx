/**
 * Arquitectura's assistant on the frontend: running a turn, the conversation it keeps per document,
 * and how an answer is shown — prose, the model's questions as a card to click, its proposed changes
 * as a card where each one is ticked and applied, and a whole new document for "design".
 */
import { useState } from "react";
import { create } from "zustand";
import { Check, FilePlus2, Square } from "lucide-react";
import { architectureAi, type ArchAiActionId } from "../../../lib/tauri/architectureCommands";
import { diagramsKeepVersion } from "../../../lib/tauri/diagramsCommands";
import { applyChanges, contextFor, describeOp, splitAnswer, type PatchChange } from "../../../lib/architecture/aiBlocks";
import { splitQuestions, type ChatQuestion } from "../../../lib/chatQuestions";
import type { TranslationKey } from "../../../lib/i18n/translations";
import type { ArchDoc } from "../../../lib/architecture/types";
import { rereadable } from "../../../lib/architecture/sources";
import type { ArchModel } from "../useArchModel";
import { useArchitectureStore } from "../../../state/architectureStore";
import { isCancellation, newRunId, useAiRunStore } from "../../../state/aiRunStore";
import { translate, useLanguageStore, useT } from "../../../state/languageStore";
import { pushErrorToast, pushSuccessToast } from "../../../state/toastStore";
import { Markdown } from "../../common/Markdown";
import { QuestionCard } from "../../chat/QuestionCard";
import { ThinkingOrb } from "../../common/ThinkingOrb";
import { buttonClass } from "../../common/Button";

export interface ArchMessage {
  role: "user" | "assistant";
  text: string;
  action: ArchAiActionId;
  questions?: ChatQuestion[];
  changes?: PatchChange[];
  doc?: ArchDoc | null;
  /** Set once the proposal was applied or dismissed. */
  settled?: "applied" | "dismissed";
}

interface AskState {
  /** Conversation per document id. */
  threads: Record<string, ArchMessage[]>;
  /** The run in flight per document id. */
  running: Record<string, string | undefined>;
  push: (docId: string, message: ArchMessage) => void;
  settle: (docId: string, index: number, how: "applied" | "dismissed") => void;
  clear: (docId: string) => void;
  setRunning: (docId: string, runId: string | undefined) => void;
}

export const useArchAskStore = create<AskState>((set) => ({
  threads: {},
  running: {},
  push: (docId, message) => set((s) => ({ threads: { ...s.threads, [docId]: [...(s.threads[docId] ?? []), message] } })),
  settle: (docId, index, how) => set((s) => ({ threads: { ...s.threads, [docId]: (s.threads[docId] ?? []).map((m, i) => (i === index ? { ...m, settled: how } : m)) } })),
  clear: (docId) => set((s) => ({ threads: { ...s.threads, [docId]: [] } })),
  setRunning: (docId, runId) => set((s) => ({ running: { ...s.running, [docId]: runId } })),
}));

/** Sends one turn. The person's words go into the thread first, the answer after, both by document. */
export async function askArchitecture(model: ArchModel, action: ArchAiActionId, question: string): Promise<void> {
  const store = useArchitectureStore.getState();
  const draft = store.draft;
  if (!draft) return;
  const docId = draft.id;
  const ask = useArchAskStore.getState();
  if (ask.running[docId]) return;
  const history = (ask.threads[docId] ?? []).map((m) => ({ role: m.role, text: m.text }));
  ask.push(docId, { role: "user", text: question || translate(`arch.ai.action.${action}` as TranslationKey), action });
  const runId = newRunId("arch");
  const title = store.items.find((i) => i.id === docId)?.title ?? "";
  useAiRunStore.getState().start(runId, { kindKey: "arch.ai.runKind", detail: title, workspaceId: store.workspaceId, target: { view: "architecture" } });
  ask.setRunning(docId, runId);
  try {
    const context = contextFor(model.findings, model.sim, model.comps, (f) => translate(`arch.rule.${f.rule}.title` as TranslationKey, f.params));
    const raw = await architectureAi({
      workspaceId: store.workspaceId,
      action,
      question,
      document: draft.text,
      context,
      history,
      language: useLanguageStore.getState().language,
      runId,
      sources: rereadable(model.doc),
    });
    const { text: withoutBlocks, changes, doc } = splitAnswer(raw);
    const { text, questions } = splitQuestions(withoutBlocks);
    useArchAskStore.getState().push(docId, { role: "assistant", text, action, questions, changes, doc });
  } catch (error) {
    if (!isCancellation(error)) pushErrorToast(String(error));
  } finally {
    useAiRunStore.getState().finish(runId);
    useArchAskStore.getState().setRunning(docId, undefined);
  }
}

export function stopArchitecture(docId: string) {
  const runId = useArchAskStore.getState().running[docId];
  if (runId) void useAiRunStore.getState().cancel(runId);
}

function ProposalCard({ docId, index, changes, settled }: { docId: string; index: number; changes: PatchChange[]; settled?: "applied" | "dismissed" }) {
  const t = useT();
  const [picked, setPicked] = useState<boolean[]>(() => changes.map(() => true));
  if (settled) {
    return <p className="m-0 rounded-lg border border-[color-mix(in_oklab,var(--cf-success)_40%,transparent)] bg-[color-mix(in_oklab,var(--cf-success)_6%,transparent)] px-2.5 py-1.5 text-[12px] text-[var(--cf-success)]">{t(settled === "applied" ? "arch.ai.applied" : "arch.ai.dismissed")}</p>;
  }
  const apply = async () => {
    const chosen = changes.filter((_, i) => picked[i]);
    if (!chosen.length) return;
    const store = useArchitectureStore.getState();
    const text = store.draft?.id === docId ? store.draft.text : null;
    if (text == null) return;
    try {
      const next = applyChanges(text, chosen);
      await store.flush({ interactive: false });
      await diagramsKeepVersion(docId).catch(() => false);
      store.editText(next);
      useArchAskStore.getState().settle(docId, index, "applied");
      pushSuccessToast(t("arch.ai.appliedToast", { n: chosen.length }));
    } catch (error) {
      pushErrorToast(t("arch.ai.applyFailed", { error: String((error as Error)?.message ?? error) }));
    }
  };
  return (
    <div className="grid gap-2 rounded-lg border border-[var(--cf-border-strong)] p-2.5">
      <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]">{t("arch.ai.proposal", { n: changes.length })}</span>
      {changes.map((c, i) => (
        <label key={i} className="grid cursor-pointer grid-cols-[18px_minmax(0,1fr)] gap-1.5 text-[12px]">
          <input type="checkbox" checked={picked[i]} onChange={(e) => setPicked((p) => p.map((v, j) => (j === i ? e.target.checked : v)))} className="mt-[3px] accent-[var(--cf-accent)]" />
          <span className="grid gap-0.5">
            <b>{c.title}</b>
            {c.why ? <span className="leading-[1.4] text-[var(--cf-text-muted)]">{c.why}</span> : null}
            <pre className="m-0 mt-1 overflow-x-auto whitespace-pre rounded-md border border-[var(--cf-border)] bg-[var(--cf-sunken)] px-2 py-1 font-mono text-[10.5px] leading-[1.55]">
              {c.ops.map((op, k) => { const d = describeOp(op); return <span key={k} className="block" style={{ color: d.sign === "-" ? "var(--cf-danger)" : d.sign === "+" ? "var(--cf-success)" : "var(--cf-text-muted)" }}>{d.sign} {d.text}</span>; })}
            </pre>
          </span>
        </label>
      ))}
      <div className="flex gap-1.5">
        <button type="button" className={buttonClass({ size: "sm", variant: "primary" })} onClick={() => void apply()}><Check size={13} />{t("arch.ai.applySelected")}</button>
        <button type="button" className={buttonClass({ size: "sm", variant: "ghost" })} onClick={() => useArchAskStore.getState().settle(docId, index, "dismissed")}>{t("arch.ai.dismiss")}</button>
      </div>
    </div>
  );
}

/** One assistant message: prose, then its question card, its proposal and the document it designed. */
export function ArchAnswer({ docId, index, message, onAnswer }: { docId: string; index: number; message: ArchMessage; onAnswer: (text: string) => void }) {
  const t = useT();
  const create = useArchitectureStore((s) => s.createFrom);
  return (
    <div className="grid gap-2 text-[12.5px] leading-[1.5]">
      {message.text ? <Markdown source={message.text} className="cf-markdown text-[12.5px]" /> : null}
      {message.questions?.length ? <QuestionCard questions={message.questions} onAnswer={onAnswer} /> : null}
      {message.changes?.length ? <ProposalCard docId={docId} index={index} changes={message.changes} settled={message.settled} /> : null}
      {message.doc ? (
        <button type="button" className={buttonClass({ size: "sm", className: "justify-self-start" })} onClick={() => void create(message.doc!, message.doc!.meta?.title)}>
          <FilePlus2 size={13} />{t("arch.ai.createDoc", { title: message.doc.meta?.title ?? t("arch.untitled") })}
        </button>
      ) : null}
    </div>
  );
}

/** The orb and a Stop while a turn runs for this document. */
export function ArchThinking({ docId }: { docId: string }) {
  const t = useT();
  const running = useArchAskStore((s) => s.running[docId]);
  if (!running) return null;
  return (
    <div className="flex items-center gap-2 text-[12px] text-[var(--cf-text-muted)]">
      <ThinkingOrb size="sm" />
      <span className="flex-1">{t("arch.ai.thinking")}</span>
      <button type="button" className={buttonClass({ size: "sm", variant: "ghost" })} onClick={() => stopArchitecture(docId)}><Square size={11} />{t("arch.ai.stop")}</button>
    </div>
  );
}
