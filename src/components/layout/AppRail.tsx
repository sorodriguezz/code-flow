import {
  Bot,
  ClipboardList,
  Database,
  Layers,
  MonitorSmartphone,
  Send,
  type LucideIcon,
} from "lucide-react";
import { useUiStore, type ApiWorkspace, type MainView } from "../../state/uiStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
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
  /** Marks an app that is still settling, so the rail says so before it is opened rather than after
   * something behaves unexpectedly inside it. */
  beta?: boolean;
}

/** Everything that belongs to the workspace rather than to the selected repository. Adding the
 * next one is a single entry here — the rail and its order follow. */
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
    beta: true,
  },
];

/** Buttons are keyed by view *and* workspace, since two of them share a view. */
function appKey(app: WorkspaceApp): string {
  return app.workspace ? `${app.id}:${app.workspace}` : app.id;
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
 * The workspace's five apps, as a rail down the right edge of the window.
 *
 * They used to be rows in a dropdown at the end of the tab bar, which cost two clicks to reach any
 * of them and left the set invisible until you opened it. A rail costs one click and is always
 * legible — and it can sit here, between the view and the AI panel, precisely *because* these
 * aren't repository tabs: it is a column of the window rather than a strip belonging to whatever
 * repository happens to be selected, so it doesn't move or reload when you click a different repo.
 *
 * The workspace tile caps it for the same reason the tab bar keeps a repository marker at its own
 * end: five unlabelled glyphs need something saying whose they are. It still isn't the way to
 * *change* workspace — that stays the projects panel's job — but it is no longer inert: clicking it
 * goes back to the repository graph.
 *
 * Which is the way out of these five apps, and it was missing. Every app here is workspace-scoped,
 * so opening one leaves the repository views with nothing on screen pointing back at them: the tab
 * bar above is about the selected repository and reads as somewhere you already are. The tile is
 * the one thing on the rail that isn't one of the five, it is directly above them, and "back to
 * where I started" is the plainest thing a cap like that can mean.
 */
export function AppRail() {
  const activeView = useUiStore((s) => s.activeView);
  const apiWorkspace = useUiStore((s) => s.apiWorkspace);
  const setActiveView = useUiStore((s) => s.setActiveView);
  const openApiWorkspace = useUiStore((s) => s.openApiWorkspace);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const t = useT();

  const workspace = workspaces.find((w) => w.id === activeWorkspaceId) ?? null;
  // No workspace yet (first launch, or one was just deleted): fall back to the accent so the
  // chrome still looks deliberate instead of losing its colour entirely.
  const wsColor = workspace?.color ?? "var(--cf-accent)";
  const scopeHint = workspace
    ? t("tabbar.scopeWorkspaceHint", { name: workspace.name })
    : t("tabbar.scopeWorkspaceNone");

  const open = (app: WorkspaceApp) => {
    // A view with sub-workspaces needs both set at once, or the tab would open on whichever side
    // was last on screen rather than the one just picked.
    if (app.workspace) openApiWorkspace(app.workspace);
    else setActiveView(app.id);
  };

  return (
    <aside
      aria-label={t("tabbar.workspaceTools")}
      className="flex w-11 shrink-0 flex-col items-center border-l border-[var(--cf-border)] bg-[var(--cf-surface)] py-2"
    >
      {/* The tour anchors this cluster rather than the whole rail: the rail is as tall as the
          window, and a spotlight that size says "look everywhere". */}
      <div data-tour="workspace-tools" className="flex flex-col items-center gap-1">
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

        {APPS.map((app) => {
          const Icon = app.icon;
          const isActive = app.id === activeView && (app.workspace ?? apiWorkspace) === apiWorkspace;
          const name = t(app.labelKey);
          return (
            // Name and description as two lines rather than the `{name} — {description}` sentence
            // the `title` attribute forced them into: what the app *is* and what it holds are two
            // different questions, and a rail of glyphs is read by scanning the first.
            <Tooltip
              key={appKey(app)}
              side="left"
              label={name}
              description={t(app.descriptionKey)}
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
              onClick={() => open(app)}
              aria-current={isActive ? "page" : undefined}
              aria-label={name}
              className={`relative flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors ${
                isActive
                  ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
                  : "text-[var(--cf-text-muted)] hover:bg-black/[0.03] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.04]"
              }`}
            >
              {/* Pushed out of the button and onto the rail's own left edge, so the mark points at
                  the view it is driving rather than floating in the middle of the strip. */}
              {isActive && (
                <span className="absolute inset-y-1.5 -left-1.5 w-[2.5px] rounded-r-full bg-[var(--cf-accent)]" />
              )}
              <Icon size={15} />
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

      {/* Pinned to the foot of the rail rather than trailing the apps: the five above are a list
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
