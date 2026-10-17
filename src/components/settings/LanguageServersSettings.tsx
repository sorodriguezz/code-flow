import { useEffect, useState } from "react";
import { Check, Copy, RotateCcw } from "lucide-react";
import { LANGUAGE_SERVERS, type LanguageServer } from "../../lib/lsp/servers";
import { currentRepoPath, refreshProbes, serverStatuses } from "../../lib/lsp/client";
import { repoRecommendedServers } from "../../lib/vscodeExtensions";
import { useT } from "../../state/languageStore";
import { Skeleton } from "../common/Skeleton";

/**
 * Which language servers this machine has, and how to get the ones it does not.
 *
 * Deliberately *not* a launch-screen check, and deliberately not an error anywhere. A language with
 * no server installed is a feature that is not there, not something broken — the same call
 * `requirements.rs` makes about everything except `git` and the data directory, and the same shape
 * the AI providers get: a found/not-found mark with the install command beside it, in a panel
 * somebody opens when they want the feature.
 *
 * The version string is quoted verbatim and left untranslated. It is what the binary said, not a
 * sentence of ours.
 */

interface Status {
  server: LanguageServer;
  version: string | null;
}

function InstallCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        void navigator.clipboard.writeText(command).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
      className="group flex min-w-0 items-center gap-1.5 rounded px-1.5 py-0.5 font-mono text-[11px] text-[var(--cf-text-muted)] hover:bg-[var(--cf-surface-raised)]"
    >
      <span className="truncate">{command}</span>
      {copied ? (
        <Check size={11} className="shrink-0 text-[var(--cf-success)]" />
      ) : (
        <Copy size={11} className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
      )}
    </button>
  );
}

function Row({ status, recommended }: { status: Status; recommended: boolean }) {
  const t = useT();
  const { server, version } = status;
  return (
    <div className="flex items-center gap-2 border-b border-[var(--cf-border)] px-3 py-2 last:border-b-0">
      <span
        aria-hidden
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${
          version ? "bg-[var(--cf-success)]" : "bg-[var(--cf-text-muted)]/40"
        }`}
      />
      {/* The label and the binary are short and known; the install command is neither, and making it
          the only elastic cell is what truncated the one actionable string on a "not found" row to
          `npm i -g dockerfile-lang…`. They shrink first now, and the command wraps instead. */}
      <span className="flex min-w-0 flex-1 items-center gap-1.5 text-[12px] text-[var(--cf-text)]">
        <span className="truncate">{server.label}</span>
        {/* The open repository's `.vscode/extensions.json` names this server's extension. */}
        {recommended && (
          <span className="shrink-0 rounded bg-[var(--cf-accent)]/12 px-1 text-[10px] text-[var(--cf-accent)]">
            {t("settings.lspRecommended")}
          </span>
        )}
      </span>
      <span className="hidden min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--cf-text-muted)] sm:block">
        {server.command}
      </span>
      <div className="flex min-w-0 flex-[2] justify-end">
        {version ? (
          <span className="truncate font-mono text-[11px] text-[var(--cf-text-muted)]" title={version}>
            {version}
          </span>
        ) : (
          // Several entries offer two ways in (`brew` or `apt`, `pip` or `brew`), joined by a middle
          // dot in the catalogue. Split so each is its own copy target rather than one string that
          // pastes into a shell as nonsense.
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-1">
            {server.install.split("·").map((command) => (
              <InstallCommand key={command} command={command.trim()} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function LanguageServersSettings() {
  const t = useT();
  const [statuses, setStatuses] = useState<Status[] | null>(null);
  /** Bumped by Refresh. The probes are cached for the life of the app — right for a project switch,
   *  wrong for the flow this panel exists to start: read "not found", copy the install command, run
   *  it, come back. Without this the panel keeps reporting what was true before the install. */
  const [asked, setAsked] = useState(0);
  const [recommended, setRecommended] = useState<string[]>([]);
  useEffect(() => {
    const repoPath = currentRepoPath();
    if (repoPath) void repoRecommendedServers(repoPath).then(setRecommended);
  }, []);

  useEffect(() => {
    let alive = true;
    void serverStatuses().then((found) => {
      if (alive) setStatuses(found);
    });
    return () => {
      alive = false;
    };
  }, [asked]);

  const groups: { tier: 0 | 1; titleKey: "settings.lspTier0" | "settings.lspTier1" }[] = [
    { tier: 0, titleKey: "settings.lspTier0" },
    { tier: 1, titleKey: "settings.lspTier1" },
  ];

  return (
    // No heading: the Editor section's rail names this pane and carries its hint.
    <div>
      {statuses === null ? (
        <div className="flex flex-col gap-1">
          {LANGUAGE_SERVERS.map((server) => (
            <Skeleton key={server.id} className="h-8 w-full" />
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          <div className="flex justify-end">
            <button
              onClick={() => {
                refreshProbes();
                setStatuses(null);
                setAsked((n) => n + 1);
              }}
              className="flex items-center gap-1 text-[12px] text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
            >
              <RotateCcw size={13} /> {t("settings.lspRefresh")}
            </button>
          </div>
          {groups.map(({ tier, titleKey }) => (
            <div key={tier}>
              <h3 className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
                {t(titleKey)}
              </h3>
              <div className="overflow-hidden rounded-lg border border-[var(--cf-border)]">
                {statuses
                  .filter((status) => status.server.tier === tier)
                  .map((status) => (
                    <Row key={status.server.id} status={status} recommended={recommended.includes(status.server.id)} />
                  ))}
              </div>
            </div>
          ))}
          <p className="text-[11px] leading-relaxed text-[var(--cf-text-muted)]">{t("settings.lspNote")}</p>
        </div>
      )}
    </div>
  );
}
