/**
 * "What links here" — the notes that point at the open one.
 *
 * Wiki links have worked in one direction for a while: writing `[[Retro 12 May]]` resolves to that
 * note and opens it. Standing *in* "Retro 12 May" and asking what refers to it had no answer, which
 * is what makes a note graph a set of one-way streets — the note you wrote the decision in never
 * tells you which meetings acted on it.
 *
 * It sits under the outline rather than in a panel of its own, because they answer the same shape
 * of question about the note you are reading: the outline is what is *inside* it, this is what is
 * *around* it.
 *
 * The lookup runs in Rust: it reads note bodies, and the store deliberately holds none of them (see
 * `notesStore`'s header). Debounced against the title rather than against keystrokes — the title is
 * what the query is made of, and it changes rarely.
 */

import { useEffect, useState } from "react";
import { Link2 } from "lucide-react";
import { notesBacklinks } from "../../lib/tauri/notesCommands";
import { useNotesStore } from "../../state/notesStore";
import { useT } from "../../state/languageStore";
import { Skeleton } from "../common/Skeleton";
import type { NoteSearchHit } from "../../types/notes";

export function NoteBacklinks({ noteId, title }: { noteId: string; title: string }) {
  const t = useT();
  const workspaceId = useNotesStore((s) => s.workspaceId);
  const notes = useNotesStore((s) => s.notes);
  const openNote = useNotesStore((s) => s.openNote);

  const [hits, setHits] = useState<NoteSearchHit[] | null>(null);

  useEffect(() => {
    if (!workspaceId || !title.trim()) {
      setHits([]);
      return;
    }
    let cancelled = false;
    // A short debounce, because the title changes as it is typed: without it, renaming a note runs
    // one body scan per keystroke over the whole workspace.
    const timer = setTimeout(() => {
      void notesBacklinks(workspaceId, title, noteId)
        .then((rows) => {
          if (!cancelled) setHits(rows);
        })
        .catch(() => {
          // A failed lookup shows as "nothing links here" rather than an error: this is a side
          // panel, and a red box in it for a query nobody asked to run is noise.
          if (!cancelled) setHits([]);
        });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [workspaceId, title, noteId]);

  const titleOf = (id: string) => notes.find((note) => note.id === id)?.title ?? t("notes.untitled");

  return (
    <div className="flex min-h-0 flex-col border-t border-[var(--cf-border)]">
      <p className="flex shrink-0 items-center gap-1.5 px-3 py-2 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
        <Link2 size={11} className="shrink-0" />
        {t("notes.backlinks")}
        {hits && hits.length > 0 && <span className="tabular-nums opacity-70">{hits.length}</span>}
      </p>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {hits === null ? (
          <div className="space-y-1 px-1" aria-hidden>
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : hits.length === 0 ? (
          <p className="px-1 text-[11px] leading-snug text-[var(--cf-text-muted)]">
            {t("notes.backlinksEmpty")}
          </p>
        ) : (
          <ul className="space-y-0.5">
            {hits.map((hit) => (
              <li key={hit.id}>
                <button
                  type="button"
                  onClick={() => void openNote(hit.id)}
                  className="w-full rounded-md px-2 py-1.5 text-left transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
                >
                  {/* The linking note's title, in full — this list is short and its rows are the
                      answer, so truncating one would hide the thing the panel exists to show. */}
                  <span className="block break-words text-[12px] leading-snug text-[var(--cf-text)]">
                    {titleOf(hit.id)}
                  </span>
                  {/* The sentence the link sits in. Two lines is enough context to know whether
                      this is the reference you were looking for. */}
                  <span className="mt-0.5 line-clamp-2 block text-[11px] leading-snug text-[var(--cf-text-muted)]">
                    {hit.snippet}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
