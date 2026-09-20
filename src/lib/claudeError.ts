const QUOTA_MARKER = "QUOTA_EXCEEDED::";

/** Why the provider refused. `usage` is a rate/usage limit that lifts on its own; `billing` is an
 * account-balance problem that needs the user to top up — different advice, so they're separated
 * rather than both shown as "you hit your limit". */
export type QuotaKind = "usage" | "billing";

/** Must stay in step with the billing half of `QUOTA_SIGNALS` in `ai.rs`: that list decides
 *  whether a refusal is recognised at all, this one decides which of the two remedies is offered.
 *  A phrase in one and not the other is the worst outcome available here — the refusal is caught
 *  and then the user is told to wait for a window that does not exist, because a prepaid balance
 *  does not refill on a clock. */
const BILLING_SIGNALS = [
  "insufficient balance",
  "insufficient credit",
  "insufficient account funds",
  "out of credit",
  "payment required",
  "billing",
];

/**
 * A run that failed because the provider is not *set up*, rather than because the model could not
 * answer. Four of them, because the remedy differs and the remedy is the entire point.
 *
 * These are worth separating from the generic error path for a reason the quota split already
 * established: a red box containing a CLI's raw stderr is the app declining to read something it
 * can read perfectly well. Every one of these failures has exactly one fix, the CLI usually names
 * it, and the user is then made to copy it out of an error message by hand.
 *
 * All four are detected only on text the app already knows is an **error** — `parseClaudeError` is
 * never called on a successful reply (see its callers: `message.isError`, caught exceptions, a
 * job's stored `error`). That matters, and it is the lesson `refusal_reply` on the Rust side
 * learned the hard way: a model is free to *write about* being signed out or about a missing
 * model, and a classifier that reads ordinary replies will eventually eat one.
 */
export type SetupProblem =
  /** The CLI is installed but nobody is authenticated. `command` is the sign-in command, taken
   *  from the CLI's own message where it offered one. */
  | { kind: "not-signed-in"; command: string | null }
  /** The configured model id does not exist for this provider. `suggestions` are the near-misses
   *  the CLI listed, which the UI offers as one-click replacements — this is almost always a
   *  renamed or retired model, and the right id is in the error text. */
  | { kind: "model-not-found"; model: string | null; suggestions: string[] }
  /** The binary is not on the app's `PATH`. Distinct from not-signed-in: nothing to log into yet. */
  | { kind: "binary-missing"; binary: string | null }
  /** The CLI refused to run in the directory it was given. Codex does this outside a Git work
   *  tree. Kept as a class even though `codex.rs` now passes `--skip-git-repo-check` where it
   *  applies, because a stale build, a different CLI or a future version can still say it, and
   *  silently rendering it as an unexplained failure is what this whole type exists to stop. */
  | { kind: "untrusted-directory" };

export interface ClaudeErrorInfo {
  isQuotaExceeded: boolean;
  /** Only set when `isQuotaExceeded`. */
  kind: QuotaKind | null;
  message: string;
  /** Best-effort "resets in N hours/minutes" extracted from the CLI's own message. */
  resetHint: string | null;
  /** An http(s) link the provider pointed at (e.g. its billing page), when it included one. */
  actionUrl: string | null;
  /** Set when the failure is a configuration problem with a known remedy. Never set at the same
   *  time as `isQuotaExceeded`: being out of quota is an account that *is* set up. */
  setup: SetupProblem | null;
}

/** The longest an error can be and still be classified as a setup problem.
 *
 * A CLI that cannot start says so in a line or two. Anything longer is a real failure that merely
 * mentions one of these phrases — a stack trace, a model's own prose, a log tail — and guessing at
 * it would replace a verbatim error the user can act on with a confident wrong instruction. The
 * generous end of "a line or two", for the same reason `MAX_REFUSAL_CHARS` is 400 in `ai.rs`.
 */
const MAX_SETUP_CHARS = 600;

/** Sign-in phrasing across the CLIs. `grok` says "Not signed in", `codex` and `claude` speak of
 *  logging in, and the OAuth-backed ones surface an expired token instead. */
const SIGNED_OUT = [
  /\bnot signed in\b/i,
  /\bnot logged in\b/i,
  /\bplease (?:run )?\/?login\b/i,
  /\byou must (?:sign|log) in\b/i,
  /\bauthentication (?:required|failed)\b/i,
  /\b(?:session|token|credentials) (?:has )?expired\b/i,
  /\bunauthorized\b/i,
  /\binvalid api key\b/i,
];

/** The command a CLI offers for signing in, lifted out of its own message.
 *
 * Anchored on the known binaries rather than "any word followed by login", so a sentence that
 * merely contains the word cannot become a command the app then offers to run. Returns it
 * verbatim — including flags like `--device-code`, which is the variant that matters here because
 * the app has no browser to hand back to. */
function signInCommand(message: string): string | null {
  const match = message.match(
    /\b((?:claude|codex|grok|agy|gemini|opencode|cline)\s+(?:auth\s+)?login[^\n.]*)/i,
  );
  return match ? match[1].trim().replace(/[`'"]+$/, "") : null;
}

/** Pulls the rejected model and the CLI's own near-misses out of a "model not found" message.
 *
 * opencode phrases it as: `Model not found: opencode/deepseek-v4-flash-free. Did you mean:
 * deepseek-v4-flash, deepseek-v4-flash-vision-exp, deepseek-v4-pro?` — which is everything the UI
 * needs to offer the fix as three buttons instead of a paragraph to read. agy phrases the same
 * failure as `model <id> is not recognized` and offers nothing, so `suggestions` is empty there
 * and the UI falls back to opening the model picker.
 *
 * # The suggestions are not usable as they arrive
 *
 * Note what opencode actually answered above: the id it rejected is **vendor-qualified**
 * (`opencode/deepseek-v4-flash-free`) and the three it suggests are **bare** model names. Offering
 * those verbatim is what this function used to do, and pressing one produced a second, worse
 * failure — `Model not found: deepseek-v4-flash/.` — because opencode reads `vendor/model`, so a
 * bare name parses as the vendor with an empty model after the slash.
 *
 * So a suggestion inherits the rejected id's vendor when it has none of its own. Nothing is
 * inherited when the rejected id was not namespaced (every other engine here), and nothing is
 * added to a suggestion that already carries a prefix — the transformation only ever restores a
 * prefix the CLI dropped from its own answer.
 */
function modelNotFound(message: string): { model: string | null; suggestions: string[] } | null {
  const named = message.match(/model not found:\s*([^\s.,]+)/i) ?? message.match(/\bmodel\s+(\S+)\s+is not recognized/i);
  if (!named && !/\bunknown model\b/i.test(message)) return null;
  const rejected = named ? named[1] : null;
  // The vendor half of a `vendor/model` id, when the rejected one had two halves. A trailing empty
  // half (`deepseek-v4-flash/`) is not a vendor — it is the shape of this very bug, and treating it
  // as one would re-apply the broken prefix to every suggestion.
  const slash = rejected?.indexOf("/") ?? -1;
  const vendor = rejected && slash > 0 && slash < rejected.length - 1 ? rejected.slice(0, slash) : null;
  const didYouMean = message.match(/did you mean:?\s*([^?\n]+)/i);
  const suggestions = didYouMean
    ? didYouMean[1]
        .split(/[,]/)
        .map((s) => s.trim().replace(/[?.]+$/, ""))
        .filter((s) => s.length > 0 && s.length < 80)
        .map((s) => (vendor && !s.includes("/") ? `${vendor}/${s}` : s))
    : [];
  return { model: named ? named[1] : null, suggestions };
}

/** Classifies a failed run as a setup problem, or `null` when it is an ordinary failure.
 *
 * Order matters where two could match: a message naming a missing binary *and* a login command is
 * a missing binary first, because logging into something that is not installed is not a step. */
function parseSetupProblem(message: string): SetupProblem | null {
  if (message.length > MAX_SETUP_CHARS) return null;

  // `ai::probe` reports the binary it looked for when it is not on `PATH`; a spawn that got past
  // the probe fails with the OS's own wording.
  const missing = message.match(/\b(?:command not found|no such file or directory|is not recognized as an internal)\b/i);
  if (missing) {
    const binary = message.match(/\b(claude|codex|grok|agy|gemini|opencode|cline)\b/i)?.[1]?.toLowerCase() ?? null;
    return { kind: "binary-missing", binary };
  }

  if (/\bnot inside a trusted directory\b/i.test(message) || /--skip-git-repo-check\b/.test(message)) {
    return { kind: "untrusted-directory" };
  }

  const model = modelNotFound(message);
  if (model) return { kind: "model-not-found", ...model };

  if (SIGNED_OUT.some((re) => re.test(message))) {
    return { kind: "not-signed-in", command: signInCommand(message) };
  }

  return null;
}

export function parseClaudeError(raw: string): ClaudeErrorInfo {
  if (raw.includes(QUOTA_MARKER)) {
    const message = raw.slice(raw.indexOf(QUOTA_MARKER) + QUOTA_MARKER.length).trim();
    const lower = message.toLowerCase();
    const kind: QuotaKind = BILLING_SIGNALS.some((s) => lower.includes(s)) ? "billing" : "usage";
    const match = message.match(/(\d+)\s*(hours?|hrs?|minutes?|mins?)/i);
    // Trailing punctuation is common when the URL ends a sentence, and would break the link.
    const url = message.match(/https?:\/\/[^\s)]+/)?.[0]?.replace(/[.,;:]+$/, "") ?? null;
    return {
      isQuotaExceeded: true,
      kind,
      message,
      resetHint: kind === "usage" && match ? `${match[1]} ${match[2].toLowerCase()}` : null,
      actionUrl: url,
      // Deliberately null: an account that is out of quota is an account that is set up. Offering
      // "sign in" to someone who is signed in and merely rate-limited sends them to re-authenticate
      // for nothing, and loses the one piece of information that was true — when it resets.
      setup: null,
    };
  }
  return {
    isQuotaExceeded: false,
    kind: null,
    message: raw,
    resetHint: null,
    actionUrl: null,
    setup: parseSetupProblem(raw),
  };
}
