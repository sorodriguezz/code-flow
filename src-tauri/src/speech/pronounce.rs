//! What the voice is handed instead of the text as written: the same words, spelled the way the
//! voice has to read them (user, 2026-11-19: «al decir repository le sale muy mal… dice codeflow
//! pero debería pronunciar Coud Flou»).
//!
//! The app writes in two languages at once — a Spanish sentence full of English terms — and a
//! Spanish voice reads every word by Spanish rules. Changing voices mid-sentence would change the
//! speaker too, so the words are respelled instead: `repository` → `ripósitori`, the term kept, its
//! sound the English one written with Spanish letters.
//!
//! Four passes, in order:
//! 0. **Abbreviations** written out ([`ABBREVIATIONS_ES`], [`ABBREVIATIONS_EN`]): «p. ej.» is «por
//!    ejemplo», «Sr.» «señor» — a voice reads them badly, and their dot would end a sentence.
//! 1. **The dictionary.** The user's own words (Settings › Voz y sonido › Pronunciación) first,
//!    then the built-in one ([`BUILTIN_ES`], [`BUILTIN_EN`]). Whole words, any case, the longest
//!    phrase first; a plural (`commits`, `branches`) is its singular's respelling plus the ending.
//! 2. **What only a screen shows.** A URL is «un enlace», a path its file's name, a file `app.ts`
//!    «app punto te ese», a version `v2.8.51` «versión 2 punto 8 punto 51», an identifier
//!    `useSpeechStore` / `speech_rate` its words, `#123` «número 123», an emoji nothing.
//! 3. **Acronyms** in Spanish (`API`, `PR`, `CLI`) letter by letter with the Spanish letter names,
//!    except the ones said as a word (`RUT`, `RAM`…) and all-caps Spanish words. A number with its
//!    unit (`500MB`, `30ms`) is the number and the unit's word.
//! 4. **An English word nobody listed**, in a Spanish sentence: one that has what no Spanish word
//!    has (`sh`, `th`, `ck`, `ght`, `tion`, a `w`, an `-ing` or `-ment` ending) gets the commonest
//!    English sounds written the Spanish way ([`english_guess`]) — `refresh` → `refrech`,
//!    `loading` → `loudin`. The dictionary is for the words this gets wrong.
//!
//! The built-in respellings and the acronyms are for the voices that read by one language's rules —
//! the computer's own and the downloaded ones. A service's voice (OpenAI, ElevenLabs) is
//! multilingual and already says `repository` well; it gets only the user's words and pass 2.
//!
//! What is shown — the status bar, the message — stays as written: only the voice gets this.

use std::sync::RwLock;

use serde::{Deserialize, Serialize};

/// The user's dictionary, as JSON: `[{"from":"Achs","to":"a che ese","lang":"es"}]`.
pub const LEXICON_KEY: &str = "speech_pronunciations";

/// One word of the user's dictionary.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Entry {
    /// As it is written — a word or a phrase, any case.
    pub from: String,
    /// As the voice should read it.
    pub to: String,
    /// `es` · `en` · empty for both.
    #[serde(default)]
    pub lang: String,
}

/// The stored dictionary; anything unreadable is an empty one, a blank row is dropped.
pub fn parse_user(json: &str) -> Vec<Entry> {
    serde_json::from_str::<Vec<Entry>>(json)
        .unwrap_or_default()
        .into_iter()
        .filter(|entry| !entry.from.trim().is_empty())
        .map(|entry| Entry { from: entry.from.trim().to_string(), to: entry.to.trim().to_string(), lang: entry.lang.trim().to_string() })
        .collect()
}

/// The user's dictionary as last read with the settings, for a caller that has no database at hand
/// (a flow saving a downloaded voice to a file).
static REMEMBERED: RwLock<Vec<Entry>> = RwLock::new(Vec::new());

pub fn remember(entries: &[Entry]) {
    if let Ok(mut held) = REMEMBERED.write() {
        *held = entries.to_vec();
    }
}

pub fn remembered() -> Vec<Entry> {
    REMEMBERED.read().map(|held| held.clone()).unwrap_or_default()
}

/// English terms as a Spanish voice must read them to sound English. Spanish spelling rules: `gu`
/// for a hard g before e/i, `j` for an h, `y` for a j, `ch` for sh, `u` for a w, and the accent
/// where the stress falls; no `z`/`ce`/`ci` for an s, which a Castilian voice says as θ.
pub const BUILTIN_ES: &[(&str, &str)] = &[
    // The app and its world.
    ("codeflow", "Cóud Flou"),
    ("code flow", "Cóud Flou"),
    ("code-flow", "Cóud Flou"),
    ("aicode", "Ei Ái Cóud"),
    ("claude", "Clod"),
    ("claude code", "Clod Cóud"),
    ("anthropic", "Anzrópic"),
    ("openai", "Óupen É Ái"),
    ("chatgpt", "Chat Ge Pe Te"),
    ("gemini", "Yémini"),
    ("copilot", "Cópailot"),
    ("ollama", "Olama"),
    ("github", "Guit Jab"),
    ("gitlab", "Guit Lab"),
    ("bitbucket", "Bit Báket"),
    ("git", "guit"),
    ("hub", "jab"),
    ("azure", "Ásur"),
    ("devops", "Dev Óps"),
    ("azure devops", "Ásur Dev Óps"),
    ("google", "Gúgol"),
    ("docker", "Dóker"),
    ("kubernetes", "Kubernétis"),
    ("jira", "Yira"),
    ("slack", "Slak"),
    ("notion", "Nóuchon"),
    ("teams", "Tims"),
    ("outlook", "Áutluk"),
    ("onedrive", "Uán Dráiv"),
    ("sharepoint", "Chér Point"),
    ("powerpoint", "Páuer Point"),
    ("word", "Uórd"),
    ("salesforce", "Séils Fors"),
    ("youtube", "Yiútub"),
    ("whatsapp", "Uátsap"),
    ("windows", "Uíndous"),
    ("macos", "mac o ese"),
    ("ios", "ai o ese"),
    ("iphone", "Ái Foun"),
    ("vscode", "Vi Es Cóud"),
    ("vs code", "Vi Es Cóud"),
    ("visual studio code", "Vísual Estudio Cóud"),
    ("javascript", "Yava Scrípt"),
    ("typescript", "Taip Scrípt"),
    ("python", "Páizon"),
    ("node.js", "Nóud yei es"),
    ("nodejs", "Nóud yei es"),
    ("react", "Riáct"),
    ("rust", "Rast"),
    ("c++", "ce más más"),
    ("c#", "ce charp"),
    (".net", "dot net"),
    ("npm", "ene pe eme"),
    ("pnpm", "pe ene pe eme"),
    ("zsh", "zeta ese hache"),
    ("json", "Yéison"),
    ("yaml", "Yámel"),
    ("jpeg", "Yéipeg"),
    ("readme", "Rídmi"),
    ("ok", "okéi"),
    // Git.
    ("repository", "ripósitori"),
    ("repositories", "ripósitoris"),
    ("commit", "cómit"),
    ("commitear", "comiteár"),
    ("push", "puch"),
    ("pushear", "pucheár"),
    ("pull", "pul"),
    ("pullear", "puleár"),
    ("pull request", "pul ricuést"),
    ("merge request", "merch ricuést"),
    ("merge", "merch"),
    ("mergear", "mergueár"),
    ("rebase", "ribéis"),
    ("checkout", "chécaut"),
    ("stash", "stach"),
    ("fetch", "fech"),
    ("main", "méin"),
    ("issue", "ísiu"),
    ("worktree", "uórk tri"),
    // Building and shipping.
    ("pipeline", "páiplain"),
    ("deploy", "diplói"),
    ("deployar", "diployár"),
    ("deployment", "diplóiment"),
    ("build", "bild"),
    ("release", "rilís"),
    ("releases", "rilísis"),
    ("workflow", "uórk flou"),
    ("workspace", "uórk speis"),
    ("frontend", "fróntend"),
    ("backend", "bákend"),
    ("framework", "fréimuork"),
    ("feature", "fícher"),
    ("bug", "bag"),
    ("hotfix", "jot fix"),
    ("debug", "dibág"),
    ("debugger", "dibáguer"),
    ("breakpoint", "bréikpoint"),
    ("runner", "ráner"),
    ("run", "ran"),
    ("shell", "chel"),
    ("bash", "bach"),
    ("plugin", "plóguin"),
    ("template", "témpleit"),
    ("dashboard", "dáchbord"),
    ("endpoint", "éndpoint"),
    ("request", "ricuést"),
    ("response", "rispóns"),
    ("cache", "cach"),
    ("token", "tóken"),
    ("thread", "tred"),
    ("agent", "éiyent"),
    ("skill", "skil"),
    ("preview", "príviu"),
    ("review", "riviú"),
    ("reviewer", "riviúer"),
    ("code review", "cóud riviú"),
    ("feedback", "fídbak"),
    ("update", "ápdeit"),
    ("upgrade", "ápgreid"),
    ("download", "dáunloud"),
    ("upload", "áploud"),
    ("setting", "séting"),
    ("settings", "sétings"),
    ("default", "dífolt"),
    ("cloud", "claud"),
    ("online", "onláin"),
    ("offline", "ofláin"),
    ("login", "lóguin"),
    ("logout", "lógaut"),
    ("password", "pásuord"),
    ("email", "ímeil"),
    ("e-mail", "ímeil"),
    ("software", "sófuer"),
    ("hardware", "járduer"),
    ("shortcut", "chórcat"),
    ("spotlight", "spótlait"),
    ("notebook", "nóutbuk"),
    ("tour", "tur"),
    // Code.
    ("string", "estring"),
    ("array", "arréi"),
    ("null", "nul"),
    ("true", "tru"),
    ("false", "fols"),
    ("boolean", "búlian"),
    ("function", "fánkchon"),
    ("class", "clas"),
    ("import", "ímport"),
    ("export", "éxport"),
    ("async", "eisínc"),
    ("await", "auéit"),
    ("return", "ritérn"),
    ("type", "taip"),
    ("interface", "ínterfeis"),
    ("hook", "juk"),
    ("state", "steit"),
    ("component", "compóunent"),
    ("store", "stor"),
    ("testing", "téstin"),
    ("mock", "mok"),
    ("file", "fail"),
    ("folder", "fóulder"),
    ("path", "pat"),
    ("browser", "bráuser"),
    ("click", "clik"),
    ("scroll", "scrol"),
    ("layout", "léiaut"),
    ("theme", "tim"),
    ("mode", "moud"),
    ("dark mode", "dark moud"),
    ("light", "lait"),
    ("developer", "divéloper"),
    ("user", "iúser"),
    ("username", "iúser neim"),
    ("key", "ki"),
    ("context", "cóntext"),
    ("model", "módel"),
    ("provider", "provaider"),
    ("sidebar", "sáid bar"),
    ("toolbar", "tul bar"),
    ("status bar", "státus bar"),
    ("button", "bátton"),
    ("check", "chek"),
    ("checkbox", "chékbox"),
    ("dropdown", "dróp daun"),
    ("input", "ínput"),
    ("output", "áutput"),
    ("inbox", "ínbox"),
    ("zoom", "zum"),
    ("screen", "scrin"),
    ("screenshot", "scrínchot"),
    ("save", "seiv"),
    ("undo", "andú"),
    ("redo", "ridú"),
    ("copy", "cópi"),
    ("paste", "peist"),
    ("delete", "dilít"),
    ("escape", "escéip"),
    ("space", "speis"),
    ("home", "joum"),
    ("play", "plei"),
    ("pause", "pos"),
    ("reset", "risét"),
    ("refresh", "rifréch"),
    ("reload", "rilóud"),
    ("sync", "sinc"),
    ("backup", "bákap"),
    ("restore", "ristór"),
    ("share", "cher"),
    ("free", "fri"),
    ("changelog", "chéinch log"),
    ("roadmap", "róud map"),
    ("ticket", "tíket"),
    ("board", "bord"),
    ("story", "stóri"),
    ("user story", "iúser stóri"),
    ("staging", "stéiyin"),
    ("production", "prodákchon"),
    ("development", "divélopment"),
    ("environment", "enváironment"),
    ("webhook", "uéb juk"),
    ("payload", "péilou"),
    ("query", "cuéri"),
    ("queries", "cuéris"),
    ("database", "déita beis"),
    ("schema", "squíma"),
    ("insights", "ínsaits"),
    ("notification", "noutifikéichon"),
    ("onboarding", "onbórdin"),
    ("welcome", "uélcom"),
    ("next", "next"),
    ("back", "bak"),
    ("done", "dan"),
    ("ready", "rédi"),
    ("loading", "lóudin"),
    ("running", "ránin"),
    ("pending", "péndin"),
    ("failed", "féild"),
    ("success", "saksés"),
    ("warning", "uórnin"),
    // Units: a number's unit is said as its word (`500MB` → «500 megas»).
    ("kb", "kilobytes"),
    ("mb", "megas"),
    ("gb", "gigas"),
    ("tb", "teras"),
    ("ms", "milisegundos"),
    ("px", "píxeles"),
    // The team's day.
    ("meeting", "míting"),
    ("daily", "déili"),
    ("backlog", "báklog"),
    ("team", "tim"),
    ("call", "col"),
];

/// An English voice reads English; only what it cannot guess.
pub const BUILTIN_EN: &[(&str, &str)] = &[("c++", "C plus plus"), ("c#", "C sharp"), (".net", "dot net"), ("macos", "mac O S"), ("vscode", "V S Code")];

pub fn builtin(lang: &str) -> &'static [(&'static str, &'static str)] {
    if lang == "es" {
        BUILTIN_ES
    } else {
        BUILTIN_EN
    }
}

/// All-caps words said as words, not letter by letter: Spanish words written in capitals, and
/// acronyms everyone pronounces.
const SAID_AS_WORDS: &[&str] = &[
    "NO", "SI", "SÍ", "YA", "Y", "O", "A", "E", "U", "EL", "LA", "LO", "LOS", "LAS", "DE", "DEL", "EN", "UN", "UNA", "ES", "AL", "QUE",
    "CON", "POR", "MAS", "MÁS", "HOY", "VER", "FIN", "TODO", "NOTA", "OJO", "SUS", "MIS", "TU", "TUS", "MI", "SE", "LE", "LES", "ME",
    "TE", "NOS", "IR", "VA", "VE", "HAY", "SON", "SER", "FUE", "ESO", "ESA", "ESE", "ESTO", "ESTA", "ESTE", "PARA", "PERO", "SIN",
    "SOLO", "AUN", "BIEN", "MAL", "ALTO", "BAJO", "OK", "RUT", "RAM", "ROM", "REST", "CRUD", "IVA", "PYME", "ONU", "OTAN", "NASA",
    "GIF", "ACHS",
];

const LETTERS_ES: [&str; 26] = [
    "a", "be", "ce", "de", "e", "efe", "ge", "hache", "i", "jota", "ka", "ele", "eme", "ene", "o", "pe", "cu", "erre", "ese", "te", "u",
    "uve", "doble uve", "equis", "ye", "zeta",
];

/// File extensions and domains, as each language says them.
const EXTENSIONS: &[(&str, &str, &str)] = &[
    ("ts", "te ese", "T S"),
    ("tsx", "te ese equis", "T S X"),
    ("js", "jota ese", "J S"),
    ("jsx", "jota ese equis", "J S X"),
    ("mjs", "eme jota ese", "M J S"),
    ("cjs", "ce jota ese", "C J S"),
    ("json", "yéison", "jason"),
    ("md", "eme de", "M D"),
    ("mdx", "eme de equis", "M D X"),
    ("rs", "erre ese", "R S"),
    ("py", "pai", "pie"),
    ("toml", "tóml", "toml"),
    ("yml", "yámel", "yamel"),
    ("yaml", "yámel", "yamel"),
    ("html", "hache te eme ele", "H T M L"),
    ("css", "ce ese ese", "C S S"),
    ("scss", "ese ce ese ese", "S C S S"),
    ("sql", "es cu ele", "S Q L"),
    ("sh", "ese hache", "S H"),
    ("txt", "te equis te", "text"),
    ("csv", "ce ese uve", "C S V"),
    ("xml", "equis eme ele", "X M L"),
    ("lock", "lok", "lock"),
    ("env", "env", "env"),
    ("go", "go", "go"),
    ("java", "yava", "java"),
    ("kt", "ka te", "K T"),
    ("swift", "suift", "swift"),
    ("cs", "ce ese", "C S"),
    ("rb", "erre be", "R B"),
    ("php", "pe hache pe", "P H P"),
    ("vue", "viu", "view"),
    ("svelte", "svelt", "svelt"),
    ("png", "pe ene ge", "P N G"),
    ("jpg", "jota pe ge", "J peg"),
    ("svg", "ese uve ge", "S V G"),
    ("pdf", "pe de efe", "P D F"),
    ("log", "log", "log"),
    ("ipynb", "nóutbuk", "notebook"),
    ("dll", "de ele ele", "D L L"),
    ("exe", "exe", "exe"),
    ("zip", "zip", "zip"),
    ("wav", "wav", "wave"),
    ("mp3", "eme pe tres", "M P 3"),
    ("docx", "doc equis", "doc X"),
    ("xlsx", "equis ele ese equis", "X L S X"),
    ("pptx", "pe pe te equis", "P P T X"),
    ("com", "com", "com"),
    ("cl", "ce ele", "C L"),
    ("io", "ai ou", "I O"),
    ("dev", "dev", "dev"),
    ("org", "org", "org"),
    ("net", "net", "net"),
    ("app", "app", "app"),
];

/// Abbreviations and what they stand for, as `(pattern, words, title)`. The pattern is a regular
/// expression matched from a word's start, any case. A `title` («Sr.») comes before a name and never
/// ends a sentence; any other one whose dot is followed by a capital or the end did end one, and
/// keeps a full stop.
pub const ABBREVIATIONS_ES: &[(&str, &str, bool)] = &[
    (r"p\.\s?ej\.", "por ejemplo", false),
    (r"p\.\s?e\.", "por ejemplo", false),
    (r"etc\.", "etcétera", false),
    (r"aprox\.", "aproximadamente", false),
    (r"págs\.", "páginas", false),
    (r"pág\.", "página", false),
    (r"núm\.", "número", false),
    (r"nro\.", "número", false),
    (r"n\.?\s?º", "número", false),
    (r"vs\.", "versus", false),
    (r"máx\.", "máximo", false),
    (r"mín\.", "mínimo", false),
    (r"tel\.", "teléfono", false),
    (r"cap\.", "capítulo", false),
    (r"art\.", "artículo", false),
    (r"ee\.\s?uu\.", "Estados Unidos", false),
    (r"xq", "porque", false),
    (r"pq", "porque", false),
    (r"srta\.", "señorita", true),
    (r"sra\.", "señora", true),
    (r"sr\.", "señor", true),
    (r"dra\.", "doctora", true),
    (r"dr\.", "doctor", true),
    (r"uds\.", "ustedes", true),
    (r"ud\.", "usted", true),
    (r"ing\.", "ingeniero", true),
    (r"lic\.", "licenciado", true),
];

pub const ABBREVIATIONS_EN: &[(&str, &str, bool)] = &[
    (r"e\.\s?g\.", "for example", false),
    (r"i\.\s?e\.", "that is", false),
    (r"etc\.", "et cetera", false),
    (r"approx\.", "approximately", false),
    (r"vs\.", "versus", false),
    (r"u\.\s?s\.", "U S", false),
    (r"mrs\.", "missus", true),
    (r"mr\.", "mister", true),
    (r"ms\.", "miz", true),
    (r"dr\.", "doctor", true),
];

/// Pass 0: every abbreviation of `lang` written out.
fn abbreviations(text: &str, lang: &str) -> String {
    use std::sync::OnceLock;
    type Compiled = Vec<(regex::Regex, &'static str, bool)>;
    static ES: OnceLock<Compiled> = OnceLock::new();
    static EN: OnceLock<Compiled> = OnceLock::new();
    let compile = |table: &'static [(&'static str, &'static str, bool)]| -> Compiled {
        table
            .iter()
            // A word's start: the text's or after a space or an opening mark; and no letter after.
            .filter_map(|(pattern, words, title)| regex::Regex::new(&format!(r#"(?i)(^|[\s(\[¿¡«"'])({pattern})([^\p{{L}}\p{{N}}]|$)"#)).ok().map(|re| (re, *words, *title)))
            .collect()
    };
    let table = if lang == "es" { ES.get_or_init(|| compile(ABBREVIATIONS_ES)) } else { EN.get_or_init(|| compile(ABBREVIATIONS_EN)) };
    let mut out = text.to_string();
    for (re, words, title) in table {
        // Twice: a match takes the character after it, so «Sr. y Sra.» needs a second look.
        for _ in 0..2 {
            let held = out.clone();
            out = re
                .replace_all(&held, |caps: &regex::Captures<'_>| {
                    let (before, found, after) = (&caps[1], &caps[2], &caps[3]);
                    let rest = &held[caps.get(2).map_or(0, |m| m.end())..];
                    let rest = rest.trim_start();
                    let ends_sentence = !title && found.ends_with('.') && (rest.is_empty() || rest.chars().next().is_some_and(char::is_uppercase));
                    format!("{before}{words}{}{after}", if ends_sentence && !after.starts_with('.') { "." } else { "" })
                })
                .into_owned();
        }
    }
    out
}

/// A dictionary ready to match: each entry's words, lower-cased, and what they become; the user's
/// first, so a word they wrote wins over the built-in one.
struct Lexicon {
    entries: Vec<(Vec<String>, String)>,
}

impl Lexicon {
    fn new(lang: &str, builtin_words: bool, user: &[Entry]) -> Self {
        let mut entries: Vec<(Vec<String>, String)> = Vec::new();
        let mut add = |from: &str, to: &str| {
            let words: Vec<String> = from.split_whitespace().map(str::to_lowercase).collect();
            if !words.is_empty() && !entries.iter().any(|(held, _)| *held == words) {
                entries.push((words, to.to_string()));
            }
        };
        for entry in user.iter().filter(|entry| entry.lang.is_empty() || entry.lang == lang) {
            add(&entry.from, &entry.to);
        }
        if builtin_words {
            for (from, to) in builtin(lang) {
                add(from, to);
            }
        }
        // The longest phrase first: «pull request» before «pull».
        entries.sort_by_key(|(words, _)| std::cmp::Reverse(words.len()));
        Lexicon { entries }
    }

    /// One word's respelling, its plural's included.
    fn word(&self, word: &str) -> Option<String> {
        let lower = word.to_lowercase();
        let singles = || self.entries.iter().filter(|(words, _)| words.len() == 1);
        // Exact first: «releases» has its own entry, not «release» plus an ending.
        singles().find(|(words, _)| words[0] == lower).map(|(_, to)| to.clone()).or_else(|| singles().find_map(|(words, to)| plural_match(&words[0], &lower, to)))
    }
}

/// `word` is `key` or its plural: what it is said as.
fn plural_match(key: &str, word: &str, to: &str) -> Option<String> {
    if word == key {
        return Some(to.to_string());
    }
    if key.chars().count() < 3 || !key.chars().last().is_some_and(char::is_alphabetic) {
        return None;
    }
    let ending = |suffix: &str| word.strip_suffix(suffix).is_some_and(|stem| stem == key);
    if ending("s") || ending("es") {
        let hissing = to.ends_with(['s', 'x']) || to.ends_with("ch");
        return Some(if hissing { format!("{to}es") } else { format!("{to}s") });
    }
    None
}

/// A word as it stands in the text: what opens and closes it, kept apart from the word itself.
#[derive(Debug, Clone)]
struct Piece {
    lead: String,
    core: String,
    trail: String,
    /// Already said by the dictionary: left alone after.
    done: bool,
}

const LEADING: &[char] = &['(', '[', '{', '"', '\'', '¿', '¡', '«', '“', '‘', '<', '*'];
const TRAILING: &[char] = &['.', ',', ';', ':', '!', '?', ')', ']', '}', '"', '\'', '»', '”', '’', '…', '>', '*'];

fn pieces(text: &str) -> Vec<Piece> {
    text.split_whitespace()
        .map(|token| {
            let after_lead = token.trim_start_matches(LEADING);
            let lead = token[..token.len() - after_lead.len()].to_string();
            // A dotfile (`.env`) keeps its dot; a trailing one is a sentence's.
            let core = after_lead.trim_end_matches(TRAILING);
            let trail = after_lead[core.len()..].to_string();
            Piece { lead, core: core.to_string(), trail, done: false }
        })
        .collect()
}

/// The language's words for the few things pass 2 says.
struct Words {
    dot: &'static str,
    link: &'static str,
    number: &'static str,
    version: &'static str,
    point: &'static str,
    at: &'static str,
    and: &'static str,
}

fn words(lang: &str) -> Words {
    if lang == "es" {
        Words { dot: "punto", link: "un enlace", number: "número", version: "versión", point: "punto", at: "arroba", and: "y" }
    } else {
        Words { dot: "dot", link: "a link", number: "number", version: "version", point: "point", at: "at", and: "and" }
    }
}

struct Context<'a> {
    lang: &'a str,
    lexicon: Lexicon,
    words: Words,
    /// The built-in respellings and the acronyms apply (not a service's multilingual voice).
    builtin: bool,
}

/// `text` as voice `lang` (`es` · `en`) should be handed it. `builtin_words` is false for a
/// service's voice: only the user's dictionary and what a screen alone shows are changed.
pub fn prepare(text: &str, lang: &str, builtin_words: bool, user: &[Entry]) -> String {
    let ctx = Context { lang, lexicon: Lexicon::new(lang, builtin_words, user), words: words(lang), builtin: builtin_words };
    let text = abbreviations(text, lang);
    let text = symbols(&text, &ctx.words);
    let mut pieces = pieces(&text);
    phrases(&mut pieces, &ctx.lexicon);
    let said: Vec<String> = pieces
        .into_iter()
        .map(|piece| {
            let core = if piece.done { piece.core } else { say_word(&piece.core, &ctx, 0) };
            format!("{}{}{}", piece.lead, core, piece.trail)
        })
        .filter(|piece| !piece.trim().is_empty())
        .collect();
    tidy(&said.join(" "))
}

/// Pass 0: the symbols a sentence uses that no voice reads, and emoji, gone or in words.
fn symbols(text: &str, words: &Words) -> String {
    let mut out: String = text.chars().filter(|c| !is_pictograph(*c)).collect();
    for arrow in ["->", "=>", "→", "⇒", "›", " | ", " — ", " – "] {
        out = out.replace(arrow, ", ");
    }
    out = out.replace(" & ", &format!(" {} ", words.and));
    out = out.replace("**", "").replace('`', "").replace("~~", "");
    out
}

fn is_pictograph(c: char) -> bool {
    matches!(c as u32, 0x1F000..=0x1FAFF | 0x2600..=0x27BF | 0x2B00..=0x2BFF | 0xFE0F | 0x200D)
}

/// Pass 1 for phrases: every run of words a dictionary phrase names, said as it says, only across
/// plain spaces (not «pull. Request»).
fn phrases(pieces: &mut Vec<Piece>, lexicon: &Lexicon) {
    let mut i = 0;
    while i < pieces.len() {
        let matched = lexicon.entries.iter().filter(|(words, _)| words.len() > 1).find_map(|(words, to)| {
            let n = words.len();
            let run = pieces.get(i..i + n)?;
            let joined = run.iter().enumerate().all(|(k, piece)| (k == 0 || piece.lead.is_empty()) && (k == n - 1 || piece.trail.is_empty()));
            if !joined || run.iter().any(|piece| piece.done) {
                return None;
            }
            let heads = run[..n - 1].iter().zip(&words[..n - 1]).all(|(piece, word)| piece.core.to_lowercase() == *word);
            let said = plural_match(&words[n - 1], &run[n - 1].core.to_lowercase(), to)?;
            heads.then_some((n, said))
        });
        if let Some((n, said)) = matched {
            let trail = pieces[i + n - 1].trail.clone();
            pieces.drain(i + 1..i + n);
            pieces[i] = Piece { lead: pieces[i].lead.clone(), core: said, trail, done: true };
        }
        i += 1;
    }
}

/// Passes 1–3 for one word.
fn say_word(word: &str, ctx: &Context<'_>, depth: u8) -> String {
    if word.is_empty() || depth > 4 {
        return word.to_string();
    }
    if let Some(said) = ctx.lexicon.word(word) {
        return said;
    }
    let lower = word.to_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("www.") {
        return ctx.words.link.to_string();
    }
    if let Some((user, domain)) = word.split_once('@') {
        if user.is_empty() {
            return say_word(domain, ctx, depth + 1);
        }
        if domain.contains('.') {
            return format!("{} {} {}", say_word(user, ctx, depth + 1), ctx.words.at, say_word(domain, ctx, depth + 1));
        }
    }
    if let Some(rest) = word.strip_prefix('#') {
        if !rest.is_empty() && rest.chars().all(|c| c.is_ascii_digit()) {
            return format!("{} {rest}", ctx.words.number);
        }
        return say_word(rest, ctx, depth + 1);
    }
    if let Some(version) = version(word, &ctx.words) {
        return version;
    }
    if let Some(path) = path(word, ctx, depth) {
        return path;
    }
    if let Some(file) = file(word, ctx, depth) {
        return file;
    }
    if let Some(measure) = measure(word, ctx) {
        return measure;
    }
    // Before the identifier's split, which would take «PRs» apart.
    if ctx.builtin && ctx.lang == "es" {
        if let Some(spelled) = acronym(word) {
            return spelled;
        }
    }
    let parts = identifier_parts(word);
    if parts.len() > 1 {
        return parts.iter().map(|part| say_word(part, ctx, depth + 1)).collect::<Vec<_>>().join(" ");
    }
    if let [only] = parts.as_slice() {
        if only != word {
            return say_word(only, ctx, depth + 1);
        }
    }
    if ctx.builtin && ctx.lang == "es" {
        if let Some(guess) = english_guess(word) {
            return guess;
        }
    }
    word.to_string()
}

/// `500MB`, `1,5GB`, `30ms`: the number, then its unit's word — only a unit the dictionary knows.
fn measure(word: &str, ctx: &Context<'_>) -> Option<String> {
    let split = word.find(|c: char| c.is_alphabetic())?;
    let (number, unit) = word.split_at(split);
    let numeric = !number.is_empty() && number.chars().next().is_some_and(|c| c.is_ascii_digit()) && number.chars().all(|c| c.is_ascii_digit() || c == '.' || c == ',');
    if !numeric || !unit.chars().all(char::is_alphabetic) {
        return None;
    }
    ctx.lexicon.word(unit).map(|said| format!("{number} {said}"))
}

/// An English word a Spanish voice would read letter for letter by Spanish rules, respelled with
/// its commonest English sounds. Only a word that has what no Spanish word has — so «leer» or
/// «cooperar» are never touched — and only the sounds that are nearly always right.
pub fn english_guess(word: &str) -> Option<String> {
    if word.chars().count() < 3 || !word.chars().all(|c| c.is_ascii_alphabetic()) || word.chars().skip(1).any(|c| c.is_ascii_uppercase()) {
        return None;
    }
    let lower = word.to_ascii_lowercase();
    let english = ["sh", "th", "ck", "ght", "tion", "w"].iter().any(|mark| lower.contains(mark))
        || (lower.len() >= 5 && (lower.ends_with("ing") || lower.ends_with("ment") || lower.ends_with("ness")))
        || (lower.len() >= 4 && lower.ends_with("ly"));
    if !english {
        return None;
    }
    let mut said = lower.clone();
    for (from, to) in [
        ("tion", "chon"),
        ("ight", "ait"),
        ("igh", "ai"),
        ("ough", "of"),
        ("gh", ""),
        ("sh", "ch"),
        ("th", "t"),
        ("ck", "k"),
        ("ew", "iu"),
        ("eam", "im"),
        ("ee", "i"),
        ("oo", "u"),
        ("oa", "ou"),
        ("ay", "ei"),
    ] {
        said = said.replace(from, to);
    }
    if let Some(stem) = said.strip_suffix("ing") {
        said = format!("{stem}in");
    }
    if let Some(stem) = said.strip_suffix("ly") {
        said = format!("{stem}li");
    }
    // «ow» at the end is «ou» (flow, window); a «w» before a vowel is a «u» (web, wifi).
    if let Some(stem) = said.strip_suffix("ow") {
        said = format!("{stem}ou");
    }
    // A silent final «e» after vowel–consonant: the vowel says its name (share → cheir, white → uait).
    let chars: Vec<char> = said.chars().collect();
    if let [.., v, c, 'e'] = chars.as_slice() {
        let vowel_name = match v {
            'a' => Some("ei"),
            'i' => Some("ai"),
            'o' => Some("ou"),
            'u' => Some("iu"),
            _ => None,
        };
        let before_vowel = chars.len() < 4 || !"aeiou".contains(chars[chars.len() - 4]);
        if let (Some(name), true, true) = (vowel_name, !"aeiouy".contains(*c), before_vowel) {
            let head: String = chars[..chars.len() - 3].iter().collect();
            said = format!("{head}{name}{c}");
        }
    }
    // Last, so the vowel before a «w» was read first: «wh» and a «w» before a vowel are a «u».
    said = said.replace("wh", "u").replace('w', "u");
    // The capital it was written with, so a name stays a name.
    if word.chars().next().is_some_and(|c| c.is_ascii_uppercase()) {
        let mut letters = said.chars();
        said = letters.next().map(|first| first.to_uppercase().chain(letters).collect()).unwrap_or(said);
    }
    (said != lower).then_some(said)
}

/// `v2.8.51`, `2.8.51`, `192.168.1.1`: the numbers and the dots between them in words. One dot
/// alone without the `v` is a decimal or a thousands mark, and the voice reads it already.
fn version(word: &str, words: &Words) -> Option<String> {
    let (prefixed, digits) = match word.strip_prefix(['v', 'V']) {
        Some(rest) => (true, rest),
        None => (false, word),
    };
    let parts: Vec<&str> = digits.split('.').collect();
    let numbers = parts.len() >= 2 && parts.iter().all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()));
    if !numbers || (!prefixed && parts.len() < 3) {
        return None;
    }
    let said = parts.join(&format!(" {} ", words.point));
    Some(if prefixed { format!("{} {said}", words.version) } else { said })
}

/// A path: its file's name. Two plain words around a slash («y/o», «CI/CD») are both said.
fn path(word: &str, ctx: &Context<'_>, depth: u8) -> Option<String> {
    if !word.contains(['/', '\\']) || !word.chars().any(char::is_alphabetic) {
        return None;
    }
    let segments: Vec<&str> = word.split(['/', '\\']).filter(|segment| !segment.is_empty() && *segment != "." && *segment != "..").collect();
    let last = segments.last()?;
    let rooted = word.starts_with(['/', '\\', '~', '.']);
    if rooted || segments.len() >= 3 || file(last, ctx, depth + 1).is_some() {
        return Some(say_word(last, ctx, depth + 1));
    }
    Some(segments.iter().map(|segment| say_word(segment, ctx, depth + 1)).collect::<Vec<_>>().join(" "))
}

/// `app.ts`, `vite.config.ts`, `github.com`, `.env`: the names and a «punto» before each part, the
/// extension as it is said. Only a known extension or domain — `p.ej.` stays as it is.
fn file(word: &str, ctx: &Context<'_>, depth: u8) -> Option<String> {
    let dot = ctx.words.dot;
    if let Some(rest) = word.strip_prefix('.') {
        if !rest.is_empty() && !rest.contains('.') && rest.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '-') {
            return Some(format!("{dot} {}", say_word(rest, ctx, depth + 1)));
        }
        return None;
    }
    let parts: Vec<&str> = word.split('.').collect();
    if parts.len() < 2 || parts.iter().any(|part| part.is_empty()) {
        return None;
    }
    let extension = parts.last()?.to_lowercase();
    let (_, es, en) = EXTENSIONS.iter().find(|(ext, _, _)| *ext == extension)?;
    let names: Vec<String> = parts[..parts.len() - 1].iter().map(|part| say_word(part, ctx, depth + 1)).collect();
    let ext = if ctx.lang == "es" { *es } else { *en };
    Some(format!("{} {dot} {ext}", names.join(&format!(" {dot} "))))
}

/// `useSpeechStore` → `use Speech Store`, `speech_rate` → `speech rate`, `HTTPServer` → `HTTP
/// Server`, `pre-commit` → `pre commit`. A word that is none of these comes back alone.
fn identifier_parts(word: &str) -> Vec<String> {
    let mut parts = Vec::new();
    for chunk in word.split(['_', '-']).filter(|chunk| !chunk.is_empty()) {
        let chars: Vec<char> = chunk.chars().collect();
        let mut current = String::new();
        for (i, &c) in chars.iter().enumerate() {
            let prev = i.checked_sub(1).map(|p| chars[p]);
            let next = chars.get(i + 1).copied();
            let boundary = match prev {
                Some(p) if c.is_uppercase() && p.is_lowercase() => true,
                Some(p) if c.is_uppercase() && p.is_uppercase() && next.is_some_and(char::is_lowercase) => true,
                _ => false,
            };
            if boundary && !current.is_empty() {
                parts.push(std::mem::take(&mut current));
            }
            current.push(c);
        }
        if !current.is_empty() {
            parts.push(current);
        }
    }
    parts
}

/// `API` → «a pe i», `K8S` → «ka 8 ese», `PRs` → «pe erres». Two to five capitals (and digits);
/// five only when it has at most one vowel, so «ERROR» or «LISTO» stay words.
fn acronym(word: &str) -> Option<String> {
    let (body, plural) = match word.strip_suffix('s') {
        Some(stem) if stem.chars().count() >= 2 && stem.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit()) => (stem, true),
        _ => (word, false),
    };
    if !body.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit()) {
        return None;
    }
    let letters = body.chars().filter(char::is_ascii_uppercase).count();
    let vowels = body.chars().filter(|c| "AEIOU".contains(*c)).count();
    if !(2..=5).contains(&body.chars().count()) || letters == 0 || (letters == 5 && vowels > 1) || SAID_AS_WORDS.contains(&body) {
        return None;
    }
    let mut said: Vec<String> =
        body.chars().map(|c| if c.is_ascii_uppercase() { LETTERS_ES[(c as u8 - b'A') as usize].to_string() } else { c.to_string() }).collect();
    if plural {
        if let Some(last) = said.last_mut() {
            last.push_str(if last.ends_with(['a', 'e', 'i', 'o', 'u']) { "s" } else { "es" });
        }
    }
    Some(said.join(" "))
}

/// Spaces before punctuation, doubled commas and the like that the passes leave behind.
fn tidy(text: &str) -> String {
    let mut out = text.split_whitespace().collect::<Vec<_>>().join(" ");
    for (from, to) in [(" ,", ","), (" .", "."), (" ;", ";"), (" :", ":"), (",,", ","), (", ,", ","), (".,", "."), (",.", ".")] {
        while out.contains(from) {
            out = out.replace(from, to);
        }
    }
    out.trim_start_matches([',', ' ']).trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn es(text: &str) -> String {
        prepare(text, "es", true, &[])
    }

    #[test]
    fn english_terms_are_respelled_for_a_spanish_voice() {
        assert_eq!(es("Bienvenido a CodeFlow."), "Bienvenido a Cóud Flou.");
        assert_eq!(es("Abre el repository y haz commit."), "Abre el ripósitori y haz cómit.");
        assert_eq!(es("Tienes 3 commits y dos pull requests."), "Tienes 3 cómits y dos pul ricuésts.");
        assert_eq!(es("Cambia de branch: main."), "Cambia de branch: méin.");
        assert_eq!(es("Revisa los issues en GitHub"), "Revisa los ísius en Guit Jab");
        // A phrase is matched only across plain spaces.
        assert_eq!(es("Haz pull. Request aparte"), "Haz pul. ricuést aparte");
    }

    #[test]
    fn plurals_take_the_ending_their_respelling_needs() {
        assert_eq!(es("pushes"), "puches");
        assert_eq!(es("pipelines"), "páiplains");
        assert_eq!(es("releases"), "rilísis");
    }

    #[test]
    fn the_users_words_win_and_apply_to_every_voice() {
        let user = vec![
            Entry { from: "CodeFlow".into(), to: "Code Flow".into(), lang: String::new() },
            Entry { from: "Achs".into(), to: "a che ese".into(), lang: "es".into() },
        ];
        assert_eq!(prepare("CodeFlow de la Achs", "es", true, &user), "Code Flow de la a che ese");
        // A service's voice: the user's words, not the built-in ones.
        assert_eq!(prepare("CodeFlow y el repository", "es", false, &user), "Code Flow y el repository");
        // A Spanish-only entry is not used for English.
        assert_eq!(prepare("Achs", "en", true, &user), "Achs");
    }

    #[test]
    fn what_only_a_screen_shows_is_put_in_words() {
        assert_eq!(es("Mira https://example.com/docs para más."), "Mira un enlace para más.");
        assert_eq!(es("Edita src/components/tour/TourOverlay.tsx ahora."), "Edita tur Overlay punto te ese equis ahora.");
        assert_eq!(es("Actualizado a v2.8.51."), "Actualizado a versión 2 punto 8 punto 51.");
        assert_eq!(es("Cuesta 3.5 dólares."), "Cuesta 3.5 dólares.");
        assert_eq!(es("Cierra el #123"), "Cierra el número 123");
        assert_eq!(es("Revisa speech_rate y useSpeechStore"), "Revisa speech rate y use Speech stor");
        assert_eq!(es("Copia .env y vite.config.ts"), "Copia punto env y vite punto config punto te ese");
        assert_eq!(es("Listo ✅ 🎉"), "Listo");
        assert_eq!(es("Configuración → Pipelines"), "Configuración, páiplains");
        assert_eq!(es("Abre github.com"), "Abre Guit Jab punto com");
    }

    #[test]
    fn spanish_acronyms_are_spelled_and_words_in_capitals_are_not() {
        assert_eq!(es("La API y el CLI"), "La a pe i y el ce ele i");
        assert_eq!(es("Abre dos PRs"), "Abre dos pe erres");
        assert_eq!(es("NO toques el RUT"), "NO toques el RUT");
        assert_eq!(es("ERROR grave"), "ERROR grave");
        assert_eq!(es("Usa HTTPS"), "Usa hache te te pe ese");
        assert_eq!(es("Dale OK"), "Dale okéi");
        // An English voice spells acronyms on its own.
        assert_eq!(prepare("The API and the CLI", "en", true, &[]), "The API and the CLI");
    }

    #[test]
    fn abbreviations_are_written_out_and_end_a_sentence_only_when_they_do() {
        assert_eq!(es("Usa un atajo, p. ej. Comando K."), "Usa un atajo, por ejemplo. Comando K.");
        assert_eq!(es("Archivos, carpetas, etc. y más."), "Archivos, carpetas, etcétera y más.");
        assert_eq!(es("Archivos, carpetas, etc. Luego sigue."), "Archivos, carpetas, etcétera. Luego sigue.");
        assert_eq!(es("Habla con el Sr. Pérez y la Sra. Soto."), "Habla con el señor Pérez y la señora Soto.");
        assert_eq!(es("Tarda aprox. 3 minutos."), "Tarda aproximadamente 3 minutos.");
        assert_eq!(es("Ver pág. 4"), "Ver página 4");
        // Inside a word, nothing: «devs.» is not «vs.».
        assert_eq!(es("Los devs."), "Los devs.");
        assert_eq!(prepare("Use a shortcut, e.g. Command K.", "en", true, &[]), "Use a shortcut, for example. Command K.");
    }

    #[test]
    fn a_number_with_its_unit_is_the_unit_in_words() {
        assert_eq!(es("Pesa 500MB y tarda 30ms."), "Pesa 500 megas y tarda 30 milisegundos.");
        assert_eq!(es("Ocupa 1,5GB"), "Ocupa 1,5 gigas");
        assert_eq!(es("El paso 2b"), "El paso 2b");
    }

    #[test]
    fn an_english_word_nobody_listed_gets_its_english_sounds() {
        assert_eq!(english_guess("flash").as_deref(), Some("flach"));
        assert_eq!(english_guess("streaming").as_deref(), Some("strimin"));
        assert_eq!(english_guess("window").as_deref(), Some("uindou"));
        assert_eq!(english_guess("Highlight").as_deref(), Some("Hailait"));
        assert_eq!(english_guess("white").as_deref(), Some("uait"));
        assert_eq!(english_guess("quickly").as_deref(), Some("quikli"));
        // Spanish words have none of the marks.
        for word in ["leer", "cooperar", "creer", "mensaje", "carpeta", "reemplazar", "Pérez", "kilo"] {
            assert_eq!(english_guess(word), None, "{word}");
        }
        assert_eq!(es("Activa el autosave y el streaming."), "Activa el autosave y el strimin.");
    }

    #[test]
    fn an_unreadable_dictionary_is_an_empty_one() {
        assert!(parse_user("not json").is_empty());
        let entries = parse_user(r#"[{"from":" Achs ","to":"a che ese","lang":"es"},{"from":"","to":"x"}]"#);
        assert_eq!(entries, vec![Entry { from: "Achs".into(), to: "a che ese".into(), lang: "es".into() }]);
    }
}
