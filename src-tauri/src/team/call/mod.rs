//! «Llamada con el equipo»: a voice call with a team's agents. The user speaks, whoever was
//! spoken to answers aloud in a voice of its own, the team plans — and when the call ends, what
//! was agreed becomes a run the team carries out.
//!
//! **The call lives here, not in a window**: the microphone, who has the word, what was said and
//! how it ends go on while the window is minimised or the user is in another view. The window
//! draws [`CallState`] and the lines as they come.
//!
//! **Talking is light, working is not.** What an agent says is one text-only answer of its
//! provider's fast model — it starts in about a second, where the agent's own turn takes many. It
//! is told who it is, what the call has said and the facts this computer knows (`stage::facts`);
//! when that is not enough it says so and asks for a look at the code ([`line::Asks::look`]),
//! which is the agent's tool turn, run with the team's permissions while the call goes on.
//! Pending work goes into a run with the team's own models and approvals.
//!
//! **One at a time.** One call (there is one microphone), one voice (whoever has the word), and the
//! user over both: speaking, or the hand, stops whoever is talking.
//!
//! **The user gives the word.** Whoever answers the last thing the user said speaks as soon as it
//! has its answer. Anybody else who comes to have something to say — an agent that was still
//! thinking when the user turned to a colleague, one that comes back from the code after the
//! conversation moved on — raises its hand and waits ([`Hand`]), in the order they finished, until
//! the user gives it the word: a press on its hand, or its name.
//!
//! **Bounded.** A thing said is answered by whoever it names; an agent may hand the word on, at
//! most [`MAX_HANDS`] times per thing said; a question to everybody is one turn each for at most
//! [`ROUND`] members and the lead to close. Nobody speaks without being spoken to.
//!
//! The engine ([`conduct`]) is written against [`Stage`] — what it needs of the world — so a whole
//! call can be run in a test with scripted voices.

pub mod cast;
pub mod commands;
mod ear;
pub mod line;
pub mod route;
pub mod stage;
pub mod wrap;

use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::speech::Voice;
use crate::team::chat::Chat;
use crate::team::MemberSnap;
use route::{Order, To};
use wrap::WrapUp;

pub const STATE_EVENT: &str = "team-call:state";
pub const LINE_EVENT: &str = "team-call:line";
pub const LEVEL_EVENT: &str = "team-call:level";

/// How many times the word may be handed on for one thing the user said.
pub const MAX_HANDS: usize = 3;
/// How many members answer a question to everybody, before the lead closes.
pub const ROUND: usize = 4;
/// How long the team waits before it starts on what was agreed.
pub const COUNTDOWN: Duration = Duration::from_secs(8);

/// One thing said, or noted, in the call.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Line {
    pub id: String,
    /// Into the call.
    pub at_ms: u64,
    /// `user`, a member's id, or `call` for a note of the call's own.
    pub who: String,
    pub name: String,
    pub text: String,
    /// Still being said: the same `id` comes again with more.
    pub partial: bool,
    /// `say` · `note`.
    pub kind: &'static str,
}

/// A participant as the window draws it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeatView {
    pub member_id: String,
    pub agent_id: String,
    pub name: String,
    pub role: String,
    pub icon: String,
    pub color: String,
    pub lead: bool,
    /// `listening` · `thinking` · `speaking` · `looking` (at the code) · `hand` (has something to say).
    pub state: &'static str,
    /// What it is looking at, while it is.
    pub note: String,
    /// Its place among those waiting for the word, from 1 — whoever finished first is first; 0
    /// when it is not waiting.
    pub hand: usize,
    pub voice: Voice,
    pub voice_label: String,
    /// Whose engine it answers with.
    pub provider: String,
    /// The model it talks with in the call: its provider's fast one, or its own where there is none.
    pub model: String,
    /// The model it looks at the code and works with: the agent's own.
    pub own_model: String,
    /// The account it runs as, by the name the user gave it; empty is the provider's own login.
    pub account: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CallState {
    pub id: String,
    pub chat_id: String,
    pub team_id: String,
    pub team_name: String,
    pub workspace_id: String,
    pub lang: &'static str,
    /// `live` · `closing` (the minutes are being written) · `countdown` · `starting` · `started` ·
    /// `ended`.
    pub phase: &'static str,
    /// When it began, in milliseconds since the epoch — the window's clock counts from it.
    pub started_at_ms: u64,
    pub seats: Vec<SeatView>,
    pub mic: bool,
    /// The user is speaking now.
    pub hearing: bool,
    /// `ready` · `missing` (a model to download) · `denied` · `unsupported` · `failed`.
    pub listening: &'static str,
    pub missing: Vec<&'static str>,
    pub headphones: bool,
    /// Which model agents talk with when none was chosen for one: `fast` · `own`.
    pub talk: &'static str,
    pub wrap: Option<WrapUp>,
    pub countdown_ends_ms: Option<u64>,
    pub run_id: Option<String>,
    pub error: String,
    /// Everything said so far — for a window that opens late.
    pub lines: Vec<Line>,
}

/// Something an agent has to say and is waiting to be given the word for.
pub(crate) struct Hand {
    pub member: String,
    pub text: String,
    /// What its words asked of the call — looked at once they are said.
    pub asks: line::Asks,
    /// Whether what it says is still to be kept in the team's conversation: an answer is, what
    /// came back from the code was kept whole when it arrived.
    pub keep: bool,
}

pub(crate) struct Seat {
    pub member: MemberSnap,
    pub voice: Voice,
    pub voice_label: String,
    /// The model it talks with — see [`SeatView::model`].
    pub talk_model: String,
    /// See [`SeatView::account`].
    pub account: String,
    pub lead: bool,
    pub state: &'static str,
    pub note: String,
}

/// A call's whole state. Held behind one lock, taken for a moment at a time.
pub(crate) struct Call {
    pub id: String,
    pub chat: Chat,
    pub lang: &'static str,
    pub started: Instant,
    pub started_at_ms: u64,
    pub seats: Vec<Seat>,
    pub lines: Vec<Line>,
    pub phase: &'static str,
    pub mic: bool,
    pub hearing: bool,
    pub listening: &'static str,
    pub missing: Vec<&'static str>,
    pub headphones: bool,
    /// See [`CallState::talk`].
    pub talk: &'static str,
    /// The agent that spoke last: who an answer with no name goes to.
    pub last: Option<String>,
    /// Who is waiting for the word, whoever finished first at the front.
    pub hands: VecDeque<Hand>,
    /// How many things the user has said: what tells an answer to the last of them from one the
    /// conversation has moved on from.
    pub said: u64,
    /// Who is thinking, and what stops each: `member → (which thought, its stop)`. One thought per
    /// member — asked again, the older one is dropped.
    pub thoughts: HashMap<String, (u64, CancellationToken)>,
    /// The last thought's number.
    pub thought: u64,
    pub wrap: Option<WrapUp>,
    pub countdown_ends_ms: Option<u64>,
    /// Bumped whenever a countdown stops counting, so one that was called off does not fire.
    pub countdown: u64,
    /// How long the countdown is: [`COUNTDOWN`], shorter in a test.
    pub wait: Duration,
    pub run_id: Option<String>,
    pub error: String,
}

impl Call {
    pub fn view(&self) -> CallState {
        CallState {
            id: self.id.clone(),
            chat_id: self.chat.id.clone(),
            team_id: self.chat.team_id.clone(),
            team_name: self.chat.team_name.clone(),
            workspace_id: self.chat.workspace_id.clone(),
            lang: self.lang,
            phase: self.phase,
            started_at_ms: self.started_at_ms,
            seats: self
                .seats
                .iter()
                .map(|seat| SeatView {
                    member_id: seat.member.member.id.clone(),
                    agent_id: seat.member.member.agent_id.clone(),
                    name: crate::team::member_name(&seat.member),
                    role: seat.member.member.role.clone(),
                    icon: seat.member.member.icon.clone(),
                    color: seat.member.member.color.clone(),
                    lead: seat.lead,
                    state: seat.state,
                    note: seat.note.clone(),
                    hand: self.hands.iter().position(|hand| hand.member == seat.member.member.id).map_or(0, |at| at + 1),
                    voice: seat.voice.clone(),
                    voice_label: seat.voice_label.clone(),
                    provider: seat.member.provider.clone(),
                    model: seat.talk_model.clone(),
                    own_model: seat.member.model.clone(),
                    account: seat.account.clone(),
                })
                .collect(),
            mic: self.mic,
            hearing: self.hearing,
            listening: self.listening,
            missing: self.missing.clone(),
            headphones: self.headphones,
            talk: self.talk,
            wrap: self.wrap.clone(),
            countdown_ends_ms: self.countdown_ends_ms,
            run_id: self.run_id.clone(),
            error: self.error.clone(),
            lines: self.lines.clone(),
        }
    }

    fn seat(&self, id: &str) -> Option<&Seat> {
        self.seats.iter().find(|seat| seat.member.member.id == id)
    }

    fn lead(&self) -> Option<&Seat> {
        self.seats.iter().find(|seat| seat.lead)
    }

    fn names(&self) -> Vec<(String, String, String, bool)> {
        self.seats.iter().map(|seat| (seat.member.member.id.clone(), crate::team::member_name(&seat.member), seat.member.member.role.clone(), seat.lead)).collect()
    }

    /// The team as an agent is told it: one row per member.
    fn roster(&self) -> String {
        self.seats
            .iter()
            .map(|seat| {
                let repo = self.chat.member_repos.get(&seat.member.member.id).map(|repo| repo.name.as_str()).unwrap_or(self.chat.project_name.as_str());
                let lead = if seat.lead { if self.lang == "es" { " | lidera" } else { " | leads" } } else { "" };
                format!("- {} | {} | {} | {repo}{lead}", seat.member.member.id, crate::team::member_name(&seat.member), seat.member.member.role.trim())
            })
            .collect::<Vec<_>>()
            .join("\n")
    }
}

/// Borrowed seats for the router, out of [`Call::names`].
fn seats_of(names: &[(String, String, String, bool)]) -> Vec<route::Seat<'_>> {
    names.iter().map(|(id, name, role, lead)| route::Seat { id, name, role, lead: *lead }).collect()
}

/// What happens to a call.
#[derive(Debug)]
pub(crate) enum Event {
    /// The user said `text` — heard, or typed. `over_voice`: an agent was speaking when it was heard.
    Said { text: String, typed: bool, over_voice: bool },
    Hearing(bool),
    /// The hand: whoever is speaking stops.
    Interrupt,
    /// A look at the code came back. `seq`: how many things the user had said when it left.
    Looked { member: String, full: String, said: String, error: Option<String>, seq: u64 },
    /// The user gives the word to `member`, who had its hand up.
    Grant(String),
    /// `member`'s hand is lowered: what it had to say is not wanted.
    Lower(String),
    /// Exchange number so-and-so ended by itself: nobody has the word any more.
    Idle(u64),
    /// The call is hung up: its minutes, and the work if there is any.
    HangUp,
    /// «Empezar ya» during the countdown.
    StartNow,
    /// «Cancelar» during the countdown: the minutes stay, nothing starts.
    CancelStart,
    CountdownOver(u64),
    /// The microphone stopped by itself.
    EarFailed(String),
    /// Something of the call's own changed (the microphone, the headphones): draw it.
    Changed,
    /// The window is done with it.
    Close,
}

/// A voice saying one agent's words: its sentences go in, and it tells when it is done.
pub struct Speaking {
    pub sentences: std::sync::mpsc::Sender<String>,
    pub done: tokio::sync::oneshot::Receiver<()>,
}

/// One agent's turn to think, as the stage needs it.
pub struct Thought {
    pub member: MemberSnap,
    /// The workspace the call is in: whose account the member answers as.
    pub workspace: String,
    pub system: String,
    pub ask: String,
    pub talk: String,
}

/// What a call needs of the world. The app's is [`stage::AppStage`]; a test's is scripted.
pub trait Stage: Clone + Send + Sync + 'static {
    /// `thought.member`'s words. What it writes goes to `written` as it comes, when its engine
    /// writes piece by piece; the whole answer is returned. Stops when `stop` is cancelled.
    fn think(&self, call: &str, thought: Thought, written: mpsc::UnboundedSender<String>, stop: CancellationToken) -> impl Future<Output = Result<String, String>> + Send;
    /// A voice for `member`, saying each sentence it is sent after whatever is being said.
    fn voice(&self, member: &str, voice: &Voice, lang: &'static str) -> Speaking;
    /// Whoever is speaking stops.
    fn hush(&self);
    fn state(&self, state: CallState);
    fn line(&self, line: &Line);
    /// Keeps what was said in the team's conversation.
    fn keep(&self, chat: &Chat, member: Option<&MemberSnap>, text: &str);
    /// What this computer knows that an agent may state as fact.
    fn facts(&self, chat: &Chat, lang: &str) -> String;
    /// `member` reads the repository for `what`: what it found, whole, and as it is said.
    fn look(&self, chat: &Chat, member: MemberSnap, what: String, talk: String, lang: &'static str, stop: CancellationToken) -> impl Future<Output = Result<(String, String), String>> + Send;
    /// The minutes, as the lead's model writes them.
    fn minutes(&self, chat: &Chat, lead: MemberSnap, system: String, talk: String) -> impl Future<Output = Result<String, String>> + Send;
    /// Starts the team on `goal`; the run's id.
    fn start(&self, chat: &Chat, title: String, goal: String) -> impl Future<Output = Result<String, String>> + Send;
    /// The microphone is not wanted any more.
    fn deafen(&self);
}

/// One turn at speaking.
enum Turn {
    Ask { member: String, ask: Asked, hops: usize },
    /// Words already written — the opening, what a look at the code found, what somebody waited
    /// with its hand up to say. `asks`: what those words asked of the call; `keep`: whether they
    /// are still to be kept in the conversation.
    Say { member: String, text: String, asks: line::Asks, keep: bool },
}

enum Asked {
    Direct(String),
    Round { said: String, closing: bool },
    Handed { by: String },
}

type Shared = Arc<Mutex<Call>>;

fn lock(call: &Shared) -> std::sync::MutexGuard<'_, Call> {
    call.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn publish<S: Stage>(stage: &S, call: &Shared) {
    let view = lock(call).view();
    stage.state(view);
}

fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// Adds a line, or replaces the one with its id, and shows it.
fn write<S: Stage>(stage: &S, call: &Shared, line: Line) {
    {
        let mut held = lock(call);
        match held.lines.iter_mut().find(|old| old.id == line.id) {
            Some(old) => *old = line.clone(),
            None => held.lines.push(line.clone()),
        }
    }
    stage.line(&line);
}

fn note<S: Stage>(stage: &S, call: &Shared, text: String) {
    let at_ms = lock(call).started.elapsed().as_millis() as u64;
    write(stage, call, Line { id: id(), at_ms, who: "call".into(), name: String::new(), text, partial: false, kind: "note" });
}

fn set_seat<S: Stage>(stage: &S, call: &Shared, member: &str, state: &'static str, note: &str) {
    {
        let mut held = lock(call);
        // Whoever is waiting for the word goes back to waiting, not to listening.
        let state = if state == "listening" && held.hands.iter().any(|hand| hand.member == member) { "hand" } else { state };
        if let Some(seat) = held.seats.iter_mut().find(|seat| seat.member.member.id == member) {
            seat.state = state;
            seat.note = note.to_string();
        }
    }
    publish(stage, call);
}

/// `member` has `text` to say and waits for the word, behind whoever was already waiting. One
/// that was waiting keeps its place and says both.
fn raise<S: Stage>(stage: &S, call: &Shared, member: &str, text: String, asks: line::Asks, keep: bool) {
    {
        let mut held = lock(call);
        match held.hands.iter_mut().find(|hand| hand.member == member) {
            Some(hand) => {
                hand.text = format!("{} {text}", hand.text);
                hand.asks = line::Asks { look: asks.look.or(hand.asks.look.take()), hand: asks.hand.or(hand.asks.hand.take()) };
                hand.keep |= keep;
            }
            None => held.hands.push_back(Hand { member: member.to_string(), text, asks, keep }),
        }
    }
    set_seat(stage, call, member, "hand", "");
}

/// Takes `member`'s hand down and hands over what it was waiting to say, as its turn.
fn granted(call: &Shared, member: &str) -> Option<Turn> {
    let mut held = lock(call);
    let at = held.hands.iter().position(|hand| hand.member == member)?;
    let hand = held.hands.remove(at)?;
    Some(Turn::Say { member: hand.member, text: hand.text, asks: hand.asks, keep: hand.keep })
}

/// The exchange that has the word: its number, what stops it outright, and what tells it the user
/// has moved on to something else.
struct Floor {
    number: u64,
    stop: CancellationToken,
    moved: CancellationToken,
}

impl Floor {
    /// Stops it: whoever was speaking or thinking in it is cut off.
    fn cut(self) {
        self.stop.cancel();
    }

    /// The user turned to something else: whoever was speaking stops, whoever was still thinking
    /// finishes behind the call and raises its hand.
    fn aside(self) {
        self.moved.cancel();
    }
}

/// Runs a call until its window lets go of it: every [`Event`], in order.
pub(crate) async fn conduct<S: Stage>(stage: S, call: Shared, events: mpsc::UnboundedSender<Event>, mut inbox: mpsc::UnboundedReceiver<Event>, opening: String) {
    // The exchange that has the word.
    let mut talking: Option<Floor> = None;
    let mut exchanges = 0u64;
    let looks = CancellationToken::new();
    let mut begin = |turns: Vec<Turn>| {
        if turns.is_empty() {
            return None;
        }
        exchanges += 1;
        Some(begin(&stage, &call, &events, &looks, exchanges, turns))
    };
    publish(&stage, &call);
    // The lead opens: the call is heard to have started before anybody asks anything.
    if let Some(lead) = lock(&call).lead().map(|seat| seat.member.member.id.clone()) {
        if !opening.trim().is_empty() {
            talking = begin(vec![Turn::Say { member: lead, text: opening, asks: line::Asks::default(), keep: false }]);
        }
    }
    while let Some(event) = inbox.recv().await {
        let phase = lock(&call).phase;
        match event {
            Event::Said { text, typed, over_voice } if phase == "live" => {
                let names = lock(&call).names();
                let seats = seats_of(&names);
                // On speakers, what is heard over an agent's voice may be that voice: only a name
                // or a «esperen» gets through. With headphones, or typed, it is the user.
                if over_voice && !typed && !lock(&call).headphones && !route::cuts_in(&text, &seats) {
                    continue;
                }
                let routed = route::route(&text, &seats);
                let at_ms = lock(&call).started.elapsed().as_millis() as u64;
                write(&stage, &call, Line { id: id(), at_ms, who: "user".into(), name: String::new(), text: text.clone(), partial: false, kind: "say" });
                let chat = lock(&call).chat.clone();
                stage.keep(&chat, None, &text);
                match routed.order {
                    Some(order) => {
                        // An order is for everybody: whoever has the word is cut off.
                        if let Some(floor) = talking.take() {
                            floor.cut();
                        }
                        stage.hush();
                        match order {
                            Order::Wait => {}
                            Order::End => close(&stage, &call, &events, &looks, false).await,
                            Order::Go => close(&stage, &call, &events, &looks, true).await,
                        }
                    }
                    None => {
                        // The user has the word now, and gives it: whoever was speaking stops, and
                        // whoever was still thinking keeps what it has for when it is asked.
                        if let Some(floor) = talking.take() {
                            floor.aside();
                        }
                        stage.hush();
                        lock(&call).said += 1;
                        talking = begin(turns_for(&call, &routed.to, &text, route::yields(&text, &seats)));
                    }
                }
            }
            Event::Hearing(hearing) => {
                lock(&call).hearing = hearing;
                publish(&stage, &call);
            }
            Event::Interrupt => {
                if let Some(floor) = talking.take() {
                    floor.cut();
                }
                stage.hush();
                // Whoever was waiting for the word keeps waiting: the user has it now.
            }
            Event::Grant(member) if phase == "live" => {
                if let Some(turn) = granted(&call, &member) {
                    if let Some(floor) = talking.take() {
                        floor.aside();
                    }
                    stage.hush();
                    talking = begin(vec![turn]);
                }
            }
            Event::Lower(member) if phase == "live" => {
                let lowered = {
                    let mut held = lock(&call);
                    let before = held.hands.len();
                    held.hands.retain(|hand| hand.member != member);
                    held.hands.len() != before
                };
                if lowered {
                    set_seat(&stage, &call, &member, "listening", "");
                }
            }
            Event::Looked { member, full, said, error, seq } if phase == "live" => {
                let (chat, seat) = {
                    let held = lock(&call);
                    (held.chat.clone(), held.seat(&member).map(|seat| seat.member.clone()))
                };
                match error {
                    Some(error) => {
                        let name = seat.as_ref().map(crate::team::member_name).unwrap_or_default();
                        let lang = lock(&call).lang;
                        note(&stage, &call, if lang == "es" { format!("{name} no pudo revisar el código: {error}") } else { format!("{name} could not look at the code: {error}") });
                        set_seat(&stage, &call, &member, "listening", "");
                    }
                    None => {
                        // The whole of what it found is the conversation's; the call hears the gist.
                        stage.keep(&chat, seat.as_ref(), &full);
                        // Back while the room is still on what it went to look at, and quiet: it
                        // says it. Otherwise the conversation went elsewhere: it asks for the word.
                        if talking.is_none() && lock(&call).said == seq {
                            talking = begin(vec![Turn::Say { member, text: said, asks: line::Asks::default(), keep: false }]);
                        } else {
                            raise(&stage, &call, &member, said, line::Asks::default(), false);
                        }
                    }
                }
            }
            Event::Idle(number) => {
                // Only the exchange that has the word gives it up: one that was cut off for a new
                // one may still be reporting its end. Whoever has a hand up waits for the user.
                if talking.as_ref().is_some_and(|floor| floor.number == number) {
                    talking = None;
                }
            }
            Event::HangUp => match phase {
                "live" => {
                    if let Some(floor) = talking.take() {
                        floor.cut();
                    }
                    close(&stage, &call, &events, &looks, false).await;
                }
                "countdown" => call_off(&stage, &call),
                _ => {}
            },
            Event::StartNow if phase == "countdown" => start(&stage, &call).await,
            Event::CancelStart if phase == "countdown" => call_off(&stage, &call),
            Event::CountdownOver(token) if phase == "countdown" && lock(&call).countdown == token => start(&stage, &call).await,
            Event::EarFailed(error) => {
                {
                    let mut held = lock(&call);
                    held.listening = "failed";
                    held.mic = false;
                    held.error = error;
                }
                publish(&stage, &call);
            }
            Event::Changed => publish(&stage, &call),
            Event::Close => break,
            _ => {}
        }
    }
    if let Some(floor) = talking.take() {
        floor.cut();
    }
    looks.cancel();
    quiet(&call);
    stage.hush();
    stage.deafen();
    lock(&call).phase = "ended";
    publish(&stage, &call);
}

/// Nobody goes on thinking and nobody is waiting for the word: the call is over.
fn quiet(call: &Shared) {
    let mut held = lock(call);
    for (_, (_, stop)) in held.thoughts.drain() {
        stop.cancel();
    }
    held.hands.clear();
}

/// Who answers what was `said`. `yields`: it asks nothing — it gives somebody the word.
fn turns_for(call: &Shared, to: &To, said: &str, yields: bool) -> Vec<Turn> {
    let mut held = lock(call);
    let lead = held.lead().map(|seat| seat.member.member.id.clone());
    let ask = |member: &str| Turn::Ask { member: member.to_string(), ask: Asked::Direct(said.to_string()), hops: 0 };
    fn take(hands: &mut VecDeque<Hand>, member: &str) -> Option<Turn> {
        let at = hands.iter().position(|hand| hand.member == member)?;
        hands.remove(at).map(|hand| Turn::Say { member: hand.member, text: hand.text, asks: hand.asks, keep: hand.keep })
    }
    match to {
        To::Members(ids) => {
            let mut turns = Vec::new();
            for member in ids {
                // Named with its hand up: it has the word, and says what it was waiting to say.
                // Asked something as well, it answers that after.
                match take(&mut held.hands, member) {
                    Some(turn) => {
                        turns.push(turn);
                        if !yields {
                            turns.push(ask(member));
                        }
                    }
                    None => turns.push(ask(member)),
                }
            }
            turns
        }
        To::Team => {
            let mut turns: Vec<Turn> = held
                .seats
                .iter()
                .filter(|seat| !seat.lead)
                .take(ROUND)
                .map(|seat| Turn::Ask { member: seat.member.member.id.clone(), ask: Asked::Round { said: said.to_string(), closing: false }, hops: MAX_HANDS })
                .collect();
            if let Some(lead) = lead {
                turns.push(Turn::Ask { member: lead, ask: Asked::Round { said: said.to_string(), closing: true }, hops: MAX_HANDS });
            }
            turns
        }
        To::Open => {
            // «Adelante», «el siguiente»: whoever has waited longest.
            if yields {
                let first = held.hands.front().map(|hand| hand.member.clone());
                if let Some(turn) = first.and_then(|member| take(&mut held.hands, &member)) {
                    return vec![turn];
                }
            }
            let member = held.last.clone().filter(|id| held.seat(id).is_some()).or(lead);
            member.map(|member| vec![ask(&member)]).unwrap_or_default()
        }
    }
}

/// Starts exchange `number` — the turns that answer one thing — and returns what ends it.
fn begin<S: Stage>(stage: &S, call: &Shared, events: &mpsc::UnboundedSender<Event>, looks: &CancellationToken, number: u64, turns: Vec<Turn>) -> Floor {
    let floor = Floor { number, stop: CancellationToken::new(), moved: CancellationToken::new() };
    let (stage, call, events, looks, stop, moved) = (stage.clone(), call.clone(), events.clone(), looks.clone(), floor.stop.clone(), floor.moved.clone());
    tokio::spawn(async move {
        exchange(&stage, &call, &events, &looks, turns, &stop, &moved).await;
        if !stop.is_cancelled() && !moved.is_cancelled() {
            let _ = events.send(Event::Idle(number));
        }
    });
    floor
}

async fn exchange<S: Stage>(stage: &S, call: &Shared, events: &mpsc::UnboundedSender<Event>, looks: &CancellationToken, turns: Vec<Turn>, stop: &CancellationToken, moved: &CancellationToken) {
    let mut turns: VecDeque<Turn> = turns.into();
    let mut handed = 0usize;
    while let Some(turn) = turns.pop_front() {
        // The user moved on: whoever had not started does not.
        if stop.is_cancelled() || moved.is_cancelled() {
            break;
        }
        let (member, asks, hops) = match turn {
            Turn::Say { member, text, asks, keep } => {
                let Some((voice, name, snap)) = lock(call).seat(&member).map(|seat| (seat.voice.clone(), crate::team::member_name(&seat.member), seat.member.clone())) else { continue };
                set_seat(stage, call, &member, "speaking", "");
                let (at_ms, lang, chat) = {
                    let held = lock(call);
                    (held.started.elapsed().as_millis() as u64, held.lang, held.chat.clone())
                };
                write(stage, call, Line { id: id(), at_ms, who: member.clone(), name, text: text.clone(), partial: false, kind: "say" });
                if keep {
                    stage.keep(&chat, Some(&snap), &text);
                }
                let speaking = stage.voice(&member, &voice, lang);
                let _ = speaking.sentences.send(text);
                drop(speaking.sentences);
                tokio::select! {
                    _ = speaking.done => {}
                    _ = stop.cancelled() => {}
                    _ = moved.cancelled() => {}
                }
                lock(call).last = Some(member.clone());
                // A look it asked for shows on its seat from here; otherwise it goes back to listening.
                if asks.look.is_none() {
                    set_seat(stage, call, &member, "listening", "");
                }
                (member, asks, 0)
            }
            Turn::Ask { member, ask, hops } => {
                let Some(asks) = speak(stage, call, &member, &ask, stop, moved).await else { continue };
                (member, asks, hops)
            }
        };
        if let Some(what) = asks.look {
            look(stage, call, events, looks, &member, what);
        }
        // The word is handed on only while this is still what the room is on.
        if stop.is_cancelled() || moved.is_cancelled() {
            break;
        }
        if let Some(to) = asks.hand {
            let names = lock(call).names();
            let target = names
                .iter()
                .find(|(id, ..)| *id == to.trim())
                .map(|(id, ..)| id.clone())
                .or_else(|| match route::route(&to, &seats_of(&names)).to {
                    To::Members(ids) => ids.into_iter().next(),
                    _ => None,
                })
                .filter(|id| *id != member);
            if let Some(target) = target {
                if hops < MAX_HANDS && handed < MAX_HANDS {
                    handed += 1;
                    let by = names.iter().find(|(id, ..)| *id == member).map(|(_, name, ..)| name.clone()).unwrap_or_default();
                    turns.push_front(Turn::Ask { member: target, ask: Asked::Handed { by }, hops: hops + 1 });
                }
            }
        }
    }
}

/// One agent thinks and says it. What it asked of the call, or nothing when it could not answer —
/// or when the user moved on (`moved`) before it had begun to speak: then it goes on thinking
/// behind the call and raises its hand with what it has to say.
async fn speak<S: Stage>(stage: &S, call: &Shared, member: &str, ask: &Asked, stop: &CancellationToken, moved: &CancellationToken) -> Option<line::Asks> {
    // The facts are a look at the database: read before the call's lock is taken.
    let (chat, lang) = {
        let held = lock(call);
        (held.chat.clone(), held.lang)
    };
    let facts = stage.facts(&chat, lang);
    let (thought, voice, name, call_id, line_id) = {
        let held = lock(call);
        let seat = held.seat(member)?;
        let said = match ask {
            Asked::Direct(said) => line::ask(&line::Ask::Direct(said), lang),
            Asked::Round { said, closing } => line::ask(&line::Ask::Round { said, closing: *closing }, lang),
            Asked::Handed { by } => line::ask(&line::Ask::Handed { by }, lang),
        };
        let thought = Thought { member: seat.member.clone(), workspace: held.chat.workspace_id.clone(), system: line::system(&seat.member, &held.chat.team_name, seat.lead, &held.roster(), &facts, lang), ask: said, talk: line::talk(&held.lines, lang) };
        (thought, seat.voice.clone(), crate::team::member_name(&seat.member), held.id.clone(), id())
    };
    // One thought per member: asked again while it was still on an older question, that one goes.
    let (mine, number) = {
        let mut held = lock(call);
        held.thought += 1;
        let (mine, number) = (stop.child_token(), held.thought);
        if let Some((_, older)) = held.thoughts.insert(member.to_string(), (number, mine.clone())) {
            older.cancel();
        }
        (mine, number)
    };
    let member_snap = thought.member.clone();
    set_seat(stage, call, member, "thinking", "");
    let at_ms = lock(call).started.elapsed().as_millis() as u64;
    let (written, mut pieces) = mpsc::unbounded_channel::<String>();
    let thinking = stage.think(&call_id, thought, written, mine.clone());
    tokio::pin!(thinking);
    let mut cutter = line::Cutter::default();
    let mut speaking: Option<Speaking> = None;
    let say = |sentences: Vec<String>, speaking: &mut Option<Speaking>| {
        for sentence in sentences {
            if speaking.is_none() {
                set_seat(stage, call, member, "speaking", "");
                *speaking = Some(stage.voice(member, &voice, lang));
            }
            if let Some(voice) = speaking.as_ref() {
                let _ = voice.sentences.send(sentence);
            }
        }
    };
    let show = |text: String, partial: bool| write(stage, call, Line { id: line_id.clone(), at_ms, who: member.to_string(), name: name.clone(), text, partial, kind: "say" });
    // The user moved on before it had said a word: it thinks on, unheard and unseen.
    let mut aside = false;
    let answer = loop {
        tokio::select! {
            biased;
            _ = moved.cancelled(), if !aside && !mine.is_cancelled() => {
                // Already speaking, it is cut off; still thinking, it keeps its answer for later.
                if speaking.is_some() {
                    mine.cancel();
                } else {
                    aside = true;
                }
            }
            // Disabled once the writer is done, so the answer is what is waited for.
            Some(piece) = pieces.recv() => {
                let sentences = cutter.push(&piece);
                if !aside {
                    say(sentences, &mut speaking);
                    // Written on screen from its first sentence on: what shows is what is being said.
                    if speaking.is_some() {
                        show(cutter.so_far(), true);
                    }
                }
            }
            answer = &mut thinking => break answer,
        }
    };
    // The same moment for both: an answer that came back as the user moved on waits for the word.
    if !aside && speaking.is_none() && moved.is_cancelled() && !mine.is_cancelled() {
        aside = true;
    }
    // Whatever was still on its way when the answer came back.
    while let Ok(piece) = pieces.try_recv() {
        let sentences = cutter.push(&piece);
        if !aside {
            say(sentences, &mut speaking);
        }
    }
    let stopped = mine.is_cancelled();
    // Whether this is still the member's thought: asked again meanwhile, the newer one has its seat.
    let ended = |call: &Shared| {
        let mut held = lock(call);
        let current = held.thoughts.get(member).is_some_and(|(current, _)| *current == number);
        if current {
            held.thoughts.remove(member);
        }
        current
    };
    if aside {
        let waiting = match answer {
            Ok(written) if !stopped => Some(line::read(&written)).filter(|(said, _)| !said.is_empty()),
            Err(error) if !stopped => {
                note(stage, call, if lang == "es" { format!("{name} no pudo responder: {error}") } else { format!("{name} could not answer: {error}") });
                None
            }
            _ => None,
        };
        if ended(call) {
            match waiting {
                Some((said, asks)) => raise(stage, call, member, said, asks, true),
                None => set_seat(stage, call, member, "listening", ""),
            }
        }
        return None;
    }
    let result = match answer {
        Ok(written) if !stopped => {
            let (said, asks) = line::read(&written);
            say(cutter.finish(&written), &mut speaking);
            if said.is_empty() {
                None
            } else {
                show(said.clone(), false);
                stage.keep(&chat, Some(&member_snap), &said);
                Some(asks)
            }
        }
        Ok(_) | Err(_) if stopped => {
            // Cut off: what was said stays, as far as it got.
            let so_far = cutter.so_far();
            if speaking.is_some() && !so_far.is_empty() {
                show(format!("{so_far}…"), false);
                stage.keep(&chat, Some(&member_snap), &so_far);
            }
            None
        }
        Ok(_) => None,
        Err(error) => {
            // What it got to say before failing stays as said, not as still being said.
            let so_far = cutter.so_far();
            if speaking.is_some() && !so_far.is_empty() {
                show(format!("{so_far}…"), false);
            }
            note(stage, call, if lang == "es" { format!("{name} no pudo responder: {error}") } else { format!("{name} could not answer: {error}") });
            None
        }
    };
    if let Some(voice) = speaking.take() {
        drop(voice.sentences);
        tokio::select! {
            _ = voice.done => {}
            _ = mine.cancelled() => {}
            _ = moved.cancelled() => {}
        }
    }
    if result.is_some() {
        lock(call).last = Some(member.to_string());
    }
    // A look it asked for shows on its seat from here; otherwise it goes back to listening.
    if ended(call) && result.as_ref().is_none_or(|asks| asks.look.is_none()) {
        set_seat(stage, call, member, "listening", "");
    }
    result
}

/// `member` goes to read the code for `what`, while the call goes on.
fn look<S: Stage>(stage: &S, call: &Shared, events: &mpsc::UnboundedSender<Event>, looks: &CancellationToken, member: &str, what: String) {
    let (chat, snap, talk, lang, seq) = {
        let held = lock(call);
        let Some(seat) = held.seat(member) else { return };
        (held.chat.clone(), seat.member.clone(), line::talk(&held.lines, held.lang), held.lang, held.said)
    };
    set_seat(stage, call, member, "looking", &what);
    let (stage, events, member, stop) = (stage.clone(), events.clone(), member.to_string(), looks.clone());
    tokio::spawn(async move {
        let found = stage.look(&chat, snap, what, talk, lang, stop.clone()).await;
        if stop.is_cancelled() {
            return;
        }
        let _ = events.send(match found {
            Ok((full, said)) => Event::Looked { member, full, said, error: None, seq },
            Err(error) => Event::Looked { member, full: String::new(), said: String::new(), error: Some(error), seq },
        });
    });
}

/// The call is over: the minutes are written, and if work was agreed the team is about to start —
/// at once when it was told to (`now`), after the countdown otherwise. Whatever the agents were
/// still doing for the call — a look at the code, an answer nobody heard — stops here.
async fn close<S: Stage>(stage: &S, call: &Shared, events: &mpsc::UnboundedSender<Event>, looks: &CancellationToken, now: bool) {
    stage.hush();
    stage.deafen();
    // Nothing of the call goes on behind it: whoever was reading the code or still thinking stops.
    // What the team does from here is the run, if work was agreed.
    looks.cancel();
    quiet(call);
    let (chat, lead, system, talk, lang, spoke) = {
        let mut held = lock(call);
        held.phase = "closing";
        held.mic = false;
        held.hearing = false;
        for seat in &mut held.seats {
            seat.state = "listening";
            seat.note.clear();
        }
        let spoke = held.lines.iter().any(|line| line.who == "user" && line.kind == "say");
        (held.chat.clone(), held.lead().map(|seat| seat.member.clone()), wrap::system(&held.roster(), held.lang), line::talk(&held.lines, held.lang), held.lang, spoke)
    };
    publish(stage, call);
    let ended = |error: String| {
        let mut held = lock(call);
        held.phase = "ended";
        held.error = error;
    };
    // A call where the user said nothing has nothing to write down.
    let (Some(lead), true) = (lead, spoke) else {
        ended(String::new());
        return publish(stage, call);
    };
    let written = stage.minutes(&chat, lead.clone(), system, talk).await;
    let names = lock(call).names();
    let wrap = match written.and_then(|written| wrap::parse(&written, &seats_of(&names))) {
        Ok(wrap) => wrap,
        Err(error) => {
            ended(if lang == "es" { format!("No se pudo escribir el acta: {error}. La conversación quedó guardada en el chat del equipo.") } else { format!("The minutes could not be written: {error}. The conversation is kept in the team's chat.") });
            return publish(stage, call);
        }
    };
    stage.keep(&chat, Some(&lead), &wrap::markdown(&wrap, lang));
    let work = !wrap.tasks.is_empty();
    let closing = wrap.closing.clone();
    {
        let mut held = lock(call);
        held.wrap = Some(wrap);
        if !work {
            held.phase = "ended";
        }
    }
    publish(stage, call);
    if !work {
        return;
    }
    // The lead says what the team does now, and then it does.
    if !closing.is_empty() {
        let (member, voice) = {
            let held = lock(call);
            let seat = held.lead().expect("the lead wrote the minutes");
            (seat.member.member.id.clone(), seat.voice.clone())
        };
        set_seat(stage, call, &member, "speaking", "");
        let at_ms = lock(call).started.elapsed().as_millis() as u64;
        write(stage, call, Line { id: id(), at_ms, who: member.clone(), name: crate::team::member_name(&lead), text: closing.clone(), partial: false, kind: "say" });
        let speaking = stage.voice(&member, &voice, lang);
        let _ = speaking.sentences.send(closing);
        drop(speaking.sentences);
        let _ = tokio::time::timeout(Duration::from_secs(30), speaking.done).await;
        set_seat(stage, call, &member, "listening", "");
    }
    if now {
        return start(stage, call).await;
    }
    let (token, wait) = {
        let mut held = lock(call);
        held.phase = "countdown";
        held.countdown += 1;
        held.countdown_ends_ms = Some(epoch_ms() + held.wait.as_millis() as u64);
        (held.countdown, held.wait)
    };
    publish(stage, call);
    let events = events.clone();
    tokio::spawn(async move {
        tokio::time::sleep(wait).await;
        let _ = events.send(Event::CountdownOver(token));
    });
}

/// «Cancelar»: the minutes stay, the team does not start.
fn call_off<S: Stage>(stage: &S, call: &Shared) {
    {
        let mut held = lock(call);
        held.phase = "ended";
        held.countdown += 1;
        held.countdown_ends_ms = None;
    }
    publish(stage, call);
}

async fn start<S: Stage>(stage: &S, call: &Shared) {
    let (chat, title, goal, lang) = {
        let mut held = lock(call);
        held.phase = "starting";
        held.countdown += 1;
        held.countdown_ends_ms = None;
        let wrap = held.wrap.clone().unwrap_or_default();
        let title = if wrap.title.is_empty() { wrap.tasks.first().map(|task| task.title.clone()).unwrap_or_default() } else { wrap.title.clone() };
        (held.chat.clone(), title, wrap::goal(&wrap, &held.lines, held.lang), held.lang)
    };
    publish(stage, call);
    let started = stage.start(&chat, title, goal).await;
    {
        let mut held = lock(call);
        match started {
            Ok(run) => {
                held.phase = "started";
                held.run_id = Some(run);
            }
            Err(error) => {
                held.phase = "ended";
                held.error = if lang == "es" { format!("El equipo no pudo empezar: {error}") } else { format!("The team could not start: {error}") };
            }
        }
    }
    publish(stage, call);
}

pub(crate) fn epoch_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// What the lead says when the call starts. Written, not thought: the call is heard to have begun
/// the moment it does.
pub(crate) fn opening(lead: &str, others: &[String], lang: &str) -> String {
    let es = lang == "es";
    let who = match others.len() {
        0 => String::new(),
        1 => others[0].clone(),
        n if n <= 4 => format!("{} {} {}", others[..n - 1].join(", "), if es { "y" } else { "and" }, others[n - 1]),
        n => {
            if es {
                format!("{} y {} más", others[..3].join(", "), n - 3)
            } else {
                format!("{} and {} more", others[..3].join(", "), n - 3)
            }
        }
    };
    match (es, who.is_empty()) {
        (true, true) => format!("Hola, aquí {lead}. Te escucho: ¿de qué hablamos?"),
        (true, false) => format!("Hola, aquí {lead}. Estamos {who}. ¿De qué hablamos?"),
        (false, true) => format!("Hi, {lead} here. I'm listening: what are we talking about?"),
        (false, false) => format!("Hi, {lead} here. With me: {who}. What are we talking about?"),
    }
}

#[cfg(test)]
mod tests;
