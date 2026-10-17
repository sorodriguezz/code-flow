import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Search } from "lucide-react";
import { nodeIcon } from "./dbChrome";
import { parseSpec, useDbStore } from "../../state/dbStore";
import { useT } from "../../state/languageStore";
import { dbSchemaCatalog, dbSchemaObjects } from "../../lib/tauri/dbCommands";
import { engineInfo, type DbNodeKind, type DbNodeRef } from "../../types/database";

/** One object any connected server has, as the search lists it. */
interface FoundObject {
  connectionId: string;
  database: string | null;
  schema: string | null;
  name: string;
  kind: DbNodeKind;
}

/**
 * Per connection, what was read and when — so ⌘O a second time is instant. Five minutes: long
 * enough to search repeatedly while working, short enough that a table made meanwhile turns up.
 */
const cache = new Map<string, { at: number; objects: FoundObject[] }>();
const CACHE_MS = 5 * 60_000;

/**
 * Reads every object of every schema a connection shows — the catalog, then one objects query per
 * schema. Only connected connections are searched: dialling every saved server to answer a search
 * would be the surprise, and the slow part.
 */
async function indexConnection(connectionId: string): Promise<FoundObject[]> {
  const hit = cache.get(connectionId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.objects;
  const row = useDbStore.getState().connections.find((c) => c.id === connectionId);
  if (!row) return [];
  const engine = engineInfo(row.kind);
  const config = parseSpec(row);
  const visible = config?.schemas_filtered ? new Set(config.visible_schemas) : null;
  const groups = await dbSchemaCatalog(connectionId);
  const scopes: DbNodeRef[] = [];
  for (const group of groups) {
    if (engine.sql && !engine.databaseIsSchema && group.schemas.length > 0) {
      for (const schema of group.schemas) {
        if (visible && !visible.has(schema)) continue;
        scopes.push({ kind: "schema", database: group.database, schema, name: schema });
      }
    } else {
      scopes.push({ kind: "database", database: group.database, schema: null, name: group.database });
    }
  }
  const objects: FoundObject[] = [];
  // A few schemas at a time: a server with hundreds of them should not get hundreds of queries at once.
  for (let at = 0; at < scopes.length; at += 4) {
    const batch = await Promise.all(
      scopes.slice(at, at + 4).map((scope) =>
        dbSchemaObjects(connectionId, scope, crypto.randomUUID())
          .then((found) => ({ scope, found }))
          .catch(() => ({ scope, found: [] })),
      ),
    );
    for (const { scope, found } of batch) {
      for (const object of found) {
        objects.push({
          connectionId,
          database: scope.database,
          schema: scope.kind === "schema" ? scope.schema : engine.databaseIsSchema ? scope.database : null,
          name: object.name,
          kind: object.kind,
        });
      }
    }
  }
  cache.set(connectionId, { at: Date.now(), objects });
  return objects;
}

/** Subsequence match with a score: an exact or prefix match first, then the tighter the better. */
function score(name: string, query: string): number | null {
  const lower = name.toLowerCase();
  if (lower === query) return 0;
  if (lower.startsWith(query)) return 1 + lower.length / 1000;
  const contains = lower.indexOf(query);
  if (contains >= 0) return 2 + contains / 100;
  let at = 0;
  let gaps = 0;
  for (const char of query) {
    const next = lower.indexOf(char, at);
    if (next < 0) return null;
    gaps += next - at;
    at = next + 1;
  }
  return 3 + gaps / 100;
}

/**
 * Go to any table, view, collection or routine of the connected servers by typing part of its name —
 * the explorer's own search only looks at what is already expanded.
 */
export function ObjectSearchModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const connected = useDbStore((s) => s.connected);
  const connections = useDbStore((s) => s.connections);
  const [query, setQuery] = useState("");
  const [objects, setObjects] = useState<FoundObject[]>([]);
  const [pending, setPending] = useState(0);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    input.current?.focus();
    const ids = connected.filter((id) => connections.some((c) => c.id === id));
    setPending(ids.length);
    let alive = true;
    for (const id of ids) {
      void indexConnection(id)
        .then((found) => {
          if (alive) setObjects((current) => [...current.filter((o) => o.connectionId !== id), ...found]);
        })
        .catch(() => {})
        .finally(() => alive && setPending((n) => n - 1));
    }
    return () => {
      alive = false;
    };
    // Read once per opening: the index is what the dialog was opened against.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return objects.slice(0, 100);
    return objects
      .map((object) => ({ object, score: score(object.name, needle) }))
      .filter((entry): entry is { object: FoundObject; score: number } => entry.score !== null)
      .sort((a, b) => a.score - b.score)
      .slice(0, 100)
      .map((entry) => entry.object);
  }, [objects, query]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const open = (object: FoundObject) => {
    const store = useDbStore.getState();
    const node: DbNodeRef = { kind: object.kind, database: object.database, schema: object.schema, name: object.name };
    if (object.kind === "routine" || object.kind === "sequence") void store.openDdl(object.connectionId, node, object.name);
    else store.openData(object.connectionId, node, object.name);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/30 pt-[12vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[60vh] w-[min(640px,calc(100vw-32px))] flex-col overflow-hidden rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] shadow-[var(--cf-shadow)]">
        <div className="flex items-center gap-2 border-b border-[var(--cf-border)] px-3 py-2">
          <Search size={14} className="text-[var(--cf-text-muted)]" />
          <input
            ref={input}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("db.objectSearchPlaceholder")}
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-[13px] text-[var(--cf-text)] outline-none placeholder:text-[var(--cf-text-muted)]"
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              else if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((n) => Math.min(results.length - 1, n + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((n) => Math.max(0, n - 1));
              } else if (e.key === "Enter" && results[active]) {
                e.preventDefault();
                open(results[active]);
              }
            }}
          />
          {pending > 0 && <Loader2 size={13} className="animate-spin text-[var(--cf-text-muted)]" />}
        </div>
        <div ref={list} className="min-h-0 flex-1 overflow-auto py-1">
          {connected.length === 0 ? (
            <p className="px-3 py-3 text-[12px] text-[var(--cf-text-muted)]">{t("db.objectSearchNoConnections")}</p>
          ) : results.length === 0 && pending === 0 ? (
            <p className="px-3 py-3 text-[12px] text-[var(--cf-text-muted)]">{t("db.noMatches")}</p>
          ) : (
            results.map((object, index) => {
              const Icon = nodeIcon(object.kind);
              const connection = connections.find((c) => c.id === object.connectionId);
              return (
                <button
                  key={`${object.connectionId}|${object.database}|${object.schema}|${object.kind}|${object.name}`}
                  data-index={index}
                  type="button"
                  onMouseEnter={() => setActive(index)}
                  onClick={() => open(object)}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] ${
                    index === active ? "bg-[var(--cf-accent-soft)]" : ""
                  }`}
                >
                  <Icon size={13} className="shrink-0 text-[var(--cf-text-muted)]" />
                  <span className="min-w-0 truncate text-[var(--cf-text)]">{object.name}</span>
                  <span className="ml-auto min-w-0 shrink truncate text-[11px] text-[var(--cf-text-faint)]">
                    {[connection?.name, object.database, object.schema !== object.database ? object.schema : null]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </button>
              );
            })
          )}
        </div>
        <div className="border-t border-[var(--cf-border)] px-3 py-1 text-[10.5px] text-[var(--cf-text-faint)]">
          {t("db.objectSearchHint", { n: String(objects.length) })}
        </div>
      </div>
    </div>
  );
}
