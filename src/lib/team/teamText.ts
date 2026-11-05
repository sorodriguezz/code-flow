/**
 * What a team member wrote, made readable: the lead's ```equipo block is JSON for the engine, so a
 * person sees the plan it describes instead — the message, the tasks and who does them.
 */

interface PlanItem {
  id?: string;
  miembro?: string;
  titulo?: string;
  tarea?: string;
  tipo?: string;
  depende_de?: string[];
}

interface Plan {
  mensaje?: string;
  items?: PlanItem[];
  preguntas?: { pregunta?: string; opciones?: string[] }[];
  cancelar?: string[];
  chico?: boolean;
  terminar?: boolean;
}

function planText(plan: Plan): string {
  const out: string[] = [];
  if (plan.mensaje) out.push(plan.mensaje.trim());
  const items = plan.items ?? [];
  if (items.length > 0) {
    out.push(items.length === 1 ? "**Tarea asignada**" : `**${items.length} tareas asignadas**`);
    out.push(
      items
        .map((item, n) => {
          const after = item.depende_de?.length ? ` _(después de ${item.depende_de.join(", ")})_` : "";
          const kind = item.tipo && item.tipo !== "trabajo" ? ` · ${item.tipo}` : "";
          const head = `${n + 1}. **${item.miembro ?? "?"}**${kind} — ${item.titulo ?? item.id ?? ""}${after}`;
          return item.tarea ? `${head}\n   ${item.tarea.trim().replace(/\n+/g, " ")}` : head;
        })
        .join("\n"),
    );
  }
  for (const q of plan.preguntas ?? []) if (q.pregunta) out.push(`**Pregunta:** ${q.pregunta}${q.opciones?.length ? ` (${q.opciones.join(" / ")})` : ""}`);
  if (plan.cancelar?.length) out.push(`**Cancela:** ${plan.cancelar.join(", ")}`);
  const flags = [plan.chico ? "tarea chica" : "", plan.terminar ? "da el trabajo por terminado" : ""].filter(Boolean);
  if (flags.length) out.push(`_${flags.join(" · ")}_`);
  return out.join("\n\n");
}

/** `text` with every ```equipo block turned into the plan it describes; anything unparsable stays. */
export function readableTeamText(text: string): string {
  return text.replace(/```equipo\s*\n([\s\S]*?)```/g, (whole, body: string) => {
    try {
      return planText(JSON.parse(body.trim()) as Plan);
    } catch {
      return whole;
    }
  });
}
