//! What a team's members write to the app, and what the app accepts from it.
//!
//! Every member answers in prose, and may add one or more fenced ```` ```equipo ```` blocks of JSON.
//! The prose is the work (the handoff to whoever depends on it); the blocks are the only part the
//! app *acts on*: a lead's plan, a question for the user, a note for another member.
//!
//! Pure on purpose: a lead's plan becomes rows that start engines in real working copies, so every
//! rule about what is accepted is pinned by a test here rather than discovered in a run. Anything that
//! does not validate is dropped with a reason the lead is shown on its next turn — the same bargain
//! `ground_archify_answer` makes: a model never gets to invent an edge.

use serde_json::Value;

/// The fence tag. Spanish like the rest of what the models are told, and distinct enough from
/// ```` ```json ```` that an example in a member's prose is not taken for an instruction.
pub const FENCE: &str = "equipo";

/// The most items one lead turn may add. A plan larger than this is almost always a lead that
/// split the work into steps no one needs, and each one costs a dispatch.
pub const MAX_ITEMS_PER_ROUND: usize = 10;

/// Who a member can address, resolved against the run's roster.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Recipient {
    User,
    Lead,
    All,
    Member(String),
}

/// One note a member left for someone.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Note {
    pub to: Recipient,
    /// `pregunta` waits for an answer; anything else is information.
    pub question: bool,
    pub text: String,
    pub options: Vec<String>,
}

/// One item a lead asked for, already resolved: the member and repository are ids, and `depends_on`
/// names keys (of items in this plan or already in the run).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedItem {
    pub key: String,
    pub member_id: String,
    pub project_id: String,
    /// `work` or `investigate`.
    pub kind: String,
    pub title: String,
    pub instruction: String,
    pub depends_on: Vec<String>,
}

/// What a lead's turn decided.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LeadReply {
    pub message: String,
    pub questions: Vec<Note>,
    pub items: Vec<PlannedItem>,
    pub cancel: Vec<String>,
    pub finish: bool,
    /// The lead judged the request small — one member, one task per repository: what it delivers is
    /// merged without another round of the lead's or the advisor's.
    pub small: bool,
    /// What was dropped, and why — shown to the lead on its next turn.
    pub rejected: Vec<String>,
}

/// The roster as the parser sees it.
#[derive(Debug, Clone)]
pub struct RosterEntry {
    pub id: String,
    pub name: String,
    pub role: String,
    pub edits: bool,
    /// Project ids it may work in; empty is all of the run's.
    pub repos: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct RepoEntry {
    pub project_id: String,
    pub name: String,
}

/// Every ```` ```equipo ```` block in `text`, parsed. A block that is not JSON is skipped — and
/// reported, so a lead whose whole plan failed to parse is told so rather than seeing nothing happen.
pub fn blocks(text: &str) -> (Vec<Value>, Vec<String>) {
    let mut out = Vec::new();
    let mut errors = Vec::new();
    let mut lines = text.lines();
    while let Some(line) = lines.next() {
        let trimmed = line.trim_start();
        let Some(rest) = trimmed.strip_prefix("```") else { continue };
        if !rest.trim().eq_ignore_ascii_case(FENCE) {
            continue;
        }
        let mut body = String::new();
        let mut closed = false;
        for inner in lines.by_ref() {
            if inner.trim_start().starts_with("```") {
                closed = true;
                break;
            }
            body.push_str(inner);
            body.push('\n');
        }
        if !closed {
            errors.push("un bloque ```equipo``` no se cerró".to_string());
            break;
        }
        match serde_json::from_str::<Value>(body.trim()) {
            Ok(Value::Array(values)) => out.extend(values),
            Ok(value) => out.push(value),
            Err(e) => errors.push(format!("un bloque ```equipo``` no es JSON válido: {e}")),
        }
    }
    (out, errors)
}

/// The prose of an answer with its ```` ```equipo ```` blocks taken out — what is handed on.
pub fn prose(text: &str) -> String {
    let mut out = Vec::new();
    let mut skipping = false;
    for line in text.lines() {
        let trimmed = line.trim_start();
        if skipping {
            if trimmed.starts_with("```") {
                skipping = false;
            }
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix("```") {
            if rest.trim().eq_ignore_ascii_case(FENCE) {
                skipping = true;
                continue;
            }
        }
        out.push(line);
    }
    out.join("\n").trim().to_string()
}

fn norm(s: &str) -> String {
    s.trim().to_lowercase()
}

/// A member by id, name or role — the three ways a model names one. A role two members share is
/// ambiguous and resolves to nobody.
pub fn find_member<'a>(roster: &'a [RosterEntry], who: &str) -> Option<&'a RosterEntry> {
    let who = norm(who);
    if who.is_empty() {
        return None;
    }
    if let Some(m) = roster.iter().find(|m| norm(&m.id) == who || norm(&m.name) == who) {
        return Some(m);
    }
    let by_role: Vec<_> = roster.iter().filter(|m| !m.role.trim().is_empty() && norm(&m.role) == who).collect();
    (by_role.len() == 1).then(|| by_role[0])
}

fn recipient(roster: &[RosterEntry], to: &str) -> Option<Recipient> {
    match norm(to).as_str() {
        "usuario" | "user" | "tú" | "tu" => Some(Recipient::User),
        "lider" | "líder" | "lead" => Some(Recipient::Lead),
        "todos" | "all" | "equipo" => Some(Recipient::All),
        _ => find_member(roster, to).map(|m| Recipient::Member(m.id.clone())),
    }
}

fn string_of(value: &Value, keys: &[&str]) -> String {
    for key in keys {
        if let Some(s) = value.get(*key).and_then(Value::as_str) {
            return s.trim().to_string();
        }
    }
    String::new()
}

fn strings_of(value: &Value, keys: &[&str]) -> Vec<String> {
    for key in keys {
        match value.get(*key) {
            Some(Value::Array(items)) => {
                return items.iter().filter_map(Value::as_str).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
            }
            Some(Value::String(s)) if !s.trim().is_empty() => return vec![s.trim().to_string()],
            _ => {}
        }
    }
    Vec::new()
}

fn note_of(roster: &[RosterEntry], value: &Value) -> Result<Option<Note>, String> {
    let text = string_of(value, &["texto", "text", "mensaje", "pregunta"]);
    let to = string_of(value, &["para", "to"]);
    if to.is_empty() {
        return Ok(None);
    }
    if text.is_empty() {
        return Err(format!("una nota para «{to}» no tiene texto"));
    }
    let Some(to_who) = recipient(roster, &to) else {
        return Err(format!("«{to}» no es nadie del equipo"));
    };
    let kind = norm(&string_of(value, &["tipo", "kind"]));
    let question = kind == "pregunta" || kind == "question" || value.get("pregunta").is_some();
    Ok(Some(Note { to: to_who, question, text, options: strings_of(value, &["opciones", "options"]) }))
}

/// The notes in a member's answer: messages to other members, the lead, the team or the user.
pub fn member_notes(text: &str, roster: &[RosterEntry]) -> (Vec<Note>, Vec<String>) {
    let (values, mut errors) = blocks(text);
    let mut notes = Vec::new();
    for value in &values {
        match note_of(roster, value) {
            Ok(Some(note)) => notes.push(note),
            Ok(None) => {}
            Err(e) => errors.push(e),
        }
    }
    (notes, errors)
}

/// Slug for an item key: what the lead wrote, kept short and safe for a branch name.
pub fn key_slug(raw: &str) -> String {
    let mut out = String::new();
    for c in raw.chars().flat_map(char::to_lowercase) {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
        if out.len() >= 24 {
            break;
        }
    }
    out.trim_matches('-').to_string()
}

/// Reads a lead's turn against the roster, the run's repositories and the keys already in the run.
///
/// Rules, each one a reason in `rejected` when broken:
/// - an item names a member of the team, by id, name or an unambiguous role;
/// - its repository is one of the run's (optional when the run has one);
/// - the member may work there, and `work` needs a member that edits;
/// - every dependency is a key in this plan or already in the run;
/// - the new items form no cycle among themselves.
pub fn lead_reply(text: &str, roster: &[RosterEntry], repos: &[RepoEntry], existing_keys: &[String]) -> LeadReply {
    let (values, mut rejected) = blocks(text);
    let mut reply = LeadReply { message: prose(text), ..Default::default() };
    let mut raw_items: Vec<&Value> = Vec::new();
    for value in &values {
        if let Some(items) = value.get("items").and_then(Value::as_array) {
            raw_items.extend(items.iter());
        }
        if let Some(m) = value.get("mensaje").and_then(Value::as_str) {
            if !m.trim().is_empty() {
                reply.message = m.trim().to_string();
            }
        }
        if let Some(qs) = value.get("preguntas").and_then(Value::as_array) {
            for q in qs {
                let text = match q {
                    Value::String(s) => s.trim().to_string(),
                    other => string_of(other, &["pregunta", "texto", "text"]),
                };
                if text.is_empty() {
                    continue;
                }
                reply.questions.push(Note { to: Recipient::User, question: true, text, options: strings_of(q, &["opciones", "options"]) });
            }
        }
        reply.cancel.extend(strings_of(value, &["cancelar", "cancel"]));
        if value.get("terminar").and_then(Value::as_bool).unwrap_or(false) || value.get("finish").and_then(Value::as_bool).unwrap_or(false) {
            reply.finish = true;
        }
        if value.get("chico").and_then(Value::as_bool).unwrap_or(false) || value.get("small").and_then(Value::as_bool).unwrap_or(false) {
            reply.small = true;
        }
    }
    if raw_items.len() > MAX_ITEMS_PER_ROUND {
        rejected.push(format!("pediste {} tareas; el máximo por ronda es {MAX_ITEMS_PER_ROUND}", raw_items.len()));
        raw_items.truncate(MAX_ITEMS_PER_ROUND);
    }

    let mut keys: Vec<String> = existing_keys.to_vec();
    let mut planned: Vec<PlannedItem> = Vec::new();
    for (at, raw) in raw_items.iter().enumerate() {
        let wanted_key = key_slug(&string_of(raw, &["id", "clave", "key"]));
        let mut key = if wanted_key.is_empty() { format!("t{}", at + 1) } else { wanted_key };
        let base = key.clone();
        let mut n = 2;
        while keys.contains(&key) {
            key = format!("{base}-{n}");
            n += 1;
        }
        let who = string_of(raw, &["miembro", "member", "agente", "para"]);
        let Some(member) = find_member(roster, &who) else {
            rejected.push(format!("«{base}»: «{who}» no es un miembro del equipo"));
            continue;
        };
        let repo_name = string_of(raw, &["repo", "repositorio"]);
        let repo = if repo_name.is_empty() {
            if repos.len() == 1 { repos.first() } else { None }
        } else {
            repos.iter().find(|r| norm(&r.name) == norm(&repo_name) || r.project_id == repo_name)
        };
        let Some(repo) = repo else {
            rejected.push(format!(
                "«{base}»: {} — los repositorios de esta tarea son {}",
                if repo_name.is_empty() { "falta el repositorio".to_string() } else { format!("«{repo_name}» no es uno de ellos") },
                repos.iter().map(|r| r.name.as_str()).collect::<Vec<_>>().join(", ")
            ));
            continue;
        };
        if !member.repos.is_empty() && !member.repos.contains(&repo.project_id) {
            rejected.push(format!("«{base}»: {} no trabaja en {}", member.name, repo.name));
            continue;
        }
        let kind = match norm(&string_of(raw, &["tipo", "kind"])).as_str() {
            "investigar" | "investigate" | "leer" | "analizar" => "investigate",
            _ => "work",
        };
        if kind == "work" && !member.edits {
            rejected.push(format!("«{base}»: {} es de solo lectura y no puede recibir trabajo que escribe", member.name));
            continue;
        }
        let instruction = string_of(raw, &["tarea", "instruccion", "instrucción", "task", "instruction"]);
        if instruction.is_empty() {
            rejected.push(format!("«{base}»: no dice qué hay que hacer"));
            continue;
        }
        let title = {
            let t = string_of(raw, &["titulo", "título", "title"]);
            if t.is_empty() { instruction.chars().take(60).collect() } else { t }
        };
        keys.push(key.clone());
        planned.push(PlannedItem {
            key,
            member_id: member.id.clone(),
            project_id: repo.project_id.clone(),
            kind: kind.to_string(),
            title,
            instruction,
            depends_on: strings_of(raw, &["depende_de", "depends_on", "dependencias"]).iter().map(|d| key_slug(d)).collect(),
        });
    }

    // Dependencies: unknown ones are dropped from the item (and reported) rather than dropping the
    // item — a typo in one key should not lose the work.
    let known: Vec<String> = keys.clone();
    for item in &mut planned {
        let mut kept = Vec::new();
        for dep in &item.depends_on {
            if dep == &item.key {
                continue;
            }
            if known.contains(dep) {
                if !kept.contains(dep) {
                    kept.push(dep.clone());
                }
            } else {
                rejected.push(format!("«{}»: la dependencia «{dep}» no existe", item.key));
            }
        }
        item.depends_on = kept;
    }
    // Cycles among the new items: drop the items on one, so what remains always has an order.
    let cyclic = cyclic_keys(&planned);
    if !cyclic.is_empty() {
        rejected.push(format!("estas tareas dependen unas de otras en círculo y se descartaron: {}", cyclic.join(", ")));
        planned.retain(|i| !cyclic.contains(&i.key));
        for item in &mut planned {
            item.depends_on.retain(|d| !cyclic.contains(d));
        }
    }
    reply.items = planned;
    reply.rejected = rejected;
    reply
}

/// Keys that sit on a dependency cycle among `items` (edges to keys outside them are ignored).
fn cyclic_keys(items: &[PlannedItem]) -> Vec<String> {
    use std::collections::HashMap;
    let index: HashMap<&str, &PlannedItem> = items.iter().map(|i| (i.key.as_str(), i)).collect();
    // 0 unseen, 1 on stack, 2 done
    let mut state: HashMap<&str, u8> = HashMap::new();
    let mut on_cycle: Vec<String> = Vec::new();
    fn visit<'a>(
        key: &'a str,
        index: &HashMap<&'a str, &'a PlannedItem>,
        state: &mut HashMap<&'a str, u8>,
        stack: &mut Vec<&'a str>,
        on_cycle: &mut Vec<String>,
    ) {
        state.insert(key, 1);
        stack.push(key);
        if let Some(item) = index.get(key) {
            for dep in &item.depends_on {
                let Some((dep_key, _)) = index.get_key_value(dep.as_str()) else { continue };
                match state.get(dep_key).copied().unwrap_or(0) {
                    0 => visit(dep_key, index, state, stack, on_cycle),
                    1 => {
                        if let Some(pos) = stack.iter().position(|k| k == dep_key) {
                            for k in &stack[pos..] {
                                if !on_cycle.iter().any(|c| c == k) {
                                    on_cycle.push((*k).to_string());
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
        stack.pop();
        state.insert(key, 2);
    }
    for item in items {
        if state.get(item.key.as_str()).copied().unwrap_or(0) == 0 {
            let mut stack = Vec::new();
            visit(item.key.as_str(), &index, &mut state, &mut stack, &mut on_cycle);
        }
    }
    on_cycle
}

/// How a member is told to talk to the team. Appended to every item's message.
pub fn member_protocol(can_ask_user: bool) -> String {
    let ask = if can_ask_user {
        "Si necesitas una decisión del usuario, pregúntale con `\"para\": \"usuario\", \"tipo\": \"pregunta\"` (puedes dar `\"opciones\"`); tu tarea queda en espera hasta que responda y luego sigues. "
    } else {
        "No puedes preguntarle al usuario: decide tú, y deja la decisión y el motivo por escrito en tu respuesta. "
    };
    format!(
        "## Cómo hablar con el equipo\n\
         Tu respuesta en texto es tu entrega: la recibe quien dependa de tu trabajo, así que di qué hiciste, qué quedó pendiente y qué debe saber.\n\
         Para dejarle una nota a alguien añade un bloque:\n\
         ```equipo\n{{\"para\": \"<nombre o rol de un miembro | lider | todos | usuario>\", \"tipo\": \"mensaje\", \"texto\": \"...\"}}\n```\n\
         {ask}\
         Deja notas solo cuando alguien las necesita para trabajar: no saludes, no confirmes que recibiste algo ni pidas acuse. Cada nota puede despertar a otro agente y gasta la cuota del usuario.\n\
         Lo destructivo o irreversible pídelo con `cf ask` antes de hacerlo.\n\n\
         {APPS}",
        APPS = APPS
    )
}

/// The rest of CodeFlow, as tools of its `codeflow` MCP server — told to every member that works,
/// so a test against an API, a failing pipeline or a database check is done with the user's own
/// connections instead of guessed. Which ones a turn has depends on its access (read-only runs get
/// only the readers) and on what the user connected.
pub const APPS: &str = "## Las demás apps de CodeFlow\n\
    Tienes herramientas del servidor MCP `codeflow` para usar el resto de la app con las conexiones del usuario: \
    `pipelines` (corridas, jobs y logs de CI), `containers`/`kubernetes`/`azure` (mirar contenedores y clústeres), \
    `db_connections`/`db_schema`/`db_read`/`db_write` (bases de datos abiertas a la IA), `api_requests` + `http_request` \
    (el cliente de API guardado), `service_logs`/`service_wait`/`service_restart` (los servicios que corre la app), \
    `terminal_output` (otras terminales), `read_note`/`write_note` (Notas) y `search_knowledge`/`recall` (conocimiento y memoria). \
    Úsalas cuando sirvan para verificar tu trabajo; lo que pida aprobación, el usuario lo aprueba en la app.";

/// How a lead is told to answer. Appended to every lead turn.
pub fn lead_protocol(can_ask_user: bool) -> String {
    let ask = if can_ask_user {
        "Si te falta información que solo el usuario tiene, pregunta en vez de suponer: `\"preguntas\": [{\"pregunta\": \"...\", \"opciones\": [\"a\", \"b\"]}]` y no planifiques todavía. "
    } else {
        "No puedes preguntarle al usuario: decide con lo que hay y deja escrito qué supusiste. "
    };
    format!(
        "## Cómo respondes\n\
         Eres el líder: no escribes código, repartes el trabajo. Responde con un texto breve para el equipo y un bloque:\n\
         ```equipo\n\
         {{\"mensaje\": \"lo que el equipo debe saber del plan\",\n \
         \"items\": [{{\"id\": \"api\", \"miembro\": \"<nombre o rol>\", \"repo\": \"<repositorio>\", \"tipo\": \"trabajo | investigar\", \"titulo\": \"...\", \"tarea\": \"qué tiene que hacer, concreto\", \"depende_de\": [\"otro-id\"]}}],\n \
         \"cancelar\": [\"id de una tarea pendiente que ya no hace falta\"],\n \
         \"chico\": false,\n \
         \"terminar\": false}}\n\
         ```\n\
         Reglas: cada tarea es de un miembro y un repositorio. Lo que no dependa de otra cosa corre en paralelo, así que divide para que varios trabajen a la vez sin tocar los mismos archivos. \
         **Planifica lo mínimo.** Cada tarea arranca un agente completo y gasta la cuota del usuario: una tarea sencilla es una tarea por repositorio que de verdad cambia, nada más. \
         No crees tareas de investigar, revisar, coordinar o verificar si la tarea no lo exige, no metas a un miembro solo porque existe, y no partas en pasos lo que una persona haría de una vez. \
         Si dudas entre dos planes, el más corto. Si una entrega trae lo pedido, termina: no abras rondas para pulir. \
         **Clasifica el pedido.** Si es chico —un cambio puntual como un color, un texto, un ajuste de estilo o un bug acotado— dáselo a un solo miembro, una tarea de `trabajo` por repositorio, y marca `\"chico\": true`: \
         la entrega se integra directo, sin otra ronda tuya ni del asesor. Si no es chico, `\"chico\": false`. \
         **Áreas con sub-líder.** Si el equipo tiene sub-líderes (por ejemplo de backend, front o base de datos), lo que es de un área dáselo entero a su sub-líder: él decide quién lo hace. \
         Si un pedido toca varias áreas, una tarea por área a cada sub-líder, con `depende_de` cuando una necesite la entrega de otra. \
         Si es chico, sáltate al sub-líder y asígnalo directo a quien lo ejecuta en esa área: un turno menos. \
         `trabajo` escribe código (en su propia rama); `investigar` solo lee. Un miembro de solo lectura no recibe `trabajo`. \
         Quien depende de otra tarea recibe su entrega. No repitas tareas que ya existen. \
         Cuando todo lo necesario esté hecho y revisado, responde `\"terminar\": true`.\n\
         {ask}"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roster() -> Vec<RosterEntry> {
        vec![
            RosterEntry { id: "m1".into(), name: "Arquitecto".into(), role: "arquitecto".into(), edits: false, repos: vec![] },
            RosterEntry { id: "m2".into(), name: "Dev".into(), role: "dev".into(), edits: true, repos: vec![] },
            RosterEntry { id: "m3".into(), name: "QA".into(), role: "qa".into(), edits: true, repos: vec!["p1".into()] },
        ]
    }
    fn repos() -> Vec<RepoEntry> {
        vec![RepoEntry { project_id: "p1".into(), name: "web".into() }, RepoEntry { project_id: "p2".into(), name: "api".into() }]
    }

    #[test]
    fn reads_a_plan_and_resolves_members_and_repos() {
        let text = "Plan listo.\n```equipo\n{\"mensaje\":\"vamos\",\"items\":[\
            {\"id\":\"Diseño\",\"miembro\":\"arquitecto\",\"repo\":\"api\",\"tipo\":\"investigar\",\"tarea\":\"lee\"},\
            {\"id\":\"impl\",\"miembro\":\"Dev\",\"repo\":\"api\",\"tarea\":\"escribe\",\"depende_de\":[\"diseño\"]}]}\n```";
        let reply = lead_reply(text, &roster(), &repos(), &[]);
        assert_eq!(reply.message, "vamos");
        assert!(reply.rejected.is_empty(), "{:?}", reply.rejected);
        assert_eq!(reply.items.len(), 2);
        assert_eq!(reply.items[0].key, "dise-o");
        assert_eq!(reply.items[0].kind, "investigate");
        assert_eq!(reply.items[1].project_id, "p2");
        assert_eq!(reply.items[1].depends_on, vec!["dise-o".to_string()]);
    }

    #[test]
    fn rejects_unknown_members_read_only_work_and_forbidden_repos() {
        let text = "```equipo\n{\"items\":[\
            {\"id\":\"a\",\"miembro\":\"nadie\",\"repo\":\"api\",\"tarea\":\"x\"},\
            {\"id\":\"b\",\"miembro\":\"arquitecto\",\"repo\":\"api\",\"tarea\":\"x\"},\
            {\"id\":\"c\",\"miembro\":\"qa\",\"repo\":\"api\",\"tarea\":\"x\"},\
            {\"id\":\"d\",\"miembro\":\"dev\",\"tarea\":\"x\"}]}\n```";
        let reply = lead_reply(text, &roster(), &repos(), &[]);
        assert!(reply.items.is_empty());
        assert_eq!(reply.rejected.len(), 4, "{:?}", reply.rejected);
    }

    #[test]
    fn drops_cycles_and_unknown_dependencies_but_keeps_the_rest() {
        let text = "```equipo\n{\"items\":[\
            {\"id\":\"a\",\"miembro\":\"dev\",\"repo\":\"web\",\"tarea\":\"x\",\"depende_de\":[\"b\"]},\
            {\"id\":\"b\",\"miembro\":\"dev\",\"repo\":\"web\",\"tarea\":\"x\",\"depende_de\":[\"a\"]},\
            {\"id\":\"c\",\"miembro\":\"dev\",\"repo\":\"web\",\"tarea\":\"x\",\"depende_de\":[\"zz\",\"old\"]}]}\n```";
        let reply = lead_reply(text, &roster(), &repos(), &["old".to_string()]);
        assert_eq!(reply.items.len(), 1);
        assert_eq!(reply.items[0].key, "c");
        assert_eq!(reply.items[0].depends_on, vec!["old".to_string()]);
        assert_eq!(reply.rejected.len(), 2, "{:?}", reply.rejected);
    }

    #[test]
    fn dedupes_keys_against_the_run() {
        let text = "```equipo\n{\"items\":[{\"id\":\"api\",\"miembro\":\"dev\",\"repo\":\"web\",\"tarea\":\"x\"}]}\n```";
        let reply = lead_reply(text, &roster(), &repos(), &["api".to_string()]);
        assert_eq!(reply.items[0].key, "api-2");
    }

    #[test]
    fn reads_questions_cancel_and_finish() {
        let text = "```equipo\n{\"preguntas\":[{\"pregunta\":\"¿JWT o sesiones?\",\"opciones\":[\"JWT\",\"Sesiones\"]}],\"cancelar\":[\"x\"],\"terminar\":true}\n```";
        let reply = lead_reply(text, &roster(), &repos(), &[]);
        assert_eq!(reply.questions.len(), 1);
        assert_eq!(reply.questions[0].options, vec!["JWT", "Sesiones"]);
        assert_eq!(reply.cancel, vec!["x"]);
        assert!(reply.finish);
    }

    #[test]
    fn member_notes_resolve_recipients_and_prose_drops_blocks() {
        let text = "Hecho.\n```equipo\n[{\"para\":\"qa\",\"texto\":\"revisa el login\"},{\"para\":\"usuario\",\"tipo\":\"pregunta\",\"texto\":\"¿borro la tabla?\",\"opciones\":[\"sí\",\"no\"]},{\"para\":\"marte\",\"texto\":\"hola\"}]\n```\nFin.";
        let (notes, errors) = member_notes(text, &roster());
        assert_eq!(notes.len(), 2);
        assert_eq!(notes[0].to, Recipient::Member("m3".into()));
        assert!(notes[1].question);
        assert_eq!(notes[1].to, Recipient::User);
        assert_eq!(errors.len(), 1);
        assert_eq!(prose(text), "Hecho.\nFin.");
    }

    #[test]
    fn a_role_two_members_share_is_nobody() {
        let mut r = roster();
        r.push(RosterEntry { id: "m4".into(), name: "Tester".into(), role: "qa".into(), edits: true, repos: vec![] });
        r[2].name = "Ana".into();
        assert!(find_member(&r, "qa").is_none());
        assert_eq!(find_member(&r, "tester").map(|m| m.id.as_str()), Some("m4"));
        // A name always wins over a role.
        assert_eq!(find_member(&r, "dev").map(|m| m.id.as_str()), Some("m2"));
    }

    #[test]
    fn broken_json_is_reported() {
        let (values, errors) = blocks("```equipo\n{nope\n```");
        assert!(values.is_empty());
        assert_eq!(errors.len(), 1);
    }
}
