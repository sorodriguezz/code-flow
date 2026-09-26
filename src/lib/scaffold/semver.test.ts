import { describe, expect, it } from "vitest";
import { compareVersions, describeRange, pickLine, satisfies } from "./semver";
import { springPackage, springRangeIncludes } from "./spring";

describe("satisfies — npm engines", () => {
  it("reads the unions frameworks actually publish", () => {
    // Angular 22's own `engines.node`, against the Node that was installed when it was written.
    expect(satisfies("24.13.0", "^22.22.3 || ^24.15.0 || >=26.0.0", "npm")).toBe(false);
    expect(satisfies("24.15.0", "^22.22.3 || ^24.15.0 || >=26.0.0", "npm")).toBe(true);
    expect(satisfies("22.22.3", "^22.22.3 || ^24.15.0 || >=26.0.0", "npm")).toBe(true);
    expect(satisfies("23.1.0", "^22.22.3 || ^24.15.0 || >=26.0.0", "npm")).toBe(false);
    expect(satisfies("26.10.0", "^22.22.3 || ^24.15.0 || >=26.0.0", "npm")).toBe(true);
    expect(satisfies("20.19.0", "^20.19.0 || >=22.12.0", "npm")).toBe(true);
    expect(satisfies("20.18.9", "^20.19.0 || >=22.12.0", "npm")).toBe(false);
    expect(satisfies("18.20.0", ">=20.9.0", "npm")).toBe(false);
  });

  it("handles carets and tildes on zero majors and partials", () => {
    expect(satisfies("0.2.9", "^0.2.3", "npm")).toBe(true);
    expect(satisfies("0.3.0", "^0.2.3", "npm")).toBe(false);
    expect(satisfies("1.2.9", "~1.2.3", "npm")).toBe(true);
    expect(satisfies("1.3.0", "~1.2", "npm")).toBe(false);
    expect(satisfies("1.9.0", "~1", "npm")).toBe(true);
    expect(satisfies("16.1.0", "^14.18.0 || >=16.0.0", "npm")).toBe(true);
  });

  it("reads hyphen ranges, spaced operators and x-ranges", () => {
    expect(satisfies("2.3.4", "1.2 - 2.3.4", "npm")).toBe(true);
    expect(satisfies("2.3.5", "1.2 - 2.3.4", "npm")).toBe(false);
    expect(satisfies("18.0.0", ">= 18", "npm")).toBe(true);
    expect(satisfies("1.4.0", "1.x", "npm")).toBe(true);
    expect(satisfies("2.0.0", "1.x", "npm")).toBe(false);
    expect(satisfies("1.3.0", ">1.2", "npm")).toBe(true);
    expect(satisfies("1.2.9", ">1.2", "npm")).toBe(false);
  });
});

describe("satisfies — PEP 440", () => {
  it("reads requires-python the way PyPI writes it", () => {
    expect(satisfies("3.9.6", ">=3.10", "pep440")).toBe(false);
    expect(satisfies("3.12.1", ">=3.10", "pep440")).toBe(true);
    expect(satisfies("3.13.0", ">=3.8, <4", "pep440")).toBe(true);
    expect(satisfies("4.0.0", ">=3.8,<4", "pep440")).toBe(false);
    expect(satisfies("3.14.0", "~=3.10", "pep440")).toBe(true);
    expect(satisfies("3.10.1", "~=3.10.2", "pep440")).toBe(false);
    expect(satisfies("3.0.5", ">=2.7, !=3.0.*, !=3.1.*", "pep440")).toBe(false);
    expect(satisfies("3.2.0", ">=2.7, !=3.0.*, !=3.1.*", "pep440")).toBe(true);
    expect(satisfies("3.12.4", "==3.12.*", "pep440")).toBe(true);
  });
});

describe("satisfies — Composer", () => {
  it("reads Laravel's php constraints", () => {
    expect(satisfies("8.2.10", "^8.3", "composer")).toBe(false);
    expect(satisfies("8.4.1", "^8.3", "composer")).toBe(true);
    expect(satisfies("7.4.0", "^7.3|^8.0", "composer")).toBe(true);
    expect(satisfies("8.1.0", "^7.3 || ^8.0", "composer")).toBe(true);
    expect(satisfies("8.9.0", "~8.2", "composer")).toBe(true);
    expect(satisfies("9.0.0", "~8.2", "composer")).toBe(false);
    expect(satisfies("8.2.0", ">=8.1 <8.4", "composer")).toBe(true);
  });
});

describe("unreadable input is advice, not a veto", () => {
  it("treats empty or garbled ranges and versions as satisfied", () => {
    expect(satisfies("1.0.0", "", "npm")).toBe(true);
    expect(satisfies("1.0.0", null, "npm")).toBe(true);
    expect(satisfies("1.0.0", "latest", "npm")).toBe(true);
    expect(satisfies("unknown", ">=2", "npm")).toBe(true);
  });
});

describe("helpers", () => {
  it("orders versions numerically", () => {
    expect(["1.10.0", "1.9.0", "1.2"].sort(compareVersions)).toEqual(["1.2", "1.9.0", "1.10.0"]);
  });

  it("describes a range on one tidy line", () => {
    expect(describeRange("^22.22.3||  ^24.15.0 ||>=26.0.0")).toBe("^22.22.3 || ^24.15.0 || >=26.0.0");
  });
});


describe("pickLine", () => {
  const node = [
    { version: "26.10.0", line: "26", channel: "", eol: false },
    { version: "24.21.0", line: "24", channel: "lts", eol: false },
    { version: "22.23.3", line: "22", channel: "lts", eol: false },
    { version: "25.9.0", line: "25", channel: "", eol: true },
  ];
  it("prefers a living LTS that fits, then any living line that fits", () => {
    expect(pickLine(node, "^22.22.3 || ^24.15.0 || >=26.0.0", "npm")?.line).toBe("24");
    expect(pickLine(node, ">=25", "npm")?.line).toBe("26");
    expect(pickLine(node, null, "npm")?.line).toBe("24");
  });
});

describe("spring helpers", () => {
  it("reads Initializr's Maven-style ranges", () => {
    expect(springRangeIncludes("", "4.1.1")).toBe(true);
    expect(springRangeIncludes("[3.5.0,4.2.0-M1)", "4.1.1")).toBe(true);
    expect(springRangeIncludes("[3.5.0,4.1.0-M1)", "4.1.1")).toBe(false);
    expect(springRangeIncludes("(3.5.0,4.0.0]", "4.0.0")).toBe(true);
    expect(springRangeIncludes("(3.5.0,4.0.0]", "3.5.0")).toBe(false);
    expect(springRangeIncludes("3.5.0", "3.4.9")).toBe(false);
  });

  it("derives a valid Java package from group and artifact", () => {
    expect(springPackage("com.example", "my-demo")).toBe("com.example.mydemo");
    expect(springPackage("Com.Acme", "2fast")).toBe("com.acme._2fast");
  });
});
