import { describe, expect, it } from "vitest";
import { installCommand } from "./install";

describe("installCommand", () => {
  it("runs pip through the interpreter it names", () => {
    expect(installCommand("/repo/.venv/bin/python3", false)).toBe("/repo/.venv/bin/python3 -m pip install ipykernel");
  });

  it("quotes a path the shell would split or expand", () => {
    expect(installCommand("/Users/ana/My Projects/.venv/bin/python", false)).toBe(
      "'/Users/ana/My Projects/.venv/bin/python' -m pip install ipykernel",
    );
    expect(installCommand("/tmp/it's/python3", false)).toBe("'/tmp/it'\\''s/python3' -m pip install ipykernel");
    expect(installCommand("/opt/$HOME/python3", false)).toBe("'/opt/$HOME/python3' -m pip install ipykernel");
  });

  it("uses PowerShell's call operator on Windows", () => {
    expect(installCommand("C:\\Users\\ana\\venv\\Scripts\\python.exe", true)).toBe(
      '& "C:\\Users\\ana\\venv\\Scripts\\python.exe" -m pip install ipykernel',
    );
  });
});
