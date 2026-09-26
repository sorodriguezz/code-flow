import { useEffect, useRef, useState } from "react";
import { Check, ListChecks, Minus } from "lucide-react";
import { providerCapabilities, providerDisplayLabel } from "../../lib/aiProviders";
import { useT } from "../../state/languageStore";

/**
 * What this conversation can and cannot do, in one place.
 *
 * # Why this is not a capability grid
 *
 * The obvious version of this — a matrix of "images ✓ / video ✗ / files ✓" per model — would be
 * one more thing in this workspace claiming something it cannot check. There is no image generator
 * here and no video generator: a file comes out of **an engine running code that writes one**, so
 * "can it make me a PNG?" is not a fact about the model at all. It is a question about which
 * interpreters are installed, and the answer changes the day somebody runs `brew install python`.
 *
 * So every row is either a flag the app already acts on — `acceptsImages` decides whether the paste
 * target is enabled, `streamsTokens` decides whether the transcript can type — or a state of *this*
 * conversation. Nothing is asserted that could not be checked, and nothing is said that the reader
 * cannot act on.
 *
 * # Three things were cut from here, all for one reason
 *
 * **A panel read before the question is asked is the wrong place for anything conditional.**
 *
 * - A "reach your repository" row, which could only ever be a dash: no conversation in this
 *   workspace is ever bound to a repository — every call site of `conversationStore.create` passes
 *   `null` and nothing offers a picker — and the sentence under it told the reader to open a chat
 *   from a repository, which this app cannot do.
 * - The prose that replaced it, naming the AI panel as the repo-bound surface. True, and still one
 *   more paragraph standing between the reader and a question they had already decided to ask.
 * - The interpreters found on `PATH`. Reading `node npm python3 pip3` before asking anything tells
 *   you nothing, because you do not yet know which one your question will need. That belongs in the
 *   turn that needs it, so the prompt carries it instead: the engine checks before it reaches for a
 *   runtime, and when one is missing it names it and offers to install it — at the only moment the
 *   answer means anything. See `runtimes_note` in `chat_cmd.rs`.
 *
 * What is left is five rows, each of which changes with the engine, the setting or the
 * conversation.
 *//** One row: a tick or a dash, a sentence, and nothing else. */
function Ability({ yes, label, detail }: { yes: boolean; label: string; detail?: string }) {
  return (
    <div className="flex items-start gap-2">
      <span
        className={`mt-[3px] flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full ${
          yes
            ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
            : "bg-[var(--cf-press)] text-[var(--cf-text-muted)]"
        }`}
      >
        {yes ? <Check size={9} strokeWidth={3} /> : <Minus size={9} strokeWidth={3} />}
      </span>
      <span className="min-w-0">
        <span className={yes ? "text-[var(--cf-text)]" : "text-[var(--cf-text-muted)]"}>{label}</span>
        {detail && (
          <span className="block text-[10.5px] leading-relaxed text-[var(--cf-text-muted)]">{detail}</span>
        )}
      </span>
    </div>
  );
}

export function ChatCapabilities({
  provider,
  effortSupported,
  /** Whether this conversation's turns may write files at all — today that is the file-generation
   *  setting alone, since no chat here reaches a repository. */
  canWriteFiles,
}: {
  provider: string;
  effortSupported: boolean;
  canWriteFiles: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const caps = providerCapabilities(provider);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const name = providerDisplayLabel(provider, t);

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        data-tour="chat-capabilities"
        title={t("chat.capabilitiesTitle")}
        aria-label={t("chat.capabilitiesTitle")}
        aria-expanded={open}
        className={`flex h-[26px] w-[26px] items-center justify-center rounded-md transition-colors hover:bg-[var(--cf-hover)] ${
          open ? "text-[var(--cf-accent)]" : "text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
        }`}
      >
        <ListChecks size={14} />
      </button>

      {open && (
        <div className="absolute bottom-9 left-0 z-30 w-[320px] rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-3 text-[12px] shadow-[var(--cf-shadow)]">
          <p className="mb-2 text-[11px] font-semibold text-[var(--cf-text)]">
            {t("chat.capabilitiesHeading", { provider: name })}
          </p>

          <div className="space-y-1.5">
            <Ability
              yes={caps.acceptsImages}
              label={t("chat.capImagesIn")}
              detail={caps.acceptsImages ? undefined : t("chat.capImagesInNo", { provider: name })}
            />
            <Ability
              yes={canWriteFiles}
              label={t("chat.capFilesOut")}
              detail={canWriteFiles ? t("chat.capFilesOutYes") : t("chat.capFilesOutNo")}
            />
            <Ability
              yes={caps.streamsTokens}
              label={t("chat.capStreams")}
              detail={caps.streamsTokens ? undefined : t("chat.capStreamsNo")}
            />
            {/*
              Where the sidebar's warning triangle went, and a better home for it.

              It used to be a yellow ⚠ on every Gemini row whenever a second Gemini conversation
              existed — permanent, unactionable, and explained only by a hover. The fact is real
              and worth knowing (agy answers a headless caller with the fixed `agy-last` sentinel
              and continues from whatever it ran last, so two open chats cross), but it is a
              property of the engine, which is exactly what this panel is for. Cline is the other
              half of the same question and was never said anywhere: it has no resume at all, so
              every turn re-sends the whole transcript and a long chat costs more each time.
            */}
            <Ability
              yes={caps.resumesSessions && !caps.resumeIsAmbiguous}
              label={t("chat.capResume")}
              detail={
                caps.resumeIsAmbiguous
                  ? t("chat.ambiguousResumeWarning", { provider: name })
                  : caps.resumesSessions
                    ? undefined
                    : t("chat.capResumeNone")
              }
            />
            <Ability yes={effortSupported} label={t("chat.capEffort")} />
          </div>
        </div>
      )}
    </div>
  );
}
