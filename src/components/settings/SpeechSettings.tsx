import { useCallback, useEffect, useState } from "react";
import { Play, Square } from "lucide-react";
import { Select, type SelectOption } from "../common/Select";
import { Segmented } from "../common/Segmented";
import { Checkbox } from "../common/Checkbox";
import { Button, iconButtonClass } from "../common/Button";
import { Tooltip } from "../common/Tooltip";
import { chipClass, fieldClass } from "../common/recipes";
import { ThinkingOrb } from "../common/ThinkingOrb";
import { formatBytes, ModelDownloadRow, type DownloadableModel } from "./localModelRow";
import { PaneBlock } from "./settingsNav";
import { previewNotificationSound } from "../../lib/notificationSound";
import { useShortcutChord } from "../../lib/useShortcutHint";
import type { LocalAiDownloadEvent } from "../../lib/tauri/events";
import type { DownloadableVoice, VoiceGender } from "../../lib/tauri/speechCommands";
import type { Language } from "../../lib/i18n/translations";
import { useLanguageStore, useT } from "../../state/languageStore";
import { useConfirmStore } from "../../state/confirmStore";
import { usePreferencesStore } from "../../state/preferencesStore";
import { useUiStore } from "../../state/uiStore";
import {
  ensureSpeechEvents,
  useSpeechStore,
  voiceLanguage,
  type AnswersMode,
  type CloudService,
  type SpeechEngine,
} from "../../state/speechStore";

/**
 * «Voz y sonido › Lectura en voz alta»: the voice the thinking mark speaks with, what it says, and
 * when it keeps quiet. The voices themselves are downloaded in «Modelos»; the speaker is chosen in
 * «Dispositivos»; which notifications are said is a column of «Notificaciones › Por origen».
 */

/** A row of this pane: a label (and its line) on the left, the control on the right. */
function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 py-1.5">
      <div className="flex flex-wrap items-center gap-3">
        <span className="w-[150px] shrink-0 text-[12.5px] text-[var(--cf-text)]">{label}</span>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{children}</div>
      </div>
      {hint && <p className="pl-[162px] text-[11.5px] leading-snug text-[var(--cf-text-muted)]">{hint}</p>}
    </div>
  );
}

const go = (section: "voice" | "notifications" | "appearance" | "tasks", tab: string) => useUiStore.getState().openSettingsAt(section, tab);

/** What «Probar» says: in the voice's own language, whatever the screen's — a voice is tested on its
 *  own words, so this is not a translation. */
const VOICE_SAMPLE: Record<Language, string> = {
  es: "Hola, soy el pensamiento de CodeFlow. Terminé de revisar el pull request: encontré dos problemas y una sugerencia.",
  en: "Hi, I'm CodeFlow's thinking mark. I finished reviewing the pull request: I found two problems and one suggestion.",
};

const GENDER_KEY = { female: "speech.gender.female", male: "speech.gender.male", nonbinary: "speech.gender.nonbinary" } as const;
const NATURAL_NOTE_KEY = {
  female: "speech.naturalNote.female",
  male: "speech.naturalNote.male",
  nonbinary: "speech.naturalNote.nonbinary",
} as const satisfies Record<VoiceGender, string>;

/** The app's language first, then the other. */
const languagesFrom = (first: Language): Language[] => (first === "es" ? ["es", "en"] : ["en", "es"]);

function Link({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" className="text-[var(--cf-accent)] hover:underline" onClick={onClick}>
      {children}
    </button>
  );
}

export function SpeechSettings() {
  const t = useT();
  const store = useSpeechStore();
  const spoken = usePreferencesStore((s) => s.spokenNotificationSources);
  const speaking = useSpeechStore((s) => s.speaking);
  /** From the registry, so a rebound chord reads as what it is now. */
  const chord = useShortcutChord();

  useEffect(() => {
    ensureSpeechEvents();
    if (!store.loaded) void store.load();
    void store.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const status = store.status;
  const language = useLanguageStore((s) => s.language);
  const engineHint = { system: t("speech.engineSystemHint"), local: t("speech.engineLocalHint"), cloud: t("speech.engineCloudHint") }[store.engine];

  return (
    <div>
      <div className="mb-4 flex items-center gap-3 rounded-lg border border-[var(--cf-border)] bg-[var(--cf-sunken)] px-3 py-2.5">
        <ThinkingOrb size="lg" activity={{ phase: speaking ? "speak" : "think" }} />
        <div className="min-w-0 text-[12px] leading-snug text-[var(--cf-text-muted)]">
          <span className="block text-[13px] font-medium text-[var(--cf-text)]">{t("speech.heroTitle")}</span>
          {t("speech.heroBody")} <Link onClick={() => go("appearance", "thinking")}>{t("speech.heroLink")}</Link>
        </div>
      </div>

      <PaneBlock title={t("speech.voiceBlock")}>
        <Row label={t("speech.engine")} hint={engineHint}>
          <Segmented
            size="sm"
            layoutId="cf-speech-engine"
            value={store.engine}
            onChange={(next) => void store.setEngine(next as SpeechEngine)}
            options={[
              { value: "system", label: t("speech.engineSystem") },
              ...(status?.localSupported === false ? [] : [{ value: "local", label: t("speech.engineLocal") }]),
              { value: "cloud", label: t("speech.engineCloud") },
            ]}
          />
        </Row>
        {store.engine !== "cloud" && (
          <>
            {languagesFrom(language).map((lang) => (
              <LanguageVoiceRow key={lang} lang={lang} engine={store.engine === "local" ? "local" : "system"} />
            ))}
            <p className="pb-1 pl-[162px] text-[11.5px] text-[var(--cf-text-muted)]">{t("speech.byLanguageHint")}</p>
          </>
        )}
        {store.engine === "cloud" && <CloudRows />}
        <Row label={t("speech.rate")}>
          <input
            type="range"
            min={0.6}
            max={1.8}
            step={0.05}
            value={store.rate}
            onChange={(e) => void store.setRate(Number(e.target.value))}
            aria-label={t("speech.rate")}
            className="w-[200px] accent-[var(--cf-accent)]"
          />
          <span className="w-12 text-[12px] tabular-nums text-[var(--cf-text-muted)]">{store.rate.toFixed(2).replace(".", ",")}×</span>
        </Row>
        <Row label={t("speech.volume")}>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={store.volume}
            onChange={(e) => void store.setVolume(Number(e.target.value))}
            aria-label={t("speech.volume")}
            className="w-[200px] accent-[var(--cf-accent)]"
          />
          <span className="w-12 text-[12px] tabular-nums text-[var(--cf-text-muted)]">{store.volume} %</span>
        </Row>
        <Row label="">
          <Button size="sm" variant="primary" onClick={() => store.say(VOICE_SAMPLE[language], "test", { interrupt: true })}>
            <Play size={12} />
            {t("speech.test")}
          </Button>
          <Button size="sm" variant="secondary" disabled={!speaking} onClick={() => store.stop()}>
            <Square size={11} fill="currentColor" />
            {t("speech.stop")}
          </Button>
          {speaking?.phase === "preparing" && <span className="text-[11.5px] text-[var(--cf-text-muted)]">{t("speech.preparing")}</span>}
        </Row>
      </PaneBlock>

      <PaneBlock title={t("speech.whatBlock")}>
        <Row
          label={t("speech.answers")}
          hint={store.answers === "summary" ? t("speech.answersSummaryHint") : store.answers === "full" ? t("speech.answersFullHint") : t("speech.answersNeverHint")}
        >
          <Segmented
            size="sm"
            layoutId="cf-speech-answers"
            value={store.answers}
            onChange={(next) => void store.setAnswers(next as AnswersMode)}
            options={[
              { value: "never", label: t("speech.answersNever") },
              { value: "summary", label: t("speech.answersSummary") },
              { value: "full", label: t("speech.answersFull") },
            ]}
          />
        </Row>
        {store.answers === "summary" && (
          <p className="pb-1 pl-[162px] text-[11.5px] text-[var(--cf-text-muted)]">
            {t("speech.summaryTask")} <Link onClick={() => go("tasks", "other")}>{t("task.spokenSummary")}</Link>
          </p>
        )}
        <Row label={t("speech.notifications")}>
          <span className="text-[12.5px] text-[var(--cf-text)]">{t("speech.notificationsCount", { n: spoken.length })}</span>
          <span className="text-[12.5px]">
            <Link onClick={() => go("notifications", "sources")}>{t("speech.notificationsChoose")}</Link>
          </span>
        </Row>
        <label className="flex items-start gap-2.5 py-1.5">
          <span className="mt-[1px]">
            <Checkbox checked={store.readSelection} onChange={(on) => void store.setReadSelection(on)} />
          </span>
          <span className="text-[12.5px] text-[var(--cf-text)]">
            {t("speech.readSelection")}
            <span className="mt-0.5 block text-[11.5px] text-[var(--cf-text-muted)]">{t("speech.readSelectionHint")}</span>
          </span>
        </label>
      </PaneBlock>

      <PaneBlock title={t("speech.quietBlock")}>
        <label className="flex items-start gap-2.5 py-1.5">
          <span className="mt-[1px]">
            <Checkbox checked={store.quietMeeting} onChange={(on) => void store.setQuietMeeting(on)} />
          </span>
          <span className="text-[12.5px] text-[var(--cf-text)]">{t("speech.quietMeeting")}</span>
        </label>
        <label className="flex items-start gap-2.5 py-1.5">
          <span className="mt-[1px]">
            <Checkbox checked={store.quietDictation} onChange={(on) => void store.setQuietDictation(on)} />
          </span>
          <span className="text-[12.5px] text-[var(--cf-text)]">{t("speech.quietDictation")}</span>
        </label>
        <p className="pt-1 text-[11.5px] text-[var(--cf-text-muted)]">
          {t("speech.stopShortcut", { chord: chord("speech.stop") ?? "—" })}{" "}
          <Link onClick={() => useUiStore.getState().openSettingsAt("keybindings", "general")}>{t("shortcuts.title")}</Link>
        </p>
      </PaneBlock>
    </div>
  );
}

/**
 * The voice one language is read with — a text in English gets the English one whatever the screen
 * shows (`speech::language_of`) — and a sample in that language. Empty is «Automática»: the system's
 * own voice for the language, or the first downloaded one.
 */
function LanguageVoiceRow({ lang, engine }: { lang: Language; engine: "system" | "local" }) {
  const t = useT();
  const status = useSpeechStore((s) => s.status);
  const chosen = useSpeechStore((s) => (engine === "system" ? s.systemVoices : s.localVoices)[lang]);
  const label = t(lang === "es" ? "speech.voiceEs" : "speech.voiceEn");

  let options: SelectOption[];
  let none = false;
  if (engine === "system") {
    const voices = (status?.systemVoices ?? []).filter((voice) => !voice.lang || voiceLanguage(voice.lang) === lang);
    const auto = status?.systemDefaults[lang];
    const autoName = auto ? (voices.find((voice) => voice.id === auto)?.name ?? auto) : null;
    options = [
      { value: "", label: autoName ? t("speech.automaticNamed", { name: autoName }) : t("speech.systemDefault") },
      ...voices.map((voice) => ({ value: voice.id, label: voice.name })),
    ];
  } else {
    const installed = (status?.voices ?? []).filter((voice) => voice.installed && voiceLanguage(voice.lang) === lang);
    const named = (voice: DownloadableVoice) => `${voice.label} · ${t(GENDER_KEY[voice.gender])}`;
    none = installed.length === 0;
    options = none
      ? [{ value: "", label: t("speech.noneReadsSystem") }]
      : [{ value: "", label: t("speech.automaticNamed", { name: named(installed[0]) }) }, ...installed.map((voice) => ({ value: voice.id, label: named(voice) }))];
  }
  // A choice that is gone (a voice removed, uninstalled from the system) reads as «Automática», which is what speaks.
  const value = options.some((option) => option.value === chosen) ? chosen : "";

  return (
    <Row label={label}>
      <div className="w-[300px]">
        <Select
          size="sm"
          value={value}
          onChange={(next) => void (engine === "system" ? useSpeechStore.getState().setSystemVoice(lang, next) : useSpeechStore.getState().setLocalVoice(lang, next))}
          options={options}
          disabled={none}
          ariaLabel={label}
        />
      </div>
      <Tooltip label={t("speech.test")}>
        <button
          type="button"
          aria-label={t("speech.test")}
          className={iconButtonClass({ size: "sm" })}
          onClick={() => useSpeechStore.getState().say(VOICE_SAMPLE[lang], "test", { interrupt: true })}
        >
          <Play size={12} />
        </button>
      </Tooltip>
      {engine === "local" && (
        <span className="text-[11.5px] text-[var(--cf-text-muted)]">
          {none ? t("speech.downloadFirst") : t("speech.moreVoices")} <Link onClick={() => go("voice", "models")}>{t("voice.modelsTab")}</Link>
        </span>
      )}
    </Row>
  );
}

/** The service, its voice and its key. The key goes to the keychain and is never shown again. */
function CloudRows() {
  const t = useT();
  const service = useSpeechStore((s) => s.cloudService);
  const voice = useSpeechStore((s) => s.cloudVoice);
  const keys = useSpeechStore((s) => s.status?.keys);
  const setService = useSpeechStore((s) => s.setCloudService);
  const setVoice = useSpeechStore((s) => s.setCloudVoice);
  const setKey = useSpeechStore((s) => s.setKey);
  const [draft, setDraft] = useState("");
  const [voiceDraft, setVoiceDraft] = useState(voice);
  useEffect(() => setVoiceDraft(voice), [voice]);
  const hasKey = service === "openai" ? keys?.openai : keys?.elevenlabs;

  return (
    <>
      <Row label={t("speech.service")} hint={t("speech.cloudPrivacy")}>
        <Segmented
          size="sm"
          layoutId="cf-speech-service"
          value={service}
          onChange={(next) => void setService(next as CloudService)}
          options={[
            { value: "openai", label: "OpenAI" },
            { value: "elevenlabs", label: "ElevenLabs" },
          ]}
        />
      </Row>
      <Row label={t("speech.voice")} hint={service === "openai" ? t("speech.openaiVoices") : t("speech.elevenVoices")}>
        <input
          value={voiceDraft}
          onChange={(e) => setVoiceDraft(e.target.value)}
          onBlur={() => voiceDraft.trim() !== voice && void setVoice(voiceDraft.trim())}
          placeholder={service === "openai" ? "alloy" : "21m00Tcm4TlvDq8ikWAM"}
          aria-label={t("speech.voice")}
          className={fieldClass({ size: "sm", className: "w-[260px]" })}
        />
      </Row>
      <Row label={t("speech.key")}>
        <input
          type="password"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={hasKey ? "••••••••" : t("speech.keyPlaceholder")}
          aria-label={t("speech.key")}
          autoComplete="off"
          className={fieldClass({ size: "sm", className: "w-[260px]" })}
        />
        <Button
          size="sm"
          variant="secondary"
          disabled={!draft.trim()}
          onClick={() => {
            void setKey(service, draft);
            setDraft("");
          }}
        >
          {t("common.save")}
        </Button>
        {hasKey && (
          <>
            <span className={chipClass("ok")}>{t("speech.keySaved")}</span>
            <Button size="sm" variant="ghost" onClick={() => void setKey(service, "")}>
              {t("speech.keyForget")}
            </Button>
          </>
        )}
      </Row>
    </>
  );
}

/** «Dispositivos › Altavoz»: where the voice, the tones and a meeting's playback come out. */
export function SpeakerRow() {
  const t = useT();
  const device = useSpeechStore((s) => s.device);
  const outputs = useSpeechStore((s) => s.outputs);
  const setDevice = useSpeechStore((s) => s.setDevice);
  const loadOutputs = useSpeechStore((s) => s.loadOutputs);
  const loaded = useSpeechStore((s) => s.loaded);

  const reload = useCallback(() => void loadOutputs(), [loadOutputs]);
  useEffect(() => {
    if (!loaded) void useSpeechStore.getState().load();
    reload();
    window.addEventListener("focus", reload);
    return () => window.removeEventListener("focus", reload);
  }, [reload, loaded]);

  const fallback = outputs?.find((output) => output.isDefault);
  const options: SelectOption[] = [
    { value: "", label: fallback ? t("speech.speakerDefaultNamed", { name: fallback.name }) : t("speech.speakerDefault") },
    ...(outputs ?? []).map((output) => ({ value: output.id, label: output.name })),
  ];
  if (device && outputs && !outputs.some((output) => output.id === device)) options.push({ value: device, label: t("speech.speakerAbsent") });

  return (
    <div className="flex items-center gap-3">
      <span className="w-20 shrink-0 text-[12.5px] text-[var(--cf-text)]">{t("speech.output")}</span>
      <div className="w-[320px]">
        <Select value={device} onChange={(next) => void setDevice(next)} options={options} size="sm" ariaLabel={t("speech.speaker")} />
      </div>
      <Button
        size="sm"
        variant="secondary"
        onClick={() => {
          const { notificationSoundId } = usePreferencesStore.getState();
          previewNotificationSound(notificationSoundId, 70);
        }}
      >
        <Play size={12} />
        {t("dictation.micTest")}
      </Button>
    </div>
  );
}

/** «Modelos › Para hablar»: the system's voices, and the natural ones that can be downloaded. */
export function SpeechVoicesBlock() {
  const t = useT();
  const status = useSpeechStore((s) => s.status);
  const engine = useSpeechStore((s) => s.engine);
  const localVoices = useSpeechStore((s) => s.localVoices);
  const language = useLanguageStore((s) => s.language);
  const progress = useSpeechStore((s) => s.progress);
  const installing = useSpeechStore((s) => s.installing);
  const ask = useConfirmStore((s) => s.ask);

  useEffect(() => {
    ensureSpeechEvents();
    const store = useSpeechStore.getState();
    if (!store.loaded) void store.load();
    void store.refresh();
  }, []);

  if (!status) return null;
  const counted = (lang: Language) => status.systemVoices.filter((voice) => voice.lang && voiceLanguage(voice.lang) === lang).length;
  // The voice that reads each language — the `crate::speech::local_voice` rule: the one chosen while
  // it is downloaded, else the first downloaded one of that language.
  const speaksWith = new Set<string>();
  if (engine === "local") {
    for (const lang of ["es", "en"] as const) {
      const installed = status.voices.filter((voice) => voice.installed && voiceLanguage(voice.lang) === lang);
      const id = installed.find((voice) => voice.id === localVoices[lang])?.id ?? installed[0]?.id;
      if (id) speaksWith.add(id);
    }
  }
  // The app's language first; the catalogue's own order within each.
  const order = languagesFrom(language);
  const voices = [...status.voices].sort((a, b) => order.indexOf(voiceLanguage(a.lang)) - order.indexOf(voiceLanguage(b.lang)));

  return (
    <div>
      <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]">{t("voice.speakModels")}</h3>
      <div className="overflow-hidden rounded-lg border border-[var(--cf-border)]">
        <div className="flex items-start gap-3 border-b border-[var(--cf-border)] px-3 py-2.5 last:border-b-0">
          <div className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-1.5 text-[13px] font-medium text-[var(--cf-text)]">
              {t("speech.systemVoices")}
              {engine === "system" && <span className={chipClass("accent")}>{t("speech.title")}</span>}
            </span>
            <span className="mt-0.5 block text-[11.5px] text-[var(--cf-text-muted)]">
              {t("speech.systemVoicesNote", { n: status.systemVoices.length, es: counted("es"), en: counted("en") })}
            </span>
          </div>
          <span className={chipClass("ok")}>{t("speech.included")}</span>
        </div>
        {status.localSupported &&
          voices.map((voice) => {
            const row: DownloadableModel = {
              id: voice.id,
              label: voice.label,
              tier: "light",
              params: "Piper",
              licence: voice.licence,
              size_bytes: voice.sizeBytes,
              min_ram_gb: 1,
              installed: voice.installed,
              partial_bytes: null,
            };
            const own = progress[voice.id];
            const rowProgress: LocalAiDownloadEvent | undefined = own && {
              model_id: voice.id,
              phase: own.phase === "unpacking" ? "verifying" : own.phase,
              done: own.done,
              total: own.total,
              error: own.error ?? undefined,
            };
            return (
              <ModelDownloadRow
                key={voice.id}
                model={row}
                active={false}
                progress={rowProgress}
                badge={speaksWith.has(voice.id) ? <span className={chipClass("accent")}>{t("speech.title")}</span> : undefined}
                note={
                  <span>
                    {installing === voice.id && !status.libraryInstalled
                      ? t("speech.libraryFirst", { size: formatBytes(status.libraryBytes) })
                      : t(NATURAL_NOTE_KEY[voice.gender])}
                  </span>
                }
                onDownload={() => void useSpeechStore.getState().install(voice.id)}
                onCancel={() => void useSpeechStore.getState().cancelInstall()}
                onDelete={() => {
                  void ask({
                    message: t("speech.deleteConfirm", { voice: voice.label, size: formatBytes(voice.sizeBytes) }),
                    confirmLabel: t("localai.delete"),
                    danger: true,
                  }).then((ok) => ok && void useSpeechStore.getState().remove(voice.id));
                }}
              />
            );
          })}
      </div>
      {status.localSupported && !status.libraryInstalled && (
        <p className="mt-1.5 text-[11px] text-[var(--cf-text-muted)]">{t("speech.libraryNote", { size: formatBytes(status.libraryBytes) })}</p>
      )}
      {!status.localSupported && <p className="mt-1.5 text-[11px] text-[var(--cf-text-muted)]">{t("speech.localUnsupported")}</p>}
    </div>
  );
}
