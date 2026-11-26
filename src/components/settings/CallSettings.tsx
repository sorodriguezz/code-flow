import { useEffect, useState, type ReactNode } from "react";
import { Play } from "lucide-react";
import { Select, type SelectOption } from "../common/Select";
import { Segmented } from "../common/Segmented";
import { Checkbox } from "../common/Checkbox";
import { PaneBlock } from "./settingsNav";
import { getSettings, setSetting } from "../../lib/tauri/commands";
import { speechTryVoice, teamCallHeadphones, teamCallListening, teamCallPool, teamCallTalk, type PoolVoice } from "../../lib/tauri/teamCallCommands";
import { useNaturalVoices } from "./naturalVoices";
import { useDictationStore } from "../../state/dictationStore";
import { useLanguageStore, useT } from "../../state/languageStore";
import { pushErrorToast } from "../../state/toastStore";
import { useTeamCallStore } from "../../state/teamCallStore";
import { useUiStore } from "../../state/uiStore";

/** The settings a call with a team has of its own — see `team::call`. */
const KEY = {
  listen: "team_call_listen_model",
  voices: "team_call_voices",
  talk: "team_call_talk",
  headphones: "team_call_headphones",
  rate: "team_call_rate",
} as const;

/** How fast a call's voices speak: each voice as recorded, a little slower, a little faster. */
const RATES = ["0.9", "1", "1.1", "1.2"] as const;

function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 py-1.5">
      <div className="flex flex-wrap items-center gap-3">
        <span className="w-[170px] shrink-0 text-[12.5px] text-[var(--cf-text)]">{label}</span>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{children}</div>
      </div>
      {hint && <p className="max-w-[62ch] pl-[182px] text-[11.5px] leading-snug text-[var(--cf-text-muted)]">{hint}</p>}
    </div>
  );
}

function Link({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className="text-[12.5px] text-[var(--cf-accent)] hover:underline" onClick={onClick}>
      {children}
    </button>
  );
}

/**
 * «Llamadas»: what a call with a team listens with, where its agents' voices come from and which
 * model they talk with — a call's own, apart from Codi's and from the reading aloud's.
 *
 * What is one for the whole call is here: there is one microphone and one person speaking into
 * it, so the model that transcribes them cannot be an agent's. What is each agent's — its voice,
 * the model it talks with — is in that agent's editor, and what is set here is what an agent
 * with nothing chosen gets.
 */
export function CallSettings() {
  const t = useT();
  const models = useDictationStore((s) => s.status?.models);
  const [values, setValues] = useState<Record<string, string> | null>(null);
  const [listening, setListening] = useState<string | null>(null);
  /** The voices a call would hand out now, `null` until read. */
  const [pool, setPool] = useState<PoolVoice[] | null>(null);
  const language = useLanguageStore((s) => s.language);
  /** Bumped when the voices on this computer change, so the list below is read again. */
  const [revision, setRevision] = useState(0);
  // The natural voices: whether they are here. They are installed in «Modelos», and installing
  // them makes calls use them — so the choice shown is read again with the list when they change.
  const natural = useNaturalVoices(() => {
    void getSettings(Object.values(KEY)).then(setValues).catch(() => {});
    setRevision((n) => n + 1);
  });
  const engine = natural.engine;

  useEffect(() => {
    void useDictationStore.getState().load();
    void getSettings(Object.values(KEY)).then(setValues).catch(() => setValues({}));
  }, []);
  // What «recommended» comes down to on this computer, read again when the choice changes.
  const chosen = values?.[KEY.listen] ?? "";
  useEffect(() => {
    void teamCallListening().then(setListening).catch(() => setListening(null));
  }, [chosen, models]);

  const save = (key: string, value: string) => {
    setValues((now) => ({ ...(now ?? {}), [key]: value }));
    void setSetting(key, value).catch((error) => pushErrorToast(String(error)));
  };
  const nameOf = (id: string) => models?.find((model) => model.id === id)?.label ?? id;
  // The models that keep up with somebody speaking — the same ones Codi can listen with.
  const listeners = (models ?? []).filter((model) => model.installed && model.features.includes("codi"));
  const listenOptions: SelectOption[] = [
    { value: "", label: listening && !chosen ? t("teamCall.settings.listenRecommended", { name: nameOf(listening) }) : t("teamCall.settings.listenRecommendedPlain") },
    ...listeners.map((model) => ({ value: model.id, label: model.label })),
  ];
  const listenValue = listeners.some((model) => model.id === chosen) ? chosen : "";
  const talk = values?.[KEY.talk] === "own" ? "own" : "fast";
  const voices = ["pocket", "local", "system", "cloud"].includes(values?.[KEY.voices] ?? "") ? (values?.[KEY.voices] as string) : "";
  const goTo = (tab: string) => useUiStore.getState().openSettingsAt("voice", tab);
  const rate = RATES.find((value) => value === (values?.[KEY.rate] ?? "").trim()) ?? "1";
  // Read again when where they come from changes: it is that choice being looked at.
  useEffect(() => {
    if (values === null) return;
    let live = true;
    void teamCallPool().then((list) => { if (live) setPool(list); }).catch(() => { if (live) setPool([]); });
    return () => { live = false; };
  }, [values === null, voices, revision]); // eslint-disable-line react-hooks/exhaustive-deps
  // The natural voices speak at the pace each was recorded at: the speed below is the others'.
  const naturalPool = (pool ?? []).some((voice) => voice.kind === "pocket");
  // Heard as a call would say it: this voice, at the call's speed.
  const tryVoice = (voice: PoolVoice) =>
    void speechTryVoice(t("teamCall.settings.voiceSample"), { id: voice.id, pitch: 1, rate: Number(rate) }, language.startsWith("en") ? "en" : "es").catch((error) => pushErrorToast(String(error)));

  return (
    <div>
      <PaneBlock title={t("teamCall.settings.listenBlock")} hint={t("teamCall.settings.listenBlockHint")}>
        <Row
          label={t("teamCall.settings.listenModel")}
          hint={
            <>
              {listeners.length === 0 ? t("teamCall.settings.listenNone") : t("teamCall.settings.listenHint")}{" "}
              <span className="[&>button]:text-[11.5px]"><Link onClick={() => goTo("models")}>{t("teamCall.settings.voiceModels")}</Link></span>
            </>
          }
        >
          <div className="w-[300px]">
            <Select size="sm" value={listenValue} loading={values === null} onChange={(next) => save(KEY.listen, next)} options={listenOptions} ariaLabel={t("teamCall.settings.listenModel")} />
          </div>
        </Row>
        <Row label={t("dictation.microphone")} hint={t("teamCall.settings.micHint")}>
          <Link onClick={() => goTo("devices")}>{t("teamCall.settings.micOpen")}</Link>
        </Row>
        <div className="py-1.5 pl-[182px]">
          <label className="flex cursor-pointer items-center gap-2 text-[12.5px] text-[var(--cf-text)]">
            <Checkbox
              checked={values?.[KEY.headphones] === "1"}
              onChange={(on) => {
                setValues((now) => ({ ...(now ?? {}), [KEY.headphones]: on ? "1" : "0" }));
                // Through the call's own command: one that is going on follows it at once.
                void teamCallHeadphones(on).catch((error) => pushErrorToast(String(error)));
                useTeamCallStore.setState((s) => ({ call: s.call ? { ...s.call, headphones: on } : s.call }));
              }}
            />
            {t("teamCall.settings.headphones")}
          </label>
          <p className="mt-1 max-w-[62ch] text-[11.5px] leading-snug text-[var(--cf-text-muted)]">{t("teamCall.settings.headphonesHint")}</p>
        </div>
      </PaneBlock>

      <PaneBlock title={t("teamCall.settings.voicesBlock")} hint={t("teamCall.settings.voicesBlockHint")}>
        <Row
          label={t("teamCall.settings.voicesFrom")}
          hint={
            <>
              {t("teamCall.settings.voicesFromHint")}
              {/* They are installed with the other voices, in «Modelos»: here, only the way there. */}
              {engine && !engine.installed && (
                <>
                  {" "}
                  {t("teamCall.settings.naturalGet")}{" "}
                  <span className="[&>button]:text-[11.5px]"><Link onClick={() => goTo("models")}>{t("teamCall.settings.voiceModels")}</Link></span>.
                </>
              )}
            </>
          }
        >
          <div className="w-[300px]">
            <Select
              size="sm"
              value={voices}
              loading={values === null}
              onChange={(next) => save(KEY.voices, next)}
              ariaLabel={t("teamCall.settings.voicesFrom")}
              options={[
                { value: "", label: t("teamCall.settings.voicesAuto") },
                ...(engine?.installed ? [{ value: "pocket", label: t("teamCall.settings.voicesNatural") }] : []),
                { value: "local", label: t("teamCall.settings.voicesLocal") },
                { value: "system", label: t("teamCall.settings.voicesSystem") },
                { value: "cloud", label: t("teamCall.settings.voicesCloud") },
              ]}
            />
          </div>
        </Row>
        <Row
          label={t("teamCall.settings.pool")}
          hint={
            <>
              {pool === null ? "" : pool.length === 0 ? t("teamCall.settings.poolNone") : pool.length <= 3 ? t("teamCall.settings.poolFew", { n: pool.length }) : t("teamCall.settings.poolHint", { n: pool.length })}{" "}
              {!naturalPool && <span className="[&>button]:text-[11.5px]"><Link onClick={() => goTo("reading")}>{t("teamCall.settings.poolMore")}</Link></span>}
            </>
          }
        >
          {(pool ?? []).map((voice) => (
            <button
              key={voice.id}
              type="button"
              onClick={() => tryVoice(voice)}
              title={t("teamCall.settings.poolTry", { name: voice.label })}
              className="inline-flex h-[26px] max-w-[240px] items-center gap-1.5 rounded-full border border-[var(--cf-border)] bg-[var(--cf-surface)] pl-2 pr-2.5 text-[12px] text-[var(--cf-text)] outline-none transition-colors hover:border-[var(--cf-accent-line)] hover:bg-[var(--cf-hover)] focus-visible:shadow-[0_0_0_2px_var(--cf-accent-line)]"
            >
              <Play size={11} className="shrink-0 text-[var(--cf-accent)]" aria-hidden />
              <span className="min-w-0 truncate">{voice.label}</span>
            </button>
          ))}
          {pool !== null && pool.length === 0 && <span className="text-[12.5px] text-[var(--cf-text-muted)]">{t("teamCall.settings.poolEmpty")}</span>}
        </Row>
        <Row label={t("teamCall.settings.rate")} hint={naturalPool ? t("teamCall.settings.rateNaturalHint") : t("teamCall.settings.rateHint")}>
          <Segmented
            size="sm"
            layoutId="cf-team-call-rate"
            value={rate}
            ariaLabel={t("teamCall.settings.rate")}
            onChange={(next) => save(KEY.rate, next)}
            options={[
              { value: "0.9", label: t("teamCall.settings.rateSlow"), disabled: naturalPool },
              { value: "1", label: t("teamCall.settings.rateNormal"), disabled: naturalPool },
              { value: "1.1", label: t("teamCall.settings.rateBrisk"), disabled: naturalPool },
              { value: "1.2", label: t("teamCall.settings.rateFast"), disabled: naturalPool },
            ]}
          />
        </Row>
      </PaneBlock>

      <PaneBlock title={t("teamCall.settings.talkBlock")} hint={t("teamCall.settings.talkBlockHint")}>
        <Row label={t("teamCall.settings.talk")} hint={t(talk === "own" ? "teamCall.settings.talkOwnHint" : "teamCall.settings.talkFastHint")}>
          <Segmented
            size="sm"
            layoutId="cf-team-call-talk"
            value={talk}
            ariaLabel={t("teamCall.settings.talk")}
            onChange={(next) => {
              setValues((now) => ({ ...(now ?? {}), [KEY.talk]: next }));
              // Through the call's own command too, so a call that is going on changes with it.
              void teamCallTalk(next)
                .then((call) => {
                  if (call) useTeamCallStore.setState((s) => ({ call: s.call ? { ...call, lines: [] } : s.call }));
                })
                .catch((error) => pushErrorToast(String(error)));
            }}
            options={[
              { value: "fast", label: t("teamCall.settings.talkFast") },
              { value: "own", label: t("teamCall.settings.talkOwn") },
            ]}
          />
        </Row>
      </PaneBlock>
    </div>
  );
}
