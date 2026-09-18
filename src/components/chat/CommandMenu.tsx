import { useEffect, useMemo, useState } from "react";
import {
  Eraser,
  GitBranch,
  MessageSquarePlus,
  SlidersHorizontal,
  SquareTerminal,
  Upload,
  type LucideIcon,
} from "lucide-react";
import { chatProviderCommands, type ProviderCommand } from "../../lib/tauri/chatCommands";
import { providerCapabilities, providerDisplayLabel } from "../../lib/aiProviders";
import { useT } from "../../state/languageStore";
import type { TranslationKey } from "../../lib/i18n/translations";

/** How each `source` is spelled on a row. A map rather than a ternary because the three are three
 *  different degrees of confidence and collapsing any two of them is the lie this menu exists to
 *  avoid — see the component's note. */
const SOURCE_KEYS: Record<ProviderCommand["source"], TranslationKey> = {
  "cli-reported": "chat.sourceCliReported",
  documented: "chat.sourceDocumented",
  app: "chat.sourceApp",
};

/** The commands this app answers itself. Never sent to a CLI — see the component's note. */
export type ChatAppCommand = "new" | "model" | "provider" | "clear" | "export" | "branch";

const APP_COMMANDS: { id: ChatAppCommand; name: string; icon: LucideIcon; descriptionKey: TranslationKey }[] = [
  { id: "new", name: "/new", icon: MessageSquarePlus, descriptionKey: "chat.cmdNew" },
  { id: "model", name: "/model", icon: SlidersHorizontal, descriptionKey: "chat.cmdModel" },
  { id: "provider", name: "/provider", icon: SlidersHorizontal, descriptionKey: "chat.cmdProvider" },
  { id: "clear", name: "/clear", icon: Eraser, descriptionKey: "chat.cmdClear" },
  { id: "export", name: "/export", icon: Upload, descriptionKey: "chat.cmdExport" },
  { id: "branch", name: "/branch", icon: GitBranch, descriptionKey: "chat.cmdBranch" },
];

/**
 * The `/` menu.
 *
 * # Two sections, because there are two kinds of slash command and conflating them is a lie
 *
 * The first section is **ours**: `/new`, `/model`, `/clear` and friends are app actions that happen
 * to be typed with a slash. They never reach a subprocess. Picking one runs a function in this
 * window and clears the composer.
 *
 * The second section is the **provider's**, and it is only ever what the provider actually
 * reported. Claude's list comes from the `slash_commands` array in its own `init` event — a hundred
 * and something entries, exactly the ones that binary has installed, including the user's own. Grok
 * and Gemini's come from documentation read at call time. The three remaining engines report
 * nothing, and the correct number of commands to invent for them is zero: a menu that offers
 * `/model` to a CLI which will receive it as the literal five characters of a question is worse
 * than a menu that admits it does not know. Those get a row that opens the real CLI in a terminal
 * instead, where its own slash commands do work.
 *
 * Each pass-through row is labelled with where the knowledge came from, because "the CLI told us"
 * and "we read the docs" are different degrees of confidence and the user is the one who pays when
 * the weaker one is stale.
 *
 * `headlessSlashCommands` gates the whole second section. Codex and Grok expand slash commands in
 * their interactive REPL and **not** under `-p`/`exec`, so offering a pass-through there would be
 * offering something that is documented, real, and still does not work on the code path this chat
 * uses.
 */
export function CommandMenu({
  query,
  provider,
  onRunApp,
  onInsert,
  onOpenTerminal,
}: {
  /** What has been typed after the `/`, already lowercased by the composer. */
  query: string;
  provider: string;
  onRunApp: (command: ChatAppCommand) => void;
  /** Puts a pass-through command's name in the composer for the user to complete and send. */
  onInsert: (name: string) => void;
  /** Opens the provider's own CLI in a terminal. Absent when there is no working directory to open
   *  one in — a conversation with no repository behind it. */
  onOpenTerminal?: () => void;
}) {
  const t = useT();
  const [passThrough, setPassThrough] = useState<ProviderCommand[]>([]);
  const caps = providerCapabilities(provider);

  // Re-asked per provider rather than cached for the session: Claude's list is whatever the *most
  // recent run* reported, so it grows the first time a run happens and changes when the user
  // installs a command. Cheap — it is a database read or a file read, not a process spawn.
  useEffect(() => {
    if (!caps.headlessSlashCommands) {
      setPassThrough([]);
      return;
    }
    let live = true;
    void chatProviderCommands(provider)
      .then((commands) => {
        if (live) setPassThrough(commands);
      })
      .catch(() => {
        if (live) setPassThrough([]);
      });
    return () => {
      live = false;
    };
  }, [provider, caps.headlessSlashCommands]);

  const apps = useMemo(
    () => APP_COMMANDS.filter((command) => command.name.slice(1).startsWith(query)),
    [query],
  );
  const others = useMemo(
    () => passThrough.filter((command) => command.name.replace(/^\//, "").toLowerCase().startsWith(query)).slice(0, 40),
    [passThrough, query],
  );

  if (apps.length === 0 && others.length === 0 && !onOpenTerminal) return null;

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
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
            >
              <command.icon size={12} className="shrink-0 text-[var(--cf-text-muted)]" />
              <span className="font-mono text-[11.5px] text-[var(--cf-text)]">{command.name}</span>
              <span className="truncate text-[11px] text-[var(--cf-text-muted)]">{t(command.descriptionKey)}</span>
            </button>
          ))}
        </>
      )}

      {others.length > 0 && (
        <>
          <SectionHeading text={t("chat.commandsProvider", { provider: providerName })} />
          {others.map((command) => (
            <button
              key={command.name}
              type="button"
              onClick={() => onInsert(command.name)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
            >
              <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-[var(--cf-text)]">
                {command.name}
              </span>
              {command.description && (
                <span className="min-w-0 flex-[2] truncate text-[11px] text-[var(--cf-text-muted)]">
                  {command.description}
                </span>
              )}
              {/* Where this row came from, on the row. "cli-reported" is the binary's own answer;
                  "documented" is a file we read and may be behind the CLI it describes. */}
              <span className="shrink-0 rounded-full border border-[var(--cf-border)] px-1.5 text-[9.5px] leading-[15px] text-[var(--cf-text-muted)]">
                {t(SOURCE_KEYS[command.source] ?? "chat.sourceDocumented")}
              </span>
            </button>
          ))}
        </>
      )}

      {others.length === 0 && (
        <>
          <SectionHeading text={t("chat.commandsProvider", { provider: providerName })} />
          <p className="px-3 py-1 text-[11px] leading-relaxed text-[var(--cf-text-muted)]">
            {t("chat.commandsNone", { provider: providerName })}
          </p>
          <button
            type="button"
            disabled={!onOpenTerminal}
            onClick={onOpenTerminal}
            title={onOpenTerminal ? undefined : t("chat.noRepoHint")}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-black/[0.04] disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-white/[0.05]"
          >
            <SquareTerminal size={12} className="shrink-0 text-[var(--cf-text-muted)]" />
            <span className="text-[11.5px] text-[var(--cf-text)]">
              {t("chat.openInTerminal", { provider: providerName })}
            </span>
          </button>
        </>
      )}
    </div>
  );
}

function SectionHeading({ text }: { text: string }) {
  return (
    <p className="px-3 pb-0.5 pt-1.5 text-[9.5px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
      {text}
    </p>
  );
}
