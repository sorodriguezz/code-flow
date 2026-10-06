import type { FlowParamSpec } from "../tauri/flowsCommands";

/**
 * Whether a node's parameter is on screen given its other values — and only while the one it
 * depends on is: Google's "Para" follows the Gmail operation, which follows the service. A field
 * of one broker *and* one operation (the queue node's) carries a second condition, `alsoIf`.
 */
export function visible(spec: FlowParamSpec, values: Record<string, unknown>, specs: FlowParamSpec[], depth = 0): boolean {
  const holds = (condition: { param: string; values: string[] } | undefined): boolean => {
    if (!condition) return true;
    const other = specs.find((s) => s.name === condition.param);
    if (other && depth < 8 && !visible(other, values, specs, depth + 1)) return false;
    const current = values[condition.param] ?? other?.default;
    return typeof current === "string" && condition.values.includes(current);
  };
  return holds(spec.showIf) && holds(spec.alsoIf);
}
