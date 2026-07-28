import { create } from "zustand";
import { onApiStreamMessage, onApiStreamStatus } from "../lib/tauri/events";
import type { GraphqlSchema } from "../lib/api/graphql";
import type {
  ApiResponse,
  ConsoleLine,
  GrpcServiceInfo,
  RunnerReport,
  StreamMessage,
  StreamStatusEvent,
} from "../types/api";

/**
 * Everything the API client knows only while the app is running: responses, in-flight sends,
 * live socket transcripts and the runner's progress.
 *
 * **Nothing here is persisted, ever.** A response body can be 50 MB and a chatty MQTT topic
 * produces thousands of frames a minute; both belong to the session that produced them, and
 * writing them to the DB would turn `codeflow.db` into a log file. `apiStore` holds the state
 * that survives a restart — this one holds the state that shouldn't.
 *
 * Keyed by *tab* id rather than request id, because the same saved request can be open in two
 * tabs with two different responses, and a scratch tab has no request id at all.
 */

/** How many frames a single tab keeps. A subscription to `#` would otherwise grow without end. */
const MAX_MESSAGES_PER_TAB = 2000;
const MAX_CONSOLE_LINES = 1000;

export interface TabConnection {
  /** The id handed to `apiWsConnect`/`apiMqttConnect`; also what the backend events carry. */
  id: string;
  status: StreamStatusEvent["status"];
  detail: string;
}

interface ApiRuntimeState {
  responses: Record<string, ApiResponse | null>;
  sending: Record<string, boolean>;
  connections: Record<string, TabConnection>;
  messages: Record<string, StreamMessage[]>;
  grpcServices: Record<string, GrpcServiceInfo[]>;
  /** Introspection result per tab, so switching tabs doesn't cost another round trip. */
  graphqlSchemas: Record<string, GraphqlSchema>;
  consoleLines: ConsoleLine[];
  runnerRunning: boolean;
  runnerReport: RunnerReport | null;

  /** Subscribes to the two stream events. Idempotent — safe to call from every mount. */
  init: () => void;

  setResponse: (tabId: string, response: ApiResponse | null) => void;
  setSending: (tabId: string, sending: boolean) => void;

  /** Registers the connection id a tab just opened, in `connecting` until the backend says more. */
  openConnection: (tabId: string, connectionId: string) => void;
  closeConnection: (tabId: string) => void;
  /** Local echo of an outgoing frame — the transports only emit what they receive. */
  appendMessage: (tabId: string, message: StreamMessage) => void;
  clearMessages: (tabId: string) => void;

  setGrpcServices: (tabId: string, services: GrpcServiceInfo[]) => void;

  setGraphqlSchema: (tabId: string, schema: GraphqlSchema) => void;

  pushConsole: (line: ConsoleLine) => void;
  clearConsole: () => void;

  setRunnerRunning: (running: boolean) => void;
  setRunnerReport: (report: RunnerReport | null) => void;

  /** Drops every trace of a tab. Called when the tab closes, so nothing leaks per-session. */
  disposeTab: (tabId: string) => void;
}

let subscribed = false;

export const useApiRuntimeStore = create<ApiRuntimeState>((set, get) => ({
  responses: {},
  sending: {},
  connections: {},
  messages: {},
  grpcServices: {},
  graphqlSchemas: {},
  consoleLines: [],
  runnerRunning: false,
  runnerReport: null,

  init: () => {
    if (subscribed) return;
    subscribed = true;
    void onApiStreamMessage((message) => {
      const tabId = tabForConnection(get().connections, message.connection_id);
      if (tabId) get().appendMessage(tabId, message);
    });
    void onApiStreamStatus((event) => {
      const tabId = tabForConnection(get().connections, event.connection_id);
      if (!tabId) return;
      set((s) => {
        const current = s.connections[tabId];
        if (!current) return s;
        return {
          connections: {
            ...s.connections,
            [tabId]: { ...current, status: event.status, detail: event.detail },
          },
        };
      });
    });
  },

  setResponse: (tabId, response) =>
    set((s) => ({ responses: { ...s.responses, [tabId]: response } })),

  setSending: (tabId, sending) => set((s) => ({ sending: { ...s.sending, [tabId]: sending } })),

  openConnection: (tabId, connectionId) =>
    set((s) => ({
      connections: { ...s.connections, [tabId]: { id: connectionId, status: "connecting", detail: "" } },
      // A reconnect starts a fresh transcript; keeping the old one would interleave two sessions.
      messages: { ...s.messages, [tabId]: [] },
    })),

  closeConnection: (tabId) =>
    set((s) => {
      const { [tabId]: _closed, ...connections } = s.connections;
      return { connections };
    }),

  appendMessage: (tabId, message) =>
    set((s) => {
      const existing = s.messages[tabId] ?? [];
      const next = [...existing, message];
      return {
        messages: {
          ...s.messages,
          [tabId]: next.length > MAX_MESSAGES_PER_TAB ? next.slice(-MAX_MESSAGES_PER_TAB) : next,
        },
      };
    }),

  clearMessages: (tabId) => set((s) => ({ messages: { ...s.messages, [tabId]: [] } })),

  setGrpcServices: (tabId, services) =>
    set((s) => ({ grpcServices: { ...s.grpcServices, [tabId]: services } })),

  setGraphqlSchema: (tabId, schema) =>
    set((s) => ({ graphqlSchemas: { ...s.graphqlSchemas, [tabId]: schema } })),

  pushConsole: (line) =>
    set((s) => {
      const next = [...s.consoleLines, line];
      return { consoleLines: next.length > MAX_CONSOLE_LINES ? next.slice(-MAX_CONSOLE_LINES) : next };
    }),

  clearConsole: () => set({ consoleLines: [] }),

  setRunnerRunning: (runnerRunning) => set({ runnerRunning }),

  setRunnerReport: (runnerReport) => set({ runnerReport }),

  disposeTab: (tabId) =>
    set((s) => {
      const { [tabId]: _response, ...responses } = s.responses;
      const { [tabId]: _sending, ...sending } = s.sending;
      const { [tabId]: _connection, ...connections } = s.connections;
      const { [tabId]: _messages, ...messages } = s.messages;
      const { [tabId]: _services, ...grpcServices } = s.grpcServices;
      const { [tabId]: _schema, ...graphqlSchemas } = s.graphqlSchemas;
      return { responses, sending, connections, messages, grpcServices, graphqlSchemas };
    }),
}));

/**
 * Events carry a connection id, not a tab id — the transport has no idea which tab opened the
 * socket. The map is at most a handful of entries, so a scan beats maintaining a second index
 * that could drift out of sync with `connections`.
 */
function tabForConnection(
  connections: Record<string, TabConnection>,
  connectionId: string,
): string | null {
  for (const [tabId, connection] of Object.entries(connections)) {
    if (connection.id === connectionId) return tabId;
  }
  return null;
}
