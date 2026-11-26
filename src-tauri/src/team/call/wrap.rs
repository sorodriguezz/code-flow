//! How a call ends: what was agreed, written down once by the lead, and the task the team is
//! handed to carry it out.

use serde::{Deserialize, Serialize};

use super::route::Seat;
use super::Line;

/// A call's minutes.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct WrapUp {
    /// A few words for the task this becomes.
    pub title: String,
    pub summary: String,
    pub decisions: Vec<String>,
    /// What somebody is to do: only this makes a call end in work.
    pub tasks: Vec<Task>,
    /// Asked and left unanswered.
    pub open: Vec<String>,
    /// What the lead says aloud to close: one sentence.
    pub closing: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Task {
    pub title: String,
    pub detail: String,
    /// The member's id; empty when nobody was named — the lead assigns it.
    pub member: String,
    /// Its name, for the screen.
    pub member_name: String,
}

/// What the lead is told to write the minutes.
pub fn system(roster: &str, lang: &str) -> String {
    if lang == "es" {
        format!(
            "Lideras un equipo de ingeniería y acaba de terminar una llamada de voz con la persona que lo dirige. Recibes la conversación por la entrada estándar. \
             Escribe el acta: solo lo que se dijo, sin inventar acuerdos ni tareas. Incluye en «tasks» los compromisos que siguen pendientes, y en el resumen lo que se completó durante la llamada. Una idea que se comentó y no se acordó va en «open».\n\n\
             Responde únicamente con un objeto JSON, sin texto antes ni después:\n\
             {{\"title\": \"de tres a siete palabras para el encargo\", \"summary\": \"dos o tres frases\", \"decisions\": [\"…\"], \
             \"tasks\": [{{\"title\": \"qué hay que hacer\", \"detail\": \"lo acordado sobre cómo, en una o dos frases\", \"member\": \"id del miembro responsable, o vacío\"}}], \
             \"open\": [\"lo que quedó sin decidir\"], \"closing\": \"una frase, dicha en voz alta, que resume lo que el equipo va a hacer ahora\"}}\n\n\
             Los ids válidos de «member» son los de esta lista; si no se nombró a nadie, déjalo vacío:\n{roster}"
        )
    } else {
        format!(
            "You lead an engineering team and a voice call with the person who runs it has just ended. The conversation comes on standard input. \
             Write the minutes: only what was said, with no invented agreements or tasks. Put agreed work that is still pending in “tasks” and work completed during the call in the summary. An idea that was mentioned and not agreed goes under “open”.\n\n\
             Answer with a JSON object alone, no text before or after:\n\
             {{\"title\": \"three to seven words for the job\", \"summary\": \"two or three sentences\", \"decisions\": [\"…\"], \
             \"tasks\": [{{\"title\": \"what is to be done\", \"detail\": \"what was agreed about how, in one or two sentences\", \"member\": \"id of the member responsible, or empty\"}}], \
             \"open\": [\"what was left undecided\"], \"closing\": \"one sentence, said aloud, that sums up what the team does now\"}}\n\n\
             The valid ids for “member” are the ones in this list; if nobody was named, leave it empty:\n{roster}"
        )
    }
}

/// The minutes out of what the model wrote: the object between the first `{` and the last `}`,
/// with every member checked against `seats` — by id, else by name — and anything empty dropped.
pub fn parse(written: &str, seats: &[Seat<'_>]) -> Result<WrapUp, String> {
    let (Some(open), Some(close)) = (written.find('{'), written.rfind('}')) else {
        return Err("the minutes came without an object".into());
    };
    if close < open {
        return Err("the minutes came without an object".into());
    }
    let mut wrap: WrapUp = serde_json::from_str(&written[open..=close]).map_err(|e| format!("the minutes could not be read: {e}"))?;
    let clean = |list: &mut Vec<String>| {
        *list = list.iter().map(|item| item.trim().to_string()).filter(|item| !item.is_empty()).collect();
    };
    clean(&mut wrap.decisions);
    clean(&mut wrap.open);
    wrap.title = wrap.title.trim().chars().take(80).collect();
    wrap.summary = wrap.summary.trim().to_string();
    wrap.closing = wrap.closing.trim().to_string();
    let normal = crate::codi::router::normalize;
    wrap.tasks = wrap
        .tasks
        .into_iter()
        .filter(|task| !task.title.trim().is_empty())
        .map(|mut task| {
            let named = task.member.trim().to_string();
            let seat = seats.iter().find(|seat| seat.id == named).or_else(|| seats.iter().find(|seat| !named.is_empty() && normal(seat.name) == normal(&named)));
            task.member = seat.map(|seat| seat.id.to_string()).unwrap_or_default();
            task.member_name = seat.map(|seat| seat.name.to_string()).unwrap_or_default();
            task.title = task.title.trim().to_string();
            task.detail = task.detail.trim().to_string();
            task
        })
        .collect();
    Ok(wrap)
}

/// The minutes as they are kept in the team's conversation.
pub fn markdown(wrap: &WrapUp, lang: &str) -> String {
    let es = lang == "es";
    let mut out = format!("## {}\n\n{}", if es { "Acta de la llamada" } else { "Call minutes" }, wrap.summary);
    let mut section = |title: &str, rows: Vec<String>| {
        if !rows.is_empty() {
            out.push_str(&format!("\n\n**{title}**\n\n{}", rows.join("\n")));
        }
    };
    section(if es { "Acuerdos" } else { "Agreed" }, wrap.decisions.iter().map(|d| format!("- {d}")).collect());
    section(if es { "Tareas" } else { "Tasks" }, wrap.tasks.iter().map(task_row).collect());
    section(if es { "Pendiente" } else { "Open" }, wrap.open.iter().map(|o| format!("- {o}")).collect());
    out
}

fn task_row(task: &Task) -> String {
    let who = if task.member_name.is_empty() { String::new() } else { format!("**{}** — ", task.member_name) };
    let detail = if task.detail.is_empty() { String::new() } else { format!(": {}", task.detail) };
    format!("- {who}{}{detail}", task.title)
}

/// The task the team is given when the call ends: what was agreed and who does what, with the end
/// of the conversation so the lead plans from what was actually said.
pub fn goal(wrap: &WrapUp, lines: &[Line], lang: &str) -> String {
    let es = lang == "es";
    let mut out = String::new();
    if !wrap.summary.is_empty() {
        out.push_str(&wrap.summary);
        out.push_str("\n\n");
    }
    out.push_str(if es {
        "Este encargo sale de una llamada con el equipo. Planifícalo a partir de lo acordado: respeta quién quedó a cargo de qué y no agregues trabajo que no se acordó."
    } else {
        "This job comes out of a call with the team. Plan it from what was agreed: keep who took what and add no work that was not agreed."
    });
    let mut section = |title: &str, rows: Vec<String>| {
        if !rows.is_empty() {
            out.push_str(&format!("\n\n## {title}\n{}", rows.join("\n")));
        }
    };
    section(if es { "Acordado en la llamada" } else { "Agreed in the call" }, wrap.decisions.iter().map(|d| format!("- {d}")).collect());
    section(if es { "Tareas y responsables" } else { "Tasks and owners" }, wrap.tasks.iter().map(|t| task_row(t).replace("**", "")).collect());
    section(if es { "Quedó sin decidir" } else { "Left undecided" }, wrap.open.iter().map(|o| format!("- {o}")).collect());
    out.push_str(&format!("\n\n## {}\n{}", if es { "Conversación" } else { "Conversation" }, super::line::talk(lines, lang)));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seats() -> Vec<Seat<'static>> {
        vec![Seat { id: "lead", name: "Arquitecto", role: "", lead: true }, Seat { id: "dba", name: "DBA", role: "", lead: false }]
    }

    #[test]
    fn the_minutes_are_read_out_of_whatever_surrounds_them() {
        let written = "Aquí va:\n```json\n{\"title\": \"Outbox para citas\", \"summary\": \"Se acordó el outbox.\", \"decisions\": [\"Usar outbox\", \" \"], \
            \"tasks\": [{\"title\": \"Crear la tabla outbox\", \"detail\": \"Con índice por estado\", \"member\": \"dba\"}, \
            {\"title\": \"Escribir el ADR\", \"member\": \"arquitecto\"}, {\"title\": \"  \", \"member\": \"dba\"}, {\"title\": \"Probar\", \"member\": \"nadie\"}], \
            \"open\": [], \"closing\": \"Nos ponemos con el outbox.\"}\n```";
        let wrap = parse(written, &seats()).unwrap();
        assert_eq!(wrap.title, "Outbox para citas");
        assert_eq!(wrap.decisions, vec!["Usar outbox"]);
        assert_eq!(wrap.tasks.len(), 3, "the one with no title is not a task");
        assert_eq!((wrap.tasks[0].member.as_str(), wrap.tasks[0].member_name.as_str()), ("dba", "DBA"));
        // Named by name instead of id; and somebody who is not in the team is nobody.
        assert_eq!(wrap.tasks[1].member, "lead");
        assert_eq!(wrap.tasks[2].member, "");
        assert_eq!(wrap.closing, "Nos ponemos con el outbox.");

        assert!(parse("No hubo acuerdos.", &seats()).is_err());
        // A call where nothing was agreed is minutes with no tasks, not an error.
        assert!(parse("{\"summary\": \"Se conversó.\"}", &seats()).unwrap().tasks.is_empty());
    }

    #[test]
    fn the_task_handed_to_the_team_says_who_does_what() {
        let wrap = parse(
            "{\"summary\": \"Se acordó el outbox.\", \"decisions\": [\"Usar outbox\"], \"tasks\": [{\"title\": \"Crear la tabla\", \"detail\": \"Con índice\", \"member\": \"dba\"}], \"open\": [\"El nombre del schema\"]}",
            &seats(),
        )
        .unwrap();
        let line = Line { id: "1".into(), at_ms: 5_000, who: "user".into(), name: String::new(), text: "DBA, crea la tabla outbox".into(), partial: false, kind: "say" };
        let goal = goal(&wrap, &[line], "es");
        assert!(goal.starts_with("Se acordó el outbox."), "{goal}");
        assert!(goal.contains("## Tareas y responsables\n- DBA — Crear la tabla: Con índice"), "{goal}");
        assert!(goal.contains("## Quedó sin decidir\n- El nombre del schema"), "{goal}");
        assert!(goal.contains("[00:05] Usuario: DBA, crea la tabla outbox"), "{goal}");

        let kept = markdown(&wrap, "es");
        assert!(kept.contains("## Acta de la llamada") && kept.contains("- **DBA** — Crear la tabla: Con índice"), "{kept}");
    }
}
