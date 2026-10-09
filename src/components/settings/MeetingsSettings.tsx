import { useCallback, useEffect, useState } from "react";
import { Check, Gauge, Mic, Trash2 } from "lucide-react";
import { Select } from "../common/Select";
import { Segmented } from "../common/Segmented";
import { Button } from "../common/Button";
import { Checkbox } from "../common/Checkbox";
import { PaneBlock } from "./settingsNav";
import { formatBytes } from "./localModelRow";
import {
  meetingsBench,
  meetingsDeleteVoice,
  meetingsRemoveVoices,
  meetingsRenameVoice,
  meetingsSetCloudKey,
  meetingsTestCloud,
  meetingsVoices,
  type Voice,
} from "../../lib/tauri/meetingsCommands";
import { ensureMeetingEvents, useMeetingsStore } from "../../state/meetingsStore";
import { useUiStore } from "../../state/uiStore";
import { useT } from "../../state/languageStore";
import { useConfirmStore } from "../../state/confirmStore";
import { pushErrorToast, useToastStore } from "../../state/toastStore";

/** OpenAI-compatible transcription services, by the base URL their docs give. */
const PRESETS = [
  { id: "openai", url: "https://api.openai.com/v1", model: "whisper-1" },
  { id: "groq", url: "https://api.groq.com/openai/v1", model: "whisper-large-v3-turbo" },
] as const;

const MODEL_LABEL: Record<string, string> = { tiny: "Whisper tiny", base: "Whisper base", small: "Whisper small", turbo: "Whisper large-v3 turbo" };

/**
 * «Reuniones»: where meetings are transcribed (this computer or a cloud Whisper), with which model,
 * how much of the work happens while the meeting runs, the voice separation download, the voices
 * saved, how long the audio is kept, and whether a call taking the microphone is noticed.
 *
 * The AI that writes the minutes is not set here but on its row of Tareas y prompts (Reuniones),
 * beside every other task's — and on the meeting's own AI tab, which writes that same row.
 */
export function MeetingsSettings() {
  const t = useT();
  const status = useMeetingsStore((s) => s.status);
  const settings = useMeetingsStore((s) => s.settings);
  const downloads = useMeetingsStore((s) => s.downloads);
  const save = useMeetingsStore((s) => s.saveSetting);

  useEffect(() => {
    ensureMeetingEvents();
    void useMeetingsStore.getState().refreshStatus();
    void useMeetingsStore.getState().loadSettings();
  }, []);

  if (!status) return null;
  if (!status.supported) return <p className="text-[12px] text-[var(--cf-text-muted)]">{t("meetings.settings.unsupported")}</p>;

  const installed = status.models.filter((m) => m.installed);
  const modelOptions = (auto: string) => [
    { value: "", label: auto },
    ...installed.map((m) => ({ value: m.id, label: MODEL_LABEL[m.id] ?? m.id })),
  ];

  return (
    <div className="flex flex-col">
      <PaneBlock title={t("meetings.settings.transcription")} hint={t("meetings.settings.transcriptionHint")}>
        <div className="flex flex-col gap-3">
          <div className="self-start">
            <Segmented
              size="sm"
              layoutId="cf-meetings-transcriber"
              value={settings.transcriber}
              onChange={(next) => void save("transcriber", next)}
              options={[
                { value: "local", label: t("meetings.settings.local") },
                { value: "cloud", label: t("meetings.settings.cloud") },
              ]}
            />
          </div>
          {settings.transcriber === "local" ? (
            <>
              {installed.length === 0 ? (
                <p className="text-[12px] text-[var(--cf-text-muted)]">
                  {t("meetings.settings.noModels")}{" "}
                  <button type="button" className="text-[var(--cf-accent)] hover:underline" onClick={() => useUiStore.getState().openSettingsAt("voice", "models")}>
                    {t("voice.open")}
                  </button>
                </p>
              ) : (
                <>
                  <Row label={t("meetings.settings.liveModel")}>
                    <div className="w-[260px]">
                      <Select size="sm" value={settings.liveModel} onChange={(v) => void save("liveModel", v)} options={modelOptions(t("meetings.settings.autoFast"))} />
                    </div>
                  </Row>
                  <Row label={t("meetings.settings.finalModel")}>
                    <div className="w-[260px]">
                      <Select size="sm" value={settings.finalModel} onChange={(v) => void save("finalModel", v)} options={modelOptions(t("meetings.settings.autoBest"))} />
                    </div>
                  </Row>
                  <p className="text-[11.5px] text-[var(--cf-text-muted)]">
                    {t("meetings.settings.moreModels")}{" "}
                    <button type="button" className="text-[var(--cf-accent)] hover:underline" onClick={() => useUiStore.getState().openSettingsAt("voice", "models")}>
                      {t("voice.open")}
                    </button>
                  </p>
                </>
              )}
            </>
          ) : (
            <CloudFields />
          )}
          <Row label={t("meetings.settings.vocabulary")} hint={t("meetings.settings.vocabularyHint")}>
            <VocabularyField />
          </Row>
        </div>
      </PaneBlock>

      <PaneBlock title={t("meetings.settings.mode")} hint={t("meetings.settings.modeHint")}>
        <div className="flex flex-col gap-2">
          <Row label={t("meetings.mode.label")}>
            <div className="w-[260px]">
              <Select
                size="sm"
                value={settings.mode}
                onChange={(v) => void save("mode", v)}
                options={[
                  { value: "", label: t("meetings.mode.auto", { mode: t(`meetings.mode.${settings.bench?.recommended ?? "balanced"}`) }) },
                  { value: "light", label: t("meetings.mode.light") },
                  { value: "balanced", label: t("meetings.mode.balanced") },
                  { value: "full", label: t("meetings.mode.full") },
                ]}
              />
            </div>
          </Row>
          <p className="text-[11.5px] text-[var(--cf-text-muted)]">{t(`meetings.mode.${settings.mode || settings.bench?.recommended || "balanced"}Hint`)}</p>
          <Bench />
          <Row label={t("meetings.settings.threads")} hint={t("meetings.settings.threadsHint")}>
            <div className="w-[260px]">
              <Select
                size="sm"
                value={String(settings.threads)}
                onChange={(v) => void save("threads", v)}
                options={[
                  { value: "0", label: t("meetings.settings.threadsAuto", { n: Math.max(1, Math.floor((navigator.hardwareConcurrency || 4) / 2)) }) },
                  ...Array.from({ length: Math.min(16, navigator.hardwareConcurrency || 8) }, (_, i) => ({ value: String(i + 1), label: String(i + 1) })),
                ]}
              />
            </div>
          </Row>
        </div>
      </PaneBlock>

      <PaneBlock title={t("meetings.settings.voices")} hint={t("meetings.settings.voicesHint")}>
        <div className="flex flex-col gap-2">
          {!status.voicesSupported ? (
            <p className="text-[12px] text-[var(--cf-text-muted)]">{t("meetings.settings.voicesUnsupported")}</p>
          ) : status.voicesInstalled ? (
            <div className="flex items-center gap-2 text-[12px]">
              <Check size={13} className="text-[var(--cf-success)]" />
              <span className="flex-1">{t("meetings.settings.voicesReady")}</span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  void useConfirmStore
                    .getState()
                    .ask({ message: t("meetings.settings.voicesRemoveConfirm"), confirmLabel: t("common.delete"), danger: true })
                    .then((ok) => ok && void meetingsRemoveVoices().then(() => useMeetingsStore.getState().refreshStatus()))
                }
              >
                {t("common.delete")}
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-[12px]">
              <span className="flex-1 text-[var(--cf-text-muted)]">{t("meetings.settings.voicesInstall", { size: formatBytes(status.voicesBytes) })}</span>
              {downloads.voices && downloads.voices.phase !== "done" ? (
                <>
                  <span className="tabular-nums text-[var(--cf-text-muted)]">
                    {downloads.voices.phase === "unpacking" ? t("meetings.settings.unpacking") : `${Math.round((downloads.voices.done / Math.max(1, downloads.voices.total)) * 100)} %`}
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => void useMeetingsStore.getState().cancelInstall()}>
                    {t("common.cancel")}
                  </Button>
                </>
              ) : (
                <Button size="sm" variant="secondary" onClick={() => void useMeetingsStore.getState().install("voices")}>
                  {t("meetings.settings.download")}
                </Button>
              )}
            </div>
          )}
          <VoicesList />
        </div>
      </PaneBlock>

      <PaneBlock title={t("meetings.settings.audio")} hint={t("meetings.settings.audioHint")}>
        <div className="flex flex-col gap-3">
          <Row label={t("meetings.settings.keep")}>
            <div className="w-[260px]">
              <Select
                size="sm"
                value={String(settings.audioDays)}
                onChange={(v) => void save("audioDays", v)}
                options={[
                  { value: "7", label: t("meetings.settings.days", { n: 7 }) },
                  { value: "30", label: t("meetings.settings.days", { n: 30 }) },
                  { value: "90", label: t("meetings.settings.days", { n: 90 }) },
                  { value: "0", label: t("meetings.settings.forever") },
                  { value: "-1", label: t("meetings.settings.deleteAfter") },
                ]}
              />
            </div>
          </Row>
          <label className="flex w-fit cursor-pointer items-center gap-2 text-[12.5px]">
            <Checkbox checked={settings.detect} onChange={(on) => void save("detect", on ? "1" : "0")} />
            {t("meetings.settings.detect")}
          </label>
        </div>
      </PaneBlock>
    </div>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-3">
        <span className="w-[150px] shrink-0 text-[12.5px] text-[var(--cf-text)]">{label}</span>
        {children}
      </div>
      {hint && (
        <div className="pl-[162px]">
          <p className="max-w-[60ch] text-[11.5px] leading-snug text-[var(--cf-text-muted)]">{hint}</p>
        </div>
      )}
    </div>
  );
}

function VocabularyField() {
  const t = useT();
  const stored = useMeetingsStore((s) => s.settings.vocabulary);
  const [value, setValue] = useState(stored);
  useEffect(() => setValue(stored), [stored]);
  return (
    <input
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => value !== stored && void useMeetingsStore.getState().saveSetting("vocabulary", value.trim())}
      placeholder={t("meetings.settings.vocabularyPlaceholder")}
      className="h-7 w-[360px] rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface)] px-2 text-[12.5px] outline-none focus:border-[var(--cf-accent)]"
    />
  );
}

function CloudFields() {
  const t = useT();
  const settings = useMeetingsStore((s) => s.settings);
  const hasKey = useMeetingsStore((s) => s.status?.cloudKey ?? false);
  const [url, setUrl] = useState(settings.cloudUrl);
  const [model, setModel] = useState(settings.cloudModel);
  const [key, setKey] = useState("");
  const [testing, setTesting] = useState(false);
  useEffect(() => {
    setUrl(settings.cloudUrl);
    setModel(settings.cloudModel);
  }, [settings.cloudUrl, settings.cloudModel]);
  const preset = PRESETS.find((p) => p.url === (url || PRESETS[0].url))?.id ?? "custom";
  const persist = (next: { url: string; model: string }) => void useMeetingsStore.getState().saveSetting("cloud", JSON.stringify(next));

  return (
    <div className="flex flex-col gap-2">
      <Row label={t("meetings.settings.service")}>
        <div className="w-[260px]">
          <Select
            size="sm"
            value={preset}
            onChange={(id) => {
              const found = PRESETS.find((p) => p.id === id);
              const next = found ? { url: found.url, model: found.model } : { url: "", model };
              setUrl(next.url);
              setModel(next.model);
              persist(next);
            }}
            options={[
              { value: "openai", label: "OpenAI" },
              { value: "groq", label: "Groq" },
              { value: "custom", label: t("meetings.settings.custom") },
            ]}
          />
        </div>
      </Row>
      <Row label="URL">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onBlur={() => persist({ url: url.trim(), model })}
          placeholder="https://api.openai.com/v1"
          className="h-7 w-[360px] rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface)] px-2 font-mono text-[12px] outline-none focus:border-[var(--cf-accent)]"
        />
      </Row>
      <Row label={t("meetings.settings.cloudModel")}>
        <input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          onBlur={() => persist({ url, model: model.trim() })}
          placeholder="whisper-1"
          className="h-7 w-[260px] rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface)] px-2 font-mono text-[12px] outline-none focus:border-[var(--cf-accent)]"
        />
      </Row>
      <Row label={t("meetings.settings.key")}>
        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={hasKey ? t("meetings.settings.keySaved") : "sk-…"}
          className="h-7 w-[260px] rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface)] px-2 font-mono text-[12px] outline-none focus:border-[var(--cf-accent)]"
        />
        <Button
          size="sm"
          variant="secondary"
          disabled={!key.trim()}
          onClick={() =>
            void meetingsSetCloudKey(key)
              .then(() => {
                setKey("");
                return useMeetingsStore.getState().refreshStatus();
              })
              .catch((e) => pushErrorToast(String(e)))
          }
        >
          {t("common.save")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={testing}
          onClick={() => {
            setTesting(true);
            void meetingsTestCloud()
              .then(() => useToastStore.getState().pushToast(t("meetings.settings.cloudOk"), "success"))
              .catch((e) => pushErrorToast(String(e)))
              .finally(() => setTesting(false));
          }}
        >
          {t("meetings.settings.test")}
        </Button>
      </Row>
      <p className="text-[11.5px] text-[var(--cf-text-muted)]">{t("meetings.settings.cloudHint")}</p>
    </div>
  );
}

function Bench() {
  const t = useT();
  const bench = useMeetingsStore((s) => s.settings.bench);
  const [running, setRunning] = useState(false);
  const run = useCallback(async () => {
    setRunning(true);
    try {
      await meetingsBench();
      await useMeetingsStore.getState().loadSettings();
    } catch (error) {
      pushErrorToast(String(error));
    } finally {
      setRunning(false);
    }
  }, []);
  return (
    <div className="flex flex-wrap items-center gap-2 text-[12px]">
      <Button size="sm" variant="secondary" disabled={running} onClick={() => void run()}>
        <Gauge size={12} />
        {running ? t("meetings.settings.measuring") : t("meetings.settings.measure")}
      </Button>
      {bench && (
        <span className="text-[11.5px] text-[var(--cf-text-muted)]">
          {t("meetings.settings.perPhrase", { times: bench.perUtteranceMs.map(([id, ms]) => `${id} ${(ms / 1000).toFixed(1)} s`).join(" · ") })}
          {" → "}
          {t(`meetings.mode.${bench.recommended}`)}
        </span>
      )}
    </div>
  );
}

function VoicesList() {
  const t = useT();
  const [voices, setVoices] = useState<Voice[] | null>(null);
  const reload = useCallback(() => void meetingsVoices().then(setVoices).catch(() => setVoices([])), []);
  useEffect(() => reload(), [reload]);
  if (!voices || voices.length === 0) return <p className="text-[11.5px] text-[var(--cf-text-muted)]">{t("meetings.settings.noVoices")}</p>;
  return (
    <div className="overflow-hidden rounded-lg border border-[var(--cf-border)]">
      {voices.map((voice) => (
        <div key={voice.id} className="flex items-center gap-2 border-b border-[var(--cf-border)] px-2.5 py-1.5 text-[12.5px] last:border-b-0">
          <Mic size={12} className="shrink-0 text-[var(--cf-text-muted)]" />
          <input
            defaultValue={voice.name}
            onBlur={(e) => {
              const name = e.target.value.trim();
              if (name && name !== voice.name) void meetingsRenameVoice(voice.id, name).then(reload);
            }}
            className="min-w-0 flex-1 bg-transparent outline-none"
          />
          {voice.isMe && <span className="rounded-full border border-[var(--cf-border)] px-1.5 text-[10.5px] text-[var(--cf-text-muted)]">{t("meetings.speaker.me")}</span>}
          <span className="text-[11px] text-[var(--cf-text-faint)]">{t("meetings.settings.samples", { n: voice.samples })}</span>
          <button
            type="button"
            aria-label={t("common.delete")}
            className="text-[var(--cf-text-faint)] hover:text-[var(--cf-danger)]"
            onClick={() =>
              void useConfirmStore
                .getState()
                .ask({ message: t("meetings.settings.forgetVoice", { name: voice.name }), confirmLabel: t("common.delete"), danger: true })
                .then((ok) => ok && void meetingsDeleteVoice(voice.id).then(reload))
            }
          >
            <Trash2 size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}
