import { useEffect, useState } from "react";
import { AlertTriangle, CornerDownLeft, Save, TerminalSquare } from "lucide-react";
import { useRemoteStore } from "../../state/remoteStore";
import { remoteParseSshCommand } from "../../lib/tauri/remoteCommands";
import { pushErrorToast } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import type { ParsedCommand } from "../../types/remote";

/**
 * Type or paste an `ssh` command line and connect.
 *
 * **Why this earns the top of the view.** An address almost never arrives as a form. It arrives as
 * `ssh deploy@10.0.0.7 -p 2222` in a ticket, a runbook, or a message from whoever built the box.
 * Retyping that into six fields is work the app can do — and the parse is shown back before
 * anything runs, so a mis-read is visible rather than discovered as a failed connection.
 *
 * The parse lives in Rust (`remotes::parse`) because it is a parser and that is where the tests
 * are. This component only debounces, renders the result and picks between the two verbs.
 *
 * Two verbs, deliberately: **Connect** opens a session against the parsed spec without saving
 * anything — the one-off case, which is most of them — and **Save** turns it into a host row. A
 * connect bar that silently added a row for every experiment would grow an inventory nobody
 * curated.
 */
export function ConnectBar() {
  const connectDraft = useRemoteStore((s) => s.connectDraft);
  const saveDraftAsHost = useRemoteStore((s) => s.saveDraftAsHost);
  const openDetails = useRemoteStore((s) => s.openDetails);
  const t = useT();

  const [line, setLine] = useState("");
  const [parsed, setParsed] = useState<ParsedCommand | null>(null);
  const [busy, setBusy] = useState(false);

  // Debounced: the parse is an IPC round trip and this fires on every keystroke. 150ms is under
  // the threshold where the preview feels like it lags the typing.
  useEffect(() => {
    const text = line.trim();
    if (!text) {
      setParsed(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void remoteParseSshCommand(text)
        .then((result) => !cancelled && setParsed(result))
        .catch(() => !cancelled && setParsed(null));
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [line]);

  const connect = async () => {
    if (!parsed || busy) return;
    setBusy(true);
    try {
      await connectDraft(parsed.spec, parsed.name);
      setLine("");
    } catch (error) {
      pushErrorToast(String(error));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!parsed || busy) return;
    setBusy(true);
    try {
      const row = await saveDraftAsHost(parsed.spec, parsed.name);
      if (row) {
        setLine("");
        openDetails(row.id);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="shrink-0 border-b border-[var(--cf-border)] px-3 py-2">
      <div className="flex items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-[var(--cf-border)] px-2.5 py-1.5 focus-within:border-[var(--cf-accent)]">
          <TerminalSquare size={13} className="shrink-0 text-[var(--cf-text-muted)]" />
          <input
            value={line}
            onChange={(e) => setLine(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void connect();
              } else if (e.key === "Escape") {
                setLine("");
              }
            }}
            placeholder={t("remote.connectPlaceholder")}
            spellCheck={false}
            autoComplete="off"
            className="min-w-0 flex-1 bg-transparent font-mono text-[12px] outline-none placeholder:font-sans placeholder:text-[var(--cf-text-muted)]"
          />
          {parsed && (
            <span className="hidden shrink-0 items-center gap-1 text-[10px] text-[var(--cf-text-muted)] sm:flex">
              <CornerDownLeft size={10} />
              {t("remote.connect")}
            </span>
          )}
        </div>

        <button
          type="button"
          onClick={() => void connect()}
          disabled={!parsed || busy}
          className="shrink-0 rounded-md bg-[var(--cf-accent)] px-3 py-1.5 text-[12px] font-medium text-white transition-opacity hover:brightness-110 disabled:opacity-40"
        >
          {t("remote.connect")}
        </button>
        <button
          type="button"
          onClick={() => void save()}
          disabled={!parsed || busy}
          title={t("remote.saveAsHost")}
          aria-label={t("remote.saveAsHost")}
          className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-md border border-[var(--cf-border)] text-[var(--cf-text-muted)] transition-colors hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)] disabled:opacity-40"
        >
          <Save size={13} />
        </button>
      </div>

      {parsed && <ParsePreview parsed={parsed} />}
    </div>
  );
}

/**
 * What the line was understood to mean, before anything runs.
 *
 * The `ignored` list is the part that matters. A pasted `-L 5432:db:5432` produces a perfectly
 * good session with no tunnel in it, and without this the user would find that out by using the
 * port and getting connection refused.
 */
function ParsePreview({ parsed }: { parsed: ParsedCommand }) {
  const t = useT();
  const { spec } = parsed;

  const bits: string[] = [];
  if (spec.user) bits.push(`${t("remote.fieldUser")}: ${spec.user}`);
  bits.push(`${t("remote.fieldHost")}: ${spec.host}`);
  if (spec.port) bits.push(`${t("remote.fieldPort")}: ${spec.port}`);
  if (spec.jump) bits.push(`${t("remote.fieldJump")}: ${spec.jump}`);
  if (spec.key_file) bits.push(`${t("remote.fieldKeyFile")}: ${spec.key_file}`);
  if (spec.command) bits.push(`${t("remote.fieldCommand")}: ${spec.command}`);

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 pt-1.5 text-[11px]">
      <span className="font-mono text-[var(--cf-text-muted)]">{bits.join("  ·  ")}</span>
      {parsed.ignored.length > 0 && (
        <span className="flex items-center gap-1 text-[var(--cf-warning)]">
          <AlertTriangle size={11} className="shrink-0" />
          {t("remote.parseIgnored", { flags: parsed.ignored.join(" ") })}
        </span>
      )}
    </div>
  );
}
