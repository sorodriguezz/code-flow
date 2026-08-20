import type { DbmlEnum, DbmlField, DbmlSchema, DbmlTable } from "./types";

/**
 * What changed between two schemas.
 *
 * The comparison is **structural, not textual**: two documents that declare the same tables in a
 * different order, with the settings written in a different order, are the same schema and this
 * says so. That is the whole reason it exists rather than a text diff — a text diff of two DBML
 * files is mostly noise about formatting, and the question being asked is "will this migration drop
 * a column".
 */

export type DiffStatus = "added" | "removed" | "modified" | "unchanged";

export interface FieldDiff {
  name: string;
  status: DiffStatus;
  before: DbmlField | null;
  after: DbmlField | null;
  /** One entry per property that moved, already spelled out for display. */
  changes: { property: string; before: string; after: string }[];
}

export interface TableDiff {
  /** The qualified id, which is what identity means here. */
  id: string;
  name: string;
  status: DiffStatus;
  fields: FieldDiff[];
}

export interface EnumDiff {
  id: string;
  name: string;
  status: DiffStatus;
  added: string[];
  removed: string[];
}

export interface RefDiff {
  key: string;
  status: "added" | "removed";
}

export interface SchemaDiff {
  tables: TableDiff[];
  enums: EnumDiff[];
  refs: RefDiff[];
  changed: boolean;
  counts: { added: number; removed: number; modified: number };
}

/** Reading order: what is new, what moved, what stayed, what went. */
const ORDER: DiffStatus[] = ["added", "modified", "unchanged", "removed"];

function byStatus(a: { status: DiffStatus }, b: { status: DiffStatus }): number {
  return ORDER.indexOf(a.status) - ORDER.indexOf(b.status);
}

function flag(value: boolean): string {
  return value ? "yes" : "no";
}

function diffFields(before: DbmlField[], after: DbmlField[]): FieldDiff[] {
  const left = new Map(before.map((field) => [field.name, field]));
  const right = new Map(after.map((field) => [field.name, field]));
  const names = new Set([...left.keys(), ...right.keys()]);

  const diffs: FieldDiff[] = [];
  for (const name of names) {
    const was = left.get(name) ?? null;
    const now = right.get(name) ?? null;
    if (!was) {
      diffs.push({ name, status: "added", before: null, after: now, changes: [] });
      continue;
    }
    if (!now) {
      diffs.push({ name, status: "removed", before: was, after: null, changes: [] });
      continue;
    }
    const changes: FieldDiff["changes"] = [];
    if (was.type !== now.type) changes.push({ property: "type", before: was.type, after: now.type });
    if (was.pk !== now.pk) changes.push({ property: "pk", before: flag(was.pk), after: flag(now.pk) });
    if (was.notNull !== now.notNull) {
      changes.push({ property: "not null", before: flag(was.notNull), after: flag(now.notNull) });
    }
    if (was.unique !== now.unique) {
      changes.push({ property: "unique", before: flag(was.unique), after: flag(now.unique) });
    }
    if (was.increment !== now.increment) {
      changes.push({ property: "increment", before: flag(was.increment), after: flag(now.increment) });
    }
    if (was.default !== now.default) {
      changes.push({ property: "default", before: was.default ?? "—", after: now.default ?? "—" });
    }
    if (was.note !== now.note) {
      changes.push({ property: "note", before: was.note || "—", after: now.note || "—" });
    }
    diffs.push({
      name,
      status: changes.length > 0 ? "modified" : "unchanged",
      before: was,
      after: now,
      changes,
    });
  }
  return diffs.sort(byStatus);
}

/** How a reference is identified for comparison: both ends and both cardinalities. */
function refKey(schema: DbmlSchema): Map<string, string> {
  const keys = new Map<string, string>();
  for (const ref of schema.refs) {
    const key = `${ref.from.table}.${ref.from.fields.join("+")} ${ref.from.relation}-${ref.to.relation} ${ref.to.table}.${ref.to.fields.join("+")}`;
    keys.set(key, key);
  }
  return keys;
}

export function diffSchemas(before: DbmlSchema, after: DbmlSchema): SchemaDiff {
  const leftTables = new Map<string, DbmlTable>(before.tables.map((table) => [table.id, table]));
  const rightTables = new Map<string, DbmlTable>(after.tables.map((table) => [table.id, table]));

  const tables: TableDiff[] = [];
  for (const id of new Set([...leftTables.keys(), ...rightTables.keys()])) {
    const was = leftTables.get(id);
    const now = rightTables.get(id);
    if (!was && now) {
      tables.push({ id, name: now.name, status: "added", fields: diffFields([], now.fields) });
    } else if (was && !now) {
      tables.push({ id, name: was.name, status: "removed", fields: diffFields(was.fields, []) });
    } else if (was && now) {
      const fields = diffFields(was.fields, now.fields);
      tables.push({
        id,
        name: now.name,
        status: fields.some((field) => field.status !== "unchanged") ? "modified" : "unchanged",
        fields,
      });
    }
  }
  tables.sort(byStatus);

  const leftEnums = new Map<string, DbmlEnum>(before.enums.map((entry) => [entry.id, entry]));
  const rightEnums = new Map<string, DbmlEnum>(after.enums.map((entry) => [entry.id, entry]));
  const enums: EnumDiff[] = [];
  for (const id of new Set([...leftEnums.keys(), ...rightEnums.keys()])) {
    const was = leftEnums.get(id);
    const now = rightEnums.get(id);
    const wasValues = (was?.values ?? []).map((value) => value.name);
    const nowValues = (now?.values ?? []).map((value) => value.name);
    if (!was && now) {
      enums.push({ id, name: now.name, status: "added", added: nowValues, removed: [] });
    } else if (was && !now) {
      enums.push({ id, name: was.name, status: "removed", added: [], removed: wasValues });
    } else if (was && now) {
      const added = nowValues.filter((value) => !wasValues.includes(value));
      const removed = wasValues.filter((value) => !nowValues.includes(value));
      enums.push({
        id,
        name: now.name,
        status: added.length > 0 || removed.length > 0 ? "modified" : "unchanged",
        added,
        removed,
      });
    }
  }
  enums.sort(byStatus);

  const leftRefs = refKey(before);
  const rightRefs = refKey(after);
  const refs: RefDiff[] = [
    ...[...rightRefs.keys()].filter((key) => !leftRefs.has(key)).map((key) => ({ key, status: "added" as const })),
    ...[...leftRefs.keys()].filter((key) => !rightRefs.has(key)).map((key) => ({ key, status: "removed" as const })),
  ];

  const all = [...tables, ...enums];
  const counts = {
    added: all.filter((entry) => entry.status === "added").length,
    removed: all.filter((entry) => entry.status === "removed").length,
    modified: all.filter((entry) => entry.status === "modified").length,
  };

  return {
    tables,
    enums,
    refs,
    counts,
    changed: counts.added + counts.removed + counts.modified > 0 || refs.length > 0,
  };
}
