import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * The API client's mock server (`api::mock`, `commands/mock_cmd.rs`). Every type mirrors its Rust
 * struct field for field (camelCase on the wire); a missing field reads as Rust's default.
 */

export interface MockHeader {
  key: string;
  value: string;
  enabled: boolean;
}

export type MockMatchKind = "always" | "query" | "header" | "body";

export interface MockVariant {
  id: string;
  name: string;
  matchKind: MockMatchKind;
  matchKey: string;
  matchValue: string;
  status: number;
  headers: MockHeader[];
  body: string;
}

export type MockErrorMode = "none" | "status" | "drop";
export type MockRouteSource = "request" | "openapi" | "manual" | "log";

export interface MockRoute {
  id: string;
  enabled: boolean;
  name: string;
  /** An HTTP method, or `*` for any. */
  method: string;
  path: string;
  source: MockRouteSource;
  requestId: string | null;
  delayMinMs: number;
  delayMaxMs: number;
  errorMode: MockErrorMode;
  errorStatus: number;
  /** 0..1 */
  errorRate: number;
  variants: MockVariant[];
}

export interface MockConfig {
  /** `0` picks a free port on every start. */
  port: number;
  exposeLan: boolean;
  cors: boolean;
  withServices: boolean;
  routes: MockRoute[];
}

export interface MockStatus {
  collectionId: string;
  workspaceId: string;
  name: string;
  port: number;
  host: string;
  url: string;
  startedAt: number;
}

export interface MockLogEntry {
  seq: number;
  at: number;
  method: string;
  path: string;
  query: string;
  routeId: string | null;
  routeName: string | null;
  variantName: string | null;
  /** `0` for a dropped connection. */
  status: number;
  latencyMs: number;
  headers: [string, string][];
  body: string;
  bodyTruncated: boolean;
  remote: string;
}

export interface MockSummary {
  collectionId: string;
  name: string;
  routes: number;
  withServices: boolean;
  running: MockStatus | null;
}

export const mockGetConfig = (collectionId: string) => invoke<MockConfig>("api_mock_get_config", { collectionId });
/** Saves; a running mock serves the new rules at once. Returns its status when running. */
export const mockSaveConfig = (collectionId: string, config: MockConfig) =>
  invoke<MockStatus | null>("api_mock_save_config", { collectionId, config });
export const mockStart = (collectionId: string) => invoke<MockStatus>("api_mock_start", { collectionId });
export const mockStop = (collectionId: string) => invoke<void>("api_mock_stop", { collectionId });
export const mockList = () => invoke<MockStatus[]>("api_mock_list");
export const mockLog = (collectionId: string) => invoke<MockLogEntry[]>("api_mock_log", { collectionId });
export const mockClearLog = (collectionId: string) => invoke<void>("api_mock_clear_log", { collectionId });
export const mockWorkspace = (workspaceId: string) => invoke<MockSummary[]>("api_mock_workspace", { workspaceId });
/** Starts the workspace's mocks marked to start with the services; returns one message per failure. */
export const mockStartWithServices = (workspaceId: string) =>
  invoke<string[]>("api_mock_start_with_services", { workspaceId });

/** A mock started or stopped; the payload is its collection id. */
export const onMockChanged = (handler: (collectionId: string) => void): Promise<UnlistenFn> =>
  listen<string>("api-mock:changed", (event) => handler(event.payload));
/** One call served. */
export const onMockLog = (handler: (collectionId: string, entry: MockLogEntry) => void): Promise<UnlistenFn> =>
  listen<{ collectionId: string; entry: MockLogEntry }>("api-mock:log", (event) =>
    handler(event.payload.collectionId, event.payload.entry),
  );
