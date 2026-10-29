import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { ArrowUpRight, Layers } from "lucide-react";
import { HOLD_REVEAL_MS, HOLD_SLOP, HoldProgress, HoldScrim, slotShift, useHoldReorder } from "../../lib/holdReorder";
import { openCodi } from "../codi/openCodi";
import { useMotionLevel } from "../../lib/motion";
import { useLayoutStore } from "../../state/layoutStore";
import { useUiStore } from "../../state/uiStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useWindowStore } from "../../state/windowStore";
import { useT } from "../../state/languageStore";
import { Tooltip } from "../common/Tooltip";
import { ThinkingOrb } from "../common/ThinkingOrb";
import { ActiveMarker } from "../common/ActivePill";
import { StageChip } from "../common/StageChip";
import { TourLauncher } from "../tour/TourLauncher";
import { useShortcutHint } from "../../lib/useShortcutHint";
import { useAiRunStore } from "../../state/aiRunStore";

/** The runs the Agentes app owns: a task's turn and a chain's step. See `aiRunStore`. */
const AGENT_RUN_KINDS = new Set<string>(["agents.liveKindAgent", "agents.liveKindChain"]);
import { ReturnBurst } from "./ReturnBurst";
import { WORKSPACE_ICONS } from "./WorkspaceGlyph";
import { monogram } from "../../lib/monogram";
import { APPS, appKey, openRailApp, sendRailAppOut, type WorkspaceApp } from "../../lib/railApps";

/** The rail's apps and what opening and detaching one does live in `lib/railApps` — «Codi» does both
 *  too. Re-exported for the readers that found them here. */
export { APPS, appKey, type WorkspaceApp };

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
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const railOrder = useLayoutStore((s) => s.railOrder);
  const setRailOrder = useLayoutStore((s) => s.setRailOrder);
  // Which of these apps are showing in windows of their own. Read as the whole list rather than a
  // hook per button: this is six buttons rendered together, and six subscriptions for one answer
  // they share would re-render all of them on every change anyway.
  const satellites = useWindowStore((s) => s.satellites);
  // Islands that just came back, to point at where each one landed — see `ReturnBurst`.
  const returns = useWindowStore((s) => s.returns);
  const t = useT();
  const agentsBusy = useAiRunStore((s) =>
    Object.keys(s.active).some((id) => s.active[id] && AGENT_RUN_KINDS.has(s.aboutByRun[id]?.kindKey ?? "")),
  );

  const unsaved = useParkedDrafts();
  const scroll = useScrollEdges();

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

  // Opening (or focusing the island that holds it) and sending out are `lib/railApps`' — the same
  // two gestures «Codi» makes, so the rules behind them are written once.
  const open = (app: WorkspaceApp) => {
    openRailApp(app);
  };

  /** Sends the app out to a window of its own, and takes it off this one. */
  const sendOut = async (app: WorkspaceApp) => {
    await sendRailAppOut(app);
  };

  return (
    <aside
      aria-label={t("tabbar.workspaceTools")}
      // `relative` unconditionally, so nothing about the rail's own layout depends on whether
      // something is being dragged; only the z-index does, and only while it has to out-stack the
      // scrim. The accent edge replaces the border for the same moment: the rail stops being a
      // divider between two columns and becomes the one surface still taking input.
      // On the frame, like the projects panel across the window: no fill and no rule of its own —
      // the sheets on either side draw the edges. Lit while an icon is lifted, since it is then the
      // one thing left above the scrim.
      className={`group/rail relative flex min-h-0 w-12 shrink-0 flex-col items-center pb-2 pt-0.5 ${
        drag ? "z-[9999] rounded-lg bg-[var(--cf-bg)] shadow-[-10px_0_28px_rgba(0,0,0,0.35)]" : ""
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
      {/* The list scrolls; the foot below it does not. At the window's minimum height, or with the
          system's text scaled up, the apps are taller than the rail, and the column used to be cut
          off at the window's edge — the assistant and the tour first, since they sit at the bottom.
          The scroll is this wrapper's, not the list's own, so the list keeps the coordinates
          `HoldDrag.ghost` is measured in; and it is held still while an icon is lifted, because the
          slots a drag compares the pointer with were read when the hold began. No bar: the rail is
          48px wide, and a wheel, a trackpad or Tab reaches the hidden icons all the same. */}
      <div
        ref={scroll.ref}
        onScroll={scroll.update}
        // With no scroll bar, the fade is what says there is more: only on the side that has icons
        // past the edge. A mask rather than a painted gradient, so it is right over the see-through
        // window too, where the frame has no single colour to paint with.
        style={scrollFade(scroll.above, scroll.below)}
        className={`flex min-h-0 w-full flex-1 flex-col items-center [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${
          drag ? "overflow-hidden" : "overflow-y-auto overflow-x-hidden"
        }`}
      >
      <div ref={reorder.listRef} data-tour="workspace-tools" className="relative flex flex-col items-center gap-1">
        <Tooltip side="left" label={scopeHint} description={t("tabbar.scopeWorkspaceReset")}>
          <button
            type="button"
            data-tour="workspace-menu"
            onClick={() => useUiStore.getState().returnToRepo()}
            aria-label={`${workspace?.name ?? t("tabbar.scopeWorkspace")} — ${t("tabbar.scopeWorkspaceReset")}`}
            className="mb-0.5 flex h-7 w-7 shrink-0 select-none items-center justify-center rounded-[8px] border transition-[filter,transform] hover:brightness-105 active:scale-95"
            style={{ backgroundColor: wash(wsColor, 16), borderColor: wash(wsColor, 40) }}
          >
            {/* The workspace's own mark — the icon picked for it in its menu, else its initials. */}
            {workspace && WORKSPACE_ICONS[workspace.icon] ? (
              (() => {
                const Icon = WORKSPACE_ICONS[workspace.icon];
                return <Icon size={14} style={{ color: ink(wsColor) }} />;
              })()
            ) : workspace ? (
              <span className="text-[11px] font-bold tracking-[0.02em]" style={{ color: ink(wsColor) }}>
                {monogram(workspace.name)}
              </span>
            ) : (
              <Layers size={14} style={{ color: ink(wsColor) }} />
            )}
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
          const returning = returns.find((r) => r.kind === "app" && r.refId === key) ?? null;
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
                  {unsaved.has(app.id) && !detachedTo && (
                    <span className="mt-1 block text-[var(--cf-warning)]">{t("tabbar.unsavedDrafts")}</span>
                  )}
                  {/* The only announcement the hold gets. Quieter than the description
                      above it: it is about the rail rather than about this app, and it is read
                      once. */}
                  <span className="mt-1 block opacity-70">{t("tabbar.reorderHint")}</span>
                </>
              }
              trailing={app.stage ? <StageChip stage={app.stage} /> : undefined}
            >
            {/* The app's button and its "open in a window" corner are siblings in one box. The
                corner used to be a `span role="button"` *inside* the app's button — an interactive
                element nested in another, which HTML does not allow and which left the corner's
                name unannounced (a screen reader only reads the outer button). The box carries what
                moves both together: the reorder slot and the drag transform. */}
            <div
              data-reorder={key}
              // Only while a drag is on: an idle rail is six boxes with no transform at all, rather
              // than six `translateY(0)`s each generating a containing block for nothing.
              style={
                drag
                  ? { transform: `translateY(${offset}px)${lifted ? " scale(1.12)" : ""}` }
                  : undefined
              }
              className={`relative h-9 w-9 shrink-0 ${
                // The lifted icon is pinned to the pointer, so it must not ease anywhere; its
                // neighbours are the ones sliding out of the way, so they must. Dropping the
                // transform transition on the way out is what keeps the icons still in the frame
                // where the preview becomes the order.
                lifted ? "z-10" : drag ? "transition-transform duration-150 ease-out" : ""
              }`}
            >
            <button
              type="button"
              onPointerDown={(e) => reorder.beginHold(e, index, key)}
              onClick={() => {
                if (reorder.swallowsClick()) return;
                open(app);
              }}
              aria-current={isActive ? "page" : undefined}
              aria-label={detachedTo ? `${name} — ${t("windows.inOtherWindow")}` : name}
              className={`relative flex h-9 w-9 shrink-0 select-none items-center justify-center rounded-lg ${
                // Idle, the only thing that moves is colour.
                lifted
                  ? "cursor-grabbing shadow-lg ring-1 ring-[var(--cf-accent)]"
                  : drag
                    ? ""
                    : "transition-colors"
              } ${
                isActive
                  ? "bg-[var(--cf-surface)] text-[var(--cf-accent)] shadow-[var(--cf-shadow-lift),0_0_0_1px_var(--cf-border)]"
                  : detachedTo
                    ? "border border-dashed border-[var(--cf-accent)]/55 text-[var(--cf-accent)]"
                    : `text-[var(--cf-text-muted)] ${
                      lifted
                        ? "bg-[var(--cf-surface-raised)] text-[var(--cf-text)]"
                        : "hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]"
                      }`
              }`}
            >
              {/* The active app wears the same lifted sheet as the active tab and the active project —
                  one way to say "selected" across the frame — and, since an accent glyph on a dark
                  sheet barely showed which one it was (user report, 2026-10-08), the rail's own
                  "you are here" bar on its edge, the projects panel's. The rail's edge is 6px out
                  from the 36px button in its 48px column. */}
              {isActive && !drag && (
                <ActiveMarker layoutId="app-rail-active" color="var(--cf-accent-fill)" className="-left-1.5 inset-y-2" />
              )}
              {/* Keyed by the return, so an app that comes back twice in a row drops in twice. */}
              <span key={returning?.id ?? "rest"} className={`flex ${returning ? "cf-return-land" : ""}`}>
                <Icon size={18} />
              </span>
              {returning && (
                <ReturnBurst
                  side="left"
                  label={t("windows.returned", { name })}
                  leading={<Icon size={14} className="shrink-0 text-[var(--cf-accent)]" />}
                />
              )}
              {/* Something of this app's is running right now — an agent turn or a chain step — so a
                  glance at the rail finds work in flight without opening the app. A plain dot, not
                  the orb: the orb is for the row that *is* the run. */}
              {app.id === "agents" && agentsBusy && !detachedTo && (
                <span
                  aria-hidden
                  className="pointer-events-none absolute bottom-1 right-1 h-[7px] w-[7px] rounded-full bg-[var(--cf-success)] shadow-[0_0_0_2px_var(--cf-bg)]"
                />
              )}
              {/* A save that did not land: the draft is parked, still unsaved, until it does — a
                  dot in the warning colour so it is seen from any other app, where it matters. */}
              {unsaved.has(app.id) && !detachedTo && (
                <span
                  aria-hidden
                  className="pointer-events-none absolute bottom-1 right-1 h-[7px] w-[7px] rounded-full bg-[var(--cf-warning)] shadow-[0_0_0_2px_var(--cf-bg)]"
                />
              )}
              {reorder.arming === key && <HoldProgress shape="ring" />}
              {/* The corner mark, and the one control on this rail that is not the app itself.
                  Always drawn rather than revealed on hover: this rail is reachable by touch and by
                  keyboard, and a gesture that only exists under a pointer is a gesture half the
                  ways into the app cannot perform. Dimmed until wanted, so six of them do not read
                  as six badges.

                  Once the app is out, the same corner becomes a *statement* — a plain arrow, not a
                  button — because there is nothing left to ask for: the button underneath it is
                  already the way to that window. */}
              {detachedTo && (
                <span
                  aria-hidden
                  className="pointer-events-none absolute -right-0.5 -top-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-[3px] border border-[var(--cf-accent)]/55 bg-[var(--cf-surface)] text-[var(--cf-accent)]"
                >
                  <ArrowUpRight size={9} />
                </span>
              )}
              {/* The word, not a dot. A coloured dot in the corner of a control already means
                  "something new is waiting for you" everywhere else in this app — the tour's
                  launcher, the notification bell — and it read as an alert here rather than as a
                  status. Spelled out there is nothing to decode, and at 6.5px in the warning colour
                  it is legible without competing with the glyph it labels.

                  Absolutely positioned, so the icon stays on the same centre line as the other
                  four: a rail is read as a column, and one glyph nudged up to make room for its own
                  caption is the kind of misalignment you see before you can name. */}
              {app.stage && (
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-x-0 bottom-[1px] text-center text-[6.5px] font-bold uppercase leading-none tracking-[0.06em] text-[var(--cf-warning)]"
                >
                  {t(app.stage === "alpha" ? "common.alpha" : "common.beta")}
                </span>
              )}
            </button>
            {!detachedTo && (
              <button
                type="button"
                aria-label={`${name} — ${t("windows.openInWindow")}`}
                title={t("windows.openInWindow")}
                // The rail's own gesture is a *hold*, and this sits on the surface that starts one —
                // stopped so aiming at the corner never picks the icon up instead.
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => void sendOut(app)}
                className="absolute -right-0.5 -top-0.5 flex h-3.5 w-3.5 cursor-pointer items-center justify-center rounded-[3px] border border-[var(--cf-border)] bg-[var(--cf-surface)] text-[var(--cf-text-muted)] opacity-0 transition-opacity hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)] focus-visible:opacity-100 group-hover/rail:opacity-70"
              >
                <ArrowUpRight size={9} />
              </button>
            )}
            </div>
            </Tooltip>
          );
        })}

      </div>
      </div>

      {/* Pinned to the foot of the rail rather than trailing the apps: the apps above are a list
          you pick from and neither of these is one of them, so a fixed corner tells them apart
          better than a rule does. It also stops them moving up and down as apps are added.

          The assistant above the rule and the tour's cap below it, because the two have nothing to
          do with each other (the user's placement, 2026-09-25). `my-1` on the rule, as on the one
          under the workspace tile, so both rules on the rail keep the same room either side.

          The cap is unconditional now. It used to come and go with whether the screen had an app
          tour, which left the three repository views with an empty corner and their tour up in the
          title bar — the split this button exists to have ended. A control that is always in the
          same place is the whole argument for putting it here. */}
      <div className="flex w-full shrink-0 flex-col items-center gap-1 pt-2">
        <AssistantButton />
        <span className="my-1 h-px w-5 bg-[var(--cf-border)]" />
        <TourLauncher />
      </div>
    </aside>
  );
}

/**
 * The way into the assistant, at the foot of the rail — the user's placement (2026-09-25: "dejalo
 * sobre el icono del tour guiado, pero sobre la linea … esto seria una app pero debe ir aparte al
 * final abajo"). Shaped like an app, the same 36px square and 18px glyph, because that is what it
 * reads as; kept apart from the list above because it is not one of the places that list switches
 * between — the panel it opens docks beside whichever of them is on screen.
 *
 * It spent a day in the title bar beating in the accent. Since 2026-10-08 its glyph is the thinking
 * design the user picked (the user: "reemplaza ese icono de IA … por el diseño de pensamiento
 * elegido") — the assistant's own mark, so the button looks like what it opens — running its base
 * animation all the time, the user's call (it was first held still between runs, and they asked for
 * it to move: "que tenga la animación base"). Open, it holds a tinted pill, the way a pressed toggle
 * does. Not the lifted sheet of the active app — on
 * this rail that sheet means "the view you are in", and with the panel open beside an app the rail
 * would claim two of them.
 *
 * Held down for two seconds it opens «Codi» instead — the voice assistant's door since its title-bar
 * button went (the user, 2026-10-21: "que se abra después de mantener presionado 2 segundos el
 * pensamiento que está en el rail"). The rail's own hold gesture, drawn the same way (`HoldProgress`,
 * after the same quarter-second of silence, dropped when the pointer drifts) — or, in Motion
 * «Completa», with no ring: the button itself charges up from half a second in — filling with the
 * accent, glowing, the mark thinking and swelling, trembling at the end — and the mark pops and
 * startles awake when Codi opens. Let
 * go before the two seconds and it is a click: the chat opens (or closes) as always. The click that
 * ends a hold that opened Codi is not also a click on the panel.
 */
/** How long the assistant's mark is held for «Codi» — the user's two seconds. */
const CODI_HOLD_MS = 2000;
/** Module-level, so the mark is handed the same object every render: held, it thinks — loading up
 *  (user: «mientras se mantenga pulsado … alguna animación como de cargando»). */
const CHARGING = { phase: "think" } as const;
/** How long the mark plays its wake startle once Codi has opened. */
const WOKE_MS = 1200;
/** In Motion «Completa» the mark itself is the indicator, from half a second in — a click is well
 *  under it — instead of the ring (user, 2026-10-21: «de 0.5 s a 2 s en vez de salir el círculo»). */
const CHARGE_FROM_MS = 500;

function AssistantButton() {
  const open = useUiStore((s) => s.aiPanelOpen);
  const toggle = useUiStore((s) => s.toggleAiPanel);
  const t = useT();
  const hint = useShortcutHint();
  const [arming, setArming] = useState(false);
  const charges = useMotionLevel() === "full";
  const [wokeAt, setWokeAt] = useState<number | null>(null);
  useEffect(() => {
    if (wokeAt === null) return;
    const id = window.setTimeout(() => setWokeAt(null), WOKE_MS);
    return () => window.clearTimeout(id);
  }, [wokeAt]);
  const press = useRef<{ x: number; y: number; timers: number[] } | null>(null);
  const openedCodi = useRef(false);

  const release = useCallback(() => {
    press.current?.timers.forEach((id) => window.clearTimeout(id));
    press.current = null;
    setArming(false);
  }, []);
  useEffect(() => release, [release]);

  const onPointerDown = (event: ReactPointerEvent) => {
    if (event.button !== 0) return;
    release();
    openedCodi.current = false;
    press.current = {
      x: event.clientX,
      y: event.clientY,
      timers: [
        window.setTimeout(() => setArming(true), charges ? CHARGE_FROM_MS : HOLD_REVEAL_MS),
        window.setTimeout(() => {
          openedCodi.current = true;
          release();
          setWokeAt(performance.now());
          openCodi();
        }, CODI_HOLD_MS),
      ],
    };
  };
  const onPointerMove = (event: ReactPointerEvent) => {
    const held = press.current;
    if (held && Math.hypot(event.clientX - held.x, event.clientY - held.y) > HOLD_SLOP) release();
  };

  return (
    <Tooltip side="left" label={hint("panel.ai", t("statusbar.aiPanel"))} description={hint("codi.open", t("codi.rail.hold"))}>
      <button
        type="button"
        onClick={() => {
          if (openedCodi.current) {
            openedCodi.current = false;
            return;
          }
          toggle();
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={release}
        onPointerLeave={release}
        onPointerCancel={release}
        data-tour="toggle-ai-panel"
        aria-label={t("statusbar.aiPanel")}
        aria-expanded={open}
        className={`relative flex h-9 w-9 shrink-0 select-none items-center justify-center rounded-lg transition-colors ${
          open ? "bg-[var(--cf-accent)]/15 hover:bg-[var(--cf-accent)]/20" : "hover:bg-[var(--cf-hover)]"
        } ${arming && charges ? "cf-charging" : ""}`}
        style={arming && charges ? ({ "--cf-charge-ms": `${CODI_HOLD_MS - CHARGE_FROM_MS}ms` } as CSSProperties) : undefined}
      >
        {arming && charges && <span aria-hidden className="cf-charge-fill" />}
        {/* `card` (32px) rather than `md`: the designs draw inside their square with room to spare,
            and at 22px the mark read smaller than the app icons above it (user: "un poco más grande").
            `follow`: every design notices the pointer — the ones with eyes look at it (user: "que siga el
            mouse con los ojos"), the rest turn, lean or light up toward it — and perks up as it comes
            close to the button. See `ThinkingOrb`. Its charge (`index.css`, «charging up to open
            Codi»): swelling while held, popping back as Codi opens. */}
        <span className={`cf-charge-mark relative flex ${charges && !arming && wokeAt !== null ? "cf-charge-pop" : ""}`}>
          <ThinkingOrb size="card" follow activity={arming && charges ? CHARGING : wokeAt !== null ? { cue: { kind: "wake", at: wokeAt } } : undefined} />
        </span>
        {arming && !charges && <HoldProgress shape="ring" ms={CODI_HOLD_MS - HOLD_REVEAL_MS} />}
      </button>
    </Tooltip>
  );
}

/**
 * Which rail apps hold a parked draft — a note or diagram whose save failed and is waiting to be
 * retried (see `parked` in `notesStore` / `diagramsStore`). Both stores are imported lazily, as the
 * views are: the rail is on screen from the first frame and must not pull them in to draw a dot.
 */
function useParkedDrafts(): ReadonlySet<string> {
  const [ids, setIds] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    let live = true;
    const unsubscribes: (() => void)[] = [];
    const state = { notes: false, diagrams: false };
    const publish = () => {
      if (!live) return;
      setIds((prev) => {
        const next = new Set<string>();
        if (state.notes) next.add("notes");
        if (state.diagrams) next.add("diagrams");
        return prev.size === next.size && [...next].every((id) => prev.has(id)) ? prev : next;
      });
    };
    void Promise.all([import("../../state/notesStore"), import("../../state/diagramsStore")]).then(
      ([{ useNotesStore }, { useDiagramsStore }]) => {
        if (!live) return;
        const watch = (id: "notes" | "diagrams", parked: () => Record<string, unknown>, subscribe: (f: () => void) => () => void) => {
          const read = () => {
            state[id] = Object.keys(parked()).length > 0;
            publish();
          };
          read();
          unsubscribes.push(subscribe(read));
        };
        watch("notes", () => useNotesStore.getState().parked, useNotesStore.subscribe);
        watch("diagrams", () => useDiagramsStore.getState().parked, useDiagramsStore.subscribe);
      },
    );
    return () => {
      live = false;
      unsubscribes.forEach((off) => off());
    };
  }, []);
  return ids;
}

function scrollFade(above: boolean, below: boolean): CSSProperties | undefined {
  if (!above && !below) return undefined;
  const mask = `linear-gradient(to bottom, ${above ? "transparent, black 24px" : "black"}, ${
    below ? "black calc(100% - 24px), transparent" : "black"
  })`;
  return { maskImage: mask, WebkitMaskImage: mask };
}

/** Whether the rail's list has icons hidden above or below — re-read on scroll and on resize. */
function useScrollEdges() {
  const [edges, setEdges] = useState({ above: false, below: false });
  const node = useRef<HTMLDivElement | null>(null);
  const update = useCallback(() => {
    const el = node.current;
    if (!el) return;
    const above = el.scrollTop > 1;
    const below = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
    setEdges((prev) => (prev.above === above && prev.below === below ? prev : { above, below }));
  }, []);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback(
    (el: HTMLDivElement | null) => {
      observer.current?.disconnect();
      node.current = el;
      if (!el) return;
      // The list's own size changes too (an app switched on or off), not only the window's.
      observer.current = new ResizeObserver(update);
      observer.current.observe(el);
      if (el.firstElementChild) observer.current.observe(el.firstElementChild);
      update();
    },
    [update],
  );
  return { ref, update, ...edges };
}
