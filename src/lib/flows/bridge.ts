import { listen } from "@tauri-apps/api/event";
import { flowsBridgeAnswer } from "../tauri/flowsCommands";
import { isMainWindow } from "../windowIdentity";
import type { DbSchemaDiagram } from "../../types/database";
import type { PrCommentThread } from "../../types/domain";

/**
 * The main window's half of `flows::bridge`: a run asks (`flows:ask`) for work that lives in this
 * webview and nowhere else, and this answers (`flows_bridge_answer`).
 *
 * Only the main window runs flows, so only it listens — one question, one answer. A run that stops
 * while a question is being worked on says so (`flows:ask-cancel`), and the handler's signal fires.
 */

type Ask = { id: string; kind: string; payload: unknown };
type Handler = (payload: unknown, signal: AbortSignal) => Promise<unknown>;

/** A schema as DBML — the one emitter (`lib/dbml/fromSchema.ts`), on the schema's own tables. */
export async function dbmlAnswer(payload: unknown): Promise<{ dbml: string; tables: number }> {
  const { diagram, title } = payload as { diagram: DbSchemaDiagram; title?: string };
  const [{ schemaToDbml }, { ownTablesOnly }] = await Promise.all([import("../dbml/fromSchema"), import("../db/erLayout")]);
  const own = ownTablesOnly(diagram);
  return { dbml: schemaToDbml(own, title || undefined), tables: own.tables.length };
}

/** The PR panel's decision comment for a saved review run (`decisionCommentForRun`). */
export async function decisionCommentAnswer(payload: unknown): Promise<string> {
  const { runId, decision } = payload as { runId: string; decision: "approve" | "request_changes" | "close" };
  const [{ getReviewRun }, { decisionCommentForRun }] = await Promise.all([import("../tauri/commands"), import("../parseAnalysis")]);
  const run = await getReviewRun(runId);
  if (!run) throw new Error("That review run is no longer saved");
  return decisionCommentForRun(run, decision, new Date().toISOString().slice(0, 10));
}

/** What "Resolver con IA" and "Responder con IA" tell a model: a saved run's findings as fix
 *  prompts, and comment threads as fix prompts and as conversations — the PR panel's own wording. */
export async function prPromptsAnswer(payload: unknown): Promise<{
  findings: { id: string; prompt: string; severity: string; title: string; location: string | null }[];
  threads: { id: number; fixPrompt: string; conversation: string; location: string | null }[];
}> {
  const { runId, findingIds, threads, extra } = payload as { runId: string | null; findingIds: string[]; threads: PrCommentThread[]; extra?: string };
  const [{ getReviewRun }, analysis, threadText] = await Promise.all([
    import("../tauri/commands"),
    import("../parseAnalysis"),
    import("../prThreadText"),
  ]);
  let findings: Awaited<ReturnType<typeof prPromptsAnswer>>["findings"] = [];
  if (runId && findingIds.length > 0) {
    const run = await getReviewRun(runId);
    if (!run) throw new Error("That review run is no longer saved");
    const wanted = new Set(findingIds);
    findings = analysis
      .parseAnalysis(run.review_md)
      .findings.filter((f) => wanted.has(f.id))
      .map((f) => ({
        id: f.id,
        prompt: analysis.withExtraInstructions(analysis.formatFindingAsFixPrompt(f), extra ?? ""),
        severity: f.severity,
        title: f.subtitle,
        location: f.location ? analysis.locationLabel(f.location) : null,
      }));
  }
  return {
    findings,
    threads: (threads ?? []).map((thread) => ({
      id: thread.id,
      fixPrompt: analysis.withExtraInstructions(threadText.threadFixPrompt(thread), extra ?? ""),
      conversation: threadText.threadAsText(thread),
      location: threadText.threadLocation(thread),
    })),
  };
}

const handlers: Record<string, Handler> = {
  "dbml.fromSchema": dbmlAnswer,
  "pr.decisionComment": decisionCommentAnswer,
  "pr.prompts": prPromptsAnswer,
  /** A saved request of the API client, by the API client's own path (`lib/api/savedRequest.ts`). */
  "api.request": async (payload, signal) => {
    const { runSavedRequest } = await import("../api/savedRequest");
    return runSavedRequest(payload as Parameters<typeof runSavedRequest>[0], signal);
  },
};

/** Registers another kind of question — the API client's requests register theirs from their own module. */
export function answerFlowQuestions(kind: string, handler: Handler): void {
  handlers[kind] = handler;
}

const running = new Map<string, AbortController>();
let started = false;

async function answer(ask: Ask): Promise<void> {
  const handler = handlers[ask.kind];
  if (!handler) {
    await flowsBridgeAnswer(ask.id, false, null, `This window cannot answer "${ask.kind}" — restart CodeFlow`).catch(() => {});
    return;
  }
  const controller = new AbortController();
  running.set(ask.id, controller);
  try {
    const value = await handler(ask.payload, controller.signal);
    if (!controller.signal.aborted) await flowsBridgeAnswer(ask.id, true, value ?? null, null);
  } catch (error) {
    if (!controller.signal.aborted) await flowsBridgeAnswer(ask.id, false, null, String(error instanceof Error ? error.message : error)).catch(() => {});
  } finally {
    running.delete(ask.id);
  }
}

/** Starts listening, once, in the main window — wherever Flujos' background pieces start. */
export function startFlowsBridge(): void {
  if (started || !isMainWindow()) return;
  started = true;
  void listen<Ask>("flows:ask", ({ payload }) => void answer(payload));
  void listen<{ id: string }>("flows:ask-cancel", ({ payload }) => running.get(payload.id)?.abort());
}
