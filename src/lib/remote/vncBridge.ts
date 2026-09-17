import type { TranslationKey } from "../i18n/translations";
import type { Translate } from "../../state/languageStore";

/**
 * Why the screen didn't connect, as the bridge saw it.
 *
 * **The gap this fills.** `remotes::wsbridge` opens the TCP connection the webview cannot, so the
 * error that matters — refused, unreachable, timed out, *not permitted* — happens in a process the
 * panel can't see. And noVNC is no help: `rfb.js` reads the close code and reason in `_socketClose`,
 * writes them to its log and drops them, then fires `disconnect` carrying `{ clean }` and nothing
 * else. So every one of those failures reached the user as the same sentence about the host having
 * "gone away", including the macOS one where the host is right there and the app simply lacks
 * permission to talk to it.
 *
 * The bridge therefore closes with a token in the frame's `reason`, and this turns the token into
 * the sentence. Tokens rather than text because a close frame's reason is 123 bytes and because the
 * wording belongs in `src/lib/i18n` with everything else the user reads.
 */

/**
 * The close code `remotes::wsbridge` marks its own diagnoses with.
 *
 * Must match `DIAGNOSIS_CLOSE_CODE` there. 4000-4999 is the WebSocket spec's application range, so
 * a close arriving with any other code — 1000 from a tidy shutdown, 1006 from a connection that
 * simply dropped mid-session — is a real network event and keeps its existing meaning.
 */
const DIAGNOSIS_CLOSE_CODE = 4000;

/**
 * Each token the bridge can send, and the sentence it stands for.
 *
 * Kept as a lookup rather than a `switch` so an unrecognised token — an older bridge, a newer one —
 * falls through to the generic wording instead of throwing inside a close handler.
 */
const WORDING: Record<string, TranslationKey> = {
  refused: "remote.vncRefused",
  unreachable: "remote.vncUnreachable",
  timeout: "remote.vncTimedOut",
  blocked: "remote.vncBlocked",
};

/**
 * The sentence for a close frame, or `null` when the close carries no diagnosis.
 *
 * `null` is the important half of the return type: it means "this was an ordinary close, say what
 * you would have said" — which keeps a mid-session drop, a server-side hangup and a teardown from
 * unmounting all reading as a connect failure.
 *
 * The reason is `token` or `token:detail`; only the unclassified `failed:` case carries a detail,
 * and it carries the OS's own message, which is better in the panel than nothing at all.
 */
export function vncBridgeFailure(event: CloseEvent, t: Translate): string | null {
  if (event.code !== DIAGNOSIS_CLOSE_CODE) return null;

  const separator = event.reason.indexOf(":");
  const token = separator === -1 ? event.reason : event.reason.slice(0, separator);
  const known = WORDING[token];
  if (known) return t(known);

  const detail = separator === -1 ? "" : event.reason.slice(separator + 1).trim();
  return detail ? t("remote.vncBridgeFailed", { detail }) : null;
}
