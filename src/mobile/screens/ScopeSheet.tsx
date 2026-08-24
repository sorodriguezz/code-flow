import { Check, FolderGit2, Layers } from "lucide-react";
import { t } from "../i18n";
import { useMobileStore } from "../store";
import { useNav } from "../nav";
import { Sheet } from "../ui/Sheet";
import { Card, Divider, Row, Section } from "../ui/List";
import { Badge } from "../ui/Feedback";

/**
 * Which workspace, and which project inside it.
 *
 * # Why this is a sheet and not two selects in the header
 *
 * It was two native `<select>`s pinned above every screen: ~97 px of the least reachable part of a
 * phone, permanently, for a control most sessions never touch. They were unlabelled, they were the
 * only sub-44px targets in the client, and a `<select>` shows the *current* value and nothing else —
 * so the one question they could not answer was the one worth asking, which is what else there is.
 *
 * Moved here, the scope costs one line in each screen's app bar — the project's name, which is worth
 * showing anyway — and the picker gets a full sheet: both lists, room for the branch and the repo
 * path, and a tick on where you are.
 */
export function ScopeSheet() {
  const back = useNav((s) => s.back);
  const workspaces = useMobileStore((s) => s.workspaces);
  const workspaceId = useMobileStore((s) => s.workspaceId);
  const projects = useMobileStore((s) => s.projects);
  const projectId = useMobileStore((s) => s.projectId);
  const setWorkspace = useMobileStore((s) => s.setWorkspace);
  const setProject = useMobileStore((s) => s.setProject);

  /**
   * Applies a choice, and lets the store close this sheet.
   *
   * Deliberately **not** `back()` followed by the action. `setWorkspace` and `setProject` both call
   * `resetDepth()`, which unwinds the stack — and this sheet is on that stack. Closing it here as
   * well would queue two history jumps for one tap, and `history.go` is asynchronous, so the second
   * would be computed against a depth the first had already spent: one tap, two entries popped, and
   * on a shallow stack that walks the user out of the app.
   */
  const pick = (action: () => Promise<void>) => {
    void action();
  };

  return (
    <Sheet title={t("scope.title")}>
      {workspaces.length > 1 && (
        <Section title={t("scope.workspace")}>
          <Card>
            {workspaces.map((workspace, index) => (
              <div key={workspace.id}>
                {index > 0 && <Divider inset />}
                <Row
                  leading={<Layers size={16} className="text-[var(--cf-text-muted)]" aria-hidden />}
                  title={workspace.name}
                  chevron={false}
                  trailing={
                    workspace.id === workspaceId ? (
                      <Check size={17} className="text-[var(--cf-accent)]" aria-hidden />
                    ) : undefined
                  }
                  onClick={() => {
                    if (workspace.id === workspaceId) {
                      back();
                      return;
                    }
                    pick(() => setWorkspace(workspace.id));
                  }}
                />
              </div>
            ))}
          </Card>
        </Section>
      )}

      <Section title={t("scope.project")}>
        {projects.length === 0 ? (
          <p className="px-1 py-2 text-base text-[var(--cf-text-muted)]">{t("scope.noProjects")}</p>
        ) : (
          <Card>
            {projects.map((project, index) => (
              <div key={project.id}>
                {index > 0 && <Divider inset />}
                <Row
                  leading={
                    <FolderGit2 size={16} className="text-[var(--cf-text-muted)]" aria-hidden />
                  }
                  title={project.name}
                  // The path, because two projects called `api` in two checkouts is the normal case
                  // on a developer's machine and the name alone cannot tell them apart.
                  subtitle={project.local_path}
                  chevron={false}
                  trailing={
                    project.id === projectId ? (
                      <Badge tone="accent">
                        <Check size={11} aria-hidden />
                      </Badge>
                    ) : undefined
                  }
                  onClick={() => {
                    if (project.id === projectId) {
                      back();
                      return;
                    }
                    pick(() => setProject(project.id));
                  }}
                />
              </div>
            ))}
          </Card>
        )}
      </Section>
    </Sheet>
  );
}
