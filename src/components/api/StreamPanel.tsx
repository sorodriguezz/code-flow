import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import Editor from "@monaco-editor/react";
// The only panel in `components/api` that renders an editor without also importing
// `OVERFLOW_SAFE_OPTIONS`, so it is the only one that has to ask for Monaco's setup by hand. See
// the note in `monacoSetup` — since `main.tsx` stopped importing it, a module that shows an editor
// and stays silent gets an unconfigured loader reaching for a CDN.
import "../../lib/monacoSetup";
import {
  AlertTriangle,
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Copy,
  Info,
  Loader2,
  Plug,
  Plus,
  Radio,
  Send,
  Settings2,
  Trash2,
  Unplug,
  X,
} from "lucide-react";
import { buttonClass, iconButtonClass } from "../common/Button";
import { Checkbox } from "../common/Checkbox";
import { CollapsibleSection } from "../common/CollapsibleSection";
import { chipClass, fieldClass, type ChipTone } from "../common/recipes";
import { Segmented } from "../common/Segmented";
import { Select } from "../common/Select";
import { Tooltip } from "../common/Tooltip";
import { useApiStore } from "../../state/apiStore";
import { DEFAULT_TAB_VIEW, useApiRuntimeStore } from "../../state/apiRuntimeStore";
import { useThemeStore } from "../../state/themeStore";
import { useT } from "../../state/languageStore";
import { pushErrorToast } from "../../state/toastStore";
import { resolveRequest } from "../../lib/api/send";
import {
  apiMqttConnect,
  apiMqttPublish,
  apiMqttSubscribe,
  apiMqttUnsubscribe,
  apiSocketioConnect,
  apiSocketioEmit,
  apiStreamDisconnect,
  apiWsConnect,
  apiWsSend,
} from "../../lib/tauri/apiCommands";
import type { MqttSubscription, StreamMessage } from "../../types/api";

/**
 * The workbench for the three long-lived protocols — WebSocket, Socket.IO and MQTT.
 *
 * They share the same shape (open a connection, watch a transcript, send something into it), so
 * they share one component and branch on the draft's protocol for the settings row and the
 * composer. Splitting them into three would have meant three copies of the transcript, which is
 * where all the actual difficulty lives.
 *
 * Nothing here is fetched: the connection lives in `apiRuntimeStore` keyed by tab id, frames
 * arrive on the `api:stream-message` event that the runtime store already subscribes to, and the
 * only outgoing calls are the IPC transports.
 */

type Translate = ReturnType<typeof useT>;

/** Frames actually rendered. `apiRuntimeStore` keeps 2000 per tab; a subscription to `#` would
 * otherwise put 2000 DOM subtrees on the page and make scrolling unusable. */
const RENDER_WINDOW = 300;
const BINARY_PREVIEW_BYTES = 512;
/** Payloads longer than this start collapsed, so one chatty frame can't own the whole viewport. */
const COLLAPSE_THRESHOLD = 140;
/** How close to the bottom still counts as "following the log". */
const STICK_TO_BOTTOM_PX = 24;

const NO_MESSAGES: StreamMessage[] = [];

/** The settings and composer fields: the 26px strip size, so they sit level with the `compact`
 * selects and the `sm` buttons that share their rows. */
const INPUT = fieldClass({ size: "sm", className: "w-full" });

/** A textarea in the same clothes as `INPUT` — `fieldClass` itself is a fixed-height single line. */
const TEXTAREA =
  "w-full resize-none rounded-md border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-2.5 py-1.5 font-mono text-[12px] text-[var(--cf-text)] outline-none transition-[border-color,box-shadow] duration-100 placeholder:text-[var(--cf-text-faint)] focus:border-[var(--cf-accent)] focus:shadow-[0_0_0_3px_color-mix(in_oklab,var(--cf-accent)_20%,transparent)]";

/** The small uppercase caption over a group — the transcript's, the composer's "Format". */
const CAPTION = "text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]";

export function StreamPanel({ tabId }: { tabId: string }) {
  const t = useT();
  const protocol = useApiStore((s) => s.openTabs.find((tab) => tab.id === tabId)?.draft.protocol);
  const url = useApiStore((s) => s.openTabs.find((tab) => tab.id === tabId)?.draft.url ?? "");
  const connection = useApiRuntimeStore((s) => s.connections[tabId] ?? null);
  const initRuntime = useApiRuntimeStore((s) => s.init);

  useEffect(() => {
    initRuntime();
  }, [initRuntime]);

  // The runtime store's `disposeTab` runs from `closeTab`, which also drops the socket. This is
  // the safety net for every other way a tab can stop existing (a deleted request detaches it,
  // a future bulk-close): once nothing addresses the connection, nobody can ever close it.
  useEffect(() => {
    return () => {
      const stillOpen = useApiStore.getState().openTabs.some((tab) => tab.id === tabId);
      if (stillOpen) return;
      const live = useApiRuntimeStore.getState().connections[tabId];
      if (!live) return;
      void apiStreamDisconnect(live.id).catch(() => {});
      useApiRuntimeStore.getState().closeConnection(tabId);
    };
  }, [tabId]);

  const status = connection?.status ?? "closed";
  const open = status === "open";

  // reqwest's MQTT transport speaks TCP only; a ws:// broker URL fails inside the backend with an
  // error the user can do nothing about, so the refusal happens here where it can be explained.
  const mqttOverWebsocket = protocol === "mqtt" && /^wss?:\/\//i.test(url.trim());

  const connect = useCallback(async () => {
    const store = useApiStore.getState();
    const tab = store.openTabs.find((x) => x.id === tabId);
    if (!tab) return;

    const runtime = useApiRuntimeStore.getState();
    const connectionId = `${tabId}:${Date.now().toString(36)}`;
    try {
      const resolved = await resolveRequest(
        tab.draft,
        store.variableContext(tab.collectionId),
        store.authChainForTab(tabId),
        store.settings,
        store.cookies,
      );
      // Registered before the invoke, not after: the backend can emit `connecting`/`error`
      // while the call is still in flight, and an event whose id maps to no tab is dropped.
      runtime.openConnection(tabId, connectionId);

      switch (tab.draft.protocol) {
        case "websocket": {
          const ws = tab.draft.websocket;
          await apiWsConnect(connectionId, {
            url: resolved.url,
            headers: resolved.headers,
            subprotocols: splitList(ws.subprotocols),
            ping_interval_ms: ws.pingIntervalMs,
            options: resolved.options,
          });
          break;
        }
        case "socketio": {
          const io = tab.draft.socketio;
          await apiSocketioConnect(connectionId, {
            url: resolved.url,
            path: io.path,
            namespace: io.namespace,
            version: io.version,
            headers: resolved.headers,
            auth_json: io.authJson.trim() || "{}",
            // Left empty on purpose: the Params table has already been folded into `resolved.url`
            // by `resolveRequest`, and the backend appends both to the same handshake query
            // string — passing them here as well would duplicate every parameter.
            query: [],
            options: resolved.options,
          });
          break;
        }
        case "mqtt": {
          const mqtt = tab.draft.mqtt;
          await apiMqttConnect(connectionId, {
            url: resolved.url,
            client_id: mqtt.clientId,
            username: mqtt.username,
            password: mqtt.password,
            keep_alive_secs: mqtt.keepAlive,
            clean_session: mqtt.cleanSession,
            version: mqtt.version,
            last_will: mqtt.lastWill.topic.trim()
              ? {
                  topic: mqtt.lastWill.topic,
                  payload: mqtt.lastWill.payload,
                  qos: mqtt.lastWill.qos,
                  retain: mqtt.lastWill.retain,
                }
              : null,
            subscriptions: mqtt.subscriptions
              .filter((row) => row.enabled && row.topic.trim() !== "")
              .map((row) => ({ topic: row.topic, qos: row.qos })),
            options: resolved.options,
          });
          break;
        }
        default:
          runtime.closeConnection(tabId);
          return;
      }
    } catch (e) {
      runtime.closeConnection(tabId);
      pushErrorToast(t("api.toast.connectFailed", { error: String(e) }));
    }
  }, [tabId, t]);

  const disconnect = useCallback(async () => {
    const live = useApiRuntimeStore.getState().connections[tabId];
    if (!live) return;
    try {
      await apiStreamDisconnect(live.id);
    } catch {
      // A socket the backend has already forgotten is still a socket that is closed.
    }
    useApiRuntimeStore.getState().closeConnection(tabId);
  }, [tabId]);

  if (protocol !== "websocket" && protocol !== "socketio" && protocol !== "mqtt") return <></>;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--cf-border)] px-3.5">
        <StatusChip status={status} t={t} />
        {connection?.detail && (
          <span className="min-w-0 truncate text-[12px] text-[var(--cf-text-muted)]" title={connection.detail}>
            {connection.detail}
          </span>
        )}
        <div className="flex-1" />
        {connection ? (
          <button onClick={() => void disconnect()} className={buttonClass({ variant: "secondary", size: "sm" })}>
            <Unplug size={13} />
            {t("api.disconnect")}
          </button>
        ) : (
          <button
            onClick={() => void connect()}
            disabled={mqttOverWebsocket || url.trim() === ""}
            className={buttonClass({ variant: "primary", size: "sm" })}
          >
            <Plug size={13} />
            {t("api.connect")}
          </button>
        )}
      </div>

      {mqttOverWebsocket && (
        <div className="flex shrink-0 items-start gap-2 border-b border-[var(--cf-border)] bg-[color-mix(in_oklab,var(--cf-warning)_12%,transparent)] px-3.5 py-2 text-[12px] text-[var(--cf-text)]">
          <AlertTriangle size={13} className="mt-px shrink-0 text-[var(--cf-warning)]" />
          {t("api.mqtt.wsUnsupported")}
        </div>
      )}

      <div className="shrink-0 border-b border-[var(--cf-border)] px-3.5 py-2">
        <CollapsibleSection icon={Settings2} title={t("api.tab.settings")} defaultOpen>
          {protocol === "websocket" && <WebsocketSettings tabId={tabId} locked={connection !== null} />}
          {protocol === "socketio" && <SocketIoSettings tabId={tabId} locked={connection !== null} />}
          {protocol === "mqtt" && <MqttSettings tabId={tabId} locked={connection !== null} />}
        </CollapsibleSection>
      </div>

      {protocol === "socketio" && (
        <div className="shrink-0 border-b border-[var(--cf-border)] px-3.5 py-2">
          <CollapsibleSection icon={Radio} title={t("api.socketio.listeners")} defaultOpen>
            <SocketIoListeners tabId={tabId} />
          </CollapsibleSection>
        </div>
      )}

      {protocol === "mqtt" && (
        <div className="shrink-0 border-b border-[var(--cf-border)] px-3.5 py-2">
          <CollapsibleSection icon={Radio} title={t("api.tab.subscriptions")} defaultOpen>
            <MqttSubscriptions tabId={tabId} connectionId={open ? (connection?.id ?? null) : null} />
          </CollapsibleSection>
        </div>
      )}

      <Transcript tabId={tabId} />

      <div className="shrink-0 border-t border-[var(--cf-border)] px-3.5 py-2.5">
        {protocol === "websocket" && <WebsocketComposer tabId={tabId} connectionId={open ? (connection?.id ?? null) : null} />}
        {protocol === "socketio" && <SocketIoComposer tabId={tabId} connectionId={open ? (connection?.id ?? null) : null} />}
        {protocol === "mqtt" && <MqttComposer tabId={tabId} connectionId={open ? (connection?.id ?? null) : null} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Connection bar
// ---------------------------------------------------------------------------

const STATUS_TONE: Record<"connecting" | "open" | "closed" | "error", ChipTone> = {
  open: "ok",
  connecting: "warn",
  error: "bad",
  closed: "neutral",
};

/**
 * The connection's state as a chip: the tone, a shape and the word, so no one of them has to
 * carry it alone. Open is a filled dot and closed a hollow one; connecting is the machine-work
 * spinner rather than a pulsing dot, and an error gets the same triangle the transcript uses.
 */
function StatusChip({ status, t }: { status: "connecting" | "open" | "closed" | "error"; t: Translate }) {
  return (
    <span className={chipClass(STATUS_TONE[status])}>
      {status === "connecting" ? (
        <Loader2 size={11} className="animate-spin" />
      ) : status === "error" ? (
        <AlertTriangle size={11} />
      ) : (
        <span
          aria-hidden
          className={`h-1.5 w-1.5 rounded-full ${status === "open" ? "bg-current" : "border border-current"}`}
        />
      )}
      {statusLabel(status, t)}
    </span>
  );
}

function statusLabel(status: "connecting" | "open" | "closed" | "error", t: Translate): string {
  switch (status) {
    case "connecting":
      return t("api.connecting");
    case "open":
      return t("api.connected");
    case "error":
      return t("api.ws.error");
    case "closed":
      return t("api.disconnected");
  }
}

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

function Transcript({ tabId }: { tabId: string }) {
  const t = useT();
  const messages = useApiRuntimeStore((s) => s.messages[tabId] ?? NO_MESSAGES);
  const clearMessages = useApiRuntimeStore((s) => s.clearMessages);
  const listeners = useApiStore(
    (s) => s.openTabs.find((tab) => tab.id === tabId)?.draft.socketio.listeners,
  );
  const isSocketIo = useApiStore(
    (s) => s.openTabs.find((tab) => tab.id === tabId)?.draft.protocol === "socketio",
  );

  /**
   * The transcript's filter and whether it is pinned to the newest frame — per request tab.
   *
   * `messages` beside them has always been keyed by tab; these two were not, so one `StreamPanel`
   * instance shared them across every open socket. Filtering one transcript filtered the others,
   * and scrolling back through one tab's history unpinned every other tab from its live tail.
   */
  const filter = useApiRuntimeStore(
    (s) => s.tabView[tabId]?.streamFilter ?? DEFAULT_TAB_VIEW.streamFilter,
  );
  const autoScroll = useApiRuntimeStore(
    (s) => s.tabView[tabId]?.streamAutoScroll ?? DEFAULT_TAB_VIEW.streamAutoScroll,
  );
  const setTabView = useApiRuntimeStore((s) => s.setTabView);
  const setAutoScroll = (next: boolean) => setTabView(tabId, { streamAutoScroll: next });
  const scrollRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    // The Socket.IO transport has no per-event subscribe call, so the listener list can only be
    // what it says on the label: what this transcript shows. `[]` means "everything".
    const wanted = isSocketIo && listeners && listeners.length > 0 ? new Set(listeners) : null;
    // The frame's position in the untrimmed transcript comes along as its React key: the store
    // only ever appends, so that index names one frame for as long as it exists, while a key
    // based on the position in the rendered window would move under a row every time the
    // window slides — taking its expanded/hex state with it.
    const kept: { message: StreamMessage; index: number }[] = [];
    messages.forEach((message, index) => {
      if (wanted && message.direction === "received" && !wanted.has(message.channel)) return;
      if (
        needle &&
        !message.channel.toLowerCase().includes(needle) &&
        !message.payload.toLowerCase().includes(needle)
      ) {
        return;
      }
      kept.push({ message, index });
    });
    return kept;
  }, [messages, filter, listeners, isSocketIo]);

  const visible = filtered.length > RENDER_WINDOW ? filtered.slice(-RENDER_WINDOW) : filtered;

  useEffect(() => {
    if (!autoScroll) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [visible.length, autoScroll]);

  // Position *is* the toggle: scrolling away turns following off, scrolling back turns it on.
  // Two independent notions of "am I following the log" would only ever disagree.
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const next = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_TO_BOTTOM_PX;
    // Guarded, and not optionally: this fires once per scroll frame, and every store write
    // allocates a fresh record that re-renders each subscriber. Only a real change is worth one.
    if (next !== autoScroll) setAutoScroll(next);
  };

  const jumpToLatest = () => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setAutoScroll(true);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--cf-border)] pl-3.5 pr-2">
        <span className={CAPTION}>{t("api.ws.messages")}</span>
        <input
          value={filter}
          onChange={(e) => setTabView(tabId, { streamFilter: e.target.value })}
          placeholder={t("api.ws.filterPlaceholder")}
          className={fieldClass({ size: "sm", className: "w-48" })}
        />
        <div className="flex-1" />
        <label className="flex cursor-pointer items-center gap-1.5 text-[12px] text-[var(--cf-text-muted)]">
          <Checkbox checked={autoScroll} onChange={(next) => (next ? jumpToLatest() : setAutoScroll(false))} />
          {t("api.ws.autoScroll")}
        </label>
        <Tooltip label={t("api.ws.clear")}>
          <button
            onClick={() => clearMessages(tabId)}
            aria-label={t("api.ws.clear")}
            className={iconButtonClass({ size: "sm" })}
          >
            <Trash2 size={14} />
          </button>
        </Tooltip>
      </div>

      {/* The log is a well in the sheet — sunken, monospaced — the way every other log in the app
          reads; the notice about the render window belongs to it, so it wears the same tone. */}
      {filtered.length > visible.length && (
        <div className="shrink-0 bg-[var(--cf-sunken)] px-3.5 pt-1.5 text-[11px] text-[var(--cf-text-faint)]">
          {t("api.ws.windowed", { shown: visible.length, total: filtered.length })}
        </div>
      )}

      <div className="relative min-h-0 flex-1 bg-[var(--cf-sunken)]">
        <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-y-auto px-1.5 py-1">
          {visible.length === 0 ? (
            <p className="px-2 py-6 text-center text-[12px] text-[var(--cf-text-faint)]">
              {messages.length === 0 ? t("api.ws.noMessages") : t("api.ws.noMatches")}
            </p>
          ) : (
            // Scoped by tab, because `entry.index` is a position within *this* tab's transcript:
            // tab A's frame #3 and tab B's frame #3 collided on the bare index, so the row's
            // expanded/hex state landed on an unrelated payload after a tab switch.
            visible.map((entry) => (
              <MessageRow key={`${tabId}:${entry.index}`} message={entry.message} t={t} />
            ))
          )}
        </div>

        {!autoScroll && visible.length > 0 && (
          <button
            onClick={jumpToLatest}
            className="absolute bottom-3 left-1/2 flex h-7 -translate-x-1/2 items-center gap-1.5 rounded-full border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] px-3 text-[12px] font-medium text-[var(--cf-text)] shadow-[var(--cf-shadow)] transition-colors duration-100 hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]"
          >
            <ArrowDownToLine size={13} />
            {t("api.ws.jumpToLatest")}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * One frame of the transcript.
 *
 * Memoised because every arriving frame re-renders `Transcript`, and without it that meant every
 * row in the 300-row window again — each one's Hex/Base64 switch included, which is a
 * `Segmented` whose sliding thumb is a framer-motion layout node that measures itself whenever it
 * renders. `message` objects are never rewritten by the store (it only appends and trims) and `t`
 * is stable per language, so a row now renders once, when it arrives, and again only for its own
 * toggles.
 */
const MessageRow = memo(function MessageRow({ message, t }: { message: StreamMessage; t: Translate }) {
  const rendered = useMemo(() => renderPayload(message), [message]);
  const [expanded, setExpanded] = useState(false);
  const [asHex, setAsHex] = useState(true);
  // One per row: the switch's thumb slides by `layoutId`, and two rows sharing one would send it
  // flying across the transcript.
  const encodingId = useId();

  const collapsible = rendered.kind === "binary" || rendered.text.length > COLLAPSE_THRESHOLD || rendered.text.includes("\n");
  const showFull = expanded || !collapsible;

  const body =
    rendered.kind === "binary"
      ? asHex
        ? rendered.hex
        : rendered.base64
      : showFull
        ? rendered.text
        : firstLine(rendered.text);

  return (
    <div className="group flex items-start gap-2 rounded-md px-2 py-1 hover:bg-[var(--cf-hover)]">
      <DirectionIcon direction={message.direction} t={t} />
      <span className="mt-px shrink-0 font-mono text-[11px] tabular-nums text-[var(--cf-text-faint)]">
        {formatTime(message.at)}
      </span>

      <div className="min-w-0 flex-1">
        {(message.channel || rendered.kind !== "text" || message.qos !== undefined) && (
          <div className="mb-0.5 flex flex-wrap items-center gap-1.5">
            {message.channel && <span className={chipClass("accent", "font-mono")}>{message.channel}</span>}
            {rendered.kind === "json" && <span className={chipClass("neutral")}>{t("api.ws.formatJson")}</span>}
            {rendered.kind === "binary" && (
              <>
                <span className={chipClass("neutral", "tabular-nums")}>{t("api.ws.bytes", { n: rendered.size })}</span>
                <Segmented
                  size="sm"
                  layoutId={`cf-api-stream-encoding-${encodingId}`}
                  value={asHex ? "hex" : "base64"}
                  onChange={(next) => setAsHex(next === "hex")}
                  options={[
                    { value: "hex", label: t("api.ws.hex") },
                    { value: "base64", label: t("api.ws.base64") },
                  ]}
                />
              </>
            )}
            {message.qos !== undefined && (
              <span className="text-[11px] text-[var(--cf-text-faint)]">
                {t("api.mqtt.qos")} {message.qos}
                {message.retain ? ` · ${t("api.mqtt.retain")}` : ""}
              </span>
            )}
          </div>
        )}

        {collapsible ? (
          <button
            onClick={() => setExpanded((v) => !v)}
            className="flex w-full items-start gap-1 text-left"
          >
            {expanded ? (
              <ChevronDown size={12} className="mt-[3px] shrink-0 text-[var(--cf-text-faint)]" />
            ) : (
              <ChevronRight size={12} className="mt-[3px] shrink-0 text-[var(--cf-text-faint)]" />
            )}
            <pre
              className={`min-w-0 flex-1 font-mono text-[12px] leading-[18px] text-[var(--cf-text)] ${
                showFull ? "whitespace-pre-wrap break-all" : "truncate"
              }`}
            >
              {body}
            </pre>
          </button>
        ) : (
          <pre className="whitespace-pre-wrap break-all font-mono text-[12px] leading-[18px] text-[var(--cf-text)]">
            {body}
          </pre>
        )}
      </div>

      <Tooltip label={t("api.ws.copyMessage")}>
        <button
          onClick={() => void navigator.clipboard.writeText(message.payload)}
          aria-label={t("api.ws.copyMessage")}
          className={iconButtonClass({
            size: "xs",
            className: "opacity-0 focus-visible:opacity-100 group-hover:opacity-100",
          })}
        >
          <Copy size={13} />
        </button>
      </Tooltip>
    </div>
  );
});

function DirectionIcon({ direction, t }: { direction: StreamMessage["direction"]; t: Translate }) {
  switch (direction) {
    case "sent":
      return <ArrowUp size={13} className="mt-[3px] shrink-0 text-[var(--cf-accent)]" aria-label={t("api.ws.sentAt")} />;
    case "received":
      return <ArrowDown size={13} className="mt-[3px] shrink-0 text-[var(--cf-success)]" aria-label={t("api.ws.receivedAt")} />;
    case "error":
      return <AlertTriangle size={13} className="mt-[3px] shrink-0 text-[var(--cf-danger)]" aria-label={t("api.ws.error")} />;
    case "system":
      return <Info size={13} className="mt-[3px] shrink-0 text-[var(--cf-text-muted)]" aria-label={t("api.ws.system")} />;
  }
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

function WebsocketSettings({ tabId, locked }: { tabId: string; locked: boolean }) {
  const t = useT();
  const settings = useApiStore((s) => s.openTabs.find((tab) => tab.id === tabId)?.draft.websocket);
  const updateDraft = useApiStore((s) => s.updateDraft);
  if (!settings) return <></>;

  return (
    <div className="grid grid-cols-2 gap-x-3 gap-y-2.5">
      <Field label={t("api.ws.subprotocols")}>
        <input
          value={settings.subprotocols}
          disabled={locked}
          onChange={(e) => updateDraft(tabId, { websocket: { ...settings, subprotocols: e.target.value } })}
          placeholder="graphql-ws, json"
          className={INPUT}
        />
      </Field>
      <Field label={t("api.ws.pingInterval")}>
        <input
          type="number"
          min={0}
          value={settings.pingIntervalMs}
          disabled={locked}
          onChange={(e) =>
            updateDraft(tabId, { websocket: { ...settings, pingIntervalMs: toInt(e.target.value, 0) } })
          }
          className={INPUT}
        />
      </Field>
    </div>
  );
}

function WebsocketComposer({ tabId, connectionId }: { tabId: string; connectionId: string | null }) {
  const t = useT();
  const settings = useApiStore((s) => s.openTabs.find((tab) => tab.id === tabId)?.draft.websocket);
  const updateDraft = useApiStore((s) => s.updateDraft);
  const appendMessage = useApiRuntimeStore((s) => s.appendMessage);
  const formatId = useId();
  if (!settings) return <></>;

  const jsonError = settings.messageFormat === "json" && !isJson(settings.draftMessage);

  const send = async () => {
    if (!connectionId) return;
    const binary = settings.messageFormat === "binary";
    try {
      await apiWsSend(connectionId, settings.draftMessage, binary);
      // The transports only report what arrives; without a local echo the log would show half
      // of the conversation.
      appendMessage(tabId, {
        connection_id: connectionId,
        direction: "sent",
        channel: "",
        payload: settings.draftMessage,
        binary,
        at: Date.now(),
      });
    } catch (e) {
      pushErrorToast(String(e));
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className={CAPTION}>{t("api.ws.format")}</span>
        {/* Three peer ways of sending the same draft — the segmented control, not a value list.
            Unique per instance: two sockets on screen must not trade one thumb. */}
        <Segmented
          size="sm"
          layoutId={`cf-api-stream-format-${formatId}`}
          ariaLabel={t("api.ws.format")}
          value={settings.messageFormat}
          onChange={(value) => updateDraft(tabId, { websocket: { ...settings, messageFormat: value } })}
          options={[
            { value: "text", label: t("api.ws.formatText") },
            { value: "json", label: t("api.ws.formatJson") },
            { value: "binary", label: t("api.ws.formatBinary") },
          ]}
        />
        {settings.messageFormat === "binary" && (
          <span className="min-w-0 truncate text-[12px] text-[var(--cf-text-muted)]">{t("api.ws.binaryHint")}</span>
        )}
        {jsonError && <InvalidJson t={t} />}
        <div className="flex-1" />
        <button
          onClick={() => void send()}
          disabled={!connectionId || jsonError}
          className={buttonClass({ variant: "primary", size: "sm" })}
        >
          <Send size={13} />
          {t("api.ws.send")}
        </button>
      </div>

      {settings.messageFormat === "json" ? (
        <JsonEditor
          value={settings.draftMessage}
          onChange={(value) => updateDraft(tabId, { websocket: { ...settings, draftMessage: value } })}
        />
      ) : (
        <textarea
          value={settings.draftMessage}
          onChange={(e) => updateDraft(tabId, { websocket: { ...settings, draftMessage: e.target.value } })}
          placeholder={t("api.ws.composePlaceholder")}
          rows={3}
          className={TEXTAREA}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Socket.IO
// ---------------------------------------------------------------------------

function SocketIoSettings({ tabId, locked }: { tabId: string; locked: boolean }) {
  const t = useT();
  const settings = useApiStore((s) => s.openTabs.find((tab) => tab.id === tabId)?.draft.socketio);
  const updateDraft = useApiStore((s) => s.updateDraft);
  if (!settings) return <></>;

  return (
    <div className="grid grid-cols-3 gap-x-3 gap-y-2.5">
      <Field label={t("api.socketio.path")}>
        <input
          value={settings.path}
          disabled={locked}
          onChange={(e) => updateDraft(tabId, { socketio: { ...settings, path: e.target.value } })}
          className={INPUT}
        />
      </Field>
      <Field label={t("api.socketio.namespace")}>
        <input
          value={settings.namespace}
          disabled={locked}
          onChange={(e) => updateDraft(tabId, { socketio: { ...settings, namespace: e.target.value } })}
          className={INPUT}
        />
      </Field>
      <Field label={t("api.socketio.version")}>
        <Select
          size="compact"
          disabled={locked}
          value={settings.version}
          onChange={(value) =>
            updateDraft(tabId, { socketio: { ...settings, version: value as typeof settings.version } })
          }
          options={[
            { value: "v4", label: "v4 · Socket.IO 3 / 4" },
            { value: "v3", label: "v3 · Socket.IO 2" },
          ]}
        />
      </Field>
      <div className="col-span-3">
        <Field label={t("api.socketio.handshakeAuth")}>
          {/* Marked through `aria-invalid` rather than a second border colour on the class list: two
              `border-*` utilities on one element are settled by stylesheet order, not by which was
              written last, and the variant is what wins over the field's own border reliably. */}
          <input
            value={settings.authJson}
            disabled={locked}
            onChange={(e) => updateDraft(tabId, { socketio: { ...settings, authJson: e.target.value } })}
            placeholder='{"token":"{{authToken}}"}'
            aria-invalid={!isJson(settings.authJson)}
            className={`${INPUT} font-mono aria-[invalid=true]:border-[var(--cf-danger)]`}
          />
        </Field>
      </div>
    </div>
  );
}

function SocketIoListeners({ tabId }: { tabId: string }) {
  const t = useT();
  const settings = useApiStore((s) => s.openTabs.find((tab) => tab.id === tabId)?.draft.socketio);
  const updateDraft = useApiStore((s) => s.updateDraft);
  const [draftName, setDraftName] = useState("");
  if (!settings) return <></>;

  const setListeners = (listeners: string[]) => updateDraft(tabId, { socketio: { ...settings, listeners } });

  const add = () => {
    const name = draftName.trim();
    if (!name || settings.listeners.includes(name)) return;
    setListeners([...settings.listeners, name]);
    setDraftName("");
  };

  return (
    <div className="space-y-2">
      {settings.listeners.length === 0 ? (
        <p className="text-[12px] text-[var(--cf-text-muted)]">{t("api.socketio.listenAll")}</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {settings.listeners.map((name) => (
            // An accent chip with its remove button as the chip's own right end: at `chipClass`'s
            // 20px there is no room for a 22px target, so this one is written out at 24px, in the
            // same tone.
            <span
              key={name}
              className="inline-flex h-6 items-center rounded-md bg-[var(--cf-accent-soft)] pl-2 font-mono text-[12px] text-[var(--cf-accent)] shadow-[inset_0_0_0_1px_var(--cf-accent-line)]"
            >
              {name}
              <Tooltip label={t("api.socketio.removeListener")}>
                <button
                  onClick={() => setListeners(settings.listeners.filter((other) => other !== name))}
                  aria-label={t("api.socketio.removeListener")}
                  className="ml-0.5 inline-flex h-6 w-[22px] items-center justify-center rounded-r-md transition-colors duration-100 hover:bg-[var(--cf-hover)] hover:text-[var(--cf-danger)]"
                >
                  <X size={12} />
                </button>
              </Tooltip>
            </span>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2">
        <input
          value={draftName}
          onChange={(e) => setDraftName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
          }}
          placeholder={t("api.socketio.event")}
          className={`${INPUT} font-mono`}
        />
        <button onClick={add} className={buttonClass({ variant: "secondary", size: "sm" })}>
          <Plus size={13} />
          {t("api.socketio.addListener")}
        </button>
      </div>
      <p className="text-[11px] leading-snug text-[var(--cf-text-faint)]">{t("api.socketio.listenerHint")}</p>
    </div>
  );
}

function SocketIoComposer({ tabId, connectionId }: { tabId: string; connectionId: string | null }) {
  const t = useT();
  const settings = useApiStore((s) => s.openTabs.find((tab) => tab.id === tabId)?.draft.socketio);
  const updateDraft = useApiStore((s) => s.updateDraft);
  const appendMessage = useApiRuntimeStore((s) => s.appendMessage);
  if (!settings) return <></>;

  const jsonError = !isJson(settings.draftPayload);

  const emit = async () => {
    if (!connectionId) return;
    try {
      await apiSocketioEmit(connectionId, settings.draftEvent, settings.draftPayload);
      appendMessage(tabId, {
        connection_id: connectionId,
        direction: "sent",
        channel: settings.draftEvent,
        payload: settings.draftPayload,
        binary: false,
        at: Date.now(),
      });
    } catch (e) {
      pushErrorToast(String(e));
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <input
          value={settings.draftEvent}
          onChange={(e) => updateDraft(tabId, { socketio: { ...settings, draftEvent: e.target.value } })}
          placeholder={t("api.socketio.event")}
          className={fieldClass({ size: "sm", className: "w-48 font-mono" })}
        />
        {jsonError && <InvalidJson t={t} />}
        <div className="flex-1" />
        <button
          onClick={() => void emit()}
          disabled={!connectionId || jsonError || settings.draftEvent.trim() === ""}
          className={buttonClass({ variant: "primary", size: "sm" })}
        >
          <Send size={13} />
          {t("api.socketio.emit")}
        </button>
      </div>
      <JsonEditor
        value={settings.draftPayload}
        onChange={(value) => updateDraft(tabId, { socketio: { ...settings, draftPayload: value } })}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// MQTT
// ---------------------------------------------------------------------------

const QOS_OPTIONS = [
  { value: "0", label: "0" },
  { value: "1", label: "1" },
  { value: "2", label: "2" },
];

function toQos(value: string): 0 | 1 | 2 {
  return value === "1" ? 1 : value === "2" ? 2 : 0;
}

function MqttSettings({ tabId, locked }: { tabId: string; locked: boolean }) {
  const t = useT();
  const settings = useApiStore((s) => s.openTabs.find((tab) => tab.id === tabId)?.draft.mqtt);
  const updateDraft = useApiStore((s) => s.updateDraft);
  if (!settings) return <></>;

  const patch = (next: Partial<typeof settings>) => updateDraft(tabId, { mqtt: { ...settings, ...next } });

  return (
    <div className="space-y-2.5">
      <div className="grid grid-cols-4 gap-x-3 gap-y-2.5">
        <Field label={t("api.mqtt.clientId")}>
          <input
            value={settings.clientId}
            disabled={locked}
            onChange={(e) => patch({ clientId: e.target.value })}
            className={`${INPUT} font-mono`}
          />
        </Field>
        <Field label={t("api.mqtt.keepAlive")}>
          <input
            type="number"
            min={0}
            value={settings.keepAlive}
            disabled={locked}
            onChange={(e) => patch({ keepAlive: toInt(e.target.value, 60) })}
            className={INPUT}
          />
        </Field>
        <Field label={t("api.mqtt.version")}>
          <Select
            size="compact"
            disabled={locked}
            value={settings.version}
            onChange={(value) => patch({ version: value as typeof settings.version })}
            options={[
              { value: "3.1.1", label: "3.1.1" },
              { value: "5.0", label: "5.0" },
            ]}
          />
        </Field>
        <div className="flex items-end">
          <label className="flex h-[26px] cursor-pointer items-center gap-1.5 text-[12px] text-[var(--cf-text)]">
            <Checkbox
              checked={settings.cleanSession}
              disabled={locked}
              onChange={(checked) => patch({ cleanSession: checked })}
            />
            {t("api.mqtt.cleanSession")}
          </label>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-x-3 gap-y-2.5">
        <Field label={t("api.auth.username")}>
          <input
            value={settings.username}
            disabled={locked}
            onChange={(e) => patch({ username: e.target.value })}
            className={INPUT}
          />
        </Field>
        <Field label={t("api.auth.password")}>
          <input
            type="password"
            value={settings.password}
            disabled={locked}
            onChange={(e) => patch({ password: e.target.value })}
            className={INPUT}
          />
        </Field>
      </div>

      {/* A group of fields rather than a field, so its heading is a step above their captions —
          sentence case and full text colour — with a hairline to say where the group starts. */}
      <div className="border-t border-[var(--cf-border)] pt-2.5">
        <p className="mb-2 text-[12px] font-semibold text-[var(--cf-text)]">{t("api.mqtt.lastWill")}</p>
        <div className="grid grid-cols-4 gap-x-3 gap-y-2.5">
          <Field label={t("api.mqtt.topic")}>
            <input
              value={settings.lastWill.topic}
              disabled={locked}
              onChange={(e) => patch({ lastWill: { ...settings.lastWill, topic: e.target.value } })}
              className={`${INPUT} font-mono`}
            />
          </Field>
          <div className="col-span-2">
            <Field label={t("api.mqtt.payload")}>
              <input
                value={settings.lastWill.payload}
                disabled={locked}
                onChange={(e) => patch({ lastWill: { ...settings.lastWill, payload: e.target.value } })}
                className={`${INPUT} font-mono`}
              />
            </Field>
          </div>
          <div className="flex items-end gap-3">
            <Field label={t("api.mqtt.qos")}>
              <Select
                size="compact"
                disabled={locked}
                value={String(settings.lastWill.qos)}
                onChange={(value) => patch({ lastWill: { ...settings.lastWill, qos: toQos(value) } })}
                options={QOS_OPTIONS}
              />
            </Field>
            <label className="flex h-[26px] cursor-pointer items-center gap-1.5 text-[12px] text-[var(--cf-text)]">
              <Checkbox
                checked={settings.lastWill.retain}
                disabled={locked}
                onChange={(checked) => patch({ lastWill: { ...settings.lastWill, retain: checked } })}
              />
              {t("api.mqtt.retain")}
            </label>
          </div>
        </div>
      </div>
    </div>
  );
}

function MqttSubscriptions({ tabId, connectionId }: { tabId: string; connectionId: string | null }) {
  const t = useT();
  const settings = useApiStore((s) => s.openTabs.find((tab) => tab.id === tabId)?.draft.mqtt);
  const updateDraft = useApiStore((s) => s.updateDraft);
  if (!settings) return <></>;

  const setRows = (subscriptions: MqttSubscription[]) =>
    updateDraft(tabId, { mqtt: { ...settings, subscriptions } });

  const patchRow = (id: string, next: Partial<MqttSubscription>) =>
    setRows(settings.subscriptions.map((row) => (row.id === id ? { ...row, ...next } : row)));

  /** Toggling a row while connected has to reach the broker too — the checkbox is the
   * subscription, not a note about one. */
  const applyEnabled = async (row: MqttSubscription, enabled: boolean) => {
    patchRow(row.id, { enabled });
    if (!connectionId || row.topic.trim() === "") return;
    try {
      if (enabled) await apiMqttSubscribe(connectionId, row.topic, row.qos);
      else await apiMqttUnsubscribe(connectionId, row.topic);
    } catch (e) {
      pushErrorToast(String(e));
    }
  };

  return (
    <div className="space-y-1.5">
      {settings.subscriptions.length === 0 && (
        <p className="text-[12px] text-[var(--cf-text-muted)]">{t("api.mqtt.noSubscriptions")}</p>
      )}

      {settings.subscriptions.map((row) => (
        <div key={row.id} className="flex items-center gap-2">
          <Checkbox checked={row.enabled} onChange={(checked) => void applyEnabled(row, checked)} />
          <input
            value={row.topic}
            onChange={(e) => patchRow(row.id, { topic: e.target.value })}
            placeholder="sensors/+/temperature"
            className={`${INPUT} font-mono`}
          />
          <div className="w-16 shrink-0">
            <Select
              size="compact"
              ariaLabel={t("api.mqtt.qos")}
              value={String(row.qos)}
              onChange={(value) => patchRow(row.id, { qos: toQos(value) })}
              options={QOS_OPTIONS}
            />
          </div>
          <button
            onClick={() => void applyEnabled(row, true)}
            disabled={!connectionId || row.topic.trim() === ""}
            className={buttonClass({ variant: "secondary", size: "sm" })}
          >
            {t("api.mqtt.subscribe")}
          </button>
          <button
            onClick={() => void applyEnabled(row, false)}
            disabled={!connectionId || row.topic.trim() === ""}
            className={buttonClass({ variant: "secondary", size: "sm" })}
          >
            {t("api.mqtt.unsubscribe")}
          </button>
          <Tooltip label={t("api.removeRow")}>
            <button
              onClick={() => setRows(settings.subscriptions.filter((other) => other.id !== row.id))}
              aria-label={t("api.removeRow")}
              className={iconButtonClass({ size: "xs" })}
            >
              <X size={13} />
            </button>
          </Tooltip>
        </div>
      ))}

      <button
        onClick={() =>
          setRows([
            ...settings.subscriptions,
            { id: newRowId(), topic: "", qos: 0, enabled: true },
          ])
        }
        className={buttonClass({ variant: "ghost", size: "sm", className: "-ml-2" })}
      >
        <Plus size={13} />
        {t("api.mqtt.addSubscription")}
      </button>
    </div>
  );
}

function MqttComposer({ tabId, connectionId }: { tabId: string; connectionId: string | null }) {
  const t = useT();
  const settings = useApiStore((s) => s.openTabs.find((tab) => tab.id === tabId)?.draft.mqtt);
  const updateDraft = useApiStore((s) => s.updateDraft);
  const appendMessage = useApiRuntimeStore((s) => s.appendMessage);
  if (!settings) return <></>;

  const patch = (next: Partial<typeof settings>) => updateDraft(tabId, { mqtt: { ...settings, ...next } });

  const publish = async () => {
    if (!connectionId) return;
    try {
      await apiMqttPublish(
        connectionId,
        settings.publishTopic,
        settings.publishPayload,
        settings.publishQos,
        settings.publishRetain,
      );
      appendMessage(tabId, {
        connection_id: connectionId,
        direction: "sent",
        channel: settings.publishTopic,
        payload: settings.publishPayload,
        binary: false,
        at: Date.now(),
        qos: settings.publishQos,
        retain: settings.publishRetain,
      });
    } catch (e) {
      pushErrorToast(String(e));
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <input
          value={settings.publishTopic}
          onChange={(e) => patch({ publishTopic: e.target.value })}
          placeholder={t("api.mqtt.topic")}
          className={fieldClass({ size: "sm", className: "w-64 font-mono" })}
        />
        <div className="w-16 shrink-0">
          <Select
            size="compact"
            ariaLabel={t("api.mqtt.qos")}
            value={String(settings.publishQos)}
            onChange={(value) => patch({ publishQos: toQos(value) })}
            options={QOS_OPTIONS}
          />
        </div>
        <label className="flex cursor-pointer items-center gap-1.5 text-[12px] text-[var(--cf-text)]">
          <Checkbox checked={settings.publishRetain} onChange={(checked) => patch({ publishRetain: checked })} />
          {t("api.mqtt.retain")}
        </label>
        <div className="flex-1" />
        <button
          onClick={() => void publish()}
          disabled={!connectionId || settings.publishTopic.trim() === ""}
          className={buttonClass({ variant: "primary", size: "sm" })}
        >
          <Send size={13} />
          {t("api.mqtt.publish")}
        </button>
      </div>
      <textarea
        value={settings.publishPayload}
        onChange={(e) => patch({ publishPayload: e.target.value })}
        placeholder={t("api.mqtt.payload")}
        rows={3}
        className={TEXTAREA}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className={`mb-1 block ${CAPTION}`}>{label}</span>
      {children}
    </label>
  );
}

/** The composer's "this isn't JSON" — a word and a triangle on the danger tone, not red text alone. */
function InvalidJson({ t }: { t: Translate }) {
  return (
    <span className={chipClass("bad")}>
      <AlertTriangle size={11} />
      {t("api.ws.invalidJson")}
    </span>
  );
}

function JsonEditor({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const monacoTheme = useThemeStore((s) => s.monacoTheme);
  return (
    <div className="overflow-hidden rounded-md border border-[var(--cf-field-border)]">
      <Editor
        height="110px"
        language="json"
        value={value}
        theme={monacoTheme}
        onChange={(next) => onChange(next ?? "")}
        options={{
          minimap: { enabled: false },
          fontSize: 12,
          lineNumbers: "off",
          folding: false,
          wordWrap: "on",
          scrollBeyondLastLine: false,
          renderLineHighlight: "none",
          overviewRulerLanes: 0,
          automaticLayout: true,
          scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
        }}
      />
    </div>
  );
}

type RenderedPayload =
  | { kind: "text" | "json"; text: string }
  | { kind: "binary"; hex: string; base64: string; size: number };

/** Pretty-prints JSON, and turns a base64 binary frame into a hex dump. Both are computed once
 * per message and memoised by the row — a 2000-frame transcript re-parsing on every keystroke in
 * the filter box is exactly the melt this window is meant to avoid. */
function renderPayload(message: StreamMessage): RenderedPayload {
  if (message.binary) {
    const bytes = decodeBase64(message.payload);
    if (bytes) {
      return { kind: "binary", hex: hexDump(bytes), base64: message.payload, size: bytes.length };
    }
    return { kind: "text", text: message.payload };
  }
  const trimmed = message.payload.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return { kind: "json", text: JSON.stringify(JSON.parse(trimmed), null, 2) };
    } catch {
      // Not JSON after all — a payload that merely starts with a brace is still just text.
    }
  }
  return { kind: "text", text: message.payload };
}

function decodeBase64(payload: string): Uint8Array | null {
  try {
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/** `offset  hex  ascii`, capped — nobody reads past the first few lines of a 4 MB frame. */
function hexDump(bytes: Uint8Array): string {
  const slice = bytes.subarray(0, BINARY_PREVIEW_BYTES);
  const lines: string[] = [];
  for (let offset = 0; offset < slice.length; offset += 16) {
    const chunk = slice.subarray(offset, offset + 16);
    const hex = Array.from(chunk, (byte) => byte.toString(16).padStart(2, "0")).join(" ");
    const ascii = Array.from(chunk, (byte) =>
      byte >= 32 && byte < 127 ? String.fromCharCode(byte) : ".",
    ).join("");
    lines.push(`${offset.toString(16).padStart(8, "0")}  ${hex.padEnd(47, " ")}  ${ascii}`);
  }
  if (bytes.length > slice.length) lines.push("…");
  return lines.join("\n");
}

function firstLine(text: string): string {
  const index = text.indexOf("\n");
  return index < 0 ? text : text.slice(0, index);
}

function formatTime(at: number): string {
  const date = new Date(at);
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

function isJson(text: string): boolean {
  if (text.trim() === "") return true;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

function toInt(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function newRowId(): string {
  return `sub-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
