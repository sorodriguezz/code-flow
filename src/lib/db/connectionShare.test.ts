import { describe, expect, it } from "vitest";
import { defaultConnectionConfig } from "../../types/database";
import {
  SHARE_LINK_PREFIX,
  decodeShareLink,
  encodeShareLink,
  importedConfig,
  sharePayload,
} from "./connectionShare";

const sqlServer = {
  ...defaultConnectionConfig("sqlserver"),
  id: "conn-1",
  driver_id: "azuresql",
  host: "localhost",
  port: 1433,
  database: "Agendamiento",
  user: "sa",
  ssh_enabled: true,
  ssh_host: "bastión.example.com",
};

describe("connection share links", () => {
  it("round-trips a saved connection without its id or password", () => {
    const link = encodeShareLink(sharePayload("Agendamiento", { ...sqlServer, password: "leak" }));
    expect(link.startsWith(SHARE_LINK_PREFIX)).toBe(true);
    expect(link).toMatch(/^codeflow:\/\/connection\?d=[A-Za-z0-9_-]+$/);

    const shared = decodeShareLink(link)!;
    expect(shared.name).toBe("Agendamiento");
    expect(shared.password).toBeUndefined();
    expect(shared.spec).not.toHaveProperty("id");
    expect(shared.spec).not.toHaveProperty("password");

    const config = importedConfig(shared);
    expect(config).toMatchObject({
      kind: "sqlserver",
      driver_id: "azuresql",
      host: "localhost",
      port: 1433,
      database: "Agendamiento",
      user: "sa",
      ssh_host: "bastión.example.com",
      id: "",
      password: "",
    });
  });

  it("strips a password still sitting in the URL", () => {
    const payload = sharePayload("pg", {
      ...defaultConnectionConfig("postgres"),
      url: "postgresql://app:s3cret@db.example.com/shop",
    });
    expect(payload.spec.url).toBe("postgresql://app@db.example.com/shop");
  });

  it("reads the password the backend adds, and the link inside a pasted message", () => {
    // What `db_copy_share_link_with_password` writes: the same payload plus `password`, as
    // URL-safe base64 without padding.
    const json = JSON.stringify({ ...sharePayload("x", sqlServer), password: "p@ss wörd" });
    const bytes = new TextEncoder().encode(json);
    const data = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const shared = decodeShareLink(`Hola, aquí va:\n<${SHARE_LINK_PREFIX}${data}>\nsaludos`)!;
    expect(shared.password).toBe("p@ss wörd");
  });

  it("refuses what is not a link this build understands", () => {
    expect(decodeShareLink("")).toBeNull();
    expect(decodeShareLink("codeflow://flow/nightly")).toBeNull();
    expect(decodeShareLink(`${SHARE_LINK_PREFIX}not-base64!!`)).toBeNull();
    const encode = (value: unknown) =>
      SHARE_LINK_PREFIX + btoa(JSON.stringify(value)).replace(/=+$/, "");
    expect(decodeShareLink(encode({ v: 2, name: "x", spec: { kind: "postgres" } }))).toBeNull();
    expect(decodeShareLink(encode({ v: 1, name: "x", spec: { kind: "cassandra" } }))).toBeNull();
  });

  it("keeps only known fields of the right type", () => {
    const config = importedConfig({
      v: 1,
      name: "x",
      spec: { kind: "mysql", port: "3306" as unknown as number, host: "db", future_field: 1 } as never,
    });
    expect(config.port).toBe(0);
    expect(config.host).toBe("db");
    expect(config).not.toHaveProperty("future_field");
  });
});
