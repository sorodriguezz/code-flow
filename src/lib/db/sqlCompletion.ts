import type { languages as MonacoLanguages } from "monaco-editor";
import { monaco } from "../monacoSetup";
import { nodeKey, useDbStore, type DbConsoleTab } from "../../state/dbStore";
import { translate } from "../../state/languageStore";
import type { DbNode, DbNodeRef } from "../../types/database";

/**
 * Schema-aware completion for the SQL console.
 *
 * The console is where you type names you half-remember, and until now the only thing behind ⌃Space
 * was Monaco's word-based fallback — which offers words already in the buffer, i.e. exactly the
 * names you had to get right by hand the first time. This provider answers with the catalog
 * instead: the tables of the scope the console is pointed at, the columns of the tables the
 * statement actually names, and the schemas around them.
 *
 * **There is no cache here.** The metadata is the explorer tree's — `dbStore.children`, keyed by
 * `nodeKey`, filled by `warmNode`, which is `refreshNode` without the spinner and the error row
 * because nobody asked for these reads. That is the whole design: expanding the tree warms
 * completion, completing warms the tree, "Refresh" on a node re-reads for both, and disconnecting
 * drops one cache rather than leaving a second one quietly serving a schema that has been dropped
 * since.
 *
 * **The provider itself never awaits.** This is what makes it feel live, and it is worth spelling
 * out because the obvious implementation — `await refreshNode(...)` before answering — is the one
 * that feels broken. Monaco asks a provider once per suggest session and then filters that answer
 * locally as you keep typing; it only asks again on the next keystroke if the answer said
 * `incomplete`. So an awaited first answer arrives late *and* freezes: the catalog that landed 200ms
 * after the widget opened would not appear until the session was closed and reopened. Instead every
 * read here is a synchronous look at what the tree already holds, anything missing is asked for in
 * the background, the answer is flagged `incomplete` while a read is in flight, and the widget is
 * re-triggered when one lands (see `warm` and `nudge`). The first keystroke shows keywords
 * instantly, the catalog fills in underneath it a moment later, and nothing blocks.
 *
 * What it will not do is guess. A console with no schema picked gets the schemas and whatever
 * relations the tree has already read (qualified, so they are unambiguous), never a silent default
 * of `public` — being handed `users` from a schema you are not in is worse than being handed
 * nothing, because it looks like an answer.
 */

/** Enough SQL to not have to type it. Ordered by how often you reach for it, not alphabetically —
 * `sortText` below keeps the catalog above all of it either way. */
const KEYWORDS = [
  "SELECT", "FROM", "WHERE", "JOIN", "LEFT JOIN", "RIGHT JOIN", "INNER JOIN", "FULL JOIN",
  "CROSS JOIN", "ON", "USING", "GROUP BY", "ORDER BY", "HAVING", "LIMIT", "OFFSET", "FETCH",
  "INSERT INTO", "VALUES", "UPDATE", "SET", "DELETE FROM", "RETURNING", "WITH", "AS", "DISTINCT",
  "UNION", "UNION ALL", "INTERSECT", "EXCEPT", "CASE", "WHEN", "THEN", "ELSE", "END", "AND", "OR",
  "NOT", "IN", "EXISTS", "BETWEEN", "LIKE", "ILIKE", "IS NULL", "IS NOT NULL", "ASC", "DESC",
  "COUNT", "SUM", "AVG", "MIN", "MAX", "COALESCE", "NULLIF", "CAST", "CREATE TABLE", "ALTER TABLE",
  "DROP TABLE", "CREATE INDEX", "TRUNCATE", "BEGIN", "COMMIT", "ROLLBACK", "EXPLAIN",
];

/** The ones that can open a statement — the only keywords worth ranking first on an empty line. */
const STATEMENT_KEYWORDS = new Set([
  "SELECT", "INSERT INTO", "UPDATE", "DELETE FROM", "WITH", "CREATE TABLE", "ALTER TABLE",
  "DROP TABLE", "CREATE INDEX", "TRUNCATE", "EXPLAIN", "BEGIN", "COMMIT", "ROLLBACK",
]);

/** Words that follow a relation without being its alias — `from users where …` names no alias. */
const NOT_AN_ALIAS = [
  "where", "join", "inner", "left", "right", "full", "cross", "outer", "on", "using", "group",
  "order", "having", "limit", "offset", "fetch", "union", "intersect", "except", "set", "values",
  "returning", "and", "or", "not", "as", "select", "from", "into", "with", "window", "for",
];

/** One identifier: quoted every way the SQL engines here quote them, or bare. Quoting matters
 * because a name is allowed a space in it, and `from "mi tabla"` read as a bare word is two
 * things. */
const IDENT = String.raw`(?:"[^"]*"|\`[^\`]*\`|\[[^\]]*\]|[\w$]+)`;

const IDENT_RE = new RegExp(IDENT, "g");

/**
 * `FROM x`, `JOIN a.b c`, `UPDATE t` — the relation, and its alias when it has one.
 *
 * The alias is guarded by a *lookahead* rather than matched and then discarded: matching it would
 * consume the keyword too, and `join b on …` would swallow the `on` that ends `b` and lose the next
 * relation with it — which cost table `b` of `from a join b on … join c` before it was written this
 * way.
 */
const RELATION_RE = new RegExp(
  String.raw`\b(?:from|join|update|into|table)\s+((?:${IDENT}\s*\.\s*)*${IDENT})` +
    String.raw`(?:\s+(?:as\s+)?(?!(?:${NOT_AN_ALIAS.join("|")})\b)([a-zA-Z_]\w*))?`,
  "gi",
);

/** What sits before the `.` the cursor is typing after — an alias, a table, or a schema. */
const QUALIFIER_RE = new RegExp(String.raw`(${IDENT})\s*\.\w*$`);

/**
 * What the cursor is about to name, read off the text in front of it.
 *
 * `FROM ` and `SELECT ` want opposite lists, and offering both — which is what a single flat list
 * does — means the right answer is never the first one. These two regexes decide which; anything
 * they don't recognise is treated as the start of a statement, where the keywords lead.
 *
 * A relation slot is `from`/`join`/`update`/`into`/`table` followed by nothing yet, or by a
 * comma-separated list still being written (`from users, ord`). Once an alias appears — `from users
 * u ` — the tail stops matching, which is correct: what follows an alias is a clause keyword, not
 * another table.
 */
const RELATION_SLOT = new RegExp(
  String.raw`\b(?:from|join|update|into|table|truncate)\s+(?:${IDENT}\s*,\s*)*[\w$."\`\[\]]*$`,
  "i",
);

/** A column slot is anything after a clause keyword that takes column names, or after the
 * punctuation that starts an expression — `(`, `,`, a comparison. Tested second, so `select * from
 * us` is still a relation slot. */
const COLUMN_SLOT =
  /(?:\b(?:select|where|on|using|group\s+by|order\s+by|having|set|returning|and|or|not|when|then|else|by|distinct|between|like|ilike|in|values)\b|[(,=<>+\-*/])[^;]*$/i;

type Slot = "relation" | "column" | "statement";

/** A relation named in the statement, and what it was called there. */
interface Referenced {
  schema: string | null;
  table: string;
  alias: string | null;
}

/** `"public"."my table"` / `[dbo].[Users]` / `` `db`.`t` `` all name something plainer. */
function unquote(identifier: string): string {
  return identifier.replace(/^[["'`]+|[\]"'`]+$/g, "");
}

/**
 * The relations a statement names, with their aliases.
 *
 * A regex rather than a parser on purpose: this runs on a keystroke, against text that is usually
 * half-written and frequently not valid SQL at all. Missing a relation costs a suggestion; a parser
 * that throws on an unfinished statement costs every suggestion.
 */
export function referencedRelations(sql: string): Referenced[] {
  const out: Referenced[] = [];
  for (const match of sql.matchAll(RELATION_RE)) {
    // Split on the identifiers themselves, not on `.`: a quoted name is allowed to contain one.
    const parts = [...match[1].matchAll(IDENT_RE)].map((part) => unquote(part[0])).filter(Boolean);
    const table = parts[parts.length - 1];
    if (!table) continue;
    out.push({
      schema: parts.length > 1 ? parts[parts.length - 2] : null,
      table,
      alias: match[2] ?? null,
    });
  }
  return out;
}

/** The names a `WITH` introduces. They read exactly like tables to `RELATION_RE`, but the catalog
 * has never heard of them, so looking their columns up is a guaranteed round-trip to an error —
 * once per statement that uses a CTE, forever. */
const CTE_RE = new RegExp(String.raw`(?:\bwith\s+(?:recursive\s+)?|,\s*)(${IDENT})\s+as\s*\(`, "gi");

function cteNames(sql: string): Set<string> {
  const out = new Set<string>();
  for (const match of sql.matchAll(CTE_RE)) out.add(unquote(match[1]).toLowerCase());
  return out;
}

/** Where the cursor sits in a console that may hold a whole script. */
interface Cursor {
  /** The statement around the cursor. A console is a script — completing `select id from |` against
   * the tables of the four other queries in the file is how you get a list you have to read. */
  statement: string;
  /** That statement up to the cursor, which is what the slot is read from. */
  prefix: string;
  /** Inside a string literal or a comment, where a table name is not what you are typing. */
  quiet: boolean;
}

/**
 * Split a script at the `;` that actually separate statements.
 *
 * The scanner skips string literals and comments rather than counting semicolons blindly, because
 * `where note = 'a; b'` is one statement and a commented-out `-- drop table x;` is none. It is not a
 * lexer — `$$ … $$` bodies and dialect quirks will fool it — but every way it can be wrong costs one
 * suggestion list, and the alternative (no splitting at all) is wrong on every multi-statement
 * console.
 */
function cursorContext(sql: string, offset: number): Cursor {
  let start = 0;
  let end = sql.length;
  let quiet = false;
  let index = 0;

  const mark = (from: number, to: number) => {
    if (offset > from && offset <= to) quiet = true;
  };

  while (index < sql.length && index < end) {
    const char = sql[index];

    if (char === "'" || char === '"' || char === "`") {
      const opened = index;
      index += 1;
      while (index < sql.length && sql[index] !== char) index += 1;
      // Both kinds of quote are skipped over, so a `;` inside one doesn't split a statement — but
      // only `'…'` silences completion. `"…"` and `` `…` `` delimit *identifiers*, which is
      // precisely a name worth completing. An unterminated quote runs to the end of the buffer,
      // which is the state of `where name = '` mid-typing and the reason this marks rather than
      // bails out.
      if (char === "'") mark(opened, index >= sql.length ? sql.length : index);
      index += 1;
      continue;
    }

    if (char === "-" && sql[index + 1] === "-") {
      const opened = index;
      while (index < sql.length && sql[index] !== "\n") index += 1;
      mark(opened, index);
      continue;
    }

    if (char === "/" && sql[index + 1] === "*") {
      const opened = index;
      index += 2;
      while (index < sql.length && !(sql[index] === "*" && sql[index + 1] === "/")) index += 1;
      index = Math.min(index + 2, sql.length);
      mark(opened, index);
      continue;
    }

    if (char === ";") {
      if (index < offset) start = index + 1;
      else {
        end = index;
        break;
      }
    }

    index += 1;
  }

  return { statement: sql.slice(start, end), prefix: sql.slice(start, offset), quiet };
}

/** Which of the three lists the text in front of the cursor is asking for. */
function slotOf(prefix: string): Slot {
  if (RELATION_SLOT.test(prefix)) return "relation";
  if (COLUMN_SLOT.test(prefix)) return "column";
  return "statement";
}

/**
 * Whether a space or a comma at this position is asking for a name.
 *
 * The space trigger is what makes the console feel like it knows the schema — `FROM ` and the
 * tables are there — but Monaco has no concept of "the user dismissed this", so taken literally it
 * means the list reopens at every word boundary of every line, including the one right after
 * Escape. The distinction that matters is what the space *follows*: a keyword, an operator, an open
 * paren or a comma all mean something is expected next; a name, a literal or a closing paren mean
 * the user finished a thought, and re-opening there is just noise. A word character re-opens it
 * either way through Monaco's own quick-suggest, which is the escape hatch when this guesses wrong.
 */
const EXPECTS_SOMETHING =
  /(?:\b(?:select|from|join|on|using|where|and|or|not|by|set|into|update|table|values|distinct|as|in|between|like|ilike|returning|when|then|else|case|exists|all|any|asc|desc|inner|left|right|full|cross|outer|union|intersect|except|having|limit|offset|group|order|with|insert|delete|truncate|explain)\b|[(,=<>!+\-*/%|]|\bis\b)\s*$/i;

function wantsNameHere(prefix: string): boolean {
  return prefix.trim().length === 0 || EXPECTS_SOMETHING.test(prefix);
}

// ---------------------------------------------------------------------------
// Catalog access — synchronous reads, background fills
// ---------------------------------------------------------------------------

/** Keys a read has come back empty for. Asking again on every keystroke would turn a typo — `from
 * usres` — into a query per character; the explorer's own Refresh is the way back. Successes are not
 * tracked: `children` already holds them, and it is consulted first, so an entry that goes stale
 * here is simply never reached again. */
const barren = new Set<string>();

/** Keys whose read failed, and when. Unlike `barren` this expires: a failure is usually "not
 * connected yet" or a dropped session, and both are fixed by the time you have typed the next word.
 * Marking those permanently is what silently kills completion for the rest of the session. */
const failedAt = new Map<string, number>();
const RETRY_AFTER_MS = 8_000;

/** Reads in flight, so ten keystrokes against a cold catalog are one round-trip and not ten. */
const inFlight = new Set<string>();

/** How long a read is allowed to hold the re-trigger back. A Tauri `invoke` that never settles would
 * otherwise leave its key in `inFlight` for the life of the process, and `nudge` — which waits for
 * the burst to finish — would be off for every console, silently, until a restart. */
const READ_TIMEOUT_MS = 15_000;

/** Asks the tree for a node, once, in the background. The answer lands in `dbStore.children`, where
 * the next call to `childrenNow` — the one the re-trigger below provokes — will find it. */
function warm(connectionId: string, ref: DbNodeRef, key: string): void {
  if (inFlight.has(key)) return;
  inFlight.add(key);
  const read = useDbStore.getState().warmNode(connectionId, ref, key);
  const timeout = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), READ_TIMEOUT_MS));
  void Promise.race([read, timeout])
    .then((ok) => {
      const loaded = useDbStore.getState().children[key];
      if (ok && loaded) {
        if (loaded.length === 0) barren.add(key);
        failedAt.delete(key);
        return;
      }
      // A read that failed or timed out. Not `barren` — that one is permanent, and "not connected
      // yet" is the usual reason a first read fails.
      failedAt.set(key, Date.now());
    })
    .finally(() => {
      inFlight.delete(key);
      nudge();
    });
}

/**
 * What the tree holds for a node right now, and whether an answer is still coming.
 *
 * Never awaits — see the header. `pending` is what becomes `incomplete` on the completion list,
 * which is the flag that makes Monaco ask again instead of filtering a list it took before the
 * catalog existed.
 */
function childrenNow(
  connectionId: string,
  ref: DbNodeRef,
): { nodes: DbNode[]; pending: boolean } {
  const key = nodeKey(connectionId, ref);
  const cached = useDbStore.getState().children[key];
  if (cached) return { nodes: cached, pending: false };
  if (barren.has(key)) return { nodes: [], pending: false };
  const failed = failedAt.get(key);
  if (failed !== undefined && Date.now() - failed < RETRY_AFTER_MS) return { nodes: [], pending: false };
  warm(connectionId, ref, key);
  return { nodes: [], pending: true };
}

/**
 * Monaco's suggest controller, as much of it as this file uses.
 *
 * Reached through `getContribution` rather than through `editor.trigger("editor.action.
 * triggerSuggest")`, which looks like the supported way to do this and is the one thing that cannot
 * work here: that action's precondition is `!suggestWidgetVisible`, and the only moment worth
 * re-triggering is while the widget *is* visible. The command is a no-op exactly when it is needed.
 *
 * `state` is the same reason. The widget's `visible` class is added on a 100ms timer after the
 * session opens, so a catalog read that comes back quickly — a local database, the common case —
 * would find the class not yet written and skip the refresh, which is a "sometimes the tables show
 * up" bug rather than an honest one. `model.state` is set synchronously when the session starts.
 */
interface SuggestController {
  readonly model?: {
    readonly state: number;
    trigger(options: {
      auto: boolean;
      retrigger?: boolean;
      completionOptions?: { providerFilter?: Set<unknown> };
    }): void;
  };
}

/** `State.Idle` — no suggest session open. `State.Auto` — one Monaco opened by itself. */
const SUGGEST_IDLE = 0;
const SUGGEST_AUTO = 2;

/**
 * Re-asks for the list once a background read lands, so it fills in while you are looking at it
 * rather than on the next keypress.
 *
 * Deliberately narrow: only when the focused editor is a console, only when a session is already
 * open, and only after the last read of a burst. Opening the widget when it was closed would pop it
 * up under the user's hands, which is worse than a list that is one keystroke behind.
 *
 * The three arguments are each load-bearing:
 *
 * - `retrigger: true` is what makes this an *update* rather than a close and a reopen. Without it
 *   the controller answers the cancellation by hiding the widget outright — list emptied, size
 *   re-read, focus dropped — and rebuilds it a microtask later. Today that fits inside one frame
 *   and is invisible, which is precisely the kind of invariant that stops being true quietly.
 * - `providerFilter` pins the re-ask to this provider. Monaco asks providers in priority groups and
 *   falls through to the next when a group answers with nothing — so a re-ask that comes back empty
 *   (an alias that resolves to no table, say) would be answered by the word-based provider instead,
 *   and the widget would fill with every word in the buffer.
 * - `auto` is carried, not assumed. A session the user opened with ⌃Space freezes its last good
 *   list when the answer goes empty; an automatic one is cancelled. Re-triggering a manual session
 *   as automatic would quietly swap one behaviour for the other.
 */
let nudging = false;
function nudge(): void {
  if (nudging || inFlight.size > 0) return;
  nudging = true;
  // `setTimeout` and not `requestAnimationFrame`: a minimised window never runs a frame, and a
  // nudge that never gets to clear this flag would take every later one down with it.
  setTimeout(() => {
    nudging = false;
    const editor = monaco.editor.getEditors().find((entry) => entry.hasTextFocus());
    const uri = editor?.getModel()?.uri.toString();
    if (!editor || !uri || !consoleOf(uri)) return;
    const controller = editor.getContribution("editor.contrib.suggestController") as unknown as
      | SuggestController
      | null;
    const state = controller?.model?.state;
    if (!controller?.model || state === undefined || state === SUGGEST_IDLE) return;
    controller.model.trigger({
      auto: state === SUGGEST_AUTO,
      retrigger: true,
      completionOptions: { providerFilter: new Set([sqlProvider]) },
    });
  }, 0);
}

/** Every relation the tree has read for this connection, wherever it was read from. Free — it only
 * looks at what is already in the store. */
function relationsAlreadyRead(connectionId: string): DbNode[] {
  const { children } = useDbStore.getState();
  const out: DbNode[] = [];
  for (const [key, nodes] of Object.entries(children)) {
    if (!key.startsWith(`${connectionId}|`)) continue;
    for (const node of nodes) {
      if (node.kind === "table" || node.kind === "view" || node.kind === "collection") out.push(node);
    }
  }
  return out;
}

/** The console a Monaco model belongs to. The path is this panel's own (`cf-db:/console/<id>.sql`),
 * so the tab is identified by the URI rather than by a registry that could go stale. */
function consoleOf(uri: string): DbConsoleTab | null {
  // Matched on the tail rather than anchored to the whole URI: `Uri.toString()` is free to spell
  // the scheme and authority its own way, and the tab id is the only part this needs.
  const id = /\/console\/([^/]+)\.(?:sql|js)$/.exec(uri)?.[1];
  if (!id) return null;
  const tab = useDbStore.getState().tabs.find((entry) => entry.id === id);
  return tab && tab.kind === "console" ? tab : null;
}

/** Where a relation's columns live, given the console's scope for anything the statement left out. */
function columnRef(tab: DbConsoleTab, relation: Referenced): DbNodeRef {
  return {
    kind: "column_folder",
    database: tab.database || null,
    schema: relation.schema ?? (tab.schema || null),
    name: relation.table,
  };
}

function columnItems(
  columns: DbNode[],
  range: MonacoLanguages.CompletionItem["range"],
  qualifier: string,
  rank: string,
): MonacoLanguages.CompletionItem[] {
  return columns.map((column) => ({
    label: column.name,
    kind: monaco.languages.CompletionItemKind.Field,
    detail: [column.detail, qualifier].filter(Boolean).join(" · "),
    insertText: column.name,
    // Columns of the tables you actually named beat everything else in the list, and the primary
    // key beats the rest of them — it is what a hand-written `WHERE` is reaching for.
    sortText: `${rank}${column.column?.primary_key ? "0" : "1"}`,
    range,
  }));
}

/**
 * A list Monaco will come back to.
 *
 * `incomplete` on an *empty* list does nothing, which is the trap: an auto-triggered session whose
 * model ends up with no items is cancelled outright, and a provider that returned nothing is never
 * recorded as incomplete — so the one case that most needs a second ask, `u.` before that table's
 * columns have ever been read, is exactly the one Monaco drops. A single placeholder keeps the
 * session open until the read lands and the re-trigger replaces it.
 *
 * It carries the word already typed as both its filter and its insertion, so it matches whatever is
 * in front of the cursor and accepting it by reflex — Tab completes the top item here — types the
 * same thing the user already had.
 */
function pendingList(
  suggestions: MonacoLanguages.CompletionItem[],
  pending: boolean,
  typed: string,
  range: MonacoLanguages.CompletionItem["range"],
): MonacoLanguages.CompletionList {
  if (!pending || suggestions.length > 0) return { suggestions, incomplete: pending };
  return {
    incomplete: true,
    suggestions: [
      {
        // Spelled out rather than an ellipsis: this is also what a screen reader announces, and
        // "…, text" is indistinguishable from a column actually named that.
        label: translate("db.loadingNames"),
        // Not `Text`, which is the one kind `suggest.showWords` can filter out of a list entirely —
        // and this item disappearing is the session dying, silently, in the one case it exists for.
        kind: monaco.languages.CompletionItemKind.Field,
        filterText: typed,
        insertText: typed,
        sortText: "0",
        range,
      },
    ],
  };
}

// ---------------------------------------------------------------------------

/**
 * Held as a value rather than written inline into `registerCompletionItemProvider`, because `nudge`
 * needs to name it: a re-ask has to be pinned to this provider, or Monaco answers an empty one with
 * the word-based fallback.
 */
const sqlProvider: MonacoLanguages.CompletionItemProvider = {
  // `.` opens the list after an alias. A space or a comma opens it after `FROM`/`SELECT` — which is
  // the whole point of a console that knows the schema: the next name is offered as soon as the
  // previous word ends, not only once you have guessed enough letters for Monaco's word trigger.
  // `wantsNameHere` below is what keeps that from meaning "after every space".
  triggerCharacters: [".", " ", ","],
  provideCompletionItems(model, position, context) {
    const tab = consoleOf(model.uri.toString());
    if (!tab) return { suggestions: [] };
    const connectionId = tab.connectionId;

    const word = model.getWordUntilPosition(position);
    const range = {
      startLineNumber: position.lineNumber,
      endLineNumber: position.lineNumber,
      startColumn: word.startColumn,
      endColumn: word.endColumn,
    };

    const cursor = cursorContext(model.getValue(), model.getOffsetAt(position));
    // Inside `'…'` or a comment nothing here is an answer, and with a space as a trigger character
    // the widget would otherwise open on every word of a string literal.
    if (cursor.quiet) return { suggestions: [] };
    // A space is a trigger character, which is what puts the tables in front of you the moment you
    // finish typing `FROM` — but taken literally it also means the list reopens at every word
    // boundary for the rest of the line, including the one right after you pressed Escape to get
    // rid of it. It is honoured only where a name is genuinely what comes next.
    if (
      context.triggerKind === monaco.languages.CompletionTriggerKind.TriggerCharacter &&
      context.triggerCharacter !== "." &&
      !wantsNameHere(cursor.prefix)
    ) {
      return { suggestions: [] };
    }

    const ctes = cteNames(cursor.statement);
    const relations = referencedRelations(cursor.statement).filter(
      (relation) => !ctes.has(relation.table.toLowerCase()),
    );
    const slot = slotOf(cursor.prefix);

    /** Set by any read that had to go to the server. It becomes `incomplete` below, which is what
     * makes Monaco come back for the answer instead of filtering this one forever. */
    let pending = false;
    const read = (ref: DbNodeRef): DbNode[] => {
      const got = childrenNow(connectionId, ref);
      if (got.pending) pending = true;
      return got.nodes;
    };

    // `alias.` / `table.` — the one case with a single right answer, so nothing else is offered.
    const line = model.getValueInRange({
      startLineNumber: position.lineNumber,
      startColumn: 1,
      endLineNumber: position.lineNumber,
      endColumn: position.column,
    });
    const qualifier = QUALIFIER_RE.exec(line)?.[1];
    if (qualifier) {
      const name = unquote(qualifier).toLowerCase();
      const hit = relations.find(
        (relation) =>
          relation.alias?.toLowerCase() === name || relation.table.toLowerCase() === name,
      );
      if (hit) {
        const columns = read(columnRef(tab, hit));
        return pendingList(columnItems(columns, range, hit.table, "0"), pending, word.word, range);
      }
      // Not an alias. It may be a schema — `public.` wants that schema's relations — but only if it
      // is actually one of this database's: `where price > 1.` and `from (select …) s where s.` both
      // land here too, and treating them as schemas means a round-trip to an error, once per typed
      // decimal point, and a `barren` entry for a schema named `1`.
      const known = read({ kind: "database", database: tab.database, schema: null, name: null });
      const isSchema = known.some(
        (node) => node.kind === "schema" && node.name.toLowerCase() === name,
      );
      if (!isSchema) return { suggestions: [] };
      const tables = read({
        kind: "table_folder",
        database: tab.database || null,
        schema: unquote(qualifier),
        name: null,
      });
      return pendingList(
        tables.map((node) => ({
          label: node.name,
          kind: monaco.languages.CompletionItemKind.Struct,
          detail: node.detail,
          insertText: node.name,
          range,
        })),
        pending,
        word.word,
        range,
      );
    }

    const suggestions: MonacoLanguages.CompletionItem[] = [];
    const seen = new Map<string, MonacoLanguages.CompletionItem>();
    const push = (item: MonacoLanguages.CompletionItem) => {
      const dedupe = `${item.label as string}|${item.kind}`;
      const already = seen.get(dedupe);
      if (already) {
        // The same column name in two joined tables is one row in the list; say so in the detail
        // rather than showing the name twice with no way to tell them apart.
        if (item.detail && already.detail && !already.detail.includes(item.detail)) {
          already.detail = `${already.detail}, ${item.detail}`;
        }
        return;
      }
      seen.set(dedupe, item);
      suggestions.push(item);
    };

    // Ranking, not filtering — except for columns in a `FROM`, which are never the answer. Every
    // other list stays reachable by typing, it just isn't in front.
    const rank = {
      column: slot === "column" ? "1" : "4",
      scoped: slot === "relation" ? "1" : slot === "column" ? "3" : "4",
      elsewhere: slot === "relation" ? "2" : "5",
      schema: slot === "relation" ? "3" : "6",
      keyword: slot === "statement" ? "1" : slot === "relation" ? "7" : "2",
    };

    // The columns of what the statement names, unqualified — the whole point of `select <here>`.
    if (slot !== "relation") {
      for (const relation of relations) {
        const columns = read(columnRef(tab, relation));
        for (const item of columnItems(columns, range, relation.alias ?? relation.table, rank.column)) {
          push(item);
        }
      }
    }

    // The relations of the scope the console is pointed at, unqualified because that is how they
    // can be written here.
    const scoped =
      tab.database || tab.schema
        ? [
            ...read({
              kind: "table_folder",
              database: tab.database || null,
              schema: tab.schema || null,
              name: null,
            }),
            ...read({
              kind: "view_folder",
              database: tab.database || null,
              schema: tab.schema || null,
              name: null,
            }),
          ]
        : [];
    for (const node of scoped) {
      push({
        label: node.name,
        kind: monaco.languages.CompletionItemKind.Struct,
        detail: node.detail || node.schema || undefined,
        insertText: node.name,
        sortText: rank.scoped,
        range,
      });
    }

    // Anything the tree happens to have read elsewhere, qualified so it is writable as offered.
    for (const node of relationsAlreadyRead(connectionId)) {
      if (node.schema && node.schema === tab.schema) continue;
      const label = node.schema ? `${node.schema}.${node.name}` : node.name;
      push({
        label,
        kind: monaco.languages.CompletionItemKind.Struct,
        detail: node.detail || undefined,
        insertText: label,
        sortText: rank.elsewhere,
        range,
      });
    }

    // The schemas themselves, for `schema.` to have something to complete from.
    if (tab.database) {
      for (const node of read({
        kind: "database",
        database: tab.database,
        schema: null,
        name: null,
      })) {
        if (node.kind !== "schema") continue;
        push({
          label: node.name,
          kind: monaco.languages.CompletionItemKind.Module,
          insertText: node.name,
          sortText: rank.schema,
          range,
        });
      }
    }

    // `from ` with nothing read yet is the one place the keywords are actively harmful: they are
    // the only thing in the list, `ALTER TABLE` sorts to the top of them, it is auto-focused, and
    // Tab — which completes the top item here — types it. Wait for the tables instead.
    if (!(slot === "relation" && pending && suggestions.length === 0)) {
      for (const keyword of KEYWORDS) {
        push({
          label: keyword,
          kind: monaco.languages.CompletionItemKind.Keyword,
          insertText: keyword,
          // On an empty statement the handful that can actually open one lead; the rest sit behind
          // the catalog wherever they are.
          sortText: slot === "statement" && !STATEMENT_KEYWORDS.has(keyword) ? "8" : rank.keyword,
          range,
        });
      }
    }

    return pendingList(suggestions, pending, word.word, range);
  },
};

let installed = false;

export function installSqlCompletions(): void {
  if (installed) return;
  installed = true;

  // A connection that drops takes its `children` with it (see `dropConnection`), so the two caches
  // kept here — which only ever hold *absences* — have to go with it too. Otherwise a table that
  // did not exist when you last looked stays uncompletable for the rest of the session, and
  // reconnecting, the one thing you would try, does not fix it.
  let known = useDbStore.getState().connected;
  useDbStore.subscribe((state) => {
    const gone = known.filter((id) => !state.connected.includes(id));
    known = state.connected;
    if (gone.length === 0) return;
    for (const key of [...barren]) if (gone.some((id) => key.startsWith(`${id}|`))) barren.delete(key);
    for (const key of [...failedAt.keys()]) {
      if (gone.some((id) => key.startsWith(`${id}|`))) failedAt.delete(key);
    }
  });

  monaco.languages.registerCompletionItemProvider("sql", sqlProvider);
}
