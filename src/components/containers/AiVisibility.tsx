import { useEffect } from "react";
import { EyeOff } from "lucide-react";
import { AiGlyph } from "../common/AiGlyph";
import { RowAction } from "./containerBits";
import { useAiInfraStore, type AiInfraKind } from "../../state/aiInfraStore";
import { useT } from "../../state/languageStore";

/**
 * Whether chats and agents may look at one cluster, Azure subscription or engine — a click hides it
 * from them or shows it again. The glyph says it is visible; a crossed eye that it is not.
 */
export function AiVisibilityToggle({ kind, id, name }: { kind: AiInfraKind; id: string; name: string }) {
  const t = useT();
  const load = useAiInfraStore((s) => s.load);
  const hidden = useAiInfraStore((s) => s.hidden[kind].includes(id));
  const toggle = useAiInfraStore((s) => s.toggle);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <RowAction label={t(hidden ? "containers.ai.hidden" : "containers.ai.visible", { name })} onClick={() => toggle(kind, id)}>
      {hidden ? <EyeOff size={12} className="text-[var(--cf-text-faint)]" /> : <AiGlyph name="sparkles" size={12} still />}
    </RowAction>
  );
}
