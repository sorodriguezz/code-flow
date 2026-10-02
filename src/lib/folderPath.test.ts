import { describe, expect, it } from "vitest";
import { folderName, joinFolder, relativeInside } from "./folderPath";

describe("relativeInside", () => {
  it("answers the part below the root, with forward slashes", () => {
    expect(relativeInside("/Users/me/shop", "/Users/me/shop/backend/pagos/api")).toBe("backend/pagos/api");
    expect(relativeInside("/Users/me/shop/", "/Users/me/shop/web")).toBe("web");
  });

  it("answers an empty path for the root itself", () => {
    expect(relativeInside("/Users/me/shop", "/Users/me/shop")).toBe("");
    expect(relativeInside("/Users/me/shop", "/Users/me/shop/")).toBe("");
  });

  it("refuses a folder outside, including one that only shares a prefix", () => {
    expect(relativeInside("/Users/me/shop", "/Users/me")).toBeNull();
    expect(relativeInside("/Users/me/shop", "/Users/me/shop-old/api")).toBeNull();
    expect(relativeInside("/Users/me/shop", "")).toBeNull();
    expect(relativeInside("", "/Users/me/shop")).toBeNull();
  });

  it("matches Windows paths across separators and case", () => {
    expect(relativeInside("C:/Code/Shop", "c:\\code\\shop\\apps\\api")).toBe("apps/api");
    expect(relativeInside("C:\\Code\\Shop", "C:\\Code\\Shop")).toBe("");
    expect(relativeInside("C:\\Code\\Shop", "C:\\Code\\Shopping")).toBeNull();
  });

  it("keeps case-sensitive comparison off a drive path", () => {
    expect(relativeInside("/Users/me/Shop", "/Users/me/shop/api")).toBeNull();
  });
});

describe("folderName", () => {
  it("is the last folder whatever the separators", () => {
    expect(folderName("/Users/me/shop/api/")).toBe("api");
    expect(folderName("C:\\code\\shop")).toBe("shop");
    expect(folderName("api")).toBe("api");
  });
});

describe("joinFolder", () => {
  it("puts a relative path below the root, whatever the root's trailing slash", () => {
    expect(joinFolder("/Users/me/shop", "services/api")).toBe("/Users/me/shop/services/api");
    expect(joinFolder("/Users/me/shop/", " api ")).toBe("/Users/me/shop/api");
  });

  it("is the root itself for a blank path", () => {
    expect(joinFolder("/Users/me/shop", "")).toBe("/Users/me/shop");
    expect(joinFolder("/Users/me/shop", "  ")).toBe("/Users/me/shop");
  });

  it("lets an absolute path replace the root, as Path::join does", () => {
    expect(joinFolder("/Users/me/shop", "/opt/api")).toBe("/opt/api");
    expect(joinFolder("C:\\code\\shop", "D:\\api")).toBe("D:\\api");
    expect(joinFolder("C:\\code\\shop", "\\\\server\\share")).toBe("\\\\server\\share");
  });

  it("joins below a Windows root too", () => {
    expect(joinFolder("C:\\code\\shop\\", "apps\\api")).toBe("C:\\code\\shop/apps\\api");
  });
});
