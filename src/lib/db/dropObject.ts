import { engineInfo, type DbKind, type DbNode } from "../../types/database";
import { objectReference, quoteIdent } from "./sqlTemplates";

/**
 * The statements that actually remove an object, for the explorer's "Drop…" rows.
 *
 * **Deliberately not in `sqlTemplates.ts`.** Everything in that module is a *draft*: it lands in a
 * console, the user reads it, and the user decides to run it — which is why its `DROP` carries a
 * comment and why nothing there is ever executed on its own. What is here is the opposite by
 * design: a statement built to be sent, because "right-click → drop" is the whole feature, and the
 * safeguard is the confirmation in front of it rather than a draft the user has to finish. Keeping
 * the two apart is what stops a change to one silently arming the other.
 *
 * `null` means the engine has no such operation and the menu row must not be offered — never a
 * fallback statement. A row labelled "Drop schema" that sends something else is worse than no row.
 */

/** A schema's objects, read from the tree so a container drop can name and order them. */
export interface SchemaContents {
  tables: DbNode[];
  views: DbNode[];
}

/**
 * `DROP TABLE` / `DROP VIEW` / `db.x.drop()` for one relation.
 *
 * The kind is read off the node rather than assumed: this menu opens on views too, and `DROP TABLE`
 * against a view is an error on every engine here.
 *
 * Redis answers `null`. Its "tables" are keys and its "collections" are namespace prefixes — a `DEL`
 * is a perfectly good thing to want, but it is not what "drop table" means, and the generator menu
 * already drafts one.
 */
export function dropRelationSql(node: DbNode, kind: DbKind): string | null {
  const language = engineInfo(kind).consoleLanguage;
  if (language === "redis") return null;
  // `db.<collection>.drop()` — the one shell operation this console maps straight through.
  if (language === "javascript") return `${objectReference(node, kind)}.drop()`;
  const what = node.kind === "view" ? "VIEW" : "TABLE";
  return `DROP ${what} ${objectReference(node, kind)}`;
}

/**
 * Everything needed to remove a schema — and, on Mongo, the database that stands in for one.
 *
 * Three shapes, because the engines genuinely differ and pretending otherwise would produce a row
 * that fails on half of them:
 *
 * - **Postgres (and Supabase)** has `CASCADE`, so this is one statement that either takes the whole
 *   schema or takes nothing. That is the good case and the one worth having: no ordering, no
 *   partial state, and foreign keys pointing in from elsewhere are dropped with it.
 * - **SQL Server and IRIS** have no `CASCADE` for a schema: `DROP SCHEMA` refuses while anything is
 *   still in it. So the objects the tree knows about go first — views before tables, since a view
 *   over a table blocks it — and the schema last. **This is best-effort and says so**: a foreign key
 *   between two of those tables can still make the order wrong, and a routine or a sequence the
 *   confirmation never counted will keep the last statement from succeeding. The engine's own error
 *   is what the user sees then, which names the object in the way, and the tables that did drop
 *   stay dropped. A connection with an object filter on narrows the list this is built from, too:
 *   the tree is where `contents` comes from, and the tree is showing what the filter left. The alternative — walking the constraint graph from the frontend — is a query
 *   planner in TypeScript for a case Postgres solves with one keyword.
 * - **Mongo** has no schema level at all; the container is the database, and `dropDatabase` is a
 *   command rather than a collection method, so it goes through `runCommand` — which is the one
 *   escape hatch this console's shell subset always understands.
 *
 * `null` for Redis, for the reason `dropRelationSql` gives.
 */
export function dropContainerSql(
  node: DbNode,
  kind: DbKind,
  contents: SchemaContents,
): string | null {
  const language = engineInfo(kind).consoleLanguage;
  if (language === "redis") return null;
  if (language === "javascript") return `db.runCommand({ "dropDatabase": 1 })`;

  const schema = node.schema ?? node.name;
  if (kind === "postgres" || kind === "supabase") {
    return `DROP SCHEMA ${quoteIdent(schema, kind)} CASCADE`;
  }
  return [
    ...contents.views.map((view) => `DROP VIEW ${objectReference(view, kind)}`),
    ...contents.tables.map((table) => `DROP TABLE ${objectReference(table, kind)}`),
    `DROP SCHEMA ${quoteIdent(schema, kind)}`,
  ].join(";\n");
}

/**
 * Whether this engine can drop a schema from the tree at all.
 *
 * Read by the menu so the row is absent rather than present-and-broken on Redis — the one engine
 * with no container to drop.
 */
export function canDropObjects(kind: DbKind): boolean {
  return engineInfo(kind).consoleLanguage !== "redis";
}
