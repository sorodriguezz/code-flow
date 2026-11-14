import { describe, expect, it } from "vitest";
import { connectionText, urlParts, type ConnectionTextInput } from "./connectionText";

const base: ConnectionTextInput = {
  kind: "mysql",
  mode: "fields",
  url: "",
  host: "localhost",
  port: null,
  defaultPort: 3306,
  user: "root",
  database: "",
  file: false,
};

describe("connectionText", () => {
  it("writes the fields, with the default port and without empty lines", () => {
    expect(connectionText(base)).toBe("HOST: localhost\nPORT: 3306\nUSER: root");
    expect(connectionText({ ...base, host: "db.internal", port: 3307, database: "shop" })).toBe(
      "HOST: db.internal\nPORT: 3307\nUSER: root\nDATABASE: shop",
    );
  });

  it("names a file engine by its file", () => {
    expect(connectionText({ ...base, kind: "sqlite", file: true, database: "C:/data/shop.db" })).toBe("FILE: C:/data/shop.db");
  });

  it("adds a JDBC driver's own fields", () => {
    expect(connectionText({ ...base, extras: [{ label: "Warehouse", value: "COMPUTE_WH" }, { label: "Role", value: "" }] })).toContain(
      "WAREHOUSE: COMPUTE_WH",
    );
  });

  it("never copies the password a URL carries", () => {
    const text = connectionText({ ...base, mode: "url", url: "mysql://root:s3cret@db.example.com:3307/shop?ssl=true" });
    expect(text).not.toContain("s3cret");
    expect(text).toBe("URL: mysql://root@db.example.com:3307/shop?ssl=true\nHOST: db.example.com\nPORT: 3307\nUSER: root\nDATABASE: shop");
  });

  it("masks a password parameter it cannot lift", () => {
    const text = connectionText({ ...base, kind: "sqlserver", mode: "url", url: "Server=db;Database=shop;User Id=sa;Password=s3cret;" });
    expect(text).not.toContain("s3cret");
    expect(text.startsWith("URL: ")).toBe(true);
  });

  it("falls back to the fields when URL mode has no URL", () => {
    expect(connectionText({ ...base, mode: "url" })).toBe("HOST: localhost\nPORT: 3306\nUSER: root");
  });

  it("reads JDBC and IPv6 URLs", () => {
    expect(urlParts("jdbc:postgresql://pg.local:5433/app")).toEqual({ host: "pg.local", port: "5433", user: "", database: "app" });
    expect(urlParts("postgres://u@[::1]/db")?.host).toBe("[::1]");
    expect(urlParts("Server=db;Database=x")).toBeNull();
  });
});
