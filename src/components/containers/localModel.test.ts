import { describe, expect, it } from "vitest";
import {
  freeClusterName,
  helmTone,
  installCommandFor,
  localClusterOf,
  localContextOf,
  localTone,
  releaseNameFor,
  validClusterName,
  validNamespace,
  validReleaseName,
  validRepoName,
  validRepoUrl,
} from "./localModel";
import type { LocalCluster } from "../../types/containersLocal";

const cluster = (tool: LocalCluster["tool"], name: string): LocalCluster => ({
  tool,
  name,
  context: localContextOf(tool, name),
  state: "running",
  nodes: 1,
  runningNodes: 1,
  version: "",
  canStop: tool !== "kind",
});

describe("local clusters", () => {
  it("takes the names every tool takes, and refuses what could be a flag", () => {
    expect(validClusterName("dev")).toBe(true);
    expect(validClusterName("dev-2")).toBe(true);
    for (const bad of ["", "-dev", "dev-", "Dev", "dev cluster", "dev_1", "x".repeat(33)]) expect(validClusterName(bad)).toBe(false);
  });

  it("names contexts the way the tools do, and finds a cluster by its context", () => {
    expect(localContextOf("kind", "dev")).toBe("kind-dev");
    expect(localContextOf("k3d", "dev")).toBe("k3d-dev");
    expect(localContextOf("minikube", "dev")).toBe("dev");
    const all = [cluster("kind", "dev"), cluster("k3d", "lab")];
    expect(localClusterOf(all, "k3d-lab")?.tool).toBe("k3d");
    expect(localClusterOf(all, "prod")).toBeNull();
    expect(localClusterOf(null, "kind-dev")).toBeNull();
  });

  it("offers a name not taken by that tool", () => {
    const all = [cluster("kind", "dev"), cluster("kind", "dev-2"), cluster("k3d", "lab")];
    expect(freeClusterName(all, "kind")).toBe("dev-3");
    expect(freeClusterName(all, "k3d")).toBe("dev");
  });

  it("colours states", () => {
    expect(localTone("running")).toBe("ok");
    expect(localTone("partial")).toBe("warn");
    expect(localTone("")).toBe("idle");
  });

  it("has an install command for every platform", () => {
    expect(installCommandFor("kind", "macos")).toBe("brew install kind");
    expect(installCommandFor("helm", "windows")).toContain("Helm.Helm");
    expect(installCommandFor("k3d", "unknown")).toContain("install.sh");
  });
});

describe("helm", () => {
  it("checks names, namespaces and repositories", () => {
    expect(validReleaseName("site")).toBe(true);
    expect(validReleaseName("x".repeat(54))).toBe(false);
    expect(validNamespace("kube-system")).toBe(true);
    expect(validNamespace("--all")).toBe(false);
    expect(validRepoName("bitnami")).toBe(true);
    expect(validRepoName("-x")).toBe(false);
    expect(validRepoUrl("https://charts.bitnami.com/bitnami")).toBe(true);
    expect(validRepoUrl("oci://registry-1.docker.io/bitnamicharts")).toBe(true);
    expect(validRepoUrl("file:///etc")).toBe(false);
  });

  it("colours statuses", () => {
    expect(helmTone("deployed")).toBe("ok");
    expect(helmTone("failed")).toBe("bad");
    expect(helmTone("pending-upgrade")).toBe("warn");
    expect(helmTone("superseded")).toBe("idle");
  });

  it("makes a release name from a chart", () => {
    expect(releaseNameFor("bitnami/nginx")).toBe("nginx");
    expect(releaseNameFor("ingress-nginx/ingress-nginx")).toBe("ingress-nginx");
    expect(releaseNameFor("repo/My_Chart")).toBe("my-chart");
    expect(releaseNameFor("repo/___")).toBe("release");
  });
});
