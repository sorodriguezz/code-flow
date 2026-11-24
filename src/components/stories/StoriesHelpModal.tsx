import { CircleHelp } from "lucide-react";
import { STORIES_GUIDE_EN, STORIES_GUIDE_ES } from "./storiesGuide";
import { ApiModal } from "../api/ApiModal";
import { Markdown } from "../common/Markdown";
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
      // Sized by the window, like the other dialogs of this view (user ask, 2026-11-23): wider
      // than the old 672px, though capped so the manual's lines stay short enough to read, and
      // nearly the window's height so more of it is on screen at once.
      width="max-w-[min(900px,90vw)]"
      height="h-[88vh]"
      maxHeight="max-h-[92vh]"
      onClose={onClose}
    >
      {/* The guide is a constant per language, so `Markdown`'s memo means it is parsed and
          sanitised once — not again on every unrelated re-render of the modal. */}
      <Markdown
        source={content}
        className="cf-markdown-preview min-h-0 flex-1 overflow-y-auto px-6 py-4 text-[13px]"
      />
    </ApiModal>
  );
}
