import { useEffect, useState } from "react";
import { AzureSignInModal } from "./AzureSignInModal";
import { AlertTriangle, Cloud, CornerDownLeft, Save, TerminalSquare } from "lucide-react";
import { buttonClass, iconButtonClass, Kbd } from "../common/Button";
import { chipClass } from "../common/recipes";
import { Tooltip } from "../common/Tooltip";
import { useRemoteStore } from "../../state/remoteStore";
import {
  remoteParseAzureConnection,
  remoteParseSshCommand,
  remoteSetPassword,
} from "../../lib/tauri/remoteCommands";
import { pushErrorToast } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import type { ParsedAzureConnection, ParsedCommand } from "../../types/remote";

/** Whether a line is an Azure connection string rather than an `ssh` command.
 *
 * Checked here so that typing an `ssh` line doesn't cost an extra IPC round trip per keystroke; the
 * real parse is still in Rust. Deliberately narrow — a key or a signature has to be named for this
 * to fire, because those are the parts that make a string a credential rather than an address. */
const looksAzure = (text: string): boolean =>
  /(^|;)\s*(accountname|accountkey|sharedaccesssignature|usedevelopmentstorage|blobendpoint|queueendpoint|tableendpoint|fileendpoint)\s*=/i.test(
    text,
  ) || (/^https?:\/\//i.test(text) && /[?&]sig=/i.test(text));

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
 *
 * **An Azure connection string is the other thing that arrives as one line**, and it goes in the
 * same box for the same reason: `DefaultEndpointsProtocol=https;AccountName=…;AccountKey=…` is how
 * a storage account is handed over, and typing it into four fields is work the app can do.
 *
 * It is the one input here that *must* save. The two verbs above exist because a session can be
 * opened against a spec that was never written down — but an account key lives in the keychain,
 * which is keyed by host id, so there is no id and nowhere to put the key until a row exists. So
 * the button says "Add account" rather than "Connect", and what it does is exactly that: one row,
 * one key in the keychain, and the account open.
 */
export function ConnectBar() {
  const connectDraft = useRemoteStore((s) => s.connectDraft);
  const saveDraftAsHost = useRemoteStore((s) => s.saveDraftAsHost);
  const openDetails = useRemoteStore((s) => s.openDetails);
  const openAzure = useRemoteStore((s) => s.openAzure);
  const t = useT();

  const [line, setLine] = useState("");
  const [parsed, setParsed] = useState<ParsedCommand | null>(null);
  const [azure, setAzure] = useState<ParsedAzureConnection | null>(null);
  const [busy, setBusy] = useState(false);
  const [signingIn, setSigningIn] = useState(false);

  // Debounced: the parse is an IPC round trip and this fires on every keystroke. 150ms is under
  // the threshold where the preview feels like it lags the typing.
  useEffect(() => {
    const text = line.trim();
    if (!text) {
      setParsed(null);
      setAzure(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (looksAzure(text)) {
        setParsed(null);
        void remoteParseAzureConnection(text)
          .then((result) => !cancelled && setAzure(result))
          .catch(() => !cancelled && setAzure(null));
        return;
      }
      setAzure(null);
      void remoteParseSshCommand(text)
        .then((result) => !cancelled && setParsed(result))
        .catch(() => !cancelled && setParsed(null));
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [line]);

  /** The account, as a row plus a key in the keychain plus an open tab. See the note above for why
   *  this one has to save. */
  const addAccount = async () => {
    if (!azure || busy) return;
    setBusy(true);
    try {
      const row = await saveDraftAsHost(azure.spec, azure.name);
      if (!row) return;
      // Before the tab opens, because opening it is what makes the first signed request.
      if (azure.secret) await remoteSetPassword(row.id, azure.secret);
      setLine("");
      openAzure(row.id);
    } catch (error) {
      pushErrorToast(String(error));
    } finally {
      setBusy(false);
    }
  };

  const connect = async () => {
    if (azure) return addAccount();
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
    <div data-tour="remote-connect" className="shrink-0 border-b border-[var(--cf-border)] px-3 py-2.5">
      <div className="flex items-center gap-2">
        <label className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-2.5 transition-[border-color,box-shadow] duration-100 focus-within:border-[var(--cf-accent)] focus-within:shadow-[0_0_0_3px_color-mix(in_oklab,var(--cf-accent)_20%,transparent)]">
          <TerminalSquare size={14} className="shrink-0 text-[var(--cf-text-faint)]" />
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
            className="min-w-0 flex-1 bg-transparent font-mono text-[13px] text-[var(--cf-text)] outline-none placeholder:font-sans placeholder:text-[12px] placeholder:text-[var(--cf-text-faint)]"
          />
          {(parsed || azure) && (
            <span className="hidden shrink-0 items-center gap-1.5 text-[11px] text-[var(--cf-text-faint)] sm:flex">
              <Kbd>
                <CornerDownLeft size={10} />
              </Kbd>
              {azure ? t("remote.azAddAccount") : t("remote.connect")}
            </span>
          )}
        </label>

        {/* The one filled button on the bar: it runs the line once and keeps nothing. */}
        <button
          type="button"
          onClick={() => void connect()}
          disabled={(!parsed && !azure) || busy}
          className={buttonClass({ variant: "primary", size: "lg" })}
        >
          {azure && <Cloud size={14} />}
          {azure ? t("remote.azAddAccount") : t("remote.connect")}
        </button>
        {/* The other way in, and for most people the better one: rather than pasting a connection
            string per account, sign in once and pick from what you already have access to. */}
        <Tooltip label={t("remote.azSignIn")}>
          <button
            type="button"
            onClick={() => setSigningIn(true)}
            aria-label={t("remote.azSignIn")}
            className={iconButtonClass({ size: "md" })}
          >
            <Cloud size={16} />
          </button>
        </Tooltip>
        {/* Absent for an account, not disabled: adding one already saves it, so a second button
            meaning "save" would be a button with nothing left to do. The other verb, and it stays:
            Connect is once, this is a host row you keep. */}
        {!azure && (
          <Tooltip label={t("remote.saveAsHost")}>
            <button
              type="button"
              onClick={() => void save()}
              disabled={!parsed || busy}
              aria-label={t("remote.saveAsHost")}
              className={iconButtonClass({ size: "md" })}
            >
              <Save size={16} />
            </button>
          </Tooltip>
        )}
      </div>

      {parsed && <ParsePreview parsed={parsed} />}
      {azure && <AzurePreview parsed={azure} />}

      {signingIn && <AzureSignInModal onClose={() => setSigningIn(false)} />}
    </div>
  );
}

/**
 * One thing the line was read as: the field it landed in, then the value, in the face the value is
 * typed in. A chip per fact rather than one run-on line, so "is the port right?" is a glance at one
 * chip instead of a read along a string.
 */
function ReadAs({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  return (
    <span className={chipClass("neutral", "max-w-full")}>
      <span className="shrink-0 text-[var(--cf-text-faint)]">{label}</span>
      <span className={`min-w-0 truncate text-[var(--cf-text)] ${mono ? "font-mono" : ""}`}>
        {value}
      </span>
    </span>
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

  const bits: [string, string][] = [];
  if (spec.user) bits.push([t("remote.fieldUser"), spec.user]);
  bits.push([t("remote.fieldHost"), spec.host]);
  if (spec.port) bits.push([t("remote.fieldPort"), String(spec.port)]);
  if (spec.jump) bits.push([t("remote.fieldJump"), spec.jump]);
  if (spec.key_file) bits.push([t("remote.fieldKeyFile"), spec.key_file]);
  if (spec.command) bits.push([t("remote.fieldCommand"), spec.command]);

  return (
    <div className="flex flex-wrap items-center gap-1.5 pt-2">
      {bits.map(([label, value]) => (
        <ReadAs key={label} label={label} value={value} />
      ))}
      {/* A sentence, not a chip: it names the flags it dropped, and that can run long enough to
          need wrapping — which a chip, being one line, would clip. */}
      {parsed.ignored.length > 0 && (
        <span className="flex min-w-0 items-center gap-1 text-[11px] text-[var(--cf-warning)]">
          <AlertTriangle size={12} className="shrink-0" />
          {t("remote.parseIgnored", { flags: parsed.ignored.join(" ") })}
        </span>
      )}
    </div>
  );
}

/** What the pasted connection string was read as, before a row exists. */
function AzurePreview({ parsed }: { parsed: ParsedAzureConnection }) {
  const t = useT();
  const { azure } = parsed.spec;

  const bits: [string, string, boolean][] = [[t("remote.azAccount"), azure.account || "—", true]];
  bits.push([
    t("remote.fieldAuth"),
    parsed.auth === "sas" ? t("remote.azAuthSas") : t("remote.azAuthKey"),
    false,
  ]);
  if (azure.endpoint_suffix) bits.push([t("remote.azSuffix"), azure.endpoint_suffix, true]);
  if (azure.endpoint) bits.push([t("remote.azEndpoint"), azure.endpoint, true]);

  return (
    <div className="flex flex-wrap items-center gap-1.5 pt-2">
      {/* The secret itself is never echoed — only that there is one. The line is on screen and may
          be on somebody else's screen too. */}
      {bits.map(([label, value, mono]) => (
        <ReadAs key={label} label={label} value={value} mono={mono} />
      ))}
      <span className="text-[11px] text-[var(--cf-text-faint)]">{t("remote.azWillSave")}</span>
    </div>
  );
}
