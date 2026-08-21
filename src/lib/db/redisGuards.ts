/**
 * The commands a Redis console refuses before sending anything.
 *
 * The Redis half of `sqlGuards`, and it exists for the same reason: some mistakes are neither
 * visible nor recoverable, and the console is where they are one keystroke away. `FLUSHALL` next to
 * `FLUSHDB` in an autocomplete, `KEYS *` typed out of habit from a tutorial.
 *
 * **This is a duplicate of the check in `datasource/redis.rs`, deliberately.** The backend's is the
 * authoritative one — the frontend must never be what stands between a user and their server — and
 * this one exists only so the refusal is instant and local rather than a round trip. If the two
 * ever disagree, the backend is right; keep this list a subset of that one.
 *
 * Three reasons appear here and nothing else does: it takes the server down, it blocks the server,
 * or it breaks the multiplexed connection every other tab on the session is sharing.
 */

/** The first word of a line, upper-cased. Quotes cannot appear in a command name, so this needs no
 *  parser — the backend does the real argv parse. */
function commandName(line: string): string {
  return line.trim().split(/\s+/, 1)[0]?.toUpperCase() ?? "";
}

function secondWord(line: string): string {
  return line.trim().split(/\s+/)[1]?.toUpperCase() ?? "";
}

/** Blocking commands: on a shared, multiplexed connection one of these stalls every other tab. */
const BLOCKING = new Set([
  "BLPOP",
  "BRPOP",
  "BLMOVE",
  "BRPOPLPUSH",
  "BLMPOP",
  "BZPOPMIN",
  "BZPOPMAX",
  "BZMPOP",
  "WAIT",
  "WAITAOF",
]);

/** Commands that put the connection into a mode it cannot leave. */
const MODE_CHANGING = new Set([
  "SUBSCRIBE",
  "PSUBSCRIBE",
  "SSUBSCRIBE",
  "MONITOR",
  "SYNC",
  "PSYNC",
  "RESET",
]);

/** Transaction verbs, whose state belongs to one connection and this one is shared. */
const TRANSACTIONAL = new Set(["MULTI", "EXEC", "DISCARD", "WATCH"]);

/**
 * The i18n key naming why this line is refused, or `null` when it is fine.
 *
 * Returns a key rather than a message so the toast is translated where every other one is. The
 * backend's version returns the prose, because there is no `t()` in Rust.
 */
export function refusedRedisCommand(
  line: string,
): { key: "db.redisRefused"; command: string } | null {
  const trimmed = line.trim();
  // `#` is this console's comment marker — see `split_redis_statements` in the driver.
  if (!trimmed || trimmed.startsWith("#")) return null;

  const name = commandName(trimmed);
  const second = secondWord(trimmed);

  const refused =
    name === "FLUSHALL" ||
    name === "FLUSHDB" ||
    name === "SWAPDB" ||
    name === "KEYS" ||
    name === "SELECT" ||
    name === "SHUTDOWN" ||
    MODE_CHANGING.has(name) ||
    BLOCKING.has(name) ||
    TRANSACTIONAL.has(name) ||
    (name === "DEBUG" && second === "SLEEP") ||
    (name === "CLIENT" && second === "PAUSE") ||
    // `XREAD`/`XREADGROUP` only block when asked to.
    ((name === "XREAD" || name === "XREADGROUP") && /\bBLOCK\b/i.test(trimmed));

  return refused ? { key: "db.redisRefused", command: name } : null;
}

/** The first refused command in a console buffer, or `null`. One command per line, like the driver. */
export function firstRefusedRedisCommand(body: string): string | null {
  for (const line of body.split("\n")) {
    const refused = refusedRedisCommand(line);
    if (refused) return refused.command;
  }
  return null;
}
