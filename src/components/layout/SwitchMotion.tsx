import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Briefcase } from "lucide-react";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useTourStore } from "../../state/tourStore";
import { EASE_OUT, motionLevel } from "../../lib/motion";
import { monogram, monogramStyle } from "../../lib/monogram";
import { DEFAULT_WORKSPACE_COLOR } from "../../lib/workspaceColors";

/**
 * Changing repository or workspace, at the full motion level — and only there (user, 2026-10-14:
 * "cuando las animaciones de la app estén en completo… una animación al cambiar de repositorio y
 * otra al cambiar de workspace que sean llamativas y modernas").
 *
 * # A repository: the view comes into focus
 *
 * The view's contents arrive out of a blur, a hair small, and settle; a band of light in the
 * repository's colour crosses the sheet corner to corner; the sheet's edge lights up in that colour
 * and goes out; a pill in its middle names the repository and floats away. Not on a workspace's view
 * (the API client, Tareas…): the repository changing leaves it as it was, so only the edge and the
 * pill say anything happened.
 *
 * # A workspace: the whole desk slides over
 *
 * Bigger, because more changed: the sidebar and the work column arrive from the side the workspace
 * sits on in the list (later ones from the right, as Spaces do), out of a blur and from a step back,
 * the column a beat after the sidebar. A bloom of the workspace's colour opens from the middle of
 * the window behind a card with its tile and name, and a row of dots under the name — one per
 * workspace — whose lit dot stretches across from where you were to where you are.
 *
 * # How it is driven
 *
 * From the store, not from the switchers: a switch comes from the sidebar's menu, the combination
 * lock, the palette, a notification, a pasted PR link — twenty-odd places, every one of which would
 * otherwise need the same call. A layout effect sees the new ids after React has put the new
 * contents in the DOM and before they are painted, so the old view never shows again and the new
 * one is never seen at full strength first (`useSwapFade` does the same).
 *
 * Only a move from one thing to another plays — the boot's first workspace and repository are a
 * window opening, not a switch. A workspace switch clears the repository and the workspace's own
 * repository lands a few milliseconds later (`loadProjects`): `null` in between is what keeps that
 * second step from playing the repository's animation on top of the workspace's.
 *
 * Only `translate`, `scale`, `opacity` and `filter`, never `transform` — the moved panels may place
 * themselves with one. See-through (`data-glass`), the panels only travel: a frosted header inside
 * them would lose its blur while an ancestor's opacity or filter animates (WebKit), and land it late.
 * The overlays are `position: fixed`, which the full level's arrival animator leaves alone.
 */

/** How long each overlay stays mounted: its longest CSS animation, and a little over. */
const REPO_MS = 1300;
const WORKSPACE_MS = 1500;
/** Past this many workspaces the card leaves its dots out: a row of twenty says nothing. */
const MAX_DOTS = 12;
/** A dot's size and the gap after it, in px — `.cf-switch-space-dot`. */
const DOT = 6;
const DOT_GAP = 6;
/** A long, soft landing: most of the travel in the first third. */
const SETTLE = "cubic-bezier(0.16, 1, 0.3, 1)";

type RepoFx = { kind: "repo"; key: number; name: string; color: string; rect: DOMRect; sweep: boolean };
type WorkspaceFx = { kind: "workspace"; key: number; name: string; color: string; at: number; from: number; count: number };

interface Props {
  /** The work column — the view's sheet and the dock under it. The sidebar is the element before it. */
  column: RefObject<HTMLElement | null>;
  /** The view's sheet: what a repository switch changes. */
  sheet: RefObject<HTMLElement | null>;
  /** Whether the view on screen is one of the repository's, rather than one of the workspace's. */
  showsRepo: () => boolean;
}

export function SwitchMotion({ column, sheet, showsRepo }: Props) {
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const projectId = useWorkspaceStore((s) => s.activeProjectId);
  const shown = useRef({ workspaceId, projectId });
  const running = useRef<Animation[]>([]);
  const played = useRef(0);
  const [fx, setFx] = useState<RepoFx | WorkspaceFx | null>(null);

  useLayoutEffect(() => {
    const before = shown.current;
    shown.current = { workspaceId, projectId };
    const workspaceMoved = before.workspaceId !== null && workspaceId !== null && before.workspaceId !== workspaceId;
    const repoMoved = before.projectId !== null && projectId !== null && before.projectId !== projectId;
    if (!workspaceMoved && !repoMoved) return;
    if (motionLevel() !== "full" || useTourStore.getState().active) return;

    // A switch on top of one still playing starts over from where things are now.
    for (const animation of running.current) animation.cancel();
    running.current = [];
    const glass = document.documentElement.hasAttribute("data-glass");
    const state = useWorkspaceStore.getState();
    const key = ++played.current;

    if (workspaceMoved) {
      const at = state.workspaces.findIndex((w) => w.id === workspaceId);
      const from = state.workspaces.findIndex((w) => w.id === before.workspaceId);
      const workspace = state.workspaces[at];
      if (!workspace) return;
      const side = from >= 0 && at < from ? -1 : 1;
      const travel = `${side * 44}px 0`;
      const frames: Keyframe[] = glass
        ? [
            { translate: travel, scale: 0.95 },
            { translate: "0 0", scale: 1 },
          ]
        : [
            { opacity: 0, translate: travel, scale: 0.95, filter: "blur(12px)" },
            { opacity: 1, translate: "0 0", scale: 1, filter: "blur(0px)" },
          ];
      const panels = [column.current?.previousElementSibling, column.current];
      panels.forEach((panel, index) => {
        if (!(panel instanceof HTMLElement) || typeof panel.animate !== "function") return;
        running.current.push(panel.animate(frames, { duration: 680, delay: index * 70, easing: SETTLE, fill: "backwards" }));
      });
      setFx({
        kind: "workspace",
        key,
        name: workspace.name,
        color: workspace.color || DEFAULT_WORKSPACE_COLOR,
        at,
        from: from >= 0 ? from : at,
        count: state.workspaces.length,
      });
      return;
    }

    const project = state.activeProject();
    const el = sheet.current;
    if (!project || !el) return;
    const sweep = showsRepo();
    if (sweep) {
      const frames: Keyframe[] = glass
        ? [
            { translate: "0 10px", scale: 0.975 },
            { translate: "0 0", scale: 1 },
          ]
        : [
            { opacity: 0, translate: "0 10px", scale: 0.975, filter: "blur(10px)" },
            { opacity: 1, translate: "0 0", scale: 1, filter: "blur(0px)" },
          ];
      for (const view of Array.from(el.children)) {
        if (!(view instanceof HTMLElement) || view.classList.contains("hidden") || typeof view.animate !== "function") continue;
        running.current.push(view.animate(frames, { duration: 560, easing: EASE_OUT, fill: "backwards" }));
      }
    }
    setFx({
      kind: "repo",
      key,
      name: project.name,
      color: project.color || "var(--cf-accent)",
      rect: el.getBoundingClientRect(),
      sweep,
    });
  }, [workspaceId, projectId, column, sheet, showsRepo]);

  useEffect(() => {
    if (!fx) return;
    const timer = window.setTimeout(
      () => setFx((current) => (current?.key === fx.key ? null : current)),
      fx.kind === "repo" ? REPO_MS : WORKSPACE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [fx]);

  if (!fx) return null;
  return createPortal(
    fx.kind === "repo" ? <RepoOverlay key={fx.key} fx={fx} /> : <WorkspaceOverlay key={fx.key} fx={fx} />,
    document.body,
  );
}

/** Over the sheet, the sheet's shape: its edge's glow, the band of light, the pill. */
function RepoOverlay({ fx }: { fx: RepoFx }) {
  const style = {
    left: fx.rect.left,
    top: fx.rect.top,
    width: fx.rect.width,
    height: fx.rect.height,
    "--cf-switch": fx.color,
  } as CSSProperties;
  return (
    <div className="cf-switch-repo" style={style} aria-hidden data-no-enter>
      {fx.sweep && <div className="cf-switch-repo-sweep" />}
      <div className="cf-switch-chip">
        <span className="cf-switch-chip-tile" style={monogramStyle(fx.color)}>
          {monogram(fx.name)}
        </span>
        <span className="truncate">{fx.name}</span>
      </div>
    </div>
  );
}

/** Over the window: the bloom, a ring, the card with the tile, the name and the dots. */
function WorkspaceOverlay({ fx }: { fx: WorkspaceFx }) {
  const dots = fx.count > 1 && fx.count <= MAX_DOTS;
  const x = (index: number) => `${index * (DOT + DOT_GAP)}px`;
  return (
    <div className="cf-switch-space" style={{ "--cf-switch": fx.color } as CSSProperties} aria-hidden data-no-enter>
      <div className="cf-switch-space-bloom" />
      <div className="cf-switch-space-ring" />
      <div className="cf-switch-space-card">
        <span className="cf-switch-space-tile" style={monogramStyle(fx.color)}>
          <Briefcase size={22} />
        </span>
        <span className="cf-switch-space-name">{fx.name}</span>
        {dots && (
          <span className="cf-switch-space-dots" style={{ width: fx.count * DOT + (fx.count - 1) * DOT_GAP }}>
            {Array.from({ length: fx.count }, (_, index) => (
              <span key={index} className="cf-switch-space-dot" style={{ left: x(index) }} />
            ))}
            <span
              className="cf-switch-space-mark"
              style={{ "--cf-switch-from": x(fx.from), "--cf-switch-to": x(fx.at) } as CSSProperties}
            />
          </span>
        )}
      </div>
    </div>
  );
}
