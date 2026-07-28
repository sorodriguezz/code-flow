import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  GripVertical,
  Loader2,
  Play,
  Square,
  X,
  XCircle,
} from "lucide-react";
import { Checkbox } from "../common/Checkbox";
import { ApiModal, Field, GhostButton, PrimaryButton } from "./ApiModal";
import { DRAG_THRESHOLD, setDragCursor } from "../../lib/pointerDrag";
import { useApiStore } from "../../state/apiStore";
import { useApiRuntimeStore } from "../../state/apiRuntimeStore";
import { pushErrorToast, useToastStore } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import { resolveRequest, sendResolved } from "../../lib/api/send";
import { runPostResponseScript, runPreRequestScript, type SandboxScopes } from "../../lib/api/sandbox";
import type { VariableContext } from "../../lib/api/variables";
import { apiPickFile, apiReadTextFile, apiSaveFile } from "../../lib/tauri/apiCommands";
import { defaultRequestSpec } from "../../types/api";
import type {
  ApiFolder,
  ApiProtocol,
  ApiRequestRow,
  ApiRequestSpec,
  ApiResponse,
  HttpResponse,
  ResolvedRequest,
  RunnerConfig,
  RunnerReport,
  RunnerResultItem,
  TestResult,
} from "../../types/api";

/**
 * Hard ceiling on requests executed in one run. `postman.setNextRequest` can jump backwards, which
 * is what makes retry loops possible and also what makes an accidental infinite loop possible; a
 * runner that never returns is worse than one that stops and says so.
 */
const EXECUTION_CAP = 2000;

/** A socket or gRPC request has no meaning in a batch run — there is nothing to assert on. */
const RUNNABLE: ApiProtocol[] = ["http", "graphql"];

const DATA_EXTENSIONS = ["csv", "json", "tsv", "txt"];

function parseSpec(row: ApiRequestRow): ApiRequestSpec {
  const fallback = defaultRequestSpec(row.protocol);
  try {
    return { ...fallback, ...(JSON.parse(row.spec) as Partial<ApiRequestSpec>) };
  } catch {
    return fallback;
  }
}

/**
 * Requests directly under a node come before its subfolders' contents. Folders and requests carry
 * independent `sort_order` sequences within the same parent, so there is no single truth to
 * interleave them by; this order at least keeps a collection's root-level setup requests (log in,
 * seed) ahead of everything nested, and the list is drag-reorderable regardless.
 */
function flattenRequests(
  folders: ApiFolder[],
  requests: ApiRequestRow[],
  collectionId: string,
  rootFolderId: string | null,
): ApiRequestRow[] {
  const out: ApiRequestRow[] = [];
  const seen = new Set<string>();

  const visit = (parentId: string | null) => {
    out.push(
      ...requests
        .filter(
          (r) =>
            r.collection_id === collectionId &&
            r.folder_id === parentId &&
            RUNNABLE.includes(r.protocol),
        )
        .sort((a, b) => a.sort_order - b.sort_order),
    );
    for (const folder of folders
      .filter((f) => f.collection_id === collectionId && f.parent_id === parentId)
      .sort((a, b) => a.sort_order - b.sort_order)) {
      if (seen.has(folder.id)) continue;
      seen.add(folder.id);
      visit(folder.id);
    }
  };

  visit(rootFolderId);
  return out;
}

// ---------------------------------------------------------------------------
// Data files
// ---------------------------------------------------------------------------

/**
 * RFC 4180 CSV: double quotes escape delimiters, `""` is a literal quote, and a quoted field may
 * span newlines. `split(",")` corrupts every export that contains an address or a JSON column, so
 * this walks the text one character at a time instead.
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      // A CRLF inside a quoted field becomes a plain newline, so the value matches what a
      // spreadsheet shows rather than carrying a stray carriage return into the request.
      if (ch === "\r" && text[i + 1] === "\n") {
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (ch === "\r") {
      i += 1;
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  // A file that doesn't end in a newline still has one last field and one last row.
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function jsonRows(parsed: unknown): Record<string, string>[] {
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list.map((entry) => {
    const row: Record<string, string> = {};
    if (entry !== null && typeof entry === "object") {
      for (const [key, value] of Object.entries(entry as Record<string, unknown>)) {
        row[key] =
          typeof value === "string"
            ? value
            : value === null || value === undefined
              ? ""
              : JSON.stringify(value);
      }
    }
    return row;
  });
}

function csvRows(text: string): Record<string, string>[] {
  const table = parseCsv(text);
  if (table.length === 0) return [];
  const headers = table[0].map((header) => header.trim());
  return table
    .slice(1)
    .filter((cells) => cells.some((cell) => cell.trim() !== ""))
    .map((cells) => {
      const row: Record<string, string> = {};
      headers.forEach((header, index) => {
        if (header) row[header] = cells[index] ?? "";
      });
      return row;
    });
}

function parseDataFile(text: string, path: string): Record<string, string>[] {
  const trimmed = text.trim();
  const looksJson = /\.json$/i.test(path) || trimmed.startsWith("[") || trimmed.startsWith("{");
  if (looksJson) return jsonRows(JSON.parse(trimmed));
  return csvRows(text);
}

// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function moveInList(list: string[], id: string, target: number): string[] {
  const current = list.indexOf(id);
  if (current < 0) return list;
  const without = list.filter((entry) => entry !== id);
  // Removing the dragged row first shifts every later slot down by one.
  const insert = target > current ? target - 1 : target;
  without.splice(Math.max(0, Math.min(insert, without.length)), 0, id);
  return without;
}

export function RunnerModal({
  collectionId,
  folderId,
  onClose,
}: {
  collectionId: string;
  folderId: string | null;
  onClose: () => void;
}) {
  const t = useT();
  const folders = useApiStore((s) => s.folders);
  const requests = useApiStore((s) => s.requests);
  const collectionName = useApiStore(
    (s) => s.collections.find((c) => c.id === collectionId)?.name ?? "",
  );
  const running = useApiRuntimeStore((s) => s.runnerRunning);
  const pushToast = useToastStore((s) => s.pushToast);

  const candidates = useMemo(
    () => flattenRequests(folders, requests, collectionId, folderId),
    [folders, requests, collectionId, folderId],
  );
  const byId = useMemo(() => new Map(candidates.map((row) => [row.id, row])), [candidates]);

  const [order, setOrder] = useState<string[]>(() => candidates.map((row) => row.id));
  /** Unchecked rows. Tracking the exclusions means a newly-imported request is included by default. */
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [iterations, setIterations] = useState(1);
  const [delayMs, setDelayMs] = useState(0);
  const [persistVariables, setPersistVariables] = useState(false);
  const [stopOnError, setStopOnError] = useState(false);
  const [data, setData] = useState<Record<string, string>[]>([]);
  const [dataPath, setDataPath] = useState<string | null>(null);
  const [view, setView] = useState<"setup" | "results">("setup");
  const [progress, setProgress] = useState<{ done: number; total: number; label: string } | null>(null);
  const [report, setReport] = useState<RunnerReport | null>(null);
  const [capped, setCapped] = useState(false);

  const abortRef = useRef(false);
  const orderRef = useRef(order);
  orderRef.current = order;

  // Keeps the manual order alive across tree reloads: known ids stay put, new ones land at the end.
  useEffect(() => {
    setOrder((previous) => {
      const known = new Set(candidates.map((row) => row.id));
      const kept = previous.filter((id) => known.has(id));
      const added = candidates.filter((row) => !kept.includes(row.id)).map((row) => row.id);
      return added.length === 0 && kept.length === previous.length ? previous : [...kept, ...added];
    });
  }, [candidates]);

  // A run that outlives its modal has nothing to report to; stopping is the honest teardown.
  useEffect(
    () => () => {
      abortRef.current = true;
      useApiRuntimeStore.getState().setRunnerRunning(false);
    },
    [],
  );

  const selectedIds = order.filter((id) => !excluded.has(id));
  const allSelected = selectedIds.length === order.length && order.length > 0;

  const toggleAll = () =>
    setExcluded(allSelected ? new Set(order) : new Set());

  const toggleOne = (id: string) =>
    setExcluded((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // ---------- drag reorder ----------

  const [dragId, setDragId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  const beginDrag = useCallback((e: React.PointerEvent<HTMLElement>, id: string) => {
    if (e.button !== 0) return;
    const from = { x: e.clientX, y: e.clientY };
    let started = false;

    /** Insertion slot under the pointer: before or after the row it's over, by which half. */
    const slotAt = (x: number, y: number): number | null => {
      const row = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-cf-runid]");
      const overId = row?.dataset.cfRunid;
      if (!row || overId === undefined) return null;
      const at = orderRef.current.indexOf(overId);
      if (at < 0) return null;
      const rect = row.getBoundingClientRect();
      return y > rect.top + rect.height / 2 ? at + 1 : at;
    };

    const onMove = (ev: PointerEvent) => {
      if (!started) {
        if (Math.hypot(ev.clientX - from.x, ev.clientY - from.y) < DRAG_THRESHOLD) return;
        started = true;
        setDragCursor(true);
        setDragId(id);
      }
      setDropIndex(slotAt(ev.clientX, ev.clientY));
    };

    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (!started) return;
      const target = slotAt(ev.clientX, ev.clientY);
      setDragCursor(false);
      setDragId(null);
      setDropIndex(null);
      if (target !== null) setOrder((previous) => moveInList(previous, id, target));
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }, []);

  // ---------- data file ----------

  const pickData = async () => {
    const path = await apiPickFile(DATA_EXTENSIONS).catch((e: unknown) => {
      pushErrorToast(String(e));
      return null;
    });
    if (!path) return;
    try {
      const rows = parseDataFile(await apiReadTextFile(path), path);
      setData(rows);
      setDataPath(path);
      // One iteration per row is what a data file means; the field stays editable afterwards.
      if (rows.length > 0) setIterations(rows.length);
    } catch (e) {
      pushErrorToast(t("api.runner.dataFailed", { error: String(e) }));
    }
  };

  // ---------- the run ----------

  const run = async () => {
    const chosen = selectedIds
      .map((id) => byId.get(id))
      .filter((row): row is ApiRequestRow => row !== undefined);
    if (chosen.length === 0) {
      pushErrorToast(t("api.runner.noRequests"));
      return;
    }

    const store = useApiStore.getState();
    const runtime = useApiRuntimeStore.getState();
    const { settings, cookies, activeEnvironmentId } = store;
    const seed = store.variableContext(collectionId);

    const config: RunnerConfig = {
      collectionId,
      folderId,
      requestIds: chosen.map((row) => row.id),
      iterations: Math.max(1, Math.floor(iterations) || 1),
      delayMs: Math.max(0, Math.floor(delayMs) || 0),
      data,
      persistVariables,
      stopOnError,
    };

    abortRef.current = false;
    setCapped(false);
    setReport(null);
    setView("results");
    runtime.setRunnerReport(null);
    runtime.setRunnerRunning(true);

    /**
     * The one mutable piece of the whole run. Every script's writes land here and the next request
     * resolves against it — a token fetched in request 1 being visible to request 2 is the reason
     * a runner exists at all.
     */
    let scopes: SandboxScopes = {
      local: {},
      data: {},
      environment: seed.environment.map((variable) => ({ ...variable })),
      collection: seed.collection.map((variable) => ({ ...variable })),
      global: seed.global.map((variable) => ({ ...variable })),
    };

    const execute = async (
      row: ApiRequestRow,
      iteration: number,
    ): Promise<{ item: RunnerResultItem; next: string | null }> => {
      const spec = parseSpec(row);
      const ctx: VariableContext = {
        local: scopes.local,
        data: scopes.data,
        environment: scopes.environment,
        collection: scopes.collection,
        global: scopes.global,
      };
      const item: RunnerResultItem = {
        iteration,
        requestId: row.id,
        name: row.name,
        method: spec.method,
        url: spec.url,
        status: null,
        durationMs: 0,
        sizeBytes: 0,
        tests: [],
        error: null,
      };

      let resolved: ResolvedRequest;
      try {
        resolved = await resolveRequest(spec, ctx, store.effectiveAuthChain(row.id), settings, cookies);
      } catch (e) {
        return { item: { ...item, error: String(e) }, next: null };
      }
      item.method = resolved.method;
      item.url = resolved.url;

      let next: string | null = null;

      if (spec.preScript.trim() !== "") {
        const pre = await runPreRequestScript(spec.preScript, { request: resolved, scopes });
        scopes = pre.scopes;
        next = pre.nextRequest;
        for (const line of pre.console) runtime.pushConsole(line);
        if (pre.error) return { item: { ...item, error: pre.error }, next };
      }

      const sentAt = Date.now();
      let http: HttpResponse;
      try {
        http = await sendResolved(resolved);
      } catch (e) {
        return { item: { ...item, error: String(e), durationMs: Date.now() - sentAt }, next };
      }

      item.status = http.status;
      item.durationMs = http.duration_ms;
      item.sizeBytes = http.size_bytes;

      if (spec.postScript.trim() !== "") {
        const response: ApiResponse = {
          ...http,
          tests: [],
          consoleLines: [],
          visualizer: null,
          error: null,
        };
        const post = await runPostResponseScript(spec.postScript, {
          request: resolved,
          response,
          scopes,
        });
        scopes = post.scopes;
        item.tests = post.tests;
        if (post.nextRequest !== null) next = post.nextRequest;
        for (const line of post.console) runtime.pushConsole(line);
        if (post.error) return { item: { ...item, error: post.error }, next };
      }

      return { item, next };
    };

    const items: RunnerResultItem[] = [];
    const startedAt = Date.now();
    const estimate = config.iterations * chosen.length;
    let executed = 0;
    let hitCap = false;

    const wait = async (ms: number) => {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        if (abortRef.current) return;
        await sleep(Math.min(100, until - Date.now()));
      }
    };

    try {
      runLoop: for (let iteration = 0; iteration < config.iterations; iteration += 1) {
        // Locals are per-iteration so two iterations can't contaminate each other; the environment,
        // collection and global scopes deliberately carry across the whole run.
        scopes = {
          ...scopes,
          local: {},
          data: config.data.length > 0 ? config.data[iteration % config.data.length] : {},
        };

        let index = 0;
        while (index < chosen.length) {
          if (abortRef.current) break runLoop;
          if (executed >= EXECUTION_CAP) {
            hitCap = true;
            break runLoop;
          }

          const row = chosen[index];
          executed += 1;
          setProgress({ done: executed, total: Math.max(estimate, executed), label: row.name });

          const { item, next } = await execute(row, iteration);
          items.push(item);
          setReport({
            startedAt,
            finishedAt: Date.now(),
            items: [...items],
            totalRequests: items.length,
            totalAssertions: items.reduce((n, entry) => n + entry.tests.length, 0),
            failedAssertions: items.reduce(
              (n, entry) => n + entry.tests.filter((test) => !test.passed).length,
              0,
            ),
          });

          const failed = item.error !== null || item.tests.some((test) => !test.passed);
          if (config.stopOnError && failed) break runLoop;

          if (next !== null) {
            const target = chosen.findIndex((candidate) => candidate.name === next);
            if (target >= 0) {
              index = target;
            } else {
              runtime.pushConsole({
                level: "warn",
                text: t("api.runner.unknownNext", { name: next }),
                at: Date.now(),
              });
              index += 1;
            }
          } else {
            index += 1;
          }

          if (config.delayMs > 0) await wait(config.delayMs);
        }
      }
    } catch (e) {
      pushErrorToast(String(e));
    }

    const finished: RunnerReport = {
      startedAt,
      finishedAt: Date.now(),
      items,
      totalRequests: items.length,
      totalAssertions: items.reduce((n, entry) => n + entry.tests.length, 0),
      failedAssertions: items.reduce(
        (n, entry) => n + entry.tests.filter((test) => !test.passed).length,
        0,
      ),
    };

    if (config.persistVariables) {
      const after = useApiStore.getState();
      const globals = after.environments.find((environment) => environment.is_global);
      if (globals) {
        await after.updateEnvironment({ ...globals, variables: JSON.stringify(scopes.global) });
      }
      const environment = after.environments.find(
        (candidate) => candidate.id === activeEnvironmentId && !candidate.is_global,
      );
      if (environment) {
        await after.updateEnvironment({
          ...environment,
          variables: JSON.stringify(scopes.environment),
        });
      }
      const collection = after.collections.find((candidate) => candidate.id === collectionId);
      if (collection) {
        await after.updateCollection({
          ...collection,
          variables: JSON.stringify(scopes.collection),
        });
      }
    }

    setCapped(hitCap);
    if (hitCap) {
      runtime.pushConsole({
        level: "warn",
        text: t("api.runner.capReached", { n: EXECUTION_CAP }),
        at: Date.now(),
      });
    }
    setReport(finished);
    setProgress(null);
    runtime.setRunnerReport(finished);
    runtime.setRunnerRunning(false);
  };

  const exportReport = async () => {
    if (!report) return;
    try {
      const path = await apiSaveFile(
        `${collectionName || "collection"}-run.json`,
        JSON.stringify(report, null, 2),
      );
      if (path) pushToast(t("api.export.done", { path }), "success");
    } catch (e) {
      pushErrorToast(t("api.toast.exportFailed", { error: String(e) }));
    }
  };

  const passedAssertions = report ? report.totalAssertions - report.failedAssertions : 0;

  return (
    <ApiModal
      icon={Play}
      title={t("api.runner.title")}
      subtitle={collectionName}
      width="max-w-4xl"
      height="h-[80vh]"
      busy={running}
      onClose={onClose}
      toolbar={
        <div className="flex items-center gap-1">
          {(
            [
              ["setup", t("api.runner.setup")],
              ["results", t("api.runner.results")],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              onClick={() => setView(id)}
              className={`rounded-md px-2 py-1 text-[11px] ${
                view === id
                  ? "bg-[var(--cf-accent-soft)] font-medium text-[var(--cf-accent)]"
                  : "text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      }
      footer={
        <>
          <span className="mr-auto min-w-0 truncate text-[11px] text-[var(--cf-text-muted)]">
            {progress
              ? `${t("api.runner.progress", { done: progress.done, total: progress.total })} · ${progress.label}`
              : report
                ? t("api.runner.summary", {
                    requests: report.totalRequests,
                    passed: passedAssertions,
                    total: report.totalAssertions,
                  })
                : ""}
          </span>
          {report && !running && (
            <GhostButton onClick={() => void exportReport()}>
              <Download size={12} />
              {t("api.runner.exportResults")}
            </GhostButton>
          )}
          {running ? (
            <PrimaryButton danger onClick={() => (abortRef.current = true)}>
              <Square size={12} />
              {t("api.runner.stop")}
            </PrimaryButton>
          ) : (
            <PrimaryButton onClick={() => void run()} disabled={selectedIds.length === 0}>
              <Play size={13} />
              {t("api.runner.run")}
            </PrimaryButton>
          )}
        </>
      }
    >
      {view === "setup" ? (
        <div className="flex min-h-0 flex-1">
          {/* Ordered request list */}
          <div className="flex min-w-0 flex-1 flex-col border-r border-[var(--cf-border)]">
            <div className="flex shrink-0 items-center gap-2 border-b border-[var(--cf-border)] px-3 py-1.5">
              <Checkbox checked={allSelected} onChange={toggleAll} />
              <span className="text-[11px] text-[var(--cf-text)]">{t("api.runner.selectAll")}</span>
              <span className="ml-auto text-[11px] text-[var(--cf-text-muted)]">
                {t("api.runner.reorderHint")}
              </span>
            </div>

            <div className="min-h-0 flex-1 overflow-auto p-1">
              {order.length === 0 && (
                <p className="p-3 text-[12px] text-[var(--cf-text-muted)]">{t("api.noRequests")}</p>
              )}
              {order.map((id, index) => {
                const row = byId.get(id);
                if (!row) return null;
                return (
                  <div key={id} data-cf-runid={id}>
                    {dropIndex === index && dragId !== null && (
                      <div className="mx-2 h-[2px] rounded bg-[var(--cf-accent)]" />
                    )}
                    <div
                      className={`flex items-center gap-2 rounded-md px-2 py-1.5 ${
                        dragId === id ? "opacity-40" : "hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
                      }`}
                    >
                      <span
                        onPointerDown={(e) => beginDrag(e, id)}
                        title={t("api.runner.reorderHint")}
                        className="cursor-grab text-[var(--cf-text-muted)]"
                      >
                        <GripVertical size={13} />
                      </span>
                      <Checkbox checked={!excluded.has(id)} onChange={() => toggleOne(id)} />
                      <span className="w-[44px] shrink-0 font-mono text-[10px] font-semibold uppercase text-[var(--cf-accent)]">
                        {row.method}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--cf-text)]">
                        {row.name}
                      </span>
                      <span className="min-w-0 max-w-[45%] truncate font-mono text-[11px] text-[var(--cf-text-muted)]">
                        {row.url}
                      </span>
                    </div>
                    {dropIndex === index + 1 && dragId !== null && index === order.length - 1 && (
                      <div className="mx-2 h-[2px] rounded bg-[var(--cf-accent)]" />
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Run settings */}
          <div className="w-[240px] shrink-0 overflow-auto p-3">
            <label className="mb-1 block text-[11px] font-medium text-[var(--cf-text-muted)]">
              {t("api.runner.iterations")}
            </label>
            <Field
              type="number"
              value={String(iterations)}
              onChange={(value) => setIterations(Number(value))}
            />

            <label className="mb-1 mt-3 block text-[11px] font-medium text-[var(--cf-text-muted)]">
              {t("api.runner.delay")}
            </label>
            <Field type="number" value={String(delayMs)} onChange={(value) => setDelayMs(Number(value))} />

            <label className="mb-1 mt-3 block text-[11px] font-medium text-[var(--cf-text-muted)]">
              {t("api.runner.dataFile")}
            </label>
            {dataPath === null ? (
              <GhostButton onClick={() => void pickData()}>
                <FileSpreadsheet size={12} />
                {t("api.import.pickFile")}
              </GhostButton>
            ) : (
              <div className="rounded-md border border-[var(--cf-border)] p-2">
                <div className="flex items-center gap-1.5">
                  <FileSpreadsheet size={12} className="shrink-0 text-[var(--cf-accent)]" />
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px]" title={dataPath}>
                    {dataPath.split(/[\\/]/).pop()}
                  </span>
                  <button
                    onClick={() => {
                      setData([]);
                      setDataPath(null);
                    }}
                    title={t("api.runner.removeData")}
                    className="text-[var(--cf-text-muted)] hover:text-[var(--cf-danger)]"
                  >
                    <X size={12} />
                  </button>
                </div>
                <p className="mt-1 text-[11px] text-[var(--cf-text-muted)]">
                  {t("api.runner.dataRows", { n: data.length })}
                </p>
              </div>
            )}

            <label className="mt-4 flex cursor-pointer items-start gap-2">
              <Checkbox checked={persistVariables} onChange={setPersistVariables} className="mt-[1px]" />
              <span className="text-[12px] text-[var(--cf-text)]">
                {t("api.runner.persistVariables")}
              </span>
            </label>

            <label className="mt-2 flex cursor-pointer items-start gap-2">
              <Checkbox checked={stopOnError} onChange={setStopOnError} className="mt-[1px]" />
              <span className="text-[12px] text-[var(--cf-text)]">{t("api.runner.stopOnError")}</span>
            </label>
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto p-3">
          {capped && (
            <p className="mb-2 flex items-center gap-1.5 rounded-md border border-[var(--cf-warning)] bg-[color-mix(in_oklab,var(--cf-warning)_12%,transparent)] px-2 py-1.5 text-[11px] text-[var(--cf-text)]">
              <AlertTriangle size={12} className="shrink-0 text-[var(--cf-warning)]" />
              {t("api.runner.capReached", { n: EXECUTION_CAP })}
            </p>
          )}

          {!report ? (
            <p className="p-3 text-[12px] text-[var(--cf-text-muted)]">
              {running ? (
                <span className="flex items-center gap-1.5">
                  <Loader2 size={12} className="animate-spin" />
                  {t("api.runner.running")}
                </span>
              ) : (
                t("api.runner.noResults")
              )}
            </p>
          ) : (
            <div className="overflow-hidden rounded-md border border-[var(--cf-border)]">
              {report.items.map((item, index) => {
                const failedTests = item.tests.filter((test) => !test.passed);
                const ok = item.error === null && failedTests.length === 0;
                return (
                  <div
                    key={`${item.iteration}-${item.requestId}-${index}`}
                    className={index === 0 ? "" : "border-t border-[var(--cf-border)]"}
                  >
                    <div className="flex items-center gap-2 px-2.5 py-1.5">
                      {ok ? (
                        <CheckCircle2 size={13} className="shrink-0 text-[var(--cf-success)]" />
                      ) : (
                        <XCircle size={13} className="shrink-0 text-[var(--cf-danger)]" />
                      )}
                      <span className="w-[68px] shrink-0 text-[10px] uppercase tracking-wide text-[var(--cf-text-muted)]">
                        {t("api.runner.iteration", { n: item.iteration + 1 })}
                      </span>
                      <span className="w-[44px] shrink-0 font-mono text-[10px] font-semibold uppercase text-[var(--cf-accent)]">
                        {item.method}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--cf-text)]">
                        {item.name}
                      </span>
                      <span className="w-[44px] shrink-0 text-right font-mono text-[11px] text-[var(--cf-text-muted)]">
                        {item.status ?? "—"}
                      </span>
                      <span className="w-[64px] shrink-0 text-right font-mono text-[11px] text-[var(--cf-text-muted)]">
                        {item.durationMs} ms
                      </span>
                      <span className="w-[76px] shrink-0 text-right text-[11px] text-[var(--cf-text-muted)]">
                        {item.tests.length > 0
                          ? t("api.response.testsPassed", {
                              passed: item.tests.length - failedTests.length,
                              total: item.tests.length,
                            })
                          : ""}
                      </span>
                    </div>

                    {item.error !== null && (
                      <p className="px-2.5 pb-1.5 pl-[38px] text-[11px] leading-snug text-[var(--cf-danger)]">
                        {item.error}
                      </p>
                    )}

                    {failedTests.length > 0 && (
                      <ul className="px-2.5 pb-1.5 pl-[38px]">
                        {failedTests.map((test: TestResult, testIndex) => (
                          <li
                            key={testIndex}
                            className="text-[11px] leading-snug text-[var(--cf-text-muted)]"
                          >
                            <span className="text-[var(--cf-danger)]">{test.name}</span>
                            {test.error && ` — ${test.error}`}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </ApiModal>
  );
}
