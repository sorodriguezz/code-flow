import { invoke } from "@tauri-apps/api/core";
import { readFileText } from "./tauri/commands";
import { manifestNamesFor, type TestLanguage } from "./testCommand";

/** The manifest that decides how `path`'s tests run, looked for from its folder up to the
 *  repository root — `null` when there is none. */
export async function findTestManifest(
  repoPath: string,
  path: string,
  language: TestLanguage,
): Promise<{ dir: string; name: string; text: string } | null> {
  const parts = path.split("/").slice(0, -1);
  for (let depth = parts.length; depth >= 0; depth -= 1) {
    const dir = parts.slice(0, depth).join("/");
    for (const name of manifestNamesFor(language)) {
      try {
        const text = await readFileText(repoPath, dir ? `${dir}/${name}` : name);
        return { dir, name, text };
      } catch {
        // Not here: one folder up.
      }
    }
  }
  return null;
}

export interface TestRunResult {
  /** `null` when it was stopped or killed. */
  code: number | null;
  output: string;
  millis: number;
}

/** Runs one test command to the end and returns how it went — `tests_cmd::run_test_command`. */
export const runTestCommand = (repoPath: string, cwd: string, command: string) =>
  invoke<TestRunResult>("run_test_command", { repoPath, cwd, command });
