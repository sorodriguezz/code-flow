import type { MarketCategory, MarketCreated, MarketService, PlannedService, StackServiceView, StackView } from "../../types/containersMarket";

/**
 * What the service catalogue's page works out on its own — the categories in reading order, a stack
 * name Compose accepts, which ports the user changed, how a stack is doing — kept apart from the page
 * so every rule is checkable without a window (see `MarketPage`).
 */

/** The order the categories are read in: what a backend needs first, what watches it last. */
export const MARKET_CATEGORIES: MarketCategory[] = ["databases", "cache", "messaging", "identity", "storage", "email", "testing", "ai", "observability"];

export function groupByCategory(services: MarketService[]): { category: MarketCategory; services: MarketService[] }[] {
  return MARKET_CATEGORIES.map((category) => ({ category, services: services.filter((s) => s.category === category) })).filter((g) => g.services.length > 0);
}

/** A Compose project name, as `marketplace::check_stack_name` takes it. */
export const STACK_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export function validStackName(name: string): boolean {
  return STACK_NAME.test(name.trim());
}

/** A first stack name: `dev`, then `dev-2`, `dev-3`… past the ones already taken. */
export function suggestStackName(taken: string[], base = "dev"): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
}

/** Whether a service needs a generated password — and so an unlocked Llavero to keep it. */
export function needsSecret(service: MarketService): boolean {
  return service.env.some((e) => e.value.from === "secret");
}

/** A typed host port: a whole number from 1024 to 65535 (below needs root on most systems). */
export function parsePort(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value >= 1024 && value <= 65535 ? value : null;
}

/**
 * The ports the user typed that differ from what was suggested — the only ones sent, so the backend
 * keeps those as they are and is free to move the rest.
 */
export function portOverrides(suggested: PlannedService[], typed: Record<string, Record<string, string>>): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const service of suggested) {
    for (const port of service.ports) {
      const text = typed[service.id]?.[port.key];
      if (text === undefined) continue;
      const value = parsePort(text);
      if (value === null || value === port.host) continue;
      (out[service.id] ??= {})[port.key] = value;
    }
  }
  return out;
}

/** Ports typed twice in one form, which the backend would refuse. */
export function duplicatePorts(suggested: PlannedService[], typed: Record<string, Record<string, string>>): number[] {
  const seen = new Map<number, number>();
  for (const service of suggested) {
    for (const port of service.ports) {
      const value = parsePort(typed[service.id]?.[port.key] ?? String(port.host));
      if (value !== null) seen.set(value, (seen.get(value) ?? 0) + 1);
    }
  }
  return [...seen.entries()].filter(([, n]) => n > 1).map(([port]) => port);
}

export type StackTone = "ok" | "warn" | "bad" | "idle";

/** How a stack is doing, in one tone: all running and healthy, some, none — or not answering. */
export function stackTone(stack: StackView): StackTone {
  if (!stack.reachable) return "idle";
  const running = stack.services.filter((s) => s.state === "running");
  if (stack.services.some((s) => s.health === "unhealthy")) return "bad";
  if (running.length === 0) return stack.lastError ? "bad" : "idle";
  if (running.length < stack.services.length || running.some((s) => s.health === "starting")) return "warn";
  return "ok";
}

export function runningCount(stack: StackView): number {
  return stack.services.filter((s) => s.state === "running").length;
}

/** A service a console can be opened for: it has one, and it runs. */
export function canOpen(service: StackServiceView): boolean {
  return !!service.console && service.state === "running";
}

/** What a stack made in each module, counted — the chips and the removal dialog's labels. */
export function integrationCounts(created: MarketCreated[]): { connections: number; api: number; vault: number } {
  return {
    connections: created.filter((c) => c.kind === "dbConnection").length,
    api: created.filter((c) => c.kind === "apiEnvironment" || c.kind === "apiCollection").length,
    vault: created.filter((c) => c.kind === "vaultItem").length,
  };
}

// ------------------------------------------------------------------------------------ up jobs

/** What a stack keeps as its error when its `up` job was closed before it ended (`marketplace::UP_CANCELLED`). */
export const MARKET_CANCELLED = "cancelled";

/** The part of a job these rules read — `containersJobsStore`'s `ContainerJob`. */
export interface MarketJobLike {
  request: { kind: string; target: string };
  ended: boolean;
}

/** The stacks with an `up` job still running, by id — their row waits for it instead of offering another. */
export function runningMarketStacks(jobs: MarketJobLike[]): string[] {
  return [...new Set(jobs.filter((j) => j.request.kind === "marketUp" && !j.ended).map((j) => j.request.target))].sort();
}

/** One string for the `up` jobs and whether each still runs: it changes when one starts, ends or is closed. */
export function marketJobsSignature(jobs: MarketJobLike[]): string {
  return jobs
    .filter((j) => j.request.kind === "marketUp")
    .map((j) => `${j.request.target}:${j.ended ? 1 : 0}`)
    .join("|");
}

export type MarketJobToast =
  | { tone: "success"; key: "containers.market.done"; params: { name: string } }
  | { tone: "error"; key: "containers.market.doneWithNotes"; params: { name: string; notes: string } }
  | { tone: "error"; key: "containers.market.failed"; params: { name: string; error: string } }
  | null;

/**
 * What is said once a stack's `up` job has ended, read from the stack as the backend left it (it is
 * settled before the panel hears the job end): up, up with notes (an integration that could not be
 * made), or not up. A job that never started says why; a cancelled one says nothing — the user did it.
 */
export function marketJobToast(name: string, stack: Pick<StackView, "lastError"> | undefined, code: number | null, error: string | null): MarketJobToast {
  if (error) return { tone: "error", key: "containers.market.failed", params: { name, error } };
  const lastError = stack?.lastError ?? "";
  // Closed from this side (or its code was lost): the backend kept it as cancelled.
  if (code === null || lastError === MARKET_CANCELLED) return null;
  if (code === 0) return lastError ? { tone: "error", key: "containers.market.doneWithNotes", params: { name, notes: lastError } } : { tone: "success", key: "containers.market.done", params: { name } };
  return { tone: "error", key: "containers.market.failed", params: { name, error: lastError || `exit ${code}` } };
}
