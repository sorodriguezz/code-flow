import { create } from "zustand";
import { onApiStreamMessage, onApiStreamStatus } from "../lib/tauri/events";
import { exampleToResponse } from "../lib/api/examples";
import type { GraphqlSchema } from "../lib/api/graphql";
import type {
  ApiResponse,
  ConsoleLine,
  GrpcServiceInfo,
  RunnerReport,
  SavedExample,
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

/** A saved example being read in the response panel, alongside — never on top of — the live one. */
export interface ExampleView {
  exampleId: string;
  name: string;
  response: ApiResponse;
}

interface ApiRuntimeState {
  /**
   * The live response per tab. Freed on tab close and at no other point.
   *
   * Deliberately **not** capped the way `messages` and `consoleLines` are, and this is the one
   * place in the store where that is a decision rather than an oversight. Those two are streams of
   * independent frames, so dropping the oldest loses context and nothing else. A body is one
   * value: `saveResponseToFile`, copy-response, save-as-example and the test-script runner all read
   * `body_text` in full, and handing them a silently shortened string would write a corrupt file,
   * store a corrupt example and fail an assertion on text the server never sent — with nothing on
   * screen to say why.
   *
   * The honest fix is upstream, where the size is actually known: lower the backend's 50 MB
   * default, and have it flag what it cut (`truncated: true`) so the panel can say so in a banner
   * and the writers above can refuse rather than lie. Until then this grows, bounded only by how
   * many tabs are open.
   */
  responses: Record<string, ApiResponse | null>;
  /**
   * The example a tab is currently showing instead of its response, by tab id.
   *
   * Kept beside `responses` rather than written into it so that closing the example puts the
   * live response back exactly as it was — reading a saved example shouldn't cost you the one
   * you just sent.
   */
  exampleViews: Record<string, ExampleView>;
  sending: Record<string, boolean>;
  connections: Record<string, TabConnection>;
  messages: Record<string, StreamMessage[]>;
  grpcServices: Record<string, GrpcServiceInfo[]>;
  /** Introspection result per tab, so switching tabs doesn't cost another round trip. */
  graphqlSchemas: Record<string, GraphqlSchema>;
  consoleLines: ConsoleLine[];
  runnerRunning: boolean;
  /** The last run's report **without its captures** — see where it is written in `RunnerModal`.
   * A capture is up to 8 MB of response text, and this copy outlives the modal, so anything that
   * later wants the bodies has to read them from the modal's own state or re-run. */
  runnerReport: RunnerReport | null;

  /** Subscribes to the two stream events. Idempotent — safe to call from every mount. */
  init: () => void;

  setResponse: (tabId: string, response: ApiResponse | null) => void;
  setSending: (tabId: string, sending: boolean) => void;

  /** Shows a saved example in `tabId`'s response panel. */
  showExample: (tabId: string, example: SavedExample) => void;
  closeExample: (tabId: string) => void;

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
  exampleViews: {},
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

  // A response arriving is the tab going back to live: whatever example was being read is no
  // longer what the user is looking at, and leaving it up would hide the send they just made.
  setResponse: (tabId, response) =>
    set((s) => {
      const { [tabId]: _viewed, ...exampleViews } = s.exampleViews;
      return { responses: { ...s.responses, [tabId]: response }, exampleViews };
    }),

  // A tab that is sending is showing live: the skeleton, and then whatever comes back.
  setSending: (tabId, sending) =>
    set((s) => {
      if (!sending) return { sending: { ...s.sending, [tabId]: sending } };
      const { [tabId]: _viewed, ...exampleViews } = s.exampleViews;
      return { sending: { ...s.sending, [tabId]: sending }, exampleViews };
    }),

  showExample: (tabId, example) =>
    set((s) => ({
      exampleViews: {
        ...s.exampleViews,
        [tabId]: {
          exampleId: example.id,
          name: example.name,
          response: exampleToResponse(example),
        },
      },
    })),

  closeExample: (tabId) =>
    set((s) => {
      const { [tabId]: _closed, ...exampleViews } = s.exampleViews;
      return { exampleViews };
    }),

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
      const { [tabId]: _example, ...exampleViews } = s.exampleViews;
      const { [tabId]: _sending, ...sending } = s.sending;
      const { [tabId]: _connection, ...connections } = s.connections;
      const { [tabId]: _messages, ...messages } = s.messages;
      const { [tabId]: _services, ...grpcServices } = s.grpcServices;
      const { [tabId]: _schema, ...graphqlSchemas } = s.graphqlSchemas;
      return { responses, exampleViews, sending, connections, messages, grpcServices, graphqlSchemas };
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
