/**
 * The voice an agent speaks with in a call with its team: whose it is and how high. Left on
 * «Automática», it is given one when the call starts — a different one from its colleagues' —
 * from what this computer has.
 */
import { useEffect, useState } from "react";
import { Play } from "lucide-react";
import type { AgentVoice } from "../../../types/domain";
import { speechTryVoice, teamCallVoices, type PoolVoice } from "../../../lib/tauri/teamCallCommands";
import { useLanguageStore } from "../../../state/languageStore";
import { pushErrorToast } from "../../../state/toastStore";
import { Select, type SelectItems } from "../../common/Select";
import { Btn, Label, Seg } from "../kit/ui";
import { useL } from "../state";

const AUTO = "";

/** The pitches offered, lowest first: a little either way and no more — a voice moved far is not
 *  understood (the backend holds it to the same range, `speech::Voice::PITCH`). */
export const PITCHES = [0.95, 0.975, 1, 1.025, 1.05] as const;

/** The pitch offered that is nearest to `pitch` — what the control shows for a value saved before. */
export function nearestPitch(pitch: number): number {
  return PITCHES.reduce((best, option) => (Math.abs(option - pitch) < Math.abs(best - pitch) ? option : best), 1);
}

/** The voices in the groups the list shows them in, with the ones of the app's language first. */
export function voiceGroups(voices: PoolVoice[], lang: "es" | "en", l: (es: string, en: string) => string): SelectItems {
  const of = (kind: PoolVoice["kind"]) => voices.filter((voice) => voice.kind === kind).sort((a, b) => Number(b.lang === lang) - Number(a.lang === lang));
  const mark = (voice: PoolVoice) => ({ value: voice.id, label: voice.lang === "multi" || voice.lang === lang ? voice.label : `${voice.label} · ${voice.lang === "es" ? l("español", "Spanish") : l("inglés", "English")}` });
  const groups: SelectItems = [{ value: AUTO, label: l("Automática", "Automatic") }];
  const add = (label: string, kind: PoolVoice["kind"]) => {
    const options = of(kind).map(mark);
    if (options.length > 0) groups.push({ label, options });
  };
  add(l("Voces naturales de las llamadas", "The calls' natural voices"), "pocket");
  add(l("Voces descargadas", "Downloaded voices"), "local");
  add(l("Voces clonadas", "Cloned voices"), "clone");
  add(l("Voces del sistema", "System voices"), "system");
  add(l("Servicio (el texto sale de este equipo)", "Service (the text leaves this computer)"), "cloud");
  return groups;
}

export function VoiceField({ name, voice, onChange }: { name: string; voice: AgentVoice | null; onChange: (voice: AgentVoice | null) => void }) {
  const l = useL();
  const lang = useLanguageStore((s) => s.language);
  const [voices, setVoices] = useState<PoolVoice[] | null>(null);
  useEffect(() => {
    let valid = true;
    void teamCallVoices().then((list) => { if (valid) setVoices(list); }).catch(() => { if (valid) setVoices([]); });
    return () => { valid = false; };
  }, []);
  const chosen = voice?.id ?? AUTO;
  const pitch = nearestPitch(voice?.pitch ?? 1);
  // A voice chosen on another computer, or removed since: still shown, so it is not lost by looking.
  const known = !chosen || (voices ?? []).some((v) => v.id === chosen);
  const items = voiceGroups(voices ?? [], lang === "es" ? "es" : "en", l);
  if (!known) items.push({ value: chosen, label: l(`${chosen} (no está en este equipo)`, `${chosen} (not on this computer)`) });
  const who = name.trim() || l("este agente", "this agent");
  const sample = l(`Hola, soy ${who}. Así sueno en una llamada con el equipo.`, `Hi, I'm ${who}. This is how I sound on a call with the team.`);
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{l("Voz en las llamadas", "Voice on calls")}</Label>
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-[200px] flex-1">
          <Select value={chosen} size="field" loading={voices === null} ariaLabel={l("Voz en las llamadas", "Voice on calls")} onChange={(id) => onChange(id ? { id, pitch, rate: voice?.rate ?? 1 } : null)} options={items} />
        </span>
        <Seg
          size="sm"
          className={chosen ? "" : "pointer-events-none opacity-40"}
          value={String(pitch)}
          onChange={(value) => chosen && onChange({ id: chosen, pitch: Number(value), rate: voice?.rate ?? 1 })}
          options={PITCHES.map((option, index) => ({
            value: String(option),
            label: ["−−", "−", "·", "+", "++"][index],
            title: [l("Algo más grave", "A little lower"), l("Apenas más grave", "Slightly lower"), l("Su tono", "Its own pitch"), l("Apenas más aguda", "Slightly higher"), l("Algo más aguda", "A little higher")][index],
          }))}
        />
        <Btn small icon={Play} disabled={!chosen} title={chosen ? l("Oír esta voz", "Hear this voice") : l("Elige una voz para oírla", "Choose a voice to hear it")} onClick={() => chosen && void speechTryVoice(sample, { id: chosen, pitch, rate: voice?.rate ?? 1 }, lang).catch((error) => pushErrorToast(String(error)))}>
          {l("Probar", "Try")}
        </Btn>
      </div>
      <span className="text-[11.5px] text-[var(--cf-text-muted)]">
        {chosen
          ? l("Habla siempre con esta voz. El tono la mueve apenas, para distinguirla sin que deje de entenderse.", "It always speaks with this voice. The pitch moves it slightly, to tell it apart without making it hard to understand.")
          : l("Al empezar una llamada se le da una voz distinta de la de sus compañeros, de las que tiene este equipo.", "When a call starts it is given a voice different from its colleagues', from the ones this computer has.")}
      </span>
    </div>
  );
}
