/**
 * The regex tester's worker: evaluates one request and posts the result back. The UI terminates
 * and recreates it when a request takes too long — a catastrophic pattern (`(a+)+$`) stops being
 * a frozen window and becomes an inline "took too long".
 */

import { runRegex } from "./regex";

export interface RegexRequest {
  id: number;
  pattern: string;
  flags: string;
  text: string;
  replacement: string | null;
}

// Typed by hand rather than with the `webworker` lib, which clashes with the DOM lib the rest of
// the project compiles against.
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<RegexRequest>) => void) | null;
  postMessage: (message: unknown) => void;
};

scope.onmessage = (event) => {
  const { id, pattern, flags, text, replacement } = event.data;
  try {
    scope.postMessage({ id, ok: true, result: runRegex(pattern, flags, text, replacement) });
  } catch (err) {
    scope.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
