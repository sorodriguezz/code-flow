import { useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { ChevronDown, FileArchive, FolderInput, Loader2, PackagePlus, Plus, Trash2 } from "lucide-react";
import {
  createCustomSkill,
  deleteSkillFile,
  importSkillFromFile,
  importSkillFromFolder,
  installWorkspaceSkill,
  listSkillFiles,
  listWorkspaceSkills,
  readSkillFile,
  removeWorkspaceSkill,
  setWorkspaceSkillEnabled,
  writeSkillFile,
} from "../../lib/tauri/commands";
import { onSkillsProgress } from "../../lib/tauri/events";
import { pushErrorToast } from "../../state/toastStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import type { WorkspaceSkill } from "../../types/domain";
import { confirmAction } from "../../state/confirmStore";
import { useT } from "../../state/languageStore";
import { Checkbox } from "../common/Checkbox";
import { Skeleton } from "../common/Skeleton";
import { SettingsHeader } from "../api/settingsChrome";
import { riseDelay } from "../../lib/rise";

const DEFAULT_SKILL_MD = "---\nname: my-skill\ndescription: What this skill does and when to use it.\n---\n\n# My skill\n\nInstructions for the model…\n";

export function SkillsSettings() {
  const t = useT();
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const [skills, setSkills] = useState<WorkspaceSkill[]>([]);
  const [repo, setRepo] = useState("");
  const [skillName, setSkillName] = useState("");
  const [installing, setInstalling] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");

  /**
   * Re-reads one workspace's skills — and refuses to publish them into a screen that has moved on.
   *
   * Every caller below holds the `workspaceId` of the render it was created in, while the header and
   * the rows around it are drawn from the live one. An install is the long case (a clone and a copy,
   * seconds at least) but even a delete is a round trip, so switching workspace while one is in
   * flight is ordinary. Without the check the answer lands anyway and the panel lists one
   * workspace's skills under another's header — and the trash button beside each row then deletes
   * the row and the on-disk directory of a workspace the user is no longer in, having asked them to
   * confirm by a name that looked local.
   */
  const reload = async (id: string) => {
    const loaded = await listWorkspaceSkills(id);
    if (useWorkspaceStore.getState().activeWorkspaceId !== id) return;
    setSkills(loaded);
  };

  useEffect(() => {
    if (workspaceId) void reload(workspaceId);
    else setSkills([]);
  }, [workspaceId]);

  if (!workspaceId) {
    return (
      <section>
        <SettingsHeader title={t("settings.skillsTitle")} hint={t("settings.skillsSelectWorkspace")} />
      </section>
    );
  }

  const install = async () => {
    if (!repo.trim() || !skillName.trim()) return;
    setInstalling(true);
    setLines([]);
    const unlisten = await onSkillsProgress((e) => setLines((prev) => [...prev.slice(-200), e.line]));
    try {
      await installWorkspaceSkill(workspaceId, repo.trim(), skillName.trim());
      setRepo("");
      setSkillName("");
      await reload(workspaceId);
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setInstalling(false);
      void unlisten();
    }
  };

  const createSkill = async () => {
    if (!newName.trim()) return;
    try {
      const created = await createCustomSkill(workspaceId, newName.trim(), DEFAULT_SKILL_MD);
      setNewName("");
      setCreating(false);
      await reload(workspaceId);
      setExpandedId(created.id);
    } catch (e) {
      pushErrorToast(String(e));
    }
  };

  const importFolder = async () => {
    const dir = await openDialog({ directory: true, multiple: false, title: t("settings.skillImportTitle") });
    if (typeof dir !== "string") return;
    try {
      await importSkillFromFolder(workspaceId, dir);
      await reload(workspaceId);
    } catch (e) {
      pushErrorToast(String(e));
    }
  };

  /**
   * The other half of "get a skill onto this machine": a `.skill` bundle, which is the shape a
   * skill travels in once it has left a repository — the zipped folder Claude hands back, and the
   * thing that actually arrives in a chat window or an email.
   *
   * `.zip` is in the filter beside it because a bundle re-saved by a browser or a mail client
   * routinely arrives under that extension instead, and a dialog that refuses to *show* the file
   * the user is looking straight at reads as the feature being broken. The backend does not care
   * what it is called: it looks for a `SKILL.md` inside and says so plainly when there isn't one.
   */
  const importBundle = async () => {
    const file = await openDialog({
      multiple: false,
      title: t("settings.skillImportBundleTitle"),
      filters: [{ name: "Skill", extensions: ["skill", "zip"] }],
    });
    if (typeof file !== "string") return;
    try {
      await importSkillFromFile(workspaceId, file);
      await reload(workspaceId);
    } catch (e) {
      pushErrorToast(String(e));
    }
  };

  const toggle = async (skill: WorkspaceSkill, enabled: boolean) => {
    setSkills((prev) => prev.map((s) => (s.id === skill.id ? { ...s, enabled } : s)));
    try {
      await setWorkspaceSkillEnabled(skill.id, enabled);
    } catch (e) {
      pushErrorToast(String(e));
      await reload(workspaceId);
    }
  };

  const remove = async (skill: WorkspaceSkill) => {
    if (!(await confirmAction(t("settings.removeSkillConfirm", { name: skill.skill_name })))) return;
    try {
      await removeWorkspaceSkill(skill.id);
      if (expandedId === skill.id) setExpandedId(null);
      await reload(workspaceId);
    } catch (e) {
      pushErrorToast(String(e));
    }
  };

  return (
    <section>
      <SettingsHeader
        title={t("settings.skillsTitle")}
        hint={
          <>
            {t("settings.skillsHintPrefix")}{" "}
            <a
              href="https://www.skills.sh/"
              target="_blank"
              rel="noreferrer"
              className="text-[var(--cf-accent)] underline"
            >
              skills.sh
            </a>{" "}
            {t("settings.skillsHintSuffix")} {t("settings.skillsOnlyClaude")}
          </>
        }
      />

      <div className="mb-3 space-y-2 rounded-lg border border-[var(--cf-border)] p-3">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
          {t("settings.skillFromRegistry")}
        </p>
        <div className="flex gap-1.5">
          <input
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            disabled={installing}
            placeholder={t("settings.skillRepoPlaceholder")}
            className="flex-1 rounded-md border border-[var(--cf-border)] bg-transparent px-2.5 py-1.5 font-mono text-[13px] outline-none focus:border-[var(--cf-accent)] disabled:opacity-50"
          />
          <input
            value={skillName}
            onChange={(e) => setSkillName(e.target.value)}
            disabled={installing}
            placeholder={t("settings.skillNamePlaceholder")}
            className="w-40 rounded-md border border-[var(--cf-border)] bg-transparent px-2.5 py-1.5 font-mono text-[13px] outline-none focus:border-[var(--cf-accent)] disabled:opacity-50"
          />
          <button
            onClick={install}
            disabled={installing || !repo.trim() || !skillName.trim()}
            className="flex shrink-0 items-center gap-1.5 rounded-md bg-[var(--cf-accent)] px-3 py-1.5 text-[12px] font-medium text-white disabled:opacity-40"
          >
            {installing ? <Loader2 size={13} className="animate-spin" /> : <PackagePlus size={13} />}
            {installing ? t("settings.installingSkill") : t("settings.installSkill")}
          </button>
        </div>
        {lines.length > 0 && (
          <div className="max-h-28 overflow-auto rounded-md bg-black/[0.04] p-2 font-mono text-[11px] text-[var(--cf-text-muted)] dark:bg-white/[0.06]">
            {lines.map((line, i) => (
              <div key={i} className="whitespace-pre-wrap break-all">
                {line}
              </div>
            ))}
          </div>
        )}

        <div className="flex items-center gap-2 pt-1">
          {creating ? (
            <div className="flex flex-1 gap-1.5">
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                autoFocus
                placeholder={t("settings.skillNamePlaceholder")}
                onKeyDown={(e) => e.key === "Enter" && void createSkill()}
                className="flex-1 rounded-md border border-[var(--cf-border)] bg-transparent px-2.5 py-1.5 font-mono text-[13px] outline-none focus:border-[var(--cf-accent)]"
              />
              <button onClick={() => void createSkill()} disabled={!newName.trim()} className="rounded-md bg-[var(--cf-accent)] px-3 py-1.5 text-[12px] font-medium text-white disabled:opacity-40">
                {t("common.create")}
              </button>
              <button onClick={() => setCreating(false)} className="px-2 text-[12px] text-[var(--cf-text-muted)]">
                {t("common.cancel")}
              </button>
            </div>
          ) : (
            <>
              <button onClick={() => setCreating(true)} className="flex items-center gap-1 text-[12px] text-[var(--cf-accent)] hover:underline">
                <Plus size={13} /> {t("settings.skillCreateCustom")}
              </button>
              <button onClick={() => void importBundle()} className="flex items-center gap-1 text-[12px] text-[var(--cf-accent)] hover:underline">
                <FileArchive size={13} /> {t("settings.skillImportBundle")}
              </button>
              <button onClick={() => void importFolder()} className="flex items-center gap-1 text-[12px] text-[var(--cf-accent)] hover:underline">
                <FolderInput size={13} /> {t("settings.skillImportFolder")}
              </button>
            </>
          )}
        </div>
      </div>

      <div className="space-y-1">
        {skills.map((s, at) => (
          <div key={s.id} style={riseDelay(at)} className="cf-rise rounded-md border border-[var(--cf-border)]">
            <div className="flex items-center gap-2 px-2.5 py-1.5 text-[12px]">
              <Checkbox checked={s.enabled} onChange={(enabled) => void toggle(s, enabled)} />
              <span className={`font-medium ${s.enabled ? "" : "text-[var(--cf-text-muted)] line-through"}`}>{s.skill_name}</span>
              <span className="rounded bg-black/[0.05] px-1.5 py-0.5 text-[10px] text-[var(--cf-text-muted)] dark:bg-white/[0.08]">
                {s.source_repo === "custom"
                  ? t("settings.skillBadgeCustom")
                  : s.source_repo === "local"
                    ? t("settings.skillBadgeLocal")
                    : s.source_repo === "bundle"
                      ? t("settings.skillBadgeBundle")
                      : s.source_repo}
              </span>
              <div className="ml-auto flex items-center gap-2">
                <button
                  onClick={() => setExpandedId((id) => (id === s.id ? null : s.id))}
                  className="flex items-center gap-1 text-[11px] text-[var(--cf-text-muted)] hover:text-[var(--cf-accent)]"
                >
                  <ChevronDown size={13} className={`transition-transform ${expandedId === s.id ? "" : "-rotate-90"}`} />
                  {t("settings.skillEdit")}
                </button>
                <button onClick={() => void remove(s)} className="text-[var(--cf-text-muted)] hover:text-[var(--cf-danger)]">
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
            {expandedId === s.id && (
              <div className="border-t border-[var(--cf-border)] p-2.5">
                <SkillFilesEditor workspaceId={workspaceId} skillName={s.skill_name} />
              </div>
            )}
          </div>
        ))}
        {skills.length === 0 && <p className="text-[12px] text-[var(--cf-text-muted)]">{t("settings.noSkills")}</p>}
      </div>
    </section>
  );
}

/** In-app editor for every file inside a skill's folder — a file list plus a per-file editor
 * (save on blur), with add/delete. Path-safe on the backend (no traversal outside the skill). */
function SkillFilesEditor({ workspaceId, skillName }: { workspaceId: string; skillName: string }) {
  const t = useT();
  const [files, setFiles] = useState<string[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [addingName, setAddingName] = useState("");
  const [savedFlash, setSavedFlash] = useState(false);

  const load = async (keep?: string) => {
    const list = await listSkillFiles(workspaceId, skillName);
    setFiles(list);
    const pick = keep && list.includes(keep) ? keep : list.find((f) => f === "SKILL.md") ?? list[0] ?? null;
    setSelected(pick);
    setContent(pick ? await readSkillFile(workspaceId, skillName, pick) : "");
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, skillName]);

  const openFile = async (rel: string) => {
    setSelected(rel);
    setContent(await readSkillFile(workspaceId, skillName, rel));
  };

  const save = async () => {
    if (!selected) return;
    await writeSkillFile(workspaceId, skillName, selected, content);
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 1400);
  };

  const addFile = async () => {
    const rel = addingName.trim();
    if (!rel) return;
    await writeSkillFile(workspaceId, skillName, rel, "");
    setAddingName("");
    await load(rel);
  };

  const removeFile = async (rel: string) => {
    if (!(await confirmAction(t("settings.skillDeleteFileConfirm", { name: rel })))) return;
    await deleteSkillFile(workspaceId, skillName, rel);
    await load();
  };

  if (files === null) return <Skeleton className="h-32 w-full" />;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {files.map((f) => (
          <button
            key={f}
            onClick={() => void openFile(f)}
            className={`rounded px-2 py-0.5 font-mono text-[11px] ${
              f === selected ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]" : "text-[var(--cf-text-muted)] hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
            }`}
          >
            {f}
          </button>
        ))}
        <input
          value={addingName}
          onChange={(e) => setAddingName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void addFile()}
          placeholder={t("settings.skillNewFile")}
          className="w-32 rounded border border-[var(--cf-border)] bg-transparent px-1.5 py-0.5 font-mono text-[11px] outline-none focus:border-[var(--cf-accent)]"
        />
      </div>

      {selected && (
        <>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            onBlur={() => void save()}
            rows={12}
            spellCheck={false}
            className="w-full resize-y rounded-md border border-[var(--cf-border)] bg-transparent px-2.5 py-1.5 font-mono text-[12px] leading-relaxed outline-none focus:border-[var(--cf-accent)]"
          />
          <div className="flex items-center justify-between">
            <span className="text-[10.5px] text-[var(--cf-text-muted)]">
              {savedFlash ? t("settings.saved") : t("settings.templateAutosave")}
            </span>
            <button onClick={() => void removeFile(selected)} className="flex items-center gap-1 text-[11px] text-[var(--cf-text-muted)] hover:text-[var(--cf-danger)]">
              <Trash2 size={11} /> {t("settings.skillDeleteFile")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
