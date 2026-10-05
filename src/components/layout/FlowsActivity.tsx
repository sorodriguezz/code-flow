import { useEffect } from "react";
import { Waypoints } from "lucide-react";
import { Tooltip } from "../common/Tooltip";
import { ensureFlowRunEvents, useFlowRunsStore } from "../../state/flowRunsStore";
import { useLanguageStore, useT } from "../../state/languageStore";
import { useUiStore } from "../../state/uiStore";

/**
 * Flujos in the bar: how many of this workspace's flows are listening for their triggers, and
 * whether one is running — nothing at all when neither. The rule `ServicesActivity` beside it keeps:
 * a permanent "0" stops being read; this one's presence is the message ("three flows will run while
 * you are not looking"). Pressing it opens Programación.
 */
export function FlowsActivity() {
  const t = useT();
  const language = useLanguageStore((s) => s.language);
  const armed = useFlowRunsStore((s) => s.triggers);
  const runningCount = useFlowRunsStore((s) => Object.values(s.current).filter((live) => live.run.status === "running").length);

  useEffect(() => ensureFlowRunEvents(), []);
  // Shared flows sync in the background whether or not Flows is open (the poller runs in the main
  // window only); a teammate's version reloads what is on screen. Loaded on demand, like the view.
  useEffect(() => {
    void import("../../state/flowShareStore").then(({ startFlowSharing }) =>
      startFlowSharing((event) => {
        if (event.applied) void import("../../state/flowsStore").then(({ useFlowsStore }) => useFlowsStore.getState().reloadShared(event.flowId));
      }),
    );
  }, []);

  if (armed.length === 0 && runningCount === 0) return null;
  const next = armed
    .flatMap((flow) => flow.triggers.filter((tr) => tr.next).map((tr) => ({ flow: flow.flowName, at: tr.next as string })))
    .sort((a, b) => a.at.localeCompare(b.at))[0];
  const parts: string[] = [];
  if (next) {
    parts.push(
      t("flows.bar.next", {
        flow: next.flow,
        at: new Date(next.at).toLocaleTimeString(language, { hour: "2-digit", minute: "2-digit" }),
      }),
    );
  }
  if (runningCount > 0) parts.push(t("flows.bar.running", { n: runningCount }));

  return (
    <Tooltip label={t("flows.bar.label", { n: armed.length })} description={parts.join(" · ") || t("flows.bar.hint")}>
      <button
        type="button"
        onClick={() => {
          useUiStore.getState().setActiveView("flows");
          useFlowRunsStore.getState().setPane("schedule");
        }}
        className="flex h-[22px] items-center gap-[5px] rounded-md px-1.5 text-[12px] tabular-nums text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]"
      >
        <Waypoints size={14} className={runningCount > 0 ? "animate-pulse" : ""} style={{ color: runningCount > 0 ? "var(--cf-accent)" : "var(--cf-success)" }} />
        {armed.length}
      </button>
    </Tooltip>
  );
}
