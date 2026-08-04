import { CircleHelp } from "lucide-react";
import { AGENTS_GUIDE_EN, AGENTS_GUIDE_ES } from "./agentsGuide";
import { ApiModal } from "../api/ApiModal";
import { renderMarkdown } from "../../lib/markdown";
import { useLanguageStore, useT } from "../../state/languageStore";

/**
 * What this view does, how to work with it, and — the part worth the space — what it cannot do.
 *
 * A read-only manual rather than tooltips scattered over the chrome: the limits only make sense
 * together. "One agent per repository" and "nothing starts on its own" and "the chain cannot tell
 * whether a step succeeded" are three answers to the same question, and a user who meets them one
 * popover at a time never assembles the picture.
 */
export function AgentsHelpModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const language = useLanguageStore((s) => s.language);
  const content = language === "es" ? AGENTS_GUIDE_ES : AGENTS_GUIDE_EN;

  return (
    <ApiModal
      icon={CircleHelp}
      title={t("agents.help")}
      subtitle={t("agents.helpSubtitle")}
      width="max-w-2xl"
      onClose={onClose}
    >
      <div
        className="cf-markdown-preview min-h-0 flex-1 overflow-y-auto px-5 py-4 text-[13px]"
        dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }}
      />
    </ApiModal>
  );
}
