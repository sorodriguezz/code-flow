import { writeClipboardText } from "../../../lib/clipboard";
import { exportNotes } from "../../../lib/notes/exportActions";
import { worklogGenerate, type WorklogOutcome, type WorklogRequest } from "../../../lib/tauri/worklogCommands";
import { translate } from "../../../state/languageStore";
import { pushErrorToast, useToastStore } from "../../../state/toastStore";
import { useUiStore } from "../../../state/uiStore";
import { useWorkspaceStore } from "../../../state/workspaceStore";
import { commitOf, toSlack, toTeamsHtml } from "./format";

/**
 * What the summary's buttons do — copy for Slack, copy for Teams, export, regenerate — and the
 * commit links of its «Fuentes». Copy and export only: nothing is ever sent from here (user,
 * 2026-10-23: «Copiar para Slack o Teams, o exportar»).
 */

export async function copyForSlack(summary: string): Promise<void> {
  try {
    await writeClipboardText(toSlack(summary));
    useToastStore.getState().pushToast(translate("worklog.copiedSlack"), "success");
  } catch (error) {
    pushErrorToast(String(error));
  }
}

/** Rich text where the webview allows it (Teams keeps the lists and links), the Markdown otherwise. */
export async function copyForTeams(summary: string): Promise<void> {
  try {
    const html = toTeamsHtml(summary);
    if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
      try {
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/html": new Blob([html], { type: "text/html" }),
            "text/plain": new Blob([summary], { type: "text/plain" }),
          }),
        ]);
        useToastStore.getState().pushToast(translate("worklog.copiedTeams"), "success");
        return;
      } catch {
        // Outside a gesture, or a webview without rich clipboard: the Markdown, which Teams reads too.
      }
    }
    await writeClipboardText(summary);
    useToastStore.getState().pushToast(translate("worklog.copiedTeams"), "success");
  } catch (error) {
    pushErrorToast(String(error));
  }
}

export async function exportSummary(title: string, summary: string): Promise<void> {
  await exportNotes("md", [{ id: "", title, content: `# ${title}\n\n${summary}` }], title);
}

/** Generates and keeps the summary as a note of the open workspace (over `noteId` to regenerate). */
export async function generateIntoNote(request: WorklogRequest, noteId: string | null = null): Promise<WorklogOutcome | null> {
  const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;
  if (!workspaceId) {
    pushErrorToast(translate("worklog.noWorkspace"));
    return null;
  }
  try {
    const outcome = await worklogGenerate(request, workspaceId, true, noteId);
    const { useNotesStore } = await import("../../../state/notesStore");
    const store = useNotesStore.getState();
    await store.refresh();
    if (outcome.note) {
      if (noteId && store.activeId === noteId) await store.syncFromDisk(noteId);
      else await store.openNote(outcome.note.id);
    }
    if (outcome.fallbackReason) {
      useToastStore.getState().pushToast(translate("worklog.fellBack").replace("{reason}", outcome.fallbackReason), "info");
    }
    return outcome;
  } catch (error) {
    pushErrorToast(String(error));
    return null;
  }
}

/**
 * A commit link of «Fuentes» (`#cf-commit=…`): its repository brought into focus, the graph on
 * screen, the commit selected once the repository has loaded.
 */
export async function openCommitLink(href: string): Promise<boolean> {
  const commit = commitOf(href);
  if (!commit) return false;
  try {
    await useWorkspaceStore.getState().focusProject(commit.workspaceId, commit.projectId);
    useUiStore.getState().setActiveView("graph");
    const { useRepoStore } = await import("../../../state/repoStore");
    const project = useWorkspaceStore.getState().activeProject();
    const deadline = Date.now() + 5000;
    while (project && useRepoStore.getState().repoPath !== project.local_path && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await useRepoStore.getState().selectCommit(commit.sha);
  } catch (error) {
    pushErrorToast(String(error));
  }
  return true;
}
