import { describe, expect, it } from "vitest";
import { testCommand, testLanguageOf, testNameAt } from "./testCommand";

const base = { packageManager: "pnpm" as const, windows: false };

describe("testLanguageOf", () => {
  it("knows test files by name, and Rust ones by content", () => {
    expect(testLanguageOf("src/a.test.ts", "")).toBe("js");
    expect(testLanguageOf("src/a.spec.jsx", "")).toBe("js");
    expect(testLanguageOf("src/a.ts", "")).toBeNull();
    expect(testLanguageOf("tests/test_api.py", "")).toBe("python");
    expect(testLanguageOf("pkg/x_test.go", "")).toBe("go");
    expect(testLanguageOf("src/lib.rs", "#[test]\nfn a() {}")).toBe("rust");
    expect(testLanguageOf("src/lib.rs", "fn a() {}")).toBeNull();
    expect(testLanguageOf("src/test/java/FooTest.java", "")).toBe("java");
  });
});

describe("testNameAt", () => {
  it("finds the nearest test above the caret", () => {
    const text = 'describe("suite", () => {\n  it("adds two", () => {\n    expect(1).toBe(1);\n  });\n});';
    expect(testNameAt("js", text, 3)).toBe("adds two");
    expect(testNameAt("js", text, 1)).toBe("suite");
    expect(testNameAt("go", "func TestSum(t *testing.T) {\n\tx := 1\n}", 2)).toBe("TestSum");
  });
});

describe("testCommand", () => {
  it("runs vitest from the package folder, filtered by the test under the caret", () => {
    const text = 'it("a (b)", () => {\n  x();\n});';
    const run = testCommand({
      ...base,
      language: "js",
      path: "web/src/a.test.ts",
      text,
      manifest: { dir: "web", name: "package.json", text: '{"devDependencies":{"vitest":"1"}}' },
      line: 2,
    });
    expect(run).toEqual({ cwd: "web", command: 'pnpm exec vitest run "src/a.test.ts" -t "a .b."', title: "a.test.ts · a (b)" });
  });

  it("names pytest's class and function", () => {
    const text = "class TestApi:\n    def test_get(self):\n        pass\n";
    const run = testCommand({ ...base, language: "python", path: "tests/test_api.py", text, manifest: null, line: 3 });
    expect(run?.command).toBe('python3 -m pytest "tests/test_api.py::TestApi::test_get"');
  });

  it("uses go test with an anchored name, and gradlew.bat on Windows", () => {
    const go = testCommand({ ...base, language: "go", path: "pkg/sum_test.go", text: "func TestSum(t *testing.T) {\n}", manifest: { dir: "", name: "go.mod", text: "" }, line: 2 });
    expect(go?.command).toBe('go test ./pkg -run "^TestSum$"');
    const java = testCommand({ ...base, windows: true, language: "java", path: "src/FooTest.java", text: "", manifest: { dir: "", name: "build.gradle", text: "" } });
    expect(java?.command).toBe('./gradlew.bat test --tests "*FooTest"');
  });

  it("gives up on a JavaScript package with no runner", () => {
    expect(testCommand({ ...base, language: "js", path: "a.test.js", text: "", manifest: { dir: "", name: "package.json", text: "{}" } })).toBeNull();
  });
});

describe("testNamesIn", () => {
  it("lists a file's tests, and only marked ones where a mark is required", async () => {
    const { testNamesIn } = await import("./testCommand");
    expect(testNamesIn("js", 'describe("s", () => {\n  it("a", () => {});\n  test.only(`b`, () => {});\n});')).toEqual([
      { name: "a", line: 2 },
      { name: "b", line: 3 },
    ]);
    expect(testNamesIn("rust", "fn helper() {}\n#[test]\nfn works() {}")).toEqual([{ name: "works", line: 3 }]);
  });
});
