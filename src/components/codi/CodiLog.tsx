import { Check, FileSearch, Megaphone, ShieldQuestion, Square, X } from "lucide-react";
import { Button } from "../common/Button";
import { chipClass } from "../common/recipes";
import type { CodiHeard, CodiTurn } from "../../lib/tauri/codiCommands";
import type { TranslationKey } from "../../lib/i18n/translations";
import { useCodiStore, type AnnouncedLine, type TurnLine } from "../../state/codiStore";
import { useLanguageStore, useT } from "../../state/languageStore";

/**
 * What Codi heard and said, the confirmation it waits on, and — in the expanded window — the log of
 * every order and what came of it.
 */

const IGNORED_KEY: Record<NonNullable<CodiHeard["ignored"]>, TranslationKey> = {
  name: "codi.window.ignoredName",
  own: "codi.window.ignoredOwn",
  quiet: "codi.window.ignoredQuiet",
};

const TIER_KEY: Record<CodiTurn["tier"], TranslationKey> = {
  own: "codi.window.tierNone",
  router: "codi.window.tierNone",
  local: "codi.window.tierLocal",
  provider: "codi.window.tierProvider",
};

/** `340 ms`, `1,2 s` — in the window's language. */
export function formatMs(ms: number, language: string): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  const seconds = (ms / 1000).toFixed(1);
  return `${language === "es" ? seconds.replace(".", ",") : seconds} s`;
}

/** What a turn came to, in one line: its error, its answer, or — an answer left empty — what its
 *  actions said (or why they failed). */
export function turnLine(turn: Pick<CodiTurn, "error" | "reply" | "actions">): { text: string; failed: boolean } {
  if (turn.error) return { text: turn.error, failed: true };
  if (turn.reply.trim()) return { text: turn.reply, failed: false };
  const parts = turn.actions.map((acted) => (acted.ok ? acted.say : (acted.error ?? acted.say))).filter((part): part is string => !!part);
  return { text: parts.join(" · "), failed: turn.actions.some((acted) => !acted.ok) };
}

/** The last thing heard — greyed, with why, when it was not acted on — and the last thing said. */
export function CodiTranscript() {
  const t = useT();
  const heard = useCodiStore((s) => s.heard[0]);
  const turn = useCodiStore((s) => s.turns[0]);
  const announced = useCodiStore((s) => s.announced[0]);
  const speaking = useCodiStore((s) => s.state?.phase === "speaking");
  // The newest of its answer and its announcement is what it said last.
  const line = announced && (!turn || announced.at >= turn.at) ? { text: announced.text, failed: false } : turn ? turnLine(turn) : null;
  const said = line?.text;

  if (!heard && !said) return null;
  return (
    <div className="flex w-full flex-col items-center gap-1 text-center">
      {heard && (
        <p className={`max-w-full text-[13px] leading-snug ${heard.ignored ? "text-[var(--cf-text-faint)]" : "text-[var(--cf-text)]"}`}>
          <span className="break-words">«{heard.text}»</span>
          {heard.ignored && <span className="ml-1.5 whitespace-nowrap text-[10.5px]">{t(IGNORED_KEY[heard.ignored])}</span>}
        </p>
      )}
      {said && (
        <p className={`max-w-full break-words text-[12.5px] leading-snug ${line?.failed ? "text-[var(--cf-danger)]" : "text-[var(--cf-text-muted)]"}`}>
          {said}
        </p>
      )}
      {speaking && (
        <Button size="sm" variant="secondary" onClick={() => useCodiStore.getState().hush()} className="mt-0.5">
          <Square size={10} fill="currentColor" />
          {t("codi.window.hush")}
        </Button>
      )}
    </div>
  );
}

/** A destructive action waiting for a yes — from these buttons, or said aloud. */
export function CodiConfirmCard() {
  const t = useT();
  const confirmation = useCodiStore((s) => s.confirmation);
  const mic = useCodiStore((s) => !!s.state?.mic);
  if (!confirmation) return null;
  return (
    <div
      role="alertdialog"
      aria-label={t("codi.window.confirmTitle")}
      className="rounded-lg border border-[var(--cf-warning)]/40 bg-[color-mix(in_oklab,var(--cf-warning)_8%,transparent)] px-3 py-2.5"
    >
      <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-warning)]">
        <ShieldQuestion size={12} />
        {t("codi.window.confirmTitle")}
      </p>
      <p className="mt-1 break-words text-[13px] text-[var(--cf-text)]">{confirmation.what}</p>
      <div className="mt-2 flex items-center gap-2">
        <Button size="sm" variant="primary" onClick={() => void useCodiStore.getState().confirm(true)}>
          {t("codi.window.confirmYes")}
        </Button>
        <Button size="sm" variant="secondary" onClick={() => void useCodiStore.getState().confirm(false)}>
          {t("codi.window.confirmNo")}
        </Button>
      </div>
      {mic && <p className="mt-1.5 text-[11px] text-[var(--cf-text-muted)]">{t("codi.window.confirmVoice")}</p>}
    </div>
  );
}

type LogEntry = { kind: "turn"; at: number; turn: TurnLine } | { kind: "announce"; at: number; said: AnnouncedLine };

/** Every order and what came of it, newest first, with the announcements between them. */
export function CodiActionLog() {
  const t = useT();
  const language = useLanguageStore((s) => s.language);
  const turns = useCodiStore((s) => s.turns);
  const announced = useCodiStore((s) => s.announced);
  const entries: LogEntry[] = [
    ...turns.map((turn): LogEntry => ({ kind: "turn", at: turn.at, turn })),
    ...announced.map((said): LogEntry => ({ kind: "announce", at: said.at, said })),
  ].sort((a, b) => b.at - a.at);

  return (
    <section aria-label={t("codi.window.log")} className="flex flex-col gap-1.5">
      <h2 className="px-0.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]">{t("codi.window.log")}</h2>
      {entries.length === 0 && <p className="px-0.5 text-[11.5px] text-[var(--cf-text-muted)]">{t("codi.window.logEmpty")}</p>}
      {entries.map((entry) =>
        entry.kind === "announce" ? (
          <AnnouncedRow key={`a-${entry.at}-${entry.said.text}`} said={entry.said} t={t} />
        ) : (
          <TurnRow key={`t-${entry.turn.id}`} turn={entry.turn} language={language} t={t} />
        ),
      )}
    </section>
  );
}

/** Something said without being a turn's answer: a notification, or what Codi went to find out
 *  in the background (`research:<repo>`, `log:<container>`), which is labelled with what it is about. */
function AnnouncedRow({ said, t }: { said: AnnouncedLine; t: ReturnType<typeof useT> }) {
  const [kind, about] = said.source.includes(":") ? [said.source.slice(0, said.source.indexOf(":")), said.source.slice(said.source.indexOf(":") + 1)] : [said.source, ""];
  const found = kind === "research" || kind === "log";
  return (
    <div className="flex items-start gap-2 rounded-lg bg-[var(--cf-sunken)] px-2.5 py-2">
      {found ? (
        <FileSearch size={12} className="mt-[3px] shrink-0 text-[var(--cf-accent)]" />
      ) : (
        <Megaphone size={12} className="mt-[3px] shrink-0 text-[var(--cf-text-muted)]" />
      )}
      <div className="min-w-0 flex-1">
        {found && about && <p className="text-[10.5px] font-medium text-[var(--cf-text-muted)]">{t("codi.window.about", { name: about })}</p>}
        <p className="break-words text-[12px] text-[var(--cf-text)]">{said.text}</p>
      </div>
    </div>
  );
}

function TurnRow({ turn, language, t }: { turn: TurnLine; language: string; t: ReturnType<typeof useT> }) {
  return (
    <div className="rounded-lg bg-[var(--cf-sunken)] px-2.5 py-2">
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 break-words text-[12.5px] font-medium text-[var(--cf-text)]">«{turn.order}»</p>
        <span className={chipClass(turn.tier === "provider" ? "info" : turn.tier === "local" ? "accent" : "neutral")}>{t(TIER_KEY[turn.tier])}</span>
        <span className="mt-[2px] shrink-0 text-[10.5px] tabular-nums text-[var(--cf-text-faint)]">{formatMs(turn.ms, language)}</span>
      </div>
      {turn.actions.length > 0 && (
        <ul className="mt-1 space-y-0.5">
          {turn.actions.map((acted, index) => (
            <li key={`${acted.action}-${index}`} className="flex items-start gap-1.5 text-[11.5px]">
              {acted.ok ? (
                <Check size={12} className="mt-[2px] shrink-0 text-[var(--cf-success)]" aria-label={t("codi.window.actionOk")} />
              ) : (
                <X size={12} className="mt-[2px] shrink-0 text-[var(--cf-danger)]" aria-label={t("codi.window.actionFailed")} />
              )}
              <span className="min-w-0 flex-1 break-words">
                <span className={acted.ok ? "text-[var(--cf-text)]" : "text-[var(--cf-danger)]"}>
                  {acted.ok ? acted.say || acted.action : acted.error || acted.say || acted.action}
                </span>
                <span className="ml-1.5 font-mono text-[10.5px] text-[var(--cf-text-faint)]">{acted.action}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {turn.actions.length === 0 && turn.reply && !turn.error && (
        <p className="mt-1 break-words text-[11.5px] text-[var(--cf-text-muted)]">{turn.reply}</p>
      )}
      {turn.error && <p className="mt-1 break-words text-[11.5px] text-[var(--cf-danger)]">{turn.error}</p>}
    </div>
  );
}
