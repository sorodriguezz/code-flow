//! The AI side of a meeting: recipes that write minutes, decisions, tasks, a plan… into the note,
//! and questions answered from the transcript.
//!
//! **Which engine.** The «Reuniones» routing row (`AiTask::Meetings`, which inherits the Notes row
//! until somebody sets it) — a CLI with the user's subscription — or, for a meeting filed in a
//! local-only book, the local model of Settings › Local model, whatever the row says. The transcript
//! is text by then; the audio never goes anywhere.
//!
//! **A transcript longer than the model's window** is the local case: a two-hour meeting is some
//! 25 000 tokens and a local model may hold 8 192. It is read in parts first — detailed notes per
//! part, with the minutes and names kept — and the recipe then runs over the notes (`map_reduce`).
//! The CLIs' models read two hours whole.

use serde::Deserialize;

use crate::ai::AiEngine;
use crate::hybrid::local_llm::{self, BackendKind, ChatRequest, Endpoint, LocalError};

/// What every answer is told: be faithful, cite minutes, write Markdown in the reader's language.
const SYSTEM: &str = "Eres quien toma las notas de una reunión. Recibes los datos de la reunión y su \
transcripción automática, línea por línea con su minuto entre corchetes y quién habló. La \
transcripción puede traer palabras mal reconocidas, nombres mal escritos y hablantes sin nombre \
(«Persona 2»); corrige lo evidente por el contexto, pero no inventes: ningún acuerdo, fecha, cifra \
ni responsable que no aparezca. Cuando algo salga de un momento concreto, añade su minuto entre \
corchetes tal como aparece en la transcripción, por ejemplo [12:34]. Responde en Markdown, sin \
envolverlo en un bloque de código y sin repetir la transcripción.";

/// The built-in recipes, by id. The names the user sees are translated in the frontend
/// (`meetings.recipe.<id>`); the instructions are here, one language, and ask for the reader's.
pub fn builtin(id: &str) -> Option<&'static str> {
    Some(match id {
        "summary" => "Escribe el resumen de la reunión bajo el título «## Resumen»: de qué se habló y en qué quedó, en 5 a 10 viñetas breves, de lo más importante a lo menos.",
        "minutes" => "Escribe el acta bajo «## Acta»: una línea con fecha, duración y participantes; luego «### Temas» en el orden en que se trataron (cada tema con lo esencial y su minuto), «### Acuerdos» y «### Próximos pasos».",
        "decisions" => "Lista bajo «## Decisiones» cada decisión tomada: qué se decidió, quién la propuso o la aprobó, el motivo si se dijo, y su minuto. Si no se decidió nada, dilo en una línea.",
        "tasks" => "Lista bajo «## Tareas» los compromisos como checklist de Markdown, una tarea por línea: «- [ ] qué — responsable — fecha [minuto]». Responsable es quien se comprometió o a quien se le asignó; si no queda claro, escribe «sin responsable». La fecha solo si se dijo; si no, omítela. No inventes tareas que nadie asumió.",
        "plan" => "Arma bajo «## Planificación» el plan que sale de la reunión: una tabla Markdown con columnas Hito | Responsable | Fecha o plazo | Minuto, en orden cronológico. Lo que no tenga fecha va al final con «Sin fecha». Debajo, en dos o tres viñetas, las dependencias o riesgos del plan que se mencionaron.",
        "agenda" => "Propón bajo «## Próxima reunión» la agenda de la siguiente: los pendientes, las preguntas abiertas y los temas que quedaron por revisar, ordenados por prioridad, cada uno con una duración sugerida y quién debería traerlo.",
        "risks" => "Lista bajo «## Riesgos y preguntas abiertas» los riesgos, dudas, bloqueos y desacuerdos que se mencionaron, con quién los planteó, su minuto, y si quedó algo acordado al respecto.",
        "followup" => "Redacta bajo «## Correo de seguimiento» un correo para los participantes: saludo breve, resumen en tres líneas, acuerdos, tareas con responsable y fecha, y cierre. Tono profesional y cordial. Solo el texto del correo, listo para copiar.",
        _ => return None,
    })
}

/// How a question about the meeting is asked.
const QUESTION: &str = "Responde la pregunta de abajo usando solo lo que dice la transcripción. Si la \
respuesta no está en ella, dilo en una línea. Cita los minutos de donde sale la respuesta.";

/// What the engine is told about the meeting, above the transcript.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Facts {
    pub title: String,
    pub date: String,
    pub duration: String,
    pub participants: Vec<String>,
    /// The reader's language, as a name the model understands ("español", "English").
    pub language: String,
}

pub fn context(facts: &Facts, transcript: &str) -> String {
    format!(
        "REUNIÓN: {}\nFECHA: {}\nDURACIÓN: {}\nPARTICIPANTES: {}\n\n=== TRANSCRIPCIÓN ===\n{}",
        facts.title.trim(),
        facts.date.trim(),
        facts.duration.trim(),
        facts.participants.join(", "),
        transcript
    )
}

fn ask_for(instruction: &str, facts: &Facts, question: bool) -> String {
    let language = if facts.language.trim().is_empty() { "el idioma de la reunión" } else { facts.language.trim() };
    if question {
        format!("{QUESTION}\nEscribe en {language}.\n\nPREGUNTA: {}", instruction.trim())
    } else {
        format!("{}\nEscribe en {language}.", instruction.trim())
    }
}

/// Where an answer is written.
pub enum Runner<'a> {
    Cli { engine: &'a dyn AiEngine, binary: &'a str, model: &'a str },
    Local { endpoint: Endpoint, model: String, ctx: u32, label: &'static str },
}

impl Runner<'_> {
    /// Characters of transcript one call may carry. A CLI's models read hours; a local model's
    /// window is the limit — about 3.2 characters a token for Spanish, with room for the answer.
    fn budget(&self) -> usize {
        match self {
            Runner::Cli { .. } => 600_000,
            Runner::Local { ctx, .. } => ((*ctx as f32 * 0.55) * 3.2) as usize,
        }
    }

    async fn call(&self, ask: &str, stdin: &str) -> Result<String, String> {
        match self {
            Runner::Cli { engine, binary, model } => crate::ai::meeting_answer(*engine, binary, model, SYSTEM, ask, stdin).await,
            Runner::Local { endpoint, model, ctx, label } => {
                let user = format!("{ask}\n\n{stdin}");
                let request = ChatRequest {
                    model,
                    system: SYSTEM,
                    user: &user,
                    num_ctx: (endpoint.kind == BackendKind::Ollama).then_some(*ctx),
                    max_tokens: 2_048,
                    temperature: 0.2,
                    think: None,
                    keep_alive: (endpoint.kind == BackendKind::Ollama).then_some("5m"),
                    schema: None,
                };
                let mut stop = None;
                if let Some(scope) = crate::ai_runs::current() {
                    crate::ai_runs::emit_engine(&scope, "local", label, model, None);
                    stop = crate::ai_runs::subscribe(&scope.run_id);
                }
                let outcome = local_llm::chat(endpoint, &request, |_| {}, crate::ai_runs::cancelled(&mut stop)).await;
                match outcome {
                    Ok(outcome) => {
                        let usage = crate::ai::AiUsage {
                            input_tokens: outcome.prompt_tokens.unwrap_or(0) as i64,
                            output_tokens: outcome.completion_tokens.unwrap_or(0) as i64,
                            ..Default::default()
                        };
                        crate::ai_usage::record("local", model, crate::ai::task::MEETINGS, None, &usage);
                        Ok(outcome.text.trim().to_string())
                    }
                    Err(LocalError::Cancelled) => Err(crate::ai_runs::CANCELLED_MARKER.to_string()),
                    Err(error) => Err(error.sentence()),
                }
            }
        }
    }
}

/// A recipe (`instruction`) or a question (`question = true`) over the transcript.
pub async fn answer(runner: &Runner<'_>, facts: &Facts, transcript: &str, instruction: &str, question: bool) -> Result<String, String> {
    let ask = ask_for(instruction, facts, question);
    let budget = runner.budget();
    if transcript.len() <= budget {
        return runner.call(&ask, &context(facts, transcript)).await;
    }
    let notes = map_reduce(runner, facts, transcript, budget).await?;
    runner.call(&ask, &context(facts, &format!("(Notas detalladas de la reunión, tomadas por partes)\n{notes}"))).await
}

/// Notes of a transcript too long for one call: detailed notes per part, then the notes condensed
/// again while they are still too long.
async fn map_reduce(runner: &Runner<'_>, facts: &Facts, transcript: &str, budget: usize) -> Result<String, String> {
    const MAP: &str = "Toma notas detalladas de este fragmento de la reunión, sin resumir de más: temas, \
        decisiones, tareas con su responsable, fechas, cifras, preguntas y desacuerdos. Conserva el \
        minuto entre corchetes de cada cosa y los nombres tal como aparecen. Viñetas Markdown.";
    let mut text = transcript.to_string();
    for _ in 0..4 {
        if text.len() <= budget {
            return Ok(text);
        }
        let parts = split_lines(&text, budget);
        let mut notes = Vec::with_capacity(parts.len());
        for (index, part) in parts.iter().enumerate() {
            let ask = format!("{MAP}\nParte {} de {}.", index + 1, parts.len());
            notes.push(runner.call(&ask, &context(facts, part)).await?);
        }
        text = notes.join("\n\n");
    }
    Ok(text.chars().take(budget).collect())
}

/// `text` cut at line ends into parts no longer than `budget` bytes (a line longer than that is a
/// part of its own, cut).
pub fn split_lines(text: &str, budget: usize) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    for line in text.lines() {
        if !current.is_empty() && current.len() + line.len() + 1 > budget {
            parts.push(std::mem::take(&mut current));
        }
        if line.len() > budget {
            parts.push(line.chars().take(budget).collect());
            continue;
        }
        current.push_str(line);
        current.push('\n');
    }
    if !current.trim().is_empty() {
        parts.push(current);
    }
    parts
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_builtin_recipe_has_instructions() {
        for id in ["summary", "minutes", "decisions", "tasks", "plan", "agenda", "risks", "followup"] {
            assert!(builtin(id).is_some_and(|text| text.len() > 40), "{id}");
        }
        assert!(builtin("nope").is_none());
    }

    #[test]
    fn long_transcripts_split_at_line_ends() {
        let text = "[00:01] A: uno\n[00:02] B: dos\n[00:03] A: tres\n";
        let parts = split_lines(text, 30);
        assert_eq!(parts.len(), 2);
        assert!(parts.iter().all(|p| p.len() <= 30));
        assert_eq!(parts.concat(), text);
    }

    #[test]
    fn the_context_names_the_meeting_and_its_people() {
        let facts = Facts { title: "Arquitectura".into(), date: "9 oct".into(), duration: "47 min".into(), participants: vec!["Tú".into(), "María".into()], language: "español".into() };
        let text = context(&facts, "[00:01] Tú: hola\n");
        assert!(text.contains("PARTICIPANTES: Tú, María"));
        assert!(text.ends_with("[00:01] Tú: hola\n"));
        assert!(ask_for("¿qué se decidió?", &facts, true).contains("PREGUNTA: ¿qué se decidió?"));
    }
}
