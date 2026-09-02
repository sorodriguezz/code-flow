import { CirclePlay } from "lucide-react";
import { Tooltip } from "../common/Tooltip";
import { useT } from "../../state/languageStore";
import { STATUS_TONE, deriveRunning, useServicesStore } from "../../state/servicesStore";
import { useTerminalStore } from "../../state/terminalStore";
import { useWorkspaceStore } from "../../state/workspaceStore";

/**
 * How many services are up, in the bar — and nothing at all when none are.
 *
 * Same rule as `AgentActivity` beside it: a permanent control reading "0" is a control that stops
 * being read, and the whole value of this one is that its presence is the message. Two containers
 * and four processes left running from this morning is exactly the thing you forget, and the fan is
 * currently the only thing that tells you.
 *
 * # It counts across workspaces, and that is not a detail
 *
 * Services are defined per workspace, so the list on screen holds one workspace at a time — but a
 * `docker compose up` does not stop because you clicked somewhere else. Counting off that list meant
 * starting six services, switching workspace, and being told zero. It counts off what is *running*
 * instead, and says how many of those are somewhere other than here.
 *
 * Only in the main window, because services only run there — see `ServicesDock`.
 */
export function ServicesActivity() {
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  // Subscribed to the two maps the answer is derived from, then derived — a selector returning a
  // fresh array on every store write would re-render this bar on every line of output.
  const runtime = useServicesStore((s) => s.runtime);
  const runningInfo = useServicesStore((s) => s.runningInfo);
  // Services live in the bottom panel now, so this opens the panel rather than switching view.
  // Not `togglePanel`: pressing a "3 running" badge is a request to see them, and a toggle would
  // close the panel for anyone who already had it open.
  const panelOpen = useTerminalStore((s) => s.panelOpen);
  const togglePanel = useTerminalStore((s) => s.togglePanel);
  const t = useT();

  const running = deriveRunning(runtime, runningInfo, workspaceId);
  const total = running.length;
  const elsewhere = running.filter((r) => r.foreign).length;
  const starting = running.some((r) => r.status === "starting");

  if (total === 0) return null;

  return (
    <Tooltip
      label={t("services.statusBar", { count: String(total) })}
      description={
        elsewhere > 0
          ? t("services.statusBarElsewhere", { count: String(elsewhere) })
          : t("services.statusBarHint")
      }
    >
      <button
        onClick={() => !panelOpen && togglePanel()}
        className="flex items-center gap-1 px-1.5 text-[11px] tabular-nums text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
      >
        <CirclePlay size={12} style={{ color: starting ? STATUS_TONE.starting : STATUS_TONE.ready }} />
        {total}
      </button>
    </Tooltip>
  );
}
