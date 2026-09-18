import { Check, Copy, ExternalLink, TerminalSquare } from "lucide-react";
import { useState } from "react";
import type { ClaudeErrorInfo, SetupProblem } from "../../lib/claudeError";
import { AI_PROVIDERS } from "../../lib/aiProviders";
import { openExternalUrl } from "../../lib/tauri/commands";
import { useT } from "../../state/languageStore";
import { useTerminalStore } from "../../state/terminalStore";
import { useWorkspaceStore } from "../../state/workspaceStore";

/**
 * How an AI failure is shown. Three cases, because the advice differs: a usage limit lifts on its
 * own (tell them when), an empty balance needs them to top up (link them straight there), and
 * anything else is a real error worth showing verbatim.
 *
 * Plus a fourth, which is the one this component earns its keep on: a run that failed because the
 * provider is not *set up*. Those arrive as a wall of the CLI's own stderr — "Not signed in. To
 * authenticate without a browser, run: grok login --device-code" — and the app knows exactly what
 * to do with every one of them. See [`SetupProblem`]. Rendering that as red prose and leaving the
 * user to copy a command out of it by hand is the app declining to read something it can read
 * perfectly well.
 *
 * `provider` and `onPickModel` are optional so the existing call sites keep working unchanged:
 * without them the remedies degrade to a copyable command, which is still the fix.
 */
export function AiErrorBanner({
  error,
  compact = false,
  provider,
  onPickModel,
}: {
  error: ClaudeErrorInfo;
  compact?: boolean;
  /** Which engine failed, so the remedy can name its install command and its docs. */
  provider?: string;
  /** Called with a model id the CLI itself suggested. Absent → the ids are shown but not
   *  clickable, because a button that cannot apply its own label is worse than a list. */
  onPickModel?: (model: string) => void;
}) {
  const t = useT();
  const size = compact ? "text-[12px]" : "text-[13px]";
  const subSize = compact ? "text-[11px]" : "text-[12px]";

  const headline = !error.isQuotaExceeded
    ? error.message
    : error.kind === "billing"
      ? t("ai.billingMessage")
      : t("changes.quotaMessage");

  return (
    // Selectable: a provider error is the text most likely to be pasted into a search or an
    // issue, and it's the one place the app has no copy button of its own.
    <div className="select-text rounded-lg border border-[var(--cf-danger)]/30 bg-[color-mix(in_oklab,var(--cf-danger)_8%,transparent)] p-4">
      <p className={`whitespace-pre-wrap break-words ${size} text-[var(--cf-danger)]`}>{headline}</p>

      {error.isQuotaExceeded && (
        <p className={`mt-1 ${subSize} text-[var(--cf-text-muted)]`}>
          {error.kind === "billing"
            ? t("ai.billingHint")
            : error.resetHint
              ? t("changes.quotaRetry", { hint: error.resetHint })
              : t("changes.quotaRetryLater")}
        </p>
      )}

      {error.setup && (
        <SetupRemedy setup={error.setup} provider={provider} subSize={subSize} onPickModel={onPickModel} />
      )}

      {error.actionUrl && (
        <button
          onClick={() => void openExternalUrl(error.actionUrl!)}
          className={`mt-2 flex items-center gap-1 ${subSize} font-medium text-[var(--cf-accent)] hover:underline`}
        >
          <ExternalLink size={11} />
          {/* Providers don't always link to billing — OpenAI's quota error points at its error-code
              docs — so the label follows the URL rather than promising a payments page. */}
          {/billing|payment|plans?\b/i.test(error.actionUrl) ? t("ai.openBilling") : t("ai.openLink")}
        </button>
      )}
    </div>
  );
}

/** The one action that fixes this failure, rendered as something you can press. */
function SetupRemedy({
  setup,
  provider,
  subSize,
  onPickModel,
}: {
  setup: SetupProblem;
  provider?: string;
  subSize: string;
  onPickModel?: (model: string) => void;
}) {
  const t = useT();
  const option = AI_PROVIDERS.find((p) => p.id === provider);

  if (setup.kind === "model-not-found") {
    return (
      <div className="mt-2">
        <p className={`${subSize} text-[var(--cf-text-muted)]`}>
          {setup.suggestions.length > 0 ? t("ai.setupModelSuggest") : t("ai.setupModelGone")}
        </p>
        {setup.suggestions.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {setup.suggestions.map((model) => (
              <button
                key={model}
                disabled={!onPickModel}
                onClick={() => onPickModel?.(model)}
                className={`rounded-md border border-[var(--cf-border)] px-2 py-1 font-mono ${subSize} ${
                  onPickModel
                    ? "hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]"
                    : "cursor-default text-[var(--cf-text-muted)]"
                }`}
              >
                {model}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (setup.kind === "untrusted-directory") {
    // No command to offer: the app passes `--skip-git-repo-check` itself wherever it applies (see
    // `codex.rs`), so seeing this at all means an older CLI, or a directory the app did not choose.
    return <p className={`mt-2 ${subSize} text-[var(--cf-text-muted)]`}>{t("ai.setupUntrustedDir")}</p>;
  }

  if (setup.kind === "binary-missing") {
    const name = setup.binary ?? option?.defaultBinary ?? provider ?? "";
    return (
      <div className="mt-2">
        <p className={`${subSize} text-[var(--cf-text-muted)]`}>{t("ai.setupBinaryMissing", { binary: name })}</p>
        {option?.setup?.command && <CommandRow command={option.setup.command} subSize={subSize} />}
        {option?.setup?.url && (
          <button
            onClick={() => void openExternalUrl(option.setup!.url)}
            className={`mt-1.5 flex items-center gap-1 ${subSize} font-medium text-[var(--cf-accent)] hover:underline`}
          >
            <ExternalLink size={11} />
            {t("ai.setupOpenDocs")}
          </button>
        )}
      </div>
    );
  }

  // not-signed-in. The CLI's own command wins over the catalogue's: grok offers
  // `grok login --device-code` when there is no browser to hand back to, which is exactly this
  // situation, and the catalogue only knows the plain `grok login`.
  const command = setup.command ?? option?.setup?.postCommand ?? null;
  return (
    <div className="mt-2">
      <p className={`${subSize} text-[var(--cf-text-muted)]`}>{t("ai.setupSignedOut")}</p>
      {command && <CommandRow command={command} subSize={subSize} />}
    </div>
  );
}

/**
 * A command the user is meant to run, with the two ways to run it.
 *
 * Copy is always offered because it always works. "Run in terminal" appears only when a project is
 * open, and that is not an oversight: the terminal dock is keyed by project, and a chat about
 * nothing has none. A sign-in button that silently opens nowhere is worse than no button, which is
 * the failure this asymmetry avoids.
 */
function CommandRow({ command, subSize }: { command: string; subSize: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const projectId = useWorkspaceStore((s) => s.activeProjectId);
  // Subscribed to the id and the list rather than calling `activeProject()` in the selector: that
  // helper builds its answer from both, and a selector returning a fresh object every render is
  // how a zustand component ends up re-rendering on every unrelated store write.
  const projectPath = useWorkspaceStore((s) =>
    s.activeWorkspaceId
      ? (s.projectsByWorkspace[s.activeWorkspaceId]?.find((p) => p.id === s.activeProjectId)?.local_path ?? null)
      : null,
  );
  const runCommand = useTerminalStore((s) => s.runCommand);

  const copy = () => {
    void navigator.clipboard.writeText(command).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      },
      // A clipboard the OS refused is not worth an error banner inside an error banner — the
      // command is on screen and selectable either way.
      () => {},
    );
  };

  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
      <code className={`rounded-md bg-[var(--cf-surface-2)] px-2 py-1 font-mono ${subSize}`}>{command}</code>
      <button
        onClick={copy}
        title={t("ai.setupCopyCommand")}
        className="rounded-md border border-[var(--cf-border)] p-1 hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]"
      >
        {copied ? <Check size={12} /> : <Copy size={12} />}
      </button>
      {projectId && projectPath && (
        <button
          onClick={() =>
            void runCommand(projectId, {
              cwd: projectPath,
              command,
              // One terminal for signing in, reused: pressing this twice should land in the same
              // shell, not open a second one beside a login that is already waiting for a code.
              reuseKey: "ai-setup",
              title: t("ai.setupTerminalTitle"),
            })
          }
          className={`flex items-center gap-1 rounded-md border border-[var(--cf-border)] px-2 py-1 ${subSize} hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]`}
        >
          <TerminalSquare size={12} />
          {t("ai.setupRunInTerminal")}
        </button>
      )}
    </div>
  );
}
