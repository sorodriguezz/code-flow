import type { MicInput } from "../tauri/dictationCommands";
import type { SelectOption } from "../../components/common/Select";
import type { Translate } from "../../state/languageStore";

/**
 * The microphones as a list to choose from, wherever one is chosen (Settings, a meeting about to
 * start): the system's own first — named, when it is known which one that is — then every input,
 * and the chosen one even when it is unplugged now, so looking at the list does not lose the choice.
 */
export function micOptions(inputs: MicInput[] | null, device: string, t: Translate): SelectOption[] {
  const fallback = inputs?.find((input) => input.isDefault);
  const options: SelectOption[] = [
    { value: "", label: fallback ? t("dictation.micDefaultNamed", { name: fallback.name }) : t("dictation.micDefault") },
    ...(inputs ?? []).map((input) => ({ value: input.id, label: input.name })),
  ];
  // Chosen once and unplugged now: still the choice, and recordings use the default meanwhile.
  if (device && inputs && !inputs.some((input) => input.id === device)) {
    options.push({ value: device, label: t("dictation.micAbsent") });
  }
  return options;
}
