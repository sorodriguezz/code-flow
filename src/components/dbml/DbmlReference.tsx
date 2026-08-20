import { useEffect } from "react";
import { X } from "lucide-react";
import { CopyButton } from "./CopyButton";
import { ICON_BUTTON } from "../diagrams/diagramsChrome";
import { useT } from "../../state/languageStore";
import type { TranslationKey } from "../../lib/i18n/translations";

/**
 * The DBML cheat sheet, one keypress from the editor.
 *
 * A schema is written in a language most people use a few times a year, and the failure mode is
 * never "I don't know what a table is" — it is forgetting whether the arrow in a `Ref` points at the
 * many side or the one side, and whether a default goes in quotes or backticks. Both are one line to
 * look up and neither is worth leaving the app for.
 *
 * The samples are **not translated**: they are DBML, and DBML is the same in every language. Only
 * the headings above them are, so the panel can be scanned in the reader's own language and copied
 * from in the parser's.
 */

interface Entry {
  label: TranslationKey;
  code: string;
}

const ENTRIES: Entry[] = [
  {
    label: "dbml.ref.table",
    code: `Table users {
  id integer [pk, increment]
  email varchar(120) [not null, unique]
}

// A schema, and a shorter name to refer to it by
Table shop.orders as O {
  id integer [pk]
}`,
  },
  {
    label: "dbml.ref.settings",
    code: `id     integer  [pk, increment]
email  varchar  [not null, unique]
role   varchar  [default: 'user']     // text
count  integer  [default: 0]          // number
made   timestamp [default: \`now()\`]   // expression
state  boolean  [default: null, note: 'why']`,
  },
  {
    label: "dbml.ref.relations",
    code: `// Inline, on the column that holds the key
Table posts {
  author_id integer [ref: > users.id]
}

// Or on its own. The < opens towards the many side
Ref: users.id < posts.author_id   // one to many
Ref: posts.id - post_meta.post_id // one to one
Ref: posts.id <> tags.id          // many to many

// Composite, and what happens on delete
Ref: orders.(a, b) > lines.(a, b) [delete: cascade]`,
  },
  {
    label: "dbml.ref.enum",
    code: `Enum post_status {
  draft
  published [note: 'visible to everyone']
  archived
}

Table posts {
  status post_status [not null]
}`,
  },
  {
    label: "dbml.ref.indexes",
    code: `Table posts {
  id integer [pk]
  slug varchar
  author_id integer

  indexes {
    slug [unique]
    (author_id, slug) [name: 'by_author']
    slug [type: hash]
  }
}`,
  },
  {
    label: "dbml.ref.notes",
    code: `Table users {
  Note: 'Everyone who can sign in'
  id integer [pk, note: 'never reused']
}

TableGroup billing {
  invoices
  payments
}`,
  },
];

export function DbmlReference({ onClose }: { onClose: () => void }) {
  const t = useT();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      {/* A press anywhere else closes it. Transparent rather than a scrim: this is a reference held
          up beside the work, not a dialog that owns the window. */}
      <div className="fixed inset-0 z-30" onMouseDown={onClose} />
      <aside className="absolute right-2 top-[38px] z-40 flex max-h-[calc(100%-52px)] w-[360px] flex-col overflow-hidden rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] shadow-[var(--cf-shadow)]">
        <header className="flex shrink-0 items-center gap-1 border-b border-[var(--cf-border)] px-2.5 py-[7px]">
          <span className="min-w-0 flex-1 truncate text-[9.5px] font-semibold uppercase tracking-[0.09em] text-[var(--cf-text-muted)]">
            {t("dbml.reference")}
          </span>
          <button
            type="button"
            className={ICON_BUTTON}
            title={t("dbml.ref.close")}
            aria-label={t("dbml.ref.close")}
            onClick={onClose}
          >
            <X size={12} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-auto px-2.5 py-2">
          <p className="mb-2 text-[10.5px] leading-snug text-[var(--cf-text-muted)]">
            {t("dbml.ref.intro")}
          </p>
          {ENTRIES.map((entry) => (
            <section key={entry.label} className="group/example mb-2.5 last:mb-1">
              <h3 className="mb-1 text-[9px] font-semibold uppercase tracking-[0.09em] text-[var(--cf-accent)]">
                {t(entry.label)}
              </h3>
              {/* The point of a reference is to be taken from, so every block is one click from
                  the clipboard. Dimmed rather than hidden until hover: a control nobody can see is
                  a control nobody uses, and this one exists because it was asked for by name. */}
              <div className="relative">
                <pre className="overflow-x-auto rounded-md border border-[var(--cf-border)] bg-[var(--cf-field)] py-1.5 pl-2 pr-8 font-mono text-[10.5px] leading-[1.5] text-[var(--cf-text-muted)]">
                  {entry.code}
                </pre>
                <div className="absolute right-1 top-1 opacity-55 transition-opacity focus-within:opacity-100 group-hover/example:opacity-100">
                  <CopyButton
                    text={entry.code}
                    compact
                    className="flex items-center rounded border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-[3px] text-[var(--cf-text-muted)] transition-colors hover:text-[var(--cf-accent)]"
                  />
                </div>
              </div>
            </section>
          ))}
        </div>
      </aside>
    </>
  );
}
