import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Download, ShieldAlert, Upload } from "lucide-react";
import { ApiModal, GhostButton, PrimaryButton } from "./ApiModal";
import { Note, Tag, relativeTime } from "./settingsChrome";
import { EmptyState } from "../common/EmptyState";
import { MethodBadge } from "./CollectionTree";
import { useCollabStore } from "../../state/collabStore";
import { useApiStore } from "../../state/apiStore";
import { useT } from "../../state/languageStore";
import type { SyncConflict } from "../../lib/tauri/apiCommands";
import type { ApiProtocol } from "../../types/api";

/**
 * The records a three-way merge refused to decide, and the decision for each.
 *
 * Two rules shape this screen. **Nothing has happened yet** — a frozen record is neither applied nor
 * pushed, so both versions are still intact and the choice is genuinely open; the copy has to say
 * that, because a conflict dialog that has already picked a winner is just an apology. And **the
 * choice is per record**: a collection where one request is contested keeps syncing everything else,
 * so resolving is a small, ordinary act rather than a crisis to be cleared before work resumes.
 */
export function ConflictModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const conflicts = useCollabStore((s) => s.conflicts);
  const resolve = useCollabStore((s) => s.resolve);
  const [busy, setBusy] = useState(false);

  const byCollection = useMemo(() => {
    const map = new Map<string, SyncConflict[]>();
    for (const conflict of conflicts) {
      const list = map.get(conflict.collection_id);
      if (list) list.push(conflict);
      else map.set(conflict.collection_id, [conflict]);
    }
    return [...map.values()];
  }, [conflicts]);

  const resolveAll = async (keep: "mine" | "theirs") => {
    setBusy(true);
    try {
      // Sequential on purpose: each resolution writes rows the next one reads back, and the whole
      // point of this screen is that nothing gets clobbered by something else running at once.
      for (const conflict of conflicts) await resolve(conflict, keep);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ApiModal
      icon={ShieldAlert}
      title={t("api.conflict.title")}
      subtitle={
        conflicts.length > 0 ? t("api.conflict.subtitle", { n: String(conflicts.length) }) : undefined
      }
      width="max-w-2xl"
      busy={busy}
      onClose={onClose}
      footer={
        conflicts.length > 1 ? (
          <>
            <span className="mr-auto text-[11px] text-[var(--cf-text-muted)]">
              {t("api.conflict.bulkHint")}
            </span>
            <GhostButton onClick={() => void resolveAll("theirs")} disabled={busy}>
              <Download size={12} />
              {t("api.conflict.allTheirs")}
            </GhostButton>
            <PrimaryButton onClick={() => void resolveAll("mine")} disabled={busy}>
              <Upload size={13} />
              {t("api.conflict.allMine")}
            </PrimaryButton>
          </>
        ) : undefined
      }
    >
      {conflicts.length === 0 ? (
        <div className="h-[220px]">
          <EmptyState icon={ShieldAlert} title={t("api.conflict.none")} subtitle={t("api.conflict.noneHint")} />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
          <Note>{t("api.conflict.about")}</Note>
          {byCollection.map((group) => (
            <section key={group[0].collection_id} className="mb-3 last:mb-0">
              <h3 className="mb-1 truncate text-[11px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
                {group[0].collection_name || t("api.untitledCollection")}
              </h3>
              <div className="flex flex-col gap-1.5">
                {group.map((conflict) => (
                  <ConflictCard
                    key={`${conflict.kind}:${conflict.id}`}
                    conflict={conflict}
                    disabled={busy}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </ApiModal>
  );
}

// ---------------------------------------------------------------------------

/** The fields worth putting side by side. Everything else is behind "show the whole record". */
interface Summary {
  name: string;
  protocol?: ApiProtocol;
  method?: string;
  url?: string;
}

function summarise(json: string): Summary | null {
  if (json === "{}" || json === "") return null;
  try {
    const value = JSON.parse(json) as Record<string, unknown>;
    return {
      name: typeof value.name === "string" ? value.name : "",
      protocol: typeof value.protocol === "string" ? (value.protocol as ApiProtocol) : undefined,
      method: typeof value.method === "string" ? value.method : undefined,
      url: typeof value.url === "string" ? value.url : undefined,
    };
  } catch {
    return null;
  }
}

function Side({
  title,
  when,
  summary,
  deleted,
  tone,
}: {
  title: string;
  when: string;
  summary: Summary | null;
  deleted: boolean;
  tone: "mine" | "theirs";
}) {
  const t = useT();
  const ago = relativeTime(when, {
    now: t("api.collab.justNow"),
    minutes: t("api.collab.minutesAgo"),
    hours: t("api.collab.hoursAgo"),
    days: t("api.collab.daysAgo"),
  });
  return (
    <div
      className={`min-w-0 flex-1 rounded-md border px-2 py-1.5 ${
        tone === "mine"
          ? "border-[color-mix(in_oklab,var(--cf-accent)_40%,transparent)]"
          : "border-[var(--cf-border)]"
      }`}
    >
      <div className="mb-1 flex items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
          {title}
        </span>
        {ago && <span className="shrink-0 text-[10px] text-[var(--cf-text-muted)]">{ago}</span>}
      </div>
      {deleted || !summary ? (
        <p className="text-[12px] italic text-[var(--cf-warning)]">{t("api.conflict.deletedHere")}</p>
      ) : (
        <>
          <p className="truncate text-[12px] text-[var(--cf-text)]">{summary.name}</p>
          {summary.url !== undefined && (
            <div className="mt-0.5 flex items-center gap-1.5">
              <MethodBadge protocol={summary.protocol ?? "http"} method={summary.method ?? "GET"} />
              <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-[var(--cf-text-muted)]">
                {summary.url || "—"}
              </span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ConflictCard({ conflict, disabled }: { conflict: SyncConflict; disabled: boolean }) {
  const t = useT();
  const resolve = useCollabStore((s) => s.resolve);
  const openRequest = useApiStore((s) => s.openRequest);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const mine = summarise(conflict.local_payload);
  const theirs = summarise(conflict.remote_payload);

  const pick = async (keep: "mine" | "theirs") => {
    setBusy(true);
    try {
      await resolve(conflict, keep);
    } finally {
      setBusy(false);
    }
  };

  const kindLabel =
    conflict.kind === "request"
      ? t("api.conflict.kindRequest")
      : conflict.kind === "folder"
        ? t("api.conflict.kindFolder")
        : t("api.conflict.kindCollection");

  return (
    <div className="rounded-lg border border-[var(--cf-border)] px-2.5 py-2">
      <div className="flex items-center gap-2">
        <ShieldAlert size={13} className="shrink-0 text-[var(--cf-warning)]" />
        <button
          onClick={() => conflict.kind === "request" && !conflict.local_deleted && openRequest(conflict.id)}
          disabled={conflict.kind !== "request" || conflict.local_deleted}
          className="min-w-0 flex-1 truncate text-left text-[13px] font-medium text-[var(--cf-text)] enabled:hover:text-[var(--cf-accent)] disabled:cursor-default"
        >
          {conflict.name || t("api.untitledRequest")}
        </button>
        <Tag>{kindLabel}</Tag>
      </div>

      <div className="mt-1.5 flex gap-1.5">
        <Side
          title={t("api.conflict.mine")}
          when={conflict.local_updated_at}
          summary={mine}
          deleted={conflict.local_deleted}
          tone="mine"
        />
        <Side
          title={t("api.conflict.theirs")}
          when={conflict.remote_updated_at}
          summary={theirs}
          deleted={conflict.remote_deleted}
          tone="theirs"
        />
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <PrimaryButton onClick={() => void pick("mine")} disabled={disabled || busy}>
          <Upload size={13} />
          {t("api.conflict.keepMine")}
        </PrimaryButton>
        <GhostButton onClick={() => void pick("theirs")} disabled={disabled || busy}>
          <Download size={12} />
          {t("api.conflict.takeTheirs")}
        </GhostButton>
        <GhostButton onClick={() => setOpen((value) => !value)}>
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {t("api.conflict.showRaw")}
        </GhostButton>
      </div>

      {open && (
        <div className="mt-1.5 grid grid-cols-2 gap-1.5">
          {[conflict.local_payload, conflict.remote_payload].map((payload, index) => (
            <pre
              key={index}
              className="max-h-[200px] overflow-auto rounded-md bg-black/[0.03] p-2 font-mono text-[10px] leading-snug text-[var(--cf-text-muted)] dark:bg-white/[0.04]"
            >
              {pretty(payload)}
            </pre>
          ))}
        </div>
      )}
    </div>
  );
}

function pretty(json: string): string {
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}
