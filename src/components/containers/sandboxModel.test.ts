import { describe, expect, it } from "vitest";
import { actionsFor, allowedNetworks, argvLine, commandCounts, evidenceTone, fmtDuration, isLive, parsePortList, samePolicy, sandboxLabel, statusTone } from "./sandboxModel";
import type { EvidenceEntry, SecurityPolicy } from "../../types/containersSandbox";

const entry = (kind: EvidenceEntry["kind"], data: EvidenceEntry["data"] = {}): EvidenceEntry => ({ id: 1, sandboxId: "s", kind, at: "t", summary: "", data });

const policy: SecurityPolicy = {
  noPrivileged: true,
  noHostMounts: true,
  requireNonRoot: false,
  blockCriticalVulns: false,
  requireSigned: false,
  signingKey: "",
  restrictNetwork: false,
  noEngineSocket: true,
  requireLimits: false,
  enforceInFlows: false,
  sandboxImage: "img",
};

describe("sandbox states", () => {
  it("say what can be done", () => {
    expect(statusTone("running")).toBe("ok");
    expect(statusTone("blocked")).toBe("bad");
    expect(statusTone("destroyed")).toBe("idle");
    expect(isLive("stopped")).toBe(true);
    expect(isLive("failed")).toBe(false);
    expect(actionsFor("running")).toMatchObject({ exec: true, stop: true, start: false, destroy: true, forget: false });
    expect(actionsFor("stopped")).toMatchObject({ exec: false, start: true, destroy: true });
    expect(actionsFor("blocked")).toMatchObject({ destroy: false, forget: true });
    expect(actionsFor("creating").cancel).toBe(true);
  });
});

describe("sandbox helpers", () => {
  it("read ports, lines and durations", () => {
    expect(parsePortList("3000, 8080 3000;99999 abc 0 5173")).toEqual(["3000", "8080", "5173"]);
    expect(argvLine(["sh", "-c", "echo 'hi'"])).toBe("sh -c 'echo '\\''hi'\\'''");
    expect(argvLine(undefined)).toBe("");
    expect(fmtDuration(420)).toBe("420 ms");
    expect(fmtDuration(1500)).toBe("1.5 s");
    expect(fmtDuration(125_000)).toBe("2 min 5 s");
  });

  it("tone a timeline and count its commands", () => {
    expect(evidenceTone(entry("exec", { exitCode: 0 }))).toBe("ok");
    expect(evidenceTone(entry("test", { exitCode: 1 }))).toBe("bad");
    expect(evidenceTone(entry("test", { exitCode: null, timedOut: true }))).toBe("warn");
    expect(evidenceTone(entry("policy", { violations: [{ rule: "notScanned", detail: "", blocking: false }] }))).toBe("warn");
    expect(evidenceTone(entry("policy", { violations: [] }))).toBe("ok");
    expect(evidenceTone(entry("policy", { violations: [{ rule: "network", detail: "bridge", blocking: true }] }))).toBe("bad");
    const counts = commandCounts([entry("exec", { exitCode: 0 }), entry("test", { exitCode: 2 }), entry("diff"), entry("test", { exitCode: 0 })]);
    expect(counts).toEqual({ commands: 3, tests: 2, failed: 1 });
  });

  it("name a sandbox by what it is for", () => {
    expect(sandboxLabel({ storyTitle: "Login", taskTitle: "t", title: "x", containerName: "c" })).toBe("Login");
    expect(sandboxLabel({ storyTitle: "", taskTitle: "", title: "", containerName: "codeflow-sbx-1" })).toBe("codeflow-sbx-1");
  });

  it("follow the policy", () => {
    expect(allowedNetworks(null)).toEqual(["none", "internal", "internet"]);
    expect(allowedNetworks({ ...policy, restrictNetwork: true })).toEqual(["none", "internal"]);
    expect(samePolicy(policy, { ...policy, sandboxImage: " img " })).toBe(true);
    expect(samePolicy(policy, { ...policy, requireLimits: true })).toBe(false);
  });
});
