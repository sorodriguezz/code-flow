import { useEffect, useState } from "react";
import { Select } from "../common/Select";
import { CHAT_EFFORTS } from "../../lib/tauri/chatCommands";
import type { TranslationKey } from "../../lib/i18n/translations";
import { useT } from "../../state/languageStore";

const LABEL: Record<string, TranslationKey> = {
  "": "chat.effortDefault",
  low: "chat.effortLow",
  medium: "chat.effortMedium",
  high: "chat.effortHigh",
  max: "chat.effortMax",
};

/**
 * Whether `(provider, model)` takes a reasoning level, asked of the backend each time the pair
 * changes. `null` while the answer is on its way, so the caller can keep the control hidden rather
 * than flash one that may not apply.
 */
export function useEffortSupport(provider: string, model: string, ask: (provider: string, model: string) => Promise<boolean>) {
  const [supported, setSupported] = useState<boolean | null>(null);
  useEffect(() => {
    if (!provider) {
      setSupported(false);
      return;
    }
    let live = true;
    setSupported(null);
    ask(provider, model)
      .then((answer) => live && setSupported(answer))
      .catch(() => live && setSupported(false));
    return () => {
      live = false;
    };
  }, [provider, model, ask]);
  return supported;
}

/** The reasoning level as a field: the chat's four steps plus «the CLI's own default». */
export function EffortSelect({ value, onChange }: { value: string; onChange: (effort: string) => void }) {
  const t = useT();
  return (
    <Select
      size="field"
      value={value}
      onChange={onChange}
      ariaLabel={t("chat.effortTitle")}
      options={["", ...CHAT_EFFORTS].map((level) => ({ value: level, label: t(LABEL[level]) }))}
    />
  );
}
