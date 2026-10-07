import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { composeProblems, composeYaml, emptyDraft, joinPath, newService, nextId, presetService, type ComposeDraft, type ComposeService } from "./composeFile";

const service = (name: string, change: Partial<ComposeService> = {}): ComposeService => ({ ...newService(name), image: "nginx", ...change });
const draftOf = (...services: ComposeService[]): ComposeDraft => ({ name: "", services });
const port = (host: string, container: string, protocol: "tcp" | "udp" = "tcp") => ({ id: nextId(), host, container, protocol });
const keys = (draft: ComposeDraft) => composeProblems(draft).map((problem) => problem.key);

describe("composeYaml", () => {
  it("writes the services, their ports quoted, and declares every named volume once", () => {
    const db = presetService(emptyDraft(), "postgres");
    const api = service("api", {
      from: "build",
      context: "/work/shop/api",
      dockerfile: "Dockerfile.dev",
      ports: [port("3000", "3000"), port("", "9229"), port("", "")],
      env: [
        { id: nextId(), key: "DATABASE_URL", value: "postgres://postgres:postgres@postgres:5432/app" },
        { id: nextId(), key: "", value: "" },
      ],
      mounts: [{ id: nextId(), kind: "bind", source: "/work/shop/api/src", target: "/app/src", readOnly: true }],
      dependsOn: [db.id],
      restart: "on-failure",
      command: "npm run dev",
    });
    const text = composeYaml({ name: "shop", services: [db, api] }, "/work/shop");
    expect(text).toContain('- "5432:5432"');
    expect(text).toContain('- "9229"');
    expect(parse(text)).toEqual({
      name: "shop",
      services: {
        postgres: {
          image: "postgres",
          restart: "unless-stopped",
          ports: ["5432:5432"],
          environment: { POSTGRES_USER: "postgres", POSTGRES_PASSWORD: "postgres", POSTGRES_DB: "app" },
          volumes: ["pgdata:/var/lib/postgresql"],
        },
        api: {
          build: { context: "./api", dockerfile: "Dockerfile.dev" },
          restart: "on-failure",
          command: "npm run dev",
          ports: ["3000:3000", "9229"],
          environment: { DATABASE_URL: "postgres://postgres:postgres@postgres:5432/app" },
          volumes: ["./api/src:/app/src:ro"],
          depends_on: ["postgres"],
        },
      },
      volumes: { pgdata: null },
    });
  });

  it("quotes what YAML 1.1 readers (podman-compose's PyYAML) would take for something else", () => {
    const text = composeYaml(draftOf(service("ssh", { ports: [port("22", "22")], env: [{ id: nextId(), key: "DEBUG", value: "yes" }, { id: nextId(), key: "PORT", value: "8080" }] })));
    expect(text).toContain('- "22:22"');
    expect(text).toContain('DEBUG: "yes"');
    expect(text).toContain('PORT: "8080"');
    expect(parse(text, { version: "1.1" }).services.ssh).toMatchObject({ ports: ["22:22"], environment: { DEBUG: "yes", PORT: "8080" } });
  });

  it("keeps a folder outside the file's own as given, and makes a bare word a path", () => {
    const web = service("web", {
      mounts: [
        { id: nextId(), kind: "bind", source: "/srv/static", target: "/usr/share/nginx/html", readOnly: false },
        { id: nextId(), kind: "bind", source: "conf", target: "/etc/nginx/conf.d", readOnly: true },
        { id: nextId(), kind: "bind", source: "/work/shop", target: "/repo", readOnly: false },
      ],
    });
    expect(parse(composeYaml(draftOf(web), "/work/shop")).services.web.volumes).toEqual(["/srv/static:/usr/share/nginx/html", "./conf:/etc/nginx/conf.d:ro", ".:/repo"]);
    // Unsaved, nothing is known about the folder: as typed, still never a bare word.
    expect(parse(composeYaml(draftOf(web))).services.web.volumes[2]).toBe("/work/shop:/repo");
  });

  it("names what a service waits for by the name it has now, and forgets one removed", () => {
    const db = service("db");
    const api = service("api", { dependsOn: [db.id, 999_999] });
    db.name = "database";
    expect(parse(composeYaml(draftOf(db, api))).services.api.depends_on).toEqual(["database"]);
  });

  it("builds from the file's own folder by default, with the engine's own Dockerfile", () => {
    const app = { ...newService("app", "build") };
    expect(parse(composeYaml(draftOf(app), "/work/shop")).services.app).toEqual({ build: "." });
  });
});

describe("composeProblems", () => {
  it("is quiet about a draft Compose would take", () => {
    expect(composeProblems(draftOf(presetService(emptyDraft(), "redis"), service("web", { ports: [port("127.0.0.1:8080", "80")] })))).toEqual([]);
  });

  it("asks for a service, a valid project name, names and images", () => {
    expect(keys(emptyDraft())).toEqual(["containers.m.compose.b.noServices"]);
    expect(keys({ name: "My App", services: [service("web")] })).toEqual(["containers.m.compose.nameInvalid"]);
    expect(keys(draftOf(service(""), service("bad name"), service("x", { image: "" }), service("y", { image: "nginx latest" })))).toEqual([
      "containers.m.compose.b.nameMissing",
      "containers.m.compose.b.nameInvalid",
      "containers.m.compose.b.imageMissing",
      "containers.m.compose.b.imageInvalid",
    ]);
    expect(keys(draftOf(service("web"), service("web")))).toEqual(["containers.m.compose.b.nameTaken", "containers.m.compose.b.nameTaken"]);
  });

  it("finds ports that are not ports, and a host port two services publish", () => {
    expect(keys(draftOf(service("a", { ports: [port("80", "http")] })))).toEqual(["containers.m.compose.b.portInvalid"]);
    expect(keys(draftOf(service("a", { ports: [port("70000", "80")] })))).toEqual(["containers.m.compose.b.portInvalid"]);
    const taken = composeProblems(draftOf(service("a", { ports: [port("8080", "80")] }), service("b", { ports: [port("8080", "8080"), port("8080", "53", "udp")] })));
    expect(taken).toEqual([{ service: expect.any(Number), key: "containers.m.compose.b.portTaken", params: { name: "b", port: "8080", other: "a" } }]);
  });

  it("checks variables and volumes, ignoring the rows left empty", () => {
    const rows = service("a", {
      env: [
        { id: nextId(), key: "", value: "" },
        { id: nextId(), key: "BAD KEY", value: "1" },
      ],
      mounts: [
        { id: nextId(), kind: "volume", source: "", target: "" },
        { id: nextId(), kind: "volume", source: "-data", target: "/data" },
        { id: nextId(), kind: "bind", source: "./x", target: "relative" },
      ].map((mount) => ({ ...mount, readOnly: false }) as ComposeService["mounts"][number]),
    });
    expect(keys(draftOf(rows))).toEqual(["containers.m.compose.b.envInvalid", "containers.m.compose.b.volumeInvalid", "containers.m.compose.b.targetInvalid"]);
  });

  it("refuses services that end up waiting for themselves", () => {
    const a = service("a");
    const b = service("b", { dependsOn: [a.id] });
    a.dependsOn = [b.id];
    expect(keys(draftOf(a, b))).toEqual(["containers.m.compose.b.cycle"]);
  });
});

describe("presetService", () => {
  it("gives a second copy its own name, host ports and volume", () => {
    const first = presetService(emptyDraft(), "postgres");
    const second = presetService(draftOf(first), "postgres");
    expect(second.name).toBe("postgres-2");
    expect(second.ports.map((p) => p.host)).toEqual(["5433"]);
    expect(second.mounts.map((m) => m.source)).toEqual(["pgdata2"]);
    expect(composeProblems(draftOf(first, second))).toEqual([]);
  });
});

describe("joinPath", () => {
  it("uses the separator the folder already has", () => {
    expect(joinPath("/work/shop", "compose.yaml")).toBe("/work/shop/compose.yaml");
    expect(joinPath("/work/shop/", "compose.yaml")).toBe("/work/shop/compose.yaml");
    expect(joinPath("C:\\work\\shop", "compose.yaml")).toBe("C:\\work\\shop\\compose.yaml");
    expect(joinPath("", "compose.yaml")).toBe("compose.yaml");
  });
});
