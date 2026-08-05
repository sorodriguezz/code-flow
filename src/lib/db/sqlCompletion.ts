import type { languages as MonacoLanguages } from "monaco-editor";
import { monaco } from "../monacoSetup";
import { nodeKey, useDbStore, type DbConsoleTab } from "../../state/dbStore";
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
 * `nodeKey` — read and filled through `refreshNode`, the same call expanding a folder makes. That
 * is the whole design: expanding the tree warms completion, completing warms the tree, "Refresh" on
 * a node re-reads for both, and disconnecting drops one cache rather than leaving a second one
 * quietly serving a schema that has been dropped since.
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

/** Keys already asked for and answered with nothing. Retrying one of those on every keystroke would
 * turn a typo — `from usres` — into a query per character; the explorer's own Refresh is the way
 * back. Successes are not tracked: `children` already holds them. */
const barren = new Set<string>();

/** Reads a node's children, fetching them once if the tree has never been asked. */
async function childrenOf(connectionId: string, ref: DbNodeRef): Promise<DbNode[]> {
  const key = nodeKey(connectionId, ref);
  const cached = useDbStore.getState().children[key];
  if (cached) return cached;
  if (barren.has(key)) return [];
  // `refreshNode` reports its own failures against the node and never throws.
  await useDbStore.getState().refreshNode(connectionId, ref, key);
  const loaded = useDbStore.getState().children[key];
  if (!loaded || loaded.length === 0) barren.add(key);
  return loaded ?? [];
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
): MonacoLanguages.CompletionItem[] {
  return columns.map((column) => ({
    label: column.name,
    kind: monaco.languages.CompletionItemKind.Field,
    detail: [column.detail, qualifier].filter(Boolean).join(" · "),
    insertText: column.name,
    // Columns of the tables you actually named beat everything else in the list, and the primary
    // key beats the rest of them — it is what a hand-written `WHERE` is reaching for.
    sortText: column.column?.primary_key ? "0" : "1",
    range,
  }));
}

let installed = false;

export function installSqlCompletions(): void {
  if (installed) return;
  installed = true;

  monaco.languages.registerCompletionItemProvider("sql", {
    // `.` opens the list after an alias; the rest is Monaco's own quick-suggest on word characters.
    triggerCharacters: ["."],
    async provideCompletionItems(model, position) {
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

      const sql = model.getValue();
      const relations = referencedRelations(sql);

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
          const columns = await childrenOf(connectionId, columnRef(tab, hit));
          return { suggestions: columnItems(columns, range, hit.table) };
        }
        // Not an alias, so it reads as a schema: `public.` wants that schema's relations.
        const tables = await childrenOf(connectionId, {
          kind: "table_folder",
          database: tab.database || null,
          schema: unquote(qualifier),
          name: null,
        });
        return {
          suggestions: tables.map((node) => ({
            label: node.name,
            kind: monaco.languages.CompletionItemKind.Struct,
            detail: node.detail,
            insertText: node.name,
            range,
          })),
        };
      }

      const suggestions: MonacoLanguages.CompletionItem[] = [];
      const seen = new Set<string>();
      const push = (item: MonacoLanguages.CompletionItem) => {
        const dedupe = `${item.label as string}|${item.kind}`;
        if (seen.has(dedupe)) return;
        seen.add(dedupe);
        suggestions.push(item);
      };

      // The columns of what the statement names, unqualified — the whole point of `select <here>`.
      const columnLists = await Promise.all(
        relations.map((relation) => childrenOf(connectionId, columnRef(tab, relation))),
      );
      relations.forEach((relation, index) => {
        for (const item of columnItems(columnLists[index], range, relation.alias ?? relation.table)) {
          push(item);
        }
      });

      // The relations of the scope the console is pointed at, unqualified because that is how they
      // can be written here.
      const scoped =
        tab.database || tab.schema
          ? [
              ...(await childrenOf(connectionId, {
                kind: "table_folder",
                database: tab.database || null,
                schema: tab.schema || null,
                name: null,
              })),
              ...(await childrenOf(connectionId, {
                kind: "view_folder",
                database: tab.database || null,
                schema: tab.schema || null,
                name: null,
              })),
            ]
          : [];
      for (const node of scoped) {
        push({
          label: node.name,
          kind: monaco.languages.CompletionItemKind.Struct,
          detail: node.detail || node.schema || undefined,
          insertText: node.name,
          sortText: "2",
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
          sortText: "3",
          range,
        });
      }

      // The schemas themselves, for `schema.` to have something to complete from.
      if (tab.database) {
        const schemas = await childrenOf(connectionId, {
          kind: "database",
          database: tab.database,
          schema: null,
          name: null,
        });
        for (const node of schemas) {
          if (node.kind !== "schema") continue;
          push({
            label: node.name,
            kind: monaco.languages.CompletionItemKind.Module,
            insertText: node.name,
            sortText: "4",
            range,
          });
        }
      }

      for (const keyword of KEYWORDS) {
        push({
          label: keyword,
          kind: monaco.languages.CompletionItemKind.Keyword,
          insertText: keyword,
          sortText: "5",
          range,
        });
      }

      return { suggestions };
    },
  });
}
