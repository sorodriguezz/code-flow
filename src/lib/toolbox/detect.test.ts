import { describe, expect, it } from "vitest";
import { detectTools } from "./detect";

const first = (text: string) => detectTools(text)[0]?.tool;

describe("detectTools", () => {
  it("recognises the common things people paste", () => {
    expect(first("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abc_DEF-123")).toBe("jwt");
    expect(first('{"a": [1, 2]}')).toBe("json");
    expect(first("curl -X POST https://api.example.com")).toBe("curl");
    expect(first("https://example.com/path?q=1")).toBe("url-parse");
    expect(first("1732400000")).toBe("timestamp");
    expect(first("1732400000123")).toBe("timestamp");
    expect(first("2026-11-23T21:40:00Z")).toBe("timestamp");
    expect(first("*/5 * * * *")).toBe("cron");
    expect(first("0 9 * * MON-FRI")).toBe("cron");
    expect(first("550e8400-e29b-41d4-a716-446655440000")).toBe("uuid");
    expect(first("507f1f77bcf86cd799439011")).toBe("id-decode");
    expect(first("1541815603606036480")).toBe("id-decode");
    expect(first("-----BEGIN CERTIFICATE-----\nMIIB")).toBe("cert");
    expect(first("$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy")).toBe("bcrypt");
    expect(first("otpauth://totp/Acme:me?secret=JBSWY3DPEHPK3PXP")).toBe("totp");
    expect(first("SG9sYSBtdW5kbywgZXN0byBlcyB1biB0ZXh0bw==")).toBe("base64");
    expect(first("SELECT * FROM users")).toBe("sql");
    expect(first("10.0.0.0/16")).toBe("cidr");
    expect(first("DB_HOST=localhost\nDB_PORT=5432")).toBe("env");
    expect(first("#3b82f6")).toBe("color");
    expect(first("12.345.678-5")).toBe("rut");
    expect(first("caf%C3%A9%20con%20leche")).toBe("url");
  });

  it("sends two-way tools the text to decode", () => {
    expect(detectTools("SG9sYSBtdW5kbywgZXN0byBlcyB1biB0ZXh0bw==")[0].extra).toEqual({ direction: "decode" });
  });

  it("leaves prose and tool names alone", () => {
    expect(detectTools("")).toEqual([]);
    expect(detectTools("base64")).toEqual([]);
    expect(detectTools("formatear json")).toEqual([]);
    expect(detectTools("hola que tal como estas")).toEqual([]);
    expect(detectTools("password")).toEqual([]);
  });
});
