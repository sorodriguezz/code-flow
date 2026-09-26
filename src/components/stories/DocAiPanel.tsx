import { FolderGit2 } from "lucide-react";
import { AiGlyph } from "../common/AiGlyph";
import { Checkbox } from "../common/Checkbox";
import { ThinkingOrb } from "../common/ThinkingOrb";
import { buttonClass } from "../common/Button";
import { ChatModelPicker } from "../ai/ChatModelPicker";
import { FloatingAiWindow } from "../ai/FloatingAiWindow";
import { confirmAction } from "../../state/confirmStore";
import { NO_DOC_PARAMS, useDocsStore } from "../../state/docsStore";
import { useActiveProjects } from "../../state/workspaceStore";
import { useT } from "../../state/languageStore";
import type { DocPage } from "../../types/domain";

/** The routing row a document is generated under — `AiTask::Wiki`, what `generate_doc_page` loads. */
const TASK = "wiki";

/**
 * Generates the open document — everything the run reads, in the window it is started from.
 *
 * The same floating window as a note's "write with AI" (`FloatingAiWindow`), opened from the AI
 * button beside "link" in the editor's toolbar. It used to be a bar over the editor: the repositories,
 * the project-context switch and a one-line instruction, then a model tag and a play button at the far
 * end. The instruction is the part that makes a generated document good — what to cover, who reads
 * it, what to leave out — and one line was too little room to write it in; the rest only matters in
 * the moment you generate, so it lives where that happens.
 *
 * All of it is still the document's own composer (`docsStore.paramsByDoc`), which is what
 * `generate` reads: closing the window keeps what was typed, and another document keeps its own.
 *
 * The run does not live here either. It is the document's (`runByDoc`), so this window can be closed
 * while it works — the toolbar's button shows the orb, and opening it again offers Stop.
 */
export function DocAiPanel({
  page,
  body,
  onStarted,
  onClose,
}: {
  page: DocPage;
  body: string;
  /** A run was started from here. The caller closes the window when that run lands — the caller,
   *  because this window is mounted twice over one run: beside "reading…" while the document is
   *  empty, then over the editor once text arrives, and a flag kept here would not survive the move. */
  onStarted: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const repos = useActiveProjects();
  const { projectIds: picked, instructions, useContext } = useDocsStore(
    (s) => s.paramsByDoc[page.id] ?? NO_DOC_PARAMS,
  );
  const running = useDocsStore((s) => Boolean(s.runByDoc[page.id]));
  const docs = useDocsStore.getState;

  const isRepo = page.scope === "repo";
  const subject = repos.find((r) => r.id === page.project_id);
  // A repository document is bound to the checkout it was created for, and that checkout can have
  // left the workspace since; a workspace document reads whatever is ticked here.
  const canGenerate = isRepo ? Boolean(subject) : picked.length > 0;
  const replacing = body.trim().length > 0;

  const start = () => {
    void docs().generate(page.id);
    // `generate` claims the run before its first await, so this reads whether it started at all —
    // it refuses, with a toast of its own, when there is nothing it may read.
    if (docs().runByDoc[page.id]) onStarted();
  };

  const submit = () => {
    if (running || !canGenerate) return;
    // Regenerating replaces the body outright, and nothing keeps the previous version — so a
    // document that already says something asks first. An empty one does not.
    if (!replacing) {
      start();
      return;
    }
    void confirmAction(t("docs.regenerateConfirm")).then((ok) => {
      if (ok) start();
    });
  };

  const stop = () => void docs().stop(page.id);

  return (
    <FloatingAiWindow
      title={replacing ? t("docs.aiTitleRegenerate") : t("docs.aiTitleGenerate")}
      onClose={onClose}
      footer={
        running ? (
          <>
            <button
              type="button"
              onClick={stop}
              title={t("docs.stopHint")}
              className="mr-auto rounded-md px-1.5 py-0.5 text-[11px] text-[var(--cf-text-muted)] transition-colors hover:text-[var(--cf-danger)]"
            >
              {t("docs.stop")}
            </button>
            {/* The orb on the window's own surface, as the note's window does: a model reading the
                repository, not something loading. */}
            <span className="flex items-center gap-1.5 rounded-md border border-[var(--cf-border)] bg-[var(--cf-field)] px-2 py-1 text-[11px] font-medium text-[var(--cf-text)]">
              <ThinkingOrb size="sm" />
              {t("docs.aiGenerating")}
            </span>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md px-2 py-1 text-[11px] text-[var(--cf-text-muted)] transition-colors hover:text-[var(--cf-text)]"
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={!canGenerate}
              title={canGenerate ? t("docs.generateHint") : isRepo ? t("docs.repoGone") : t("docs.pickReposFirst")}
              className={buttonClass({ variant: "primary", size: "sm" })}
            >
              <AiGlyph size={11} onFill />
              {replacing ? t("docs.regenerate") : t("docs.generate")}
            </button>
          </>
        )
      }
    >
      {/* What it reads. A repository document names its one checkout, fixed when it was created so
          that regenerating describes the same thing; a workspace document is ticked here. */}
      <div>
        <span className="mb-1 block text-[10.5px] font-medium text-[var(--cf-text-muted)]">
          {isRepo ? t("docs.aiReads") : t("docs.whichRepos")}
        </span>
        {isRepo ? (
          <span
            title={t("docs.repoSubjectHint")}
            className={`flex items-center gap-1.5 rounded-md border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-2 py-1 text-[12px] ${
              subject ? "text-[var(--cf-text)]" : "text-[var(--cf-warning)]"
            }`}
          >
            <FolderGit2 size={12} className="shrink-0 text-[var(--cf-text-muted)]" />
            <span className="min-w-0 truncate">{subject?.name ?? t("docs.repoGone")}</span>
          </span>
        ) : (
          <div
            title={t("docs.whichReposHint")}
            className="max-h-28 overflow-y-auto rounded-md border border-[var(--cf-field-border)] bg-[var(--cf-field)] p-1"
          >
            {repos.map((repo) => (
              <label
                key={repo.id}
                className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-[12px] text-[var(--cf-text)] hover:bg-[var(--cf-hover)]"
              >
                <Checkbox
                  checked={picked.includes(repo.id)}
                  disabled={running}
                  onChange={() => docs().toggleProject(page.id, repo.id)}
                />
                <span className="min-w-0 truncate">{repo.name}</span>
              </label>
            ))}
          </div>
        )}
      </div>

      <label
        title={t("huReview.useContextHint")}
        className="flex cursor-pointer items-center gap-2 text-[12px] text-[var(--cf-text)]"
      >
        <Checkbox
          checked={useContext}
          disabled={running}
          onChange={(next) => docs().setUseContext(page.id, next)}
        />
        {t("huReview.useContext")}
      </label>

      <textarea
        // Not while a run is going: the window was opened to follow it, and the caret belongs in the
        // document the user came back to.
        autoFocus={!running}
        disabled={running}
        value={instructions}
        onChange={(event) => docs().setInstructions(page.id, event.target.value)}
        onKeyDown={(event) => {
          // Enter alone is a newline: what a document should cover is prose, often a few lines.
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            submit();
          }
        }}
        rows={4}
        aria-label={t("docs.instructionsPlaceholder")}
        placeholder={t("docs.instructionsPlaceholder")}
        className="w-full resize-none rounded-md border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-2 py-1.5 text-[12px] leading-relaxed text-[var(--cf-text)] outline-none focus:border-[var(--cf-accent)] disabled:opacity-50"
      />

      {/* The chat's model menu on the `wiki` row — the one Settings shows — so what is picked here
          is what Settings says, and the other way round. A generation keeps no session, so any
          provider can take the next one. */}
      <ChatModelPicker task={TASK} liveModel={null} chatActive={false} />
    </FloatingAiWindow>
  );
}
