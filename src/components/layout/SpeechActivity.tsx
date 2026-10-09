import { useEffect } from "react";
import { Square } from "lucide-react";
import { Tooltip } from "../common/Tooltip";
import { ThinkingOrb } from "../common/ThinkingOrb";
import { ensureSpeechEvents, useSpeechStore } from "../../state/speechStore";
import { useT } from "../../state/languageStore";

/** Module-level, so the orb is handed the same object every render. */
const SPEAKING = { phase: "speak" } as const;

/**
 * «Hablando» in the bar: the thinking mark breathing with the voice while it reads something aloud,
 * from every view — and the way to stop it. Nothing at all otherwise, the rule the other activities
 * keep. Mounting it is also what starts the reading aloud's listeners in this window (notifications
 * included), which is why it loads the store even while silent.
 */
export function SpeechActivity() {
  const t = useT();
  const speaking = useSpeechStore((s) => s.speaking);

  useEffect(() => {
    ensureSpeechEvents();
    const store = useSpeechStore.getState();
    if (!store.loaded) void store.load();
  }, []);

  if (!speaking) return null;
  const preview = speaking.text.length > 140 ? `${speaking.text.slice(0, 140)}…` : speaking.text;
  return (
    <Tooltip label={t(speaking.phase === "preparing" ? "speech.barPreparing" : "speech.barSpeaking")} description={preview}>
      <button
        type="button"
        onClick={() => useSpeechStore.getState().stop()}
        aria-label={t("speech.stop")}
        className="group flex h-[22px] items-center gap-[6px] rounded-md px-1.5 text-[12px] text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]"
      >
        <ThinkingOrb size="sm" activity={SPEAKING} />
        <span>{t("speech.barShort")}</span>
        <Square size={9} fill="currentColor" className="opacity-60 group-hover:opacity-100" />
      </button>
    </Tooltip>
  );
}
