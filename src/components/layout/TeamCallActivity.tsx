import { useEffect, useState } from "react";
import { AudioLines } from "lucide-react";
import { Tooltip } from "../common/Tooltip";
import { useT } from "../../state/languageStore";
import { followTarget } from "../../state/notificationStore";
import { callOngoing, useTeamCallStore } from "../../state/teamCallStore";

/**
 * «En llamada» in the bar, from every view: a call with a team goes on wherever the user is, and
 * while it does its microphone may be open — nothing listens without something on screen saying so.
 * Pressing it unfolds the call where the user is.
 */
export function TeamCallActivity() {
  const t = useT();
  const call = useTeamCallStore((s) => s.call);
  const ongoing = callOngoing(call);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ongoing) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [ongoing]);
  if (!call || !ongoing) return null;
  const seconds = Math.max(0, Math.floor((now - call.startedAtMs) / 1000));
  const time = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  const speaker = call.seats.find((seat) => seat.state === "speaking");
  const description = call.phase !== "live" ? t("teamCall.barClosing")
    : speaker ? t("teamCall.barSpeaking", { name: speaker.name })
    : t(call.mic ? "teamCall.barMicOn" : "teamCall.barMicOff");
  return (
    <Tooltip label={t("teamCall.barTooltip", { team: call.teamName })} description={description}>
      <button
        type="button"
        onClick={() => {
          // The call floats over whichever view is showing: going back to it is unfolding it, in
          // its workspace.
          useTeamCallStore.getState().restore();
          void followTarget(call.workspaceId, {});
        }}
        aria-label={t("teamCall.barTooltip", { team: call.teamName })}
        className="flex h-[22px] items-center gap-[6px] rounded-md px-1.5 text-[12px] font-medium text-[var(--cf-accent)] hover:bg-[var(--cf-hover)]"
      >
        <AudioLines size={13} className={speaker || call.hearing ? "animate-pulse" : ""} />
        <span className="tabular-nums">{call.phase === "live" ? `${t("teamCall.bar")} · ${time}` : t("teamCall.bar")}</span>
      </button>
    </Tooltip>
  );
}
