import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Check, CornerDownLeft, Lock, Minus, Plus, Search, Users, X } from "lucide-react";
import { useDialog } from "../../../lib/useFocusTrap";
import { buttonClass } from "../../common/Button";
import { fieldClass } from "../../common/recipes";
import { meetingsVoices, type Meeting, type MeetingRosterArgs, type MeetingSpeaker, type Voice } from "../../../lib/tauri/meetingsCommands";
import { useT } from "../../../state/languageStore";
import { MAX_PEOPLE, initialRoster, meFixed, pickableVoices, rosterIds, rosterSections, rosterSummary, separatedCount, tickedVoices, type RosterChoice } from "./roster";

/** What the dialog was opened for — it names the button that ends it. */
export type RosterPurpose = "transcribe" | "separate" | "retranscribe";

/** From this many saved voices the list gets a search field; below it, the whole list fits at a glance. */
const SEARCH_FROM = 7;

/**
 * "¿Quiénes hablaron?" — asked before the voices are separated.
 *
 * The user builds the list instead of guessing a number: "Tú" (fixed in a call — the microphone is
 * theirs), the saved voices they tick, and how many more they do not know. The top of the dialog is
 * that list as it stands — "8 personas" and a chip per person, each removable — so what is sent is
 * exactly what they see. Ticked voices anchor their person in the clustering and come out named;
 * "No lo sé" leaves it all to the clustering, as before.
 *
 * There may be a hundred saved voices, so they are a scrolling list, not a wall of chips: the ones
 * this meeting already points at first, then everyone alphabetically, with a search that ignores
 * accents. Typing a name and pressing Enter ticks the first match and clears the field for the next
 * one — "jua ↵ ped ↵ die ↵" fills a roster without the mouse.
 *
 * Opens on last time's roster, or on whoever the last separation recognised.
 */
export function MeetingRoster({
  meeting,
  speakers,
  purpose,
  onCancel,
  onConfirm,
}: {
  meeting: Meeting;
  speakers: MeetingSpeaker[];
  purpose: RosterPurpose;
  onCancel: () => void;
  /** `null`: "No lo sé" — no count, no names. */
  onConfirm: (who: MeetingRosterArgs | null) => void;
}) {
  const t = useT();
  const panel = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [voices, setVoices] = useState<Voice[] | null>(null);
  const [choice, setChoice] = useState<RosterChoice>({ voiceIds: [], unknown: 0 });
  const [query, setQuery] = useState("");
  useDialog(panel, true, onCancel);

  useEffect(() => {
    let alive = true;
    void meetingsVoices()
      .catch(() => [] as Voice[])
      .then((list) => {
        if (!alive) return;
        setVoices(list);
        setChoice(initialRoster(meeting, speakers, list));
      });
    return () => {
      alive = false;
    };
    // Read once per opening: a roster re-derived while the user ticks would undo their ticks.
  }, []);

  const all = useMemo(() => voices ?? [], [voices]);
  const pickable = useMemo(() => pickableVoices(all, meeting.kind), [all, meeting.kind]);
  // The sections are sorted when the dialog opens and when the query changes — not when a voice is
  // ticked, or the row under the pointer would jump away from it.
  const sections = useMemo(() => rosterSections(all, meeting, speakers, query), [all, meeting, speakers, query]);
  const shown = useMemo(() => [...sections.suggested, ...sections.rest], [sections]);
  const searchable = pickable.length >= SEARCH_FROM;
  const first = query.trim() ? shown[0] : undefined;

  const me = t("meetings.speaker.me");
  const summary = rosterSummary(choice, all, meeting.kind, me);
  const chosen = tickedVoices(choice, all, meeting.kind);
  const separated = separatedCount(choice, all, meeting.kind);
  const ready = voices !== null && separated > 0;

  const toggle = (id: string) =>
    setChoice((c) => ({ ...c, voiceIds: c.voiceIds.includes(id) ? c.voiceIds.filter((v) => v !== id) : [...c.voiceIds, id] }));
  const setUnknown = (n: number) => setChoice((c) => ({ ...c, unknown: Math.max(0, Math.min(MAX_PEOPLE - c.voiceIds.length, Math.round(n) || 0)) }));
  const confirm = () => {
    if (ready) onConfirm({ speakers: separated, roster: rosterIds(choice, all, meeting.kind) });
  };
  const confirmLabel = purpose === "transcribe" ? t("meetings.roster.transcribe") : purpose === "separate" ? t("meetings.roster.separate") : t("meetings.retranscribe");

  const rows = () => Array.from(list.current?.querySelectorAll<HTMLButtonElement>("button[data-voice]") ?? []);
  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && query.trim()) {
      // Ticks the first match and clears the field for the next name. An empty field lets Enter
      // through to the dialog, which confirms.
      e.preventDefault();
      e.stopPropagation();
      if (first) {
        toggle(first.id);
        setQuery("");
      }
    } else if (e.key === "Escape" && query) {
      // Clears the search first; the next Escape closes the dialog.
      e.preventDefault();
      setQuery("");
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      rows()[0]?.focus();
    }
  };
  const onListKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const buttons = rows();
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (at === -1) return;
    e.preventDefault();
    const next = at + (e.key === "ArrowDown" ? 1 : -1);
    if (next < 0) search.current?.focus();
    else buttons[Math.min(next, buttons.length - 1)]?.focus();
  };

  const row = (v: Voice) => {
    const on = choice.voiceIds.includes(v.id);
    return (
      <button
        key={v.id}
        type="button"
        data-voice={v.id}
        aria-pressed={on}
        // With a search field the arrows walk the rows from it — a hundred Tab stops would trap the
        // keyboard in the list. A short list without one keeps them in the Tab order.
        tabIndex={searchable ? -1 : 0}
        onClick={() => toggle(v.id)}
        className="flex h-8 w-full shrink-0 items-center gap-2.5 rounded-md px-2 text-left text-[12.5px] outline-none hover:bg-[var(--cf-hover)] focus-visible:bg-[var(--cf-hover)] focus-visible:ring-1 focus-visible:ring-[var(--cf-accent)]"
      >
        <span
          aria-hidden
          className="flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors"
          style={{ borderColor: on ? "var(--cf-accent)" : "var(--cf-field-border)", backgroundColor: on ? "var(--cf-accent-fill)" : "transparent" }}
        >
          {on && <Check size={11} strokeWidth={3} className="text-[var(--cf-on-accent)]" />}
        </span>
        <span className={`min-w-0 flex-1 truncate ${on ? "text-[var(--cf-text)]" : "text-[var(--cf-text-muted)]"}`}>{v.isMe ? me : v.name}</span>
        {first?.id === v.id && <CornerDownLeft size={11} className="shrink-0 text-[var(--cf-text-faint)]" aria-hidden />}
      </button>
    );
  };
  const heading = (text: string) => (
    <p className="sticky top-0 z-[1] bg-[var(--cf-surface)] px-2 pb-1 pt-2 text-[10.5px] font-medium uppercase tracking-wide text-[var(--cf-text-faint)]">{text}</p>
  );

  const chip = "flex items-center gap-1 rounded-full border px-2 py-[2px] text-[12px]";

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 p-4" onClick={onCancel}>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="cf-roster-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          // Enter confirms from anywhere but a button, which answers its own Enter.
          if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement)) {
            e.preventDefault();
            confirm();
          }
        }}
        className="cf-fade-in flex max-h-[calc(100vh-2rem)] w-[460px] max-w-[92vw] flex-col gap-3.5 overflow-hidden rounded-[14px] border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-5 shadow-[var(--cf-shadow-modal)]"
      >
        <div className="flex shrink-0 items-start gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]">
            <Users size={15} />
          </span>
          <div className="flex-1 pt-0.5">
            <p id="cf-roster-title" className="text-[13.5px] font-medium text-[var(--cf-text)]">
              {t("meetings.roster.title")}
            </p>
            <p className="mt-0.5 text-[11.5px] leading-snug text-[var(--cf-text-muted)]">{t("meetings.roster.subtitle")}</p>
          </div>
        </div>

        {/* Who is in, as it stands: the count and a chip per person, each removable. */}
        <div className="shrink-0 rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface)] px-3 py-2.5" aria-live="polite">
          {separated > 0 ? (
            <>
              <p className="text-[13px] font-medium text-[var(--cf-text)]">{summary.total === 1 ? t("meetings.roster.totalOne") : t("meetings.roster.total", { n: summary.total })}</p>
              <div className="mt-2 flex max-h-[76px] flex-wrap gap-1.5 overflow-y-auto">
                {meFixed(meeting.kind) && (
                  <span className={`${chip} border-[var(--cf-accent)] bg-[var(--cf-accent-soft)] text-[var(--cf-text)]`} title={t("meetings.roster.meFixed")}>
                    <Lock size={10} className="text-[var(--cf-accent)]" aria-hidden />
                    {me}
                  </span>
                )}
                {chosen.map((v) => (
                  <span key={v.id} className={`${chip} border-[var(--cf-accent)] bg-[var(--cf-accent-soft)] pr-1 text-[var(--cf-text)]`}>
                    {v.isMe ? me : v.name}
                    <button
                      type="button"
                      onClick={() => toggle(v.id)}
                      aria-label={t("meetings.roster.remove", { name: v.isMe ? me : v.name })}
                      className="flex h-4 w-4 items-center justify-center rounded-full text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]"
                    >
                      <X size={10} />
                    </button>
                  </span>
                ))}
                {choice.unknown > 0 && (
                  <span className={`${chip} border-dashed border-[var(--cf-border-strong)] text-[var(--cf-text-muted)]`}>{t("meetings.roster.unknownChip", { n: choice.unknown })}</span>
                )}
              </div>
            </>
          ) : (
            <p className="text-[11.5px] leading-snug text-[var(--cf-text-muted)]">{t("meetings.roster.nobody")}</p>
          )}
        </div>

        {/* The saved voices: a list that scrolls, however many there are. */}
        <section className="flex min-h-0 flex-col gap-2">
          {voices === null ? (
            <p className="text-[11.5px] text-[var(--cf-text-faint)]">…</p>
          ) : pickable.length === 0 ? (
            <p className="text-[11.5px] leading-snug text-[var(--cf-text-faint)]">{t("meetings.roster.noVoices")}</p>
          ) : (
            <>
              {searchable ? (
                <label className="relative flex shrink-0 items-center">
                  <Search size={12} className="pointer-events-none absolute left-2.5 text-[var(--cf-text-faint)]" aria-hidden />
                  <input
                    ref={search}
                    autoFocus
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={onSearchKey}
                    placeholder={t("meetings.roster.searchIn", { n: pickable.length })}
                    aria-label={t("meetings.roster.searchIn", { n: pickable.length })}
                    className={fieldClass({ className: "h-8 w-full pl-8 text-[12.5px]" })}
                  />
                </label>
              ) : (
                <p className="shrink-0 text-[11.5px] font-medium text-[var(--cf-text-muted)]">{t("meetings.roster.saved")}</p>
              )}
              <div
                ref={list}
                onKeyDown={onListKey}
                className="flex max-h-[224px] min-h-0 flex-col overflow-y-auto rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface)] p-1"
              >
                {shown.length === 0 ? (
                  <p className="px-2 py-2.5 text-[11.5px] leading-snug text-[var(--cf-text-faint)]">{t("meetings.roster.noMatch", { query: query.trim() })}</p>
                ) : sections.suggested.length > 0 && sections.rest.length > 0 ? (
                  <>
                    {heading(t("meetings.roster.inMeeting"))}
                    {sections.suggested.map(row)}
                    {heading(t("meetings.roster.allVoices"))}
                    {sections.rest.map(row)}
                  </>
                ) : (
                  shown.map(row)
                )}
              </div>
            </>
          )}
        </section>

        <section className="flex shrink-0 items-center justify-between gap-3">
          <span className="text-[11.5px] font-medium text-[var(--cf-text-muted)]">{t("meetings.roster.unknown")}</span>
          <div className="flex items-center rounded-md border border-[var(--cf-border)]">
            <button type="button" aria-label={t("meetings.roster.fewer")} disabled={choice.unknown <= 0} onClick={() => setUnknown(choice.unknown - 1)} className="flex h-7 w-7 items-center justify-center text-[var(--cf-text-muted)] hover:text-[var(--cf-text)] disabled:opacity-40">
              <Minus size={12} />
            </button>
            <input
              value={choice.unknown}
              inputMode="numeric"
              aria-label={t("meetings.roster.unknown")}
              onChange={(e) => setUnknown(Number(e.target.value.replace(/\D/g, "")))}
              onFocus={(e) => e.target.select()}
              className="h-7 w-9 border-x border-[var(--cf-border)] bg-transparent text-center font-mono text-[12px] tabular-nums text-[var(--cf-text)] outline-none"
            />
            <button type="button" aria-label={t("meetings.roster.more")} onClick={() => setUnknown(choice.unknown + 1)} className="flex h-7 w-7 items-center justify-center text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]">
              <Plus size={12} />
            </button>
          </div>
        </section>

        <div className="flex shrink-0 items-center justify-between gap-2">
          <button type="button" onClick={() => onConfirm(null)} className={buttonClass({ variant: "ghost", size: "sm" })} title={t("meetings.roster.dontKnowHint")}>
            {t("meetings.roster.dontKnow")}
          </button>
          <div className="flex gap-2">
            <button type="button" onClick={onCancel} className={buttonClass({ variant: "ghost" })}>
              {t("common.cancel")}
            </button>
            <button type="button" onClick={confirm} disabled={!ready} className={buttonClass({ variant: "primary" })}>
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
