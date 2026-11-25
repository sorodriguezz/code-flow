/**
 * Contenedores › Catálogo de servicios — mirrors of `src-tauri/src/containers/marketplace.rs` and
 * `commands/containers_market_cmd.rs`.
 */

export type MarketIntegration = "database" | "keycloak" | "apiEnvironment" | "console" | "none";

export type MarketCategory = "databases" | "cache" | "identity" | "messaging" | "storage" | "email" | "testing" | "ai" | "observability";

export interface MarketPortSpec {
  key: string;
  container: number;
  defaultHost: number;
  /** The protocol's own name: `PostgreSQL`, `SMTP`, `OTLP gRPC`. */
  purpose: string;
}

export type MarketEnvValue = { from: "text"; value: string } | { from: "secret" } | { from: "user" } | { from: "database" };

export interface MarketEnvSpec {
  key: string;
  value: MarketEnvValue;
}

/** One service of the catalogue. */
export interface MarketService {
  id: string;
  name: string;
  category: MarketCategory;
  image: string;
  platform: string | null;
  ports: MarketPortSpec[];
  env: MarketEnvSpec[];
  command: string[];
  volumes: { name: string; target: string }[];
  health: { test: string[]; intervalS: number; timeoutS: number; retries: number; startPeriodS: number };
  console: string | null;
  address: string | null;
  integration: MarketIntegration;
  user: string;
  database: string;
  dbKind: string | null;
}

export interface StackPort {
  key: string;
  purpose: string;
  container: number;
  host: number;
}

/** A service with its ports planned — what `containers_market_suggest_ports` answers. */
export interface PlannedService {
  id: string;
  ports: StackPort[];
  secretItem?: string | null;
}

/** Something made outside the engine for a stack, which removing it can undo. */
export interface MarketCreated {
  kind: "dbConnection" | "apiEnvironment" | "apiCollection" | "vaultItem";
  id: string;
  label: string;
  service: string;
}

export interface StackServiceView {
  id: string;
  name: string;
  category: MarketCategory | "";
  image: string;
  ports: StackPort[];
  /** As the engine says (`running`, `exited`…), `missing` with no container, `unknown` unanswered. */
  state: string;
  health: string;
  console: string | null;
  address: string | null;
  user: string;
  secretItem: string | null;
}

export interface StackView {
  id: string;
  name: string;
  runtime: string;
  context: string | null;
  workspaceId: string;
  dir: string;
  composeFile: string;
  createdAt: string;
  lastError: string;
  integrations: MarketCreated[];
  services: StackServiceView[];
  reachable: boolean;
}

export interface ProvisionRequest {
  runtime: string;
  context: string | null;
  name: string;
  workspaceId: string | null;
  /** `ports`: host ports the user typed, by port key. */
  services: { id: string; ports: Record<string, number> }[];
}

export interface RemoveOptions {
  volumes: boolean;
  connections: boolean;
  api: boolean;
  vault: boolean;
}
