import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { FileGlyph } from "../common/FileGlyph";
import { Segmented } from "../common/Segmented";
import { hierarchyChildren, resetHierarchyCache, type HierarchyMode, type HierarchyNode } from "../../lib/hierarchy";
import { useEditorPanelStore } from "../../state/editorPanelStore";
import { pushErrorToast } from "../../state/toastStore";
import { useT } from "../../state/languageStore";

/** How deep a branch can be opened — a recursive function would otherwise go on for ever. */
const MAX_DEPTH = 12;

/**
 * The «Jerarquía» tab: the call or type hierarchy of the symbol it was asked for (the editor's right
 * click), as a tree that loads each level when it is opened — see `lib/hierarchy` for where the
 * answers come from. The toggle flips direction on the same root: who calls it / what it calls,
 * what it extends / what extends it.
 */
export function HierarchyView({ repoPath, onOpen }: { repoPath: string; onOpen: (path: string, line: number) => void }) {
  const t = useT();
  const request = useEditorPanelStore((s) => s.hierarchy);
  useEffect(() => {
    resetHierarchyCache();
  }, [request]);
  if (!request) return <p className="px-3 py-2 text-[12px] text-[var(--cf-text-muted)]">{t("hierarchy.none")}</p>;
  const calls = request.mode === "incoming" || request.mode === "outgoing";
  const setMode = (mode: HierarchyMode) => useEditorPanelStore.setState({ hierarchy: { ...request, mode } });
  return (
    <div>
      <div className="flex items-center gap-2 px-2 pb-1 pt-1.5">
        <Segmented<HierarchyMode>
          size="sm"
          layoutId="cf-hierarchy-mode"
          value={request.mode}
          onChange={setMode}
          options={
            calls
              ? [
                  { value: "incoming", label: t("hierarchy.incoming") },
                  { value: "outgoing", label: t("hierarchy.outgoing") },
                ]
              : [
                  { value: "supertypes", label: t("hierarchy.supertypes") },
                  { value: "subtypes", label: t("hierarchy.subtypes") },
                ]
          }
        />
        <span className="min-w-0 truncate text-[11px] text-[var(--cf-text-faint)]">{t("hierarchy.byName")}</span>
      </div>
      <Branch key={`${request.mode}:${request.root.id}`} repoPath={repoPath} mode={request.mode} node={request.root} depth={0} onOpen={onOpen} startOpen />
    </div>
  );
}

function Branch({
  repoPath,
  mode,
  node,
  depth,
  onOpen,
  startOpen = false,
}: {
  repoPath: string;
  mode: HierarchyMode;
  node: HierarchyNode;
  depth: number;
  onOpen: (path: string, line: number) => void;
  startOpen?: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(startOpen);
  const [children, setChildren] = useState<HierarchyNode[] | null>(null);

  useEffect(() => {
    if (!open || children !== null) return;
    let live = true;
    hierarchyChildren(repoPath, mode, node)
      .then((found) => live && setChildren(found))
      .catch((error: unknown) => {
        if (!live) return;
        setChildren([]);
        pushErrorToast(String(error));
      });
    return () => {
      live = false;
    };
  }, [open, children, repoPath, mode, node]);

  const file = node.path.slice(node.path.lastIndexOf("/") + 1);
  const canOpen = depth < MAX_DEPTH;
  return (
    <div>
      <div className="flex h-[24px] items-center gap-1 rounded-md pr-2 hover:bg-[var(--cf-hover)]" style={{ paddingLeft: 6 + depth * 14 }}>
        <button
          type="button"
          onClick={() => canOpen && setOpen((v) => !v)}
          aria-expanded={open}
          className="flex h-4 w-4 shrink-0 items-center justify-center text-[var(--cf-text-faint)]"
        >
          {open && children === null ? (
            <Loader2 size={11} className="animate-spin" />
          ) : open ? (
            <ChevronDown size={12} />
          ) : (
            <ChevronRight size={12} />
          )}
        </button>
        <button type="button" onClick={() => onOpen(node.path, node.line)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
          <span className="shrink-0 text-[12px] text-[var(--cf-text)]">{node.name}</span>
          {node.detail && <span className="shrink-0 font-mono text-[10.5px] text-[var(--cf-text-faint)]">{node.detail}</span>}
          <FileGlyph path={node.path} size={12} />
          <span className="min-w-0 truncate text-[11px] text-[var(--cf-text-faint)]">
            {file}:{node.line}
          </span>
        </button>
      </div>
      {open && children !== null && children.length === 0 && (
        <p className="py-0.5 text-[11px] text-[var(--cf-text-faint)]" style={{ paddingLeft: 26 + depth * 14 }}>
          {t("hierarchy.empty")}
        </p>
      )}
      {open &&
        children?.map((child) => (
          <Branch key={child.id} repoPath={repoPath} mode={mode} node={child} depth={depth + 1} onOpen={onOpen} />
        ))}
    </div>
  );
}
