import { describe, expect, it } from "vitest";
import {
  DRIVER_CATALOG,
  catalogDriver,
  connectionDriverId,
  customDriverDef,
  driverErrorText,
  driverFilesError,
  driverForm,
  effectiveDriver,
  groupDrivers,
  isJvmDriver,
  jdbcUrlPreview,
  limitedSelect,
  newConnectionConfig,
  renderTemplate,
  rowDriverId,
  searchDrivers,
  templateFields,
  withUrlValue,
} from "./drivers";
import { defaultConnectionConfig, type DbDriverSettings, type DbKind } from "../../types/database";

const render = (template: string, values: Record<string, string>) =>
  renderTemplate(template, (name) => values[name] ?? "");

// The same cases `catalog.rs` tests the backend's renderer with: the form's preview has to show the
// URL the backend will actually open.
describe("renderTemplate", () => {
  it("fills fields in and lets defaults stand in for empty ones", () => {
    const template = "jdbc:db2://{host::localhost}[:{port::50000}]/{database}";
    expect(render(template, { host: "db.local", port: "50001", database: "SAMPLE" })).toBe(
      "jdbc:db2://db.local:50001/SAMPLE",
    );
    expect(render(template, { database: "SAMPLE" })).toBe("jdbc:db2://localhost/SAMPLE");
  });

  it("drops optional parts from the inside out", () => {
    const template = "jdbc:trino://{host}[:{port}][/{catalog}[/{database}]]";
    expect(render(template, { host: "h", catalog: "hive", database: "web" })).toBe("jdbc:trino://h/hive/web");
    expect(render(template, { host: "h", catalog: "hive" })).toBe("jdbc:trino://h/hive");
    expect(render(template, { host: "h", database: "web" })).toBe("jdbc:trino://h");
  });

  it("never keeps an optional part alive on a default", () => {
    expect(render("jdbc:exa:{host::localhost}[;schema={database::PUBLIC}]", {})).toBe("jdbc:exa:localhost");
  });

  it("leaves an unclosed brace as text", () => {
    expect(render("jdbc:x:{host", { host: "h" })).toBe("jdbc:x:{host");
  });
});

describe("templateFields", () => {
  it("lists each field once, in order, with its default and whether it is optional", () => {
    expect(templateFields("jdbc:h2:tcp://{host::localhost}[:{port::9092}]/{database}[;x={host}]")).toEqual([
      { name: "host", fallback: "localhost", optional: false },
      { name: "port", fallback: "9092", optional: true },
      { name: "database", fallback: undefined, optional: false },
    ]);
  });
});

describe("driverForm", () => {
  it("maps a host-based template to the form's own boxes", () => {
    const form = driverForm(catalogDriver("db2")!, "");
    expect(form.host?.fallback).toBe("localhost");
    expect(form.port).not.toBeNull();
    expect(form.database).not.toBeNull();
    expect(form.file).toBeNull();
    expect(form.credentials).toBe(true);
    expect(form.extra).toEqual([]);
  });

  it("asks for a driver's own fields under the catalogue's names, properties included", () => {
    const form = driverForm(catalogDriver("snowflake")!, "");
    expect(form.host).toBeNull();
    expect(form.extra.map((field) => [field.name, field.label])).toEqual([
      ["account", "Account identifier"],
      ["warehouse", "Warehouse"],
      ["role", "Role"],
    ]);
  });

  it("follows the template that is chosen", () => {
    const h2 = catalogDriver("h2")!;
    expect(driverForm(h2, "").file).not.toBeNull();
    expect(driverForm(h2, "Server").host).not.toBeNull();
    expect(driverForm(h2, "In-memory").database?.fallback).toBe("test");
  });

  it("has no login boxes for a local file with no notion of one", () => {
    expect(driverForm(catalogDriver("duckdb")!, "").credentials).toBe(false);
    expect(driverForm(catalogDriver("h2")!, "").credentials).toBe(true);
  });
});

describe("jdbcUrlPreview", () => {
  it("renders the URL the backend will open, port default and password masked", () => {
    const def = catalogDriver("databricks")!;
    const config = {
      ...newConnectionConfig(def),
      host: "adb-1.azuredatabricks.net",
      password: "dapi-secret",
      url_values: withUrlValue([], "httpPath", "/sql/1.0/warehouses/abc"),
    };
    expect(jdbcUrlPreview(config, def)).toBe(
      "jdbc:databricks://adb-1.azuredatabricks.net:443/default;transportMode=http;ssl=1;httpPath=/sql/1.0/warehouses/abc;AuthMech=3;UID=token",
    );
  });

  it("shows a pasted URL as it is", () => {
    const def = catalogDriver("db2")!;
    expect(jdbcUrlPreview({ ...newConnectionConfig(def), url: " jdbc:db2://x/Y " }, def)).toBe("jdbc:db2://x/Y");
  });
});

describe("newConnectionConfig", () => {
  it("starts from the engine's blank form with the driver's own defaults", () => {
    const config = newConnectionConfig(catalogDriver("cockroachdb")!);
    expect(config.kind).toBe("postgres");
    expect(config.driver_id).toBe("cockroachdb");
    expect(config.user).toBe("root");
    expect(config.database).toBe("defaultdb");
    expect(newConnectionConfig(catalogDriver("snowflake")!).host).toBe("");
    expect(newConnectionConfig(catalogDriver("azure-sql")!).ssl).toBe("require");
  });
});

describe("driver ids of saved connections", () => {
  it("stands an engine's own driver in for connections made before drivers existed", () => {
    const old = { ...defaultConnectionConfig("postgres") };
    expect(connectionDriverId(old)).toBe("postgresql");
    expect(rowDriverId({ kind: "mysql", spec: "{}" })).toBe("mysql");
    expect(rowDriverId({ kind: "jdbc", spec: JSON.stringify({ driver_id: "trino" }) })).toBe("trino");
    expect(rowDriverId({ kind: "oracle", spec: "not json" })).toBe("oracle");
  });
});

describe("driverFilesError", () => {
  it("reads the backend's marker, wherever in the message it ended up", () => {
    const missing = "driver-files-missing:snowflake\nSnowflake needs its driver files, which haven't been downloaded yet.";
    expect(driverFilesError(missing)).toEqual({
      kind: "missing",
      driverId: "snowflake",
      message: "Snowflake needs its driver files, which haven't been downloaded yet.",
    });
    expect(driverFilesError(`Couldn't connect: ${missing}`)?.driverId).toBe("snowflake");
    expect(driverFilesError("driver-files-manual:denodo\nGet them by hand.")?.kind).toBe("manual");
    expect(driverFilesError("password authentication failed")).toBeNull();
  });

  it("shows a person the sentence, not the marker", () => {
    expect(driverErrorText("driver-files-missing:h2\nH2 needs its driver files.")).toBe("H2 needs its driver files.");
    expect(driverErrorText("timeout")).toBe("timeout");
  });
});

describe("the Drivers list", () => {
  it("puts the best match first", () => {
    const names = searchDrivers(DRIVER_CATALOG, "sql").map((def) => def.name);
    expect(names[0]).toBe("SQLite");
    expect(searchDrivers(DRIVER_CATALOG, "mssql").some((def) => def.id === "sqlserver")).toBe(true);
    expect(searchDrivers(DRIVER_CATALOG, "zzzz")).toEqual([]);
  });

  it("groups by how completely the explorer supports a driver", () => {
    const groups = groupDrivers(DRIVER_CATALOG);
    expect(groups.map((entry) => entry.group)).toEqual(["complete", "basic"]);
    expect(groups[0].drivers.some((def) => def.id === "oracle")).toBe(true);
    expect(groups[1].drivers.some((def) => def.id === "snowflake")).toBe(true);
  });

  it("puts a user's own drivers under their own heading, with their templates first", () => {
    const custom: DbDriverSettings = {
      id: "custom-1",
      custom: true,
      name: "Acme DB",
      basedOn: "trino",
      class: "com.acme.Driver",
      files: ["C:/drivers/acme.jar"],
      urls: [{ name: "default", template: "jdbc:acme://{host}" }],
      properties: [],
      vmOptions: "",
      vmEnv: [],
      javaHome: "",
    };
    const def = customDriverDef(custom);
    expect(def.mark).toBe("AD");
    expect(def.sql?.paging).toBe(catalogDriver("trino")!.sql?.paging);
    expect(groupDrivers([def]).map((entry) => entry.group)).toEqual(["user"]);

    const tweaked = effectiveDriver("db2", [
      { ...custom, id: "db2", custom: false, urls: [{ name: "mine", template: "jdbc:db2://{host}/X" }] },
    ])!;
    expect(tweaked.urls?.[0].name).toBe("mine");
    expect(tweaked.urls?.length).toBe(catalogDriver("db2")!.urls!.length + 1);
  });
});

describe("limitedSelect", () => {
  it("caps a SELECT in the paging the engine speaks", () => {
    expect(limitedSelect("t", "top", 5)).toBe("SELECT TOP 5 * FROM t");
    expect(limitedSelect("t", "fetch-first", 5)).toBe("SELECT * FROM t FETCH FIRST 5 ROWS ONLY");
    expect(limitedSelect("t", "none", 5)).toBe("SELECT * FROM t");
    expect(limitedSelect("t", undefined, 5)).toBe("SELECT * FROM t LIMIT 5");
  });
});

// The JSON is edited by hand; these are the promises the rest of the app relies on.
describe("the catalogue", () => {
  const kinds: DbKind[] = ["postgres", "supabase", "sqlserver", "iris", "mongodb", "redis", "mysql", "mariadb", "sqlite", "oracle", "jdbc"];

  it("has unique ids, a known engine, a colour and a mark for every driver", () => {
    const ids = new Set<string>();
    for (const def of DRIVER_CATALOG) {
      expect(ids.has(def.id), def.id).toBe(false);
      ids.add(def.id);
      expect(kinds, def.id).toContain(def.engine);
      expect(["complete", "basic"], def.id).toContain(def.support);
      expect(def.color, def.id).toMatch(/^#[0-9a-f]{6}$/);
      expect(def.mark.length, def.id).toBeGreaterThan(0);
    }
  });

  it("gives every JVM driver a class, and files or a vendor page to get them from", () => {
    for (const def of DRIVER_CATALOG.filter(isJvmDriver)) {
      expect(def.class, def.id).toBeTruthy();
      expect((def.files?.length ?? 0) > 0 || Boolean(def.manual), def.id).toBe(true);
      for (const file of def.files ?? []) {
        expect(Boolean(file.sha1 || file.sha256), `${def.id}: ${file.name}`).toBe(true);
        expect(Boolean(file.maven || file.url), `${def.id}: ${file.name}`).toBe(true);
      }
    }
  });

  it("gives every generic JDBC driver a URL template and its SQL traits", () => {
    for (const def of DRIVER_CATALOG.filter((entry) => entry.engine === "jdbc")) {
      expect(def.urls?.length ?? 0, def.id).toBeGreaterThan(0);
      expect(def.sql?.paging, def.id).toBeTruthy();
    }
  });

  it("keeps an entry for every engine's own driver", () => {
    for (const kind of kinds.filter((entry) => entry !== "jdbc")) {
      const id = kind === "postgres" ? "postgresql" : kind;
      expect(catalogDriver(id)?.engine, kind).toBe(kind);
    }
  });
});
