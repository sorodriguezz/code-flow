import { useEffect, useState } from "react";
import { aiReadOnlyEngines } from "./tauri/commands";

/**
 * Which providers' read-only mode is a limit their CLI **enforces** — asked of the backend, never
 * listed here.
 *
 * Every place that promises "text only" or "writes nothing" — the chat's capability panel, the
 * story realizer's analyst — reads this instead of assuming, because the answer is a property of
 * the command line the backend builds (`AiEngine::enforces_read_only`): Claude Code, Codex and grok
 * enforce it; agy, opencode and Cline can only be asked. A second list in the frontend would be the
 * copy that stays wrong the day an engine changes sides.
 *
 * Fixed for a build, so one probe per window. A failed probe answers "none" — the honest direction:
 * saying a guarantee is only a request is a smaller lie than promising one that is not there — and
 * is asked again next time rather than cached.
 */
let request: Promise<string[]> | null = null;

export function readOnlyEngines(): Promise<string[]> {
  request ??= aiReadOnlyEngines().catch(() => {
    request = null;
    return [] as string[];
  });
  return request;
}

/** Whether `provider`'s read-only mode is enforced — `null` until the answer is in. */
export function useEnforcesReadOnly(provider: string): boolean | null {
  const [engines, setEngines] = useState<string[] | null>(null);
  useEffect(() => {
    let live = true;
    void readOnlyEngines().then((list) => {
      if (live) setEngines(list);
    });
    return () => {
      live = false;
    };
  }, []);
  return engines === null ? null : engines.includes(provider);
}
