import { describe, expect, it } from "vitest";
import { composeProjectPreview, configFor, featuresBlock, hostPortLabel, initChangedCommands, initialProposal, isDirtyRefusal, plausibleBranch, portUrl, publishedPorts, runsAsJob, slug, statusTone } from "./envsModel";
import type { EnvPortBinding, EnvProposal } from "../../types/containersEnvs";

const port = (over: Partial<EnvPortBinding>): EnvPortBinding => ({ service: "web", target: 80, protocol: "tcp", hostIp: "", base: 8080, host: 8180, hostEnd: null, ...over });

describe("envsModel", () => {
  it("names a project the way the backend does", () => {
    expect(slug("feature/Payment_v2", 40)).toBe("feature-payment-v2");
    expect(composeProjectPreview("Shop.API", "feature/payment")).toBe("shop-api-feature-payment");
    expect(composeProjectPreview("", "main")).toBe("main");
    expect(composeProjectPreview("...", "///")).toBe("env");
    expect(composeProjectPreview("repo", "x".repeat(200)).length).toBeLessThanOrEqual(63);
  });

  it("refuses the branch names git refuses most often", () => {
    for (const ok of ["main", "feature/payment", "fix/auth-2"]) expect(plausibleBranch(ok)).toBe(true);
    for (const bad of ["", "-x", "a b", "a..b", "a:b", "x/", "x.lock", "a//b"]) expect(plausibleBranch(bad)).toBe(false);
  });

  it("links published TCP ports on localhost", () => {
    expect(portUrl(port({}))).toBe("http://localhost:8180");
    expect(portUrl(port({ hostIp: "127.0.0.1" }))).toBe("http://localhost:8180");
    expect(portUrl(port({ hostIp: "192.168.1.4" }))).toBe("http://192.168.1.4:8180");
    expect(portUrl(port({ hostIp: "fe80::1" }))).toBe("http://[fe80::1]:8180");
    expect(portUrl(port({ protocol: "udp" }))).toBeNull();
    expect(portUrl(port({ host: null }))).toBeNull();
    expect(hostPortLabel(port({ host: 8100, hostEnd: 8105 }))).toBe("8100-8105");
    expect(hostPortLabel(port({ host: null }))).toBe("—");
  });

  it("lists only published ports, by service", () => {
    const rows = publishedPorts({ ports: [port({ service: "web", host: 8180 }), port({ service: "db", host: 5532 }), port({ service: "api", host: null })] });
    expect(rows.map((p) => p.service)).toEqual(["db", "web"]);
  });

  it("tells states, jobs and refusals apart", () => {
    expect(statusTone("running")).toBe("ok");
    expect(statusTone("partial")).toBe("warn");
    expect(statusTone("absent")).toBe("idle");
    expect(runsAsJob({ config: { kind: "compose", dir: "", files: ["compose.yaml"] } })).toBe(true);
    expect(runsAsJob({ config: { kind: "devcontainer", config: ".devcontainer/devcontainer.json", mode: "cli" } })).toBe(false);
    expect(isDirtyRefusal("Error: WORKTREE_DIRTY: /w/x")).toBe(true);
    expect(isDirtyRefusal("other")).toBe(false);
  });

  it("starts on the recommended proposal that can run", () => {
    const base: Omit<EnvProposal, "id" | "kind" | "recommended" | "available"> = { label: "", config: { kind: "compose", dir: "", files: [] }, detail: "", ports: [], reason: null, problem: null, unsupported: [], honoured: [], features: [], initialize: [], offsetApplies: true, suggestedOffset: 100 };
    const list: EnvProposal[] = [
      { ...base, id: "a", kind: "devcontainerCli", recommended: true, available: false },
      { ...base, id: "b", kind: "compose", recommended: false, available: true },
    ];
    expect(initialProposal(list)?.id).toBe("b");
    expect(initialProposal([])).toBeNull();
  });

  it("reads an initializeCommand refusal back into the commands to approve", () => {
    expect(initChangedCommands('Error: INIT_CHANGED: ["./prep.sh \\"a b\\"","make"]')).toEqual(['./prep.sh "a b"', "make"]);
    expect(initChangedCommands("INIT_CHANGED: not json")).toBeNull();
    expect(initChangedCommands("INIT_CHANGED: [1]")).toBeNull();
    expect(initChangedCommands("other")).toBeNull();
  });

  it("makes running without features an explicit choice", () => {
    const direct = { kind: "devcontainer" as const, features: ["ghcr.io/devcontainers/features/node:1"], initialize: ["make prep"], config: { kind: "devcontainer" as const, config: ".devcontainer/devcontainer.json", mode: "direct" as const } };
    expect(featuresBlock(direct, false)).toBe(true);
    expect(featuresBlock(direct, true)).toBe(false);
    expect(featuresBlock({ ...direct, kind: "devcontainerCli" }, false)).toBe(false);
    expect(featuresBlock({ ...direct, features: [] }, false)).toBe(false);
    expect(featuresBlock(null, false)).toBe(false);
    expect(configFor(direct, true)).toEqual({ ...direct.config, withoutFeatures: true, approvedInit: ["make prep"] });
    expect(configFor({ ...direct, kind: "devcontainerCli", config: { ...direct.config, mode: "cli" } }, true)).toEqual({ ...direct.config, mode: "cli", withoutFeatures: false, approvedInit: ["make prep"] });
    const compose = { kind: "compose" as const, features: [], initialize: [], config: { kind: "compose" as const, dir: "", files: ["compose.yaml"] } };
    expect(configFor(compose, true)).toEqual(compose.config);
  });
});
