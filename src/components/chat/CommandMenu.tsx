import { useEffect, useMemo, useState } from "react";
import {
  Eraser,
  GitBranch,
  MessageSquarePlus,
  Puzzle,
  Shrink,
  SpellCheck,
  SquareTerminal,
  Upload,
  type LucideIcon,
} from "lucide-react";
import {
  chatProviderCommands,
  chatProviderSkills,
  type ProviderCommand,
  type ProviderSkill,
} from "../../lib/tauri/chatCommands";
import { providerCapabilities, providerDisplayLabel } from "../../lib/aiProviders";
import { useT } from "../../state/languageStore";
import type { TranslationKey } from "../../lib/i18n/translations";

/** How each `source` is spelled on a row. A map rather than a ternary because the three are three
 *  different degrees of confidence and collapsing any two of them is the lie this menu exists to
 *  avoid — see the component's note. */
const SOURCE_KEYS: Record<ProviderCommand["source"], TranslationKey> = {
  builtin: "chat.sourceBuiltin",
  user: "chat.sourceUser",
  project: "chat.sourceProject",
  plugin: "chat.sourcePlugin",
  "cli-reported": "chat.sourceCliReported",
  documented: "chat.sourceDocumented",
  app: "chat.sourceApp",
};

/** How a skill's origin is spelled on its row. A plugin's is its own name, not this map's. */
const SKILL_SOURCE_KEYS: Record<ProviderSkill["source"], TranslationKey> = {
  app: "chat.skillSourceApp",
  user: "chat.skillSourceUser",
  project: "chat.skillSourceProject",
  plugin: "chat.skillSourcePlugin",
  bundled: "chat.skillSourceBundled",
};

/** The commands this app answers itself. Never sent to a CLI — see the component's note. */
export type ChatAppCommand = "new" | "export" | "branch" | "compact" | "caveman" | "clear";

/**
 * Which composer the menu belongs to — they offer different app commands.
 *
 * The free chat owns its compaction (`/compact`, summarised by the app, for every engine) and has
 * `/branch` and `/caveman`; a repository conversation in the panel has neither, so there `/compact`
 * is Claude's own and `/clear` is the app's — the next turn simply starts a fresh engine session,
 * which works on every engine rather than only the one whose CLI expands the command headlessly.
 */
export type CommandSurface = "chat" | "panel";

interface AppCommand {
  id: ChatAppCommand;
  /** Typed, so **never translated**. A command whose name changed with the interface language would
   *  be a different command in each one: the muscle memory would break on a switch, and anything
   *  written down — a note, a README, a message to somebody else — would work for half the users.
   *  The description beside it is prose and does follow the language. */
  name: string;
  icon: LucideIcon;
  descriptionKey: TranslationKey;
  /**
   * Whether text after the command belongs to it.
   *
   * Only `/compact` takes any today, and the default matters more than the exception: without it,
   * `/new empezar de cero` would silently run `/new` and throw the sentence away. For everything
   * else an exact match is the only match, so a line that merely *starts* with a command name is
   * an ordinary message and is sent as one.
   */
  takesArgs?: boolean;
}

const APP_COMMANDS: AppCommand[] = [
  { id: "new", name: "/new", icon: MessageSquarePlus, descriptionKey: "chat.cmdNew" },
  { id: "export", name: "/export", icon: Upload, descriptionKey: "chat.cmdExport" },
  { id: "branch", name: "/branch", icon: GitBranch, descriptionKey: "chat.cmdBranch" },
  { id: "compact", name: "/compact", icon: Shrink, descriptionKey: "chat.cmdCompact", takesArgs: true },
  { id: "caveman", name: "/caveman", icon: SpellCheck, descriptionKey: "chat.cmdCaveman", takesArgs: true },
  { id: "clear", name: "/clear", icon: Eraser, descriptionKey: "chat.cmdClear" },
];

/** Which app commands each composer offers — see `CommandSurface`. */
const SURFACE_COMMANDS: Record<CommandSurface, ChatAppCommand[]> = {
  chat: ["new", "export", "branch", "compact", "caveman"],
  panel: ["new", "clear", "export"],
};

function appCommandsOf(surface: CommandSurface): AppCommand[] {
  return APP_COMMANDS.filter((command) => SURFACE_COMMANDS[surface].includes(command.id));
}

/**
 * The app command a composed line runs, if it runs one at all.
 *
 * Exists because picking a row in the menu was, until now, the *only* way to run one of these:
 * typing `/compact` and pressing Enter sent the literal seven characters to the model, which read
 * as the command being ignored. The menu is a discovery aid, not the mechanism.
 *
 * Exported and pure so it can be tested without a DOM — the parsing is where the surprises live:
 * an exact match for most commands, an exact match *or* a name followed by arguments for the ones
 * that take them, and nothing at all for a line that merely begins with the same letters.
 */
export function appCommandFor(
  line: string,
  surface: CommandSurface = "chat",
): { id: ChatAppCommand; args: string } | null {
  const text = line.trim();
  if (!text.startsWith("/")) return null;
  // Only the first line. A `/compact` with a pasted paragraph under it is a message about a
  // command, not a command — and running it would swallow the paragraph.
  if (text.includes("\n")) return null;
  const cut = text.search(/\s/);
  const name = (cut === -1 ? text : text.slice(0, cut)).toLowerCase();
  const args = cut === -1 ? "" : text.slice(cut).trim();
  const command = appCommandsOf(surface).find((candidate) => candidate.name === name);
  if (!command) return null;
  // Arguments handed to a command that does not take them mean the user was writing a sentence,
  // not invoking anything. Sending it is the safe reading: the worst case is a model that answers
  // a question about a slash command, rather than an action taken by surprise.
  if (args && !command.takesArgs) return null;
  return { id: command.id, args };
}

/**
 * The `/` menu.
 *
 * # Three sections, because there are three kinds of thing behind a slash
 *
 * The first section is **ours**: `/new`, `/export` and friends are app actions that happen to be
 * typed with a slash. They never reach a subprocess, and which ones exist depends on the composer
 * (see `CommandSurface`).
 *
 * The second is the **provider's** commands, and only what is true of the installed CLI: Claude's
 * built-ins that were verified to do something in `-p` (`/compact`, `/clear`, `/context`, `/usage`,
 * and in a repository `/init` and `/security-review`), plus the custom commands on disk — the
 * user's, the repository's and the enabled plugins'. Grok and Gemini's come from documentation. The
 * other engines expand nothing headlessly, and the correct number of commands to invent for them is
 * zero: those get a row that opens the real CLI in a terminal instead.
 *
 * The third is **skills**: the workspace's own and the ones each CLI brings (Claude Code's, Codex's,
 * Grok's, agy's). A skill is not typed through as a slash command — that only works when it is the
 * very first thing on the command line — but picked: the composer carries it to the turn, and the
 * backend tells the engine to use it (see `provider_skills::instruction`). So skills are offered on
 * every engine, headless slash support or not.
 *
 * Each pass-through row is labelled with where the knowledge came from, because "verified against
 * the CLI", "a file of yours" and "we read the docs" are different degrees of confidence and the
 * user is the one who pays when the weaker one is stale.
 */
export function CommandMenu({
  query,
  provider,
  surface = "chat",
  scope = {},
  onRunApp,
  onInsert,
  onPickSkill,
  onOpenTerminal,
}: {
  /** What has been typed after the `/`, already lowercased by the composer. */
  query: string;
  provider: string;
  surface?: CommandSurface;
  /** Whose skills and commands to list: the account the turn runs as, the workspace whose skills are
   *  the app's, and the repository (panel) or the free chat's folder whose own ones join them. */
  scope?: {
    accountId?: string | null;
    workspaceId?: string | null;
    projectId?: string | null;
    conversationId?: string | null;
  };
  onRunApp: (command: ChatAppCommand) => void;
  /** Puts a pass-through command's name in the composer for the user to complete and send. */
  onInsert: (name: string) => void;
  /** Stages a skill for the next turn. Absent where a surface cannot carry one. */
  onPickSkill?: (skill: ProviderSkill) => void;
  /** Opens the provider's own CLI in a terminal. Absent when there is no working directory to open
   *  one in — a conversation with no repository behind it. */
  onOpenTerminal?: () => void;
}) {
  const t = useT();
  const [passThrough, setPassThrough] = useState<ProviderCommand[]>([]);
  const [skills, setSkills] = useState<ProviderSkill[]>([]);
  const caps = providerCapabilities(provider);
  const { accountId = null, workspaceId = null, projectId = null, conversationId = null } = scope;

  // Re-asked per provider rather than cached for the session: the lists are read from disk and from
  // the CLI's last report, both of which change when the user installs something. Cheap — file
  // reads, and for Grok one process whose answer the backend keeps for a minute.
  useEffect(() => {
    if (!caps.headlessSlashCommands) {
      setPassThrough([]);
      return;
    }
    let live = true;
    void chatProviderCommands(provider, { accountId, workspaceId, projectId })
      .then((commands) => {
        if (live) setPassThrough(commands);
      })
      .catch(() => {
        if (live) setPassThrough([]);
      });
    return () => {
      live = false;
    };
  }, [provider, caps.headlessSlashCommands, accountId, workspaceId, projectId]);

  // Skills are picked, not typed through, so they need no headless slash support: every engine here
  // can be told to use one. Fetched whatever the provider.
  useEffect(() => {
    if (!onPickSkill) {
      setSkills([]);
      return;
    }
    let live = true;
    void chatProviderSkills(provider, { accountId, workspaceId, projectId, conversationId })
      .then((found) => {
        if (live) setSkills(found);
      })
      .catch(() => {
        if (live) setSkills([]);
      });
    return () => {
      live = false;
    };
    // `onPickSkill` is a fresh closure every render; only whether one exists matters here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, accountId, workspaceId, projectId, conversationId, Boolean(onPickSkill)]);

  const appCommands = useMemo(() => appCommandsOf(surface), [surface]);
  const apps = useMemo(
    () => appCommands.filter((command) => command.name.slice(1).startsWith(query)),
    [appCommands, query],
  );
  const others = useMemo(
    () =>
      passThrough
        // A provider command with the name of one of this composer's own would never run — Enter
        // takes the app's — so it is not offered beside it.
        .filter((command) => !appCommands.some((app) => app.name === command.name))
        .filter((command) => command.name.replace(/^\//, "").toLowerCase().startsWith(query))
        .slice(0, 40),
    [passThrough, appCommands, query],
  );
  const pickable = useMemo(
    () => skills.filter((skill) => skill.name.toLowerCase().includes(query)).slice(0, 60),
    [skills, query],
  );

  if (apps.length === 0 && others.length === 0 && pickable.length === 0 && !onOpenTerminal) return null;

  const providerName = providerDisplayLabel(provider, t);

  return (
    <div className="cf-fade-in mb-1.5 max-h-[320px] overflow-y-auto rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] py-1 shadow-[var(--cf-shadow)]">
      {apps.length > 0 && (
        <>
          <SectionHeading text={t("chat.commandsApp")} />
          {apps.map((command) => (
            <button
              key={command.id}
              type="button"
              onClick={() => onRunApp(command.id)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-[var(--cf-hover)]"
            >
              <command.icon size={12} className="shrink-0 text-[var(--cf-text-muted)]" />
              <span className="font-mono text-[12px] text-[var(--cf-text)]">{command.name}</span>
              <span className="truncate text-[11px] text-[var(--cf-text-muted)]">{t(command.descriptionKey)}</span>
            </button>
          ))}
        </>
      )}

      {others.length > 0 && (
        <>
          <SectionHeading text={t("chat.commandsProvider", { provider: providerName })} />
          {others.map((command) => {
            const description = command.description_key
              ? t(command.description_key as TranslationKey)
              : command.description;
            return (
              <button
                key={command.name}
                type="button"
                onClick={() => onInsert(command.name)}
                title={description || undefined}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-[var(--cf-hover)]"
              >
                {/* The name keeps its width and the description gives way: in the narrow panel a
                    command you cannot read is useless, a description cut short is only shorter. */}
                <span className="min-w-0 max-w-[65%] shrink-0 truncate font-mono text-[12px] text-[var(--cf-text)]">
                  {command.name}
                </span>
                <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--cf-text-muted)]">
                  {description}
                </span>
                {/* Where this row came from, on the row: verified against the CLI, a command file of
                    the user's or a plugin's, or a docs page that may be behind the CLI it describes. */}
                <span className="shrink-0 rounded-full border border-[var(--cf-border)] px-1.5 text-[10.5px] leading-[15px] text-[var(--cf-text-muted)]">
                  {t(SOURCE_KEYS[command.source] ?? "chat.sourceDocumented")}
                </span>
              </button>
            );
          })}
        </>
      )}

      {others.length === 0 && !caps.headlessSlashCommands && (
        <>
          <SectionHeading text={t("chat.commandsProvider", { provider: providerName })} />
          <button
            type="button"
            disabled={!onOpenTerminal}
            onClick={onOpenTerminal}
            title={onOpenTerminal ? t("chat.commandsNone", { provider: providerName }) : t("chat.noRepoHint")}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-[var(--cf-hover)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            <SquareTerminal size={12} className="shrink-0 text-[var(--cf-text-muted)]" />
            <span className="text-[12px] text-[var(--cf-text)]">
              {t("chat.openInTerminal", { provider: providerName })}
            </span>
          </button>
        </>
      )}

      {pickable.length > 0 && onPickSkill && (
        <>
          <SectionHeading text={t("chat.skillsHeading")} />
          {pickable.map((skill) => (
            <button
              key={`${skill.source}:${skill.name}`}
              type="button"
              onClick={() => onPickSkill(skill)}
              title={skill.description || undefined}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-[var(--cf-hover)]"
            >
              <Puzzle size={12} className="shrink-0 text-[var(--cf-text-muted)]" />
              <span className="min-w-0 max-w-[65%] shrink-0 truncate font-mono text-[12px] text-[var(--cf-text)]">
                {skill.name}
              </span>
              <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--cf-text-muted)]">{skill.description}</span>
              <span className="shrink-0 rounded-full border border-[var(--cf-border)] px-1.5 text-[10.5px] leading-[15px] text-[var(--cf-text-muted)]">
                {skill.source === "plugin" && skill.plugin ? skill.plugin : t(SKILL_SOURCE_KEYS[skill.source])}
              </span>
            </button>
          ))}
        </>
      )}
    </div>
  );
}

function SectionHeading({ text }: { text: string }) {
  return (
    <p className="px-3 pb-0.5 pt-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
      {text}
    </p>
  );
}
