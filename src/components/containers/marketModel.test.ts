import { describe, expect, it } from "vitest";
import {
  duplicatePorts,
  groupByCategory,
  integrationCounts,
  MARKET_CANCELLED,
  marketJobToast,
  marketJobsSignature,
  needsSecret,
  parsePort,
  portOverrides,
  runningMarketStacks,
  stackTone,
  suggestStackName,
  validStackName,
} from "./marketModel";
import type { MarketService, PlannedService, StackView } from "../../types/containersMarket";

const service = (id: string, category: MarketService["category"], secret = false): MarketService => ({
  id,
  name: id,
  category,
  image: `${id}:1`,
  platform: null,
  ports: [],
  env: secret ? [{ key: "PASS", value: { from: "secret" } }] : [{ key: "A", value: { from: "text", value: "b" } }],
  command: [],
  volumes: [],
  health: { test: ["CMD", "true"], intervalS: 10, timeoutS: 5, retries: 3, startPeriodS: 0 },
  console: null,
  address: null,
  integration: "none",
  user: "",
  database: "",
  dbKind: null,
});

const stack = (states: [string, string][], extra: Partial<StackView> = {}): StackView => ({
  id: "s",
  name: "dev",
  runtime: "docker",
  context: null,
  workspaceId: "w",
  dir: "/d",
  composeFile: "/d/compose.yaml",
  createdAt: "",
  lastError: "",
  integrations: [],
  reachable: true,
  services: states.map(([state, health], i) => ({ id: `s${i}`, name: `s${i}`, category: "databases", image: "", ports: [], state, health, console: null, address: null, user: "", secretItem: null })),
  ...extra,
});

describe("the service catalogue's page model", () => {
  it("groups the catalogue in reading order and leaves empty categories out", () => {
    const groups = groupByCategory([service("jaeger", "observability"), service("pg", "databases"), service("redis", "cache")]);
    expect(groups.map((g) => g.category)).toEqual(["databases", "cache", "observability"]);
  });

  it("takes only Compose project names", () => {
    expect(validStackName("shop-dev")).toBe(true);
    expect(validStackName("Shop")).toBe(false);
    expect(validStackName("-p")).toBe(false);
    expect(validStackName("a b")).toBe(false);
    expect(suggestStackName([])).toBe("dev");
    expect(suggestStackName(["dev", "dev-2"])).toBe("dev-3");
  });

  it("knows which services need the Llavero", () => {
    expect(needsSecret(service("pg", "databases", true))).toBe(true);
    expect(needsSecret(service("mailpit", "email"))).toBe(false);
  });

  it("sends only the ports the user changed, and catches one typed twice", () => {
    const suggested: PlannedService[] = [
      { id: "pg", ports: [{ key: "postgres", purpose: "PostgreSQL", container: 5432, host: 5432 }] },
      { id: "mailpit", ports: [{ key: "smtp", purpose: "SMTP", container: 1025, host: 1025 }, { key: "web", purpose: "Web UI", container: 8025, host: 8025 }] },
    ];
    expect(portOverrides(suggested, { pg: { postgres: "5432" }, mailpit: { web: "18025", smtp: "x" } })).toEqual({ mailpit: { web: 18025 } });
    expect(duplicatePorts(suggested, { mailpit: { web: "5432" } })).toEqual([5432]);
    expect(parsePort("80")).toBeNull();
    expect(parsePort("65536")).toBeNull();
    expect(parsePort(" 8080 ")).toBe(8080);
  });

  it("reads a stack's state as one tone", () => {
    expect(stackTone(stack([["running", "healthy"], ["running", ""]]))).toBe("ok");
    expect(stackTone(stack([["running", "starting"]]))).toBe("warn");
    expect(stackTone(stack([["running", ""], ["exited", ""]]))).toBe("warn");
    expect(stackTone(stack([["running", "unhealthy"]]))).toBe("bad");
    expect(stackTone(stack([["missing", ""]], { lastError: "pull failed" }))).toBe("bad");
    expect(stackTone(stack([["exited", ""]]))).toBe("idle");
    expect(stackTone(stack([["running", ""]], { reachable: false }))).toBe("idle");
  });

  it("counts what a stack made in each module", () => {
    expect(
      integrationCounts([
        { kind: "dbConnection", id: "1", label: "", service: "pg" },
        { kind: "apiEnvironment", id: "2", label: "", service: "kc" },
        { kind: "apiCollection", id: "3", label: "", service: "kc" },
        { kind: "vaultItem", id: "4", label: "", service: "pg" },
      ]),
    ).toEqual({ connections: 1, api: 2, vault: 1 });
  });
});

describe("a stack's up job", () => {
  const job = (kind: string, target: string, ended: boolean) => ({ request: { kind, target }, ended });

  it("knows which stacks are being brought up, and changes its signature when one ends or goes", () => {
    const jobs = [job("marketUp", "s2", false), job("composeUp", "s9", false), job("marketUp", "s1", false), job("marketUp", "s3", true), job("marketUp", "s1", false)];
    expect(runningMarketStacks(jobs)).toEqual(["s1", "s2"]);
    const before = marketJobsSignature(jobs);
    expect(before).not.toContain("s9");
    expect(marketJobsSignature([...jobs.slice(0, 2), job("marketUp", "s1", true), ...jobs.slice(3)])).not.toBe(before);
    expect(marketJobsSignature(jobs.slice(1))).not.toBe(before);
  });

  it("says how it went from the stack the backend settled", () => {
    expect(marketJobToast("dev", { lastError: "" }, 0, null)).toEqual({ tone: "success", key: "containers.market.done", params: { name: "dev" } });
    expect(marketJobToast("dev", { lastError: "PostgreSQL: no workspace" }, 0, null)?.key).toBe("containers.market.doneWithNotes");
    expect(marketJobToast("dev", { lastError: "compose up ended with exit code 1" }, 1, null)).toEqual({ tone: "error", key: "containers.market.failed", params: { name: "dev", error: "compose up ended with exit code 1" } });
    expect(marketJobToast("dev", undefined, 2, null)?.params).toEqual({ name: "dev", error: "exit 2" });
    // Never started (a locked Llavero): the reason, whatever the stack says.
    expect(marketJobToast("dev", { lastError: "" }, null, "the Llavero is locked")).toEqual({ tone: "error", key: "containers.market.failed", params: { name: "dev", error: "the Llavero is locked" } });
    // Cancelled by the user: nothing to say.
    expect(marketJobToast("dev", { lastError: MARKET_CANCELLED }, null, null)).toBeNull();
    expect(marketJobToast("dev", { lastError: "" }, null, null)).toBeNull();
  });
});
