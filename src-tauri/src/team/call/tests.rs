//! A whole call, run with scripted voices: who answers, who is handed the word, what a look at the
//! code brings back, and how hanging up turns what was agreed into work.

use std::collections::HashMap;
use std::sync::Mutex as StdMutex;

use super::*;
use crate::team::chat::RepoRef;
use crate::team::Member;

#[derive(Default)]
struct Script {
    /// What each member writes, in order, each time it is asked.
    answers: HashMap<String, VecDeque<String>>,
    /// What each member was asked.
    asked: Vec<(String, String)>,
    /// Every sentence a voice was given: `(member, sentence)`.
    said: Vec<(String, String)>,
    kept: Vec<(String, String)>,
    looked: Vec<(String, String)>,
    minutes: String,
    started: Vec<(String, String)>,
    states: Vec<CallState>,
    hushed: usize,
    /// A turn that never ends by itself: only a stop ends it.
    stuck: Option<String>,
    /// Members whose answer waits to be let go: thinking for as long as the test wants.
    held: HashMap<String, Arc<tokio::sync::Notify>>,
}

#[derive(Clone, Default)]
struct Scripted(Arc<StdMutex<Script>>);

impl Scripted {
    fn with<T>(&self, f: impl FnOnce(&mut Script) -> T) -> T {
        f(&mut self.0.lock().unwrap())
    }
    fn answers(&self, member: &str, answers: &[&str]) {
        self.with(|s| s.answers.insert(member.into(), answers.iter().map(|a| a.to_string()).collect()));
    }
    fn said(&self) -> Vec<(String, String)> {
        self.with(|s| s.said.clone())
    }
    /// `member` thinks until [`Scripted::let_go`].
    fn hold(&self, member: &str) {
        self.with(|s| s.held.insert(member.into(), Arc::new(tokio::sync::Notify::new())));
    }
    fn let_go(&self, member: &str) {
        if let Some(gate) = self.with(|s| s.held.remove(member)) {
            gate.notify_one();
        }
    }
    fn phase(&self) -> &'static str {
        self.with(|s| s.states.last().map(|state| state.phase).unwrap_or("none"))
    }
}

impl Stage for Scripted {
    fn think(&self, _call: &str, thought: Thought, written: mpsc::UnboundedSender<String>, stop: CancellationToken) -> impl Future<Output = Result<String, String>> + Send {
        let member = thought.member.member.id.clone();
        let (answer, stuck, gate) = self.with(|s| {
            s.asked.push((member.clone(), thought.ask.clone()));
            (s.answers.get_mut(&member).and_then(VecDeque::pop_front), s.stuck.as_deref() == Some(member.as_str()), s.held.get(&member).cloned())
        });
        async move {
            if let Some(gate) = gate {
                tokio::select! {
                    _ = gate.notified() => {}
                    _ = stop.cancelled() => return Err(crate::ai_runs::CANCELLED_MARKER.to_string()),
                }
            }
            if stuck {
                let _ = written.send("Empiezo a explicar algo largo. ".to_string());
                stop.cancelled().await;
                return Err(crate::ai_runs::CANCELLED_MARKER.to_string());
            }
            let answer = answer.ok_or("no answer scripted")?;
            // Written a word at a time, as an engine that streams does.
            for word in answer.split_inclusive(' ') {
                let _ = written.send(word.to_string());
            }
            Ok(answer)
        }
    }

    fn voice(&self, member: &str, _voice: &Voice, _lang: &'static str) -> Speaking {
        let (sentences, incoming) = std::sync::mpsc::channel::<String>();
        let (done, ended) = tokio::sync::oneshot::channel();
        let (script, member) = (self.0.clone(), member.to_string());
        std::thread::spawn(move || {
            for sentence in incoming {
                script.lock().unwrap().said.push((member.clone(), sentence));
            }
            let _ = done.send(());
        });
        Speaking { sentences, done: ended }
    }

    fn hush(&self) {
        self.with(|s| s.hushed += 1);
    }
    fn state(&self, state: CallState) {
        self.with(|s| s.states.push(state));
    }
    fn line(&self, _line: &Line) {}
    fn keep(&self, _chat: &Chat, member: Option<&MemberSnap>, text: &str) {
        let who = member.map(|m| m.member.id.clone()).unwrap_or_else(|| "user".into());
        self.with(|s| s.kept.push((who, text.to_string())));
    }
    fn facts(&self, _chat: &Chat, _lang: &str) -> String {
        "- Corrida «Autenticación»: 2 de 3 tareas terminadas.".into()
    }
    fn look(&self, _chat: &Chat, member: MemberSnap, what: String, _talk: String, _lang: &'static str, _stop: CancellationToken) -> impl Future<Output = Result<(String, String), String>> + Send {
        let gate = self.with(|s| {
            s.looked.push((member.member.id.clone(), what.clone()));
            s.held.get(&format!("look:{}", member.member.id)).cloned()
        });
        async move {
            if let Some(gate) = gate {
                gate.notified().await;
            }
            Ok((format!("Informe completo sobre {what} en `cita.repository.ts`."), format!("Revisé {what}: falta un índice.")))
        }
    }
    fn minutes(&self, _chat: &Chat, _lead: MemberSnap, _system: String, _talk: String) -> impl Future<Output = Result<String, String>> + Send {
        let minutes = self.with(|s| s.minutes.clone());
        async move { if minutes.is_empty() { Err("no minutes scripted".to_string()) } else { Ok(minutes) } }
    }
    fn start(&self, _chat: &Chat, title: String, goal: String) -> impl Future<Output = Result<String, String>> + Send {
        self.with(|s| s.started.push((title, goal)));
        async move { Ok("run-1".to_string()) }
    }
    fn deafen(&self) {}
}

fn member(id: &str, name: &str, role: &str) -> MemberSnap {
    MemberSnap { member: Member { id: id.into(), agent_id: format!("agent-{id}"), name: name.into(), role: role.into(), ..Default::default() }, provider: "claude".into(), model: "opus".into(), ..Default::default() }
}

fn call() -> Shared {
    let members = vec![member("lead", "Arquitecto", "Arquitectura"), member("dba", "DBA", "Base de datos"), member("qa", "QA", "Calidad"), member("dev", "Backend", "Implementación")];
    let chat = Chat {
        id: "chat".into(),
        workspace_id: "ws".into(),
        project_id: "repo".into(),
        project_name: "core".into(),
        team_id: "team".into(),
        team_name: "Equipo Agenda".into(),
        team_updated_at: String::new(),
        lead_id: "lead".into(),
        task_id: "task".into(),
        members: members.clone(),
        policy: Default::default(),
        status: "idle".into(),
        active_member_id: String::new(),
        active_run_id: String::new(),
        error: String::new(),
        revision: 0,
        created_at: String::new(),
        member_repos: HashMap::from([("dba".to_string(), RepoRef { id: "repo2".into(), name: "agenda".into(), scope: String::new() })]),
    };
    let seats = members.into_iter().map(|member| Seat { lead: member.member.id == "lead", voice: Voice::default(), voice_label: String::new(), talk_model: "haiku".into(), account: String::new(), member, state: "listening", note: String::new() }).collect();
    Arc::new(Mutex::new(Call {
        id: "call".into(),
        chat,
        lang: "es",
        started: Instant::now(),
        started_at_ms: 0,
        seats,
        lines: Vec::new(),
        phase: "live",
        mic: true,
        hearing: false,
        listening: "ready",
        missing: Vec::new(),
        headphones: false,
        talk: "fast",
        last: None,
        hands: Default::default(),
        said: 0,
        thoughts: Default::default(),
        thought: 0,
        wrap: None,
        countdown_ends_ms: None,
        countdown: 0,
        wait: Duration::from_millis(120),
        run_id: None,
        error: String::new(),
    }))
}

struct Room {
    stage: Scripted,
    call: Shared,
    events: mpsc::UnboundedSender<Event>,
}

impl Room {
    fn open() -> Self {
        let (stage, call) = (Scripted::default(), call());
        let (events, inbox) = mpsc::unbounded_channel();
        tokio::spawn(conduct(stage.clone(), call.clone(), events.clone(), inbox, String::new()));
        Room { stage, call, events }
    }
    fn say(&self, text: &str) {
        self.events.send(Event::Said { text: text.into(), typed: true, over_voice: false }).unwrap();
    }
    /// Waits until `ready` holds, or fails the test saying what was there instead.
    async fn until(&self, what: &str, ready: impl Fn(&Self) -> bool) {
        for _ in 0..400 {
            if ready(self) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("{what}: said {:?}, phase {}", self.stage.said(), self.stage.phase());
    }
    fn lines(&self) -> Vec<(String, String)> {
        lock(&self.call).lines.iter().filter(|line| line.kind == "say").map(|line| (line.who.clone(), line.text.clone())).collect()
    }
    fn seat_state(&self, member: &str) -> &'static str {
        lock(&self.call).seat(member).map(|seat| seat.state).unwrap_or("gone")
    }
}

#[tokio::test]
async fn whoever_is_named_answers_aloud_a_sentence_at_a_time_and_a_reply_goes_to_who_spoke_last() {
    let room = Room::open();
    room.stage.answers("dba", &["La base está bien armada. Faltan dos índices.", "Porque las consultas por fecha recorren toda la tabla."]);
    room.say("DBA, ¿cómo ves la base de datos?");
    room.until("the DBA's two sentences", |r| r.stage.said().len() == 2).await;
    assert_eq!(room.stage.said(), vec![("dba".to_string(), "La base está bien armada.".to_string()), ("dba".to_string(), "Faltan dos índices.".to_string())]);
    assert_eq!(room.lines(), vec![("user".to_string(), "DBA, ¿cómo ves la base de datos?".to_string()), ("dba".to_string(), "La base está bien armada. Faltan dos índices.".to_string())]);

    // No name: whoever spoke last is who is being answered.
    room.until("the DBA back to listening", |r| r.seat_state("dba") == "listening" && lock(&r.call).last.is_some()).await;
    room.say("¿Y por qué?");
    room.until("the reply", |r| r.stage.said().len() == 3).await;
    assert_eq!(room.stage.said()[2].0, "dba");
    // What it was told: who it is, what the call knows for a fact, and what was said so far.
    let asked = room.stage.with(|s| s.asked.clone());
    assert!(asked[0].1.contains("«DBA, ¿cómo ves la base de datos?»"), "{asked:?}");
    // Everything said is kept in the team's conversation.
    let kept = room.stage.with(|s| s.kept.clone());
    assert_eq!(kept[0], ("user".to_string(), "DBA, ¿cómo ves la base de datos?".to_string()));
    assert_eq!(kept[1].0, "dba");
}

#[tokio::test]
async fn nobody_named_is_the_lead_who_may_hand_the_word_on_a_bounded_number_of_times() {
    let room = Room::open();
    room.stage.answers("lead", &["Eso lo sabe mejor QA.\n[[palabra: qa]]"]);
    room.stage.answers("qa", &["Falta un escenario de expiración.\n[[palabra: Backend]]"]);
    room.stage.answers("dev", &["Lo cubro hoy.\n[[palabra: dba]]"]);
    room.stage.answers("dba", &["Por mi parte nada.\n[[palabra: lead]]"]);
    room.stage.answers("lead", &["Eso lo sabe mejor QA.\n[[palabra: qa]]", "No debería hablar otra vez."]);
    room.say("¿Cómo vamos con la autenticación?");
    room.until("four voices", |r| r.stage.said().len() == 4).await;
    tokio::time::sleep(Duration::from_millis(60)).await;
    let who: Vec<String> = room.stage.said().into_iter().map(|(member, _)| member).collect();
    // The lead, then three hand-overs — by id, by name — and there it stops.
    assert_eq!(who, vec!["lead", "qa", "dev", "dba"]);
    assert!(room.stage.said().iter().all(|(_, sentence)| !sentence.contains("[[")), "an ask is never said");
    let asked = room.stage.with(|s| s.asked.clone());
    assert!(asked[1].1.contains("Arquitecto te da la palabra"), "{asked:?}");
}

#[tokio::test]
async fn a_question_to_everybody_is_a_turn_each_and_the_lead_closes() {
    let room = Room::open();
    for (member, answer) in [("dba", "Eventos, con outbox."), ("qa", "Hay que probar la entrega duplicada."), ("dev", "Me preocupa la idempotencia."), ("lead", "Hay acuerdo en eventos; falta decidir los reintentos.")] {
        room.stage.answers(member, &[answer]);
    }
    room.say("Equipo, ¿eventos de dominio o llamadas síncronas?");
    room.until("the round", |r| r.stage.said().len() == 4).await;
    let who: Vec<String> = room.stage.said().into_iter().map(|(member, _)| member).collect();
    assert_eq!(who, vec!["dba", "qa", "dev", "lead"]);
    let asked = room.stage.with(|s| s.asked.clone());
    assert!(asked[3].1.contains("Cierra la ronda"), "{asked:?}");
}

#[tokio::test]
async fn speaking_over_an_agent_stops_it_and_on_speakers_only_a_name_gets_through() {
    let room = Room::open();
    room.stage.with(|s| s.stuck = Some("dba".into()));
    room.stage.answers("qa", &["Sí, uno de expiración del token."]);
    room.say("DBA, cuéntame todo");
    room.until("the DBA started", |r| r.seat_state("dba") == "speaking").await;

    // Heard over the agent's voice, with no headphones and no name: it may be the agent itself.
    room.events.send(Event::Said { text: "empiezo a explicar algo".into(), typed: false, over_voice: true }).unwrap();
    tokio::time::sleep(Duration::from_millis(40)).await;
    assert_eq!(room.seat_state("dba"), "speaking");
    assert_eq!(room.lines().len(), 2, "nothing was taken as said: {:?}", room.lines());

    // A name is the user: the DBA is cut off and QA answers.
    room.events.send(Event::Said { text: "QA, ¿encontraste algún problema?".into(), typed: false, over_voice: true }).unwrap();
    room.until("QA answered", |r| r.stage.said().iter().any(|(member, _)| member == "qa")).await;
    assert!(room.stage.with(|s| s.hushed) >= 1);
    room.until("the DBA is listening again", |r| r.seat_state("dba") == "listening").await;
    // What the DBA got to say stays, marked as cut.
    assert!(room.lines().iter().any(|(who, text)| who == "dba" && text.ends_with('…')), "{:?}", room.lines());
}

#[tokio::test]
async fn a_look_at_the_code_goes_on_behind_the_call_and_comes_back_asking_for_the_word() {
    let room = Room::open();
    room.stage.answers("dba", &["Lo reviso y te digo.\n[[revisar: los índices de la tabla cita]]"]);
    room.say("DBA, ¿faltan índices?");
    room.until("the DBA came back with what it found", |r| r.stage.said().len() == 2).await;
    assert_eq!(room.stage.with(|s| s.looked.clone()), vec![("dba".to_string(), "los índices de la tabla cita".to_string())]);
    assert_eq!(room.stage.said()[1], ("dba".to_string(), "Revisé los índices de la tabla cita: falta un índice.".to_string()));
    // The whole report is the conversation's; the call heard the gist.
    assert!(room.stage.with(|s| s.kept.iter().any(|(who, text)| who == "dba" && text.starts_with("Informe completo"))));
    room.until("the DBA is listening again", |r| r.seat_state("dba") == "listening").await;
}

#[tokio::test]
async fn whoever_was_still_thinking_when_the_user_moved_on_raises_its_hand_and_speaks_when_given_the_word() {
    let room = Room::open();
    room.stage.hold("lead");
    room.stage.hold("qa");
    room.stage.answers("lead", &["Seguimos el lienzo y lo cerramos con un registro de decisión."]);
    room.stage.answers("qa", &["Faltan dos escenarios."]);
    room.stage.answers("dba", &["Falta particionar la tabla por fecha."]);
    room.say("Arquitecto, ¿qué hacemos con el estado del proceso?");
    room.until("the lead is thinking", |r| r.seat_state("lead") == "thinking").await;
    room.say("QA, ¿qué falta probar?");
    room.until("QA is thinking", |r| r.seat_state("qa") == "thinking").await;

    // The user turns to the DBA: the other two go on thinking, and the DBA — who answers the last
    // thing said — speaks as soon as it has its answer.
    room.say("DBA, ¿qué falta para que la base soporte el histórico?");
    room.until("the DBA answered", |r| r.stage.said().len() == 1).await;
    assert_eq!(room.stage.said()[0].0, "dba");
    assert_eq!(room.seat_state("lead"), "thinking");
    assert_eq!(room.stage.with(|s| s.hushed), 3, "nobody was cut off but by the user speaking");

    // QA finishes first, then the lead: neither speaks — each raises its hand, in that order.
    room.stage.let_go("qa");
    room.until("QA has its hand up", |r| r.seat_state("qa") == "hand").await;
    room.stage.let_go("lead");
    room.until("the lead has its hand up", |r| r.seat_state("lead") == "hand").await;
    tokio::time::sleep(Duration::from_millis(40)).await;
    assert_eq!(room.stage.said().len(), 1, "nobody speaks without the word: {:?}", room.stage.said());
    let order = |r: &Room| lock(&r.call).view().seats.iter().map(|seat| (seat.member_id.clone(), seat.hand)).filter(|(_, hand)| *hand > 0).collect::<Vec<_>>();
    assert_eq!(order(&room), vec![("lead".to_string(), 2), ("qa".to_string(), 1)]);
    assert_eq!(room.lines().len(), 4, "what waits is not in the transcript yet: {:?}", room.lines());

    // The hand is pressed: the lead says it, and QA moves up.
    room.events.send(Event::Grant("lead".into())).unwrap();
    room.until("the lead spoke", |r| r.stage.said().len() == 2).await;
    assert_eq!(room.stage.said()[1], ("lead".to_string(), "Seguimos el lienzo y lo cerramos con un registro de decisión.".to_string()));
    room.until("the lead is listening again", |r| r.seat_state("lead") == "listening").await;
    assert_eq!(order(&room), vec![("qa".to_string(), 1)]);
    assert!(room.stage.with(|s| s.kept.iter().any(|(who, text)| who == "lead" && text.starts_with("Seguimos el lienzo"))), "what it said is kept once it is said");

    // Or it is named: «adelante» gives it the word and asks nothing new.
    room.say("QA, adelante");
    room.until("QA spoke", |r| r.stage.said().len() == 3).await;
    assert_eq!(room.stage.said()[2], ("qa".to_string(), "Faltan dos escenarios.".to_string()));
    tokio::time::sleep(Duration::from_millis(40)).await;
    assert_eq!(room.stage.with(|s| s.asked.len()), 3, "giving the word is not a question: {:?}", room.stage.with(|s| s.asked.clone()));
    assert!(order(&room).is_empty());
}

#[tokio::test]
async fn a_hand_can_be_lowered_and_the_next_in_line_is_whoever_waited_longest() {
    let room = Room::open();
    room.stage.hold("lead");
    room.stage.hold("qa");
    room.stage.answers("lead", &["Lo mío puede esperar."]);
    room.stage.answers("qa", &["Hay un escenario sin cubrir."]);
    room.stage.answers("dba", &["Listo por mi parte."]);
    room.say("Arquitecto, ¿algo más?");
    room.until("the lead is thinking", |r| r.seat_state("lead") == "thinking").await;
    room.say("QA, ¿y tú?");
    room.until("QA is thinking", |r| r.seat_state("qa") == "thinking").await;
    room.say("DBA, ¿cómo vas?");
    room.until("the DBA answered", |r| r.stage.said().len() == 1).await;
    room.stage.let_go("lead");
    room.until("the lead has its hand up", |r| r.seat_state("lead") == "hand").await;
    room.stage.let_go("qa");
    room.until("QA has its hand up", |r| r.seat_state("qa") == "hand").await;

    room.events.send(Event::Lower("lead".into())).unwrap();
    room.until("the lead's hand is down", |r| r.seat_state("lead") == "listening").await;
    // «El siguiente» names nobody: it is whoever is first in line now.
    room.say("El siguiente");
    room.until("QA spoke", |r| r.stage.said().len() == 2).await;
    assert_eq!(room.stage.said()[1].0, "qa");
    tokio::time::sleep(Duration::from_millis(40)).await;
    assert!(room.stage.said().iter().all(|(member, _)| member != "lead"), "a lowered hand says nothing");
}

#[tokio::test]
async fn what_comes_back_from_the_code_after_the_conversation_moved_on_waits_for_the_word_and_hanging_up_drops_it() {
    let room = Room::open();
    room.stage.with(|s| s.minutes = "{\"summary\": \"Se conversó.\"}".into());
    room.stage.hold("qa");
    room.stage.hold("look:dba");
    room.stage.answers("dba", &["Lo reviso y te digo.\n[[revisar: los índices de la tabla cita]]"]);
    room.stage.answers("qa", &["Nada nuevo."]);
    room.say("DBA, ¿faltan índices?");
    room.until("the DBA went to look", |r| r.seat_state("dba") == "looking").await;
    // By the time it is back the user is on something else.
    room.say("QA, ¿y las pruebas?");
    room.until("QA is thinking", |r| r.seat_state("qa") == "thinking").await;
    room.stage.let_go("look:dba");
    room.until("the DBA is back, with its hand up", |r| r.seat_state("dba") == "hand").await;
    tokio::time::sleep(Duration::from_millis(40)).await;
    assert_eq!(room.stage.said().len(), 1, "{:?}", room.stage.said());

    // Hung up: nobody is left thinking or waiting.
    room.events.send(Event::HangUp).unwrap();
    room.until("ended", |r| r.stage.phase() == "ended").await;
    assert!(lock(&room.call).hands.is_empty());
    assert!(lock(&room.call).thoughts.is_empty());
    assert!(lock(&room.call).view().seats.iter().all(|seat| seat.state == "listening" && seat.hand == 0));
}

const MINUTES: &str = "{\"title\": \"Outbox para citas\", \"summary\": \"Se acordó el outbox.\", \"decisions\": [\"Usar outbox\"], \
    \"tasks\": [{\"title\": \"Crear la tabla outbox\", \"detail\": \"Con índice por estado\", \"member\": \"dba\"}], \"open\": [], \"closing\": \"Nos ponemos con el outbox.\"}";

#[tokio::test]
async fn hanging_up_writes_the_minutes_and_after_the_countdown_the_team_starts() {
    let room = Room::open();
    room.stage.with(|s| s.minutes = MINUTES.into());
    room.stage.answers("dba", &["Creo la tabla outbox con un índice por estado."]);
    room.say("DBA, crea la tabla outbox");
    room.until("the DBA answered", |r| r.stage.said().len() == 1).await;
    room.events.send(Event::HangUp).unwrap();
    room.until("the countdown", |r| r.stage.phase() == "countdown").await;
    // The lead said what the team does now, and the minutes are in the conversation.
    assert_eq!(room.stage.said().last().unwrap(), &("lead".to_string(), "Nos ponemos con el outbox.".to_string()));
    assert!(room.stage.with(|s| s.kept.iter().any(|(who, text)| who == "lead" && text.contains("## Acta de la llamada"))));
    assert!(room.stage.with(|s| s.started.is_empty()), "nothing starts before the countdown ends");

    room.until("the run", |r| r.stage.phase() == "started").await;
    let (title, goal) = room.stage.with(|s| s.started[0].clone());
    assert_eq!(title, "Outbox para citas");
    assert!(goal.contains("- DBA — Crear la tabla outbox: Con índice por estado"), "{goal}");
    assert_eq!(lock(&room.call).run_id.as_deref(), Some("run-1"));
}

#[tokio::test]
async fn the_countdown_can_be_called_off_and_haganlo_does_not_wait_for_it() {
    let room = Room::open();
    room.stage.with(|s| s.minutes = MINUTES.into());
    room.say("Arquitecto, anota que usamos outbox");
    room.stage.answers("lead", &["Anotado."]);
    room.events.send(Event::HangUp).unwrap();
    room.until("the countdown", |r| r.stage.phase() == "countdown").await;
    room.events.send(Event::CancelStart).unwrap();
    room.until("called off", |r| r.stage.phase() == "ended").await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(room.stage.with(|s| s.started.is_empty()), "a countdown called off starts nothing");
    assert!(lock(&room.call).wrap.is_some(), "the minutes stay");

    // Told to, the team starts at once.
    let room = Room::open();
    room.stage.with(|s| s.minutes = MINUTES.into());
    room.say("DBA, crea la tabla outbox");
    room.stage.answers("dba", &["Hecho el plan."]);
    room.say("Perfecto, háganlo");
    room.until("started at once", |r| r.stage.phase() == "started").await;
    assert_eq!(room.stage.with(|s| s.started.len()), 1);
}

#[tokio::test]
async fn a_call_with_nothing_said_or_nothing_agreed_ends_without_work() {
    // Hung up before saying anything: no minutes are asked for at all.
    let room = Room::open();
    room.events.send(Event::HangUp).unwrap();
    room.until("ended", |r| r.stage.phase() == "ended").await;
    assert!(lock(&room.call).wrap.is_none());

    // Talked, agreed nothing: minutes, no countdown, no run.
    let room = Room::open();
    room.stage.with(|s| s.minutes = "{\"summary\": \"Se conversó sobre los eventos.\", \"open\": [\"Los reintentos\"]}".into());
    room.stage.answers("lead", &["Depende de los reintentos."]);
    room.say("¿Eventos o llamadas síncronas?");
    room.until("the lead answered", |r| r.stage.said().len() == 1).await;
    room.events.send(Event::HangUp).unwrap();
    room.until("ended", |r| r.stage.phase() == "ended").await;
    assert_eq!(lock(&room.call).wrap.as_ref().unwrap().open, vec!["Los reintentos"]);
    assert!(room.stage.with(|s| s.started.is_empty()));
}

#[test]
fn an_agent_talks_with_the_model_chosen_for_it_else_as_the_call_says() {
    use super::stage::talk_model;
    // Chosen for the agent: that one, whatever the call says.
    assert_eq!(talk_model("claude-sonnet-5-5", "fast", "claude-haiku-5-5", "claude-opus-5-5"), "claude-sonnet-5-5");
    assert_eq!(talk_model("claude-sonnet-5-5", "own", "claude-haiku-5-5", "claude-opus-5-5"), "claude-sonnet-5-5");
    // Nothing chosen: the provider's fast model, or its own when the call says so.
    assert_eq!(talk_model("", "fast", "claude-haiku-5-5", "claude-opus-5-5"), "claude-haiku-5-5");
    assert_eq!(talk_model("", "own", "claude-haiku-5-5", "claude-opus-5-5"), "claude-opus-5-5");
    // A provider with no fast model talks with the agent's own either way.
    assert_eq!(talk_model("", "fast", "", "gpt-6-luna"), "gpt-6-luna");
}

#[test]
fn the_lead_opens_the_call_naming_who_is_in_it() {
    let names = |n: usize| ["DBA", "QA", "Backend", "Frontend", "DevOps", "Seguridad"][..n].iter().map(|name| name.to_string()).collect::<Vec<_>>();
    assert_eq!(opening("Arquitecto", &names(0), "es"), "Hola, aquí Arquitecto. Te escucho: ¿de qué hablamos?");
    assert_eq!(opening("Arquitecto", &names(3), "es"), "Hola, aquí Arquitecto. Estamos DBA, QA y Backend. ¿De qué hablamos?");
    assert_eq!(opening("Arquitecto", &names(6), "es"), "Hola, aquí Arquitecto. Estamos DBA, QA, Backend y 3 más. ¿De qué hablamos?");
    assert_eq!(opening("Architect", &names(1), "en"), "Hi, Architect here. With me: DBA. What are we talking about?");
}

/// How long a spoken line really takes, on the engines installed here: the whole answer, which is
/// the latest a voice could start (an engine that writes piece by piece starts sooner).
///
/// `CODEFLOW_CALL_EVAL=claude,codex cargo test --lib team::call::tests::eval -- --ignored --nocapture`
/// — a model per engine with `provider:model`.
#[tokio::test]
#[ignore = "calls real engines; set CODEFLOW_CALL_EVAL"]
async fn eval_how_long_a_spoken_line_takes() {
    let Ok(wanted) = std::env::var("CODEFLOW_CALL_EVAL") else { return };
    let member = member("dba", "DBA", "Base de datos");
    let system = line::system(&member, "Equipo Agenda", false, "- lead | Arquitecto | Arquitectura | core\n- dba | DBA | Base de datos | agenda", "- El equipo no tiene ninguna corrida en marcha ahora.", "es");
    let ask = line::ask(&line::Ask::Direct("DBA, ¿qué es lo primero que revisarías en una tabla de citas que se volvió lenta?"), "es");
    for entry in wanted.split(',').map(str::trim).filter(|entry| !entry.is_empty()) {
        let (provider, model) = entry.split_once(':').unwrap_or((entry, ""));
        let engine = crate::ai::engine_for(provider);
        let fast = engine.commit_message_model();
        let model = if !model.is_empty() { model } else { fast };
        for round in 1..=2 {
            let started = Instant::now();
            let answer = crate::ai::call_line(&*engine, engine.default_binary(), model, &system, &ask, "(La llamada acaba de empezar.)", Some(crate::ai::effort::LOW), None).await;
            let took = started.elapsed();
            match answer {
                Ok(text) => {
                    let (said, asks) = line::read(&text);
                    println!("EVAL {provider} model={model:?} round={round} {:.1}s chars={} asks={asks:?}\n  {said}", took.as_secs_f32(), said.chars().count());
                }
                Err(error) => println!("EVAL {provider} model={model:?} round={round} {:.1}s FAILED {error}", took.as_secs_f32()),
            }
        }
    }
}

#[test]
fn a_call_speaks_at_its_own_speed_and_within_what_a_voice_can_do() {
    use super::commands::pace_of;
    // Unset, empty or unreadable: each voice as it was recorded.
    assert_eq!(pace_of(None), 1.0);
    assert_eq!(pace_of(Some("")), 1.0);
    assert_eq!(pace_of(Some("rápido")), 1.0);
    assert_eq!(pace_of(Some("NaN")), 1.0);
    assert_eq!(pace_of(Some(" 1.1 ")), 1.1);
    // Never so slow that it drags nor so fast it is not followed.
    assert_eq!(pace_of(Some("0.5")), 0.85);
    assert_eq!(pace_of(Some("3")), 1.25);
}
