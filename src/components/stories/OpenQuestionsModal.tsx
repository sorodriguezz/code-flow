import { useMemo, useState } from "react";
import { CircleHelp, RefreshCw, Save } from "lucide-react";
import { ApiModal, GhostButton, PrimaryButton } from "../api/ApiModal";
import { Note } from "../api/settingsChrome";
import {
  parseOpenQuestions,
  parseQuestionAnswers,
  useStoriesStore,
} from "../../state/storiesStore";
import { useT } from "../../state/languageStore";
import type { QuestionAnswer } from "../../types/domain";

/** One question and the box to settle it in. */
function QuestionRow({
  question,
  answer,
  onChange,
}: {
  question: string;
  answer: string;
  onChange: (value: string) => void;
}) {
  const t = useT();
  return (
    <div className="rounded-md border border-[var(--cf-border)] bg-[var(--cf-bg)] p-2">
      <p className="mb-1.5 text-[12px] leading-snug text-[var(--cf-text)]">{question}</p>
      <textarea
        value={answer}
        rows={2}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t("stories.answerPlaceholder")}
        className="w-full resize-y rounded-md border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-2 py-1.5 text-[12px] leading-relaxed outline-none focus:border-[var(--cf-accent)]"
      />
    </div>
  );
}

/**
 * Answering what the documentation left out, in one pass.
 *
 * The questions were a terminal notice before this: the model listed them, and acting on one meant
 * retyping it into the free-text instructions box, where nothing recorded which question it settled
 * and the model never saw the question it was answering.
 *
 * The answers are kept on the set rather than spent on one run. An answer is a requirement the
 * documentation was missing, so it stays true after the question stops being asked — which is why
 * questions that have dropped off the current list are still shown here, below the open ones, and
 * still editable. Every later generation is handed the whole sheet.
 */
export function OpenQuestionsModal({
  batchId,
  onClose,
}: {
  batchId: string;
  onClose: () => void;
}) {
  const t = useT();
  const batch = useStoriesStore((s) => s.batches.find((b) => b.id === batchId) ?? null);
  const [busy, setBusy] = useState(false);

  const open = useMemo(() => (batch ? parseOpenQuestions(batch.open_questions) : []), [batch]);
  const stored = useMemo(
    () => (batch ? parseQuestionAnswers(batch.question_answers) : []),
    [batch],
  );

  /** Keyed by the question text, which is what makes an answer survive a regeneration that asks it
   * again in a different position. */
  const [answers, setAnswers] = useState<Record<string, string>>(() =>
    Object.fromEntries(stored.map((qa) => [qa.question, qa.answer])),
  );

  // Answered before, and no longer on the model's list. Kept visible so the sheet is the whole of
  // what this set knows, not just what the last run happened to still be unsure about.
  const settled = stored.filter((qa) => !open.includes(qa.question));

  if (!batch) return null;

  const sheet = (): QuestionAnswer[] =>
    Object.entries(answers)
      .map(([question, answer]) => ({ question, answer: answer.trim() }))
      .filter((qa) => qa.answer !== "");

  const answeredCount = sheet().length;

  const save = async () => {
    setBusy(true);
    try {
      await useStoriesStore.getState().setAnswers(batchId, sheet());
    } finally {
      setBusy(false);
    }
  };

  const saveAndRegenerate = async () => {
    setBusy(true);
    try {
      await useStoriesStore.getState().setAnswers(batchId, sheet());
      onClose();
      // Deliberately after the close: the generation streams into the list behind this dialog, and
      // watching it happen is the point.
      void useStoriesStore.getState().generate(batchId);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ApiModal
      icon={CircleHelp}
      title={t("stories.answerTitle")}
      subtitle={t("stories.answerSubtitle")}
      width="max-w-3xl"
      height="h-[80vh]"
      busy={busy}
      dismissOnBackdrop={false}
      onClose={onClose}
      footer={
        <>
          <span className="text-[11px] text-[var(--cf-text-muted)]">
            {t("stories.answerCount", { n: answeredCount, total: open.length + settled.length })}
          </span>
          <span className="ml-auto flex items-center gap-2">
            <GhostButton onClick={() => void save()} disabled={busy}>
              <Save size={13} />
              {t("common.save")}
            </GhostButton>
            <PrimaryButton onClick={() => void saveAndRegenerate()} disabled={busy}>
              <RefreshCw size={13} />
              {t("stories.answerRegenerate")}
            </PrimaryButton>
          </span>
        </>
      }
    >
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
        <Note>{t("stories.answerHint")}</Note>
        {/* Said plainly and up front, because the primary button here does it: the regeneration
            throws away every unpublished story along with the edits made to it. */}
        <Note tone="warning">{t("stories.answerRegenerateWarning")}</Note>

        {open.length === 0 && settled.length === 0 ? (
          <p className="py-6 text-center text-[12px] text-[var(--cf-text-muted)]">
            {t("stories.answerNone")}
          </p>
        ) : (
          <>
            {open.length > 0 && (
              <section className="space-y-2">
                <h4 className="text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
                  {t("stories.openQuestions")}
                </h4>
                {open.map((question) => (
                  <QuestionRow
                    key={question}
                    question={question}
                    answer={answers[question] ?? ""}
                    onChange={(value) => setAnswers((current) => ({ ...current, [question]: value }))}
                  />
                ))}
              </section>
            )}

            {settled.length > 0 && (
              <section className="space-y-2">
                <h4 className="text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
                  {t("stories.answerSettled")}
                </h4>
                <Note>{t("stories.answerSettledHint")}</Note>
                {settled.map((qa) => (
                  <QuestionRow
                    key={qa.question}
                    question={qa.question}
                    answer={answers[qa.question] ?? ""}
                    onChange={(value) =>
                      setAnswers((current) => ({ ...current, [qa.question]: value }))
                    }
                  />
                ))}
              </section>
            )}
          </>
        )}
      </div>
    </ApiModal>
  );
}
