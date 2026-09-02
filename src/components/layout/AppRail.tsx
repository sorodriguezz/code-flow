import {
  ArrowUpRight,
  Bot,
  KeyRound,
  ClipboardList,
  Database,
  Layers,
  MonitorSmartphone,
  NotebookPen,
  Send,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { HoldProgress, HoldScrim, slotShift, useHoldReorder } from "../../lib/holdReorder";
import { useLayoutStore } from "../../state/layoutStore";
import { useUiStore, type ApiWorkspace, type MainView } from "../../state/uiStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useWindowStore } from "../../state/windowStore";
import { useT } from "../../state/languageStore";
import { Tooltip } from "../common/Tooltip";
import { TourLauncher } from "../tour/TourLauncher";
import type { TranslationKey } from "../../lib/i18n/translations";

interface WorkspaceApp {
  id: MainView;
  /**
   * Which workspace *inside* that view, for a view that holds more than one.
   *
   * The API tab holds two — requests and databases — because both are workspace-scoped and neither
   * follows the selected repository. They are separate buttons here so each is one click;
   * `undefined` means the view has only one.
   */
  workspace?: ApiWorkspace;
  icon: LucideIcon;
  labelKey: TranslationKey;
  /** What the app holds, so the tooltip can say it — the rail itself has room for an icon and
   * nothing else. */
  descriptionKey: TranslationKey;
  /** Marks an app that is still settling, so the rail says so before it is opened rather than
   * after something behaves unexpectedly inside it.
   *
   * Intentionally unused right now — nothing is in beta. Kept so the next app that ships early
   * is one field, not a rediscovered design. Don't delete as dead code. */
  beta?: boolean;
}

/** Everything that belongs to the workspace rather than to the selected repository. Adding the
 * next one is a single entry here — the rail follows.
 *
 * This is the order the rail *starts* in, and the comments below are the argument for it. It is no
 * longer the order it necessarily stays in: an icon held down can be moved, and [`ordered`] lays
 * this list out against what the user chose. It remains the source of truth for which apps exist. */
const APPS: WorkspaceApp[] = [
  {
    id: "api",
    workspace: "requests",
    icon: Send,
    labelKey: "tabbar.api",
    descriptionKey: "tabbar.apiDescription",
  },
  {
    id: "api",
    workspace: "database",
    icon: Database,
    labelKey: "tabbar.databases",
    descriptionKey: "tabbar.databasesDescription",
  },
  // No `workspace`: the agent console is a view of its own. It sits here rather than in the tab
  // bar for the same reason the other two do — the roster belongs to the workspace, and switching
  // repository doesn't change which agents exist.
  {
    id: "agents",
    icon: Bot,
    labelKey: "tabbar.agents",
    descriptionKey: "tabbar.agentsDescription",
  },
  // Below the agents, and workspace-scoped for the plainest reason of the three: a requirement is
  // written before the code that satisfies it, so this screen has to work in a workspace whose
  // repositories don't exist yet.
  {
    id: "stories",
    icon: ClipboardList,
    labelKey: "tabbar.stories",
    descriptionKey: "tabbar.storiesDescription",
  },
  // Last, and workspace-scoped for the same reason as the databases above it: a host is part of the
  // environment a workspace's repositories are deployed to, so switching repository must not change
  // which machines are listed.
  {
    id: "remote",
    icon: MonitorSmartphone,
    labelKey: "tabbar.remote",
    descriptionKey: "tabbar.remoteDescription",
  },
  // Under the machines, and among the least repository-bound of them: a note is the writing *around*
  // the work — the decision, the runbook, the meeting — and none of it changes meaning when you
  // click a different repo. It sits down here because it is one you come back to rather than one
  // you pass through.
  {
    id: "notes",
    icon: NotebookPen,
    labelKey: "tabbar.notes",
    descriptionKey: "tabbar.notesDescription",
  },
  // After the notes, because it is the same kind of thing one step further out: a diagram is the
  // drawing *around* the work the way a note is the writing around it, and neither changes meaning
  // when you click a different repo. Last because it is the newest, and because the rail's declared
  // order is only where it starts — see `ordered`.
  {
    id: "diagrams",
    icon: Workflow,
    labelKey: "tabbar.diagrams",
    descriptionKey: "tabbar.diagramsDescription",
  },
  // Last, and the only app here that is *not* scoped to the workspace: a password does not belong
  // to the workspace it was typed in, and losing one because a workspace was tidied up is not a
  // trade worth making. Its list narrows by workspace; the vault itself does not. See
  // `vaultStore`'s closing comment.
  {
    id: "vault",
    icon: KeyRound,
    labelKey: "tabbar.vault",
    descriptionKey: "tabbar.vaultDescription",
  },
];

/** Buttons are keyed by view *and* workspace, since two of them share a view. This key is also what
 * the stored order is written in, so it has to stay stable across releases — renaming one silently
 * drops that app to the bottom of a rail somebody had already arranged. */
function appKey(app: WorkspaceApp): string {
  return app.workspace ? `${app.id}:${app.workspace}` : app.id;
}

/** `items` with the entry at `from` lifted out and put back in at `to`. */
function move<T>(items: T[], from: number, to: number): T[] {
  const next = items.slice();
  const [lifted] = next.splice(from, 1);
  next.splice(to, 0, lifted);
  return next;
}

/**
 * `APPS` in the user's order.
 *
 * The stored order is advisory, and never the source of truth for *which* apps exist — `APPS` is.
 * A key the stored order doesn't mention (the next app to ship, arriving into a rail somebody
 * arranged two releases ago) sorts after the ones it does, keeping its declared position among its
 * fellow newcomers; a key naming an app that no longer exists ranks nothing and is ignored. So
 * neither adding nor removing an app can leave the rail an icon short or an icon over.
 */
function ordered(order: string[]): WorkspaceApp[] {
  // A copy on both branches. Handing out `APPS` itself was safe only by luck — the one caller,
  // `move`, happens to `slice()` before splicing — and the next one to sort or splice in place
  // would corrupt the app registry for the rest of the process, silently, with no way back short
  // of a relaunch. A handful of elements is not a copy worth economising on.
  if (order.length === 0) return APPS.slice();
  const rank = new Map(order.map((key, index) => [key, index]));
  // `order.length` rather than `Infinity`: every real rank is below it, so unmentioned apps land at
  // the end — and, being equal to each other, they keep their declared order through a sort that
  // has been stable since ES2019. Subtracting two infinities would have produced `NaN` instead.
  const rankOf = (app: WorkspaceApp) => rank.get(appKey(app)) ?? order.length;
  return APPS.slice().sort((a, b) => rankOf(a) - rankOf(b));
}

/** A translucent wash of the workspace's own colour. Built as a string rather than a Tailwind
 * class because the colour comes from the database; `color` may also be a `var(...)` fallback. */
function wash(color: string, percent: number): string {
  return `color-mix(in oklab, ${color} ${percent}%, transparent)`;
}

/** The workspace colour, pulled toward the theme's text colour so it stays legible on both.
 *  A wash is fine behind a glyph; a glyph *in* an arbitrary user colour is not — a pale yellow
 *  vanishes on light. Mixing toward `--cf-text` borrows the theme's contrast for free. */
function ink(color: string): string {
  return `color-mix(in oklab, ${color} 55%, var(--cf-text))`;
}

/**
 * The workspace's apps, as a rail down the right edge of the window.
 *
 * They used to be rows in a dropdown at the end of the tab bar, which cost two clicks to reach any
 * of them and left the set invisible until you opened it. A rail costs one click and is always
 * legible — and it can sit here, between the view and the AI panel, precisely *because* these
 * aren't repository tabs: it is a column of the window rather than a strip belonging to whatever
 * repository happens to be selected, so it doesn't move or reload when you click a different repo.
 *
 * The workspace tile caps it for the same reason the tab bar keeps a repository marker at its own
 * end: six unlabelled glyphs need something saying whose they are. It still isn't the way to
 * *change* workspace — that stays the projects panel's job — but it is no longer inert: clicking it
 * goes back to the repository graph.
 *
 * Which is the way out of these apps, and it was missing. Every app here is workspace-scoped,
 * so opening one leaves the repository views with nothing on screen pointing back at them: the tab
 * bar above is about the selected repository and reads as somewhere you already are. The tile is
 * the one thing on the rail that isn't one of them, it is directly above them, and "back to
 * where I started" is the plainest thing a cap like that can mean.
 *
 * The six can be rearranged: hold one down and it lifts, and where it is dropped is remembered (`railOrder` in `layoutStore`, which is a row in `app_settings` and therefore travels
 * with the backup). Purely visual — the order decides nothing but which icon is where, and no
 * other screen reads it.
 *
 * Which is also the argument for putting the gesture behind a hold rather than behind a drag
 * threshold, the way the editor's tabs do it. A tab strip is rearranged often and every tab is
 * interchangeable; this rail is arranged once, and each icon is a door someone is trying to open
 * on a single click. A few pixels of travel is a slip, and a slip that quietly moves the app
 * you meant to open is worse than a gesture that has to be asked for.
 */
export function AppRail() {
  const activeView = useUiStore((s) => s.activeView);
  const apiWorkspace = useUiStore((s) => s.apiWorkspace);
  const setActiveView = useUiStore((s) => s.setActiveView);
  const openApiWorkspace = useUiStore((s) => s.openApiWorkspace);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const railOrder = useLayoutStore((s) => s.railOrder);
  const setRailOrder = useLayoutStore((s) => s.setRailOrder);
  // Which of these apps are showing in windows of their own. Read as the whole list rather than a
  // hook per button: this is six buttons rendered together, and six subscriptions for one answer
  // they share would re-render all of them on every change anyway.
  const satellites = useWindowStore((s) => s.satellites);
  const detach = useWindowStore((s) => s.detach);
  const focusWindow = useWindowStore((s) => s.focus);
  const t = useT();

  const apps = ordered(railOrder);
  // The gesture is shared with the sidebar's repositories; the preview below is not. This rail is
  // six identical squares, so it can afford to slide its neighbours out of the way to show where
  // the held one is going — which the sidebar, whose open repository is unfolded to a list of
  // branches, cannot.
  const reorder = useHoldReorder((from, to) => setRailOrder(move(apps, from, to).map(appKey)));
  const drag = reorder.drag;

  const workspace = workspaces.find((w) => w.id === activeWorkspaceId) ?? null;
  // No workspace yet (first launch, or one was just deleted): fall back to the accent so the
  // chrome still looks deliberate instead of losing its colour entirely.
  const wsColor = workspace?.color ?? "var(--cf-accent)";
  const scopeHint = workspace
    ? t("tabbar.scopeWorkspaceHint", { name: workspace.name })
    : t("tabbar.scopeWorkspaceNone");

  /** The label of the window this app is showing in, or `null` for one that is still in here. */
  const windowFor = (app: WorkspaceApp) =>
    satellites.find((s) => s.kind === "app" && s.ref_id === appKey(app))?.label ?? null;

  const open = (app: WorkspaceApp) => {
    // Detaching moves rather than duplicates, so the icon for an app that is elsewhere is a way
    // *to* that window, not a second copy of the app. Anything else would be two API clients on one
    // workspace's collections, which is the case this whole design exists to prevent.
    const label = windowFor(app);
    if (label) {
      void focusWindow(label);
      return;
    }
    // A view with sub-workspaces needs both set at once, or the tab would open on whichever side
    // was last on screen rather than the one just picked.
    if (app.workspace) openApiWorkspace(app.workspace);
    else setActiveView(app.id);
  };

  /** Sends the app out to a window of its own, and takes it off this one. */
  const sendOut = async (app: WorkspaceApp) => {
    const moved = await detach("app", appKey(app), t(app.labelKey));
    // Only once the window actually exists: refused (the limit is reached, the backend said no) the
    // app stays exactly where it was, rather than leaving this window on an empty view.
    if (!moved) return;
    if (activeView === app.id && (app.workspace ?? apiWorkspace) === apiWorkspace) {
      setActiveView("graph");
    }
  };

  return (
    <aside
      aria-label={t("tabbar.workspaceTools")}
      // `relative` unconditionally, so nothing about the rail's own layout depends on whether
      // something is being dragged; only the z-index does, and only while it has to out-stack the
      // scrim. The accent edge replaces the border for the same moment: the rail stops being a
      // divider between two columns and becomes the one surface still taking input.
      className={`group/rail relative flex w-11 shrink-0 flex-col items-center border-l bg-[var(--cf-surface)] py-2 ${
        drag
          ? "z-[9999] border-[var(--cf-accent)] shadow-[-10px_0_28px_rgba(0,0,0,0.35)]"
          : "border-[var(--cf-border)]"
      }`}
    >
      {/* The rest of the window, dimmed, for as long as an icon is off the ground. It is the whole
          announcement that the hold has *become* a drag — and, since the rail is the only thing
          left lit, it is also the answer to "where can I put this down".

          Declared here rather than beside the rail because it is a portal: where it sits in this
          tree decides nothing, and inside the thing it exists for is where it is found. */}
      <HoldScrim active={drag !== null} />

      {/* The tour anchors this cluster rather than the whole rail: the rail is as tall as the
          window, and a spotlight that size says "look everywhere".
          `relative` is also what the drop marker below is positioned against — see `HoldDrag.ghost`,
          which is measured in this container's coordinates. It has no border and never scrolls,
          which is what makes those coordinates the same ones `top` is resolved in. */}
      <div ref={reorder.listRef} data-tour="workspace-tools" className="relative flex flex-col items-center gap-1">
        <Tooltip side="left" label={scopeHint} description={t("tabbar.scopeWorkspaceReset")}>
          <button
            type="button"
            data-tour="workspace-menu"
            onClick={() => setActiveView("graph")}
            aria-label={`${workspace?.name ?? t("tabbar.scopeWorkspace")} — ${t("tabbar.scopeWorkspaceReset")}`}
            className="flex h-6 w-6 shrink-0 select-none items-center justify-center rounded-md border transition-[filter,transform] hover:brightness-105 active:scale-95"
            style={{ backgroundColor: wash(wsColor, 16), borderColor: wash(wsColor, 40) }}
          >
            <Layers size={12} style={{ color: ink(wsColor) }} />
          </button>
        </Tooltip>

        <span className="my-1 h-px w-5 bg-[var(--cf-border)]" />

        {/* Where it lands, drawn in the hole the neighbours have opened up.
            The sliding was already saying this, but only by implication — you had to read six icons
            and work out which gap was new. An outline in the gap says it outright, and it is the one
            square on the rail that is neither an app nor the icon in your hand.
            Dashed and washed rather than filled: it is a place, not a thing, and a solid tile there
            would read as a seventh app. */}
        {drag && (
          <span
            aria-hidden
            className="pointer-events-none absolute left-1/2 w-8 -translate-x-1/2 rounded-md border border-dashed border-[var(--cf-accent)] bg-[var(--cf-accent)]/12"
            style={{ top: drag.ghost.top, height: drag.ghost.height }}
          />
        )}

        {apps.map((app, index) => {
          const Icon = app.icon;
          const key = appKey(app);
          // Showing in a window of its own. It stays on the rail and stays pressable — that is the
          // whole of "detaching moves": the icon is now the way back to that window rather than a
          // second copy of the app.
          const detachedTo = windowFor(app);
          const isActive =
            !detachedTo && app.id === activeView && (app.workspace ?? apiWorkspace) === apiWorkspace;
          const lifted = drag?.key === key;
          const name = t(app.labelKey);
          // The lifted icon follows the pointer; the ones it has passed step aside by a slot. Both
          // are the same property, so both are written here rather than one of them in a class.
          const offset = drag
            ? lifted
              ? drag.dy
              : slotShift(index, drag)
            : 0;
          return (
            // Name and description as two lines rather than the `{name} — {description}` sentence
            // the `title` attribute forced them into: what the app *is* and what it holds are two
            // different questions, and a rail of glyphs is read by scanning the first.
            <Tooltip
              key={key}
              side="left"
              label={name}
              // A label about the button under the pointer is a label about the wrong thing while
              // that button is being moved — and it would sit on top of the rail being rearranged.
              disabled={drag !== null}
              description={
                <>
                  {detachedTo ? t("windows.focusWindow") : t(app.descriptionKey)}
                  {/* The only announcement the hold gets. Quieter than the description
                      above it: it is about the rail rather than about this app, and it is read
                      once. */}
                  <span className="mt-1 block opacity-70">{t("tabbar.reorderHint")}</span>
                </>
              }
              trailing={
                app.beta ? (
                  <span className="shrink-0 rounded-[4px] bg-[color-mix(in_oklab,var(--cf-warning)_18%,transparent)] px-1 py-px text-[9px] font-bold uppercase leading-none tracking-[0.06em] text-[var(--cf-warning)]">
                    {t("common.beta")}
                  </span>
                ) : undefined
              }
            >
            <button
              type="button"
              data-reorder={key}
              onPointerDown={(e) => reorder.beginHold(e, index, key)}
              onClick={() => {
                if (reorder.swallowsClick()) return;
                open(app);
              }}
              aria-current={isActive ? "page" : undefined}
              aria-label={detachedTo ? `${name} — ${t("windows.inOtherWindow")}` : name}
              // Only while a drag is on: an idle rail is six buttons with no transform at all,
              // rather than six `translateY(0)`s each generating a containing block for nothing.
              style={
                drag
                  ? { transform: `translateY(${offset}px)${lifted ? " scale(1.12)" : ""}` }
                  : undefined
              }
              className={`relative flex h-8 w-8 shrink-0 select-none items-center justify-center rounded-md ${
                // The lifted icon is pinned to the pointer, so it must not ease anywhere; its
                // neighbours are the ones sliding out of the way, so they must. Idle, the only
                // thing that moves is colour — and dropping the transform transition on the way out
                // is what keeps the icons still in the frame where the preview becomes the order.
                lifted
                  ? "z-10 cursor-grabbing shadow-lg ring-1 ring-[var(--cf-accent)]"
                  : drag
                    ? "transition-transform duration-150 ease-out"
                    : "transition-colors"
              } ${
                isActive
                  ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
                  : detachedTo
                    ? "border border-dashed border-[var(--cf-accent)]/55 text-[var(--cf-accent)]"
                    : `text-[var(--cf-text-muted)] ${
                      lifted
                        ? "bg-[var(--cf-surface-raised)] text-[var(--cf-text)]"
                        : "hover:bg-black/[0.03] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.04]"
                      }`
              }`}
            >
              {/* Pushed out of the button and onto the rail's own left edge, so the mark points at
                  the view it is driving rather than floating in the middle of the strip. */}
              {isActive && (
                <span className="absolute inset-y-1.5 -left-1.5 w-[2.5px] rounded-r-full bg-[var(--cf-accent)]" />
              )}
              <Icon size={15} />
              {reorder.arming === key && <HoldProgress shape="ring" />}
              {/* The corner mark, and the one control on this rail that is not the app itself.
                  Always drawn rather than revealed on hover: this rail is reachable by touch and by
                  keyboard, and a gesture that only exists under a pointer is a gesture half the
                  ways into the app cannot perform. Dimmed until wanted, so six of them do not read
                  as six badges.

                  Once the app is out, the same corner becomes a *statement* — a plain arrow, not a
                  button — because there is nothing left to ask for: the button underneath it is
                  already the way to that window. */}
              {detachedTo ? (
                <span
                  aria-hidden
                  className="pointer-events-none absolute -right-0.5 -top-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-[3px] border border-[var(--cf-accent)]/55 bg-[var(--cf-surface)] text-[var(--cf-accent)]"
                >
                  <ArrowUpRight size={9} />
                </span>
              ) : (
                <span
                  role="button"
                  tabIndex={0}
                  aria-label={`${name} — ${t("windows.openInWindow")}`}
                  title={t("windows.openInWindow")}
                  // The rail's own gesture is a *hold*, and this sits inside the surface that
                  // starts one — so both events have to be stopped, or aiming at the corner would
                  // pick the icon up instead.
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    void sendOut(app);
                  }}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter" && e.key !== " ") return;
                    e.preventDefault();
                    e.stopPropagation();
                    void sendOut(app);
                  }}
                  className="absolute -right-0.5 -top-0.5 flex h-3.5 w-3.5 cursor-pointer items-center justify-center rounded-[3px] border border-[var(--cf-border)] bg-[var(--cf-surface)] text-[var(--cf-text-muted)] opacity-0 transition-opacity hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)] focus-visible:opacity-100 group-hover/rail:opacity-70"
                >
                  <ArrowUpRight size={9} />
                </span>
              )}
              {/* The word, not a dot. A coloured dot in the corner of a control already means
                  "something new is waiting for you" everywhere else in this app — the title bar's
                  tour button, the notification bell — and it read as an alert here rather than as a
                  status. Spelled out there is nothing to decode, and at 6.5px in the warning colour
                  it is legible without competing with the glyph it labels.

                  Absolutely positioned, so the icon stays on the same centre line as the other
                  four: a rail is read as a column, and one glyph nudged up to make room for its own
                  caption is the kind of misalignment you see before you can name. */}
              {app.beta && (
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-x-0 bottom-[1px] text-center text-[6.5px] font-bold uppercase leading-none tracking-[0.06em] text-[var(--cf-warning)]"
                >
                  {t("common.beta")}
                </span>
              )}
            </button>
            </Tooltip>
          );
        })}

      </div>

      {/* Pinned to the foot of the rail rather than trailing the apps: the apps above are a list
          you pick from and this is not one of them, so a fixed corner tells them apart better than
          a rule does. It also stops the cap moving up and down as apps are added.

          Unconditional now. It used to come and go with whether the screen had an app tour, which
          left the three repository views with an empty corner and their tour up in the title bar —
          the split this button exists to have ended. A control that is always in the same place is
          the whole argument for putting it here. */}
      <div className="mt-auto flex w-full flex-col items-center gap-1 pt-2">
        <span className="h-px w-5 bg-[var(--cf-border)]" />
        <TourLauncher />
      </div>
    </aside>
  );
}
