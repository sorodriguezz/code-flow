import { DictationSettings } from "./DictationSettings";
import { MeetingsSettings } from "./MeetingsSettings";
import { SpeechSettings } from "./SpeechSettings";
import { VoiceDevicesSettings, VoiceModelsSettings } from "./VoiceSettings";
import { RailSection } from "./settingsNav";
import { useT } from "../../state/languageStore";

/**
 * «Voz y sonido»: what CodeFlow listens with and speaks through. Out of the AI section, where Voice,
 * Dictation and Meetings used to sit (2026-10-09): the devices first, then what is downloaded for
 * them, then the three features that use them — dictating, taking a meeting's notes, and the
 * thinking mark reading aloud.
 */
export function VoiceSoundSettings() {
  const t = useT();
  return (
    <RailSection section="voice" title={t("voice.sectionTitle")} hint={t("voice.sectionHint")} fallback="devices">
      {(tab) => (
        <>
          {tab === "devices" && <VoiceDevicesSettings />}
          {tab === "models" && <VoiceModelsSettings />}
          {tab === "dictation" && <DictationSettings />}
          {tab === "meetings" && <MeetingsSettings />}
          {tab === "reading" && <SpeechSettings />}
        </>
      )}
    </RailSection>
  );
}
