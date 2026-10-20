import { FolderGit2, ListTree } from "lucide-react";
import { Segmented } from "../../common/Segmented";
import { useWorktreeViewStore } from "../../../state/worktreeViewStore";
import { useT } from "../../../state/languageStore";

/**
 * Tasks or worktrees — the console's two ways of reading the same work. At the very top of the left
 * rail in both layouts, words and not only glyphs, so the other layout is never something the user
 * has to already know is there.
 */
export function LayoutSwitch() {
  const t = useT();
  const layout = useWorktreeViewStore((s) => s.layout);
  const setLayout = useWorktreeViewStore((s) => s.setLayout);
  return (
    <div className="shrink-0 px-2.5 pt-2.5">
      <Segmented
        value={layout}
        onChange={setLayout}
        layoutId="cf-agents-layout"
        full
        ariaLabel={t("wt.layout")}
        options={[
          { value: "worktrees", icon: FolderGit2, label: t("wt.layoutWorktrees"), title: t("wt.layoutWorktreesHint") },
          { value: "tasks", icon: ListTree, label: t("wt.layoutTasks"), title: t("wt.layoutTasksHint") },
        ]}
      />
    </div>
  );
}
