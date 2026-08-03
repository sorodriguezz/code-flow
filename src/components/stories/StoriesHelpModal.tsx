import { CircleHelp } from "lucide-react";
import { STORIES_GUIDE_EN, STORIES_GUIDE_ES } from "./storiesGuide";
import { ApiModal } from "../api/ApiModal";
import { renderMarkdown } from "../../lib/markdown";
import { useLanguageStore, useT } from "../../state/languageStore";

/**
 * What this workspace does, how to work with it, and — the part worth the space — what it cannot do.
 *
 * A read-only manual rather than tooltips scattered over the chrome, for the same reason the Agents
 * view has one: the limits only make sense together. "The review writes nothing to Azure", "the
 * session is not saved" and "no run sees two repositories at once" are three answers to the same
 * question, and a user who meets them one popover at a time never assembles the picture.
 */
export function StoriesHelpModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const language = useLanguageStore((s) => s.language);
  const content = language === "es" ? STORIES_GUIDE_ES : STORIES_GUIDE_EN;

  return (
    <ApiModal
      icon={CircleHelp}
      title={t("stories.help")}
      subtitle={t("stories.helpSubtitle")}
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
