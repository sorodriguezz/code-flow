import { AlertCircle, FileDown, GitCommitHorizontal, ScanEye, SquareTerminal, type LucideIcon } from "lucide-react";
import { AiSparkles } from "../common/AiGlyph";
import { useT } from "../../state/languageStore";
import type { TranslationKey } from "../../lib/i18n/translations";

/**
 * What an empty chat says instead of nothing.
 *
 * The workspace opens here far more often than on any conversation — "New chat" is the default
 * state, not an edge case — and what stood here was a definition: a title, and a sentence
 * explaining that no repository is required. True, useful once, and read as a dead end every time
 * after that. A surface whose entire job is to be typed into should *ask* for something.
 *
 * # The openers are the point, not decoration
 *
 * They are not examples of what the model can do; each one is a real first line with the caret
 * left at the end of it, so the cheapest gesture — one click, then paste — is also the useful one.
 * A starter that sends itself answers a question nobody asked, and a starter that reads like a demo
 * gets clicked once out of curiosity and never again.
 *
 * # Why each one is a paragraph and not four words
 *
 * The first version put four words in the composer — "Review this code and tell me what you would
 * improve:" — and that is not a prompt, it is a topic. The model got no idea what kind of answer
 * was wanted, so it wrote the kind it writes by default: long, hedged, and starting from scratch.
 *
 * So every draft now states the **shape of the answer** as well as the subject: what to look at,
 * what to leave alone, and what to hand back. That is the part a person will not type at 9am and
 * the part that decides whether the reply is worth reading, and it costs one click to have it.
 * Each ends at a label and a blank line, so there is no placeholder to delete before pasting —
 * only the one thing the app cannot know, which is the error, the diff or the snippet itself.
 *
 * # Why the cards say what they will do
 *
 * A grid of bare labels makes the reader open all four to learn what they are. The second line is
 * what each one is *for*, in the words of the result rather than of the feature, so the choice is
 * made before the click rather than after it.
 *
 * They are also chosen for *this* app rather than for a general chat box. A window whose other tabs
 * are a commit graph and a diff is one where "write me a commit message" and "what does this git
 * command do" are the questions actually being asked.
 */

/** One opener: the words on the card, the line under them, and the text it leaves in the composer. */
export interface Starter {
  icon: LucideIcon;
  label: TranslationKey;
  hint: TranslationKey;
  draft: TranslationKey;
  /** Only shown when this conversation may actually produce files. A card offering a spreadsheet
   *  on a chat that cannot write one is the panel's "no grid of ticks" rule broken on the way in. */
  needsFiles?: boolean;
}

const STARTERS: Starter[] = [
  {
    icon: AlertCircle,
    label: "chat.starterErrorLabel",
    hint: "chat.starterErrorHint",
    draft: "chat.starterErrorDraft",
  },
  {
    icon: GitCommitHorizontal,
    label: "chat.starterCommitLabel",
    hint: "chat.starterCommitHint",
    draft: "chat.starterCommitDraft",
  },
  {
    icon: ScanEye,
    label: "chat.starterReviewLabel",
    hint: "chat.starterReviewHint",
    draft: "chat.starterReviewDraft",
  },
  {
    icon: SquareTerminal,
    label: "chat.starterGitLabel",
    hint: "chat.starterGitHint",
    draft: "chat.starterGitDraft",
  },
  {
    icon: AiSparkles,
    label: "chat.starterDiffLabel",
    hint: "chat.starterDiffHint",
    draft: "chat.starterDiffDraft",
  },
  {
    icon: FileDown,
    label: "chat.starterFileLabel",
    hint: "chat.starterFileHint",
    draft: "chat.starterFileDraft",
    needsFiles: true,
  },
];

/** The openers on offer for a conversation with these powers. Exported for the test, which is the
 *  only place the gating can be checked without a DOM. */
export function startersFor(canWriteFiles: boolean): Starter[] {
  return STARTERS.filter((starter) => !starter.needsFiles || canWriteFiles);
}

/**
 * Which greeting the clock calls for.
 *
 * The bands are the ordinary ones and the last is deliberately open-ended: everything outside
 * morning and afternoon is "evening", which covers 2am honestly enough in both languages and is
 * better than a fourth string nobody has a name for.
 */
export function greetingKey(hour: number): TranslationKey {
  if (hour >= 5 && hour < 12) return "chat.welcomeMorning";
  if (hour >= 12 && hour < 20) return "chat.welcomeAfternoon";
  return "chat.welcomeEvening";
}

export function ChatWelcome({
  onPickStarter,
  canWriteFiles = false,
}: {
  onPickStarter: (draft: string) => void;
  canWriteFiles?: boolean;
}) {
  const t = useT();
  // Read on every render rather than memoised on mount. Not a performance question — reading the
  // hour is free — but a correctness one: memoising would freeze the greeting at whatever it was
  // when this screen first appeared, so an app left open across noon would go on saying "good
  // morning" until something else happened to remount it. No timer either; the parent re-renders on
  // every keystroke in the composer, which is far more often than the greeting can change.
  const greeting = greetingKey(new Date().getHours());
  const starters = startersFor(canWriteFiles);

  return (
    /* A container for the same reason `GroupView` is one: `sm:grid-cols-2` asked the window, and
       the window is always wide enough. The cards carry two lines each, so two of them in a 300px
       half is the layout falling apart rather than adapting — and the side padding comes down with
       them, because eight rems of gutter on a narrow pane is space taken from the only thing on
       screen. */
    <div className="@container flex h-full w-full flex-col items-center justify-center gap-3 px-4 py-8 @md:px-8 text-center">
      {/* The same badge the empty *transcript* draws (see `ChatTranscript`), because these two are
          the same kind of moment one step apart — nothing asked yet — and giving each its own
          treatment would make the workspace look like two different products. */}
      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]">
        <AiSparkles size={20} />
      </div>

      <div className="space-y-1">
        <p className="text-[15px] font-semibold text-[var(--cf-text)]">{t(greeting)}</p>
        <p className="text-[13px] text-[var(--cf-text-muted)]">{t("chat.welcomeAsk")}</p>
      </div>

      {/* The one fact worth keeping from what used to be here: this conversation needs no
          repository. Demoted to a footnote rather than dropped — it answers "why is there no
          project picker", which is a real question the first time and never again. */}
      <p className="max-w-sm text-[12px] leading-relaxed text-[var(--cf-text-muted)]">
        {t("chat.emptyBody")}
      </p>

      <div className="mt-2 grid w-full max-w-2xl grid-cols-1 gap-2 @xl:grid-cols-2">
        {starters.map(({ icon: Icon, label, hint, draft }) => (
          <button
            key={label}
            type="button"
            onClick={() => onPickStarter(t(draft))}
            // `items-start` and a top-aligned icon rather than a centred row: the second line makes
            // these two lines tall, and an icon centred against both would float in the middle of a
            // card whose first line is the thing it labels.
            className="group/starter flex items-start gap-2.5 rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface)] px-3 py-2.5 text-left transition-colors hover:border-[var(--cf-accent)] hover:bg-[var(--cf-surface-raised)]"
          >
            <Icon
              size={14}
              className="mt-[2px] shrink-0 text-[var(--cf-text-muted)] transition-colors group-hover/starter:text-[var(--cf-accent)]"
            />
            <span className="min-w-0">
              <span className="block text-[13px] text-[var(--cf-text)]">{t(label)}</span>
              <span className="block text-[11px] leading-snug text-[var(--cf-text-muted)]">
                {t(hint)}
              </span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
