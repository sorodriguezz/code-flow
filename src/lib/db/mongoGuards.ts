/**
 * The Mongo console's destructive operations, so it can ask before sending one.
 *
 * The Mongo half of `sqlGuards.unguardedWrites`. The driver refuses a write with no filter at all
 * (`deleteMany()` — see `plan_command` in `datasource/mongo.rs`), which is the accident; what reaches
 * here is the deliberate version, `deleteMany({})`, and a deliberate statement is asked about rather
 * than refused: the `{}` is how you say "every document", and there has to be a way to say it.
 *
 * Syntactic, like its SQL twin. It reads the shell forms this console accepts and the raw command
 * documents behind them, and says nothing about anything else — the backend is what stands between
 * the user and the server, and this only turns a statement that would clear a collection into a
 * question first.
 */

export type MongoDestructiveOperation =
  | "deleteMany"
  | "remove"
  | "updateMany"
  | "drop"
  | "dropDatabase"
  | "delete";

export interface MongoDestructive {
  operation: MongoDestructiveOperation;
  /** The collection, or the database for `dropDatabase` (empty when the statement doesn't name it). */
  target: string;
}

/** `db.users`, `db.getCollection('odd name')` → the collection name. */
const COLLECTION = String.raw`db\.(?:getCollection\(\s*(['"])(.+?)\1\s*\)|([A-Za-z_$][\w$.-]*?))`;

/** A filter written as nothing but `{}`. */
const EMPTY = String.raw`\{\s*\}`;

const SHELL_EVERYTHING = new RegExp(
  String.raw`^${COLLECTION}\.(deleteMany|remove|updateMany)\(\s*${EMPTY}\s*([,)])`,
);
const SHELL_DROP = new RegExp(String.raw`^${COLLECTION}\.drop\(\s*\)`);
const SHELL_DROP_DATABASE = /^db\.dropDatabase\(\s*\)/;
/** `{drop: 'users'}` / `{dropDatabase: 1}`, bare or inside `db.runCommand(…)`. */
const RAW_DROP = /^(?:db\.runCommand\(\s*)?\{\s*["']?(dropDatabase|drop)["']?\s*:\s*(?:(["'])(.*?)\2|[^,}]*)/;
/** `{delete: 'users', deletes: [{q: {}, …}]}`. */
const RAW_DELETE_ALL = new RegExp(
  String.raw`^(?:db\.runCommand\(\s*)?\{\s*["']?delete["']?\s*:\s*(["'])(.*?)\1[\s\S]*?["']?q["']?\s*:\s*${EMPTY}`,
);

/** The destructive operation in one console statement, or `null`. */
export function destructiveMongoCommand(statement: string): MongoDestructive | null {
  const text = statement.trim().replace(/;+\s*$/, "");

  const everything = SHELL_EVERYTHING.exec(text);
  if (everything) {
    const operation = everything[4] as MongoDestructiveOperation;
    // `remove({}, true)` removes one document, as `justOne` says.
    const rest = text.slice(everything.index + everything[0].length);
    if (operation === "remove" && everything[5] === "," && /^\s*(true|\{[^}]*justOne\s*:\s*true)/.test(rest)) {
      return null;
    }
    return { operation, target: everything[2] ?? everything[3] ?? "" };
  }

  const drop = SHELL_DROP.exec(text);
  if (drop) return { operation: "drop", target: drop[2] ?? drop[3] ?? "" };
  if (SHELL_DROP_DATABASE.test(text)) return { operation: "dropDatabase", target: "" };

  const raw = RAW_DROP.exec(text);
  if (raw) {
    const operation = raw[1] as "drop" | "dropDatabase";
    return { operation, target: operation === "drop" ? (raw[3] ?? "") : "" };
  }
  const rawDelete = RAW_DELETE_ALL.exec(text);
  if (rawDelete) return { operation: "delete", target: rawDelete[2] ?? "" };
  return null;
}

/** Every destructive statement in a buffer, in order. `statements` is the buffer already split —
 *  `splitStatements(text, "javascript")` — so this and the driver agree on where each one ends. */
export function destructiveMongoCommands(statements: string[]): MongoDestructive[] {
  return statements
    .map(destructiveMongoCommand)
    .filter((found): found is MongoDestructive => found !== null);
}
