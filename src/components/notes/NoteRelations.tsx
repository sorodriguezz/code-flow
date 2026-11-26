/**
 * «Relacionadas» — the notes and meetings that are about the same thing as the open one, and the
 * ones it follows or that follow it.
 *
 * Backlinks answer "who wrote my title down". This answers the question a week of meetings leaves
 * behind: which earlier one does this continue, and did what was left open there get closed. The
 * pairs are made on their own — by the notes' words every time one is looked at, and by a model
 * when asked or after a meeting's minutes are written (`note_relations` in the backend) — so the
 * panel is something to read, not something to keep up.
 *
 * Two pieces of one list: [`NoteRelationsBar`] is the line over the note, there whenever it has
 * relations, so a follow-up says what it follows without the rail open; [`NoteRelations`] is the
 * rail's section, where a pair is explained, added by hand or taken apart.
 */

import { useEffect, useMemo, useState } from "react";
import { Check, Circle, CornerDownRight, CornerUpLeft, Link2, Loader2, Mic, Plus, Sparkles, Waypoints, X } from "lucide-react";
import { useNoteRelationsStore } from "../../state/noteRelationsStore";
import { useNotesStore } from "../../state/notesStore";
import { useLanguageStore, useT } from "../../state/languageStore";
import { linkCandidates, relationRole, relationSummary, relationWhy, ROLE_LABEL, type RelationRole } from "../../lib/notes/relations";
import { fieldClass } from "../common/recipes";
import { Skeleton } from "../common/Skeleton";
import { ICON_BUTTON, relativeTime } from "./notesChrome";
import type { NoteRelation } from "../../types/notes";

const ROLE_ICON: Record<RelationRole, typeof Link2> = {
  continuesFrom: CornerUpLeft,
  continuedIn: CornerDownRight,
  related: Link2,
};

/** A continuation is the stronger claim, so it carries the accent; "about the same" stays quiet. */
const roleInk = (role: RelationRole) => (role === "related" ? "text-[var(--cf-text-muted)]" : "text-[var(--cf-accent)]");

/** Starts and stops following `noteId`, and compares it again a few seconds after it was last
 *  saved — while it is being typed the words have not settled. */
export function useNoteRelations(noteId: string | null, savedAt: string | null): void {
  useEffect(() => {
    useNoteRelationsStore.getState().watch(noteId);
  }, [noteId]);
  useEffect(() => {
    if (!noteId || !savedAt) return;
    const timer = window.setTimeout(() => void useNoteRelationsStore.getState().rescan(), 4000);
    return () => window.clearTimeout(timer);
  }, [noteId, savedAt]);
}

/** The line over the note: what it follows, what follows it and what it is like. Nothing when the
 *  note stands alone. */
export function NoteRelationsBar({ noteId }: { noteId: string }) {
  const t = useT();
  const relations = useNoteRelationsStore((s) => (s.noteId === noteId ? s.relations : EMPTY));
  const openNote = useNotesStore((s) => s.openNote);
  if (relations.length === 0) return null;
  return (
    <div
      role="group"
      aria-label={t("notes.relations.title")}
      className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-[var(--cf-border)] px-3 py-1.5 [scrollbar-width:none]"
    >
      <Waypoints size={12} className="shrink-0 text-[var(--cf-text-faint)]" aria-hidden />
      {relations.map((relation) => {
        const role = relationRole(relation);
        const Icon = ROLE_ICON[role];
        return (
          <button
            key={relation.id}
            type="button"
            onClick={() => void openNote(relation.id)}
            title={relationSummary(relation, t)}
            className="group inline-flex h-[22px] max-w-[260px] shrink-0 items-center gap-1 rounded-full border border-[var(--cf-border)] bg-[var(--cf-surface)] pl-1.5 pr-2 text-[11.5px] text-[var(--cf-text)] outline-none transition-colors hover:border-[var(--cf-accent-line)] hover:bg-[var(--cf-hover)] focus-visible:shadow-[0_0_0_2px_var(--cf-accent-line)]"
          >
            <Icon size={11} className={`shrink-0 ${roleInk(role)}`} aria-hidden />
            {role !== "related" && <span className={`shrink-0 ${roleInk(role)}`}>{t(ROLE_LABEL[role])}</span>}
            <span className="min-w-0 truncate">{relation.title.trim() || t("notes.untitled")}</span>
            {relation.pending.length > 0 && (
              <span className="shrink-0 rounded-full bg-[color-mix(in_oklab,var(--cf-warning)_16%,transparent)] px-1 text-[10px] font-medium tabular-nums text-[var(--cf-warning)]">
                {relation.pending.length}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

const EMPTY: NoteRelation[] = [];

/** The rail's section. */
export function NoteRelations({ noteId }: { noteId: string }) {
  const t = useT();
  const language = useLanguageStore((s) => s.language);
  const watching = useNoteRelationsStore((s) => s.noteId === noteId);
  const relations = useNoteRelationsStore((s) => (s.noteId === noteId ? s.relations : EMPTY));
  const loaded = useNoteRelationsStore((s) => s.noteId === noteId && s.loaded);
  const judging = useNoteRelationsStore((s) => Boolean(s.judging[noteId]));
  const openNote = useNotesStore((s) => s.openNote);
  const [adding, setAdding] = useState(false);

  // A picker left open belongs to the note it was opened on.
  useEffect(() => setAdding(false), [noteId]);

  return (
    <div className="flex min-h-0 flex-col border-t border-[var(--cf-border)]">
      <div className="flex shrink-0 items-center gap-1 py-1 pl-3 pr-1.5">
        <p className="flex min-w-0 flex-1 items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
          <Waypoints size={11} className="shrink-0" />
          <span className="truncate">{t("notes.relations.title")}</span>
          {relations.length > 0 && <span className="tabular-nums opacity-70">{relations.length}</span>}
        </p>
        <button
          type="button"
          disabled={judging || !watching}
          onClick={() => void useNoteRelationsStore.getState().analyze(noteId)}
          title={judging ? t("notes.relations.analyzing") : t("notes.relations.analyzeHint")}
          aria-label={t("notes.relations.analyze")}
          className={`${ICON_BUTTON} !h-6 !w-6`}
        >
          {judging ? <Loader2 size={13} className="animate-spin text-[var(--cf-accent)]" /> : <Sparkles size={13} />}
        </button>
        <button
          type="button"
          onClick={() => setAdding((open) => !open)}
          title={t("notes.relations.addHint")}
          aria-label={t("notes.relations.add")}
          aria-expanded={adding}
          className={`${ICON_BUTTON} !h-6 !w-6 ${adding ? "bg-[var(--cf-accent-soft)] !text-[var(--cf-accent)]" : ""}`}
        >
          <Plus size={13} />
        </button>
      </div>

      {adding && <LinkPicker noteId={noteId} linked={relations} onDone={() => setAdding(false)} />}

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {!loaded ? (
          <div className="space-y-1 px-1" aria-hidden>
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : relations.length === 0 ? (
          <p className="px-1 text-[11px] leading-snug text-[var(--cf-text-muted)]">{t("notes.relations.empty")}</p>
        ) : (
          <ul className="space-y-0.5">
            {relations.map((relation) => (
              <RelationRow key={relation.id} relation={relation} language={language} onOpen={() => void openNote(relation.id)} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function RelationRow({ relation, language, onOpen }: { relation: NoteRelation; language: string; onOpen: () => void }) {
  const t = useT();
  const role = relationRole(relation);
  const Icon = ROLE_ICON[role];
  const why = relationWhy(relation, t);
  const title = relation.title.trim() || t("notes.untitled");
  return (
    <li className="group relative">
      <button
        type="button"
        onClick={onOpen}
        className="w-full rounded-md py-1.5 pl-2 pr-7 text-left outline-none transition-colors hover:bg-[var(--cf-hover)] focus-visible:shadow-[inset_0_0_0_2px_var(--cf-accent-line)]"
      >
        <span className={`flex items-center gap-1 text-[10.5px] font-medium ${roleInk(role)}`}>
          <Icon size={11} className="shrink-0" aria-hidden />
          <span className="truncate">{t(ROLE_LABEL[role])}</span>
          <span className="ml-auto flex shrink-0 items-center gap-1 font-normal text-[var(--cf-text-faint)]">
            {relation.meeting && <Mic size={10} aria-label={t("notes.relations.meeting")} />}
            <span className="tabular-nums">{relativeTime(relation.when, language)}</span>
          </span>
        </span>
        {/* In full, as the backlinks' titles are: the row is the answer. */}
        <span className="mt-0.5 block break-words text-[12px] leading-snug text-[var(--cf-text)]">{title}</span>
        {why && <span className="mt-0.5 line-clamp-3 block text-[11px] leading-snug text-[var(--cf-text-muted)]">{why}</span>}
        {(relation.resolved.length > 0 || relation.pending.length > 0) && (
          <span className="mt-1 block space-y-0.5">
            {relation.resolved.map((item) => (
              <Outcome key={`r:${item}`} icon={Check} tone="var(--cf-success)" label={t("notes.relations.resolved")} text={item} />
            ))}
            {relation.pending.map((item) => (
              <Outcome key={`p:${item}`} icon={Circle} tone="var(--cf-warning)" label={t("notes.relations.pending")} text={item} />
            ))}
          </span>
        )}
      </button>
      <button
        type="button"
        onClick={() => void useNoteRelationsStore.getState().remove(relation.id)}
        title={t("notes.relations.removeHint")}
        aria-label={t("notes.relations.remove", { title })}
        className="absolute right-1 top-1 grid h-5 w-5 place-items-center rounded text-[var(--cf-text-muted)] opacity-0 outline-none transition-opacity hover:bg-[var(--cf-hover)] hover:text-[var(--cf-danger)] focus-visible:opacity-100 focus-visible:shadow-[0_0_0_2px_var(--cf-accent-line)] group-hover:opacity-100"
      >
        <X size={12} />
      </button>
    </li>
  );
}

/** One thing that was left open: settled since, or still open. */
function Outcome({ icon: Icon, tone, label, text }: { icon: typeof Check; tone: string; label: string; text: string }) {
  return (
    <span className="flex items-start gap-1.5 text-[11px] leading-snug text-[var(--cf-text)]">
      <Icon size={10} strokeWidth={2.5} className="mt-[3px] shrink-0" style={{ color: tone }} aria-label={label} />
      <span className="min-w-0 break-words">{text}</span>
    </span>
  );
}

/** Linking a note by hand: a title search over the notes already on the shelf. */
function LinkPicker({ noteId, linked, onDone }: { noteId: string; linked: NoteRelation[]; onDone: () => void }) {
  const t = useT();
  const notes = useNotesStore((s) => s.notes);
  const [query, setQuery] = useState("");
  const found = useMemo(() => linkCandidates(notes, query, new Set([noteId, ...linked.map((relation) => relation.id)]), 6), [notes, query, noteId, linked]);
  return (
    <div className="shrink-0 px-2 pb-1.5">
      <input
        autoFocus
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") onDone();
          if (event.key === "Enter" && found[0]) {
            void useNoteRelationsStore.getState().add(found[0].id);
            onDone();
          }
        }}
        placeholder={t("notes.relations.addPlaceholder")}
        aria-label={t("notes.relations.add")}
        className={fieldClass({ size: "sm", className: "w-full" })}
      />
      <ul className="mt-1 max-h-[132px] overflow-y-auto">
        {found.map((note) => (
          <li key={note.id}>
            <button
              type="button"
              onClick={() => {
                void useNoteRelationsStore.getState().add(note.id);
                onDone();
              }}
              className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[12px] text-[var(--cf-text)] outline-none hover:bg-[var(--cf-hover)] focus-visible:shadow-[inset_0_0_0_2px_var(--cf-accent-line)]"
            >
              <Link2 size={11} className="shrink-0 text-[var(--cf-text-faint)]" />
              <span className="min-w-0 truncate">{note.title.trim() || t("notes.untitled")}</span>
            </button>
          </li>
        ))}
        {found.length === 0 && <li className="px-1.5 py-1 text-[11px] text-[var(--cf-text-muted)]">{t("notes.relations.addNone")}</li>}
      </ul>
    </div>
  );
}
