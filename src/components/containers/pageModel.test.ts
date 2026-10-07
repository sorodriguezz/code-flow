import { describe, expect, it } from "vitest";
import {
  baseName,
  composeOptions,
  composeProjectName,
  composeProjects,
  COMPOSE_PROJECT,
  dirOf,
  dockerHubUrl,
  imageName,
  onDockerHub,
  validObjectName,
  imageUseCount,
  imageUsers,
  layerCommand,
  networkFacts,
  pullableReference,
  relativeTo,
  rowOfStats,
  shortReference,
  statsFor,
  topByUsage,
  validImageTag,
} from "./pageModel";
import type { ContainerRow, ContainerStats, ImageRow } from "../../types/containers";

const container = (over: Partial<ContainerRow>): ContainerRow => ({
  id: "c".repeat(64),
  name: "web",
  image: "nginx:latest",
  state: "running",
  status: "Up 2 hours",
  health: "",
  exitCode: null,
  ports: [],
  created: "",
  command: "",
  project: "",
  service: "",
  projectDir: "",
  configFiles: "",
  pod: "",
  labels: {},
  ...over,
});

const image = (over: Partial<ImageRow>): ImageRow => ({
  id: "a1b2c3d4e5f6",
  repository: "nginx",
  tag: "latest",
  reference: "nginx:latest",
  size: "187MB",
  sizeBytes: 187_000_000,
  created: "",
  dangling: false,
  containers: null,
  ...over,
});

const sample = (over: Partial<ContainerStats>): ContainerStats => ({
  id: "c1",
  name: "web",
  cpuPercent: 0,
  memUsage: 0,
  memLimit: 0,
  memPercent: 0,
  netRx: 0,
  netTx: 0,
  blockRead: 0,
  blockWrite: 0,
  pids: null,
  ...over,
});

describe("imageUsers", () => {
  it("finds containers by reference, by repository alone for latest, and by Docker Hub's long name", () => {
    const rows = [
      container({ name: "a", image: "nginx:latest" }),
      container({ name: "b", image: "nginx" }),
      container({ name: "c", image: "docker.io/library/nginx:latest" }),
      container({ name: "d", image: "nginx:1.27" }),
      container({ name: "e", image: "postgres:16" }),
    ];
    expect(imageUsers(image({}), rows).map((r) => r.name)).toEqual(["a", "b", "c"]);
    expect(imageUsers(image({ tag: "1.27", reference: "nginx:1.27" }), rows).map((r) => r.name)).toEqual(["d"]);
  });

  it("matches a Podman image's full name against Docker-style container images", () => {
    const podman = image({ id: "f".repeat(64), repository: "docker.io/library/redis", tag: "7", reference: "docker.io/library/redis:7" });
    expect(imageUsers(podman, [container({ image: "redis:7" })])).toHaveLength(1);
  });

  it("finds a container by image id, the only name a dangling image has", () => {
    const dangling = image({ id: "0123456789ab", repository: "<none>", tag: "<none>", reference: "0123456789ab", dangling: true });
    const rows = [container({ name: "old", image: `sha256:0123456789ab${"0".repeat(52)}` }), container({ name: "short", image: "0123456789ab" }), container({ name: "other", image: "nginx:latest" })];
    expect(imageUsers(dangling, rows).map((r) => r.name)).toEqual(["old", "short"]);
  });

  it("never takes a short hex tag for an id", () => {
    expect(imageUsers(image({ id: "cafe00000000" }), [container({ image: "cafe" })])).toEqual([]);
  });

  it("counts with the engine's own number when it gives one", () => {
    expect(imageUseCount(image({ containers: 3 }), [])).toBe(3);
    expect(imageUseCount(image({ containers: null }), [container({})])).toBe(1);
  });
});

describe("shortReference", () => {
  it("drops Docker Hub's implied parts only", () => {
    expect(shortReference("docker.io/library/nginx:1")).toBe("nginx:1");
    expect(shortReference("docker.io/bitnami/redis:7")).toBe("bitnami/redis:7");
    expect(shortReference("ghcr.io/acme/app:2")).toBe("ghcr.io/acme/app:2");
  });
});

describe("layerCommand", () => {
  it("reads classic builder steps the way the Dockerfile wrote them", () => {
    expect(layerCommand('/bin/sh -c #(nop)  CMD ["nginx" "-g" "daemon off;"]')).toBe('CMD ["nginx" "-g" "daemon off;"]');
    expect(layerCommand("/bin/sh -c apt-get update &&   apt-get install -y curl")).toBe("RUN apt-get update && apt-get install -y curl");
  });

  it("leaves BuildKit's history as it is", () => {
    expect(layerCommand("RUN /bin/sh -c npm ci # buildkit")).toBe("RUN /bin/sh -c npm ci # buildkit");
    expect(layerCommand("COPY . . # buildkit")).toBe("COPY . . # buildkit");
  });
});

describe("validImageTag", () => {
  it("takes name[:tag], with a registry in front", () => {
    for (const ok of ["app", "app:1.0", "my-app:latest", "acme/app", "localhost:5000/app:dev", "registry.example.com/team/app:v2_1", "a__b"]) {
      expect(validImageTag(ok), ok).toBe(true);
    }
  });

  it("refuses what an engine would", () => {
    for (const bad of ["", "App", "app:", ":tag", "-app", "app name", "app:-x", "app@sha256:abc", "app//x", "app-"]) {
      expect(validImageTag(bad), bad).toBe(false);
    }
  });
});

describe("pullableReference", () => {
  it("refuses spaces and flags, and leaves the rest to the engine", () => {
    expect(pullableReference("nginx")).toBe(true);
    expect(pullableReference("ghcr.io/acme/app@sha256:abc")).toBe(true);
    expect(pullableReference("--all")).toBe(false);
    expect(pullableReference("nginx latest")).toBe(false);
    expect(pullableReference("  ")).toBe(false);
  });
});

describe("references", () => {
  it("splits a tag off without eating a registry port", () => {
    expect(imageName("nginx:1.27")).toBe("nginx");
    expect(imageName("localhost:5000/app")).toBe("localhost:5000/app");
    expect(imageName("localhost:5000/app:dev")).toBe("localhost:5000/app");
    expect(imageName("bitnami/redis")).toBe("bitnami/redis");
  });

  it("knows a Docker Hub name from another registry's, and where Hub shows it", () => {
    expect(onDockerHub("nginx")).toBe(true);
    expect(onDockerHub("bitnami/redis")).toBe(true);
    expect(onDockerHub("ghcr.io/acme/app")).toBe(false);
    expect(onDockerHub("localhost/app")).toBe(false);
    expect(onDockerHub("localhost:5000/app")).toBe(false);
    expect(dockerHubUrl("nginx")).toBe("https://hub.docker.com/_/nginx");
    expect(dockerHubUrl("bitnami/redis")).toBe("https://hub.docker.com/r/bitnami/redis");
  });

  it("takes volume and network names an engine takes", () => {
    for (const ok of ["data", "shop_db-data", "v1.2", "A1"]) expect(validObjectName(ok), ok).toBe(true);
    for (const bad of ["", "a", "-data", ".data", "my data", "data/x"]) expect(validObjectName(bad), bad).toBe(false);
  });
});

describe("composeProjects", () => {
  it("groups by project, counts what runs, lists services and keeps the files of the first that names them", () => {
    const rows = [
      container({ id: "1", project: "shop", service: "web", state: "running" }),
      container({ id: "2", project: "shop", service: "db", state: "exited", projectDir: "/w/shop", configFiles: "/w/shop/compose.yaml" }),
      container({ id: "3", project: "shop", service: "web", state: "running" }),
      container({ id: "4", project: "", name: "alone" }),
      container({ id: "5", project: "api", service: "app", state: "exited" }),
    ];
    const projects = composeProjects(rows);
    expect(projects.map((p) => p.name)).toEqual(["api", "shop"]);
    const shop = projects[1];
    expect(shop.rows).toHaveLength(3);
    expect(shop.running).toBe(2);
    expect(shop.services).toEqual(["db", "web"]);
    expect(composeOptions(shop)).toEqual({ projectDir: "/w/shop", configFiles: "/w/shop/compose.yaml" });
    expect(composeOptions(projects[0])).toEqual({ projectDir: "", configFiles: "" });
  });
});

describe("paths", () => {
  it("finds a file's folder on either separator", () => {
    expect(dirOf("/w/shop/compose.yaml")).toBe("/w/shop");
    expect(dirOf("/compose.yaml")).toBe("/");
    expect(dirOf("C:\\w\\shop\\compose.yml")).toBe("C:\\w\\shop");
    expect(dirOf("C:\\compose.yml")).toBe("C:\\");
    expect(dirOf("compose.yml")).toBe("");
  });

  it("names a project the way Compose does", () => {
    expect(baseName("/w/My Shop/")).toBe("My Shop");
    expect(composeProjectName("/w/My Shop")).toBe("myshop");
    expect(composeProjectName("C:\\code\\Api_v2")).toBe("api_v2");
    expect(composeProjectName("/w/_hidden-app")).toBe("hidden-app");
    expect(composeProjectName("/w/ñ")).toBe("");
    expect(COMPOSE_PROJECT.test("shop_2")).toBe(true);
    expect(COMPOSE_PROJECT.test("-shop")).toBe(false);
    expect(COMPOSE_PROJECT.test("Shop")).toBe(false);
  });

  it("makes a Dockerfile inside the context relative to it, and leaves one outside alone", () => {
    expect(relativeTo("/w/app", "/w/app/Dockerfile")).toBe("Dockerfile");
    expect(relativeTo("/w/app/", "/w/app/docker/Dockerfile.dev")).toBe("docker/Dockerfile.dev");
    expect(relativeTo("C:\\w\\app", "C:\\w\\app\\Dockerfile")).toBe("Dockerfile");
    expect(relativeTo("/w/app", "/w/app2/Dockerfile")).toBe("/w/app2/Dockerfile");
    expect(relativeTo("", "/w/app/Dockerfile")).toBe("/w/app/Dockerfile");
  });
});

describe("networkFacts", () => {
  it("reads Docker's addressing and members", () => {
    const facts = networkFacts(
      JSON.stringify({
        Name: "shop_default",
        IPAM: { Config: [{ Subnet: "172.18.0.0/16", Gateway: "172.18.0.1" }] },
        Internal: false,
        Containers: { abc: { Name: "shop-web-1", IPv4Address: "172.18.0.3/16" }, def: { Name: "shop-db-1", IPv4Address: "172.18.0.2/16" } },
      }),
    );
    expect(facts).toEqual({
      subnets: ["172.18.0.0/16"],
      gateways: ["172.18.0.1"],
      internal: false,
      containers: [
        { name: "shop-db-1", ip: "172.18.0.2" },
        { name: "shop-web-1", ip: "172.18.0.3" },
      ],
    });
  });

  it("reads Podman's, and a host network with no IPAM at all", () => {
    const podman = networkFacts(
      JSON.stringify([
        {
          name: "podman",
          subnets: [{ subnet: "10.88.0.0/16", gateway: "10.88.0.1" }],
          internal: true,
          containers: { x: { name: "db", interfaces: { eth0: { subnets: [{ ipnet: "10.88.0.5/16", gateway: "10.88.0.1" }] } } } },
        },
      ]),
    );
    expect(podman).toEqual({ subnets: ["10.88.0.0/16"], gateways: ["10.88.0.1"], internal: true, containers: [{ name: "db", ip: "10.88.0.5" }] });
    expect(networkFacts(JSON.stringify({ Name: "host", IPAM: { Config: null }, Containers: {} }))).toEqual({ subnets: [], gateways: [], internal: null, containers: [] });
    expect(networkFacts("not json")).toBeNull();
  });
});

describe("stats", () => {
  it("pairs short sample ids with long row ids, and ranks the busiest", () => {
    const rows = [container({ id: "c1".padEnd(64, "0"), name: "web" }), container({ id: "d2".padEnd(64, "0"), name: "db" })];
    const stats = [sample({ id: "c1", name: "web", cpuPercent: 3, memUsage: 900 }), sample({ id: "d2", name: "db", cpuPercent: 40, memUsage: 100 })];
    expect(statsFor(stats, rows[1])?.name).toBe("db");
    expect(rowOfStats(rows, stats[0])?.name).toBe("web");
    expect(topByUsage(stats, "cpu").map((s) => s.name)).toEqual(["db", "web"]);
    expect(topByUsage(stats, "memory", 1).map((s) => s.name)).toEqual(["web"]);
  });
});
