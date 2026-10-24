import { describe, expect, it } from "vitest";
import {
  addDuration,
  dateDiff,
  durationSeconds,
  formatInZone,
  formatIsoDuration,
  guessUnit,
  parseDateInput,
  parseIsoDuration,
  timestampToMs,
  zoneOffsetMinutes,
} from "./time";
import { describeCron, nextRuns, parseCron } from "./cron";
import {
  formatIpv6,
  ipv4Subnet,
  ipv6Subnet,
  parseIpv6,
  parseUrl,
  parseUserAgent,
  permissionsFromOctal,
  permissionsFromSymbolic,
  permissionsToOctal,
  permissionsToSymbolic,
  splitIpv4,
  buildUrl,
} from "./net";
import { contrastRatio, formatColor, parseColor } from "./color";
import { byteTable, formatBigInt, formatBytes, parseBigInt, parseByteSize, twosComplement } from "./numbers";

describe("timestamps", () => {
  it("guesses the unit by digits", () => {
    expect(guessUnit("1761235200")).toBe("s");
    expect(guessUnit("1761235200000")).toBe("ms");
    expect(guessUnit("1761235200000000")).toBe("us");
    expect(guessUnit("1761235200000000000")).toBe("ns");
  });
  it("converts every unit to the same instant", () => {
    const iso = "2025-10-23T16:00:00.000Z";
    for (const [text, unit] of [["1761235200", "s"], ["1761235200000", "ms"], ["1761235200000000", "us"], ["1761235200000000000", "ns"]] as const) {
      expect(new Date(timestampToMs(text, unit)).toISOString()).toBe(iso);
      expect(parseDateInput(text).date.toISOString()).toBe(iso);
    }
    expect(parseDateInput("2025-10-23T16:00:00Z").unit).toBeNull();
    expect(() => parseDateInput("mañana")).toThrow();
  });
  it("formats in a time zone, DST included", () => {
    const d = new Date("2026-01-15T12:00:00Z");
    expect(formatInZone(d, "UTC")).toBe("2026-01-15 12:00:00 +00:00");
    expect(formatInZone(d, "America/New_York")).toBe("2026-01-15 07:00:00 -05:00");
    expect(zoneOffsetMinutes(new Date("2026-07-15T12:00:00Z"), "America/New_York")).toBe(-240);
    expect(formatInZone(d, "Asia/Kolkata")).toBe("2026-01-15 17:30:00 +05:30");
  });
});

describe("dates and durations", () => {
  it("calendar difference with borrows", () => {
    const d = dateDiff(new Date(2024, 0, 31, 10), new Date(2024, 2, 1, 9));
    expect([d.years, d.months, d.days, d.hours]).toEqual([0, 1, 0, 23]);
    expect(dateDiff(new Date(2026, 9, 23), new Date(2026, 9, 30)).businessDays).toBe(5);
    expect(dateDiff(new Date(2026, 1, 1), new Date(2025, 1, 1)).negative).toBe(true);
  });
  it("parses and formats ISO-8601 durations", () => {
    const { parts, negative } = parseIsoDuration("P1Y2M3W4DT5H6M7.5S");
    expect(negative).toBe(false);
    expect(parts).toEqual({ years: 1, months: 2, weeks: 3, days: 4, hours: 5, minutes: 6, seconds: 7.5 });
    expect(formatIsoDuration(parts)).toBe("P1Y2M3W4DT5H6M7.5S");
    expect(durationSeconds(parseIsoDuration("PT1H30M").parts)).toBe(5400);
    expect(parseIsoDuration("-P1D").negative).toBe(true);
    expect(() => parseIsoDuration("P")).toThrow();
    expect(() => parseIsoDuration("PT")).toThrow();
    expect(() => parseIsoDuration("1D")).toThrow();
    expect(addDuration(new Date(2026, 0, 31), { ...parts, years: 0, months: 1, weeks: 0, days: 0, hours: 0, minutes: 0, seconds: 0 }).getMonth()).toBe(2);
  });
});

describe("cron", () => {
  it("parses fields, names, steps and lists", () => {
    const c = parseCron("*/15 9-17 * JAN,jul MON-FRI");
    expect(c.minute.values).toEqual([0, 15, 30, 45]);
    expect(c.hour.values).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect(c.month.values).toEqual([1, 7]);
    expect(c.dow.values).toEqual([1, 2, 3, 4, 5]);
    expect(parseCron("0 0 * * 7").dow.values).toEqual([0]);
    expect(parseCron("@daily").minute.values).toEqual([0]);
    expect(parseCron("*/10 * * * * *").second.values).toEqual([0, 10, 20, 30, 40, 50]);
  });
  it("refuses what it cannot read", () => {
    expect(() => parseCron("* * *")).toThrow(/5 fields/);
    expect(() => parseCron("60 * * * *")).toThrow(/out of range/);
    expect(() => parseCron("0 0 L * *")).toThrow(/Quartz/);
    expect(() => parseCron("@reboot")).toThrow();
  });
  it("lists the next runs, OR-ing day-of-month and weekday", () => {
    const from = new Date(Date.UTC(2026, 9, 23, 10, 7, 30));
    expect(nextRuns(parseCron("*/15 * * * *"), from, 3, true).map((d) => d.toISOString())).toEqual([
      "2026-10-23T10:15:00.000Z",
      "2026-10-23T10:30:00.000Z",
      "2026-10-23T10:45:00.000Z",
    ]);
    // 2026-10-23 is a Friday: next "Monday or the 1st" is Mon 26th, then Sun 1 Nov.
    expect(nextRuns(parseCron("0 9 1 * 1"), from, 2, true).map((d) => d.toISOString())).toEqual([
      "2026-10-26T09:00:00.000Z",
      "2026-11-01T09:00:00.000Z",
    ]);
    expect(nextRuns(parseCron("0 0 29 2 *"), from, 1, true)[0].toISOString()).toBe("2028-02-29T00:00:00.000Z");
  });
  it("explains in both languages", () => {
    expect(describeCron(parseCron("*/15 9-17 * * 1-5"), "en")).toBe("Every 15 minutes, between 09:00 and 17:59, on Monday through Friday");
    expect(describeCron(parseCron("*/15 9-17 * * 1-5"), "es")).toBe("Cada 15 minutos, entre las 09:00 y las 17:59, los lunes a viernes");
    expect(describeCron(parseCron("0 9 * * *"), "es")).toBe("A las 09:00, todos los días");
    expect(describeCron(parseCron("30 2 1 1,7 *"), "en")).toBe("At 02:30, on day 1 of the month, in January and July");
  });
});

describe("network", () => {
  it("IPv4 subnets", () => {
    const s = ipv4Subnet("192.168.10.37/22");
    expect(s).toMatchObject({
      network: "192.168.8.0",
      broadcast: "192.168.11.255",
      netmask: "255.255.252.0",
      wildcard: "0.0.3.255",
      firstHost: "192.168.8.1",
      lastHost: "192.168.11.254",
      size: 1024,
      hosts: 1022,
      ipClass: "C",
      kind: "private",
    });
    expect(ipv4Subnet("10.0.0.1 255.0.0.0").prefix).toBe(8);
    expect(ipv4Subnet("8.8.8.8").hosts).toBe(1);
    expect(ipv4Subnet("10.0.0.0/31").hosts).toBe(2);
    expect(() => ipv4Subnet("300.1.1.1/8")).toThrow();
    expect(splitIpv4("10.0.0.0/24", 3)).toEqual(["10.0.0.0/26", "10.0.0.64/26", "10.0.0.128/26", "10.0.0.192/26"]);
  });
  it("IPv6", () => {
    expect(formatIpv6(parseIpv6("2001:0db8:0000:0000:0000:ff00:0042:8329"))).toBe("2001:db8::ff00:42:8329");
    expect(formatIpv6(parseIpv6("::1"))).toBe("::1");
    expect(formatIpv6(parseIpv6("::ffff:192.0.2.1"))).toBe("::ffff:c000:201");
    const s = ipv6Subnet("2001:db8:abcd:12::1/64");
    expect(s.network).toBe("2001:db8:abcd:12::/64");
    expect(s.size).toBe("18446744073709551616");
    expect(s.kind).toBe("documentation");
    expect(ipv6Subnet("fe80::1").kind).toBe("link-local");
    expect(() => parseIpv6("1:2:3")).toThrow();
  });
  it("URLs parse and rebuild", () => {
    const p = parseUrl("https://u:p@api.example.com:8443/v1/a%20b?x=1&x=2#frag");
    expect(p).toMatchObject({ protocol: "https", username: "u", hostname: "api.example.com", port: "8443", pathname: "/v1/a b", hash: "frag" });
    expect(p.query).toEqual([["x", "1"], ["x", "2"]]);
    expect(buildUrl({ ...p, query: [["y", "ñ"]] })).toBe("https://u:p@api.example.com:8443/v1/a%20b?y=%C3%B1#frag");
    expect(parseUrl("example.com/x").hostname).toBe("example.com");
  });
  it("chmod", () => {
    const p = permissionsFromOctal("4755");
    expect(permissionsToSymbolic(p)).toBe("rwsr-xr-x");
    expect(permissionsToOctal(p)).toBe("4755");
    expect(permissionsToOctal(permissionsFromSymbolic("-rw-r--r--"))).toBe("644");
    expect(permissionsToOctal(permissionsFromSymbolic("rwxrwxrwt"))).toBe("1777");
    expect(() => permissionsFromOctal("9")).toThrow();
  });
  it("User-Agent", () => {
    expect(parseUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0")).toMatchObject({
      browser: "Edge",
      browserVersion: "130.0.0.0",
      os: "Windows",
      device: "desktop",
    });
    expect(parseUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1")).toMatchObject({
      browser: "Safari",
      os: "iOS",
      osVersion: "18.1",
      device: "mobile",
    });
    expect(parseUserAgent("curl/8.7.1").device).toBe("bot");
  });
});

describe("colour", () => {
  it("parses notations and writes them all", () => {
    expect(formatColor(parseColor("#3b82f6")).rgb).toBe("rgb(59 130 246)");
    expect(formatColor(parseColor("rgb(255, 0, 0)")).hex).toBe("#ff0000");
    expect(formatColor(parseColor("hsl(120 100% 25%)")).hex).toBe("#008000");
    expect(formatColor(parseColor("#fff8")).hex).toBe("#ffffff88");
    expect(formatColor(parseColor(formatColor(parseColor("#3b82f6")).oklch)).hex).toBe("#3b82f6");
    expect(formatColor(parseColor("white")).oklch).toBe("oklch(100% 0 0)");
    expect(() => parseColor("nope")).toThrow();
  });
  it("WCAG contrast", () => {
    expect(contrastRatio(parseColor("#000"), parseColor("#fff"))).toBeCloseTo(21, 5);
    expect(contrastRatio(parseColor("#777"), parseColor("#fff"))).toBeCloseTo(4.48, 2);
  });
});

describe("numbers", () => {
  it("bases with BigInt", () => {
    expect(formatBigInt(parseBigInt("ff", 16), 10)).toBe("255");
    expect(formatBigInt(parseBigInt("0b1010", 10), 16)).toBe("a");
    expect(formatBigInt(parseBigInt("-0x10", 10), 2)).toBe("-10000");
    const big = parseBigInt("340282366920938463463374607431768211455", 10);
    expect(formatBigInt(big, 16)).toBe("f".repeat(32));
    expect(formatBigInt(1234567n, 10, 3)).toBe("1,234,567");
    expect(() => parseBigInt("12g", 16)).toThrow();
  });
  it("two's complement", () => {
    expect(twosComplement(-1n, 8)).toBe("1111 1111");
    expect(twosComplement(5n, 8)).toBe("0000 0101");
    expect(twosComplement(-129n, 8)).toBeNull();
  });
  it("byte sizes", () => {
    expect(parseByteSize("1.5 GiB")).toBe(1.5 * 1024 ** 3);
    expect(parseByteSize("200MB")).toBe(200e6);
    expect(parseByteSize("8 Mbit")).toBe(1e6);
    expect(parseByteSize("1,5 kB")).toBe(1500);
    expect(parseByteSize("1024")).toBe(1024);
    expect(formatBytes(1536, "iec")).toBe("1.5 KiB");
    expect(formatBytes(1536, "si")).toBe("1.54 kB");
    expect(byteTable(1024 ** 2, "iec")[2]).toEqual({ unit: "MiB", value: 1 });
  });
});
