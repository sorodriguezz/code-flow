import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Code2,
  Download,
  FileQuestion,
  Loader2,
  Save,
  Send,
  ShieldAlert,
  X,
} from "lucide-react";
import { Select } from "../common/Select";
import { ResizeHandle } from "../common/ResizeHandle";
import { Tooltip } from "../common/Tooltip";
import { ActiveUnderline } from "../common/ActivePill";
import { Kbd, buttonClass, iconButtonClass } from "../common/Button";
import {
  chipClass,
  menuItemClass,
  popoverClass,
  tabCountClass,
  underlineTabClass,
} from "../common/recipes";
import { useShortcutChord } from "../../lib/useShortcutHint";
import { scrollEdgeMask, useScrollEdges } from "../../lib/useScrollEdges";
import { ensureSnippetPanelLoaded, useSnippetPanelStore } from "./snippetPanelState";
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
import { DEFAULT_TAB_VIEW, useApiRuntimeStore } from "../../state/apiRuntimeStore";
import { useLayoutStore } from "../../state/layoutStore";
import { useT } from "../../state/languageStore";
import { pushErrorToast, useToastStore } from "../../state/toastStore";
import { API_PROTOCOLS, emptyKeyValue, HTTP_METHODS, STREAMING_PROTOCOLS } from "../../types/api";
import type {
  ApiCollection,
  ApiFolder,
  ApiPanelId as PanelId,
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


const MIN_RESPONSE_HEIGHT = 140;
const MAX_RESPONSE_HEIGHT = 900;
const IMPLICIT_HEADER_DEBOUNCE_MS = 250;
/** How much of a body the history snapshot keeps. */
const HISTORY_BODY_LIMIT = 200_000;

/** The URL field wears the text-field recipe (`fieldClass`): the field fill, its hairline, and the
 *  accent edge with a soft halo while the caret is in it. Spelled out rather than imported because
 *  the box is `VariableInput`'s wrapper, not the `<input>` — so the ring answers `focus-within`. */
const INPUT_SHELL =
  "rounded-md border border-[var(--cf-field-border)] bg-[var(--cf-field)] transition-[border-color,box-shadow] duration-100 focus-within:border-[var(--cf-accent)] focus-within:shadow-[0_0_0_3px_color-mix(in_oklab,var(--cf-accent)_20%,transparent)]";

/** The in-panel heading ("QUERY PARAMETERS"): the app's section label, set in a panel's own inset. */
const PANE_TITLE = "text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]";

/**
 * The verb's own colour as a tinted field — wash, ink and a ring out of one hue — so the method reads
 * as the first word of the URL rather than as a separate control beside it. Inline because the hue
 * is data (`badgeColor`), and it must be the *same* hue the tab strip and the tree give that verb.
 */
function methodTint(color: string): React.CSSProperties {
  return {
    color,
    backgroundColor: `color-mix(in oklab, ${color} 12%, var(--cf-field))`,
    borderColor: `color-mix(in oklab, ${color} 35%, transparent)`,
  };
}

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
  const chord = useShortcutChord();
  // The code-snippet panel's switch lives here, beside Save; the panel itself is `ApiView`'s right
  // column. Both read the one remembered flag.
  const snippetOpen = useSnippetPanelStore((s) => s.open);
  const setSnippetOpen = useSnippetPanelStore((s) => s.setOpen);
  useEffect(() => ensureSnippetPanelLoaded(), []);

  /**
   * Which sub-panel this *tab* is on, and whether its hidden-header list is unfolded.
   *
   * In the runtime store rather than in a `useState` here, because this component is mounted once
   * for every tab (`ApiView.tsx` renders it with no key, deliberately — a key would remount Monaco
   * and throw away the undo stacks). A local `useState` was therefore one panel selector shared by
   * every open request: leaving one tab on Body put every other tab on Body too, and coming back
   * to a tab had forgotten where it was. Read as scalars so a click in one tab doesn't re-render
   * every subscriber of the record.
   */
  const panel = useApiRuntimeStore((s) => s.tabView[tabId]?.panel ?? DEFAULT_TAB_VIEW.panel);
  const showImplicit = useApiRuntimeStore(
    (s) => s.tabView[tabId]?.showImplicit ?? DEFAULT_TAB_VIEW.showImplicit,
  );
  const setTabView = useApiRuntimeStore((s) => s.setTabView);
  const setPanel = (next: PanelId) => setTabView(tabId, { panel: next });

  const [menuOpen, setMenuOpen] = useState(false);
  const [savePicker, setSavePicker] = useState<{ collectionId: string; folderId: string } | null>(null);
  const [protocolMenu, setProtocolMenu] = useState(false);
  const [implicitHeaders, setImplicitHeaders] = useState<KeyValue[]>([]);
  const menuRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<TabActions>({ save: () => {}, send: () => {} });

  /**
   * The three popovers, closed on the way *out* of a tab rather than remembered.
   *
   * They are the other half of the one-instance-for-every-tab problem, and they want the opposite
   * treatment from `panel`: a popover belongs to the tab it was opened over. Without this, the save
   * picker opened on tab A stays on screen over tab B — and `saveToTarget` calls `saveTab(tabId)`
   * with whatever tab is current, so it files B into the collection chosen for A.
   *
   * Adjusted during render, not in an effect: an effect runs after paint, which leaves exactly one
   * frame in which the wrong-tab popover is on screen and clickable.
   */
  const [popoverTab, setPopoverTab] = useState(tabId);
  if (popoverTab !== tabId) {
    setPopoverTab(tabId);
    setSavePicker(null);
    setMenuOpen(false);
    setProtocolMenu(false);
  }

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
    runtime.setSendTrack(tabId, trackId);
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
      const runtimeNow = useApiRuntimeStore.getState();
      runtimeNow.setSending(tabId, false);
      // Only disarm the slot if it is still *this* send's. Without the guard, a send that finishes
      // after the user has already started another one on the same tab would leave Cancel with
      // nothing to fire at.
      if (runtimeNow.sendTracks[tabId] === trackId) runtimeNow.setSendTrack(tabId, null);
    }
  };

  // Read from the store rather than from a ref: the ref was a single slot shared by every tab, so
  // sending in A and then in B left Cancel on A aborting B's request — or doing nothing at all,
  // if B had already finished and cleared the slot.
  const cancelSend = () => {
    const trackId = useApiRuntimeStore.getState().sendTracks[tabId];
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
  // The section tabs only exist on the HTTP/GraphQL branch below, so that is when to watch them.
  const sectionTabsRef = useRef<HTMLDivElement>(null);
  const sectionTabsMask = scrollEdgeMask(useScrollEdges(sectionTabsRef, !isStreaming && !isGrpc, "x"), 24, "x");
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
    <div data-tour="api-builder" className="flex h-full min-h-0 flex-col">
      {/* Only ever shown for a tab with unsaved edits: a clean tab has already taken the incoming
          version, silently and correctly, because it had nothing of its own to lose. */}
      {tab.staleAgainst !== undefined && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--cf-border)] bg-[color-mix(in_oklab,var(--cf-warning)_12%,transparent)] py-1.5 pl-3.5 pr-3">
          <ShieldAlert size={14} className="shrink-0 text-[var(--cf-warning)]" />
          <span className="min-w-0 flex-1 text-[12px] text-[var(--cf-text)]">
            {t("api.stale.message")}
          </span>
          <button
            type="button"
            onClick={() => useApiStore.getState().takeRemoteVersion(tab.id)}
            className={buttonClass({ variant: "ghost", size: "sm" })}
          >
            {t("api.stale.takeTheirs")}
          </button>
          <button
            type="button"
            onClick={() => useApiStore.getState().keepLocalVersion(tab.id)}
            className={buttonClass({ variant: "primary", size: "sm" })}
          >
            {t("api.stale.keepMine")}
          </button>
        </div>
      )}

      {/* ---------- name row ---------- */}
      {/* Reads as one line — what kind of request, where it lives, what it's called — with only
          the last part editable. The protocol leads because it's the thing that decides what
          everything below the row even means. No rule under it: the name, the URL bar and the
          section tabs are one header, and the tabs' hairline is where the request's body starts. */}
      <div className="flex h-[46px] shrink-0 items-center gap-2 pl-3 pr-3">
        <div className="relative shrink-0">
          {/* Locked once the request has a row of its own: the protocol shapes the whole request —
              a body, a subscription, a service call — so changing it on something already saved is
              less "adjust a setting" than "replace this with a different request". While it's
              still a scratch tab there's nothing to betray, so it stays editable. */}
          {protocolLocked ? (
            <Tooltip label={PROTOCOL_NAMES[spec.protocol]} description={t("api.protocolLocked")} side="bottom">
              <span
                role="img"
                aria-label={`${PROTOCOL_NAMES[spec.protocol]} — ${t("api.protocolLocked")}`}
                className="flex h-7 w-7 items-center justify-center rounded-md"
              >
                <ProtocolIcon size={16} style={{ color: badgeColor(spec.protocol, "") }} />
              </span>
            </Tooltip>
          ) : (
            <Tooltip label={t("api.changeProtocol")} side="bottom">
              <button
                type="button"
                onClick={() => setProtocolMenu((open) => !open)}
                aria-label={t("api.changeProtocol")}
                aria-haspopup="menu"
                aria-expanded={protocolMenu}
                className={iconButtonClass({ size: "md", active: protocolMenu })}
              >
                <ProtocolIcon size={16} style={{ color: badgeColor(spec.protocol, "") }} />
              </button>
            </Tooltip>
          )}

          {protocolMenu && !protocolLocked && (
            <>
              {/* Full-viewport catcher, so the click that dismisses doesn't also press whatever
                  is underneath it. */}
              <div className="fixed inset-0 z-[9998]" onMouseDown={() => setProtocolMenu(false)} />
              <div role="menu" className={`absolute left-0 top-full z-[9999] mt-1 w-[200px] ${popoverClass}`}>
                {API_PROTOCOLS.map((id) => {
                  const Icon = protocolIcon(id);
                  const current = id === spec.protocol;
                  return (
                    <button
                      key={id}
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setProtocolMenu(false);
                        if (id !== spec.protocol) update(switchProtocol(spec, id));
                      }}
                      className={menuItemClass(current, current ? "font-medium" : "")}
                    >
                      <Icon size={15} className="shrink-0" style={{ color: badgeColor(id, "") }} />
                      <span className="min-w-0 flex-1 truncate">{PROTOCOL_NAMES[id]}</span>
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>

        {/* A request that lives nowhere yet, said rather than left blank.
            This slot holds the trail to the collection, and a scratch tab has none — so it used to
            render as empty space, which reads the same as a request whose path simply did not fit.
            The two are very different: one is filed and one will be lost when the tab closes. It is
            a button because saying so is only half the job; the other half is the way out, and this
            is the same picker ⌘S opens. */}
        {crumbs.length === 0 && (
          <Tooltip label={t("api.scratchBadge")} description={t("api.scratchHint")} side="bottom">
            <button
              type="button"
              onClick={() => {
                const first = collections[0];
                setSavePicker({ collectionId: first?.id ?? "", folderId: "" });
              }}
              className={chipClass(
                "warn",
                "transition-colors hover:bg-[color-mix(in_oklab,var(--cf-warning)_24%,transparent)]",
              )}
            >
              <FileQuestion size={12} className="shrink-0" />
              {t("api.scratchBadge")}
              <ChevronRight size={12} className="-mr-0.5 shrink-0 opacity-60" />
            </button>
          </Tooltip>
        )}

        {/* The path, then the name as its last segment — the same trail the explorer shows, with
            the one part you're allowed to change sitting where it actually belongs. */}
        {crumbs.map((crumb, index) => (
          <span
            key={`${crumb}-${index}`}
            className="flex min-w-0 shrink items-center gap-1.5 text-[12px] text-[var(--cf-text-muted)]"
          >
            <span className="truncate">{crumb}</span>
            <ChevronRight size={12} className="shrink-0 text-[var(--cf-text-faint)]" />
          </span>
        ))}
        <input
          type="text"
          value={tab.name}
          spellCheck={false}
          placeholder={t("api.untitledRequest")}
          aria-label={t("api.untitledRequest")}
          onChange={(e) => useApiStore.getState().renameTab(tabId, e.target.value)}
          className="h-7 min-w-[80px] flex-1 rounded-md bg-transparent px-1.5 text-[14px] font-semibold text-[var(--cf-text)] outline-none transition-[background-color,box-shadow] duration-100 placeholder:font-normal placeholder:text-[var(--cf-text-faint)] hover:bg-[var(--cf-hover)] focus:bg-[var(--cf-field)] focus:shadow-[inset_0_0_0_1px_var(--cf-accent)]"
        />
        {tab.dirty && (
          <span className="shrink-0 text-[12px] text-[var(--cf-text-faint)]">{t("api.unsaved")}</span>
        )}
        <div className="relative shrink-0">
          {/* Live only when there's something to save. A button that looks the same whether or
              not it would do anything makes "is my work in?" a question you have to answer some
              other way — here the button itself is the answer, and the "unsaved" tag beside it
              says the same thing twice on purpose. The span is what the tooltip hangs on: a
              disabled button takes no pointer events, and "no changes to save" is exactly the
              line worth reading on the disabled one. */}
          <Tooltip
            label={t("api.save")}
            description={tab.dirty ? undefined : t("api.noChangesToSave")}
            trailing={chord("editor.save") ? <Kbd>{chord("editor.save")}</Kbd> : undefined}
            side="bottom"
          >
            <span className="inline-flex">
              <button
                type="button"
                onClick={() => void save()}
                disabled={!tab.dirty}
                className={buttonClass({ variant: "secondary", size: "md" })}
              >
                <Save size={14} />
                {t("api.save")}
              </button>
            </span>
          </Tooltip>

          {savePicker && (
            <div className="absolute right-0 top-full z-50 mt-1 w-[320px] rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-3 shadow-[var(--cf-shadow)]">
              <p className={`mb-2.5 ${PANE_TITLE}`}>{t("api.saveTo")}</p>
              {collections.length === 0 ? (
                <p className="text-[12px] text-[var(--cf-text-muted)]">{t("api.noCollections")}</p>
              ) : (
                <div className="flex flex-col gap-2.5">
                  <label className="flex flex-col gap-1">
                    <span className="text-[12px] text-[var(--cf-text-muted)]">{t("api.scope.collection")}</span>
                    <Select
                      size="compact"
                      value={savePicker.collectionId}
                      onChange={(value) => setSavePicker({ collectionId: value, folderId: "" })}
                      options={collections.map((item) => ({ value: item.id, label: item.name }))}
                      ariaLabel={t("api.scope.collection")}
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-[12px] text-[var(--cf-text-muted)]">{t("api.folder")}</span>
                    <Select
                      size="compact"
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
              <div className="mt-3 flex justify-end gap-1.5">
                <button
                  type="button"
                  onClick={() => setSavePicker(null)}
                  className={buttonClass({ variant: "ghost", size: "sm" })}
                >
                  {t("common.cancel")}
                </button>
                <button
                  type="button"
                  onClick={() => void saveToTarget()}
                  disabled={collections.length === 0}
                  className={buttonClass({ variant: "primary", size: "sm" })}
                >
                  {t("api.save")}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ---------- URL bar ---------- */}
      {/* Method, URL and Send as one line, all three 32px: the verb in its own colour, the address
          in the monospace every other path in the app is set in, and the action at the end. */}
      <div className="shrink-0 px-3.5 pb-2.5">
        <div className="flex h-8 items-stretch gap-2">
          {protocol === "http" ? (
            <div className="w-[104px] shrink-0">
              <Select
                size="field"
                value={spec.method}
                onChange={(method) => update({ method })}
                options={HTTP_METHODS.map((method) => ({ value: method, label: method }))}
                ariaLabel={t("api.method")}
                className="font-mono font-bold"
                // Inline because the hue is the verb's own (`badgeColor`) and `Select` paints its
                // trigger in the field colours. `height` rather than a size class: the row is 32px
                // and `items-stretch`, so the trigger takes whatever the URL field beside it is.
                style={{ ...methodTint(badgeColor(protocol, spec.method)), height: "100%" }}
              />
            </div>
          ) : (
            <span
              className="flex shrink-0 items-center rounded-md border px-2.5 font-mono text-[12px] font-bold"
              style={methodTint(badgeColor(protocol, spec.method))}
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
            // 20px of line plus 5px either side inside the 1px hairlines: the 32px the row is.
            fieldClassName="px-2.5 py-[5px] font-mono text-[12px]"
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
                  type="button"
                  onClick={cancelSend}
                  className={buttonClass({
                    variant: "secondary",
                    size: "lg",
                    className: "hover:text-[var(--cf-danger)]",
                  })}
                >
                  <X size={14} />
                  {t("api.cancel")}
                </button>
              ) : (
                <>
                  {/* One split button: Send, and a caret for the variant that also saves the body to
                      a file. The seam between them is a line of the ink colour at a quarter, so it
                      reads on every accent in both themes. */}
                  <Tooltip
                    label={t("api.send")}
                    trailing={chord("api.send") ? <Kbd>{chord("api.send")}</Kbd> : undefined}
                    side="bottom"
                  >
                    <button
                      type="button"
                      onClick={() => void runSend(false)}
                      disabled={spec.url.trim() === ""}
                      className={buttonClass({ variant: "primary", size: "lg", className: "rounded-r-none" })}
                    >
                      <Send size={14} />
                      {t("api.send")}
                    </button>
                  </Tooltip>
                  <Tooltip label={t("api.sendAndDownload")} side="bottom">
                    <button
                      type="button"
                      onClick={() => setMenuOpen((open) => !open)}
                      aria-label={t("api.sendAndDownload")}
                      aria-haspopup="menu"
                      aria-expanded={menuOpen}
                      disabled={spec.url.trim() === ""}
                      className="inline-flex w-7 shrink-0 items-center justify-center rounded-r-md bg-[var(--cf-accent-fill)] text-[var(--cf-on-accent)] shadow-[inset_1px_0_0_color-mix(in_oklab,var(--cf-on-accent)_25%,transparent)] transition-colors duration-100 hover:bg-[color-mix(in_oklab,var(--cf-accent-fill)_86%,var(--cf-text))] disabled:pointer-events-none disabled:opacity-45"
                    >
                      <ChevronDown size={14} />
                    </button>
                  </Tooltip>
                </>
              )}

              {menuOpen && !sending && (
                <div role="menu" className={`absolute right-0 top-full z-50 mt-1 w-[220px] ${popoverClass}`}>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      void runSend(true);
                    }}
                    className={menuItemClass()}
                  >
                    <Download size={15} className="shrink-0 text-[var(--cf-text-muted)]" />
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
            {/* The request's sections: underlined tabs, the level below the request tabs above the
                builder and above the body's own format picker — one kind of control per level, so
                what depends on what reads off the shapes. A count says how many rows are on; a dot
                says the section holds something without a number to give. */}
            {/* `underlineStripClass` split in two: the frame (height, rule, padding) and, inside it, the
                part that scrolls. The code switch at the end has to stay outside the scroller — with
                the snippet panel open the builder narrows, and inside it the switch slid out of view
                exactly when its pressed state was the thing to see. */}
            <div className="flex h-9 shrink-0 items-stretch gap-3 border-b border-[var(--cf-border)] px-3.5">
              <div
                ref={sectionTabsRef}
                role="tablist"
                // Faded where more tabs continue past the edge, rather than cut mid-word against the
                // switch — the settings rail's cue (`scrollEdgeMask`), sideways.
                style={{ maskImage: sectionTabsMask, WebkitMaskImage: sectionTabsMask }}
                className="flex min-w-0 flex-1 items-stretch gap-4 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
              >
                {PANEL_ORDER.map((id) => {
                  const count = badgeCount(id);
                  const active = panel === id;
                  return (
                    <button
                      key={id}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      onClick={() => setPanel(id)}
                      className={underlineTabClass(active)}
                    >
                      {panelLabel(id)}
                      {count !== null && <span className={tabCountClass}>{count}</span>}
                      {count === null && badgeDot(id) && (
                        <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[var(--cf-success)]" />
                      )}
                      {active && <ActiveUnderline layoutId="cf-api-request-panel" />}
                    </button>
                  );
                })}
              </div>
              {/* The code snippet's switch, at the end of the sections: a view of the whole request,
                  where the HTTP clients this one follows put "Code". It sat in the name row between
                  "unsaved changes" and Save, where it read as part of the save status and looked out
                  of place (user report); before that it was a 36px rail down the right edge with its
                  title written sideways. Only in this row, so only for HTTP and GraphQL — the two
                  protocols the snippet can speak (`generateSnippet`); the panel has its own close
                  button for the rest. Pressed while open, and remembered (`snippetPanelState`). */}
              <Tooltip label={snippetOpen ? t("api.snippet.collapse") : t("api.snippet.expand")} side="bottom">
                <button
                  type="button"
                  onClick={() => setSnippetOpen(!snippetOpen)}
                  // The API tour's snippet step falls back to this switch when the panel is closed,
                  // which it is by default — the switch is what the step's words point at anyway.
                  data-tour="api-snippet-toggle"
                  aria-pressed={snippetOpen}
                  className={buttonClass({
                    variant: "ghost",
                    size: "sm",
                    className:
                      // `-mr-0.5` puts the button's box on the same right edge as Save and Send above it.
                      "-mr-0.5 shrink-0 self-center aria-pressed:bg-[var(--cf-accent-soft)] aria-pressed:text-[var(--cf-accent)]",
                  })}
                >
                  <Code2 size={13} />
                  {t("api.snippet.button")}
                </button>
              </Tooltip>
            </div>

            {/* No `overflow` here: every sibling panel roots at `h-full min-h-0` and owns its own
                scrolling (Monaco in particular must be measured, not scrolled by an ancestor), so
                the panels rendered inline below bring their own scroll container instead. */}
            <div className="min-h-0 flex-1">
              {panel === "params" && (
                <div className="flex h-full flex-col gap-4 overflow-auto px-3.5 py-3">
                  <section className="flex flex-col gap-2">
                    <h3 className={PANE_TITLE}>{t("api.queryParams")}</h3>
                    {/* Scoped by tab: `KeyValueTable` keeps the bulk-edit textarea, its snapshot of
                        the rows it was opened over, and a half-typed new row in local state. This
                        is the one place a React key is the right tool — that snapshot is only
                        meaningful for the rows it was taken from, so it can never travel to
                        another tab, and remounting is exactly the re-snapshot it would need. */}
                    <KeyValueTable
                      key={`${tabId}:params`}
                      rows={spec.params}
                      onChange={onParamsChange}
                      variableContext={variableContext}
                      allowBulkEdit
                    />
                  </section>
                  {spec.pathVars.length > 0 && (
                    <section className="flex flex-col gap-2">
                      <h3 className={PANE_TITLE}>{t("api.pathVariables")}</h3>
                      <KeyValueTable
                        key={`${tabId}:pathVars`}
                        rows={spec.pathVars}
                        onChange={(pathVars) => update({ pathVars })}
                        variableContext={variableContext}
                      />
                    </section>
                  )}
                </div>
              )}

              {/* Keyed, unlike the builder itself. `AuthPanel` holds nothing worth remembering — the auth
                  config lives in `spec.auth` — but its children hold reveal toggles, and a secret shown
                  in clear text on one tab must not arrive already revealed on the next. */}
              {panel === "auth" && <AuthPanel key={tabId} tabId={tabId} />}

              {panel === "headers" && (
                <div className="flex h-full flex-col gap-3 overflow-auto px-3.5 py-3">
                  <KeyValueTable
                    key={`${tabId}:headers`}
                    rows={spec.headers}
                    onChange={(headers) => update({ headers })}
                    variableContext={variableContext}
                    allowBulkEdit
                  />
                  {implicitHeaders.length > 0 && (
                    <div className="flex flex-col gap-1.5">
                      <Tooltip label={showImplicit ? t("api.hideHiddenHeaders") : t("api.showHiddenHeaders")}>
                        <button
                          type="button"
                          onClick={() => setTabView(tabId, { showImplicit: !showImplicit })}
                          aria-expanded={showImplicit}
                          className={buttonClass({ variant: "ghost", size: "sm", className: "-ml-2 self-start" })}
                        >
                          <ChevronRight
                            size={13}
                            className={`transition-transform ${showImplicit ? "rotate-90" : ""}`}
                          />
                          {t("api.hiddenHeaders", { n: implicitHeaders.length })}
                        </button>
                      </Tooltip>
                      {/* Read-only on purpose: these are supplied by the transport, and the
                          backend offers no way to suppress them — an editable row here would be a
                          control that quietly does nothing. */}
                      {showImplicit && (
                        <KeyValueTable key={`${tabId}:implicit`} rows={implicitHeaders} onChange={() => {}} readOnlyKeys />
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
                <div className="h-full overflow-auto px-3.5 py-3">
                  <textarea
                    value={spec.description}
                    spellCheck={false}
                    placeholder={t("api.description")}
                    aria-label={t("api.description")}
                    onChange={(e) => update({ description: e.target.value })}
                    className="min-h-[200px] w-full resize-y rounded-md border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-2.5 py-2 text-[13px] leading-5 text-[var(--cf-text)] outline-none transition-[border-color,box-shadow] duration-100 placeholder:text-[var(--cf-text-faint)] focus:border-[var(--cf-accent)] focus:shadow-[0_0_0_3px_color-mix(in_oklab,var(--cf-accent)_20%,transparent)]"
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
