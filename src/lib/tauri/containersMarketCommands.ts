import { invoke } from "./invoke";
import type { MarketService, PlannedService, ProvisionRequest, RemoveOptions, StackView } from "../../types/containersMarket";

/**
 * IPC surface for Contenedores › Catálogo de servicios (`src-tauri/src/commands/containers_market_cmd.rs`):
 * the catalogue, provisioning a stack (Compose file and Llavero passwords, then `up` as a job of the jobs
 * panel, then the integrations), and its lifecycle.
 */

export const containersMarketCatalog = () => invoke<MarketService[]>("containers_market_catalog");

/** The host ports each service would get on this engine now — defaults, or the next free ones. */
export const containersMarketSuggestPorts = (runtime: string, context: string | null, services: string[]) =>
  invoke<PlannedService[]>("containers_market_suggest_ports", { runtime, context, services });

/** Plans the ports, writes the Compose file and keeps the passwords in the Llavero — nothing runs yet.
 *  A stack whose passwords could not be kept comes back with `lastError`, and is not to be brought up. */
export const containersMarketPrepare = (request: ProvisionRequest) => invoke<StackView>("containers_market_prepare", { request });

export const containersMarketStacks = () => invoke<StackView[]>("containers_market_list");

/** Opens a stack's `compose up` as a terminal session — the jobs panel's `marketUp` job (see
 *  `containersJobsStore`). The passwords reach Compose in its environment, read from the Llavero in the
 *  backend; when it ends the backend settles the stack (integrations, or the error) before the panel
 *  hears of it. */
export const containersMarketUpJob = (id: string) => invoke<string>("containers_market_up_job", { id });

export const containersMarketStart = (id: string) => invoke<StackView>("containers_market_start", { id });

export const containersMarketStop = (id: string) => invoke<StackView>("containers_market_stop", { id });

/** Answers with what was asked to be removed but was kept (a locked Llavero keeps its entries). */
export const containersMarketRemove = (id: string, options: RemoveOptions) => invoke<string[]>("containers_market_remove", { id, options });
