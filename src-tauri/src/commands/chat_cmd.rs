//! Tauri commands for the `chat` workspace — the full-window, ChatGPT-shaped conversation list
//! that lives beside the repository tools rather than inside one.
//!
//! This is the successor to [`crate::commands::claude_cmd::send_chat_message`], not a second copy
//! of it, and the routing helpers are shared with it rather than duplicated ([`load_ai_config`],
//! [`load_ai_config_as`], [`AiTask`]). What is different here is everything that follows from one
//! premise: **a conversation does not have to be about a repository.** Three of this module's
//! decisions come straight out of that, and each is a decision rather than a default.
//!
//! # 1. A conversation with no repository is read-only
//!
//! The panel's chat runs with edits auto-approved because it is always pointed at a checkout the
//! user is working in, wrapped in a checkpoint pair so anything it does is undoable. A conversation
//! about no repository has neither: no working copy to snapshot, and — crucially — no place the
//! user asked for files to be written. So [`chat_send`] passes `auto_approve_edits: false` and a
//! read-only tool set for it.
//!
//! **This is best-effort for most engines, and it is never a sandbox.** Say it plainly, because the
//! distinction decides whether anyone should rely on it. Two of the six take a tool allow-list and
//! are therefore genuinely limited: Claude Code through `--allowedTools`, and grok through
//! `--tools`. Each names its own set in `AiEngine::read_only_tools` — the vocabularies differ, which
//! is exactly why one hardcoded list here was wrong and why grok spent its first release running
//! these conversations with `write_file` and `bash` in hand.
//!
//! The other four have no allow-list flag at all; their access is a permission or sandbox *mode* of
//! their own, which this app does not set. For those, the whole of the protection is
//! `auto_approve_edits: false` — which means the engine is not told to accept edits, not that the
//! operating system will stop it. A CLI that writes anyway writes.
//! The read-only claim in the UI is therefore about intent, and the honest statement of it is that
//! a repo-less conversation runs in an empty scratch directory ([`crate::paths::chat_scratch_dir`])
//! where there is nothing of the user's to damage — that part is real and does not depend on any
//! engine cooperating.
//!
//! # 2. The lease is per conversation, not per path
//!
//! `ai_locks` keys on a filesystem path because until now every AI run was about a working copy.
//! A repo-less conversation has no path, and the scratch directory is shared by all of them, so
//! leasing *that* would serialise the entire workspace — asking a second question while the first
//! is still thinking would come back "busy" with no repository on screen to explain the word. The
//! unit that matters is the conversation: N of them run at once, one of them runs one turn at a
//! time, which is exactly what the composer already draws. See [`ai_locks::acquire_key`] for why
//! that lives in the same registry rather than a second one.
//!
//! A conversation that *is* bound to a repository takes the path lease as before. It is editing a
//! real checkout, and there the constraint that matters is still "one engine per working copy".
//!
//! # 3. A fresh engine session on a conversation that already has messages replays them
//!
//! No CLI here can be rewound, and three features in this workspace are shaped like a rewind:
//! branching a thread at turn N, switching provider mid-conversation, and regenerating an answer.
//! Each is really "start a new engine session and hand it what came before". That is one rule and
//! it is implemented once, in [`replayed_prefix`]: a turn that is opening a session on a
//! conversation that is not empty sends the stored transcript as context. It is cheap to store and
//! expensive to run — which is why §9 of the spec requires the UI to put a cost chip on the buttons
//! that cause it, rather than this layer pretending it is free.
//!
//! # A note on "only the main window runs anything"
//!
//! That invariant is real elsewhere in the app — `chainStore`, `servicesStore` and `gitActions` all
//! carry an `isMainWindow()` guard — and it is **not** enforced here, deliberately. Those guards
//! exist for things that *dispatch on their own*: a chain executor stepping through work on a timer
//! in three windows at once would run every step three times. A single AI turn is the opposite
//! shape. It is one user gesture, it takes a lease before it does anything (see above), and
//! `ai_runs` is process-global, so a turn started from the quick-ask satellite already shows up in
//! the main window's status bar and is stoppable from there — which is the property the invariant
//! was protecting in the first place.
//!
//! A window-label check *could* be added here. It would cost the quick-ask window a round trip
//! through the main window for every question, in return for nothing this layer needs.

use rusqlite::Connection;
use serde::Serialize;
use tauri::{AppHandle, State};

use crate::ai;
use crate::ai_locks;
use crate::ai_runs;
use crate::ai_accounts;
use crate::commands::claude_cmd::{load_ai_config_as, load_ai_config_in, AiConfig, AiTask};
use crate::commands::skills_cmd::sync_skills_into_project;
use crate::db::models::{ChatConversation, ChatGroup, ChatMessageRow, ChatSearchHit};
use crate::db::{chat_queries, queries, Db};
use crate::git;

/// What a finished turn answers with.
///
/// Field-for-field what [`crate::commands::claude_cmd::ChatReply`] carries, plus `message_id`.
/// Redeclared rather than extended because Rust has no struct inheritance and the alternative —
/// flattening the other one in — would put a `#[serde(flatten)]` between the frontend and a shape
/// it is typed on, for no gain: the two are the same seven fields and are meant to stay that way.
///
/// Snake case, like its sibling. The TS mirror in `chatCommands.ts` spells `message_id` the same
/// way for exactly this reason.
#[derive(Serialize)]
pub struct ChatReply {
    text: String,
    session_id: Option<String>,
    model: Option<String>,
    provider: String,
    engine_version: Option<String>,
    created_at: String,
    response_time_ms: i64,
    /// The id of the row this answer was persisted as.
    ///
    /// The join between the streamed chunks and the finished message. `ai:chat-delta` carries it
    /// from the first chunk onward, long before this reply exists, so a transcript that has been
    /// growing a bubble can tell whether the answer that just landed is the one it was painting.
    /// Minted **before** the run starts, which is what makes that possible at all.
    message_id: String,
    /// Whether this turn compacted the conversation on its way past.
    ///
    /// Returned so the window that asked can say why it waited twice as long and paid for two runs.
    /// The transcript shows the summary on its own — the mark appears at the cut — but it appears
    /// silently, somewhere above the answer the user is reading, and an unexplained double wait
    /// reads as the app having stalled.
    compacted: bool,
    /// Relative paths of the files this turn wrote, already stored on the row above.
    ///
    /// Returned as well as persisted so the window that asked does not have to re-read the
    /// transcript to draw the chips. Without it the file would appear only on the next open — and
    /// on a provider whose answer is uncovered by the typewriter, `open` declines to re-read at
    /// all while the reveal is running, so "not until the next open" would sometimes mean "not
    /// until tomorrow".
    outputs: Vec<String>,
    /// The account that answered — `None` for the system account. Usually the thread's own; it
    /// differs only when that account was deleted and the turn fell back to resolution, which the
    /// row has now been re-stamped with.
    account_id: Option<String>,
}

/// A slash command the composer's `/` menu can offer for a provider. See
/// [`chat_provider_commands`].
#[derive(Serialize)]
pub struct ProviderCommand {
    /// With its leading slash, as the user would type it — `"/model"`.
    pub name: String,
    pub description: String,
    /// `"cli-reported"` | `"documented"` | `"app"`.
    ///
    /// Shown to the user, and not decoration: "cli-reported" means this came out of that binary's
    /// own handshake on this machine and is therefore true of the *installed* version, while
    /// "documented" means the app read a list and never asked the binary. Collapsing the two would
    /// put a command that may not exist next to one that certainly does.
    pub source: String,
}

/// What a repo-less conversation's model is told it is doing.
///
/// Its own prompt rather than `ai.rs`'s, which opens by telling the model it is talking about "the
/// repository the user has open". Handing that to a conversation with no repository is an
/// invitation to go and find one — and with `Read`/`Glob` in hand it would find the scratch
/// directory, or whatever the process happens to be sitting in.
///
/// # Why it defines no role
///
/// It used to open with "eres el asistente de IA integrado en CodeFlow, un cliente Git de
/// escritorio", and the models took that for a job description rather than a setting: asked for a
/// short story, Claude answered that stories fell outside its role and offered to help with Git
/// instead. That is the wrong trade. The agents console is where this app runs work with a defined
/// scope; this chat is the one surface that is supposed to be general, and a user who opens it to
/// draft an email or think through a decision is using it correctly.
///
/// So what is left is the two things that are *true about the environment* — the language to reply
/// in, and the fact that there is no repository in reach — plus a sentence saying in as many words
/// that the absence of a repository is not a restriction on subject matter. That last sentence
/// looks redundant and is not: without it the model infers a coding role from the surrounding
/// tooling anyway, which is exactly the behaviour this prompt now exists to stop.
/// The half that is true whichever mode the conversation is in: what language to answer in, and
/// that there is no assigned role. Composed with one of the two notes below by [`repo_less_prompt`].
const REPO_LESS_PREAMBLE: &str =
    "Responde en el mismo idioma en el que te escribe el usuario. Sé conciso y directo: esto es \
     una conversación, no un reporte formal.\n\n\
     No tienes ningún rol asignado ni ningún tema vedado: responde lo que te pregunten, sea de \
     programación o no. Escribir, explicar, opinar, traducir, hacer cuentas o contar un cuento son \
     todos usos válidos de esta conversación.";

/// The note for a conversation that may not write anything.
///
/// A prohibition on its own is what produced the bug this paragraph was rewritten for: told only
/// that it could not create files, an engine reached for a tool from a different product
/// (`Artifact`), had it refused along with `Write`, and then described to the user an interactive
/// generator that had never existed. A model given only a "no" will look for a loophole, so this
/// names the way that *does* work — the code block, which the UI puts a save button on.
const REPO_LESS_READONLY_NOTE: &str =
    "Nota técnica, no una restricción temática: esta conversación no tiene ningún repositorio \
     abierto, así que no tienes el código del usuario a tu alcance y no puedes escribir archivos \
     en disco. Si algo concreto requiere mirar un repositorio, dilo en lugar de suponer.\n\n\
     Aquí no hay lienzo, artefactos ni paneles interactivos: esta superficie solo muestra texto. \
     No ofrezcas botones, formularios ni herramientas, y no des por hecho que una llamada a una \
     herramienta funcionó — si falla o no existe, dilo en lugar de narrar que salió bien.\n\n\
     Cuando te pidan un archivo —un CSV, un JSON, un Markdown, un script, una consulta SQL—, la \
     forma de entregarlo es escribir su contenido completo dentro de un bloque de código con el \
     lenguaje correcto. La aplicación pone un botón de guardar en cada bloque, así que eso es \
     exactamente lo que el usuario necesita para descargarlo: no digas que no puedes darle el \
     archivo, porque así sí puedes. Pon además el nombre del archivo como comentario en la primera \
     línea del bloque (por ejemplo `# usuarios.csv`): la aplicación lo usa como nombre al guardar, \
     y lo retira del archivo cuando el formato no admite comentarios.\n\n\
     Lo que no cabe en un bloque de texto —Excel, PowerPoint, Word, PDF, imágenes— no puedes \
     entregarlo en esta conversación. Dilo claramente y ofrece la alternativa que sí cabe (un CSV \
     en vez de un .xlsx, por ejemplo) en lugar de fingir que lo creaste.";

/// The note for a conversation that may produce files.
///
/// It says **where**, and it says it twice on purpose. An engine told merely that it may write
/// files writes them wherever its own habits suggest — `~/Desktop`, an absolute path it invented,
/// the last repository it remembers — and the working directory is the only boundary this app
/// actually has (two of the six CLIs honour a tool allow-list; the other four do not). A file
/// written outside it is a file the user is never offered and never told about, which is the one
/// outcome worse than not writing it at all.
///
/// It also keeps steering plain text back to the code block. A `.xlsx` holding two columns of data
/// is worse for the user than a CSV they can see in the transcript before they save it, and an
/// engine handed a writable directory will otherwise reach for a file every time.
const REPO_LESS_WRITABLE_NOTE: &str =
    "Nota técnica, no una restricción temática: esta conversación no tiene ningún repositorio \
     abierto, así que no tienes el código del usuario a tu alcance. Si algo concreto requiere \
     mirar un repositorio, dilo en lugar de suponer.\n\n\
     Aquí no hay lienzo, artefactos ni paneles interactivos: esta superficie solo muestra texto y \
     archivos. No ofrezcas botones ni formularios, y no des por hecho que una llamada a una \
     herramienta funcionó — si falla o no existe, dilo en lugar de narrar que salió bien.\n\n\
     Sí puedes crear archivos, y esta es la única forma en que llegan al usuario: escríbelos en tu \
     directorio de trabajo actual, con rutas relativas y nunca fuera de él. La aplicación lista lo \
     que aparezca ahí y le ofrece un botón para descargarlo. Un archivo escrito en cualquier otro \
     sitio no se lo ofrecemos y el usuario no se entera de que existe.\n\n\
     Para lo que se puede escribir como texto plano —CSV, JSON, Markdown, un script, SQL— basta un \
     bloque de código en la respuesta: cada bloque lleva su propio botón de guardar y el usuario ve \
     el contenido antes de guardarlo, así que es mejor que crear un archivo. Crea archivos de \
     verdad para lo que no cabe en un bloque: Excel, PowerPoint, Word, PDF, imágenes. Di al final \
     qué archivos dejaste y para qué sirve cada uno.\n\n\
     Antes de decir que creaste un archivo, comprueba que está ahí: lista el directorio. Que un \
     comando termine sin error, o que un script tuyo imprima que salió bien, no es lo mismo que \
     que el archivo exista — un intérprete que no está instalado falla de formas que se parecen \
     mucho al éxito. Si no está, dilo y explica qué falló; no anuncies un archivo que el usuario \
     no va a encontrar.";

/// The `app_settings` key holding whether a repo-less chat may produce files.
///
/// **Unset means on.** The capability is the reason the working directory became per-conversation
/// and the reason the header badge had to stop saying "read-only", so shipping it switched off by
/// default would be shipping a feature nobody finds. The switch exists for the person who wants the
/// older, narrower behaviour back.
pub const CHAT_FILE_GENERATION_KEY: &str = "chat_file_generation";

/// The interpreters an engine reaches for when it has to build a binary file, in the order it tends
/// to try them.
const RUNTIMES: [&str; 6] = ["node", "npm", "python3", "python", "pip3", "pip"];

/// Which of [`RUNTIMES`] are actually on this machine's `PATH`.
///
/// The process inherits the user's *login* shell `PATH` (see `shell_env::import_login_path`), which
/// is the same environment the engine's own subprocess gets — so what this finds is what the engine
/// will find, and not a lie told from a different shell.
fn present_runtimes() -> Vec<&'static str> {
    let Some(path) = std::env::var_os("PATH") else { return Vec::new() };
    let dirs: Vec<_> = std::env::split_paths(&path).collect();
    RUNTIMES
        .into_iter()
        .filter(|name| dirs.iter().any(|dir| dir.join(name).is_file()))
        .collect()
}

/// How a package is installed on the machine this build runs on.
///
/// Named at compile time because the answer is a property of the OS, not of the run, and because
/// telling a macOS user to `apt install` is worse than saying nothing: it reads as authoritative
/// and it fails. The model is told the shape of the command and fills in the package.
const INSTALLER: &str = if cfg!(target_os = "macos") {
    "Homebrew (`brew install …`)"
} else if cfg!(target_os = "windows") {
    "winget (`winget install …`)"
} else {
    "el gestor de paquetes de su distribución (apt, dnf, pacman…)"
};

/// What a writable turn is told about the interpreters it may reach for.
///
/// **Observed twice before this existed, and it is the whole justification.** Asked for a slide
/// deck, the engine reached for Python, got `ModuleNotFoundError: No module named 'pptx'`, tried
/// `pip install`, got `command not found: pip` — and then announced the presentation anyway. The
/// machine had `node` the entire time, which is how the *same* request had succeeded an hour
/// earlier. Two wasted tool calls and a file that never existed, because nobody told it which
/// interpreters were in the room.
///
/// # Why the rule is here and not in the UI
///
/// The app knows this list and used to print it in the composer, above every conversation. It was
/// true and useless: a reader who has not asked their question yet does not know which interpreter
/// it will need, and `node npm python3 pip3` answers nothing for them. The fact only means
/// something in the turn that needs it — so the engine is told to check before it commits to a
/// runtime, and to bring the user in when the one it needs is absent instead of failing in private
/// or, worse, narrating a success.
///
/// Naming what is *missing* as well as what is present, because "use node" alone does not stop a
/// model that is confident Python is everywhere. The probe can come back empty on a machine with a
/// stripped `PATH`, and that case gets the rule without the inventory rather than a claim that the
/// machine is bare.
fn runtimes_note() -> String {
    let present = present_runtimes();
    let absent: Vec<&str> = RUNTIMES.into_iter().filter(|name| !present.contains(name)).collect();

    let mut note = String::from(
        "\n\nSobre los intérpretes: antes de escribir código que dependa de uno, comprueba que \
         está (`command -v node`, `command -v python3`). Si el que necesitas no está, no lo \
         sustituyas en silencio por un archivo peor ni des el trabajo por hecho: dile al usuario \
         cuál falta, que aquí se instala con ",
    );
    note.push_str(INSTALLER);
    note.push_str(
        ", y ofrécete a instalarlo — pero espera a que te diga que sí antes de tocar su máquina.",
    );

    if !present.is_empty() {
        note.push_str(&format!(
            " En esta máquina puedes contar con: {}.",
            present.join(", ")
        ));
    }
    if !absent.is_empty() {
        note.push_str(&format!(
            " NO están instalados: {}. Usa lo que hay en vez de gastar intentos en lo que no \
             está, y si te falta una librería instálala con el gestor que sí exista.",
            absent.join(", ")
        ));
    }
    note
}

/// The whole prompt for a repo-less turn, in the mode this conversation is running in.
fn repo_less_prompt(may_write: bool, cwd: &str) -> String {
    if !may_write {
        return format!("{REPO_LESS_PREAMBLE}\n\n{REPO_LESS_READONLY_NOTE}");
    }
    // **The directory by name, not "the current one".** Every engine is given the working directory
    // through `current_dir`, and most of them behave; agy does not, because its brief arrives as a
    // temp file it is told to read and it writes its output next to *that*. A turn asked for a PNG
    // produced one in `/var/folders/.../codeflow-agy-…`, which nothing lists and the OS reclaims.
    // An absolute path in the instruction removes the ambiguity for all six at once.
    //
    // The runtimes matter only where files are actually written; a read-only turn has nothing to
    // run and both sentences would be noise in its context window.
    format!(
        "{REPO_LESS_PREAMBLE}\n\n{REPO_LESS_WRITABLE_NOTE}\n\nTu directorio de trabajo es \
         exactamente este: {cwd}. Escribe ahí los archivos que crees, y en ningún otro sitio — un \
         archivo fuera de esa carpeta no se le ofrece al usuario.{}",
        runtimes_note()
    )
}

/// How much of a stored transcript is replayed into a fresh engine session, in characters.
///
/// A ceiling rather than "all of it" because the thing being protected is the turn the user just
/// asked: the prefix goes on stdin, every engine has some limit on that, and a 300-turn thread
/// branched at the end would push the actual question past whichever limit the engine has. The
/// **tail** is kept when it does not fit, because recency is what a conversation's context
/// overwhelmingly is — and the UI says out loud that a branch is a replay rather than a rewind, so
/// a truncated replay is a weaker version of something already described as approximate, not a
/// silent lie about a rewind that happened.
const REPLAY_CHAR_BUDGET: usize = 40_000;

// ===================== conversations =====================

/// Opens a conversation. `project_id` is `None` for the ordinary case — a chat about nothing.
#[tauri::command]
pub fn chat_create_conversation(
    db: State<'_, Db>,
    workspace_id: String,
    project_id: Option<String>,
    provider: String,
    model: String,
    account: Option<String>,
) -> Result<ChatConversation, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    // Which account the thread runs as is settled now, once, and stamped: its sessions will live in
    // that account's directory, so a later change of default must not move a thread out from under
    // them. `account` is the composer's explicit pick; without one it is resolved for the workspace
    // the thread was started in — the same answer every other chat surface there gets.
    let account_id = if provider.trim().is_empty() {
        None
    } else {
        ai_accounts::resolve(
            &conn,
            &provider,
            Some(AiTask::Chat.key()),
            Some(&workspace_id),
            ai_accounts::Choice::parse(account.as_deref()),
        )
        .account_id
    };
    // The system prompt is chosen per turn, from whether the conversation has a repository (see
    // [`chat_send`]), so the column is left empty rather than frozen at creation. It exists for a
    // conversation whose prompt the *user* sets, which nothing offers yet.
    chat_queries::create_conversation(
        &conn,
        &workspace_id,
        project_id.as_deref(),
        &provider,
        account_id.as_deref(),
        &model,
        "",
    )
    .map_err(|e| e.to_string())
}

/// The sidebar's list: flat and global, pinned first then by recency. Not filtered by workspace —
/// see the `chat_conversations` table comment for why the column is stamped and not queried on.
#[tauri::command]
pub fn chat_list_conversations(
    db: State<'_, Db>,
    include_archived: Option<bool>,
) -> Result<Vec<ChatConversation>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    chat_queries::list_conversations(&conn, include_archived.unwrap_or(false))
        .map_err(|e| e.to_string())
}

/// One conversation's transcript.
///
/// **`with_trace` defaults to `false`, and that default is load-bearing.** A single agentic turn's
/// trace runs to hundreds of kilobytes; a thirty-turn conversation loaded with traces moves on the
/// order of eighteen megabytes across the IPC boundary to draw a list of bubbles that shows none of
/// it. The frontend re-reads a conversation on every revisit (it keeps five transcripts live and
/// evicts the rest), so this is not a one-off cost — it is the cost of clicking around the sidebar.
#[tauri::command]
pub fn chat_get_conversation(
    db: State<'_, Db>,
    conversation_id: String,
    with_trace: Option<bool>,
) -> Result<Vec<ChatMessageRow>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    chat_queries::list_messages(&conn, &conversation_id, with_trace.unwrap_or(false))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn chat_rename_conversation(
    db: State<'_, Db>,
    conversation_id: String,
    title: String,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    chat_queries::rename(&conn, &conversation_id, &title).map_err(|e| e.to_string())
}

/// Clears (or sets) a conversation's unread mark.
///
/// The clearing half is what `open` calls. The setting half exists for completeness and for a
/// future "mark as unread" — nothing calls it with `true` today, because the send path sets the
/// flag where the answer is written.
#[tauri::command]
pub fn chat_set_unread(
    db: State<'_, Db>,
    conversation_id: String,
    unread: bool,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    chat_queries::set_unread(&conn, &conversation_id, unread).map_err(|e| e.to_string())
}

/// Points this conversation at a provider/model pair, for as long as it lives.
///
/// The conversation's own engine is what `chat_send` runs on — not the workspace's chat routing —
/// so this is the only way to change what a thread talks to. See [`chat_queries::set_engine`] for
/// why a provider change drops the resume token and a model change does not.
///
/// `account` is what the picker chose — an account id, `system`, or nothing for "automatic", which
/// is resolved here for the thread's own workspace and stamped. Picking a different account than
/// the thread has drops its resume token, exactly as picking a different provider does.
#[tauri::command]
pub fn chat_set_engine(
    db: State<'_, Db>,
    conversation_id: String,
    provider: String,
    model: String,
    account: Option<String>,
) -> Result<Option<String>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let conversation = chat_queries::get_conversation(&conn, &conversation_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "conversation not found".to_string())?;
    // No account named and the provider unchanged: the thread keeps the account it has. Only an
    // explicit pick, or a move to another provider, resolves a new one.
    let account_id = match (account.as_deref(), provider == conversation.provider) {
        (None, true) => conversation.account_id.clone(),
        (choice, _) => ai_accounts::resolve(
            &conn,
            &provider,
            Some(AiTask::Chat.key()),
            Some(&conversation.workspace_id),
            ai_accounts::Choice::parse(choice),
        )
        .account_id,
    };
    chat_queries::set_engine(&conn, &conversation_id, &provider, account_id.as_deref(), &model)
        .map_err(|e| e.to_string())?;
    // Handed back so the window can name the account on the chip without a second read — an
    // automatic pick is only known once it has been resolved here.
    Ok(account_id)
}

// ---------- turns in flight ----------

/// A chat turn the engine is still working on, as the UI needs to rebuild it.
///
/// # Why this registry exists at all
///
/// A turn's visible state — the spinner, the Stop button, the streaming text — used to live only in
/// the `conversationStore` of the webview that started it. That is wrong for this app in a way that
/// shows up the moment anyone uses it: every window has its own store, so detaching the chat into a
/// satellite gave the new window a store that had never heard of the run, and it drew nothing while
/// the engine was plainly still working. Re-attaching produced the mirror image — the turn had
/// vanished, and it looked as though closing the window had killed it.
///
/// Nothing had died. The run lives in the Rust process, and it outlives any window, any workspace
/// switch and any view change. What was missing was a way to *ask*. So the process keeps the list,
/// and a window that opens mid-turn rebuilds its own state from it instead of assuming it started
/// everything it is showing.
///
/// `ai_runs::active()` is not enough on its own: it answers "which run ids exist", and the chat
/// needs to know which *conversation* each belongs to and which message id the deltas are landing
/// under. Those are chat facts, so they live here rather than being pushed into the generic run
/// registry.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InflightTurn {
    pub conversation_id: String,
    pub run_id: String,
    /// The row the answer will be written as, and the key `ai:chat-delta` carries — which is what
    /// lets an adopting window render the tokens already arriving.
    pub message_id: String,
    pub provider: String,
    /// Milliseconds since the epoch, so an adopting window's elapsed timer starts from when the
    /// turn really began rather than from when that window happened to open.
    pub started_at_ms: i64,
}

fn inflight() -> &'static std::sync::Mutex<std::collections::HashMap<String, InflightTurn>> {
    static INFLIGHT: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<String, InflightTurn>>,
    > = std::sync::OnceLock::new();
    INFLIGHT.get_or_init(Default::default)
}

/// Removes the entry when the turn ends, by any route.
///
/// A guard rather than a pair of calls, for the reason [`ai_locks::RepoLease`] is one: `chat_send`
/// returns from a dozen places — a refusal, a cancellation, an engine error, a panic — and a
/// registry that leaked on any of them would leave a conversation showing a spinner forever, in
/// every window, until the app restarted.
pub struct InflightGuard(String);

impl Drop for InflightGuard {
    fn drop(&mut self) {
        if let Ok(mut held) = inflight().lock() {
            held.remove(&self.0);
        }
    }
}

fn mark_inflight(turn: InflightTurn) -> InflightGuard {
    let key = turn.conversation_id.clone();
    if let Ok(mut held) = inflight().lock() {
        held.insert(key.clone(), turn);
    }
    InflightGuard(key)
}

/// Every chat turn the process is currently working on.
///
/// Called by each window as it starts, and again whenever one opens a conversation, so a window
/// that appeared mid-turn shows the same thing the one that asked the question shows. Safe to call
/// often — it is a lock and a clone of a map that holds one entry per running turn.
#[tauri::command]
pub fn chat_inflight_turns() -> Vec<InflightTurn> {
    inflight().lock().map(|held| held.values().cloned().collect()).unwrap_or_default()
}

/// Sets how hard the model thinks, for every future turn of this conversation.
///
/// Per conversation rather than global, because the level is a property of the question: "read
/// this stack trace and tell me why" wants `max`, and "what is the flag for X" does not want to
/// pay for it. Empty clears it and hands the decision back to the CLI's own configuration.
///
/// Not every engine spends the same thing on it, and the UI says which — see
/// `ai::AiEngine::supports_effort`.
#[tauri::command]
pub fn chat_set_effort(
    db: State<'_, Db>,
    conversation_id: String,
    effort: String,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    chat_queries::set_effort(&conn, &conversation_id, &effort).map_err(|e| e.to_string())
}

/// Which providers accept a reasoning level, and therefore whether the composer draws the control.
///
/// Answered by the engines themselves rather than by a list here, so a seventh engine is one
/// `effort_args` implementation and not two places to remember.
///
/// The **engine** half of the question, and the half that can be answered once at startup. The
/// model half moves with the picker and is [`chat_model_effort_support`].
#[tauri::command]
pub fn chat_effort_support() -> Vec<String> {
    // Built from the same ids `ai::engine_for` dispatches on, asked one at a time rather than from
    // a second list: the answer comes out of each engine's own mapping, so an engine that gains or
    // loses the flag reports the change here without this function being touched.
    ["claude", "gemini", "codex", "grok", "opencode", "cline"]
        .into_iter()
        .filter(|id| ai::engine_for(id).supports_effort())
        .map(str::to_string)
        .collect()
}

/// Whether the level would reach a model that can use it — asked per `(provider, model)` pair.
///
/// Separate from [`chat_effort_support`] because the two change on different clocks. Whether a CLI
/// has the flag is fixed for a build; which model it is pointed at changes every time the user
/// opens the picker, and for opencode and cline that model can be anything their configured
/// providers serve. Codex answers from its own catalog, everything else from the name rule in
/// `ai::model_is_known_non_reasoning`, which is written to fail towards showing the control.
#[tauri::command]
pub fn chat_model_effort_support(provider: String, model: String) -> bool {
    ai::engine_for(&provider).model_supports_effort(&model)
}

/// Sets the compression style every future answer in this conversation comes back in.
///
/// `""` turns it off; anything else must be one of [`crate::caveman::LEVELS`] and is refused
/// otherwise rather than stored — a column holding a level nothing recognises would silently answer
/// in no style at all, which looks exactly like the command not working.
#[tauri::command]
pub fn chat_set_caveman(db: State<'_, Db>, conversation_id: String, level: String) -> Result<(), String> {
    if !level.is_empty() && !crate::caveman::valid(&level) {
        return Err(format!("unknown caveman level: {level}"));
    }
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    chat_queries::set_caveman_level(&conn, &conversation_id, &level).map_err(|e| e.to_string())
}

/// The levels this build knows, in the order a picker should show them. Read from the backend
/// rather than listed in the frontend for the same reason the context windows are: `chat_send`
/// decides with this list, and a second copy would let the picker offer a level the turn refuses.
#[tauri::command]
pub fn chat_caveman_levels() -> Vec<String> {
    crate::caveman::LEVELS.iter().map(|level| level.to_string()).collect()
}

/// Turns what the user typed after `/caveman` into a level to store.
///
/// `Some("")` means they asked to stop, `Some(level)` is a level, and `None` means the word is
/// neither — which the caller reports with the list, in the user's language, rather than this
/// returning an `Err` whose English sentence would end up in a Spanish toast.
///
/// A round trip for a string comparison, and worth it: the vocabulary — the default, the words for
/// "stop", the level names — is one thing, and the half of it that lived in the frontend was the
/// half that would not be updated when a level was added. See [`crate::caveman::resolve`].
#[tauri::command]
pub fn chat_caveman_resolve(argument: String) -> Option<String> {
    crate::caveman::resolve(&argument)
}

/// This model's context window in tokens, or `null` when the app will not name one.
///
/// Asked of the backend rather than kept in a table beside the meter, because the backend is the
/// other consumer: [`auto_compact_if_full`] decides with the same number the ring is drawn from, so
/// a conversation cannot be at 92% on screen while the turn that follows it thinks there is room.
/// Two tables would have agreed on the day they were written and drifted on the first model that
/// was added to one of them.
///
/// `null` is a real answer — see [`ai::context_window_for`] — and the caller has to render it as
/// one rather than falling back to a plausible number.
#[tauri::command]
pub fn chat_context_window(model: String) -> Option<i64> {
    ai::context_window_for(&model)
}

// ---------- groups ----------

/// The sidebar's folders, each with a live count of what is filed in it.
#[tauri::command]
pub fn chat_list_groups(db: State<'_, Db>) -> Result<Vec<ChatGroup>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    chat_queries::list_groups(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn chat_create_group(db: State<'_, Db>, name: String, color: String) -> Result<ChatGroup, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    chat_queries::create_group(&conn, name.trim(), &color).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn chat_rename_group(
    db: State<'_, Db>,
    group_id: String,
    name: String,
    color: String,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    chat_queries::rename_group(&conn, &group_id, name.trim(), &color).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn chat_set_group_instructions(
    db: State<'_, Db>,
    group_id: String,
    instructions: String,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    chat_queries::set_group_instructions(&conn, &group_id, &instructions).map_err(|e| e.to_string())
}

/// Removes a folder. Its conversations return to the ungrouped list — **deleting a folder never
/// deletes what is in it**, which is the one rule this whole feature has to get right.
/// Pins a folder to the top of the list, or unpins it.
#[tauri::command]
pub fn chat_set_group_pinned(db: State<'_, Db>, group_id: String, pinned: bool) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    chat_queries::set_group_pinned(&conn, &group_id, pinned).map_err(|e| e.to_string())
}

/// Puts a folder on the shelf, or takes it back off.
///
/// Deliberately **not** a delete and deliberately not recursive: the conversations keep their
/// `group_id` and their files, so restoring the folder restores everything that was in it. The only
/// thing that changes is whether the sidebar draws it.
#[tauri::command]
pub fn chat_set_group_archived(db: State<'_, Db>, group_id: String, archived: bool) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    chat_queries::set_group_archived(&conn, &group_id, archived).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn chat_delete_group(db: State<'_, Db>, group_id: String) -> Result<(), String> {
    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        chat_queries::delete_group(&conn, &group_id).map_err(|e| e.to_string())?;
    }
    // The conversations survive — that is the rule this whole feature rests on — but the project's
    // own reference documents do not: nothing can reach them once the project they described is
    // gone. Outside the lock and after the row, for the same reason a conversation's attachments
    // are: the database is the record of what exists, and a locked file must not leave a project
    // the user asked to delete still listed.
    super::chat_attach::discard_group_context(&group_id);
    Ok(())
}

#[tauri::command]
pub fn chat_set_group_collapsed(
    db: State<'_, Db>,
    group_id: String,
    collapsed: bool,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    chat_queries::set_group_collapsed(&conn, &group_id, collapsed).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn chat_reorder_groups(db: State<'_, Db>, ids: Vec<String>) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    chat_queries::reorder_groups(&conn, &ids).map_err(|e| e.to_string())
}

/// Files a conversation under a folder, or returns it to the ungrouped list with `None`.
#[tauri::command]
pub fn chat_set_conversation_group(
    db: State<'_, Db>,
    conversation_id: String,
    group_id: Option<String>,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    chat_queries::set_conversation_group(&conn, &conversation_id, group_id.as_deref())
        .map_err(|e| e.to_string())
}

/// Deletes the conversation and, by `ON DELETE CASCADE`, every message under it.
#[tauri::command]
pub fn chat_delete_conversation(db: State<'_, Db>, conversation_id: String) -> Result<(), String> {
    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        chat_queries::delete_conversation(&conn, &conversation_id).map_err(|e| e.to_string())?;
    }
    // After the row is gone, not before, and outside the lock: the database is the record of what
    // exists, so a failure to remove the files must not leave a conversation the user asked to
    // delete still listed. Whatever this misses is collected by `chat_sweep_attachments` on the
    // next launch — which is also what covers the paths that never reach this function at all, like
    // a workspace deletion cascading rows away.
    super::chat_attach::discard_conversation_attachments(&conversation_id);
    super::chat_attach::discard_conversation_outputs(&conversation_id);
    Ok(())
}

#[tauri::command]
pub fn chat_set_pinned(
    db: State<'_, Db>,
    conversation_id: String,
    pinned: bool,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    chat_queries::set_pinned(&conn, &conversation_id, pinned).map_err(|e| e.to_string())
}

/// Archiving is the user saying "not now", not "delete": the rows stay and search still reaches
/// them; the default list stops carrying them.
#[tauri::command]
pub fn chat_set_archived(
    db: State<'_, Db>,
    conversation_id: String,
    archived: bool,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    chat_queries::set_archived(&conn, &conversation_id, archived).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn chat_search_conversations(
    db: State<'_, Db>,
    query: String,
    limit: Option<u32>,
) -> Result<Vec<ChatSearchHit>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    chat_queries::search(&conn, &query, limit.unwrap_or(30)).map_err(|e| e.to_string())
}

/// Forks a conversation at `at_turn` into a new one carrying everything up to and including that
/// turn.
///
/// **The prefix is copied, and the engine session deliberately is not.** Copying the rows is what
/// makes the fork readable — it opens showing the conversation it came from rather than a blank
/// thread claiming a parent. Leaving `engine_session_id` NULL is what makes it *correct*: resuming
/// the parent's session would continue the parent, so the two threads would write into one CLI
/// conversation and the fork would silently inherit turns taken after the branch point. The first
/// turn on the fork therefore opens a fresh session, and [`replayed_prefix`] hands it the copied
/// transcript as context — which is the honest shape of "branch" for a CLI that cannot rewind.
///
/// Message ids are new. They are the addressing for streaming deltas and for the trace, and two
/// rows sharing one would put a chunk in the wrong bubble.
#[tauri::command]
pub fn chat_branch_conversation(
    db: State<'_, Db>,
    conversation_id: String,
    at_turn: i64,
) -> Result<ChatConversation, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let parent = chat_queries::get_conversation(&conn, &conversation_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "conversation not found".to_string())?;

    let fork = chat_queries::create_conversation(
        &conn,
        &parent.workspace_id,
        parent.project_id.as_deref(),
        &parent.provider,
        parent.account_id.as_deref(),
        &parent.model,
        &parent.system_prompt,
    )
    .map_err(|e| e.to_string())?;

    // Written here rather than through a `chat_queries` helper because the spec listed no branch
    // function and this is the only caller; if a second one appears, this is the paragraph that
    // moves.
    //
    // The title is inherited rather than left blank. Two rows reading the same in the sidebar is
    // the truth — up to `at_turn` they *are* the same conversation — and the alternative is worse:
    // an empty title makes the fork autotitle from the copied first message, which produces the
    // parent's title anyway, only after a turn has run and with any title the user typed by hand
    // thrown away on the way. The fork is told apart by `parent_conversation_id`, which the UI has.
    conn.execute(
        "UPDATE chat_conversations SET parent_conversation_id = ?2, branched_at_turn = ?3,
             title = ?4 WHERE id = ?1",
        rusqlite::params![fork.id, parent.id, at_turn, parent.title],
    )
    .map_err(|e| e.to_string())?;

    // Traces are not copied. They are by far the heaviest column, they describe a run that happened
    // under the *parent's* run id, and nothing in the fork can act on them — the fork's own turns
    // will write their own.
    let prefix = chat_queries::list_messages(&conn, &parent.id, false).map_err(|e| e.to_string())?;
    for message in prefix.into_iter().filter(|m| m.turn <= at_turn) {
        let copy = ChatMessageRow {
            id: uuid::Uuid::new_v4().to_string(),
            conversation_id: fork.id.clone(),
            // Turn numbers are kept, not renumbered: `branched_at_turn` is only meaningful if the
            // two threads agree on what turn N is.
            ..message
        };
        chat_queries::append_message(&conn, &copy).map_err(|e| e.to_string())?;
    }

    chat_queries::get_conversation(&conn, &fork.id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "conversation not found".to_string())
}

// ===================== one turn =====================

/// Runs one turn of a conversation and resolves when it is over.
///
/// The ordering here is the whole design, and each step is where it is for a reason:
///
/// 1. **The lease first**, before any work — so a conversation that is already running costs no
///    checkpoint and records no row, and a refusal is a free retry.
/// 2. **The user's message is persisted before the engine starts.** A run that is cancelled, that
///    fails, or that takes four minutes must not be able to lose the question that caused it. It
///    also means the thread is titled ([`chat_queries::autotitle_from_first_message`]) and sorted
///    to the top of the sidebar from the moment the user presses send, rather than when the answer
///    lands.
/// `attachments` carries attachment **ids** — the file names under this conversation's own
/// directory, as `commands::chat_attach` reported them — and deliberately not paths. The frontend
/// therefore never gets to name a file outside the folder the app owns, which is the difference
/// between attaching a document and handing an engine an arbitrary path to go and read.
///
/// 3. **The assistant's message id is minted before the run**, because it is the address the
///    streamed chunks carry. Handing it back at the end would make it useless to the one consumer
///    that needs it during.
/// 4. The reply — or the cancellation, or the error — is persisted after, with `is_cancelled` /
///    `is_error` set. This is a deliberate difference from `send_chat_message`, which files errors
///    and drops cancellations: `activity_log` had no column to say "the user stopped this", so a
///    cancelled turn there could only be recorded as a permanent-looking failure. `chat_messages`
///    has the column, and a transcript that quietly loses the turn you stopped is a transcript with
///    a hole in it — the question is still above it, now answered by nothing.
#[tauri::command]
pub async fn chat_send(
    app: AppHandle,
    db: State<'_, Db>,
    conversation_id: String,
    message: String,
    run_id: Option<String>,
    provider: Option<String>,
    model: Option<String>,
    stream: Option<bool>,
    attachments: Option<Vec<String>>,
) -> Result<ChatReply, String> {
    let conversation = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        chat_queries::get_conversation(&conn, &conversation_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "conversation not found".to_string())?
    };

    // Resolved from ids to real files before anything else touches them. An id that no longer names
    // a file is dropped silently rather than failing the turn: the copy may have been removed by
    // the sweep or by the user between composing and sending, and refusing to answer a question
    // because one of three attachments went missing helps nobody. What the model is told about is
    // exactly what is on disk at this moment.
    let attachments: Vec<ai::AiAttachment> = attachments
        .unwrap_or_default()
        .iter()
        .filter_map(|id| {
            let listed = super::chat_attach::chat_list_attachments(conversation_id.clone()).ok()?;
            let found = listed.into_iter().find(|a| &a.id == id)?;
            Some(ai::AiAttachment { path: found.path, name: found.name, is_image: found.is_image })
        })
        .collect();

    // The universal channel, and the reason attachments work on all six engines rather than on the
    // two with a flag: the message itself names the absolute paths. Every one of these CLIs is an
    // agent with a file-reading tool, so "attaching" a document to one is telling it where the
    // document is. The engines that can do better also get `attachment_args`; this line is what
    // makes the feature exist for the rest.
    let message = if attachments.is_empty() {
        message
    } else {
        let list = attachments
            .iter()
            .map(|a| format!("- {} ({})", a.name, a.path))
            .collect::<Vec<_>>()
            .join("\n");
        format!("{message}\n\nArchivos adjuntos a este mensaje (léelos con tu herramienta de lectura de archivos):\n{list}")
    };

    /*
     * The compression style, if this conversation is in one.
     *
     * Read here and appended **only to what the engine receives**, further down — never to the row
     * that goes in the transcript. Two reasons, and the second is the one that would bite: the
     * bubbles have to keep the user's own words, and `replayed_prefix` replays those rows, so a
     * stored instruction would be re-sent once per past turn on the next fresh session. Twelve
     * turns in, the context would be mostly copies of a rule about brevity.
     *
     * On every turn rather than in the system prompt, because a resumed session is never sent one
     * — see `crate::caveman` for the whole argument.
     */
    let caveman = crate::caveman::instruction(&conversation.caveman_level);

    // Everything this turn is filed against — the conversation id, and the `workspace_id` on the row
    // just read — is captured here, before the first await, and never read back afterwards. That is
    // the run-isolation rule, and the failure it prevents is specific: a workspace re-read after a
    // four-minute run describes whichever workspace the user has switched to since, so the turn
    // would be filed against the wrong one. The row is the capture; nothing below re-queries it.

    // A repository, if this conversation has one. Resolved before the lease so a conversation
    // pointing at a project that no longer exists fails on the project rather than on the lock.
    let project = match conversation.project_id.as_deref() {
        Some(project_id) => {
            let conn = db.0.lock().map_err(|e| e.to_string())?;
            queries::get_project(&conn, project_id).map_err(|e| e.to_string())?
        }
        None => None,
    };

    // See the module note. Two units of exclusion because there are two things worth protecting:
    // a working copy from a second engine, and a conversation from a second turn of its own.
    //
    // Both refusals carry [`ai_locks::BUSY_MARKER`], which the frontend already knows how to tell
    // apart from a genuine engine failure — a refused turn never reached an engine, so filing it as
    // a red bubble would be a lie about something that did not happen. For a conversation the
    // marker's name is the thread's own title, which is a small stretch of a constant called
    // `REPO_BUSY` and is worth it: one marker means one branch on the frontend rather than two, and
    // this path is a backstop in the first place (the composer's own Send/Stop state holds the
    // ordinary case; what gets here is a second *window* — the quick-ask box and the main sidebar
    // pointed at the same thread).
    let _lease = match project.as_ref() {
        Some(project) => ai_locks::acquire(&project.local_path)
            .ok_or_else(|| format!("{}{}", ai_locks::BUSY_MARKER, project.name))?,
        None => ai_locks::acquire_key(&conversation_id).ok_or_else(|| {
            // An untitled thread is the common case for the first few seconds of its life — the
            // title is written from the first message — so the id stands in rather than leaving the
            // toast naming nothing at all.
            let name =
                if conversation.title.trim().is_empty() { &conversation_id } else { &conversation.title };
            format!("{}{name}", ai_locks::BUSY_MARKER)
        })?,
    };

    // Routing, most specific first: what this turn asked for, then what the conversation was
    // opened on, then the global `chat` route. The middle step is what keeps a reopened
    // conversation answering on the engine that wrote it after the user has changed their default —
    // the alternative is a thread whose second half is a different model with no record of why.
    //
    // Read on its own, ahead of everything else, because the automatic compaction below runs *this*
    // engine and has to know which one it is before the turn's context is assembled.
    let config = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        conversation_config(&conn, &conversation, provider.as_deref(), model.as_deref())?
    };

    // A resume token minted by a different engine — or by another account of the same one — is
    // not portable: see `claude_cmd::session_for_engine` for the full argument. Here the pair that
    // minted it is on the conversation row itself rather than needing a query.
    let session_id = conversation
        .engine_session_id
        .clone()
        .filter(|_| conversation.provider == config.provider)
        .filter(|_| conversation.account_id.as_deref() == config.account_id());

    /*
     * Compacting *before* the question rather than leaving it to the user to notice.
     *
     * The thing being prevented is a turn that does not fit, and its two shapes are both silent.
     * On the replay path this app quietly drops the oldest turns at `REPLAY_CHAR_BUDGET` and
     * answers anyway, from a conversation whose beginning is gone; on a resumed session the CLI
     * either refuses the prompt or does its own truncation, which the user sees as the model
     * becoming forgetful rather than as a limit being reached.
     *
     * Here rather than in the frontend for three reasons: this is where the prefix is actually
     * built, so "how big is what we are about to send" is a measurement instead of an estimate;
     * the lease is already held, so compact-then-send is one indivisible operation rather than two
     * calls another window can slip between; and every caller gets it — the quick-ask box and the
     * satellites go through this function too, and none of them draws a meter.
     *
     * It happens before the user's message is appended, so the summary covers the conversation as
     * it was *asked about*, and the question that triggered it is sent verbatim on top.
     */
    let auto_compacted = auto_compact_if_full(
        &app,
        &db,
        &conversation,
        &config,
        session_id.as_deref(),
        run_id.as_deref(),
    )
    .await;
    // Cleared by `set_compaction`, and the local copy has to follow it: the row was read before the
    // compaction, so its token is still in this variable and resuming it would continue the very
    // session whose contents were just replaced with a summary.
    let session_id = session_id.filter(|_| !auto_compacted);

    let (contexts, skills) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;

        // The workspace's review contexts describe how this team's *repositories* should be read.
        // A conversation about no repository is not that, so it gets none — and gets, instead,
        // whatever transcript it already has (see `replayed_prefix`).
        let mut contexts: Vec<(String, String)> = Vec::new();
        if session_id.is_none() {
            if let Some(prefix) = replayed_prefix(&conn, &conversation_id) {
                contexts.push(("Conversation so far".to_string(), prefix));
            }
        }
        if project.is_some() {
            let workspace_contexts =
                queries::list_review_contexts(&conn, &conversation.workspace_id)
                    .map_err(|e| e.to_string())?;
            contexts.extend(
                workspace_contexts.into_iter().filter(|c| c.enabled).map(|c| (c.name, c.content)),
            );
        }

        // The project's shared context files, if this conversation is filed under one. They ride
        // `contexts` rather than `attachments` for one reason, and it is the reason `contexts`
        // exists: `chat_turn` sends these **once per engine session** and an attachment is named on
        // every turn. A project's reference documents are established facts about the conversation,
        // not something handed over with a particular question, so repeating them in message after
        // message would be both noise and money.
        //
        // The content is the path, not the file: these are PDFs and documents, and every engine
        // here has a tool that reads one. Inlining them would put a megabyte of extracted text in
        // front of a model that may not need any of it.
        if let Some(group_id) = conversation.group_id.as_deref() {
            for file in super::chat_attach::group_context_files(group_id) {
                contexts.push((
                    format!("Documento del proyecto — {}", file.name),
                    format!("está en {}; léelo con tu herramienta de lectura de archivos cuando lo necesites", file.path),
                ));
            }
        }

        let skills = match project.as_ref() {
            Some(_) => queries::list_workspace_skills(&conn, &conversation.workspace_id)
                .map_err(|e| e.to_string())?,
            // Skills are synced *into a repository*, which is the one thing this conversation does
            // not have. Nothing to sync and nowhere to sync it.
            None => Vec::new(),
        };

        (contexts, skills)
    };

    if let Some(project) = project.as_ref() {
        let _ = sync_skills_into_project(&skills, &conversation.workspace_id, &project.local_path);
    }

    // Both ids exist before anything can await, for the two different reasons in the doc above.
    let assistant_message_id = uuid::Uuid::new_v4().to_string();
    let turn = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let turn = chat_queries::next_turn(&conn, &conversation_id).map_err(|e| e.to_string())?;
        chat_queries::append_message(
            &conn,
            &ChatMessageRow {
                id: uuid::Uuid::new_v4().to_string(),
                conversation_id: conversation_id.clone(),
                turn,
                role: "user".to_string(),
                content: message.clone(),
                // Stamped on the question too, not only on the answer: which engine a question was
                // *asked of* is what makes a thread whose provider changed mid-way readable.
                provider: Some(config.provider.clone()),
                model: None,
                engine_version: None,
                response_time_ms: None,
                is_error: false,
                is_cancelled: false,
                trace: None,
                // A question writes nothing; only the answer can.
                outputs: None,
                created_at: String::new(),
            },
        )
        .map_err(|e| e.to_string())?;
        // A no-op once the thread has any title, including one the user typed, so calling it every
        // turn is both safe and intended. It does not bump `updated_at` — the append above already
        // did.
        let _ = chat_queries::autotitle_from_first_message(&conn, &conversation_id);
        turn
    };

    // Asked for whenever the caller asked, without checking the provider: the engine's own
    // `streams_partial()` decides whether a sink is honoured, so a sink set for a CLI that cannot
    // type is ignored rather than misread. See `ai::AiInvocation::stream_deltas`.
    let stream_deltas = stream.unwrap_or(false).then(|| ai::DeltaSink {
        conversation_id: conversation_id.clone(),
        message_id: assistant_message_id.clone(),
    });

    /*
     * Whether a repo-less turn may produce files, read per turn rather than held.
     *
     * Per turn because the switch is in settings and the conversation on screen is the one that
     * has to obey it immediately — a flag captured when the conversation was created would mean
     * turning the capability off leaves the chats you already have still writing.
     *
     * Unset is on; see `CHAT_FILE_GENERATION_KEY`. A database that will not answer falls back to
     * on as well, which is the direction that keeps a broken read from silently removing a
     * capability the user configured.
     */
    let may_generate_files = project.is_none()
        && db
            .0
            .lock()
            .ok()
            .and_then(|conn| queries::get_setting(&conn, CHAT_FILE_GENERATION_KEY).ok().flatten())
            .map(|raw| raw != "false")
            .unwrap_or(true);

    let allowed_tools: Vec<String> = match project.as_ref() {
        // A repo-bound conversation keeps today's behaviour: the user's configured tool list, and
        // edits auto-approved, wrapped in a checkpoint.
        Some(_) => config.tools.clone(),
        // A repo-less conversation that may generate files needs the same list, and for the
        // obvious reason: a spreadsheet is produced by writing a script and running it, so
        // stripping `Write` and `Bash` is stripping the feature. What keeps this bounded is not
        // the list — four of the six engines ignore it — it is the working directory below, which
        // holds nothing of the user's.
        None if may_generate_files => config.tools.clone(),
        // Asked of the engine, in its own vocabulary. This used to be one hardcoded list in Claude
        // Code's names, which meant grok — whose tools are called `read_file` and `list_dir` —
        // received nothing it recognised and ran a read-only conversation with its full agent
        // profile, `write_file` and `bash` included.
        None => config.engine.read_only_tools(),
    };
    // Auto-approval, not "may write": an engine that has to ask permission it has no way to be
    // granted is an engine that stops halfway and narrates a file it never created — which is
    // exactly what this conversation's first attempt at a spreadsheet did.
    let write_access = project.is_some() || may_generate_files;

    // The turn's working directory. Created lazily, here, because this is the first moment anyone
    // needs it to exist — and if it cannot be created there is still somewhere to run: the failure
    // is reported rather than silently falling back to the process's own cwd, which is exactly the
    // tree this directory exists to keep an engine out of.
    //
    // Per conversation, and that is what makes the files findable afterwards: everything the turn
    // leaves here belongs to this chat and to no other, so listing the directory *is* the answer
    // to "what did this conversation make?" with no second record to keep in step. See
    // `paths::chat_conversation_outputs_dir`.
    let cwd = match project.as_ref() {
        Some(project) => project.local_path.clone(),
        None => {
            let dir = crate::paths::chat_conversation_outputs_dir(&conversation_id);
            std::fs::create_dir_all(&dir).map_err(|e| {
                format!("could not create the chat working directory ({}): {e}", dir.display())
            })?;
            dir.to_string_lossy().to_string()
        }
    };

    // Skills, for a repo-less turn that may write. `sync_skills_into_project` above covers the
    // repository case; this is the same thing for the working directory, and it is what makes
    // "give me an .xlsx" reach a skill that knows how to build one. Best-effort: a skill that
    // fails to copy is a capability the turn does not have, not a turn that must not run.
    if may_generate_files {
        let _ = sync_skills_into_project(&skills, &conversation.workspace_id, &cwd);
    }

    // The system prompt for this turn: the base one, plus the project's standing instructions when
    // the conversation is filed under one.
    //
    // **Appended, never substituted.** The base prompt is what tells a repo-less engine that it has
    // no repository in reach and must not create files; a user who wrote "answer in English" in a
    // project has not asked to have that lifted. Read fresh from the group on every turn rather
    // than copied onto the conversation when it was created, so editing a project's instructions
    // changes what its existing chats are told next time they run — which is what the word
    // implies, and what a snapshot would quietly fail to do.
    let system_prompt: Option<String> = {
        let base = project.is_none().then(|| repo_less_prompt(may_generate_files, &cwd));
        let project_instructions = conversation
            .group_id
            .as_deref()
            .and_then(|group_id| {
                let conn = db.0.lock().ok()?;
                chat_queries::get_group(&conn, group_id).ok().flatten()
            })
            .map(|group| group.instructions)
            .filter(|text| !text.trim().is_empty());
        match (base, project_instructions) {
            (Some(base), Some(extra)) => Some(format!("{base}\n\nINSTRUCCIONES DEL PROYECTO:\n{extra}")),
            (Some(base), None) => Some(base.to_string()),
            // A repo-bound conversation keeps `ai.rs`'s own default, which is what `None` selects —
            // so a project's instructions are added to it there rather than replacing it here.
            (None, Some(extra)) => Some(format!("INSTRUCCIONES DEL PROYECTO:\n{extra}")),
            (None, None) => None,
        }
    };

    // What the working directory held *before* this turn, so the diff afterwards can say which
    // files are this answer's rather than the conversation's. Empty for a repo-bound turn, which
    // writes into a checkout and has a checkpoint rather than chips.
    let outputs_before = if may_generate_files {
        super::chat_attach::snapshot_outputs(&conversation_id)
    } else {
        Default::default()
    };

    // What the engine is actually asked, which is the user's question plus the style rules when the
    // conversation is in a mode. Built here, after the question has been persisted above, so the
    // two can never be confused: `message` is what was asked, `engine_message` is what was sent.
    let engine_message = match caveman.as_deref() {
        Some(rules) => format!("{message}\n\n{rules}"),
        None => message.clone(),
    };

    let started = std::time::Instant::now();

    // Published to the whole process before the engine is launched, and dropped by the guard on
    // every route out of this function. This is what lets a window that opened *after* the question
    // was asked — a detached satellite, a re-attached main window, a workspace the user came back
    // to — rebuild the spinner, the Stop button and the delta target instead of showing a
    // conversation that looks idle while the CLI is plainly still working. See `InflightTurn`.
    let _inflight = mark_inflight(InflightTurn {
        conversation_id: conversation_id.clone(),
        run_id: run_id.clone().unwrap_or_default(),
        message_id: assistant_message_id.clone(),
        provider: config.provider.clone(),
        started_at_ms: chrono::Utc::now().timestamp_millis(),
    });

    // Only where there is a working copy to snapshot. A repo-less turn writes nothing by design,
    // and a checkpoint of an empty scratch directory would be an undo button for nothing.
    let checkpoint = project.as_ref().and_then(|p| checkpoint_before(&p.local_path, "chat"));
    let (result, trace) = ai_runs::scoped_with_trace(app, run_id, async {
        ai::chat_turn(
            &*config.engine,
            &config.binary,
            &config.model,
            ai::ChatTurn {
                contexts: &contexts,
                message: &engine_message,
                session_id: session_id.as_deref(),
                allowed_tools: &allowed_tools,
                cwd: &cwd,
                system_prompt: system_prompt.as_deref(),
                auto_approve_edits: write_access,
                stream_deltas,
                // Empty means the conversation never touched the control, which is not the same as
                // "medium": it leaves whatever the user configured in the CLI itself in charge.
                effort: (!conversation.effort.is_empty()).then_some(conversation.effort.as_str()),
                attachments: &attachments,
            },
        )
        .await
    })
    .await;
    let response_time_ms = started.elapsed().as_millis() as i64;
    if let Some(project) = project.as_ref() {
        checkpoint_after(&project.local_path, checkpoint);
    }
    // After the run, not before: it is cached per binary, so only the first turn of an app session
    // pays for the probe and it never sits between send and the engine starting.
    let engine_version = ai::engine_version(&config.binary).await;
    let trace_json = (!trace.is_empty()).then(|| serde_json::to_string(&trace).unwrap_or_default());

    // The files this turn produced, as a JSON array of relative paths — or `None`, which is what
    // the overwhelming majority of turns write, so the column stays empty rather than holding two
    // characters on every row ever stored.
    //
    // Computed here rather than at either call site because **both** of them need it: a turn that
    // failed halfway may still have left a file behind, and the user is entitled to whatever it
    // managed to write. Losing it because the run ended badly would be the app throwing away work
    // that exists on disk.
    let produced_paths = if may_generate_files {
        super::chat_attach::outputs_since(&conversation_id, &outputs_before)
    } else {
        Vec::new()
    };
    let produced = || {
        (!produced_paths.is_empty()).then(|| serde_json::to_string(&produced_paths).unwrap_or_default())
    };

    let run = match result {
        Ok(run) => run,
        Err(e) => {
            let cancelled = e.starts_with(ai_runs::CANCELLED_MARKER);
            if let Ok(conn) = db.0.lock() {
                // A failure is worth a mark too — arguably more than an answer is. A run that died
                // while the user was in another conversation is exactly the thing that otherwise
                // goes unnoticed until they wonder why a thread never replied. A turn the user
                // *stopped* is not: they were there, they did it, and there is nothing new to see.
                if !cancelled {
                    let _ = chat_queries::set_unread(&conn, &conversation_id, true);
                }
                let _ = chat_queries::append_message(
                    &conn,
                    &ChatMessageRow {
                        id: assistant_message_id.clone(),
                        conversation_id: conversation_id.clone(),
                        turn,
                        role: "assistant".to_string(),
                        // A cancelled turn has no content to keep — the user stopped it, and
                        // storing the marker string would put "RUN_CANCELLED::" in a bubble. A
                        // failed one keeps the error, because days later that sentence is the only
                        // thing that explains why a run died (out of credit, CLI gone).
                        content: if cancelled { String::new() } else { e.clone() },
                        provider: Some(config.provider.clone()),
                        // No model: the CLI never got far enough to report one. *Which* engine and
                        // version failed is what makes it diagnosable, and both are recorded.
                        model: None,
                        engine_version: engine_version.clone(),
                        response_time_ms: Some(response_time_ms),
                        is_error: !cancelled,
                        is_cancelled: cancelled,
                        trace: trace_json.clone(),
                        // A turn that failed may still have written something before it did, and
                        // the user is entitled to whatever that was.
                        outputs: produced(),
                        created_at: String::new(),
                    },
                );
            }
            return Err(e);
        }
    };

    let created_at = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let row = ChatMessageRow {
            id: assistant_message_id.clone(),
            conversation_id: conversation_id.clone(),
            turn,
            role: "assistant".to_string(),
            content: run.text.clone(),
            provider: Some(config.provider.clone()),
            model: run.model.clone(),
            engine_version: engine_version.clone(),
            response_time_ms: Some(response_time_ms),
            is_error: false,
            is_cancelled: false,
            trace: trace_json.clone(),
            outputs: produced(),
            created_at: String::new(),
        };
        match chat_queries::append_message(&conn, &row) {
            Ok(()) => {
                // An answer has landed. Marked unread here rather than left to the frontend,
                // because the window that asked the question is not necessarily the one looking at
                // it — a turn started in the quick-ask box, or in a detached window, lands in a
                // conversation the main sidebar is also drawing. Whichever window *is* showing this
                // conversation clears the flag as the reply arrives, so it never flashes there.
                let _ = chat_queries::set_unread(&conn, &conversation_id, true);
                // Written back so the next turn resumes this session, and so the transcript can say
                // which model answered when the engine picked for itself.
                let _ = chat_queries::update_session(
                    &conn,
                    &conversation_id,
                    run.session_id.as_deref(),
                    &config.provider,
                    config.account_id(),
                    run.model.as_deref().unwrap_or(&config.model),
                    // The engine's own figure for what it was holding on the last step of this
                    // turn — see `AiRun::context_tokens` for why that is a different number from
                    // `usage.input_tokens` and why the meter must not use the latter. `None` from
                    // every engine but Claude today, and `None` leaves whatever was measured last
                    // standing rather than emptying the gauge.
                    run.context_tokens,
                );
                chat_queries::list_messages(&conn, &conversation_id, false)
                    .ok()
                    .and_then(|rows| {
                        rows.into_iter().find(|m| m.id == assistant_message_id).map(|m| m.created_at)
                    })
                    .unwrap_or_else(|| chrono::Utc::now().to_rfc3339())
            }
            // The reply is already in hand; a failed *write* must not cost the user their answer.
            // It is returned anyway, stamped with the time it arrived rather than the time it was
            // filed.
            Err(_) => chrono::Utc::now().to_rfc3339(),
        }
    };

    Ok(ChatReply {
        account_id: config.account_id().map(str::to_string),
        text: run.text,
        session_id: run.session_id,
        model: run.model,
        provider: config.provider,
        engine_version,
        created_at,
        response_time_ms,
        message_id: assistant_message_id,
        compacted: auto_compacted,
        // Re-derived from the JSON that was stored, so the reply and the row can never disagree
        // about what this turn made.
        outputs: produced_paths,
    })
}

/// What a compaction did, for the window that asked for it.
#[derive(Serialize)]
pub struct ChatCompaction {
    /// The summary as filed. Returned rather than merely stored because the transcript shows it:
    /// the user is entitled to read the thing the engine will be told their conversation said.
    summary: String,
    /// The last turn the summary covers. Every message at or below this is now replayed as the
    /// summary instead of verbatim.
    through_turn: i64,
    /// Characters the next turn would have replayed before this ran, and after. The honest measure
    /// of what was bought, and it is in characters rather than tokens because these two numbers are
    /// counted here, exactly, rather than reported by anybody.
    before_chars: i64,
    after_chars: i64,
}

/// Replaces the earlier turns of a conversation with a summary the model writes of them.
///
/// # Why this exists at all
///
/// Five of the six engines resume a session and the sixth replays the transcript, and *both* paths
/// grow without bound: the resuming ones grow inside the CLI where this app cannot see it, and the
/// replaying one grows in [`replayed_prefix`] where it can, up to [`REPLAY_CHAR_BUDGET`] and then
/// by silently dropping its own beginning. Neither is something the user can act on, and on a
/// local model — where the window is small and the machine is the one paying for it — the second
/// one is the difference between a conversation that answers and one that starts forgetting the
/// question.
///
/// So compaction is the user-facing version of the truncation this file was already doing behind
/// their back: same shape, except that what replaces the dropped turns is a summary the model
/// wrote rather than nothing at all, and it is visible in the transcript rather than invisible.
///
/// # It is a turn, and it is honest about that
///
/// This runs the engine. It takes the same lease `chat_send` takes, for the same reason (a
/// conversation can do one thing at a time), it costs what a turn costs, and it can fail. What it
/// must never do is destroy anything: **no message is deleted**. The transcript on screen is
/// unchanged, `clear_compaction` puts the full replay back, and the only thing that is really gone
/// afterwards is the engine's own session — which is not recoverable and never was, since the same
/// thing happens on a provider switch.
///
/// # Already-compacted threads compact again
///
/// The material handed to the model is [`replayed_prefix`]'s output, which for a thread that has
/// been compacted once is *its summary plus the turns since*. Summarising that produces a summary
/// of the whole conversation rather than of its most recent half, which is what makes this
/// repeatable instead of a one-shot that leaves the tail growing again.
#[tauri::command]
pub async fn chat_compact(
    app: AppHandle,
    db: State<'_, Db>,
    conversation_id: String,
    run_id: Option<String>,
    guidance: Option<String>,
) -> Result<ChatCompaction, String> {
    let conversation = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        chat_queries::get_conversation(&conn, &conversation_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "conversation not found".to_string())?
    };

    // The same exclusion a turn takes — and it has to be the *same* lease, not merely one of its
    // own, or the two would happily run at once. Compacting while an answer is being written would
    // summarise a conversation one turn shorter than the one on screen and then clear the session
    // that answer is about to be written back into.
    //
    // Which lease that is depends on the conversation, exactly as it does in `chat_send`: a
    // repo-bound thread is excluded through its working copy, an unbound one through its own id.
    // Taking the wrong one here would be worse than taking none, because it would look like
    // mutual exclusion.
    let project = match conversation.project_id.as_deref() {
        Some(project_id) => {
            let conn = db.0.lock().map_err(|e| e.to_string())?;
            queries::get_project(&conn, project_id).map_err(|e| e.to_string())?
        }
        None => None,
    };
    let busy = || {
        let name = if conversation.title.trim().is_empty() {
            &conversation_id
        } else {
            &conversation.title
        };
        format!("{}{name}", ai_locks::BUSY_MARKER)
    };
    let _lease = match project.as_ref() {
        Some(project) => ai_locks::acquire(&project.local_path)
            .ok_or_else(|| format!("{}{}", ai_locks::BUSY_MARKER, project.name))?,
        None => ai_locks::acquire_key(&conversation_id).ok_or_else(busy)?,
    };

    let config = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        conversation_config(&conn, &conversation, None, None)?
    };

    run_compaction(app, &db, &conversation_id, &config, guidance.as_deref(), run_id).await
}

/// The engine a conversation's next turn runs on, most specific first: what this turn asked for,
/// then what the conversation was opened on, then the global `chat` route.
///
/// The middle step is what keeps a reopened conversation answering on the engine *and account*
/// that wrote it after the user has changed their defaults — a thread whose second half ran as
/// another account would also have lost its session to it. A stamp naming an account that has since
/// been removed resolves afresh for the thread's workspace, and the session rule in [`chat_send`]
/// then drops the token it can no longer resume.
fn conversation_config(
    conn: &Connection,
    conversation: &ChatConversation,
    provider: Option<&str>,
    model: Option<&str>,
) -> Result<AiConfig, String> {
    let workspace = Some(conversation.workspace_id.as_str());
    match (provider, model) {
        (Some(p), Some(m)) if !p.trim().is_empty() && !m.trim().is_empty() => {
            load_ai_config_as(conn, p, m, ai_accounts::Choice::Auto, Some(AiTask::Chat), workspace)
        }
        _ if !conversation.provider.trim().is_empty() => {
            let stamped = match conversation.account_id.as_deref() {
                Some(id) => ai_accounts::Choice::Account(id.to_string()),
                None => ai_accounts::Choice::System,
            };
            load_ai_config_as(
                conn,
                &conversation.provider,
                &conversation.model,
                stamped,
                Some(AiTask::Chat),
                workspace,
            )
        }
        _ => load_ai_config_in(conn, AiTask::Chat, workspace),
    }
}

/// How full a conversation has to be before a turn compacts it on the way past.
///
/// Not at the brim, and the gap is the point: the compaction is itself a turn, and it has to send
/// the whole conversation to the model that is about to summarise it. A trigger at 95% would be a
/// trigger that fires when the summarising turn can no longer fit either — a limit that only
/// announces itself once it is too late to do anything about it.
///
/// Above [`CONTEXT_FULL_AT`] in the frontend meter, deliberately: by the time the ring is red the
/// user has been warned, and this is the backstop for when they did not act on it.
const AUTO_COMPACT_AT: f64 = 0.8;

/// Whether a turn may compact its conversation before running. **Unset means on.**
///
/// The default is the direction that cannot lose work. Off, a conversation that fills up gets a
/// silently truncated context or a refused prompt; on, it costs one extra turn, once, and says so.
/// The switch exists because it is the user's money, and because a conversation being summarised
/// by a model is a judgement call some people would rather make themselves.
pub const CHAT_AUTO_COMPACT_KEY: &str = "chat_auto_compact";

/// Compacts this conversation if what it is about to send is close to a limit, and says whether it
/// did.
///
/// # The two limits, and why only one of them is ever a guess
///
/// **The replay path is measured.** When the next turn opens a fresh session — a thread that has
/// never run, one whose provider changed, a branch, or any turn on Cline, which has no resume at
/// all — this function builds the very prefix that turn will send and counts it against
/// [`REPLAY_CHAR_BUDGET`]. That is not an estimate of anything: the budget is this app's own, and
/// overshooting it means this app silently drops the oldest turns. This is also the path a local
/// model takes, which is the case the whole feature was asked for.
///
/// **The resume path is only sometimes knowable.** There the app sends one message and the CLI
/// holds the rest, so the only figures available are the last turn's reported occupancy and
/// [`ai::context_window_for`]. Both have to be present: an engine that reports no usage, or a model
/// whose window this app will not guess at, gets no automatic compaction — and that is the right
/// refusal, because the alternative is spending a turn on a conversation that may have had all the
/// room in the world. The meter still shows those conversations their size, and the button is still
/// there.
///
/// A failed compaction is not a failed turn. If the model cannot be reached, or answers with
/// nothing, the question the user actually asked is sent anyway on the context that already
/// existed — which is exactly what would have happened without this feature.
async fn auto_compact_if_full(
    app: &AppHandle,
    db: &State<'_, Db>,
    conversation: &ChatConversation,
    config: &crate::commands::claude_cmd::AiConfig,
    session_id: Option<&str>,
    run_id: Option<&str>,
) -> bool {
    let resuming = session_id.is_some() && config.engine.resumes_sessions();

    let full = {
        let Ok(conn) = db.0.lock() else { return false };
        needs_compacting(&conn, conversation, &config.model, resuming)
    };
    if !full {
        return false;
    }

    // Under the turn's own run id, so the whole thing is one stoppable unit in the status bar and
    // one trace. It is honestly part of what this turn did — the user pressed send once and is
    // paying for two runs, and hiding the first would make the turn look inexplicably slow.
    match run_compaction(
        app.clone(),
        db,
        &conversation.id,
        config,
        None,
        run_id.map(str::to_string),
    )
    .await
    {
        Ok(_) => true,
        Err(e) => {
            // Said to the log and not to the user: they asked a question, and the answer to it is
            // still coming. A toast about a housekeeping step they never requested would read as
            // their question having failed.
            eprintln!("automatic compaction skipped: {e}");
            false
        }
    }
}

/// Whether this conversation is close enough to a limit that the next turn should summarise it.
///
/// Split from [`auto_compact_if_full`] so the decision can be tested without an engine: everything
/// above is plumbing, and this is the part that decides whether the user pays for an extra turn.
/// The two branches are measured against completely different things — see the doc there.
fn needs_compacting(
    conn: &Connection,
    conversation: &ChatConversation,
    model: &str,
    resuming: bool,
) -> bool {
    // Unset is on; a database that will not answer also reads as on, which is the direction that
    // keeps a broken read from silently removing a protection the user configured.
    let enabled = queries::get_setting(conn, CHAT_AUTO_COMPACT_KEY)
        .ok()
        .flatten()
        .map(|raw| raw != "false")
        .unwrap_or(true);
    if !enabled {
        return false;
    }
    if resuming {
        // Measured occupancy against a window this app is willing to name. Either one missing and
        // there is no question to answer: an engine that reports nothing, or a model whose window
        // is anybody's guess, would otherwise have a turn spent on a conversation that may have had
        // all the room in the world.
        match (conversation.context_tokens, ai::context_window_for(model)) {
            (Some(tokens), Some(window)) if window > 0 => {
                tokens as f64 / window as f64 >= AUTO_COMPACT_AT
            }
            _ => false,
        }
    } else {
        // The prefix this turn would carry, counted. An already-compacted thread counts its summary
        // rather than the turns it replaced, which is what stops a conversation re-triggering the
        // moment after it was compacted.
        replayed_prefix(conn, &conversation.id)
            .map(|prefix| {
                prefix.chars().count() as f64 >= REPLAY_CHAR_BUDGET as f64 * AUTO_COMPACT_AT
            })
            .unwrap_or(false)
    }
}

/// The body of a compaction, with no lease of its own.
///
/// Split out because it has two callers that hold the lease differently: [`chat_compact`], which
/// takes it, and [`chat_send`], which is already holding it when it decides the conversation is too
/// full to send into. A version that took the lease itself would deadlock the second caller against
/// itself — the most confusing possible failure, since the app would simply stop answering.
async fn run_compaction(
    app: AppHandle,
    db: &State<'_, Db>,
    conversation_id: &str,
    config: &crate::commands::claude_cmd::AiConfig,
    guidance: Option<&str>,
    run_id: Option<String>,
) -> Result<ChatCompaction, String> {
    let (material, through_turn) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        // Exactly what the next fresh session would be sent — summary already folded in if this
        // thread has been compacted before. Asking the model to compress *that* rather than the raw
        // message list is what makes a second compaction cover the whole conversation instead of
        // only the part since the first one.
        let material = replayed_prefix(&conn, conversation_id)
            .ok_or_else(|| "there is nothing to compact yet".to_string())?;
        // The highest turn on disk, so every exchange that exists right now is covered. `next_turn`
        // is the one after it; a conversation with no messages never reaches here because
        // `replayed_prefix` already returned `None`.
        let through_turn =
            chat_queries::next_turn(&conn, conversation_id).map_err(|e| e.to_string())? - 1;
        (material, through_turn)
    };

    // Somewhere to run that is not the user's repository. Compacting reads a transcript and writes
    // a paragraph; it has no business in a working copy even when the conversation has one, and
    // this directory is the one the app already owns for this thread.
    let cwd = crate::paths::chat_conversation_outputs_dir(conversation_id);
    std::fs::create_dir_all(&cwd)
        .map_err(|e| format!("could not create the chat working directory: {e}"))?;

    // What the user typed after `/compact`, if anything. Appended rather than substituted: the
    // base prompt is what keeps the summary usable as context — no greeting, no commentary, the
    // identifiers kept — and "conserva sobre todo lo del esquema" is a steer on top of that, not a
    // replacement for it. A user who writes something that contradicts the base gets the base
    // honoured for the parts they did not mention, which is the behaviour that cannot lose
    // information.
    let instructions = match guidance.as_deref().map(str::trim).filter(|g| !g.is_empty()) {
        Some(extra) => format!(
            "{COMPACT_PROMPT}\n\nAdemás, el usuario pide expresamente para este resumen: {extra}"
        ),
        None => COMPACT_PROMPT.to_string(),
    };

    let before_chars = material.chars().count() as i64;
    let (result, _trace) = ai_runs::scoped_with_trace(app, run_id, async {
        ai::chat_turn(
            &*config.engine,
            &config.binary,
            &config.model,
            ai::ChatTurn {
                contexts: &[("Conversación a compactar".to_string(), material)],
                message: &instructions,
                // Always a fresh session. Resuming the one being compacted would hand the model
                // the full conversation *and* ask it to summarise a copy of the same conversation
                // it is already holding — twice the context, to make it smaller.
                session_id: None,
                allowed_tools: &config.engine.read_only_tools(),
                cwd: &cwd.to_string_lossy(),
                system_prompt: Some(COMPACT_SYSTEM_PROMPT),
                auto_approve_edits: false,
                // Nothing is watching: this produces one paragraph the user reads afterwards, not
                // a bubble that grows. A sink here would stream a summary into the message id of
                // whatever turn happened to be on screen.
                stream_deltas: None,
                // Deliberately not the conversation's level. Summarising is not the task the user
                // set that dial for, and a thread pinned to "max" would spend a reasoning budget
                // on a précis.
                effort: None,
                attachments: &[],
            },
        )
        .await
    })
    .await;

    let summary = result?.text.trim().to_string();
    if summary.is_empty() {
        // An engine that answered with nothing has not compacted anything, and filing an empty
        // summary would be the worst of both: the turns would stop being replayed and nothing would
        // stand in for them.
        return Err("the model returned an empty summary".to_string());
    }

    let conn = db.0.lock().map_err(|e| e.to_string())?;
    chat_queries::set_compaction(&conn, conversation_id, &summary, through_turn)
        .map_err(|e| e.to_string())?;
    let after_chars = replayed_prefix(&conn, conversation_id)
        .map(|prefix| prefix.chars().count() as i64)
        .unwrap_or(0);

    Ok(ChatCompaction { summary, through_turn, before_chars, after_chars })
}

/// Throws a conversation's summary away, so the whole transcript is replayed again.
///
/// Free and instant — nothing was deleted when it was compacted, so this is a column going back to
/// empty. It is offered because compaction is a judgement call the model makes about what mattered,
/// and a user who reads the summary and finds it dropped the thing they were working on needs a way
/// back that is not "start again".
#[tauri::command]
pub fn chat_uncompact(db: State<'_, Db>, conversation_id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    chat_queries::clear_compaction(&conn, &conversation_id).map_err(|e| e.to_string())
}

/// What the summarising turn is told it is.
///
/// In Spanish because every other prompt this file writes is — see `REPO_LESS_PREAMBLE`. The
/// instruction not to address the user is load-bearing: this text is filed as the model's *own*
/// memory of the conversation and is replayed as context on the next turn, so a summary that opens
/// with "claro, aquí tienes el resumen" becomes a sentence the model later reads as something it
/// said to the user, about a request the user never made.
const COMPACT_SYSTEM_PROMPT: &str = "Eres un compactador de contexto. Recibes una conversación y \
    devuelves el resumen que sustituirá a esa conversación en la memoria del modelo. No hablas con \
    nadie: no saludes, no te presentes, no comentes la tarea, no preguntes nada. Devuelves \
    únicamente el resumen.";

/// What it is asked to do.
///
/// The list is what separates a useful compaction from a blurb. A summary that keeps only the
/// *topics* is the failure mode — "hablamos de la migración y de los tests" — because everything
/// the next turn actually needs is in the specifics: the identifiers, the decisions and, above all,
/// what is still open. Those are named one by one rather than left to the model's judgement about
/// what is important, since its judgement is precisely what has no access to the turn that has not
/// been asked yet.
const COMPACT_PROMPT: &str = "Resume la conversación anterior para que otra instancia tuya pueda \
    continuarla sin haberla leído. Conserva, en este orden: (1) qué quiere conseguir el usuario y \
    en qué punto va; (2) las decisiones que ya se tomaron y por qué; (3) los datos concretos que \
    harían falta para seguir — nombres de archivo, rutas, identificadores, versiones, fragmentos de \
    código imprescindibles, valores acordados; (4) lo que quedó pendiente o sin resolver. Omite los \
    saludos, las disculpas, los rodeos y todo lo que ya se descartó. Escribe en el idioma de la \
    conversación, en prosa breve con listas cuando ayuden, y no inventes nada que no esté en el \
    texto.";

/// The stored transcript, rendered for an engine that is about to see this conversation for the
/// first time — a branch, a provider switch, a session the CLI lost.
///
/// `None` when there is nothing to replay, which is both the ordinary first turn of a new
/// conversation and the case where a read failed: a conversation opening its session with no
/// context is the correct thing to do when its history cannot be read, and failing the turn over it
/// would refuse to answer a question the engine is perfectly able to answer.
fn replayed_prefix(conn: &Connection, conversation_id: &str) -> Option<String> {
    // Read first, because it decides which of the messages below are eligible at all. A
    // conversation nobody has compacted — almost all of them — comes back `None` here, and
    // everything after this line behaves exactly as it did before compaction existed.
    let compaction = chat_queries::get_conversation(conn, conversation_id).ok().flatten().and_then(
        |conversation| {
            let through = conversation.compacted_through_turn?;
            let summary = conversation.compacted_summary.trim().to_string();
            (!summary.is_empty()).then_some((summary, through))
        },
    );

    let messages = chat_queries::list_messages(conn, conversation_id, false).ok()?;
    if messages.is_empty() {
        return None;
    }

    let mut lines: Vec<String> = Vec::with_capacity(messages.len());
    for message in messages {
        // A cancelled turn has no content, and an error is this app's sentence rather than the
        // model's — neither is part of the conversation, and replaying the second would have the
        // model trying to account for an error it did not produce.
        if message.is_cancelled || message.is_error || message.content.trim().is_empty() {
            continue;
        }
        // Already inside the summary. Sending both is the one mistake compaction cannot survive: a
        // context carrying a precis of the first twelve turns *and* the first twelve turns is
        // longer than the one it replaced, which is the opposite of what the button promised.
        if compaction.as_ref().is_some_and(|(_, through)| message.turn <= *through) {
            continue;
        }
        let who = if message.role == "user" { "User" } else { "Assistant" };
        lines.push(format!("{who}: {}", message.content));
    }

    let Some((summary, _)) = compaction else {
        if lines.is_empty() {
            return None;
        }
        return Some(keep_tail(lines.join("\n\n"), REPLAY_CHAR_BUDGET));
    };

    // The summary is kept **whole**, and the budget is spent on what came after it.
    //
    // The uncompacted path keeps the tail because recency is what a conversation mostly is. That
    // rule inverts the moment a summary exists: the summary *is* the earlier half, already paid
    // for with a turn and already as small as it will ever be, so trimming it from the front would
    // throw away the one thing the user spent that turn to keep and leave a context that is both
    // shorter and missing its own beginning.
    let header = format!(
        "Resumen de la parte anterior de esta conversación, hecho por ti mismo en una compactación \
         previa. Es lo único que queda de esos mensajes: trátalo como tu propia memoria de lo ya \
         hablado, no como algo que el usuario acabe de decir.\n\n{summary}"
    );
    if lines.is_empty() {
        return Some(keep_tail(header, REPLAY_CHAR_BUDGET));
    }
    let room = REPLAY_CHAR_BUDGET.saturating_sub(header.chars().count());
    let rest = keep_tail(lines.join("\n\n"), room);
    Some(format!("{header}\n\nMensajes posteriores al resumen, literales:\n\n{rest}"))
}

/// The last `budget` characters of `text`, cut on a character boundary and marked as cut.
///
/// `char_indices` rather than byte arithmetic because this text is the user's and is routinely not
/// ASCII — slicing mid-code-point would panic. A budget of zero yields the marker alone, which is
/// the honest answer when a summary has already spent the whole allowance.
fn keep_tail(text: String, budget: usize) -> String {
    if text.chars().count() <= budget {
        return text;
    }
    let skip = text.chars().count() - budget;
    let at = text.char_indices().nth(skip).map(|(i, _)| i).unwrap_or(text.len());
    format!("[…earlier turns omitted…]\n\n{}", &text[at..])
}

/// Snapshots the working tree before a turn that can write to it, so the run is undoable.
/// Best-effort: a repo that cannot be snapshotted must not block the turn the user asked for — they
/// just do not get the undo button. Mirrors `claude_cmd`'s, which is private to that module.
fn checkpoint_before(repo_path: &str, kind: &str) -> Option<String> {
    match git::checkpoint::create(repo_path, kind) {
        Ok(id) => Some(id),
        Err(e) => {
            eprintln!("checkpoint before '{kind}' failed: {e}");
            None
        }
    }
}

/// Discards a checkpoint whose turn changed nothing on disk — an "undo" restoring zero files is
/// clutter in the list.
fn checkpoint_after(repo_path: &str, checkpoint: Option<String>) {
    if let Some(id) = checkpoint {
        let _ = git::checkpoint::remove_if_unchanged(repo_path, &id);
    }
}

// ===================== the provider command surface =====================

/// The slash commands this provider can actually be sent, for the composer's `/` menu.
///
/// **Nothing here is invented, and an empty answer is a real answer.** The menu is a promise that
/// typing one of these does something; a curated list of plausible-looking commands for a CLI that
/// does not expand them in headless mode would fail on send, silently, as though the model had
/// ignored the instruction. Three of the six providers therefore return nothing at all, and the UI
/// offers "open in terminal" for those instead — which is the true answer: those commands exist,
/// they are just not reachable from `-p`.
#[tauri::command]
pub fn chat_provider_commands(provider: String) -> Vec<ProviderCommand> {
    match provider.as_str() {
        "claude" => claude_slash_commands(),
        "grok" => grok_slash_commands(),
        "gemini" => gemini_slash_commands(),
        // codex, opencode, cline — and anything unknown. See the doc above.
        _ => Vec::new(),
    }
}

/// Claude's, from the handshake of the most recent run **in this process**.
///
/// The one source in this file that is true of the installed binary rather than of a document: the
/// CLI prints its whole command list in the `system`/`init` event of every run, plugins and the
/// user's own `~/.claude/commands` included, so this is a free and exact answer — for an install
/// that has run at least one turn. Before that it is empty, deliberately: guessing at a list this
/// app can simply be told is how a stale default outlives the version it was copied from.
fn claude_slash_commands() -> Vec<ProviderCommand> {
    crate::claude::last_run_meta()
        .slash_commands
        .into_iter()
        .map(|name| ProviderCommand {
            // Stored without one (see `ClaudeRunMeta::slash_commands`); the slash is this layer's.
            name: format!("/{name}"),
            description: String::new(),
            source: "cli-reported".to_string(),
        })
        .collect()
}

/// Grok's, read out of the guide its own installer ships.
///
/// **Read at call time, never bundled.** A copy of this list vendored into the app would be right
/// on the day it was copied and quietly wrong afterwards — the file belongs to a binary that
/// updates itself, and the point of reading it is that it describes the version actually installed.
/// A machine without the file gets an empty list, which is correct: nothing can be said about a
/// CLI whose own documentation is not there.
fn grok_slash_commands() -> Vec<ProviderCommand> {
    let Some(home) = dirs::home_dir() else { return Vec::new() };
    let path = home.join(".grok/docs/user-guide/04-slash-commands.md");
    let Ok(text) = std::fs::read_to_string(&path) else { return Vec::new() };
    parse_markdown_commands(&text)
        .into_iter()
        .map(|(name, description)| ProviderCommand {
            name,
            description,
            source: "documented".to_string(),
        })
        .collect()
}

/// Gemini/agy's — a small curated list, and honestly labelled as such.
///
/// `agy` has a `--disable-slash-commands` flag, which is the whole evidence that expansion works in
/// `-p` mode: a switch to turn something off is a statement that it is otherwise on. What it has
/// no equivalent of is Claude's init handshake, so there is nothing to ask. Kept short on purpose —
/// four commands this app is confident about beat forty scraped from a release note.
fn gemini_slash_commands() -> Vec<ProviderCommand> {
    [
        ("/help", "List the commands this CLI understands"),
        ("/memory", "Show or edit what the CLI remembers about this project"),
        ("/stats", "Token and session statistics for this conversation"),
        ("/compress", "Summarise the conversation so far to reclaim context"),
    ]
    .into_iter()
    .map(|(name, description)| ProviderCommand {
        name: name.to_string(),
        description: description.to_string(),
        source: "documented".to_string(),
    })
    .collect()
}

/// Pulls `(command, description)` pairs out of a Markdown page that documents slash commands.
///
/// A scan rather than a Markdown parse, and deliberately: the input is somebody else's
/// documentation, its structure is whatever their docs generator produced this month, and the only
/// thing stable about it is that a command is written as `/word` at the start of some decorated
/// line. So the decoration is stripped — heading hashes, list bullets, table pipes, backticks — and
/// what survives at the front is either a command or it is not.
///
/// Held to one rule: a page this cannot make sense of yields an empty list, never a wrong one. The
/// menu says where each row came from, and a row that came from here is claiming the installed CLI
/// documents it.
fn parse_markdown_commands(text: &str) -> Vec<(String, String)> {
    let mut found: Vec<(String, String)> = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim_start_matches(|c: char| {
            c.is_whitespace() || matches!(c, '#' | '-' | '*' | '|' | '`' | '>')
        });
        let Some(rest) = trimmed.strip_prefix('/') else { continue };
        let name: String = rest
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ':'))
            .collect();
        if name.is_empty() {
            continue;
        }
        let command = format!("/{name}");
        if found.iter().any(|(existing, _)| existing == &command) {
            continue;
        }
        // Whatever follows the command on the same line, with the decoration taken off both ends.
        // One `trim_matches` over whitespace *and* punctuation rather than alternating passes,
        // because the separators arrive interleaved — `` `/clear` : start over `` puts a backtick,
        // a space and a colon between the two, and a strip that stops at the first character it
        // does not recognise leaves half of them behind. Frequently nothing survives, which is
        // fine: the menu renders a bare row.
        let description = rest[name.len()..]
            .trim_matches(|c: char| {
                c.is_whitespace() || matches!(c, '|' | '`' | '-' | ':' | '\u{2014}' | '\u{2013}' | '*')
            })
            .to_string();
        found.push((command, description));
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The sentence exists to stop a model wasting tool calls on an interpreter that is not there,
    /// so what it must never do is claim one that is.
    #[test]
    fn the_runtimes_note_only_names_binaries_that_are_really_on_path() {
        let present = present_runtimes();
        let note = runtimes_note();
        for name in RUNTIMES {
            if present.contains(&name) {
                continue;
            }
            // Whole tokens, not a substring search: `"python3".contains("python")` is true, and a
            // looser check calls a correct note wrong the moment both are on the machine.
            let offered = note
                .split("NO están instalados")
                .next()
                .unwrap_or_default()
                .rsplit_once("puedes contar con: ")
                .map(|(_, list)| list.trim_end_matches('.').split(", ").any(|found| found == name))
                .unwrap_or(false);
            assert!(!offered, "{name} is not installed but the note offers it");
        }
    }

    /// The rule survives a machine with nothing on `PATH`, which is the case it matters most in:
    /// an engine there has to ask for an install rather than discover the gap by failing.
    #[test]
    fn the_note_always_carries_the_check_and_the_offer() {
        let note = runtimes_note();
        assert!(note.contains("command -v"), "the engine is told to check first");
        assert!(note.contains("ofrécete a instalarlo"), "and to offer the install");
        assert!(note.contains("espera a que te diga que sí"), "and to ask before running it");
    }

    /// The offer names a manager that exists on the machine the build runs on. Wrong advice reads
    /// as authoritative and fails, which is worse than no advice.
    #[test]
    fn the_installer_matches_this_platform() {
        if cfg!(target_os = "macos") {
            assert!(INSTALLER.contains("brew"));
        } else if cfg!(target_os = "windows") {
            assert!(INSTALLER.contains("winget"));
        } else {
            assert!(INSTALLER.contains("apt"));
        }
    }

    fn install() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&conn).unwrap();
        conn
    }

    fn workspace(conn: &Connection) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO workspaces (id, name, sort_order, created_at)
             VALUES (?1, 'W', 0, '2026-01-01T00:00:00Z')",
            rusqlite::params![id],
        )
        .unwrap();
        id
    }

    fn say(conn: &Connection, conversation_id: &str, turn: i64, role: &str, content: &str) {
        chat_queries::append_message(
            conn,
            &ChatMessageRow {
                id: uuid::Uuid::new_v4().to_string(),
                conversation_id: conversation_id.to_string(),
                turn,
                role: role.to_string(),
                content: content.to_string(),
                provider: Some("claude".to_string()),
                model: None,
                engine_version: None,
                response_time_ms: None,
                is_error: false,
                is_cancelled: false,
                trace: None,
            outputs: None,
                created_at: String::new(),
            },
        )
        .unwrap();
    }

    /// The ordinary first turn: there is nothing behind it, so nothing is replayed and the user
    /// does not pay for a context that does not exist.
    #[test]
    fn a_new_conversation_replays_nothing() {
        let conn = install();
        let ws = workspace(&conn);
        let c = chat_queries::create_conversation(&conn, &ws, None, "claude", None, "", "").unwrap();
        assert!(replayed_prefix(&conn, &c.id).is_none());
    }

    /// What a branch and a provider switch both rest on: a fresh engine session is handed what was
    /// said before it existed, in order, attributed.
    #[test]
    fn a_fresh_session_is_handed_what_came_before() {
        let conn = install();
        let ws = workspace(&conn);
        let c = chat_queries::create_conversation(&conn, &ws, None, "claude", None, "", "").unwrap();
        say(&conn, &c.id, 0, "user", "¿qué es un rebase?");
        say(&conn, &c.id, 0, "assistant", "Reaplica commits sobre otra base.");

        let prefix = replayed_prefix(&conn, &c.id).expect("a non-empty conversation replays");
        assert!(prefix.contains("User: ¿qué es un rebase?"));
        assert!(prefix.contains("Assistant: Reaplica commits sobre otra base."));
        assert!(
            prefix.find("User:").unwrap() < prefix.find("Assistant:").unwrap(),
            "the question has to precede its answer or the replay reads backwards"
        );
    }

    /// A turn the user stopped, and one that failed, are not part of the conversation. Replaying
    /// the second would have the model accounting for an error message this app wrote.
    #[test]
    fn stopped_and_failed_turns_are_not_replayed() {
        let conn = install();
        let ws = workspace(&conn);
        let c = chat_queries::create_conversation(&conn, &ws, None, "claude", None, "", "").unwrap();
        say(&conn, &c.id, 0, "user", "pregunta real");
        chat_queries::append_message(
            &conn,
            &ChatMessageRow {
                id: uuid::Uuid::new_v4().to_string(),
                conversation_id: c.id.clone(),
                turn: 0,
                role: "assistant".to_string(),
                content: "claude: command not found".to_string(),
                provider: Some("claude".to_string()),
                model: None,
                engine_version: None,
                response_time_ms: None,
                is_error: true,
                is_cancelled: false,
                trace: None,
            outputs: None,
                created_at: String::new(),
            },
        )
        .unwrap();

        let prefix = replayed_prefix(&conn, &c.id).unwrap();
        assert!(prefix.contains("pregunta real"));
        assert!(!prefix.contains("command not found"), "an app error is not a model turn");
    }

    /// The budget keeps the *tail*, and cuts on a character boundary — this text is the user's and
    /// is routinely not ASCII, so byte arithmetic here would be a panic waiting for a Spanish
    /// conversation long enough to trip it.
    #[test]
    fn a_long_conversation_replays_its_tail_without_splitting_a_character() {
        let conn = install();
        let ws = workspace(&conn);
        let c = chat_queries::create_conversation(&conn, &ws, None, "claude", None, "", "").unwrap();
        for turn in 0..40 {
            say(&conn, &c.id, turn, "user", &"ñ".repeat(1_200));
            say(&conn, &c.id, turn, "assistant", &format!("respuesta {turn}"));
        }

        let prefix = replayed_prefix(&conn, &c.id).unwrap();
        assert!(prefix.chars().count() <= REPLAY_CHAR_BUDGET + 64, "the budget is respected");
        assert!(prefix.contains("respuesta 39"), "the most recent turn survives the cut");
        assert!(!prefix.contains("respuesta 0"), "the oldest does not");
    }

    /// A compacted thread replays the summary **instead of** the turns it covers, never both.
    ///
    /// The failure this pins is not a crash, it is a context that grew: a prefix holding a précis
    /// of the first twelve turns and then the first twelve turns verbatim is longer than the one
    /// compaction replaced, and everything on screen would still say it had worked.
    #[test]
    fn a_compacted_conversation_replays_the_summary_and_only_what_came_after() {
        let conn = install();
        let ws = workspace(&conn);
        let c = chat_queries::create_conversation(&conn, &ws, None, "claude", None, "", "").unwrap();
        say(&conn, &c.id, 0, "user", "cómo migro la tabla de usuarios");
        say(&conn, &c.id, 0, "assistant", "con una migración aditiva");
        say(&conn, &c.id, 1, "user", "y los índices");
        say(&conn, &c.id, 1, "assistant", "después de la copia");

        chat_queries::set_compaction(&conn, &c.id, "acordamos una migración aditiva", 0).unwrap();

        let prefix = replayed_prefix(&conn, &c.id).unwrap();
        assert!(prefix.contains("acordamos una migración aditiva"), "the summary is sent");
        assert!(!prefix.contains("cómo migro la tabla"), "turn 0 is now the summary's job");
        assert!(prefix.contains("y los índices"), "turn 1 is still sent verbatim");
        assert!(prefix.contains("después de la copia"));
    }

    /// Compacting the whole thread leaves the summary standing on its own.
    ///
    /// The ordinary case immediately after pressing the button — there is nothing after the cut —
    /// and the one that would come back `None` if the summary were treated as a decoration on a
    /// list of messages rather than as the context itself. `None` here means the next turn opens a
    /// fresh session and is told *nothing at all* about a conversation the user can see.
    #[test]
    fn compacting_everything_still_replays_something() {
        let conn = install();
        let ws = workspace(&conn);
        let c = chat_queries::create_conversation(&conn, &ws, None, "claude", None, "", "").unwrap();
        say(&conn, &c.id, 0, "user", "hola");
        say(&conn, &c.id, 0, "assistant", "qué tal");
        chat_queries::set_compaction(&conn, &c.id, "una charla corta", 0).unwrap();

        let prefix = replayed_prefix(&conn, &c.id).unwrap();
        assert!(prefix.contains("una charla corta"));
        assert!(!prefix.contains("qué tal"));
    }

    /// The budget is spent on the *tail*, and the summary is never the thing that gets cut.
    ///
    /// The plain path keeps the last 40 000 characters because recency is what a conversation is.
    /// Applying that rule to a compacted prefix would trim from the front — which is the summary,
    /// the one part that was paid for with a turn and cannot be recovered from anywhere else.
    #[test]
    fn a_long_tail_never_eats_the_summary() {
        let conn = install();
        let ws = workspace(&conn);
        let c = chat_queries::create_conversation(&conn, &ws, None, "claude", None, "", "").unwrap();
        say(&conn, &c.id, 0, "user", "la parte vieja");
        for turn in 1..40 {
            say(&conn, &c.id, turn, "user", &"ñ".repeat(1_200));
            say(&conn, &c.id, turn, "assistant", &format!("respuesta {turn}"));
        }
        chat_queries::set_compaction(&conn, &c.id, "RESUMEN-CANARIO", 0).unwrap();

        let prefix = replayed_prefix(&conn, &c.id).unwrap();
        assert!(prefix.contains("RESUMEN-CANARIO"), "the summary survives a tail that overflows");
        assert!(prefix.contains("respuesta 39"), "and so does the most recent turn");
        assert!(prefix.chars().count() <= REPLAY_CHAR_BUDGET + 256, "the budget is still respected");
    }

    /// The automatic compaction measures two completely different things, and only one of them is
    /// ever available.
    ///
    /// Worth pinning because the asymmetry looks like an oversight and reads like one in a diff:
    /// the obvious "tidy-up" is to give both branches the same rule. They cannot have one. A
    /// replaying turn is measured against a budget this app owns and can count exactly; a resuming
    /// turn can only be measured where the engine reported its occupancy *and* the app is willing
    /// to name the model's window, which on four of six engines is never.
    #[test]
    fn a_turn_compacts_on_what_it_can_measure_and_nothing_else() {
        let conn = install();
        let ws = workspace(&conn);
        let c = chat_queries::create_conversation(&conn, &ws, None, "claude", None, "", "").unwrap();

        // ---- the replay path: measured, always available ----
        // Comfortably short. Nothing to do.
        say(&conn, &c.id, 0, "user", "hola");
        let short = chat_queries::get_conversation(&conn, &c.id).unwrap().unwrap();
        assert!(!needs_compacting(&conn, &short, "claude-sonnet-4-5", false));

        // Past four fifths of the budget the next turn would start losing its own beginning.
        let big = "ñ".repeat((REPLAY_CHAR_BUDGET as f64 * 0.9) as usize);
        say(&conn, &c.id, 1, "user", &big);
        let full = chat_queries::get_conversation(&conn, &c.id).unwrap().unwrap();
        assert!(needs_compacting(&conn, &full, "claude-sonnet-4-5", false));

        // ---- the resume path: only where both halves of a percentage exist ----
        // The same over-long conversation, resuming: the prefix is irrelevant now, because the
        // turn will not send it. With no reported occupancy there is nothing to compare.
        assert!(
            !needs_compacting(&conn, &full, "claude-sonnet-4-5", true),
            "an unmeasured session must not be compacted on a guess"
        );

        chat_queries::update_session(&conn, &c.id, Some("s-1"), "claude", None, "m", Some(190_000)).unwrap();
        let measured = chat_queries::get_conversation(&conn, &c.id).unwrap().unwrap();
        assert!(
            needs_compacting(&conn, &measured, "claude-sonnet-4-5", true),
            "190k of a 200k window is full"
        );
        assert!(
            !needs_compacting(&conn, &measured, "ollama/llama3.3", true),
            "the same 190k against a window nobody can name is not a percentage"
        );

        // A quarter full is a quarter full.
        chat_queries::update_session(&conn, &c.id, Some("s-1"), "claude", None, "m", Some(50_000)).unwrap();
        let roomy = chat_queries::get_conversation(&conn, &c.id).unwrap().unwrap();
        assert!(!needs_compacting(&conn, &roomy, "claude-sonnet-4-5", true));

        // ---- and the switch stops all of it ----
        queries::set_setting(&conn, CHAT_AUTO_COMPACT_KEY, "false").unwrap();
        assert!(!needs_compacting(&conn, &full, "claude-sonnet-4-5", false));
        assert!(!needs_compacting(&conn, &measured, "claude-sonnet-4-5", true));
    }

    /// A conversation that was just compacted must not compact again on the next turn.
    ///
    /// The trap is that the messages are all still there: a rule that counted the *transcript*
    /// would find it exactly as long as it was a moment ago and summarise the summary, once per
    /// turn, forever. What is counted is what would be sent, which after a compaction is the
    /// summary and nothing else.
    #[test]
    fn compacting_once_is_enough() {
        let conn = install();
        let ws = workspace(&conn);
        let c = chat_queries::create_conversation(&conn, &ws, None, "claude", None, "", "").unwrap();
        for turn in 0..40 {
            say(&conn, &c.id, turn, "user", &"ñ".repeat(1_200));
            say(&conn, &c.id, turn, "assistant", "vale");
        }
        let before = chat_queries::get_conversation(&conn, &c.id).unwrap().unwrap();
        assert!(needs_compacting(&conn, &before, "claude-sonnet-4-5", false));

        chat_queries::set_compaction(&conn, &c.id, "hablamos de muchas cosas", 39).unwrap();
        let after = chat_queries::get_conversation(&conn, &c.id).unwrap().unwrap();
        assert!(
            !needs_compacting(&conn, &after, "claude-sonnet-4-5", false),
            "the transcript is still long; what gets sent is not"
        );
    }

    /// Claude's list carries no slash (see `ClaudeRunMeta`), and the menu's does. The prefix is
    /// added exactly once, here.
    #[test]
    fn claude_commands_are_prefixed_once() {
        for command in claude_slash_commands() {
            assert!(command.name.starts_with('/'), "{} has no slash", command.name);
            assert!(!command.name.starts_with("//"), "{} was prefixed twice", command.name);
            assert_eq!(command.source, "cli-reported");
        }
    }

    /// The three that publish nothing publish nothing. The UI's "open in terminal" row depends on
    /// this being empty rather than on a curated fiction.
    #[test]
    fn providers_without_a_headless_command_surface_return_none() {
        for provider in ["codex", "opencode", "cline", "something-new"] {
            assert!(
                chat_provider_commands(provider.to_string()).is_empty(),
                "{provider} must not invent a command surface"
            );
        }
    }

    /// The shapes a docs page actually uses, all in one page: a heading, a list item, a table row
    /// and a fenced mention. Duplicates collapse, because the same command is routinely documented
    /// twice on one page.
    #[test]
    fn commands_are_recovered_from_ordinary_markdown_decoration() {
        let page = "\
# Slash commands

## /model — switch the active model
- `/clear` : start over
| `/compact` | summarise the session |
Not a command: use the /model command above.
plain prose with no leading slash
";
        let found = parse_markdown_commands(page);
        let names: Vec<&str> = found.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(names, vec!["/model", "/clear", "/compact"]);
        assert_eq!(found[0].1, "switch the active model");
        assert_eq!(found[1].1, "start over");
        assert_eq!(found[2].1, "summarise the session");
    }

    /// The rule the parser is held to: a page it cannot make sense of yields nothing, never a row
    /// claiming the CLI documents something it does not.
    #[test]
    fn an_unrecognisable_page_yields_nothing() {
        assert!(parse_markdown_commands("").is_empty());
        assert!(parse_markdown_commands("# Introduction\n\nThis CLI has no commands.\n").is_empty());
        assert!(parse_markdown_commands("- / ").is_empty(), "a bare slash is not a command");
    }

    /// Read-only means read-only, in whichever vocabulary the engine speaks.
    ///
    /// This test used to assert against one hardcoded array in Claude Code's names, and passed
    /// while grok — whose tools are called `read_file` and `write_file` — was being handed a set it
    /// recognised nothing in and running these conversations with its full agent profile. So it now
    /// asks each engine for its own set and checks that every one of them refuses to write, in its
    /// own words.
    #[test]
    fn no_engines_read_only_set_can_write() {
        for provider in ["claude", "grok"] {
            let tools = ai::engine_for(provider).read_only_tools();
            assert!(!tools.is_empty(), "{provider} takes an allow-list, so it must name a set");
            for tool in &tools {
                let lower = tool.to_lowercase();
                assert!(
                    !lower.contains("write") && !lower.contains("edit") && !lower.contains("bash")
                        && !lower.contains("shell") && !lower.contains("replace"),
                    "{provider} must not reach {tool} from a conversation with no repository"
                );
            }
            assert!(
                tools.iter().any(|t| t.to_lowercase().contains("read")),
                "{provider} must still be able to read, or an attachment is unreadable"
            );
        }
    }
}
