import { useCallback, useEffect, useState } from "react";
import { Select } from "../../common/Select";
import { dictationInputs, type MicInput } from "../../../lib/tauri/dictationCommands";
import { micOptions } from "../../../lib/dictation/micOptions";
import { useDictationStore } from "../../../state/dictationStore";
import { useT } from "../../../state/languageStore";

/**
 * Which microphone the meeting is recorded with, chosen where the meeting is started — beside the
 * meter that shows what it hears, so the choice is judged by ear and by eye before recording.
 *
 * The same choice as Settings › Voz y sonido: one microphone for dictation, Codi, calls and
 * meetings. `onChange` runs once the choice is saved, for whoever has the microphone open to open
 * the new one.
 *
 * The list is read again when the window comes back to the front, so a headset plugged in a
 * moment ago is there to pick.
 */
export function MicPicker({ onChange, disabled = false }: { onChange?: () => void; disabled?: boolean }) {
  const t = useT();
  const device = useDictationStore((s) => s.device);
  const [inputs, setInputs] = useState<MicInput[] | null>(null);
  const reload = useCallback(() => {
    void dictationInputs().then(setInputs).catch(() => setInputs([]));
  }, []);
  useEffect(() => {
    // The store holds the choice; a notes window that never opened Settings has not read it yet.
    void useDictationStore.getState().load();
    reload();
    window.addEventListener("focus", reload);
    return () => window.removeEventListener("focus", reload);
  }, [reload]);
  return (
    <div className="w-[230px] shrink-0">
      <Select
        size="sm"
        value={device}
        loading={inputs === null}
        disabled={disabled}
        ariaLabel={t("dictation.microphone")}
        options={micOptions(inputs, device, t)}
        onChange={(next) => {
          if (next === device) return;
          void useDictationStore.getState().setDevice(next).then(() => onChange?.());
        }}
      />
    </div>
  );
}
