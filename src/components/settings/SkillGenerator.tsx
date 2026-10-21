import { useState } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { AlertTriangle, Download, FileText, FolderGit2, Globe, Plus, RotateCcw, Save, Type, X } from "lucide-react";
import { skillSaveDraft, skillWriteBundle, type SkillDraft, type SkillSource } from "../../lib/tauri/commands";
import type { WorkspaceSkill } from "../../types/domain";
import type { TranslationKey } from "../../lib/i18n/translations";
import { pushErrorToast, pushSuccessToast } from "../../state/toastStore";
import { skillGenOf, sourceLabel, useSkillGenStore } from "../../state/skillGenStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useT } from "../../state/languageStore";
import { ChatModelPicker } from "../ai/ChatModelPicker";
import { ThinkingOrb } from "../common/ThinkingOrb";
import { AiWand } from "../common/AiGlyph";
import { buttonClass } from "../common/Button";
import { fieldClass } from "../common/recipes";

/** What anydoc reads (`story_source_document`), plus Markdown and text read as they are. */
const DOCUMENT_EXTENSIONS = ["pdf", "docx", "pptx", "xlsx", "odt", "ods", "odp", "rtf", "epub", "csv", "md", "markdown", "txt"];

const TEXTAREA =
  "w-full resize-y rounded-md border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-2.5 py-1.5 text-[12.5px] leading-relaxed text-[var(--cf-text)] outline-none placeholder:text-[var(--cf-text-faint)] focus:border-[var(--cf-accent)]";

const LINK = "flex items-center gap-1 text-[12px] text-[var(--cf-accent)] hover:underline disabled:opacity-50 disabled:no-underline";

const SOURCE_ICONS = { repo: FolderGit2, document: FileText, url: Globe, text: Type } as const;

/**
 * «Generar con IA»: a skill written by the `skills` task's engine — cloud or local, switched in place
 * by the picker — from a repository, documents (read by anydoc), web pages or text. The prompt that
 * says what a good skill is lives in «Tareas y prompts» › Generar skill.
 *
 * The draft is shown before anything is written: its name and every file, editable, then saved into
 * the workspace or downloaded as a `.skill`. Its state lives in `skillGenStore`, by workspace, so a
 * run started here survives closing Settings.
 */
export function SkillGenerator({
  workspaceId,
  onSaved,
  onClose,
}: {
  workspaceId: string;
  onSaved: (skill: WorkspaceSkill) => Promise<void> | void;
  onClose: () => void;
}) {
  const t = useT();
  const gen = useSkillGenStore((s) => skillGenOf(s, workspaceId));
  const { patch, generate, stop, discard, reset } = useSkillGenStore.getState();
  const projects = useWorkspaceStore((s) => s.projectsByWorkspace[workspaceId] ?? []);
  const [adding, setAdding] = useState<"repo" | "url" | "text" | null>(null);
  const [draftUrl, setDraftUrl] = useState("");
  const [draftText, setDraftText] = useState("");
  const running = Boolean(gen.runId);

  const add = (source: SkillSource) => {
    const already = gen.sources.some((s) => JSON.stringify(s) === JSON.stringify(source));
    if (!already) patch(workspaceId, { sources: [...gen.sources, source] });
    setAdding(null);
  };

  const removeSource = (at: number) => patch(workspaceId, { sources: gen.sources.filter((_, i) => i !== at) });

  const pickFolder = async () => {
    const dir = await openDialog({ directory: true, multiple: false, title: t("skills.gen.pickFolder") });
    if (typeof dir === "string") add({ kind: "repo", path: dir });
  };

  const pickDocuments = async () => {
    const picked = await openDialog({
      multiple: true,
      title: t("skills.gen.pickDocument"),
      filters: [{ name: t("skills.gen.documents"), extensions: DOCUMENT_EXTENSIONS }],
    });
    const paths = Array.isArray(picked) ? picked : typeof picked === "string" ? [picked] : [];
    const fresh = paths.filter((path) => !gen.sources.some((s) => s.kind === "document" && s.path === path));
    if (fresh.length) patch(workspaceId, { sources: [...gen.sources, ...fresh.map((path) => ({ kind: "document" as const, path }))] });
  };

  const addUrl = () => {
    const url = draftUrl.trim();
    if (!/^https?:\/\/\S+$/i.test(url)) {
      pushErrorToast(t("skills.gen.badUrl"));
      return;
    }
    add({ kind: "url", url });
    setDraftUrl("");
  };

  const addText = () => {
    if (!draftText.trim()) return;
    add({ kind: "text", text: draftText });
    setDraftText("");
  };

  return (
    <div className="space-y-2.5 rounded-md border border-[var(--cf-border)] p-2.5">
      <div className="flex items-center gap-2">
        <AiWand size={13} />
        <span className="text-[12px] font-medium text-[var(--cf-text)]">{t("skills.gen.title")}</span>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("common.close")}
          className="ml-auto text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
        >
          <X size={13} />
        </button>
      </div>

      {gen.draft ? (
        <DraftReview
          workspaceId={workspaceId}
          draft={gen.draft}
          onChange={(draft) => patch(workspaceId, { draft })}
          onRegenerate={() => void generate(workspaceId)}
          onDiscard={() => discard(workspaceId)}
          onSaved={async (skill) => {
            reset(workspaceId);
            await onSaved(skill);
          }}
        />
      ) : (
        <>
          {gen.sources.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {gen.sources.map((source, at) => {
                const Icon = SOURCE_ICONS[source.kind];
                return (
                  <span
                    key={at}
                    title={source.kind === "text" ? source.text.slice(0, 400) : sourceLabel(source)}
                    className="flex max-w-[260px] items-center gap-1 rounded-full border border-[var(--cf-border)] py-0.5 pl-2 pr-1 text-[11.5px] text-[var(--cf-text)]"
                  >
                    <Icon size={11} className="shrink-0 text-[var(--cf-text-muted)]" />
                    <span className="truncate">{sourceLabel(source) || t("skills.gen.sourceText")}</span>
                    <button
                      type="button"
                      disabled={running}
                      onClick={() => removeSource(at)}
                      aria-label={t("skills.gen.removeSource")}
                      className="rounded-full p-0.5 text-[var(--cf-text-muted)] hover:text-[var(--cf-danger)]"
                    >
                      <X size={10} />
                    </button>
                  </span>
                );
              })}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <span className="text-[11.5px] text-[var(--cf-text-muted)]">{t("skills.gen.addFrom")}</span>
            <button type="button" disabled={running} onClick={() => setAdding((a) => (a === "repo" ? null : "repo"))} className={LINK}>
              <FolderGit2 size={12} /> {t("skills.gen.sourceRepo")}
            </button>
            <button type="button" disabled={running} onClick={() => void pickDocuments()} className={LINK}>
              <FileText size={12} /> {t("skills.gen.sourceDocument")}
            </button>
            <button type="button" disabled={running} onClick={() => setAdding((a) => (a === "url" ? null : "url"))} className={LINK}>
              <Globe size={12} /> {t("skills.gen.sourceUrl")}
            </button>
            <button type="button" disabled={running} onClick={() => setAdding((a) => (a === "text" ? null : "text"))} className={LINK}>
              <Type size={12} /> {t("skills.gen.sourceText")}
            </button>
          </div>

          {adding === "repo" && (
            <div className="flex flex-wrap items-center gap-1.5">
              {projects.map((project) => (
                <button
                  key={project.id}
                  type="button"
                  onClick={() => add({ kind: "repo", path: project.local_path })}
                  title={project.local_path}
                  className="rounded-full border border-[var(--cf-border)] px-2 py-0.5 text-[11.5px] text-[var(--cf-text)] hover:border-[var(--cf-accent)]"
                >
                  {project.name}
                </button>
              ))}
              <button type="button" onClick={() => void pickFolder()} className={LINK}>
                <Plus size={12} /> {t("skills.gen.otherFolder")}
              </button>
            </div>
          )}
          {adding === "url" && (
            <div className="flex gap-1.5">
              <input
                value={draftUrl}
                onChange={(e) => setDraftUrl(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addUrl()}
                autoFocus
                placeholder="https://"
                className={fieldClass({ className: "flex-1 font-mono" })}
              />
              <button type="button" onClick={addUrl} disabled={!draftUrl.trim()} className={buttonClass({ variant: "secondary" })}>
                {t("skills.gen.add")}
              </button>
            </div>
          )}
          {adding === "text" && (
            <div className="space-y-1.5">
              <textarea
                value={draftText}
                onChange={(e) => setDraftText(e.target.value)}
                autoFocus
                rows={5}
                placeholder={t("skills.gen.textPlaceholder")}
                className={TEXTAREA}
              />
              <button type="button" onClick={addText} disabled={!draftText.trim()} className={buttonClass({ variant: "secondary", size: "sm" })}>
                {t("skills.gen.add")}
              </button>
            </div>
          )}

          <textarea
            value={gen.focus}
            onChange={(e) => patch(workspaceId, { focus: e.target.value })}
            disabled={running}
            rows={2}
            placeholder={t("skills.gen.focusPlaceholder")}
            className={TEXTAREA}
          />

          {gen.error && <p className="text-[11.5px] text-[var(--cf-danger)]">{gen.error}</p>}

          <div className="flex items-center gap-2">
            <ChatModelPicker task="skills" liveModel={null} chatActive={false} />
            <div className="ml-auto flex items-center gap-2">
              {running ? (
                <>
                  <ThinkingOrb size="sm" />
                  <span className="text-[12px] text-[var(--cf-text-muted)]">{t("skills.gen.running")}</span>
                  <button type="button" onClick={() => stop(workspaceId)} className={buttonClass({ variant: "secondary", size: "sm" })}>
                    {t("skills.gen.stop")}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => void generate(workspaceId)}
                  disabled={gen.sources.length === 0}
                  title={gen.sources.length === 0 ? t("skills.gen.needSource") : undefined}
                  className={buttonClass({ variant: "primary", size: "sm" })}
                >
                  <AiWand size={12} /> {t("skills.gen.generate")}
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** The skill as written: notes on what was fixed, its name, and every file — all editable. */
function DraftReview({
  workspaceId,
  draft,
  onChange,
  onRegenerate,
  onDiscard,
  onSaved,
}: {
  workspaceId: string;
  draft: SkillDraft;
  onChange: (draft: SkillDraft) => void;
  onRegenerate: () => void;
  onDiscard: () => void;
  onSaved: (skill: WorkspaceSkill) => Promise<void>;
}) {
  const t = useT();
  const [selected, setSelected] = useState(0);
  const [busy, setBusy] = useState<"save" | "download" | null>(null);
  const file = draft.files[Math.min(selected, draft.files.length - 1)];

  const setContent = (content: string) =>
    onChange({ ...draft, files: draft.files.map((f) => (f === file ? { ...f, content } : f)) });

  const save = async () => {
    setBusy("save");
    try {
      await onSaved(await skillSaveDraft(workspaceId, draft.name, draft.files));
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setBusy(null);
    }
  };

  const download = async () => {
    const dest = await saveDialog({
      defaultPath: `${draft.name || "skill"}.skill`,
      filters: [{ name: "Skill", extensions: ["skill"] }],
      title: t("skills.gen.downloadTitle"),
    });
    if (!dest) return;
    setBusy("download");
    try {
      const written = await skillWriteBundle(draft.name, draft.files, dest);
      pushSuccessToast(t("skills.gen.downloaded", { path: written }));
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-2">
      {draft.notes.length > 0 && (
        <ul className="space-y-0.5">
          {draft.notes.map((note, i) => (
            <li key={i} className="flex items-start gap-1.5 text-[11.5px] text-[var(--cf-text-muted)]">
              <AlertTriangle size={11} className="mt-0.5 shrink-0 text-[var(--cf-warning)]" />
              {t(`skills.gen.note.${note.code}` as TranslationKey, { detail: note.detail })}
            </li>
          ))}
        </ul>
      )}

      <label className="flex items-center gap-2 text-[11.5px] text-[var(--cf-text-muted)]">
        {t("skills.gen.name")}
        <input
          value={draft.name}
          onChange={(e) => onChange({ ...draft, name: e.target.value })}
          spellCheck={false}
          className={fieldClass({ size: "sm", className: "flex-1 font-mono" })}
        />
      </label>

      <div className="flex flex-wrap items-center gap-1.5">
        {draft.files.map((f, i) => (
          <button
            key={f.path}
            type="button"
            onClick={() => setSelected(i)}
            className={`rounded px-2 py-0.5 font-mono text-[11px] ${
              f === file ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]" : "text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)]"
            }`}
          >
            {f.path}
          </button>
        ))}
      </div>
      {file && (
        <textarea
          value={file.content}
          onChange={(e) => setContent(e.target.value)}
          rows={14}
          spellCheck={false}
          className="w-full resize-y rounded-md border border-[var(--cf-border)] bg-transparent px-2.5 py-1.5 font-mono text-[12px] leading-relaxed outline-none focus:border-[var(--cf-accent)]"
        />
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => void save()} disabled={busy !== null || !draft.name.trim()} className={buttonClass({ variant: "primary", size: "sm" })}>
          <Save size={12} /> {t("skills.gen.save")}
        </button>
        <button type="button" onClick={() => void download()} disabled={busy !== null || !draft.name.trim()} className={buttonClass({ variant: "secondary", size: "sm" })}>
          <Download size={12} /> {t("skills.gen.download")}
        </button>
        <button type="button" onClick={onRegenerate} disabled={busy !== null} className={LINK}>
          <RotateCcw size={12} /> {t("skills.gen.regenerate")}
        </button>
        <button type="button" onClick={onDiscard} disabled={busy !== null} className="ml-auto text-[12px] text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]">
          {t("skills.gen.discard")}
        </button>
      </div>
    </div>
  );
}
