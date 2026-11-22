import { describe, expect, it } from "vitest";
import { addressLabel, isLocalAddress, normalizeAddress } from "./webPreview";

describe("webPreview", () => {
  it("gives an address without a scheme the one its host speaks", () => {
    expect(normalizeAddress("localhost:5173")).toBe("http://localhost:5173/");
    expect(normalizeAddress("127.0.0.1:8080/app")).toBe("http://127.0.0.1:8080/app");
    expect(normalizeAddress("example.com/docs")).toBe("https://example.com/docs");
    expect(normalizeAddress("  https://a.dev  ")).toBe("https://a.dev/");
  });

  it("refuses what is not a web address", () => {
    expect(normalizeAddress("")).toBeNull();
    expect(normalizeAddress("file:///etc/hosts")).toBeNull();
    expect(normalizeAddress("javascript://alert(1)")).toBeNull();
  });

  it("tells the machine's own pages from the internet's", () => {
    expect(isLocalAddress("http://localhost:5173/")).toBe(true);
    expect(isLocalAddress("http://127.0.0.1:41234/key/index.html")).toBe(true);
    expect(isLocalAddress("http://[::1]:3000/")).toBe(true);
    expect(isLocalAddress("http://app.localhost:3000/")).toBe(true);
    expect(isLocalAddress("https://github.com/")).toBe(false);
    expect(isLocalAddress("not a url")).toBe(false);
  });

  it("names a page by its host and path", () => {
    expect(addressLabel("http://localhost:5173/")).toBe("localhost:5173");
    expect(addressLabel("http://localhost:5173/settings/a%20b")).toBe("localhost:5173/settings/a b");
  });
});
