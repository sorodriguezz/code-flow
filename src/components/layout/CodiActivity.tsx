import { useEffect } from "react";
import { Tooltip } from "../common/Tooltip";
import { openCodi } from "../codi/openCodi";
import { useCodiStore } from "../../state/codiStore";
import { useT } from "../../state/languageStore";

/**
 * «Codi escucha» in the bar, for as long as Codi's microphone is open — from every view, whether its
 * window is in front or not. A privacy rule rather than a status: nothing listens unseen. Nothing at
 * all while the microphone is closed, the rule the other activities keep. A click brings Codi's
 * window forward, where the switch that closes it is.
 */
export function CodiActivity() {
  const t = useT();
  const mic = useCodiStore((s) => !!s.state?.mic);

  useEffect(() => {
    void useCodiStore.getState().load();
  }, []);

  if (!mic) return null;
  return (
    <Tooltip label={t("codi.bar.listening")} description={t("codi.bar.hint")}>
      <button
        type="button"
        onClick={openCodi}
        className="flex h-[22px] items-center gap-[6px] rounded-md px-1.5 text-[12px] text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]"
      >
        <span aria-hidden className="h-[7px] w-[7px] shrink-0 rounded-full bg-[var(--cf-danger)]" />
        <span>{t("codi.bar.listening")}</span>
      </button>
    </Tooltip>
  );
}
