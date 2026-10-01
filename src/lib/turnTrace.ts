import { formatAgentLogLine, repeatsStatus } from "./agentLog";
import { getTurnTrace } from "./tauri/commands";
import type { AiRunLine } from "../state/aiRunStore";

/**
 * A finished turn's trace — what the engine printed while it worked — loaded **one turn at a time,
 * when its disclosure is opened**.
 *
 * Every transcript used to be read with every turn's trace attached: up to ~600 KB each, so reopening
 * a long conversation in the repository chat or an agent task moved ~18 MB through IPC to draw a list
 * of bubbles that shows none of it. The chat workspace had already stopped doing that — and, with
 * nothing fetching a trace afterwards, its "N steps" disclosure simply vanished from every reopened
 * turn. Now all three read light (`getChatConversation` / `chatGetConversation` without traces), keep
 * the turn's id where a stored trace exists (`traceIdOf`), and fetch that one trace through
 * `get_turn_trace` the first time somebody opens it.
 */

/**
 * Rehydrates a stored trace into the shape the log component renders, applying the same formatting
 * the live view uses so a reopened turn reads identically to a fresh one.
 */
export function parseTrace(raw: string | null): AiRunLine[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return undefined;
    const lines: AiRunLine[] = [];
    for (const item of parsed) {
      if (typeof item !== "object" || item === null) continue;
      const { stream, line } = item as { stream?: unknown; line?: unknown };
      if (typeof line !== "string") continue;
      const text = formatAgentLogLine(line);
      if (text === null || repeatsStatus(lines[lines.length - 1]?.text, text)) continue;
      lines.push({ stream: stream === "stderr" ? "stderr" : "stdout", text });
    }
    return lines.length > 0 ? lines : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The id to fetch a turn's trace by, when a light read says there is one to fetch.
 *
 * A light read answers the trace column with `""` for "this turn has one, not sent" and `null` for
 * "it has none" — see `ACTIVITY_COLUMNS_NO_TRACE` in `queries.rs`. Anything else is a trace that
 * came along whole (an eager read), which needs no fetching.
 */
export function traceIdOf(raw: unknown, id: string): string | undefined {
  return raw === "" && id ? id : undefined;
}

/** How many fetched traces are kept. A trace is up to ~600 KB; the ones worth keeping are the few
 * the user has just opened, and re-fetching an evicted one is a single indexed read. */
const CACHE_LIMIT = 24;

/** Fetched traces by turn id, oldest first. `null` is a real answer: the turn had nothing printable. */
const cache = new Map<string, AiRunLine[] | null>();
const inFlight = new Map<string, Promise<AiRunLine[] | null>>();

/** The trace, if it has already been fetched — `undefined` when it has not. Synchronous, so a
 * disclosure re-mounted by a scroll or a tab switch opens straight away instead of refetching. */
export function peekTurnTrace(id: string): AiRunLine[] | null | undefined {
  return cache.get(id);
}

/** Fetches one turn's trace, once — concurrent asks share the request, and the answer is cached. */
export function loadTurnTrace(id: string): Promise<AiRunLine[] | null> {
  const known = cache.get(id);
  if (known !== undefined) return Promise.resolve(known);
  const pending = inFlight.get(id);
  if (pending) return pending;
  const request = getTurnTrace(id)
    .then((raw) => parseTrace(raw) ?? null)
    .then((lines) => {
      cache.set(id, lines);
      while (cache.size > CACHE_LIMIT) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
      }
      return lines;
    })
    .finally(() => inFlight.delete(id));
  inFlight.set(id, request);
  return request;
}

/** Test-only: forget every cached trace. */
export function clearTurnTraceCache(): void {
  cache.clear();
  inFlight.clear();
}
