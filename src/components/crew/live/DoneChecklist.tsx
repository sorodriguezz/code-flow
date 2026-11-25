/**
 * «Definición de hecho»: what stands behind an item being done, one row per thing that has to be
 * true — and who says it is.
 *
 * A member reporting «the timeout is 60 s» and the app running `pnpm test` and reading its exit
 * are not the same kind of evidence, and the old list drew them alike. Here each row carries its
 * source: what the agent declared, what CodeFlow checked itself (and on which commit), what a
 * reviewer read, and whether the change is in the repository. The bar on top is the same rows at
 * a glance, so a task with three green and one amber is told apart from four green without
 * opening anything.
 */
import { useState } from "react";
import { AlertTriangle, Check, ChevronRight, Circle, CircleDashed, GitCommitHorizontal, GitMerge, MessageSquareQuote, ShieldCheck, X, type LucideIcon } from "lucide-react";
import type { TeamEvidence, TeamItem, TeamRunState } from "../../../types/team";
import { Label } from "../kit/ui";
import { useL } from "../state";

type RowState = "ok" | "said" | "warn" | "bad" | "todo";

type Group = "criteria" | "checks" | "delivery";

interface Row {
  key: string;
  group: Group;
  state: RowState;
  text: string;
  /** Who vouches for it, in a few words. */
  source: string;
  detail?: string;
  mono?: boolean;
}

const LOOK: Record<RowState, { icon: LucideIcon; color: string }> = {
  ok: { icon: Check, color: "var(--cf-success)" },
  said: { icon: MessageSquareQuote, color: "var(--cf-blue)" },
  warn: { icon: AlertTriangle, color: "var(--cf-warning)" },
  bad: { icon: X, color: "var(--cf-danger)" },
  todo: { icon: Circle, color: "var(--cf-text-faint)" },
};

function useRows(state: TeamRunState, item: TeamItem): Row[] {
  const l = useL();
  const info = item.intelligence;
  const evidence: TeamEvidence[] = info?.evidence ?? [];
  const settled = ["done", "error", "skipped", "cancelled"].includes(item.status);
  const rows: Row[] = [];

  // What the task was asked to make true, and what the member said about each.
  const reports = evidence.filter((e) => e.source !== "check" && ["reported", "unverified"].includes(e.result));
  (info?.criteria ?? []).forEach((criterion, index) => {
    const report = reports.find((e) => e.label === criterion);
    rows.push(
      report?.result === "reported"
        ? { key: `c${index}`, group: "criteria", state: "said", text: criterion, source: l("Lo declara el agente", "Declared by the agent"), detail: report.detail }
        : settled || report
          ? { key: `c${index}`, group: "criteria", state: "warn", text: criterion, source: l("Sin evidencia", "No evidence") }
          : { key: `c${index}`, group: "criteria", state: "todo", text: criterion, source: l("Pendiente", "Pending") },
    );
  });

  // What the app ran itself.
  evidence
    .filter((e) => e.source === "check" || ["passed", "failed", "regression", "preexisting"].includes(e.result))
    .forEach((check, index) => {
      const at = `${check.sandbox ? ` · ${l("aislado en", "isolated in")} ${check.sandbox}` : ""}${check.sha ? ` · ${check.sha.slice(0, 7)}` : ""}`;
      const verdict: [RowState, string] =
        check.result === "passed" ? ["ok", l("Lo comprobó CodeFlow", "Checked by CodeFlow")]
          : check.result === "regression" ? ["bad", l("Falla desde este cambio", "Fails since this change")]
            : check.result === "preexisting" ? ["warn", l("Ya fallaba antes del cambio", "Already failed before the change")]
              : ["bad", l("Falló; sin comparación con la base", "Failed; no baseline comparison")];
      rows.push({ key: `k${index}`, group: "checks", state: verdict[0], text: check.label, source: `${verdict[1]}${at}`, detail: check.detail, mono: true });
    });
  if (info?.phase === "verifying" && !rows.some((row) => row.key.startsWith("k"))) {
    rows.push({ key: "verifying", group: "checks", state: "todo", text: l("Pruebas del repositorio", "Repository tests"), source: l("CodeFlow las está corriendo", "CodeFlow is running them") });
  }

  if (item.kind === "work") {
    // The change itself.
    if (item.commit_sha) {
      rows.push({ key: "commit", group: "delivery", state: "ok", text: l("Cambios guardados", "Changes saved"), source: item.commit_sha.slice(0, 7) });
    } else if (info?.no_change === "already_satisfied" || info?.no_change === "no_changes_required") {
      rows.push({
        key: "commit", group: "delivery", state: "said",
        text: info.no_change === "already_satisfied" ? l("Sin cambios: ya cumplía lo pedido", "No changes: it already met the request") : l("Sin cambios: no hacía falta", "No changes: none were needed"),
        source: l("Lo declara el agente", "Declared by the agent"),
      });
    } else if (info?.no_change === "undeclared") {
      rows.push({ key: "commit", group: "delivery", state: "warn", text: l("No cambió ningún archivo", "It changed no file"), source: l("No dijo por qué", "It did not say why") });
    } else if (info?.no_change === "unable") {
      rows.push({ key: "commit", group: "delivery", state: "bad", text: l("No cambió ningún archivo", "It changed no file"), source: l("Dijo que no pudo", "It said it could not") });
    }

    // A reviewer's read of it, when the team reviews.
    const reviews = state.items.filter((other) => other.kind === "review" && other.ref_item === item.id);
    const review = reviews[reviews.length - 1];
    if (review) {
      const reviewer = review.member_name;
      rows.push(
        review.status === "done"
          ? { key: "review", group: "delivery", state: "ok", text: l("Revisión", "Review"), source: l(`La leyó ${reviewer}`, `Read by ${reviewer}`), detail: review.output_text }
          : review.status === "error" || review.status === "skipped" || review.status === "cancelled"
            ? { key: "review", group: "delivery", state: "warn", text: l("Revisión", "Review"), source: l("No se completó", "Not completed") }
            : { key: "review", group: "delivery", state: "todo", text: l("Revisión", "Review"), source: l(`La tiene ${reviewer}`, `With ${reviewer}`) },
      );
    }

    if (item.commit_sha) {
      rows.push(item.merged
        ? { key: "merged", group: "delivery", state: "ok", text: l("Integrado", "Merged"), source: l("En la rama del equipo", "On the team's branch") }
        : { key: "merged", group: "delivery", state: "todo", text: l("Integrado", "Merged"), source: l("Pendiente", "Pending") });
    }
  }
  return rows;
}

const GROUPS: Group[] = ["criteria", "checks", "delivery"];
const GROUP_LABEL: Record<Group, [string, string]> = {
  criteria: ["Criterios de aceptación", "Acceptance criteria"],
  checks: ["Lo que corrió CodeFlow", "What CodeFlow ran"],
  delivery: ["Entrega", "Delivery"],
};

const SEGMENT: Record<RowState, string> = {
  ok: "var(--cf-success)",
  said: "var(--cf-blue)",
  warn: "var(--cf-warning)",
  bad: "var(--cf-danger)",
  todo: "var(--cf-border-strong)",
};

function RowView({ row }: { row: Row }) {
  const l = useL();
  const [open, setOpen] = useState(false);
  const { icon: Icon, color } = LOOK[row.state];
  const Mark = row.key.startsWith("k") && row.state === "ok" ? ShieldCheck : row.key === "commit" && row.state === "ok" ? GitCommitHorizontal : row.key === "merged" && row.state === "ok" ? GitMerge : row.key === "verifying" ? CircleDashed : Icon;
  const body = (
    <>
      <span className="mt-[1px] grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full" style={{ background: `color-mix(in oklab, ${color} 14%, transparent)`, color }}>
        <Mark className={`h-3 w-3 ${row.key === "verifying" ? "animate-spin [animation-duration:2.4s]" : ""}`} strokeWidth={2.4} />
      </span>
      <span className="min-w-0 flex-1">
        <span className={`block break-words text-[12.5px] leading-snug text-[var(--cf-text)] ${row.mono ? "font-mono text-[11.5px]" : ""}`}>{row.text}</span>
        <span className="block text-[11px] leading-snug" style={{ color: row.state === "todo" ? "var(--cf-text-faint)" : row.state === "ok" || row.state === "said" ? "var(--cf-text-muted)" : color }}>{row.source}</span>
      </span>
      {row.detail && <ChevronRight className={`mt-[3px] h-3.5 w-3.5 shrink-0 text-[var(--cf-text-faint)] transition-transform duration-150 ${open ? "rotate-90" : ""}`} />}
    </>
  );
  return (
    <li className="border-t border-[var(--cf-border)] first:border-t-0">
      {row.detail ? (
        <button type="button" aria-expanded={open} title={open ? l("Oculta el detalle", "Hides the detail") : l("Muestra la evidencia", "Shows the evidence")} onClick={() => setOpen(!open)} className="flex w-full items-start gap-2 px-2.5 py-2 text-left hover:bg-[var(--cf-hover)]">
          {body}
        </button>
      ) : (
        <div className="flex items-start gap-2 px-2.5 py-2">{body}</div>
      )}
      {open && row.detail && (
        <pre className="m-0 max-h-56 select-text overflow-auto whitespace-pre-wrap break-words border-t border-[var(--cf-border)] bg-[var(--cf-sunken)] px-2.5 py-2 font-mono text-[11px] leading-relaxed text-[var(--cf-text-muted)]">{row.detail}</pre>
      )}
    </li>
  );
}

export function DoneChecklist({ state, item }: { state: TeamRunState; item: TeamItem }) {
  const l = useL();
  const rows = useRows(state, item);
  if (rows.length === 0) return null;
  const groups = GROUPS.filter((group) => rows.some((row) => row.group === group)).length;
  const met = rows.filter((row) => row.state === "ok" || row.state === "said").length;
  const verified = rows.filter((row) => row.state === "ok").length;
  const trouble = rows.some((row) => row.state === "bad") ? "bad" : rows.some((row) => row.state === "warn") ? "warn" : null;
  const summary = met === rows.length
    ? verified === rows.length ? l("Todo comprobado", "All checked") : l(`${verified} comprobado · ${met - verified} declarado`, `${verified} checked · ${met - verified} declared`)
    : l(`${met} de ${rows.length}`, `${met} of ${rows.length}`);
  return (
    <section className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label>{l("Definición de hecho", "Definition of done")}</Label>
        <span className="text-[11px] font-medium" style={{ color: trouble === "bad" ? "var(--cf-danger)" : trouble === "warn" ? "var(--cf-warning)" : met === rows.length ? "var(--cf-success)" : "var(--cf-text-muted)" }}>{summary}</span>
      </div>
      <div className="overflow-hidden rounded-[10px] border border-[var(--cf-border)] bg-[var(--cf-surface-raised)]">
        <div className="flex h-[3px] gap-px bg-[var(--cf-surface-raised)]" role="img" aria-label={l(`${met} de ${rows.length} condiciones cumplidas`, `${met} of ${rows.length} conditions met`)}>
          {rows.map((row) => <span key={row.key} className="h-full flex-1" style={{ background: SEGMENT[row.state] }} />)}
        </div>
        {GROUPS.map((group) => {
          const mine = rows.filter((row) => row.group === group);
          if (mine.length === 0) return null;
          const [es, en] = GROUP_LABEL[group];
          return (
            <div key={group} className="border-t border-[var(--cf-border)] first:border-t-0">
              {/* Named only when there is more than one kind of row: a lone group needs no title. */}
              {groups > 1 && <div className="bg-[color-mix(in_oklab,var(--cf-sunken)_55%,transparent)] px-2.5 py-1 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]">{l(es, en)}</div>}
              <ul className="m-0 list-none p-0">
                {mine.map((row) => <RowView key={row.key} row={row} />)}
              </ul>
            </div>
          );
        })}
      </div>
      <p className="m-0 text-[11px] leading-snug text-[var(--cf-text-faint)]">
        {l("Azul es lo que el agente dice; verde, lo que CodeFlow o un revisor comprobó.", "Blue is what the agent says; green is what CodeFlow or a reviewer checked.")}
      </p>
    </section>
  );
}
