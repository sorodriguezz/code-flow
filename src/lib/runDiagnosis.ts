import type { AiRunLine } from "../state/aiRunStore";

/**
 * Reads a run's own output for the failure it is stuck in, while it is still stuck in it.
 *
 * # The case this exists for
 *
 * A CLI configured against an endpoint that is not listening does not fail — it *retries*. Codex
 * pointed at a local gateway that is down emits one of these every few hundred milliseconds:
 *
 * ```
 * ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket:
 * IO error: Connection refused (os error 61), url: ws://127.0.0.1:11434/api/codex/v1/responses
 * ```
 *
 * …and keeps going until somebody presses Stop. The app has the whole story in front of it and was
 * showing it as an undifferentiated wall of orange text: a user watched that for seventy-two
 * seconds, stopped the run, and asked what was happening. Everything needed to answer was on
 * screen — the app just never read it.
 *
 * # Why the repeat count is the signal
 *
 * A single connection error can be a transient blip on the way to a working run, and calling that
 * out would put a scary banner over a turn that is about to succeed. A CLI that has failed to reach
 * the *same URL* several times in a row is not having a blip; it is misconfigured or the thing at
 * the other end is not running. So the threshold is the point of the test, not a detail.
 */
export interface RunDiagnosis {
  kind: "endpoint-unreachable";
  /** The address the CLI could not reach, taken from its own message. */
  url: string;
  /** How many times it failed against that address. */
  attempts: number;
}

/** Below this many failures against one address, it is a blip and nothing is said. */
const MIN_ATTEMPTS = 3;

/** `Connection refused`, and the phrases the same condition arrives under elsewhere. */
const REFUSED = /connection refused|econnrefused|failed to connect|connection reset|no route to host/i;

/**
 * The port a well-known local service listens on, when the unreachable address is one of them.
 *
 * Only for naming it: "nothing is listening on 11434" is a fact, and "11434 is Ollama's port" is
 * the sentence that turns it into something the user can act on. Deliberately a short list of
 * things this app already knows about rather than a port registry.
 */
const KNOWN_LOCAL_PORTS: Record<string, string> = {
  "11434": "Ollama",
  "4096": "opencode",
  "1234": "LM Studio",
  "8080": "llama-server",
};

/** The service behind a local port, or `null`. Exported for the message the UI builds. */
export function serviceOnPort(url: string): string | null {
  const port = url.match(/:(\d{2,5})\b/)?.[1];
  return port ? (KNOWN_LOCAL_PORTS[port] ?? null) : null;
}

/**
 * What is wrong with this run, from its own log — or `null`, which is the ordinary answer.
 *
 * Deliberately conservative: it reports only what the lines *say*, never what they might mean. A
 * run that is merely slow, or that is failing for a reason this function has no pattern for, gets
 * no diagnosis at all rather than a guess — the log is still on screen and a wrong explanation is
 * worse than none.
 */
export function diagnoseRun(lines: AiRunLine[] | undefined): RunDiagnosis | null {
  if (!lines || lines.length === 0) return null;

  const byUrl = new Map<string, number>();
  for (const line of lines) {
    if (!REFUSED.test(line.text)) continue;
    // The URL the CLI named, if it named one. Trailing punctuation is common when the address ends
    // a sentence and would otherwise become part of it.
    const url = line.text.match(/\b(?:wss?|https?):\/\/[^\s,)"']+/i)?.[0]?.replace(/[.,;:]+$/, "");
    if (!url) continue;
    byUrl.set(url, (byUrl.get(url) ?? 0) + 1);
  }

  let worst: RunDiagnosis | null = null;
  for (const [url, attempts] of byUrl) {
    if (attempts < MIN_ATTEMPTS) continue;
    if (!worst || attempts > worst.attempts) worst = { kind: "endpoint-unreachable", url, attempts };
  }
  return worst;
}
