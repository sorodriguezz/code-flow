import { useEffect, useState } from "react";
import { AudioLines } from "lucide-react";
import { Tooltip } from "../common/Tooltip";
import { ensureMeetingEvents, useMeetingsStore } from "../../state/meetingsStore";
import { useNotesStore } from "../../state/notesStore";
import { useUiStore } from "../../state/uiStore";
import { useT } from "../../state/languageStore";

function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}` : `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

/**
 * «Reuniones» in the bar: the meeting being recorded — a red dot and its time, from every view and
 * window — or the one being finished, with how far along it is. Nothing at all otherwise, the rule
 * `FlowsActivity` keeps. Pressing it opens the note.
 */
export function MeetingActivity() {
  const t = useT();
  const recording = useMeetingsStore((s) => s.status?.recording ?? null);
  const processing = useMeetingsStore((s) => s.status?.processing ?? null);
  const queued = useMeetingsStore((s) => s.status?.queued.length ?? 0);
  const progress = useMeetingsStore((s) => (s.status?.processing ? s.progress[s.status.processing] : undefined));
  const at = useMeetingsStore((s) => s.statusAt);
  const [now, setNow] = useState(Date.now());

  useEffect(() => ensureMeetingEvents(), []);
  useEffect(() => {
    if (!recording || recording.paused) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [recording]);

  if (!recording && !processing) return null;

  const open = (noteId: string | null) => {
    useUiStore.getState().setActiveView("notes");
    if (noteId) void useNotesStore.getState().openNote(noteId);
  };

  if (recording) {
    const elapsed = recording.paused ? recording.elapsedMs : recording.elapsedMs + Math.max(0, now - at);
    return (
      <Tooltip label={recording.paused ? t("meetings.bar.paused") : t("meetings.bar.recording")} description={t("meetings.bar.open")}>
        <button
          type="button"
          onClick={() => open(recording.noteId)}
          className="flex h-[22px] items-center gap-[5px] rounded-md px-1.5 text-[12px] tabular-nums text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]"
        >
          <span className={`h-[7px] w-[7px] rounded-full bg-[var(--cf-danger)] ${recording.paused ? "opacity-40" : "animate-pulse"}`} aria-hidden />
          {clock(elapsed)}
        </button>
      </Tooltip>
    );
  }
  const percent = progress ? Math.round(progress.fraction * 100) : null;
  return (
    <Tooltip label={t("meetings.bar.processing")} description={queued > 0 ? t("meetings.bar.queued", { n: queued }) : undefined}>
      <button
        type="button"
        onClick={() => open(null)}
        className="flex h-[22px] items-center gap-[5px] rounded-md px-1.5 text-[12px] tabular-nums text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]"
      >
        <AudioLines size={13} className="text-[var(--cf-accent)]" />
        {percent !== null ? `${percent} %` : "…"}
      </button>
    </Tooltip>
  );
}
