import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AudioLines,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  FileAudio,
  Lock,
  Mic,
  Monitor,
  MoreHorizontal,
  Pause,
  Play,
  RotateCcw,
  Square,
  Trash2,
  UserPlus,
  Users,
} from "lucide-react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { ContextMenu, type MenuItem } from "../../common/ContextMenu";
import { Select } from "../../common/Select";
import { Segmented } from "../../common/Segmented";
import { buttonClass } from "../../common/Button";
import { DictationWave } from "../../dictation/DictationControls";
import { ICON_BUTTON } from "../notesChrome";
import { MeetingPlayer, type PlayerHandle } from "./MeetingPlayer";
import { MeetingAi } from "./MeetingAi";
import { channelsOf, clock, duration, speakerColor, speakerName } from "./meetingLabels";
import {
  meetingsAddSpeaker,
  meetingsExportAudio,
  meetingsMergeSpeakers,
  meetingsRenameSpeaker,
  meetingsSaveVoice,
  meetingsSetLineSpeaker,
  meetingsUpdateLine,
  meetingsVoices,
  type Meeting,
  type MeetingDetail,
  type MeetingLine,
  type MeetingMode,
  type MeetingSpeaker,
  type Voice,
} from "../../../lib/tauri/meetingsCommands";
import { ensureMeetingEvents, useMeetingsStore } from "../../../state/meetingsStore";
import { useLanguageStore, useT } from "../../../state/languageStore";
import { useConfirmStore } from "../../../state/confirmStore";
import { pushErrorToast, useToastStore } from "../../../state/toastStore";

/**
 * «Reuniones» in a note: the options to start one, the bar while it records, and — once it is done
 * — the meeting itself: its audio, who spoke, what was said, and the recipes that write it up.
 *
 * Between the note's header and its toolbar, so the writing stays where it was and the meeting sits
 * above it like the note's subject. Collapsible per note: a meeting is not always what one opened
 * the note for.
 */
export const MeetingSection = memo(function MeetingSection({
  noteId,
  workspaceId,
  noteTitle,
  onInsert: insertInto,
}: {
  noteId: string;
  workspaceId: string;
  noteTitle: string;
  /** Appends Markdown to note `noteId` — one undo step. `false` when that note is not the one open. */
  onInsert: (noteId: string, markdown: string) => boolean;
}) {
  // Memoised (and the callback stable) because the editor around it re-renders on every keystroke.
  const onInsert = useCallback((markdown: string) => insertInto(noteId, markdown), [insertInto, noteId]);
  const meetings = useMeetingsStore((s) => s.byNote[noteId]);
  const recording = useMeetingsStore((s) => s.status?.recording ?? null);
  const startOpen = useMeetingsStore((s) => s.startOpenFor === noteId);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    ensureMeetingEvents();
    void useMeetingsStore.getState().loadNote(noteId);
    setSelected(null);
  }, [noteId]);

  const live = recording?.noteId === noteId ? recording : null;
  const shown = useMemo(() => {
    if (!meetings || meetings.length === 0) return null;
    return meetings.find((m) => m.id === selected) ?? meetings[meetings.length - 1];
  }, [meetings, selected]);

  return (
    <>
      {startOpen && !recording && <StartStrip noteId={noteId} workspaceId={workspaceId} />}
      {live && <RecordBar meetingId={live.meetingId} />}
      {shown && shown.id !== live?.meetingId && (
        <MeetingPanel
          meeting={shown}
          meetings={meetings ?? []}
          onSelect={setSelected}
          noteId={noteId}
          noteTitle={noteTitle}
          workspaceId={workspaceId}
          onInsert={onInsert}
        />
      )}
    </>
  );
});

const LANGUAGES = [
  { value: "es", label: "Español" },
  { value: "en", label: "English" },
  { value: "pt", label: "Português" },
  { value: "fr", label: "Français" },
  { value: "de", label: "Deutsch" },
  { value: "it", label: "Italiano" },
  { value: "auto", label: "Auto" },
];

/** The header's microphone: opens the options for this note, or shows the meeting recording. */
export function MeetingButton({ noteId }: { noteId: string }) {
  const t = useT();
  const supported = useMeetingsStore((s) => s.status?.supported ?? false);
  const recording = useMeetingsStore((s) => s.status?.recording ?? null);
  const open = useMeetingsStore((s) => s.startOpenFor === noteId);
  useEffect(() => ensureMeetingEvents(), []);
  if (!supported) return null;
  const here = recording?.noteId === noteId;
  const elsewhere = recording && !here;
  return (
    <button
      type="button"
      disabled={!!elsewhere}
      onClick={() => useMeetingsStore.getState().setStartOpen(open ? null : noteId)}
      aria-pressed={open}
      title={elsewhere ? t("meetings.busyElsewhere") : t("meetings.record")}
      aria-label={t("meetings.record")}
      className={`${ICON_BUTTON} ${open ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]" : ""} ${here ? "text-[var(--cf-danger)]" : ""} disabled:opacity-40`}
    >
      <Mic size={13} />
    </button>
  );
}

function StartStrip({ noteId, workspaceId }: { noteId: string; workspaceId: string }) {
  const t = useT();
  const appLanguage = useLanguageStore((s) => s.language);
  const settings = useMeetingsStore((s) => s.settings);
  const status = useMeetingsStore((s) => s.status);
  const [kind, setKind] = useState<"virtual" | "room">("virtual");
  const [mode, setMode] = useState<"" | MeetingMode>(settings.mode);
  const [language, setLanguage] = useState<string>(appLanguage === "en" ? "en" : "es");
  const [busy, setBusy] = useState(false);
  const recommended = settings.bench?.recommended ?? "balanced";
  const modeHint: Record<MeetingMode, string> = {
    light: t("meetings.mode.lightHint"),
    balanced: t("meetings.mode.balancedHint"),
    full: t("meetings.mode.fullHint"),
  };
  const effective: MeetingMode = mode || recommended;

  const start = async () => {
    setBusy(true);
    const ok = await useMeetingsStore.getState().start({ noteId, workspaceId, kind, mode: mode || undefined, language: language === "auto" ? "" : language });
    setBusy(false);
    if (ok) {
      useMeetingsStore.getState().setStartOpen(null);
      if (!settings.consentSeen) void useMeetingsStore.getState().saveSetting("consent", "1");
    }
  };

  const importFile = async () => {
    const picked = await open({
      multiple: false,
      filters: [{ name: t("meetings.audioFiles"), extensions: ["m4a", "mp4", "mp3", "wav", "flac", "ogg", "aac", "mov", "webm"] }],
    });
    if (typeof picked !== "string") return;
    useMeetingsStore.getState().setStartOpen(null);
    await useMeetingsStore.getState().importFile(noteId, workspaceId, picked, language === "auto" ? "" : language);
  };

  const consent = t("meetings.consentMessage");
  return (
    <div className="flex shrink-0 flex-col gap-2 border-b border-[var(--cf-border)] bg-[var(--cf-surface-2)] px-3 py-2 text-[12px]">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          size="sm"
          layoutId="cf-meeting-kind"
          value={kind}
          onChange={setKind}
          options={[
            { value: "virtual", icon: Monitor, label: t("meetings.kind.virtual"), title: t("meetings.kind.virtualHint") },
            { value: "room", icon: Users, label: t("meetings.kind.room"), title: t("meetings.kind.roomHint") },
          ]}
        />
        <div className="w-[190px]">
          <Select
            size="sm"
            value={mode}
            onChange={(next) => setMode(next as "" | MeetingMode)}
            ariaLabel={t("meetings.mode.label")}
            options={[
              { value: "", label: t("meetings.mode.auto", { mode: t(`meetings.mode.${recommended}`) }) },
              { value: "light", label: t("meetings.mode.light") },
              { value: "balanced", label: t("meetings.mode.balanced") },
              { value: "full", label: t("meetings.mode.full") },
            ]}
          />
        </div>
        <div className="w-[120px]">
          <Select size="sm" value={language} onChange={setLanguage} options={LANGUAGES} ariaLabel={t("dictation.language")} />
        </div>
        <span className="flex-1" />
        <button type="button" className={buttonClass({ variant: "ghost", size: "sm" })} onClick={() => void importFile()}>
          <FileAudio size={12} />
          {t("meetings.import")}
        </button>
        <button type="button" className={buttonClass({ variant: "ghost", size: "sm" })} onClick={() => useMeetingsStore.getState().setStartOpen(null)}>
          {t("common.cancel")}
        </button>
        <button type="button" disabled={busy || !status?.engineInstalled} className={buttonClass({ variant: "primary", size: "sm" })} onClick={() => void start()}>
          <span className="h-2 w-2 rounded-full bg-[var(--cf-danger)]" aria-hidden />
          {t("meetings.start")}
        </button>
      </div>
      <p className="text-[11.5px] text-[var(--cf-text-muted)]">{modeHint[effective]}</p>
      {!status?.engineInstalled && <p className="text-[11.5px] text-[var(--cf-warning)]">{t("meetings.needEngine")}</p>}
      {!settings.consentSeen && (
        <div className="flex items-center gap-2 text-[11.5px] text-[var(--cf-text-muted)]">
          <span className="min-w-0 flex-1">{t("meetings.consentHint")}</span>
          <button
            type="button"
            className={buttonClass({ variant: "ghost", size: "sm" })}
            onClick={() =>
              void navigator.clipboard
                .writeText(consent)
                .then(() => useToastStore.getState().pushToast(t("meetings.consentCopied"), "success"))
                .catch(() => {})
            }
          >
            <Copy size={11} />
            {t("meetings.consentCopy")}
          </button>
        </div>
      )}
    </div>
  );
}

/** The recording's own clock: the backend's elapsed time, run on locally between reads. */
function useElapsed(): number {
  const recording = useMeetingsStore((s) => s.status?.recording ?? null);
  const at = useMeetingsStore((s) => s.statusAt);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!recording || recording.paused) return;
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [recording]);
  if (!recording) return 0;
  return recording.paused ? recording.elapsedMs : recording.elapsedMs + Math.max(0, now - at);
}

function RecordBar({ meetingId }: { meetingId: string }) {
  const t = useT();
  const recording = useMeetingsStore((s) => s.status?.recording ?? null);
  const levels = useMeetingsStore((s) => s.levels);
  const lag = useMeetingsStore((s) => s.lag);
  const detail = useMeetingsStore((s) => s.details[meetingId]);
  const elapsed = useElapsed();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const meeting = detail?.meeting;
  const lines = detail?.lines ?? [];
  const speakers = detail?.speakers ?? [];
  const twoChannels = meeting ? channelsOf(meeting).includes("system") : true;

  useEffect(() => {
    const box = list.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [lines.length]);

  const paused = recording?.paused ?? false;
  const liveMode = meeting && meeting.mode !== "light";
  return (
    <div className="flex shrink-0 flex-col border-b border-[var(--cf-border)]">
      <div className="flex flex-wrap items-center gap-2 bg-[var(--cf-surface-2)] px-3 py-1.5 text-[12px]">
        <span className={`h-2 w-2 rounded-full bg-[var(--cf-danger)] ${paused ? "opacity-40" : "animate-pulse"}`} aria-hidden />
        <span className="font-medium tabular-nums">{clock(elapsed)}</span>
        <span className="flex h-4 w-[90px] items-center gap-1" title={t("meetings.channel.mic")}>
          <Mic size={11} className="shrink-0 text-[var(--cf-text-muted)]" />
          <DictationWave levels={levels.mic} max={14} />
        </span>
        {twoChannels && (
          <span className="flex h-4 w-[90px] items-center gap-1" title={t("meetings.channel.system")}>
            <Monitor size={11} className="shrink-0 text-[var(--cf-text-muted)]" />
            <DictationWave levels={levels.system} max={14} />
          </span>
        )}
        {meeting && <span className="rounded-full border border-[var(--cf-border)] px-2 text-[11px] text-[var(--cf-text-muted)]">{t(`meetings.mode.${meeting.mode}`)}</span>}
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-[var(--cf-text-muted)]">
          {lag?.behind
            ? t("meetings.liveBehind")
            : liveMode && lag && lag.ms > 3000
              ? t("meetings.liveLag", { s: Math.round(lag.ms / 1000) })
              : !liveMode
                ? t("meetings.recordOnly")
                : ""}
        </span>
        <button type="button" className={buttonClass({ variant: "ghost", size: "sm" })} onClick={() => void useMeetingsStore.getState().pause(meetingId, !paused)}>
          {paused ? <Play size={12} /> : <Pause size={12} />}
          {paused ? t("meetings.resume") : t("meetings.pause")}
        </button>
        <button type="button" className={buttonClass({ variant: "secondary", size: "sm", className: "text-[var(--cf-danger)]" })} onClick={() => void useMeetingsStore.getState().stop(meetingId)}>
          <Square size={11} fill="currentColor" />
          {t("meetings.stop")}
        </button>
        <button type="button" className={ICON_BUTTON} aria-label={t("notes.moreActions")} onClick={(e) => setMenu({ x: e.clientX, y: e.clientY })}>
          <MoreHorizontal size={13} />
        </button>
      </div>
      {liveMode && lines.length > 0 && (
        <div ref={list} className="max-h-[160px] overflow-y-auto px-3 py-1.5">
          {lines.map((line) => (
            <TranscriptLine key={line.seq} line={line} speakers={speakers} kind={meeting?.kind ?? "virtual"} />
          ))}
        </div>
      )}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            {
              label: t("meetings.discard"),
              icon: Trash2,
              danger: true,
              onClick: () => {
                void useConfirmStore
                  .getState()
                  .ask({ message: t("meetings.discardConfirm"), confirmLabel: t("meetings.discard"), danger: true })
                  .then((ok) => ok && void useMeetingsStore.getState().discard(meetingId));
              },
            },
          ]}
        />
      )}
    </div>
  );
}

function TranscriptLine({
  line,
  speakers,
  kind,
  active,
  onSeek,
  onSpeaker,
  onEdit,
}: {
  line: MeetingLine;
  speakers: MeetingSpeaker[];
  kind: Meeting["kind"];
  active?: boolean;
  onSeek?: (ms: number) => void;
  onSpeaker?: (line: MeetingLine, x: number, y: number) => void;
  onEdit?: (line: MeetingLine, text: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(line.text);
  const color = speakerColor(line.speaker, speakers);
  return (
    <div className={`group grid grid-cols-[46px_minmax(0,1fr)] gap-x-2 rounded px-1 py-[3px] text-[12.5px] leading-[1.45] ${active ? "bg-[var(--cf-accent-soft)]" : ""}`}>
      <button
        type="button"
        disabled={!onSeek}
        onClick={() => onSeek?.(line.startMs)}
        className="pt-[2px] text-left font-mono text-[10.5px] tabular-nums text-[var(--cf-text-faint)] hover:text-[var(--cf-accent)] disabled:hover:text-[var(--cf-text-faint)]"
      >
        {clock(line.startMs)}
      </button>
      <div className="min-w-0">
        <button
          type="button"
          disabled={!onSpeaker}
          onClick={(e) => onSpeaker?.(line, e.clientX, e.clientY)}
          className="mr-1.5 font-semibold"
          style={{ color }}
        >
          {speakerName(line.speaker, speakers, kind)}
        </button>
        {editing ? (
          <textarea
            autoFocus
            value={draft}
            rows={Math.max(1, Math.ceil(draft.length / 90))}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              setEditing(false);
              if (draft.trim() && draft.trim() !== line.text) onEdit?.(line, draft.trim());
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                e.currentTarget.blur();
              }
              if (e.key === "Escape") {
                setDraft(line.text);
                setEditing(false);
              }
            }}
            className="w-full resize-none rounded border border-[var(--cf-border)] bg-[var(--cf-surface)] px-1.5 py-0.5 text-[12.5px] outline-none focus:border-[var(--cf-accent)]"
          />
        ) : (
          <span
            onDoubleClick={() => {
              if (!onEdit) return;
              setDraft(line.text);
              setEditing(true);
            }}
            className={`${line.pass === "live" && !onEdit ? "text-[var(--cf-text-muted)]" : "text-[var(--cf-text)]"} cursor-text select-text`}
          >
            {line.text}
          </span>
        )}
      </div>
    </div>
  );
}

const STAGES: Record<string, string> = {
  stopping: "meetings.stage.stopping",
  decode: "meetings.stage.decode",
  detect: "meetings.stage.detect",
  transcribe: "meetings.stage.transcribe",
  voices: "meetings.stage.voices",
  finish: "meetings.stage.finish",
  compress: "meetings.stage.compress",
};

function MeetingPanel({
  meeting,
  meetings,
  onSelect,
  noteId,
  noteTitle,
  workspaceId,
  onInsert,
}: {
  meeting: Meeting;
  meetings: Meeting[];
  onSelect: (id: string) => void;
  noteId: string;
  noteTitle: string;
  workspaceId: string;
  onInsert: (markdown: string) => boolean;
}) {
  const t = useT();
  const language = useLanguageStore((s) => s.language);
  const detail: MeetingDetail | undefined = useMeetingsStore((s) => s.details[meeting.id]);
  const progress = useMeetingsStore((s) => s.progress[meeting.id]);
  const collapsed = useMeetingsStore((s) => !!s.collapsed[noteId]);
  const voicesInstalled = useMeetingsStore((s) => s.status?.voicesInstalled ?? false);
  const [tab, setTab] = useState<"transcript" | "ai">("transcript");
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [position, setPosition] = useState(0);
  const [renaming, setRenaming] = useState<string | null>(null);
  const player = useRef<PlayerHandle>(null);
  const lines = detail?.lines ?? [];
  const speakers = detail?.speakers ?? [];
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!detail) void useMeetingsStore.getState().loadDetail(meeting.id);
  }, [detail, meeting.id]);

  const reload = () => void useMeetingsStore.getState().loadDetail(meeting.id);
  const busy = meeting.status === "queued" || meeting.status === "processing";
  const activeSeq = useMemo(() => {
    let found: number | null = null;
    for (const line of lines) {
      if (line.startMs <= position) found = line.seq;
      else break;
    }
    return found;
  }, [lines, position]);

  const speakerMenu = async (key: string, x: number, y: number) => {
    const voices: Voice[] = await meetingsVoices().catch(() => []);
    const speaker = speakers.find((s) => s.key === key);
    const others = speakers.filter((s) => s.key !== key);
    const name = speakerName(key, speakers, meeting.kind);
    const items: MenuItem[] = [
      { label: t("meetings.rename"), icon: Users, onClick: () => setRenaming(key) },
    ];
    if (speaker?.hasVoice) {
      items.push({
        label: t("meetings.saveVoice"),
        icon: Mic,
        onClick: () => {},
        children: [
          ...(speaker.name.trim() || key === "me"
            ? [
                {
                  label: key === "me" ? t("meetings.saveAsMe") : t("meetings.saveAsNew", { name }),
                  onClick: () =>
                    void meetingsSaveVoice({ meetingId: meeting.id, key, name: key === "me" ? t("meetings.speaker.me") : name, isMe: key === "me" })
                      .then(() => {
                        useToastStore.getState().pushToast(t("meetings.voiceSaved", { name }), "success");
                        reload();
                      })
                      .catch((e) => pushErrorToast(String(e))),
                },
              ]
            : [{ label: t("meetings.nameFirst"), onClick: () => setRenaming(key) }]),
          ...(key !== "me"
            ? [
                {
                  label: t("meetings.thisIsMe"),
                  onClick: () =>
                    void meetingsSaveVoice({ meetingId: meeting.id, key, name: t("meetings.speaker.me"), isMe: true })
                      .then(reload)
                      .catch((e) => pushErrorToast(String(e))),
                },
              ]
            : []),
          ...voices.map((voice) => ({
            label: t("meetings.addToVoice", { name: voice.name }),
            onClick: () =>
              void meetingsSaveVoice({ meetingId: meeting.id, key, name: voice.name, isMe: voice.isMe, voiceId: voice.id })
                .then(() => {
                  useToastStore.getState().pushToast(t("meetings.voiceSaved", { name: voice.name }), "success");
                  reload();
                })
                .catch((e) => pushErrorToast(String(e))),
          })),
        ],
      });
    }
    if (others.length > 0) {
      items.push({
        label: t("meetings.mergeInto"),
        icon: Users,
        onClick: () => {},
        children: others.map((other) => ({
          label: speakerName(other.key, speakers, meeting.kind),
          onClick: () => void meetingsMergeSpeakers(meeting.id, key, other.key).then(reload).catch((e) => pushErrorToast(String(e))),
        })),
      });
    }
    setMenu({ x, y, items });
  };

  const lineSpeakerMenu = (line: MeetingLine, x: number, y: number) => {
    const items: MenuItem[] = speakers
      .filter((s) => s.key !== line.speaker)
      .map((s) => ({
        label: speakerName(s.key, speakers, meeting.kind),
        onClick: () => void meetingsSetLineSpeaker(meeting.id, line.seq, s.key).then(reload).catch((e) => pushErrorToast(String(e))),
      }));
    items.push({
      label: t("meetings.newPerson"),
      icon: UserPlus,
      separated: items.length > 0,
      onClick: () =>
        void meetingsAddSpeaker(meeting.id)
          .then((key) => meetingsSetLineSpeaker(meeting.id, line.seq, key))
          .then(reload)
          .catch((e) => pushErrorToast(String(e))),
    });
    setMenu({ x, y, items });
  };

  const actions = (x: number, y: number) => {
    const counts = [0, 2, 3, 4, 5, 6, 8];
    const items: MenuItem[] = [
      {
        label: t("meetings.retranscribe"),
        icon: RotateCcw,
        disabled: busy || !meeting.audioFile,
        onClick: () => void useMeetingsStore.getState().reprocess(meeting.id, true, meeting.speakersHint),
      },
      {
        label: t("meetings.reseparate"),
        icon: Users,
        disabled: busy || !meeting.audioFile || !voicesInstalled,
        onClick: () => {},
        children: counts.map((n) => ({
          label: n === 0 ? t("meetings.peopleUnknown") : t("meetings.people", { n }),
          onClick: () => void useMeetingsStore.getState().reprocess(meeting.id, false, n),
        })),
      },
      {
        label: t("meetings.exportAudio"),
        icon: Download,
        disabled: !meeting.audioFile,
        onClick: () =>
          void save({ defaultPath: `${(noteTitle || "reunion").replace(/[\\/:*?"<>|]/g, "-")}.${meeting.audioFile.split(".").pop() ?? "m4a"}` })
            .then((path) => (path ? meetingsExportAudio(meeting.id, path) : undefined))
            .catch((e) => pushErrorToast(String(e))),
      },
      {
        label: t("meetings.delete"),
        icon: Trash2,
        danger: true,
        separated: true,
        onClick: () =>
          void useConfirmStore
            .getState()
            .ask({ message: t("meetings.deleteConfirm"), confirmLabel: t("meetings.delete"), danger: true })
            .then((ok) => ok && void useMeetingsStore.getState().remove(meeting.id)),
      },
    ];
    setMenu({ x, y, items });
  };

  const started = new Date(meeting.startedAt);
  const when = Number.isNaN(started.getTime()) ? "" : started.toLocaleString(language, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const statusLine = busy
    ? `${t((STAGES[progress?.stage ?? meeting.stage] ?? "meetings.stage.queued") as Parameters<typeof t>[0])}${progress ? ` ${Math.round(progress.fraction * 100)} %` : ""}`
    : meeting.status === "failed"
      ? meeting.error === "cancelled"
        ? t("meetings.cancelled")
        : t("meetings.failed")
      : meeting.status === "interrupted"
        ? t("meetings.interrupted")
        : "";

  return (
    <div className="flex shrink-0 flex-col border-b border-[var(--cf-border)]">
      <div className="flex items-center gap-1.5 px-3 py-1.5 text-[12px]">
        <button type="button" className={ICON_BUTTON} aria-label={collapsed ? t("meetings.expand") : t("meetings.collapse")} onClick={() => useMeetingsStore.getState().toggleCollapsed(noteId)}>
          {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
        </button>
        <AudioLines size={13} className="shrink-0 text-[var(--cf-text-muted)]" />
        <span className="font-medium">{t("meetings.title")}</span>
        <span className="text-[var(--cf-text-muted)]">
          {when}
          {meeting.durationMs > 0 ? ` · ${duration(meeting.durationMs)}` : ""}
        </span>
        {detail?.localOnly && (
          <span className="flex items-center gap-1 rounded-full border border-[var(--cf-border)] px-1.5 text-[10.5px] text-[var(--cf-text-muted)]" title={t("meetings.localOnlyHint")}>
            <Lock size={9} />
            {t("meetings.localOnly")}
          </span>
        )}
        {meetings.length > 1 && (
          <div className="w-[150px]">
            <Select
              size="sm"
              value={meeting.id}
              onChange={onSelect}
              ariaLabel={t("meetings.which")}
              options={meetings.map((m, index) => ({ value: m.id, label: t("meetings.nth", { n: index + 1 }) }))}
            />
          </div>
        )}
        <span className={`min-w-0 flex-1 truncate text-[11.5px] ${meeting.status === "failed" && meeting.error !== "cancelled" ? "text-[var(--cf-danger)]" : "text-[var(--cf-text-muted)]"}`} title={meeting.error || undefined}>
          {statusLine}
        </span>
        {busy && (
          <button type="button" className={buttonClass({ variant: "ghost", size: "sm" })} onClick={() => void import("../../../lib/tauri/meetingsCommands").then(({ meetingsCancelJob }) => meetingsCancelJob(meeting.id))}>
            {t("common.cancel")}
          </button>
        )}
        {(meeting.status === "failed" || meeting.status === "interrupted") && (
          <button type="button" className={buttonClass({ variant: "secondary", size: "sm" })} onClick={() => void useMeetingsStore.getState().reprocess(meeting.id, meeting.status === "interrupted", meeting.speakersHint)}>
            {meeting.status === "interrupted" ? t("meetings.processRecorded") : t("meetings.retry")}
          </button>
        )}
        <button type="button" className={ICON_BUTTON} aria-label={t("notes.moreActions")} onClick={(e) => actions(e.clientX, e.clientY)}>
          <MoreHorizontal size={13} />
        </button>
      </div>

      {!collapsed && (
        <div className="flex flex-col gap-1.5 px-3 pb-2">
          {busy && progress && (
            <div className="h-[3px] overflow-hidden rounded-full bg-[var(--cf-border)]">
              <div className="h-full bg-[var(--cf-accent)] transition-[width]" style={{ width: `${Math.round(progress.fraction * 100)}%` }} />
            </div>
          )}
          {meeting.audioFile && <MeetingPlayer ref={player} meeting={meeting} lines={lines} speakers={speakers} onPosition={setPosition} />}
          {speakers.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              {speakers
                .filter((s) => lines.some((l) => l.speaker === s.key))
                .map((s) =>
                  renaming === s.key ? (
                    <RenameField
                      key={s.key}
                      initial={s.name || speakerName(s.key, speakers, meeting.kind)}
                      onDone={(name) => {
                        setRenaming(null);
                        if (name !== null) void meetingsRenameSpeaker(meeting.id, s.key, name).then(reload).catch((e) => pushErrorToast(String(e)));
                      }}
                    />
                  ) : (
                    <button
                      key={s.key}
                      type="button"
                      onClick={(e) => void speakerMenu(s.key, e.clientX, e.clientY)}
                      className="flex items-center gap-1.5 rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface)] px-2 py-[2px] text-[12px] hover:border-[var(--cf-border-strong)]"
                      title={s.voiceId ? t("meetings.knownVoice") : undefined}
                    >
                      <span className="h-2 w-2 rounded-[3px]" style={{ background: speakerColor(s.key, speakers) }} aria-hidden />
                      {speakerName(s.key, speakers, meeting.kind)}
                      {s.voiceId && <Mic size={9} className="text-[var(--cf-text-faint)]" />}
                      <span className="font-mono text-[10.5px] text-[var(--cf-text-faint)]">{duration(s.talkMs)}</span>
                    </button>
                  ),
                )}
            </div>
          )}
          {lines.length > 0 && (
            <>
              <div className="mt-0.5 flex items-center gap-2">
                <Segmented
                  size="sm"
                  layoutId={`cf-meeting-tab-${meeting.id}`}
                  value={tab}
                  onChange={setTab}
                  options={[
                    { value: "transcript", label: t("meetings.tab.transcript") },
                    { value: "ai", label: t("meetings.tab.ai") },
                  ]}
                />
                <span className="text-[11px] text-[var(--cf-text-faint)]">{tab === "transcript" ? t("meetings.editHint") : ""}</span>
              </div>
              {tab === "transcript" ? (
                <div ref={listRef} className="max-h-[34vh] min-h-[60px] overflow-y-auto rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface)] p-1">
                  {lines.map((line) => (
                    <TranscriptLine
                      key={line.seq}
                      line={line}
                      speakers={speakers}
                      kind={meeting.kind}
                      active={line.seq === activeSeq && position > 0}
                      onSeek={meeting.audioFile ? (ms) => player.current?.seek(ms, true) : undefined}
                      onSpeaker={lineSpeakerMenu}
                      onEdit={(l, text) => void meetingsUpdateLine(meeting.id, l.seq, text).then(reload).catch((e) => pushErrorToast(String(e)))}
                    />
                  ))}
                </div>
              ) : (
                <MeetingAi meeting={meeting} detail={detail!} noteTitle={noteTitle} workspaceId={workspaceId} onInsert={onInsert} onSeek={(ms) => player.current?.seek(ms, true)} />
              )}
            </>
          )}
        </div>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}

function RenameField({ initial, onDone }: { initial: string; onDone: (name: string | null) => void }) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const finish = (name: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(name);
  };
  return (
    <input
      autoFocus
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={() => finish(value.trim())}
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(value.trim());
        if (e.key === "Escape") finish(null);
      }}
      className="h-[22px] w-[140px] rounded-md border border-[var(--cf-accent)] bg-[var(--cf-surface)] px-1.5 text-[12px] outline-none"
    />
  );
}
