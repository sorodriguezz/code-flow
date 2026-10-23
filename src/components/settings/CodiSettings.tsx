import { useEffect, useState, type ReactNode } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, Play, RotateCcw, ShieldCheck, X } from "lucide-react";
import { Select, type SelectOption } from "../common/Select";
import { Segmented } from "../common/Segmented";
import { Button, Kbd, iconButtonClass } from "../common/Button";
import { Tooltip } from "../common/Tooltip";
import { fieldClass } from "../common/recipes";
import { ThinkingOrb } from "../common/ThinkingOrb";
import { ChatModelPicker } from "../ai/ChatModelPicker";
import { PaneBlock, RailSection } from "./settingsNav";
import { localErrorText, modelLabelOf } from "./LocalModelSettings";
import { openCodi } from "../codi/openCodi";
import { speechSay, type DownloadableVoice } from "../../lib/tauri/speechCommands";
import {
  codiForget,
  codiForgetAll,
  codiPttHotkey,
  codiRecollections,
  codiSetAtLogin,
  codiSetPttHotkey,
  codiSuspendPttHotkey,
  codiWindowToCorner,
  desktopAskPermission,
  desktopPermissions,
  type CodiRecollection,
  type DesktopPermissions,
} from "../../lib/tauri/codiCommands";
import { CodiRoutines } from "./CodiRoutines";
import { confirmAction } from "../../state/confirmStore";
import { acceleratorFromKey, acceleratorKeycaps } from "../../lib/globalHotkey";
import { isMac } from "../../lib/platform";
import { useShortcutChord } from "../../lib/useShortcutHint";
import type { Language, TranslationKey } from "../../lib/i18n/translations";
import { useCodiStore, type CodiBrain, type CodiMode } from "../../state/codiStore";
import { useDictationStore } from "../../state/dictationStore";
import { ensureSpeechEvents, useSpeechStore, voiceLanguage } from "../../state/speechStore";
import { useVoiceFitStore } from "../../state/voiceFitStore";
import { useLanguageStore, useT } from "../../state/languageStore";
import { useLocalExecStore } from "../../state/localExecStore";
import { billions, SMALL_MODEL_B, tidyNames } from "../../lib/codi/settings";
import { useUiStore } from "../../state/uiStore";
import { pushErrorToast } from "../../state/toastStore";

/**
 * «IA › Codi»: how the voice assistant listens (by its name, as a conversation, or while
 * a key is held — and with which model), what thinks for it (its own router, the local model, the
 * provider), and the voice it answers in. The microphone and sound switches are its window's; the
 * listening models are downloaded in «Modelos», and its voice falls back to the reading aloud's.
 */

/** A row of this pane: a label on the left, the control on the right — `SpeechSettings`' layout. */
function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
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

function Link({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className="text-[var(--cf-accent)] hover:underline" onClick={onClick}>
      {children}
    </button>
  );
}

const go = (section: "voice" | "claude" | "keybindings", tab: string) => useUiStore.getState().openSettingsAt(section, tab);

const MODE_HINT: Record<CodiMode, TranslationKey> = {
  wake: "codi.settings.modeWakeHint",
  conversation: "codi.settings.modeConversationHint",
  ptt: "codi.settings.modePttHint",
};

const BRAIN_HINT: Record<CodiBrain, TranslationKey> = {
  tiers: "codi.settings.brainTiersHint",
  provider: "codi.settings.brainProviderHint",
  local: "codi.settings.brainLocalHint",
};

/** What ▶ says: in the voice's own language, whatever the screen's. */
const VOICE_SAMPLE: Record<Language, string> = {
  es: "Hola, soy Codi. Listo, abrí Flujos.",
  en: "Hi, I'm Codi. Done, I opened Flows.",
};

const GENDER_KEY = { female: "speech.gender.female", male: "speech.gender.male", nonbinary: "speech.gender.nonbinary" } as const;

/** Codi's panes (Settings › IA › Codi), one per tab of `settingsCatalog`'s «codi» section. */
export type CodiTab = "listen" | "brain" | "voice" | "desktop" | "routines" | "privacy";

/**
 * «IA › Codi»: a section of its own since 2026-10-22 (user: «deja Codi dentro de IA como un menú
 * principal y lo de adentro como submenús, ya que Codi puede crecer un montón») — it was the last
 * pane of «Voz y sonido».
 */
export function CodiSection() {
  const t = useT();
  return (
    <RailSection section="codi" title={t("codi.settings.title")} hint={t("codi.settings.hint")} fallback="listen">
      {(tab) => <CodiSettings tab={tab as CodiTab} />}
    </RailSection>
  );
}

export function CodiSettings({ tab }: { tab: CodiTab }) {
  const t = useT();
  const settings = useCodiStore((s) => s.settings);
  const loaded = useCodiStore((s) => s.settingsLoaded);
  const listening = useCodiStore((s) => s.state?.listenModel ?? "");
  const setValue = useCodiStore((s) => s.setSettingValue);
  const dictation = useDictationStore((s) => s.status);
  const recommended = useVoiceFitStore((s) => s.fit?.picks.codi);
  const language = useLanguageStore((s) => s.language);
  const chord = useShortcutChord();
  const [wakeDraft, setWakeDraft] = useState(settings.wakeWords);
  useEffect(() => setWakeDraft(settings.wakeWords), [settings.wakeWords]);

  useEffect(() => {
    const codi = useCodiStore.getState();
    void codi.load();
    void codi.loadSettings();
    void useDictationStore.getState().load();
    void useVoiceFitStore.getState().load();
    ensureSpeechEvents();
    const speech = useSpeechStore.getState();
    if (!speech.loaded) void speech.load();
    void speech.refresh();
  }, []);

  const listeners = (dictation?.models ?? []).filter((model) => model.installed && model.features.includes("codi"));
  const nameOf = (id: string) => dictation?.models.find((model) => model.id === id)?.label ?? id;
  const listenOptions: SelectOption[] = [
    {
      value: "",
      label: recommended ? t("codi.settings.listenRecommended", { name: nameOf(recommended) }) : t("codi.settings.listenRecommendedPlain"),
    },
    ...listeners.map((model) => ({ value: model.id, label: model.label })),
  ];
  const listenValue = listeners.some((model) => model.id === settings.listenModel) ? settings.listenModel : "";

  return (
    <div>
{tab === "listen" && (
        <>
      <div className="mb-4 flex items-center gap-3 rounded-lg border border-[var(--cf-border)] bg-[var(--cf-sunken)] px-3 py-2.5">
        <ThinkingOrb size="lg" activity={{ phase: "listen" }} />
        <div className="min-w-0 flex-1 text-[12px] leading-snug text-[var(--cf-text-muted)]">
          <span className="block text-[13px] font-medium text-[var(--cf-text)]">{t("codi.settings.heroTitle")}</span>
          {t("codi.settings.heroBody")}
        </div>
        <Button size="sm" variant="primary" onClick={openCodi}>
          {t("codi.settings.open")}
        </Button>
      </div>

      <PaneBlock title={t("codi.settings.listenBlock")}>
        <Row label={t("codi.settings.mode")} hint={t(MODE_HINT[settings.mode])}>
          <Segmented
            size="sm"
            layoutId="cf-codi-mode"
            value={settings.mode}
            onChange={(next) => void setValue("mode", next)}
            ariaLabel={t("codi.settings.mode")}
            options={[
              { value: "wake", label: t("codi.settings.modeWake") },
              { value: "conversation", label: t("codi.settings.modeConversation") },
              { value: "ptt", label: t("codi.settings.modePtt") },
            ]}
          />
        </Row>
        {settings.mode === "ptt" && <PttKeyRow />}
        {settings.mode === "wake" && (
          <Row label={t("codi.settings.wakeWords")} hint={t("codi.settings.wakeWordsHint")}>
            <input
              value={wakeDraft}
              onChange={(event) => setWakeDraft(event.target.value)}
              onBlur={() => wakeDraft.trim() !== settings.wakeWords && void setValue("wakeWords", tidyNames(wakeDraft))}
              onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
              placeholder={t("codi.settings.wakeWordsPlaceholder")}
              aria-label={t("codi.settings.wakeWords")}
              disabled={!loaded}
              className={fieldClass({ size: "sm", className: "w-[260px]" })}
            />
          </Row>
        )}
        <Row
          label={t("codi.settings.listenModel")}
          hint={
            <>
              {listening ? `${t("codi.settings.listenNow", { name: nameOf(listening) })} ` : ""}
              {listeners.length === 0 && !listening ? t("codi.settings.listenNone") : t("codi.settings.listenModelsIn")}{" "}
              <Link onClick={() => go("voice", "models")}>{t("codi.settings.voiceModels")}</Link>
            </>
          }
        >
          <div className="w-[300px]">
            <Select
              size="sm"
              value={listenValue}
              onChange={(next) => void setValue("listenModel", next)}
              options={listenOptions}
              ariaLabel={t("codi.settings.listenModel")}
            />
          </div>
        </Row>
      </PaneBlock>

        </>
      )}

      {tab === "brain" && (
        <>
      <PaneBlock title={t("codi.settings.brainBlock")}>
        <Row label={t("codi.settings.brain")} hint={t(BRAIN_HINT[settings.brain])}>
          <Segmented
            size="sm"
            layoutId="cf-codi-brain"
            value={settings.brain}
            onChange={(next) => void setValue("brain", next)}
            ariaLabel={t("codi.settings.brain")}
            options={[
              { value: "tiers", label: t("codi.settings.brainTiers") },
              { value: "provider", label: t("codi.settings.brainProvider") },
              { value: "local", label: t("codi.settings.brainLocal") },
            ]}
          />
        </Row>
        <Row label={t("codi.settings.background")} hint={t("codi.settings.backgroundHint")}>
          <Segmented
            size="sm"
            layoutId="cf-codi-background"
            value={settings.background}
            onChange={(next) => void setValue("background", next)}
            ariaLabel={t("codi.settings.background")}
            options={[
              { value: "on", label: t("codi.settings.backgroundOn") },
              { value: "off", label: t("codi.settings.backgroundOff") },
            ]}
          />
        </Row>
        {settings.brain !== "local" && (
          <Row label={t("codi.settings.provider")} hint={t("codi.settings.providerHint")}>
            <ChatModelPicker task="codi" liveModel={null} chatActive={false} />
          </Row>
        )}
        {settings.brain !== "provider" && <LocalBrainRow />}
      </PaneBlock>

        </>
      )}

      {tab === "desktop" && (
        <>
      <PaneBlock title={t("codi.settings.desktopBlock")}>
        <Row label={t("codi.settings.atLogin")} hint={t("codi.settings.atLoginHint")}>
          <Segmented
            size="sm"
            layoutId="cf-codi-at-login"
            value={settings.atLogin}
            onChange={(next) => {
              useCodiStore.setState((s) => ({ settings: { ...s.settings, atLogin: next } }));
              void codiSetAtLogin(next === "on").catch((error) => {
                pushErrorToast(String(error));
                void useCodiStore.getState().loadSettings();
              });
            }}
            ariaLabel={t("codi.settings.atLogin")}
            options={[
              { value: "on", label: t("codi.settings.atLoginOn") },
              { value: "off", label: t("codi.settings.atLoginOff") },
            ]}
          />
        </Row>
        <Row label={t("codi.settings.position")} hint={t("codi.settings.positionHint")}>
          <Button size="sm" onClick={() => void codiWindowToCorner().catch((error) => pushErrorToast(String(error)))}>
            {t("codi.settings.toCorner")}
          </Button>
        </Row>
        <ReadAppsRows />
      </PaneBlock>

        </>
      )}

      {tab === "routines" && (
        <>
      <PaneBlock title={t("codi.routines.block")}>
        <CodiRoutines />
      </PaneBlock>

        </>
      )}

      {tab === "voice" && (
        <>
      <PaneBlock title={t("codi.settings.voiceBlock")} hint={t("codi.settings.voiceHint")}>
        {(language === "es" ? (["es", "en"] as const) : (["en", "es"] as const)).map((lang) => (
          <VoiceRow key={lang} lang={lang} />
        ))}
      </PaneBlock>

        </>
      )}

      {tab === "privacy" && (
        <>
      <PaneBlock title={t("codi.settings.memoryBlock")}>
        <MemoryRow />
      </PaneBlock>

      <PaneBlock title={t("codi.settings.privacyBlock")}>
        <ul className="flex flex-col gap-1.5 text-[12px] leading-snug text-[var(--cf-text-muted)]">
          {(["codi.settings.privacyLocal", "codi.settings.privacyProvider", "codi.settings.privacyConfirm", "codi.settings.privacySeen"] as const).map((key) => (
            <li key={key} className="flex items-start gap-2">
              <ShieldCheck size={13} className="mt-[1px] shrink-0 text-[var(--cf-success)]" />
              <span>{t(key)}</span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-[11.5px] text-[var(--cf-text-muted)]">
          {t("codi.settings.shortcut", { chord: chord("codi.open") ?? "—" })}{" "}
          <Link onClick={() => go("keybindings", "general")}>{t("shortcuts.title")}</Link>
        </p>
      </PaneBlock>
        </>
      )}
    </div>
  );
}

/**
 * Whether Codi reads other apps' windows (Teams, Outlook…) and who may see what it reads — and, on
 * macOS, the two permissions that takes: Accessibility for the text, Screen Recording for the
 * screenshot it falls back to (read and deleted at once). Re-read when the window regains focus,
 * which is when the user comes back from System Settings.
 */
function ReadAppsRows() {
  const t = useT();
  const mode = useCodiStore((s) => s.settings.readApps);
  const setValue = useCodiStore((s) => s.setSettingValue);
  const [granted, setGranted] = useState<DesktopPermissions | null>(null);
  useEffect(() => {
    const refresh = () => void desktopPermissions().then(setGranted).catch(() => {});
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);
  if (granted && !granted.supported) return null;
  const permission = (kind: "accessibility" | "screen", ok: boolean, label: string) => (
    <span className="flex items-center gap-1.5 text-[12px] text-[var(--cf-text)]">
      {label}
      {ok ? (
        <span className="text-[var(--cf-success)]">{t("codi.settings.permissionGranted")}</span>
      ) : (
        <Button size="sm" onClick={() => void desktopAskPermission(kind).catch((error) => pushErrorToast(String(error)))}>
          {t("codi.settings.permissionGrant")}
        </Button>
      )}
    </span>
  );
  return (
    <>
      <Row label={t("codi.settings.readApps")} hint={t("codi.settings.readAppsHint")}>
        <Segmented
          size="sm"
          layoutId="cf-codi-read-apps"
          value={mode}
          onChange={(next) => void setValue("readApps", next)}
          ariaLabel={t("codi.settings.readApps")}
          options={[
            { value: "on", label: t("codi.settings.readAppsOn") },
            { value: "local", label: t("codi.settings.readAppsLocal") },
            { value: "off", label: t("codi.settings.readAppsOff") },
          ]}
        />
      </Row>
      {isMac() && mode !== "off" && granted && (
        <Row label={t("codi.settings.permissions")} hint={t("codi.settings.permissionsHint")}>
          {permission("accessibility", granted.accessibility, t("codi.settings.permissionAccessibility"))}
          {permission("screen", granted.screen, t("codi.settings.permissionScreen"))}
        </Row>
      )}
    </>
  );
}

/**
 * Whether Codi carries a session over to the next — one short recollection a session, found by
 * meaning when the knowledge index has a local embedding model — how many it keeps, and the button
 * that forgets them all.
 */
function MemoryRow() {
  const t = useT();
  const language = useLanguageStore((s) => s.language);
  const remember = useCodiStore((s) => s.settings.remember);
  const setValue = useCodiStore((s) => s.setSettingValue);
  const [kept, setKept] = useState<CodiRecollection[] | null>(null);
  const [shown, setShown] = useState(false);
  const reload = () => void codiRecollections().then(setKept).catch(() => setKept(null));
  useEffect(reload, []);
  const count = kept?.length ?? null;
  const forget = async () => {
    if (!(await confirmAction(t("codi.settings.forgetConfirm"), true, t("codi.settings.forgetAll")))) return;
    try {
      await codiForgetAll();
    } catch (error) {
      pushErrorToast(String(error));
    }
    reload();
  };
  const forgetOne = async (id: number) => {
    try {
      await codiForget(id);
    } catch (error) {
      pushErrorToast(String(error));
    }
    reload();
  };
  const when = (at: number) =>
    new Date(at * 1000).toLocaleString(language === "es" ? "es-CL" : "en-US", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  return (
    <>
      <Row label={t("codi.settings.remember")} hint={t("codi.settings.rememberHint")}>
        <Segmented
          size="sm"
          layoutId="cf-codi-remember"
          value={remember}
          onChange={(next) => void setValue("remember", next)}
          ariaLabel={t("codi.settings.remember")}
          options={[
            { value: "on", label: t("codi.settings.rememberOn") },
            { value: "off", label: t("codi.settings.rememberOff") },
          ]}
        />
        {count !== null && <span className="text-[11.5px] tabular-nums text-[var(--cf-text-muted)]">{t("codi.settings.recollections", { n: count })}</span>}
        <Button size="sm" variant="secondary" disabled={!count} onClick={() => void forget()}>
          {t("codi.settings.forgetAll")}
        </Button>
      </Row>
      {/* What is kept, newest first: the user sees exactly what a later session may be reminded of,
          and can drop one without dropping the rest. */}
      {!!count && (
        <div className="pl-[162px]">
          <button
            type="button"
            aria-expanded={shown}
            onClick={() => setShown(!shown)}
            className="flex items-center gap-1 text-[11.5px] text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
          >
            {shown ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            {t("codi.settings.recollectionsShow")}
          </button>
          {shown && (
            <ul className="mt-1.5 flex max-h-[360px] flex-col gap-1.5 overflow-y-auto pr-1">
              {kept!.map((item) => (
                <li key={item.id} className="group flex items-start gap-2 rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface)] px-2.5 py-1.5">
                  <div className="min-w-0 flex-1">
                    <div className="text-[10.5px] tabular-nums text-[var(--cf-text-faint)]">{when(item.at)}</div>
                    <p className="whitespace-pre-wrap break-words text-[11.5px] leading-snug text-[var(--cf-text-muted)]">{item.text}</p>
                  </div>
                  <Tooltip label={t("codi.settings.forgetOne")}>
                    <button type="button" className={iconButtonClass({ size: "sm" })} aria-label={t("codi.settings.forgetOne")} onClick={() => void forgetOne(item.id)}>
                      <X size={13} />
                    </button>
                  </Tooltip>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  );
}

const SERVER_KEY = { bundled: "localexec.backendBundled", ollama: null, openai: "localexec.backendOpenai" } as const;

/**
 * The system-wide push-to-talk chord: recorded by physical key like the quick-ask hotkey, freed while
 * a new one is recorded, switchable off, and refusable by the system (another app may own it).
 */
function PttKeyRow() {
  const t = useT();
  const [current, setCurrent] = useState<{ accelerator: string | null; defaultAccelerator: string } | null>(null);
  const [recording, setRecording] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const reload = () => void codiPttHotkey().then(setCurrent).catch(() => {});
  useEffect(reload, []);

  const apply = (accelerator: string) =>
    void codiSetPttHotkey(accelerator)
      .then(() => setRefused(null))
      .catch((error: unknown) => setRefused(String(error)))
      .finally(reload);

  useEffect(() => {
    if (!recording) return;
    // Freed while recording: bound, the chord would reach Codi instead of this field.
    void codiSuspendPttHotkey(true).catch(() => {});
    let settled = false;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Shift" || event.key === "Control" || event.key === "Alt" || event.key === "Meta") return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setRecording(false);
        return;
      }
      if (event.key === "Backspace" || event.key === "Delete") {
        settled = true;
        setRecording(false);
        apply("off");
        return;
      }
      const next = acceleratorFromKey(event, isMac());
      if (!next) return;
      settled = true;
      setRecording(false);
      apply(next);
    };
    window.addEventListener("keydown", handler, true);
    return () => {
      window.removeEventListener("keydown", handler, true);
      if (!settled) void codiSuspendPttHotkey(false).catch(() => {});
    };
  }, [recording]);

  if (!current) return null;
  const { accelerator, defaultAccelerator } = current;
  return (
    <Row
      label={t("codi.settings.pttKey")}
      hint={
        refused && !recording ? (
          <span className="inline-flex items-center gap-1 text-[var(--cf-danger)]" title={refused}>
            <AlertTriangle size={12} className="shrink-0" />
            {t("codi.settings.pttKeyRefused")}
          </span>
        ) : (
          t("codi.settings.pttKeyHint")
        )
      }
    >
      <button
        type="button"
        onClick={() => setRecording((on) => !on)}
        aria-pressed={recording}
        aria-label={t("codi.settings.pttKey")}
        className={`flex h-7 min-w-[120px] items-center justify-center gap-1 rounded-md px-2 transition-colors duration-100 ${
          recording
            ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)] shadow-[inset_0_0_0_1px_var(--cf-accent)]"
            : "bg-[var(--cf-surface)] shadow-[inset_0_0_0_1px_var(--cf-border-strong)] hover:bg-[var(--cf-hover)]"
        }`}
      >
        {recording ? (
          <span className="text-[11px] font-medium">{t("shortcuts.recording")}</span>
        ) : accelerator ? (
          acceleratorKeycaps(accelerator, isMac()).map((key, i) => <Kbd key={`${key}-${i}`}>{key}</Kbd>)
        ) : (
          <span className="text-[11px] italic text-[var(--cf-text-faint)]">{t("codi.settings.pttKeyOff")}</span>
        )}
      </button>
      <Tooltip label={t("quickAsk.hotkeyTurnOff")}>
        <button type="button" onClick={() => apply("off")} disabled={!accelerator} aria-label={t("quickAsk.hotkeyTurnOff")} className={iconButtonClass({ size: "sm" })}>
          <X size={13} />
        </button>
      </Tooltip>
      <Tooltip label={t("shortcuts.resetOne")}>
        <button type="button" onClick={() => apply("")} disabled={accelerator === defaultAccelerator} aria-label={t("shortcuts.resetOne")} className={iconButtonClass({ size: "sm" })}>
          <RotateCcw size={13} />
        </button>
      </Tooltip>
    </Row>
  );
}

/** The model Codi's local tier thinks with — the «Modelo local» pane's, named here, not just pointed at. */
function LocalBrainRow() {
  const t = useT();
  const state = useLocalExecStore((s) => s.state);

  useEffect(() => {
    void useLocalExecStore.getState().load();
  }, []);

  const change = <Link onClick={() => go("claude", "localModel")}>{t(state?.model ? "codi.settings.localChange" : "codi.settings.localPick")}</Link>;
  if (!state) {
    return (
      <Row label={t("codi.settings.local")}>
        <span className="text-[12px] text-[var(--cf-text-muted)]">{change}</span>
      </Row>
    );
  }
  const row = state.models.find((model) => model.id === state.model);
  const server = SERVER_KEY[state.backend];
  const problem = localErrorText(state, t, { url: state.url, model: modelLabelOf(state) });
  const size = billions(row?.params);
  const warning = problem
    ? problem
    : row?.tools === false
      ? t("codi.settings.localNoTools")
      : size !== null && size < SMALL_MODEL_B
        ? t("codi.settings.localSmall", { size: String(size) })
        : null;

  return (
    <Row label={t("codi.settings.local")} hint={warning ? <span className="text-[var(--cf-warning)]">{warning}</span> : undefined}>
      {state.model ? (
        <span className="text-[12.5px] text-[var(--cf-text)]">
          {modelLabelOf(state)}
          <span className="text-[var(--cf-text-muted)]">
            {row?.params ? ` · ${row.params}` : ""} · {server ? t(server) : "Ollama"}
          </span>
        </span>
      ) : (
        <span className="text-[12px] text-[var(--cf-text-muted)]">{t("evals.noModel")}</span>
      )}
      <span className="text-[12px]">{change}</span>
    </Row>
  );
}

/** The voice Codi answers one language in: a downloaded one, or the reading aloud's (`""`). */
function VoiceRow({ lang }: { lang: Language }) {
  const t = useT();
  const voices = useSpeechStore((s) => s.status?.voices);
  const chosen = useCodiStore((s) => (lang === "es" ? s.settings.voiceEs : s.settings.voiceEn));
  const setValue = useCodiStore((s) => s.setSettingValue);
  const label = t(lang === "es" ? "speech.voiceEs" : "speech.voiceEn");
  const installed = (voices ?? []).filter((voice) => voice.installed && voiceLanguage(voice.lang) === lang);
  const named = (voice: DownloadableVoice) => `${voice.label} · ${t(GENDER_KEY[voice.gender])}`;
  const options: SelectOption[] = [{ value: "", label: t("codi.settings.voiceReading") }, ...installed.map((voice) => ({ value: voice.id, label: named(voice) }))];
  // A voice removed since reads as the reading aloud's, which is what speaks.
  const value = options.some((option) => option.value === chosen) ? chosen : "";

  return (
    <Row label={label}>
      <div className="w-[300px]">
        <Select
          size="sm"
          value={value}
          onChange={(next) => void setValue(lang === "es" ? "voiceEs" : "voiceEn", next)}
          options={options}
          ariaLabel={label}
        />
      </div>
      <Tooltip label={t("speech.test")}>
        <button
          type="button"
          aria-label={t("speech.test")}
          className={iconButtonClass({ size: "sm" })}
          onClick={() => void speechSay(VOICE_SAMPLE[lang], "test", true, lang, value || undefined).catch((error) => pushErrorToast(String(error)))}
        >
          <Play size={12} />
        </button>
      </Tooltip>
      {installed.length === 0 && (
        <span className="text-[11.5px] text-[var(--cf-text-muted)]">
          {t("speech.downloadFirst")} <Link onClick={() => go("voice", "models")}>{t("voice.modelsTab")}</Link>
        </span>
      )}
    </Row>
  );
}
