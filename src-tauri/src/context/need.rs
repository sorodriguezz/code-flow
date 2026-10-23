//! Whether a chat turn needs the project put in front of the model, or only the tools to fetch it.
//!
//! Both chats used to attach everything they could on every question: the approved memories that
//! shared a word with it, the best passages of the knowledge for the engines that cannot search
//! (a read-only Gemini or Grok run), and — for the local model — the project's map and four
//! passages, half of a small window before the question was read. A "gracias", a "explícalo más
//! simple" or a question about how a language works paid for all of it, and a small model handed a
//! map and passages reads them as the question's subject.
//!
//! So each turn is judged first, without asking a model (the same for every engine, and free):
//!   * a **follow-up** — thanks, an acknowledgement, "más corto", "y por qué?" — is answered from
//!     the conversation: nothing is attached;
//!   * a **general** question — nothing in it points at this project — gets nothing either, and
//!     the model keeps its tools to look if it decides it needs to;
//!   * a question **about the project** — it names a file, a note, a diff, the selection, a name
//!     the code declares, asks for a change, speaks of the project, or shares its vocabulary with
//!     the indexed knowledge — gets what clears the bar (`knowledge::strong`, `ai_memory::Bar`).
//!
//! The user can say otherwise (Settings › Conocimiento): [`Mode::Always`] is the behaviour before
//! this module, [`Mode::Tools`] attaches nothing a model could fetch. An engine that cannot call the
//! tools is never left with nothing because of a judgement: [`Turn::push_for`].

use std::future::Future;

use super::{ContextSource, SourceKind};

/// The setting: `auto` (or nothing), `always`, `tools`.
pub const MODE_KEY: &str = "chat_context_mode";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Mode {
    /// Judge each turn.
    #[default]
    Auto,
    /// Attach every candidate on every turn, as before the judgement existed.
    Always,
    /// Attach nothing a model with tools could fetch itself.
    Tools,
}

impl Mode {
    pub fn parse(raw: Option<&str>) -> Mode {
        match raw.map(str::trim) {
            Some("always") => Mode::Always,
            Some("tools") => Mode::Tools,
            _ => Mode::Auto,
        }
    }

    pub fn read(conn: &rusqlite::Connection) -> Mode {
        Mode::parse(crate::db::queries::get_setting(conn, MODE_KEY).ok().flatten().as_deref())
    }
}

/// What the question is, as far as the project goes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Need {
    /// An acknowledgement or a follow-up the conversation already answers.
    FollowUp,
    /// Nothing in it points at this project.
    General,
    /// It is about this project.
    Project,
}

/// What a turn is handed besides the question and the standing rules.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Push {
    /// Every candidate, as before: the best passages, any matching memory, the project's map.
    All,
    /// What clears the bar.
    Relevant,
    /// Nothing the model could fetch with its tools — and why, for «Contexto usado».
    Nothing(Withheld),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Withheld {
    FollowUp,
    General,
    ToolsOnly,
}

impl Withheld {
    /// The chip's code; the interface words it (`context.withheld.*`).
    fn code(self) -> &'static str {
        match self {
            Withheld::FollowUp => "follow_up",
            Withheld::General => "general",
            Withheld::ToolsOnly => "tools_only",
        }
    }
}

impl Push {
    /// The knowledge's passages and the project's map go with it.
    pub fn attaches(self) -> bool {
        !matches!(self, Push::Nothing(_))
    }

    /// Which approved memories go with it: the standing ones always (preferences and conventions —
    /// short, and they hold for every question), the rest by how well they match.
    pub fn memories(self) -> crate::ai_memory::Bar {
        match self {
            Push::All => crate::ai_memory::Bar::Any,
            Push::Relevant => crate::ai_memory::Bar::Strong,
            Push::Nothing(_) => crate::ai_memory::Bar::Standing,
        }
    }
}

/// One turn's judgement, and the words it was made on.
#[derive(Clone, Debug, PartialEq)]
pub struct Turn {
    pub mode: Mode,
    pub need: Need,
    /// The user's own words — what the passages and memories are matched with, not the message the
    /// engine gets (which carries the rules, the editor's state and the memories after them).
    pub question: String,
}

impl Turn {
    /// What goes with this turn for an engine that can (`tools`) or cannot call the knowledge and
    /// memory tools. One that cannot is not left with nothing because the question looked general
    /// or the user prefers tools: it could never fetch what it is not handed. A follow-up still
    /// gets nothing — the conversation is what answers it.
    pub fn push_for(&self, tools: bool) -> Push {
        let push = match (self.mode, self.need) {
            (Mode::Always, _) => Push::All,
            (Mode::Tools, _) => Push::Nothing(Withheld::ToolsOnly),
            (Mode::Auto, Need::Project) => Push::Relevant,
            (Mode::Auto, Need::General) => Push::Nothing(Withheld::General),
            (Mode::Auto, Need::FollowUp) => Push::Nothing(Withheld::FollowUp),
        };
        match push {
            Push::Nothing(Withheld::General | Withheld::ToolsOnly) if !tools => Push::Relevant,
            other => other,
        }
    }

    /// The chip that says nothing was attached, and why — `None` when something may have been.
    pub fn withheld_source(&self, tools: bool) -> Option<ContextSource> {
        match self.push_for(tools) {
            Push::Nothing(why) => Some(ContextSource::new(SourceKind::Withheld, why.code(), None)),
            _ => None,
        }
    }

    /// The turn asks for work on the project, as far as the reminders that push a model to apply a
    /// change go: a general question answered with a code sample is a right answer, not a change it
    /// forgot to make.
    pub fn about_the_project(&self) -> bool {
        self.need == Need::Project
    }
}

/// Whether an engine running a chat turn gets the knowledge tools (`search_knowledge`, `recall`,
/// `read_context`) to fetch what it was not handed: the in-process agent always (its own tools); a
/// CLI when the map's server is on and `ai::run` hands it one — Claude, Codex, OpenCode and Cline
/// on every run, Antigravity and Grok only on one that may write (`read_only` false).
pub fn reaches_tools(provider: &str, read_only: bool) -> bool {
    match provider {
        crate::local_agent::PROVIDER_ID => true,
        "claude" | "codex" | "opencode" | "cline" => crate::codemap::mcp::enabled(),
        "gemini" | "grok" => crate::codemap::mcp::enabled() && !read_only,
        _ => false,
    }
}

/// [`reaches_tools`] for the workspace chat, whose knowledge server only the engines that take an
/// app-declared server per run are given (`chat_cmd::chat_send`) — on a read-only turn too: it is
/// queries only. Antigravity and Grok get the passages with the question instead.
pub fn reaches_workspace_tools(provider: &str) -> bool {
    match provider {
        crate::local_agent::PROVIDER_ID => true,
        "claude" | "codex" | "opencode" | "cline" => crate::codemap::mcp::enabled(),
        _ => false,
    }
}

/// What the caller knows the question points at.
pub struct Signals<K, V> {
    /// It names a file (`@path`), a note (`[[…]]`), a diff, or comes with the editor's selection or
    /// an attachment.
    pub pointed: bool,
    /// Whether a word of the question is a name the repository declares (`codemap::Snapshot::declares`).
    pub declared: K,
    /// Whether the question shares its words with the project's indexed knowledge — asked last, and
    /// only when nothing cheaper decided.
    pub vocabulary: V,
}

/// The judgement of `question` under `mode`.
pub fn judge<K, V>(mode: Mode, question: &str, signals: Signals<K, V>) -> Turn
where
    K: Fn(&str) -> bool,
    V: FnOnce() -> bool,
{
    let need = match mode {
        // Nothing to decide: everything goes, as it always did — and the reminders to apply a change
        // keep the reach they had.
        Mode::Always => Need::Project,
        Mode::Auto | Mode::Tools => classify(question, signals),
    };
    Turn { mode, need, question: question.to_string() }
}

fn classify<K, V>(question: &str, signals: Signals<K, V>) -> Need
where
    K: Fn(&str) -> bool,
    V: FnOnce() -> bool,
{
    let words = words(question);
    if signals.pointed {
        return Need::Project;
    }
    if words.is_empty() {
        return Need::FollowUp;
    }
    if words.iter().any(|w| asks_for_work(w) || PROJECT_WORDS.contains(&w.as_str())) {
        return Need::Project;
    }
    if words.len() <= FOLLOW_UP_WORDS && words.iter().all(|w| conversational(w)) {
        return Need::FollowUp;
    }
    if names(question).iter().any(|name| (signals.declared)(name)) {
        return Need::Project;
    }
    if (signals.vocabulary)() {
        return Need::Project;
    }
    Need::General
}

/// The longest message a follow-up is: past it, the words are saying something new.
const FOLLOW_UP_WORDS: usize = 12;

/// The question's words, folded the way the index folds them.
fn words(question: &str) -> Vec<String> {
    question
        .split(|c: char| !(c.is_alphanumeric() || c == '_'))
        .filter(|w| !w.is_empty())
        .map(crate::knowledge::index::fold)
        .collect()
}

/// The words worth asking the map about: four letters at least, and — unless it looks like code —
/// not a word every program declares (`value`, `config`), which would make every question a
/// question about the project.
fn names(question: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for raw in question.split(|c: char| !(c.is_alphanumeric() || c == '_' || c == '.')) {
        let raw = raw.trim_matches('.');
        if raw.chars().count() < 4 || out.iter().any(|w| w == raw) {
            continue;
        }
        let code_like = raw.contains('_') || raw.contains('.') || raw.chars().skip(1).any(char::is_uppercase);
        if !code_like && (raw.chars().count() < 5 || COMMON_NAMES.contains(&crate::knowledge::index::fold(raw).as_str())) {
            continue;
        }
        out.push(raw.to_string());
        if out.len() == 12 {
            break;
        }
    }
    out
}

fn conversational(word: &str) -> bool {
    word.chars().count() < 2
        || word.chars().all(|c| c.is_ascii_digit())
        || SOCIAL.contains(&word)
        || FOLLOW_UP.contains(&word)
        || crate::knowledge::index::STOPWORDS.iter().any(|stop| crate::knowledge::index::fold(stop) == word)
}

fn asks_for_work(word: &str) -> bool {
    ACTION_WORDS.contains(&word) || ACTION_STEMS.iter().any(|stem| word.starts_with(stem))
}

/// Greetings, thanks and acknowledgements, folded.
const SOCIAL: &[&str] = &[
    "hola", "buenas", "buenos", "dias", "tardes", "noches", "gracias", "muchas", "mil", "ok", "okay", "oki", "vale", "dale", "listo",
    "perfecto", "genial", "excelente", "bien", "bueno", "buena", "entendido", "entiendo", "claro", "si", "no", "sip", "nop", "super",
    "joya", "bacan", "chao", "adios", "saludos", "hi", "hello", "hey", "thanks", "thank", "thx", "ty", "great", "nice", "cool",
    "good", "got", "understood", "yes", "yeah", "yep", "nope", "sure", "fine", "awesome", "perfect", "bye", "wow", "jaja", "jajaja",
    "lol",
];

/// What a follow-up asks of the last answer — shorter, simpler, again, in another language — folded.
const FOLLOW_UP: &[&str] = &[
    "explica", "explicalo", "explicamelo", "explicame", "explicar", "explain", "resume", "resumelo", "resumen", "resumir",
    "summarize", "summary", "simple", "sencillo", "facil", "corto", "corta", "breve", "largo", "larga", "detalle", "detalles",
    "detalla", "ejemplo", "ejemplos", "example", "examples", "otra", "otro", "vez", "again", "continua", "continue", "sigue",
    "seguir", "go", "on", "mas", "menos", "more", "less", "shorter", "longer", "simpler", "ingles", "espanol", "english",
    "spanish", "traduce", "traducelo", "translate", "reformula", "rephrase", "repite", "repitelo", "repeat", "entonces", "it",
    "this", "porque", "then", "luego", "despues", "ahora", "now", "mejor", "better", "nuevo", "puedes", "podrias", "please",
    "porfa", "favor", "porfavor", "palabras", "words", "punto", "puntos", "points", "pasos", "paso", "steps", "step", "anterior",
    "previous", "respuesta", "answer", "parte", "part", "dame", "dime", "give", "show", "make",
];

/// Words that are about a code base in general and so about this one, in a repository's chat —
/// folded. "Test", "error" or "versión" in a question about a language would attach the project
/// too: the safe side of the line.
const PROJECT_WORDS: &[&str] = &[
    "proyecto", "proyectos", "repo", "repos", "repositorio", "repositorios", "codigo", "codebase", "archivo", "archivos", "fichero",
    "carpeta", "carpetas", "funcion", "funciones", "metodo", "metodos", "clase", "clases", "componente", "componentes", "modulo",
    "modulos", "endpoint", "endpoints", "servicio", "servicios", "pantalla", "pantallas", "vista", "vistas", "test", "tests",
    "prueba", "pruebas", "build", "compila", "compilar", "error", "errores", "bug", "bugs", "falla", "fallo", "fallan", "rompe",
    "roto", "arquitectura", "decidimos", "decidieron", "decision", "decisiones", "convencion", "convenciones", "nuestro",
    "nuestra", "nuestros", "nuestras", "aqui", "aca", "app", "aplicacion", "rama", "branch", "commit", "commits", "deploy",
    "despliegue", "pipeline", "migracion", "migraciones", "esquema", "config", "configuracion", "readme", "docs",
    "documentacion", "dependencia", "dependencias", "libreria", "version", "logs", "project", "repository", "code", "file",
    "files", "folder", "function", "functions", "method", "class", "component", "module", "service", "screen", "page", "here",
    "decided", "convention", "architecture", "our", "ours", "dependency", "dependencies", "library", "schema", "migration",
    "crash", "failing", "fails", "broken",
];

/// A request for a change or a run — folded, whole.
const ACTION_WORDS: &[&str] = &[
    "crea", "crear", "creame", "escribe", "escribir", "ejecuta", "ejecutar", "corre", "correr", "revisa", "revisar", "aplica",
    "aplicar", "aplicalo", "hazlo", "haz", "quita", "quitar", "saca", "sacar", "mejora", "mejorar", "sube", "genera", "generar",
    "add", "change", "modify", "remove", "delete", "move", "update", "create", "write", "run", "review", "apply", "generate",
    "upgrade",
];

/// …and by its start, for the verbs Spanish conjugates (arregla, arreglalo, arreglemos).
const ACTION_STEMS: &[&str] = &[
    "arregl", "corrig", "implement", "agreg", "anad", "cambi", "modific", "refactor", "renombr", "elimin", "borr", "muev",
    "actualiz", "migr", "optimiz", "instal", "configur", "integr", "sustitu", "reemplaz", "fix", "renam", "replac", "install",
];

/// Plain words a program declares often enough that a question using them says nothing about this
/// one — folded.
const COMMON_NAMES: &[&str] = &[
    "value", "values", "result", "items", "index", "start", "state", "props", "event", "query", "table", "model", "title", "label",
    "input", "output", "print", "debug", "format", "parse", "split", "merge", "check", "build", "update", "delete", "create",
    "remove", "render", "filter", "reduce", "string", "number", "object", "array", "class", "method", "function", "script",
    "server", "client", "request", "response", "error", "errors", "config", "setup", "options", "settings", "context", "default",
    "params", "data", "handle", "handler", "listen", "close", "write", "fetch", "save", "load", "reset", "clear", "count",
    "total", "first", "last", "next", "prev", "match", "test", "tests", "main", "utils", "types", "helpers", "common", "lista",
    "texto", "datos", "valor", "nombre", "tipo", "estado", "fecha", "usuario", "usuarios", "users", "user",
];

tokio::task_local! {
    static TURN: Turn;
}

/// Runs `work` as the turn judged `turn`: the in-process agent started inside it reads the judgement
/// ([`current`]) instead of attaching everything.
pub async fn within<F: Future>(turn: Option<Turn>, work: F) -> F::Output {
    match turn {
        Some(turn) => TURN.scope(turn, work).await,
        None => work.await,
    }
}

/// The judgement of the chat turn this task is running, if it was started with [`within`].
pub fn current() -> Option<Turn> {
    TURN.try_with(Clone::clone).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn signals(pointed: bool, declared: &'static [&'static str], vocabulary: bool) -> Signals<impl Fn(&str) -> bool, impl FnOnce() -> bool> {
        Signals { pointed, declared: move |name: &str| declared.iter().any(|d| *d == name), vocabulary: move || vocabulary }
    }

    fn need(question: &str) -> Need {
        judge(Mode::Auto, question, signals(false, &[], false)).need
    }

    #[test]
    fn thanks_and_follow_ups_are_answered_from_the_conversation() {
        for question in ["gracias!", "Perfecto, gracias", "ok", "explícalo más simple", "¿y por qué?", "dame 3 ejemplos", "en inglés por favor", "make it shorter please", ""] {
            assert_eq!(need(question), Need::FollowUp, "{question:?}");
        }
    }

    #[test]
    fn a_question_that_points_nowhere_in_the_project_is_general() {
        for question in ["¿Qué diferencia hay entre let y const en JavaScript?", "how does a closure capture a variable", "¿cómo se hace un debounce en React?"] {
            assert_eq!(need(question), Need::General, "{question:?}");
        }
    }

    #[test]
    fn a_request_for_work_or_a_word_about_the_code_base_is_about_the_project() {
        for question in ["arregla el login", "agrégale validación al formulario", "¿por qué falla el build?", "¿dónde está la configuración?", "gracias, ahora hazlo", "renombra esto", "explica la arquitectura", "fix the flaky test"] {
            assert_eq!(need(question), Need::Project, "{question:?}");
        }
    }

    #[test]
    fn a_name_the_code_declares_or_the_project_vocabulary_makes_it_about_the_project() {
        let declared = judge(Mode::Auto, "¿qué hace applyDiscount?", signals(false, &["applyDiscount"], false));
        assert_eq!(declared.need, Need::Project);
        let plain = judge(Mode::Auto, "¿cómo funciona el checkout?", signals(false, &["checkout"], false));
        assert_eq!(plain.need, Need::Project, "a plain word the code declares counts");
        let common = judge(Mode::Auto, "¿cómo funciona un filter en Rust?", signals(false, &["filter"], false));
        assert_eq!(common.need, Need::General, "a name every program declares says nothing about this one");
        let vocabulary = judge(Mode::Auto, "¿cómo se calcula el descuento por volumen?", signals(false, &[], true));
        assert_eq!(vocabulary.need, Need::Project);
        let pointed = judge(Mode::Auto, "gracias", signals(true, &[], false));
        assert_eq!(pointed.need, Need::Project, "a selection or a mention points at the project whatever the words");
    }

    #[test]
    fn the_vocabulary_is_asked_only_when_nothing_cheaper_decided() {
        let asked = std::cell::Cell::new(false);
        let turn = judge(Mode::Auto, "arregla el login", Signals { pointed: false, declared: |_: &str| false, vocabulary: || { asked.set(true); true } });
        assert_eq!(turn.need, Need::Project);
        assert!(!asked.get());
        judge(Mode::Auto, "gracias", Signals { pointed: false, declared: |_: &str| false, vocabulary: || { asked.set(true); true } });
        assert!(!asked.get(), "a follow-up never searches");
    }

    #[test]
    fn the_mode_decides_what_goes_and_an_engine_without_tools_is_never_left_with_nothing() {
        let general = judge(Mode::Auto, "how does a closure capture a variable", signals(false, &[], false));
        assert_eq!(general.push_for(true), Push::Nothing(Withheld::General));
        assert_eq!(general.push_for(false), Push::Relevant, "it could not fetch it");
        let follow_up = judge(Mode::Auto, "gracias", signals(false, &[], false));
        assert_eq!(follow_up.push_for(false), Push::Nothing(Withheld::FollowUp), "the conversation answers a follow-up");
        let project = judge(Mode::Auto, "arregla el login", signals(false, &[], false));
        assert_eq!(project.push_for(true), Push::Relevant);

        let always = judge(Mode::Always, "gracias", signals(false, &[], false));
        assert_eq!(always.push_for(true), Push::All);
        assert!(always.about_the_project(), "as before: every turn keeps the reminders");
        let tools = judge(Mode::Tools, "arregla el login", signals(false, &[], false));
        assert_eq!(tools.push_for(true), Push::Nothing(Withheld::ToolsOnly));
        assert_eq!(tools.push_for(false), Push::Relevant);
        assert!(tools.about_the_project(), "what is attached and what is asked are two things");
    }

    #[test]
    fn the_chip_names_why_nothing_went() {
        let general = judge(Mode::Auto, "how does a closure capture a variable", signals(false, &[], false));
        let chip = general.withheld_source(true).unwrap();
        assert_eq!((chip.kind, chip.label.as_str()), (SourceKind::Withheld, "general"));
        assert!(general.withheld_source(false).is_none());
        assert!(judge(Mode::Auto, "arregla el login", signals(false, &[], false)).withheld_source(true).is_none());
    }

    #[test]
    fn memories_follow_the_push() {
        assert_eq!(Push::All.memories(), crate::ai_memory::Bar::Any);
        assert_eq!(Push::Relevant.memories(), crate::ai_memory::Bar::Strong);
        assert_eq!(Push::Nothing(Withheld::General).memories(), crate::ai_memory::Bar::Standing);
    }

    #[test]
    fn the_setting_reads_auto_unless_it_says_otherwise() {
        assert_eq!(Mode::parse(None), Mode::Auto);
        assert_eq!(Mode::parse(Some("always")), Mode::Always);
        assert_eq!(Mode::parse(Some(" tools ")), Mode::Tools);
        assert_eq!(Mode::parse(Some("whatever")), Mode::Auto);
    }

    #[tokio::test]
    async fn the_judgement_is_read_inside_the_turn_and_nowhere_else() {
        assert!(current().is_none());
        let turn = judge(Mode::Auto, "gracias", signals(false, &[], false));
        let seen = within(Some(turn.clone()), async { current() }).await;
        assert_eq!(seen, Some(turn));
        assert!(within(None, async { current() }).await.is_none());
    }
}
