import { useEffect, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  Boxes,
  CloudOff,
  CloudUpload,
  DownloadCloud,
  FolderOpen,
  FolderTree,
  GitBranch,
  Loader2,
  Plus,
  Tag,
  Trash2,
} from "lucide-react";
import { CollapsibleSection } from "../common/CollapsibleSection";
import { buttonClass } from "../common/Button";
import { fieldClass } from "../common/recipes";
import { Segmented } from "../common/Segmented";
import { useGitToolsStore } from "../../state/gitToolsStore";
import { useRepoStore } from "../../state/repoStore";
import { useUiStore } from "../../state/uiStore";
import { useT } from "../../state/languageStore";
import { PAGE, pageDelay, useIncremental } from "../../lib/useIncremental";
import { useFocusTrap } from "../../lib/useFocusTrap";
import { useSectionFold } from "../../state/sidebarFoldStore";
import type { SubmoduleInfo, WorktreeInfo } from "../../lib/tauri/gitCommands";

/**
 * The sidebar sections for tags, submodules and worktrees, under the open repository beside its
 * branches and stashes. Their data and verbs are `gitToolsStore`'s; these only draw them — rows in the
 * sidebar's own idiom (a faint glyph, the name, hover actions), and a header action for the verb that
 * applies to the whole list.
 */

const rowClass =
  "cf-rise group flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[13px] text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)]";
const hoverButton = "hidden shrink-0 text-[var(--cf-text-muted)] group-hover:block disabled:opacity-40";
const headerButton =
  "flex h-[22px] w-[22px] items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)] disabled:opacity-40";

function ShowMore({ hidden, onClick }: { hidden: number; onClick: () => void }) {
  const t = useT();
  if (hidden <= 0) return null;
  return (
    <button
      onClick={onClick}
      className="w-full rounded-md px-2 py-1 text-center text-[11px] font-medium text-[var(--cf-accent)] hover:bg-[var(--cf-hover)]"
    >
      {t("sidebar.showMore", { n: Math.min(hidden, PAGE) })}
    </button>
  );
}

/** Tags: click one to find it in the graph; push it, push them all, delete it here or on the remote. */
export function TagsSection() {
  const fold = useSectionFold("tags");
  const tags = useGitToolsStore((s) => s.tags);
  const pending = useGitToolsStore((s) => s.pending);
  const pushTag = useGitToolsStore((s) => s.pushTag);
  const pushAllTags = useGitToolsStore((s) => s.pushAllTags);
  const deleteTag = useGitToolsStore((s) => s.deleteTag);
  const deleteRemoteTag = useGitToolsStore((s) => s.deleteRemoteTag);
  const remoteOp = useRepoStore((s) => s.remoteOp);
  const hasRemote = useRepoStore((s) => s.remotes.length > 0);
  const repoPath = useRepoStore((s) => s.repoPath);
  const selectCommit = useRepoStore((s) => s.selectCommit);
  const setActiveView = useUiStore((s) => s.setActiveView);
  const t = useT();
  const window = useIncremental(tags.length, repoPath);
  if (tags.length === 0) return null;
  const blocked = remoteOp !== null || pending !== null;

  return (
    <CollapsibleSection
      {...fold}
      icon={Tag}
      title={`${t("tags.title")} (${tags.length})`}
      action={
        hasRemote ? (
          <button
            onClick={() => void pushAllTags()}
            disabled={blocked}
            title={t("tags.pushAll")}
            className={headerButton}
          >
            {pending === "tags" ? <Loader2 size={13} className="animate-spin" /> : <CloudUpload size={13} />}
          </button>
        ) : undefined
      }
    >
      <div className="space-y-0.5">
        {tags.slice(0, window.shown).map((tag, at) => (
          <div key={tag.name} style={pageDelay(at)} className={rowClass}>
            {pending === `tag:${tag.name}` ? (
              <Loader2 size={10} className="shrink-0 animate-spin" />
            ) : (
              <Tag size={10} className="shrink-0 opacity-40" />
            )}
            <button
              type="button"
              onClick={() => {
                setActiveView("graph");
                void selectCommit(tag.target_oid);
              }}
              title={tag.annotated ? `${tag.name}\n${tag.message.trim()}` : `${tag.name}\n${t("tags.lightweight")}`}
              className="min-w-0 flex-1 truncate text-left"
            >
              {tag.name}
            </button>
            {hasRemote && (
              <>
                <button
                  title={t("tags.push")}
                  disabled={blocked}
                  onClick={() => void pushTag(tag.name)}
                  className={`${hoverButton} hover:text-[var(--cf-accent)]`}
                >
                  <CloudUpload size={12} />
                </button>
                <button
                  title={t("tags.deleteRemote")}
                  disabled={blocked}
                  onClick={() => void deleteRemoteTag(tag.name)}
                  className={`${hoverButton} hover:text-[var(--cf-danger)]`}
                >
                  <CloudOff size={12} />
                </button>
              </>
            )}
            <button
              title={t("tags.delete")}
              disabled={blocked}
              onClick={() => void deleteTag(tag.name)}
              className={`${hoverButton} hover:text-[var(--cf-danger)]`}
            >
              <Trash2 size={12} />
            </button>
          </div>
        ))}
        <ShowMore hidden={window.hidden} onClick={window.more} />
      </div>
    </CollapsibleSection>
  );
}

function submoduleTitle(sm: SubmoduleInfo, t: ReturnType<typeof useT>): string {
  const short = (id: string | null) => (id ? id.slice(0, 7) : "—");
  const lines = [sm.path];
  if (sm.url) lines.push(sm.url);
  lines.push(t("submodules.recorded", { sha: short(sm.recorded_oid) }));
  lines.push(sm.initialized ? t("submodules.checkedOut", { sha: short(sm.checked_out_oid) }) : t("submodules.notInitialized"));
  if (sm.dirty) lines.push(t("submodules.dirty"));
  return lines.join("\n");
}

/** Submodules: where each stands against what the superproject records, updating them, opening one. */
export function SubmodulesSection() {
  const fold = useSectionFold("submodules");
  const submodules = useGitToolsStore((s) => s.submodules);
  const pending = useGitToolsStore((s) => s.pending);
  const update = useGitToolsStore((s) => s.updateSubmodules);
  const openSubmodule = useGitToolsStore((s) => s.openSubmodule);
  const remoteOp = useRepoStore((s) => s.remoteOp);
  const t = useT();
  const [recursive, setRecursive] = useState(true);
  if (submodules.length === 0) return null;
  const blocked = remoteOp !== null || pending !== null;

  return (
    <CollapsibleSection
      {...fold}
      icon={Boxes}
      title={`${t("submodules.title")} (${submodules.length})`}
      action={
        <button
          onClick={() => void update(null, recursive)}
          disabled={blocked}
          title={t("submodules.updateAll")}
          className={headerButton}
        >
          {pending === "submodules" ? <Loader2 size={13} className="animate-spin" /> : <DownloadCloud size={13} />}
        </button>
      }
    >
      <div className="space-y-0.5">
        {submodules.map((sm, at) => {
          const state = !sm.initialized
            ? { label: t("submodules.stateNew"), color: "var(--cf-warning)" }
            : sm.out_of_sync
              ? { label: t("submodules.stateMoved"), color: "var(--cf-warning)" }
              : sm.dirty
                ? { label: t("submodules.stateDirty"), color: "var(--cf-text-muted)" }
                : null;
          return (
            <div key={sm.path} style={pageDelay(at)} className={rowClass} title={submoduleTitle(sm, t)}>
              {pending === `submodule:${sm.path}` ? (
                <Loader2 size={10} className="shrink-0 animate-spin" />
              ) : (
                <Boxes size={10} className="shrink-0 opacity-40" />
              )}
              <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{sm.path}</span>
              {state && (
                <span className="shrink-0 text-[10.5px]" style={{ color: state.color }}>
                  {state.label}
                </span>
              )}
              <button
                title={t("submodules.update")}
                disabled={blocked}
                onClick={() => void update(sm.path, recursive)}
                className={`${hoverButton} hover:text-[var(--cf-accent)]`}
              >
                <DownloadCloud size={12} />
              </button>
              <button
                title={t("submodules.open")}
                disabled={!sm.initialized}
                onClick={() => void openSubmodule(sm)}
                className={`${hoverButton} hover:text-[var(--cf-accent)]`}
              >
                <FolderOpen size={12} />
              </button>
            </div>
          );
        })}
        <label
          title={t("submodules.recursiveHint")}
          className="flex cursor-pointer items-center gap-1.5 px-1.5 pt-0.5 text-[11px] text-[var(--cf-text-faint)]"
        >
          <input type="checkbox" checked={recursive} onChange={(e) => setRecursive(e.target.checked)} />
          {t("submodules.recursive")}
        </label>
      </div>
    </CollapsibleSection>
  );
}

/** Worktrees: every checkout of this repository, a new one, removing one, opening one. */
export function WorktreesSection() {
  const fold = useSectionFold("worktrees");
  const worktrees = useGitToolsStore((s) => s.worktrees);
  const pending = useGitToolsStore((s) => s.pending);
  const removeWorktree = useGitToolsStore((s) => s.removeWorktree);
  const openWorktree = useGitToolsStore((s) => s.openWorktree);
  const prune = useGitToolsStore((s) => s.pruneWorktrees);
  const t = useT();
  const [adding, setAdding] = useState(false);
  const linked = worktrees.filter((w) => !w.is_main);
  const blocked = pending !== null;

  return (
    <>
      <CollapsibleSection
        {...fold}
        icon={FolderTree}
        title={linked.length > 0 ? `${t("worktrees.title")} (${linked.length})` : t("worktrees.title")}
        action={({ expand }) => (
          <button
            onClick={() => {
              expand();
              setAdding(true);
            }}
            disabled={blocked}
            title={t("worktrees.add")}
            className={headerButton}
          >
            <Plus size={14} />
          </button>
        )}
      >
        <div className="space-y-0.5">
          {/* The main checkout alone is just "this repository" — rows only once there is another. */}
          {linked.length > 0 &&
            worktrees.map((wt, at) => (
              <WorktreeRow
                key={wt.path}
                worktree={wt}
                at={at}
                busy={blocked}
                onOpen={() => void openWorktree(wt)}
                onRemove={() => void removeWorktree(wt)}
                t={t}
              />
            ))}
          {worktrees.some((w) => w.prunable) && (
            <button
              onClick={() => void prune()}
              disabled={blocked}
              title={t("worktrees.pruneHint")}
              className="w-full rounded-md px-2 py-1 text-center text-[11px] font-medium text-[var(--cf-accent)] hover:bg-[var(--cf-hover)]"
            >
              {t("worktrees.prune")}
            </button>
          )}
        </div>
      </CollapsibleSection>
      {/* Outside the section's children, which are not mounted while it is folded. */}
      {adding && <AddWorktreeModal onClose={() => setAdding(false)} />}
    </>
  );
}

function WorktreeRow({
  worktree,
  at,
  busy,
  onOpen,
  onRemove,
  t,
}: {
  worktree: WorktreeInfo;
  at: number;
  busy: boolean;
  onOpen: () => void;
  onRemove: () => void;
  t: ReturnType<typeof useT>;
}) {
  const name = worktree.path.split(/[\\/]/).filter(Boolean).pop() ?? worktree.path;
  const label = worktree.branch ?? (worktree.head_oid ? worktree.head_oid.slice(0, 7) : "—");
  return (
    <div
      style={pageDelay(at)}
      className={rowClass}
      title={[worktree.path, worktree.is_main ? t("worktrees.main") : null, worktree.prunable ? t("worktrees.missing") : null]
        .filter(Boolean)
        .join("\n")}
    >
      <GitBranch size={10} className={`shrink-0 ${worktree.is_current ? "opacity-100 text-[var(--cf-accent)]" : "opacity-40"}`} />
      <span className={`min-w-0 flex-1 truncate ${worktree.prunable ? "line-through opacity-60" : ""}`}>
        {label}
        <span className="ml-1.5 font-mono text-[11px] text-[var(--cf-text-faint)]">{name}</span>
      </span>
      {!worktree.is_current && !worktree.prunable && (
        <button title={t("worktrees.open")} onClick={onOpen} className={`${hoverButton} hover:text-[var(--cf-accent)]`}>
          <FolderOpen size={12} />
        </button>
      )}
      {!worktree.is_main && !worktree.is_current && (
        <button
          title={t("worktrees.remove")}
          disabled={busy}
          onClick={onRemove}
          className={`${hoverButton} hover:text-[var(--cf-danger)]`}
        >
          <Trash2 size={12} />
        </button>
      )}
    </div>
  );
}

type BranchMode = "existing" | "new";

/**
 * A new worktree: on a branch that exists (and is not checked out anywhere else — git refuses that,
 * and says so), or on a new one from a start point; in a folder picked with the system dialog. The
 * folder defaults to a sibling of the repository named after the branch, which is the layout almost
 * everyone uses.
 */
function AddWorktreeModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const repoPath = useRepoStore((s) => s.repoPath);
  const branches = useRepoStore((s) => s.branches);
  const addWorktree = useGitToolsStore((s) => s.addWorktree);
  const pending = useGitToolsStore((s) => s.pending);
  const worktrees = useGitToolsStore((s) => s.worktrees);
  const taken = new Set(worktrees.map((w) => w.branch).filter(Boolean));
  const available = branches.filter((b) => !b.is_remote && !taken.has(b.name));
  const [mode, setMode] = useState<BranchMode>(available.length > 0 ? "existing" : "new");
  const [branch, setBranch] = useState(available[0]?.name ?? "");
  const [newName, setNewName] = useState("");
  const [start, setStart] = useState(branches.find((b) => b.is_head)?.name ?? "");
  const [folder, setFolder] = useState("");
  const [folderTouched, setFolderTouched] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef, true);

  const chosen = mode === "existing" ? branch : newName.trim();
  const parent = repoPath ? repoPath.replace(/[\\/][^\\/]+[\\/]?$/, "") : "";
  const repoName = repoPath?.split(/[\\/]/).filter(Boolean).pop() ?? "repo";
  const separator = repoPath?.includes("\\") ? "\\" : "/";

  // Until the user picks a folder, it follows the branch: `../repo-feature-x`.
  useEffect(() => {
    if (folderTouched || !parent) return;
    const slug = chosen.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
    setFolder(slug ? `${parent}${separator}${repoName}-${slug}` : "");
  }, [chosen, folderTouched, parent, repoName, separator]);

  const pick = async () => {
    const picked = await openDialog({ directory: true, multiple: false, title: t("worktrees.pickFolder") });
    if (typeof picked !== "string") return;
    const slug = chosen.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "worktree";
    setFolder(`${picked.replace(/[\\/]+$/, "")}${separator}${repoName}-${slug}`);
    setFolderTouched(true);
  };

  const ready = !!chosen && !!folder.trim() && pending === null;

  const confirm = async () => {
    if (!ready) return;
    const ok = await addWorktree(folder.trim(), chosen, mode === "new", mode === "new" ? start || null : null);
    if (ok) onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-24" onClick={onClose}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT") void confirm();
        }}
        className="w-[440px] rounded-[14px] border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-5 shadow-[var(--cf-shadow-modal)]"
      >
        <h3 className="mb-3 text-[15px] font-semibold">{t("worktrees.add")}</h3>
        <Segmented<BranchMode>
          full
          layoutId="worktree-branch-mode"
          value={mode}
          onChange={setMode}
          options={[
            { value: "existing", label: t("worktrees.existingBranch"), disabled: available.length === 0 },
            { value: "new", label: t("worktrees.newBranch") },
          ]}
        />
        {mode === "existing" ? (
          <select
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            aria-label={t("worktrees.existingBranch")}
            className={fieldClass({ className: "mt-3 w-full" })}
          >
            {available.map((b) => (
              <option key={b.name} value={b.name}>
                {b.name}
              </option>
            ))}
          </select>
        ) : (
          <div className="mt-3 space-y-2">
            <input
              autoFocus
              value={newName}
              spellCheck={false}
              placeholder={t("worktrees.newBranchName")}
              aria-label={t("worktrees.newBranchName")}
              onChange={(e) => setNewName(e.target.value)}
              className={fieldClass({ className: "w-full font-mono" })}
            />
            <select
              value={start}
              onChange={(e) => setStart(e.target.value)}
              title={t("worktrees.startPoint")}
              aria-label={t("worktrees.startPoint")}
              className={fieldClass({ className: "w-full" })}
            >
              {branches.map((b) => (
                <option key={`${b.is_remote}:${b.name}`} value={b.name}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="mt-3 flex gap-2">
          <input
            value={folder}
            spellCheck={false}
            placeholder={t("worktrees.folder")}
            aria-label={t("worktrees.folder")}
            onChange={(e) => {
              setFolder(e.target.value);
              setFolderTouched(true);
            }}
            className={fieldClass({ className: "min-w-0 flex-1 font-mono text-[12px]" })}
          />
          <button type="button" onClick={() => void pick()} className={buttonClass()}>
            <FolderOpen size={13} />
            {t("worktrees.choose")}
          </button>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className={buttonClass({ variant: "ghost" })}>
            {t("common.cancel")}
          </button>
          <button onClick={() => void confirm()} disabled={!ready} className={buttonClass({ variant: "primary" })}>
            {pending === "worktree" ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
            {t("worktrees.create")}
          </button>
        </div>
      </div>
    </div>
  );
}
