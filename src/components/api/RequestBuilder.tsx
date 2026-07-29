import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Download, Loader2, Save, Send, X } from "lucide-react";
import { Select } from "../common/Select";
import { ResizeHandle } from "../common/ResizeHandle";
import { KeyValueTable } from "./KeyValueTable";
import { VariableInput } from "./VariableInput";
import { badgeColor, badgeLabel, protocolIcon } from "./methodStyle";
import { AuthPanel } from "./AuthPanel";
import { BodyPanel } from "./BodyPanel";
import { GraphqlPanel } from "./GraphqlPanel";
import { ScriptsPanel } from "./ScriptsPanel";
import { RequestSettingsPanel } from "./RequestSettingsPanel";
import { ResponsePanel } from "./ResponsePanel";
import { StreamPanel } from "./StreamPanel";
import { GrpcPanel } from "./GrpcPanel";
import { registerTabActions, type TabActions } from "./tabActions";
import { buildImplicitHeaders, resolveRequest, sendResolved } from "../../lib/api/send";
import { runPostResponseScript, runPreRequestScript, type SandboxScopes } from "../../lib/api/sandbox";
import { looksLikeCurl, parseCurl } from "../../lib/api/importers";
import { PROTOCOL_NAMES, switchProtocol } from "../../lib/api/protocol";
import { apiCancelHttp, apiSaveFile } from "../../lib/tauri/apiCommands";
import { useApiStore } from "../../state/apiStore";
import { useApiRuntimeStore } from "../../state/apiRuntimeStore";
import { useLayoutStore } from "../../state/layoutStore";
import { useT } from "../../state/languageStore";
import { pushErrorToast, useToastStore } from "../../state/toastStore";
import { API_PROTOCOLS, emptyKeyValue, HTTP_METHODS, STREAMING_PROTOCOLS } from "../../types/api";
import type {
  ApiCollection,
  ApiFolder,
  ApiProtocol,
  ApiResponse,
  ApiRequestSpec,
  ConsoleLine,
  KeyValue,
  ParsedCookie,
  ResolvedRequest,
  TestResult,
} from "../../types/api";
import type { TranslationKey } from "../../lib/i18n/translations";

/**
 * The centre of the API client: name row, URL bar, the request editor's tab strip, and the
 * response pane below a draggable splitter.
 *
 * The one thing worth reading before changing anything here is the URL ↔ params relationship.
 * They are two views of the same data, and each direction is handled in the handler that owns the
 * edit — never in an effect that watches the draft. An effect would fire on *both* edits and race
 * the user's caret: the field they are typing into would be rewritten from the other view a frame
 * later, which is exactly how two-way binding usually goes wrong.
 */

type PanelId = "params" | "auth" | "headers" | "body" | "pre" | "tests" | "settings" | "docs";

const MIN_RESPONSE_HEIGHT = 140;
const MAX_RESPONSE_HEIGHT = 900;
const IMPLICIT_HEADER_DEBOUNCE_MS = 250;
/** How much of a body the history snapshot keeps. */
const HISTORY_BODY_LIMIT = 200_000;

const INPUT_SHELL =
  "rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface)] focus-within:border-[var(--cf-accent)]";

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// URL ↔ table
// ---------------------------------------------------------------------------

function splitUrl(url: string): { base: string; query: string; fragment: string } {
  const hashAt = url.indexOf("#");
  const fragment = hashAt < 0 ? "" : url.slice(hashAt);
  const head = hashAt < 0 ? url : url.slice(0, hashAt);
  const queryAt = head.indexOf("?");
  return {
    base: queryAt < 0 ? head : head.slice(0, queryAt),
    query: queryAt < 0 ? "" : head.slice(queryAt + 1),
    fragment,
  };
}

/** Left exactly as typed — `resolveRequest` is what decides whether to percent-encode, per the
 *  request's `encodeUrl` setting, and decoding here would mean doing it twice. */
function parseQuery(query: string): [string, string][] {
  if (query === "") return [];
  return query
    .split("&")
    .filter((piece) => piece !== "")
    .map((piece): [string, string] => {
      const eq = piece.indexOf("=");
      return eq < 0 ? [piece, ""] : [piece.slice(0, eq), piece.slice(eq + 1)];
    });
}

/**
 * Rebuilds the params table from the query string the user just typed.
 *
 * Enabled rows are matched to query pairs by position, so editing a key in the URL keeps that
 * row's description and id instead of replacing it with a stranger. Disabled rows have no
 * counterpart in the URL at all and are put back at the index they held, so unchecking a row
 * doesn't make it leap to the bottom of the table on the next keystroke.
 */
function syncParamsFromUrl(url: string, existing: KeyValue[]): KeyValue[] {
  const pairs = parseQuery(splitUrl(url).query);
  const held = existing
    .map((row, index) => ({ row, index }))
    .filter((entry) => !entry.row.enabled);
  const pool = existing.filter((row) => row.enabled);
  const rows = pairs.map(([key, value], index) => {
    const previous = pool[index];
    return previous
      ? { ...previous, key, value }
      : { ...emptyKeyValue(newId("kv")), key, value };
  });
  for (const { row, index } of held) rows.splice(Math.min(index, rows.length), 0, row);
  return rows;
}

function applyParamsToUrl(url: string, rows: KeyValue[]): string {
  const { base, fragment } = splitUrl(url);
  const query = rows
    .filter((row) => row.enabled && row.key !== "")
    .map((row) => `${row.key}=${row.value}`)
    .join("&");
  return query === "" ? base + fragment : `${base}?${query}${fragment}`;
}

/** The same pattern and the same region `send.ts` substitutes over, so the table lists exactly
 *  what will be replaced — and `:8080` never matches, because a name can't start with a digit. */
const PATH_VAR = /:([A-Za-z_][A-Za-z0-9_-]*)/g;

function syncPathVarsFromUrl(url: string, existing: KeyValue[]): KeyValue[] {
  const schemeEnd = url.indexOf("://");
  const tail = schemeEnd < 0 ? url : url.slice(schemeEnd + 3);
  const names: string[] = [];
  for (const match of tail.matchAll(PATH_VAR)) {
    if (!names.includes(match[1])) names.push(match[1]);
  }
  if (names.length === 0 && existing.length === 0) return existing;
  return names.map((name) => {
    const previous = existing.find((row) => row.key === name);
    return previous ?? { ...emptyKeyValue(newId("kv")), key: name };
  });
}

// ---------------------------------------------------------------------------
// Tree lookups
// ---------------------------------------------------------------------------

function breadcrumbFor(
  collections: ApiCollection[],
  folders: ApiFolder[],
  collectionId: string | null,
  folderId: string | null,
): string[] {
  const parts: string[] = [];
  const seen = new Set<string>();
  let current = folderId;
  while (current !== null && !seen.has(current)) {
    seen.add(current);
    const folder = folders.find((item) => item.id === current);
    if (!folder) break;
    parts.unshift(folder.name);
    current = folder.parent_id;
  }
  const collection = collections.find((item) => item.id === collectionId);
  if (collection) parts.unshift(collection.name);
  return parts;
}

/** Every folder of one collection, flattened with a `parent / child` label. */
function folderOptions(folders: ApiFolder[], collectionId: string): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = [];
  const walk = (parent: string | null, prefix: string) => {
    const children = folders
      .filter((folder) => folder.collection_id === collectionId && folder.parent_id === parent)
      .sort((a, b) => a.sort_order - b.sort_order);
    for (const folder of children) {
      const label = prefix + folder.name;
      out.push({ value: folder.id, label });
      walk(folder.id, `${label} / `);
    }
  };
  walk(null, "");
  return out;
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

function failureResponse(
  message: string,
  request: ResolvedRequest | null,
  durationMs: number,
  tests: TestResult[],
  consoleLines: ConsoleLine[],
): ApiResponse {
  return {
    status: 0,
    status_text: "",
    http_version: "",
    headers: [],
    body_text: "",
    body_base64: null,
    size_bytes: 0,
    duration_ms: durationMs,
    timings: {
      dns_ms: -1,
      connect_ms: -1,
      tls_ms: -1,
      first_byte_ms: -1,
      download_ms: -1,
      total_ms: durationMs,
    },
    redirects: [],
    set_cookies: [],
    sent: {
      method: request?.method ?? "",
      url: request?.url ?? "",
      headers: request?.headers ?? [],
      body_preview: "",
    },
    tests,
    consoleLines,
    visualizer: null,
    error: message,
  };
}

/** History exists to replay a request, not to archive its payload — a 50 MB body in every
 *  snapshot would turn `codeflow.db` into a log file. */
function forHistory(response: ApiResponse): ApiResponse {
  return {
    ...response,
    body_text: response.body_text.slice(0, HISTORY_BODY_LIMIT),
    body_base64: null,
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function downloadNameFor(url: string): string {
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).pop();
    if (last) return last;
  } catch {
    // A URL still holding unresolved variables doesn't parse; the generic name is the point.
  }
  return "response.txt";
}

const URL_PLACEHOLDERS: Record<ApiProtocol, TranslationKey> = {
  http: "api.urlPlaceholder",
  graphql: "api.urlPlaceholder",
  websocket: "api.wsUrlPlaceholder",
  socketio: "api.wsUrlPlaceholder",
  mqtt: "api.mqttUrlPlaceholder",
  grpc: "api.grpcUrlPlaceholder",
};

const PANEL_LABELS: Record<PanelId, TranslationKey> = {
  params: "api.tab.params",
  auth: "api.tab.authorization",
  headers: "api.tab.headers",
  body: "api.tab.body",
  pre: "api.tab.preRequest",
  tests: "api.tab.tests",
  settings: "api.tab.settings",
  docs: "api.tab.docs",
};

const PANEL_ORDER: PanelId[] = ["params", "auth", "headers", "body", "pre", "tests", "settings", "docs"];

function enabledCount(rows: KeyValue[]): number {
  return rows.filter((row) => row.enabled && row.key.trim() !== "").length;
}

/** Whether the request's per-request settings override anything at all. */
function hasOverrides(spec: ApiRequestSpec): boolean {
  return Object.values(spec.settings).some((value) => value !== null);
}

// ---------------------------------------------------------------------------

export function RequestBuilder({ tabId }: { tabId: string }) {
  const t = useT();
  const tab = useApiStore((s) => s.openTabs.find((item) => item.id === tabId) ?? null);
  const collections = useApiStore((s) => s.collections);
  const folders = useApiStore((s) => s.folders);
  const environments = useApiStore((s) => s.environments);
  const activeEnvironmentId = useApiStore((s) => s.activeEnvironmentId);
  const sending = useApiRuntimeStore((s) => s.sending[tabId] ?? false);
  const responseHeight = useLayoutStore((s) => s.sizes.apiResponseHeight);
  const setSize = useLayoutStore((s) => s.setSize);
  const commitSize = useLayoutStore((s) => s.commitSize);
  const pushToast = useToastStore((s) => s.pushToast);

  const [panel, setPanel] = useState<PanelId>("params");
  const [menuOpen, setMenuOpen] = useState(false);
  const [savePicker, setSavePicker] = useState<{ collectionId: string; folderId: string } | null>(null);
  const [protocolMenu, setProtocolMenu] = useState(false);
  const [implicitHeaders, setImplicitHeaders] = useState<KeyValue[]>([]);
  const [showImplicit, setShowImplicit] = useState(false);
  const trackRef = useRef<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<TabActions>({ save: () => {}, send: () => {} });

  const collectionId = tab?.collectionId ?? null;
  const spec = tab?.draft ?? null;
  const protocol = spec?.protocol ?? "http";

  // `variableContext()` builds a fresh object on every call, so it can never be a selector —
  // useSyncExternalStore would see a new snapshot on every render and spin. It is rebuilt only
  // when one of the things it reads actually changes.
  const variableContext = useMemo(
    () => useApiStore.getState().variableContext(collectionId),
    [collectionId, collections, environments, activeEnvironmentId],
  );

  const update = (patch: Partial<ApiRequestSpec>) => useApiStore.getState().updateDraft(tabId, patch);

  // ---------- saving ----------

  const save = async () => {
    const store = useApiStore.getState();
    const current = store.openTabs.find((item) => item.id === tabId);
    if (!current) return;
    // The button is disabled in this state, but ⌘S isn't — and re-writing a row with the spec it
    // already holds would bump `updated_at` for a save that saved nothing.
    if (!current.dirty) return;
    // A scratch tab that has never been filed has nowhere to go; that's the cue for the picker,
    // not an error.
    if (current.requestId === null && current.collectionId === null) {
      const first = store.collections[0];
      setSavePicker({ collectionId: first?.id ?? "", folderId: "" });
      return;
    }
    // No toast on success: the tab's dirty dot clearing is the confirmation, and a save is one
    // keystroke people repeat constantly — a popup for each one is noise over the request.
    await store.saveTab(tabId);
  };

  const saveToTarget = async () => {
    if (!savePicker || savePicker.collectionId === "") return;
    await useApiStore.getState().saveTab(tabId, {
      collectionId: savePicker.collectionId,
      folderId: savePicker.folderId === "" ? null : savePicker.folderId,
    });
    setSavePicker(null);
  };


  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  // ---------- auto-generated headers ----------

  useEffect(() => {
    if (panel !== "headers" || !spec) return;
    let cancelled = false;
    // Resolving is a full interpolate-and-sign pass; debounced so it doesn't run per keystroke.
    const timer = setTimeout(() => {
      const store = useApiStore.getState();
      void resolveRequest(
        spec,
        store.variableContext(collectionId),
        store.authChainForTab(tabId),
        store.settings,
        store.cookies,
      )
        .then((resolved) => {
          if (cancelled) return;
          setImplicitHeaders(
            buildImplicitHeaders(resolved).map(([key, value]) => ({
              ...emptyKeyValue(`implicit-${key}`),
              key,
              value,
            })),
          );
        })
        .catch(() => {
          // A body the resolver rejects (invalid GraphQL variables) means there is nothing
          // truthful to list; the explicit headers above are unaffected.
          if (!cancelled) setImplicitHeaders([]);
        });
    }, IMPLICIT_HEADER_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [panel, spec, collectionId, tabId]);

  // ---------- sending ----------

  const persistScopeWrites = async (before: SandboxScopes, after: SandboxScopes) => {
    const store = useApiStore.getState();
    const changed = (a: unknown, b: unknown) => JSON.stringify(a) !== JSON.stringify(b);
    if (changed(before.environment, after.environment)) {
      const env = store.environments.find((item) => item.id === store.activeEnvironmentId && !item.is_global);
      if (env) await store.updateEnvironment({ ...env, variables: JSON.stringify(after.environment) });
    }
    if (changed(before.global, after.global)) {
      const globals = store.environments.find((item) => item.is_global);
      if (globals) await store.updateEnvironment({ ...globals, variables: JSON.stringify(after.global) });
    }
    if (changed(before.collection, after.collection)) {
      const collection = store.collections.find((item) => item.id === collectionId);
      if (collection) await store.updateCollection({ ...collection, variables: JSON.stringify(after.collection) });
    }
  };

  const persistCookies = async (cookies: ParsedCookie[]) => {
    // A jar row belongs to a workspace, and the send this reply answers came from a tab in the
    // loaded one — so this is a type guard, not a case the user can reach.
    const workspaceId = useApiStore.getState().workspaceId;
    if (workspaceId === null) return;
    for (const cookie of cookies) {
      const store = useApiStore.getState();
      const existing = store.cookies.find(
        (item) => item.domain === cookie.domain && item.path === cookie.path && item.name === cookie.name,
      );
      await store.upsertCookie({
        id: existing?.id ?? newId("cookie"),
        workspace_id: workspaceId,
        domain: cookie.domain,
        path: cookie.path,
        name: cookie.name,
        value: cookie.value,
        secure: cookie.secure,
        http_only: cookie.http_only,
        expires: cookie.expires,
        updated_at: new Date().toISOString(),
      });
    }
  };

  const recordHistory = async (response: ApiResponse, request: ResolvedRequest | null) => {
    const store = useApiStore.getState();
    if (!store.settings.saveHistory || store.workspaceId === null) return;
    const current = store.openTabs.find((item) => item.id === tabId);
    if (!current) return;
    await store.addHistory({
      id: newId("hist"),
      workspace_id: store.workspaceId,
      request_id: current.requestId,
      name: current.name || current.draft.url || t("api.untitledRequest"),
      protocol: current.draft.protocol,
      method: request?.method ?? current.draft.method,
      url: request?.url ?? current.draft.url,
      status: response.error === null ? response.status : null,
      duration_ms: response.duration_ms,
      size_bytes: response.size_bytes,
      snapshot: JSON.stringify({ request: current.draft, response: forHistory(response) }),
      created_at: new Date().toISOString(),
    });
  };

  const downloadBody = async (response: ApiResponse) => {
    if (response.body_base64 !== null) {
      // `apiSaveFile` writes text; dumping the base64 of a PNG into a file named `logo.png` would
      // be worse than refusing.
      pushErrorToast(t("api.response.binary", { size: formatBytes(response.size_bytes) }));
      return;
    }
    const path = await apiSaveFile(downloadNameFor(response.sent.url), response.body_text);
    if (path) pushToast(t("api.response.savedTo", { path }), "success");
  };

  const runSend = async (download: boolean) => {
    const store = useApiStore.getState();
    const current = store.openTabs.find((item) => item.id === tabId);
    const runtime = useApiRuntimeStore.getState();
    if (!current || runtime.sending[tabId]) return;

    const trackId = newId("send");
    trackRef.current = trackId;
    runtime.setSending(tabId, true);
    runtime.setResponse(tabId, null);

    const before: SandboxScopes = store.variableContext(current.collectionId);
    let scopes = before;
    const consoleLines: ConsoleLine[] = [];
    const tests: TestResult[] = [];
    const startedAt = Date.now();
    let request: ResolvedRequest | null = null;

    const scriptError = (error: string): ConsoleLine => ({
      level: "error",
      text: t("api.scripts.error", { error }),
      at: Date.now(),
    });

    try {
      request = await resolveRequest(
        current.draft,
        scopes,
        store.authChainForTab(tabId),
        store.settings,
        store.cookies,
      );

      if (current.draft.preScript.trim() !== "") {
        // The pre-request script mutates `request` in place — that is how `pm.request.headers.add`
        // reaches the wire — so this must run against the object that is about to be sent.
        const pre = await runPreRequestScript(current.draft.preScript, { request, scopes });
        scopes = pre.scopes;
        consoleLines.push(...pre.console);
        tests.push(...pre.tests);
        if (pre.error) consoleLines.push(scriptError(pre.error));
      }

      const http = await sendResolved(request, trackId);
      let response: ApiResponse = {
        ...http,
        tests: [...tests],
        consoleLines: [...consoleLines],
        visualizer: null,
        error: null,
      };

      if (current.draft.postScript.trim() !== "") {
        const post = await runPostResponseScript(current.draft.postScript, { request, response, scopes });
        scopes = post.scopes;
        response = {
          ...response,
          tests: [...tests, ...post.tests],
          consoleLines: [...consoleLines, ...post.console, ...(post.error ? [scriptError(post.error)] : [])],
          visualizer: post.visualizer,
        };
      }

      useApiRuntimeStore.getState().setResponse(tabId, response);
      for (const line of response.consoleLines) useApiRuntimeStore.getState().pushConsole(line);
      await persistScopeWrites(before, scopes);
      await persistCookies(http.set_cookies);
      await recordHistory(response, request);
      if (download) await downloadBody(response);
    } catch (e) {
      const message = String(e);
      const response = failureResponse(message, request, Date.now() - startedAt, tests, [
        ...consoleLines,
        { level: "error", text: message, at: Date.now() },
      ]);
      // The failure is already the response — the panel shows it in full, with the message in the
      // console — so a toast on top of it would say the same thing twice.
      useApiRuntimeStore.getState().setResponse(tabId, response);
      await recordHistory(response, request);
    } finally {
      useApiRuntimeStore.getState().setSending(tabId, false);
      if (trackRef.current === trackId) trackRef.current = null;
    }
  };

  const cancelSend = () => {
    const trackId = trackRef.current;
    if (trackId) void apiCancelHttp(trackId).catch(() => {});
  };

  // `ApiView` owns ⌘S/⌘Enter, but only this component can carry them out. The ref is rewritten on
  // every render and the registration is not, so the shortcut always runs against the current
  // draft without re-registering on every keystroke.
  actionsRef.current = {
    save: () => void save(),
    send: () => {
      // The streaming and gRPC protocols have no Send: their panels own the connection, and
      // firing one from a keyboard shortcut would be a second source of truth for the socket.
      if (!spec || spec.url.trim() === "") return;
      if (STREAMING_PROTOCOLS.includes(protocol) || protocol === "grpc") return;
      void runSend(false);
    },
  };
  useEffect(
    () =>
      registerTabActions(tabId, {
        save: () => actionsRef.current.save(),
        send: () => actionsRef.current.send(),
      }),
    [tabId],
  );

  // ---------- URL ----------

  const importCurl = (text: string): boolean => {
    const parsed = parseCurl(text);
    if (!parsed || !spec) return false;
    // Scripts, docs and saved examples describe *this* request, not the pasted command — losing
    // them to a paste in the URL field would be an unpleasant surprise.
    update({
      ...parsed,
      preScript: spec.preScript,
      postScript: spec.postScript,
      description: spec.description,
      examples: spec.examples,
    });
    pushToast(t("api.toast.curlDetected"), "success");
    return true;
  };

  const onUrlChange = (next: string) => {
    if (!spec) return;
    // `onPaste` is the reliable detection path; this catches the ways text lands in an input
    // without a paste event (a text drop, autofill). It is gated on a jump no keystroke can
    // produce, so typing `curl h` into the field can't blow the request away mid-word.
    if (next.length - spec.url.length > 12 && looksLikeCurl(next) && importCurl(next)) return;
    update({
      url: next,
      params: syncParamsFromUrl(next, spec.params),
      pathVars: syncPathVarsFromUrl(next, spec.pathVars),
    });
  };

  const onParamsChange = (rows: KeyValue[]) => {
    if (!spec) return;
    update({ params: rows, url: applyParamsToUrl(spec.url, rows) });
  };

  if (!tab || !spec) return <div className="h-full" />;

  const ProtocolIcon = protocolIcon(spec.protocol);
  // `requestId` is the honest test for "saved": a scratch tab has none until `saveTab` files it,
  // and that is exactly the moment the protocol stops being a choice.
  const protocolLocked = tab.requestId !== null;

  const isStreaming = STREAMING_PROTOCOLS.includes(protocol);
  const isGrpc = protocol === "grpc";
  const crumbs = breadcrumbFor(collections, folders, tab.collectionId, tab.folderId);

  const badgeCount = (id: PanelId): string | null => {
    switch (id) {
      case "params": {
        const total = enabledCount(spec.params) + enabledCount(spec.pathVars);
        return total > 0 ? String(total) : null;
      }
      case "headers": {
        const total = enabledCount(spec.headers);
        return total > 0 ? String(total) : null;
      }
      default:
        return null;
    }
  };

  const badgeDot = (id: PanelId): boolean => {
    switch (id) {
      case "auth":
        return spec.auth.type !== "inherit" && spec.auth.type !== "none";
      case "body":
        return spec.body.mode !== "none";
      case "pre":
        return spec.preScript.trim() !== "";
      case "tests":
        return spec.postScript.trim() !== "";
      case "settings":
        return hasOverrides(spec);
      case "docs":
        return spec.description.trim() !== "";
      default:
        return false;
    }
  };

  const panelLabel = (id: PanelId): string =>
    t(id === "body" && protocol === "graphql" ? "api.tab.query" : PANEL_LABELS[id]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* ---------- name row ---------- */}
      {/* Reads as one line — what kind of request, where it lives, what it's called — with only
          the last part editable. The protocol leads because it's the thing that decides what
          everything below the row even means. */}
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--cf-border)] px-3 py-1.5">
        <div className="relative shrink-0">
          {/* Locked once the request has a row of its own: the protocol shapes the whole request —
              a body, a subscription, a service call — so changing it on something already saved is
              less "adjust a setting" than "replace this with a different request". While it's
              still a scratch tab there's nothing to betray, so it stays editable. */}
          {protocolLocked ? (
            <span
              title={`${PROTOCOL_NAMES[spec.protocol]} — ${t("api.protocolLocked")}`}
              className="flex h-6 w-6 items-center justify-center"
            >
              <ProtocolIcon size={15} style={{ color: badgeColor(spec.protocol, "") }} />
            </span>
          ) : (
            <button
              type="button"
              onClick={() => setProtocolMenu((open) => !open)}
              title={t("api.changeProtocol")}
              aria-label={t("api.changeProtocol")}
              aria-haspopup="menu"
              aria-expanded={protocolMenu}
              className="flex h-6 w-6 items-center justify-center rounded hover:bg-black/[0.05] dark:hover:bg-white/[0.08]"
            >
              <ProtocolIcon size={15} style={{ color: badgeColor(spec.protocol, "") }} />
            </button>
          )}

          {protocolMenu && !protocolLocked && (
            <>
              {/* Full-viewport catcher, so the click that dismisses doesn't also press whatever
                  is underneath it. */}
              <div className="fixed inset-0 z-[9998]" onMouseDown={() => setProtocolMenu(false)} />
              <div
                role="menu"
                className="absolute left-0 top-full z-[9999] mt-1 w-[180px] rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-1 shadow-[var(--cf-shadow)]"
              >
                {API_PROTOCOLS.map((id) => {
                  const Icon = protocolIcon(id);
                  return (
                    <button
                      key={id}
                      role="menuitem"
                      onClick={() => {
                        setProtocolMenu(false);
                        if (id !== spec.protocol) update(switchProtocol(spec, id));
                      }}
                      className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[12px] hover:bg-[color-mix(in_oklab,var(--cf-accent)_16%,transparent)] ${
                        id === spec.protocol ? "text-[var(--cf-accent)]" : "text-[var(--cf-text)]"
                      }`}
                    >
                      <Icon size={14} className="shrink-0" style={{ color: badgeColor(id, "") }} />
                      {PROTOCOL_NAMES[id]}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>

        {/* The path, then the name as its last segment — the same trail the explorer shows, with
            the one part you're allowed to change sitting where it actually belongs. */}
        {crumbs.map((crumb, index) => (
          <span
            key={`${crumb}-${index}`}
            className="flex min-w-0 shrink items-center gap-2 text-[12px] text-[var(--cf-text-muted)]"
          >
            <span className="truncate">{crumb}</span>
            <ChevronRight size={12} className="shrink-0 opacity-60" />
          </span>
        ))}
        <input
          type="text"
          value={tab.name}
          spellCheck={false}
          placeholder={t("api.untitledRequest")}
          aria-label={t("api.untitledRequest")}
          onChange={(e) => useApiStore.getState().renameTab(tabId, e.target.value)}
          className="min-w-[80px] flex-1 rounded bg-transparent px-1 py-0.5 text-[13px] font-semibold text-[var(--cf-text)] outline-none placeholder:font-normal placeholder:text-[var(--cf-text-muted)] hover:bg-black/[0.04] focus:bg-[var(--cf-surface)] dark:hover:bg-white/[0.05]"
        />
        {tab.dirty && (
          <span className="shrink-0 text-[11px] text-[var(--cf-text-muted)]" title={t("api.unsaved")}>
            {t("api.unsaved")}
          </span>
        )}
        <div className="relative shrink-0">
          {/* Live only when there's something to save. A button that looks the same whether or
              not it would do anything makes "is my work in?" a question you have to answer some
              other way — here the button itself is the answer, and the "unsaved" tag beside it
              says the same thing twice on purpose. */}
          <button
            onClick={() => void save()}
            disabled={!tab.dirty}
            title={tab.dirty ? t("api.save") : t("api.noChangesToSave")}
            className="flex items-center gap-1.5 rounded-md border border-[var(--cf-border)] px-2.5 py-1 text-[12px] text-[var(--cf-text)] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)] disabled:cursor-default disabled:border-[var(--cf-border)] disabled:text-[var(--cf-text-muted)] disabled:opacity-50 disabled:hover:border-[var(--cf-border)] disabled:hover:text-[var(--cf-text-muted)]"
          >
            <Save size={13} />
            {t("api.save")}
          </button>

          {savePicker && (
            <div className="absolute right-0 top-full z-50 mt-1 w-[320px] rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-3 shadow-[var(--cf-shadow)]">
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
                {t("api.saveTo")}
              </p>
              {collections.length === 0 ? (
                <p className="text-[12px] text-[var(--cf-text-muted)]">{t("api.noCollections")}</p>
              ) : (
                <div className="flex flex-col gap-2">
                  <label className="flex flex-col gap-1">
                    <span className="text-[11px] text-[var(--cf-text-muted)]">{t("api.scope.collection")}</span>
                    <Select
                      size="sm"
                      value={savePicker.collectionId}
                      onChange={(value) => setSavePicker({ collectionId: value, folderId: "" })}
                      options={collections.map((item) => ({ value: item.id, label: item.name }))}
                      ariaLabel={t("api.scope.collection")}
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-[11px] text-[var(--cf-text-muted)]">{t("api.folder")}</span>
                    <Select
                      size="sm"
                      value={savePicker.folderId}
                      onChange={(value) => setSavePicker({ ...savePicker, folderId: value })}
                      options={[
                        { value: "", label: t("api.collectionRoot") },
                        ...folderOptions(folders, savePicker.collectionId),
                      ]}
                      ariaLabel={t("api.folder")}
                    />
                  </label>
                </div>
              )}
              <div className="mt-3 flex justify-end gap-2">
                <button
                  onClick={() => setSavePicker(null)}
                  className="rounded-md px-2.5 py-1 text-[12px] text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
                >
                  {t("common.cancel")}
                </button>
                <button
                  onClick={() => void saveToTarget()}
                  disabled={collections.length === 0}
                  className="rounded-md bg-[var(--cf-accent)] px-2.5 py-1 text-[12px] font-medium text-white disabled:opacity-40"
                >
                  {t("api.save")}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ---------- URL bar ---------- */}
      <div className="flex shrink-0 items-stretch gap-2 px-3 py-2">
        {protocol === "http" ? (
          // The colour lives on the wrapper because `Select` renders its own label span with no
          // colour of its own — it inherits, which is exactly what makes a themed verb possible.
          <div className="w-[104px] shrink-0" style={{ color: badgeColor(protocol, spec.method) }}>
            <Select
              size="sm"
              value={spec.method}
              onChange={(method) => update({ method })}
              options={HTTP_METHODS.map((method) => ({ value: method, label: method }))}
              ariaLabel={t("api.method")}
              // `h-full` rather than a matching padding: the row is `items-stretch`, so the
              // height to match is whatever the URL field resolves to, and hard-coding a padding
              // that happens to agree today would drift the moment either side is restyled.
              className="h-full font-mono font-semibold"
            />
          </div>
        ) : (
          <span
            className="flex shrink-0 items-center rounded-md border border-[var(--cf-border)] px-2.5 font-mono text-[11px] font-semibold"
            style={{ color: badgeColor(protocol, spec.method) }}
          >
            {badgeLabel(protocol, spec.method)}
          </span>
        )}

        <VariableInput
          value={spec.url}
          onChange={onUrlChange}
          variableContext={variableContext}
          placeholder={t(URL_PLACEHOLDERS[protocol])}
          ariaLabel={t("api.urlPlaceholder")}
          className={`flex-1 ${INPUT_SHELL}`}
          fieldClassName="px-2.5 py-1.5 text-[12px]"
          onPaste={(e) => {
            const text = e.clipboardData.getData("text");
            if (!looksLikeCurl(text)) return;
            // `preventDefault` only *after* the import succeeds. Doing it up front on the strength
            // of `looksLikeCurl` alone would swallow the paste whenever the parse then failed —
            // the field would sit there looking like paste was broken.
            if (importCurl(text)) e.preventDefault();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !isStreaming && !isGrpc && spec.url.trim() !== "") {
              void runSend(false);
            }
          }}
        />

        {/* Streaming and gRPC transports are driven from their own panels, which own the
            connection lifecycle and the status they report — a second Connect button here would
            be a second source of truth for the same socket. */}
        {!isStreaming && !isGrpc && (
          <div ref={menuRef} className="relative flex shrink-0 items-stretch">
            {sending ? (
              <button
                onClick={cancelSend}
                className="flex items-center gap-1.5 rounded-md border border-[var(--cf-border)] px-3 text-[12px] text-[var(--cf-text)] hover:border-[var(--cf-danger)] hover:text-[var(--cf-danger)]"
              >
                <X size={13} />
                {t("api.cancel")}
              </button>
            ) : (
              <>
                <button
                  onClick={() => void runSend(false)}
                  disabled={spec.url.trim() === ""}
                  className="flex items-center gap-1.5 rounded-l-md bg-[var(--cf-accent)] px-3 text-[12px] font-medium text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Send size={13} />
                  {t("api.send")}
                </button>
                <button
                  onClick={() => setMenuOpen((open) => !open)}
                  aria-label={t("api.sendAndDownload")}
                  disabled={spec.url.trim() === ""}
                  className="flex items-center rounded-r-md border-l border-white/25 bg-[var(--cf-accent)] px-1.5 text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <ChevronDown size={13} />
                </button>
              </>
            )}

            {menuOpen && !sending && (
              <div className="absolute right-0 top-full z-50 mt-1 w-[200px] rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-1 shadow-[var(--cf-shadow)]">
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    void runSend(true);
                  }}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] text-[var(--cf-text)] hover:bg-[var(--cf-accent-soft)]"
                >
                  <Download size={13} className="shrink-0 text-[var(--cf-text-muted)]" />
                  {t("api.sendAndDownload")}
                </button>
              </div>
            )}
          </div>
        )}

        {sending && (isStreaming || isGrpc) && (
          <Loader2 size={14} className="shrink-0 animate-spin self-center text-[var(--cf-text-muted)]" />
        )}
      </div>

      {/* ---------- editor + response ---------- */}
      {isStreaming ? (
        <div className="min-h-0 flex-1">
          <StreamPanel tabId={tabId} />
        </div>
      ) : isGrpc ? (
        <div className="min-h-0 flex-1">
          <GrpcPanel tabId={tabId} />
        </div>
      ) : (
        <>
          {/* `overflow-hidden` so a squeezed request area clips instead of spilling over the
              response below it — the panels inside are sized by their own content and would
              otherwise keep painting at full height once this box shrinks past them. */}
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <div className="cf-tab-strip flex shrink-0 items-stretch gap-1 overflow-x-auto border-y border-[var(--cf-border)] px-3">
              {PANEL_ORDER.map((id) => {
                const count = badgeCount(id);
                const active = panel === id;
                return (
                  <button
                    key={id}
                    onClick={() => setPanel(id)}
                    className={`relative flex shrink-0 items-center gap-1 whitespace-nowrap px-2 py-2 text-[12px] transition-colors ${
                      active
                        ? "text-[var(--cf-text)]"
                        : "text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
                    }`}
                  >
                    {panelLabel(id)}
                    {count !== null && (
                      <span className="text-[11px] text-[var(--cf-success)]">({count})</span>
                    )}
                    {count === null && badgeDot(id) && (
                      <span className="h-1.5 w-1.5 rounded-full bg-[var(--cf-success)]" />
                    )}
                    {active && <span className="absolute inset-x-1 bottom-0 h-[2px] bg-[var(--cf-accent)]" />}
                  </button>
                );
              })}
            </div>

            {/* No `overflow` here: every sibling panel roots at `h-full min-h-0` and owns its own
                scrolling (Monaco in particular must be measured, not scrolled by an ancestor), so
                the panels rendered inline below bring their own scroll container instead. */}
            <div className="min-h-0 flex-1">
              {panel === "params" && (
                <div className="flex h-full flex-col gap-4 overflow-auto p-3">
                  <section className="flex flex-col gap-1.5">
                    <h3 className="text-[11px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
                      {t("api.queryParams")}
                    </h3>
                    <KeyValueTable
                      rows={spec.params}
                      onChange={onParamsChange}
                      variableContext={variableContext}
                      allowBulkEdit
                    />
                  </section>
                  {spec.pathVars.length > 0 && (
                    <section className="flex flex-col gap-1.5">
                      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
                        {t("api.pathVariables")}
                      </h3>
                      <KeyValueTable
                        rows={spec.pathVars}
                        onChange={(pathVars) => update({ pathVars })}
                        variableContext={variableContext}
                      />
                    </section>
                  )}
                </div>
              )}

              {panel === "auth" && <AuthPanel tabId={tabId} />}

              {panel === "headers" && (
                <div className="flex h-full flex-col gap-3 overflow-auto p-3">
                  <KeyValueTable
                    rows={spec.headers}
                    onChange={(headers) => update({ headers })}
                    variableContext={variableContext}
                    allowBulkEdit
                  />
                  {implicitHeaders.length > 0 && (
                    <div className="flex flex-col gap-1.5">
                      <button
                        onClick={() => setShowImplicit((open) => !open)}
                        title={showImplicit ? t("api.hideHiddenHeaders") : t("api.showHiddenHeaders")}
                        className="flex items-center gap-1 self-start text-[11px] text-[var(--cf-accent)]"
                      >
                        <ChevronRight
                          size={12}
                          className={`transition-transform ${showImplicit ? "rotate-90" : ""}`}
                        />
                        {t("api.hiddenHeaders", { n: implicitHeaders.length })}
                      </button>
                      {/* Read-only on purpose: these are supplied by the transport, and the
                          backend offers no way to suppress them — an editable row here would be a
                          control that quietly does nothing. */}
                      {showImplicit && (
                        <KeyValueTable rows={implicitHeaders} onChange={() => {}} readOnlyKeys />
                      )}
                    </div>
                  )}
                </div>
              )}

              {panel === "body" &&
                (protocol === "graphql" ? <GraphqlPanel tabId={tabId} /> : <BodyPanel tabId={tabId} />)}

              {panel === "pre" && <ScriptsPanel tabId={tabId} kind="pre" />}
              {panel === "tests" && <ScriptsPanel tabId={tabId} kind="post" />}
              {panel === "settings" && <RequestSettingsPanel tabId={tabId} />}

              {panel === "docs" && (
                <div className="h-full overflow-auto p-3">
                  <textarea
                    value={spec.description}
                    spellCheck={false}
                    placeholder={t("api.description")}
                    aria-label={t("api.description")}
                    onChange={(e) => update({ description: e.target.value })}
                    className="min-h-[200px] w-full resize-y rounded-md border border-[var(--cf-border)] bg-transparent p-2 text-[12px] leading-5 text-[var(--cf-text)] outline-none focus:border-[var(--cf-accent)]"
                  />
                </div>
              )}
            </div>
          </div>

          <ResizeHandle
            axis="y"
            value={responseHeight}
            min={MIN_RESPONSE_HEIGHT}
            max={MAX_RESPONSE_HEIGHT}
            invert
            onChange={(height) => setSize("apiResponseHeight", height)}
            onCommit={(height) => commitSize("apiResponseHeight", height)}
          />
          {/* `height` is the size the user dragged the handle to, but it can't be honoured
              unconditionally: the builder's own height changes underneath it whenever something
              else claims vertical space (opening the terminal dock is the easy way to see it).
              Without the cap the response keeps its pixel height, the request area above is
              squeezed to nothing, and the two end up painted over each other. Reserving room for
              the request area instead means the response gives way first — and the stored height
              comes back untouched as soon as there's room for it again. */}
          <div
            style={{ height: responseHeight, maxHeight: "calc(100% - 120px)" }}
            className="min-h-0 shrink-0"
          >
            <ResponsePanel tabId={tabId} />
          </div>
        </>
      )}
    </div>
  );
}
