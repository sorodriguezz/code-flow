import { describe, expect, it } from "vitest";
import { projectMenuItems, type ProjectMenuContext } from "./projectMenu";
import type { Project } from "../../types/domain";

const t = ((key: string, vars?: Record<string, string>) => (vars ? `${key}:${Object.values(vars).join(",")}` : key)) as ProjectMenuContext["t"];
const noop = () => {};

const context = (editor: ProjectMenuContext["editor"]): ProjectMenuContext => ({
  project: { id: "p", name: "repo", color: "#000000" } as Project,
  broken: false,
  detached: false,
  t,
  onOpen: noop,
  onDetach: noop,
  onFocusWindow: noop,
  onReveal: noop,
  onCopyPath: noop,
  onSettings: noop,
  onRemove: noop,
  editor,
});

describe("the repository's external editor in its menu", () => {
  const installed = [
    { id: "vscode", label: "VS Code" },
    { id: "cursor", label: "Cursor" },
  ];
  const editor = { label: "Cursor", onOpen: noop, installed, onOpenWith: noop, chosen: "cursor", inherited: "VS Code", onChoose: noop };

  it("opens in the chosen editor, offers the others once, and keeps the choice", () => {
    const labels = projectMenuItems(context(editor)).map((item) => item.label);
    expect(labels).toContain("sidebar.openInEditor:Cursor");
    expect(labels).toContain("sidebar.openWith");
    const choice = projectMenuItems(context(editor)).find((item) => item.label === "sidebar.repoEditor");
    expect(choice?.children?.map((child) => [child.label, child.checked])).toEqual([
      ["sidebar.repoEditorInherit:VS Code", false],
      ["VS Code", false],
      ["Cursor", true],
    ]);
  });

  it("has no «Abrir con» with one editor to open with", () => {
    const labels = projectMenuItems(context({ ...editor, installed: installed.slice(0, 1), chosen: null })).map((item) => item.label);
    expect(labels).not.toContain("sidebar.openWith");
  });
});
