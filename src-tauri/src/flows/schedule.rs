//! When a Schedule trigger fires: the arithmetic, with no clock of its own.
//!
//! Three ways to say "when", each one a parameter set the node's form writes:
//! - **every N minutes / hours / days**, counted from midnight in the trigger's zone, so "every 15
//!   minutes" means :00, :15, :30, :45 rather than "15 minutes after whenever the app happened to
//!   start" — the schedule a person reads off the form is the one that runs;
//! - **at these times on these days** (`at` + `days`), which is a cron expression the person never
//!   had to write;
//! - **a cron expression**, five fields or six with seconds, read by croner.
//!
//! Everything is computed in the trigger's IANA zone and returned as UTC instants, so a daily 02:30
//! survives the night the clocks change: croner settles the hour that does not exist (spring) and
//! the one that happens twice (autumn), and the tests below pin both.
//!
//! **Waking up.** A laptop asleep at 03:00 cannot run the 03:00 backup. [`decide`] is what the loop
//! asks each time it looks at the clock: nothing yet, fire now, or — when the moment passed long
//! enough ago that the computer must have been asleep — fire once to catch up (or skip it, when the
//! trigger says so). Never once per missed occurrence: a week of a 15-minute schedule is not 672
//! runs on Monday morning.

use std::str::FromStr;

use chrono::{DateTime, Duration, NaiveTime, TimeZone, Utc};
use chrono_tz::Tz;
use croner::Cron;
use serde_json::Value;

/// How late a fire may be and still count as on time — the loop's own tick plus room for a busy
/// machine. Later than this, the occurrence was missed (the computer was asleep).
pub const ON_TIME: Duration = Duration::seconds(90);

/// A schedule, read from a trigger's parameters.
#[derive(Debug, Clone)]
pub enum Schedule {
    /// Every `step` from midnight in `zone`.
    Every { step: Duration, zone: Tz },
    Cron { cron: Box<Cron>, zone: Tz },
    /// One moment, once («Una sola vez»).
    Once { at: DateTime<Utc> },
}

const WEEKDAYS: [&str; 7] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

fn text(params: &Value, key: &str) -> String {
    params.get(key).and_then(Value::as_str).unwrap_or_default().trim().to_string()
}

/// The zone a schedule runs in: its own parameter, else the flow's, else the machine's.
pub fn zone_of(params: &Value, flow_zone: Option<&str>) -> Result<Tz, String> {
    let own = text(params, "timezone");
    let name = if !own.is_empty() {
        own
    } else if let Some(zone) = flow_zone.filter(|z| !z.trim().is_empty()) {
        zone.to_string()
    } else {
        super::expr::system_zone()
    };
    Tz::from_str(&name).map_err(|_| format!("\"{name}\" is not a time zone"))
}

/// Reads a Schedule trigger's parameters (defaults already filled in) into the schedules it stands
/// for: one, or one per time of day for "at these times" — a single cron line listing 09:00 and 17:30
/// would also match 09:30 and 17:00.
pub fn parse_all(params: &Value, flow_zone: Option<&str>) -> Result<Vec<Schedule>, String> {
    let zone = zone_of(params, flow_zone)?;
    match text(params, "mode").as_str() {
        "once" => {
            let raw = text(params, "onceAt");
            if raw.is_empty() {
                return Err("Write the date and time to run at".into());
            }
            let at = once_instant(&raw, zone).ok_or_else(|| format!("\"{raw}\" is not a date and time (YYYY-MM-DD HH:MM)"))?;
            Ok(vec![Schedule::Once { at }])
        }
        "cron" => {
            let expression = text(params, "cron");
            if expression.is_empty() {
                return Err("Write a cron expression".into());
            }
            let cron = Cron::from_str(&expression).map_err(|e| format!("\"{expression}\" is not a cron expression: {e}"))?;
            Ok(vec![Schedule::Cron { cron: Box::new(cron), zone }])
        }
        "times" => {
            let mut times: Vec<NaiveTime> = Vec::new();
            for raw in params.get("at").and_then(Value::as_array).into_iter().flatten() {
                let raw = raw.as_str().unwrap_or_default().trim();
                if raw.is_empty() {
                    continue;
                }
                let time = NaiveTime::parse_from_str(raw, "%H:%M")
                    .or_else(|_| NaiveTime::parse_from_str(raw, "%H:%M:%S"))
                    .map_err(|_| format!("\"{raw}\" is not a time of day (HH:MM)"))?;
                times.push(time);
            }
            if times.is_empty() {
                return Err("Add at least one time of day".into());
            }
            let days: Vec<usize> = params
                .get("days")
                .and_then(Value::as_array)
                .map(|list| {
                    list.iter()
                        .filter_map(Value::as_str)
                        .filter_map(|day| WEEKDAYS.iter().position(|w| *w == day))
                        .collect()
                })
                .unwrap_or_default();
            if days.is_empty() {
                return Err("Choose at least one day".into());
            }
            // cron counts Sunday as 0; the form counts from Monday.
            let dow: Vec<String> = days.iter().map(|d| ((d + 1) % 7).to_string()).collect();
            times
                .iter()
                .map(|t| {
                    let line = format!("{} {} {} * * {}", t.format("%-S"), t.format("%-M"), t.format("%-H"), dow.join(","));
                    Cron::from_str(&line).map(|cron| Schedule::Cron { cron: Box::new(cron), zone }).map_err(|e| e.to_string())
                })
                .collect()
        }
        _ => {
            let every = params.get("every").and_then(Value::as_f64).unwrap_or(15.0);
            if !(every >= 1.0) {
                return Err("The interval has to be at least 1".into());
            }
            let unit = match text(params, "unit").as_str() {
                "hours" => Duration::hours(1),
                "days" => Duration::days(1),
                _ => Duration::minutes(1),
            };
            Ok(vec![Schedule::Every { step: unit * (every.floor().min(100_000.0) as i32), zone }])
        }
    }
}

/// `2026-12-24 09:00` (or with seconds, a `T`, or an offset of its own) as an instant, read in `zone`.
pub fn once_instant(raw: &str, zone: Tz) -> Option<DateTime<Utc>> {
    let raw = raw.trim();
    if let Ok(at) = DateTime::parse_from_rfc3339(raw) {
        return Some(at.with_timezone(&Utc));
    }
    ["%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%d-%m-%Y %H:%M", "%d/%m/%Y %H:%M"]
        .iter()
        .find_map(|format| chrono::NaiveDateTime::parse_from_str(raw, format).ok())
        .and_then(|local| zone.from_local_datetime(&local).earliest())
        .map(|at| at.with_timezone(&Utc))
}

/// The zone a schedule reads its days in — the holidays' calendar.
pub fn zone_of_schedule(schedules: &[Schedule]) -> Option<Tz> {
    schedules.iter().find_map(|s| match s {
        Schedule::Every { zone, .. } | Schedule::Cron { zone, .. } => Some(*zone),
        Schedule::Once { .. } => None,
    })
}

impl Schedule {
    /// The first occurrence strictly after `after`.
    pub fn next_after(&self, after: DateTime<Utc>) -> Option<DateTime<Utc>> {
        match self {
            Schedule::Once { at } => (*at > after).then_some(*at),
            Schedule::Every { step, zone } => {
                let local = after.with_timezone(zone);
                let midnight = zone
                    .from_local_datetime(&local.date_naive().and_hms_opt(0, 0, 0)?)
                    .earliest()?
                    .with_timezone(&Utc);
                let step_ms = step.num_milliseconds().max(1000);
                let since = (after - midnight).num_milliseconds();
                let n = since.div_euclid(step_ms) + 1;
                let candidate = midnight + Duration::milliseconds(n * step_ms);
                // A step that does not divide the day evenly restarts at the next midnight, so the
                // schedule is the same every day rather than drifting.
                let next_midnight = zone
                    .from_local_datetime(&(local.date_naive() + Duration::days(1)).and_hms_opt(0, 0, 0)?)
                    .earliest()?
                    .with_timezone(&Utc);
                Some(if candidate > next_midnight && step_ms < 86_400_000 { next_midnight } else { candidate })
            }
            Schedule::Cron { cron, zone } => {
                let local = after.with_timezone(zone);
                cron.find_next_occurrence(&local, false).ok().map(|next| next.with_timezone(&Utc))
            }
        }
    }
}

/// The next occurrence of any of `schedules` after `after`.
pub fn next_of(schedules: &[Schedule], after: DateTime<Utc>) -> Option<DateTime<Utc>> {
    schedules.iter().filter_map(|s| s.next_after(after)).min()
}

/// How far ahead the Programación view's ruler looks.
pub const OUTLOOK: Duration = Duration::hours(24);

/// Occurrences the ruler gets one by one. A schedule busier than this in a day (every minute is
/// 1440, a cron with seconds up to 86 400) gets [`Outlook::busy`] stretches instead.
const OUTLOOK_POINTS: usize = 300;

/// The ruler's grain for a busy schedule: five minutes, 288 slices a day, on the clock's own marks
/// (every zone's offset is a multiple of fifteen minutes, so they are local marks too).
const SLICE_MS: i64 = 5 * 60 * 1000;

/// A schedule's next day, the way the ruler draws it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Outlook {
    /// Every occurrence, when there are few enough to draw one by one.
    pub points: Vec<DateTime<Utc>>,
    /// Otherwise the stretches holding at least one occurrence: five-minute slices, neighbours merged.
    pub busy: Vec<(DateTime<Utc>, DateTime<Utc>)>,
}

/// The [`OUTLOOK`] after `first`, the schedule's next occurrence: every occurrence in it or, past
/// [`OUTLOOK_POINTS`], the stretches that have any.
///
/// **From `first`, not from now.** The loop recomputes this only when the schedule fires, while the
/// ruler keeps sliding with the clock: a weekday 09:00 computed on Friday must already hold Monday's
/// run when the ruler is looked at on Sunday. Nothing fires between now and `first`, so a day from
/// `first` covers every "next 24 hours" the ruler can show until the list is computed again.
///
/// **Stretches cost slices, not occurrences.** Each step asks for the first occurrence after the
/// slice it just marked, so a day is at most ~290 lookups however often the schedule fires — and
/// "every minute from 9 to 18" shows 9 to 18 rather than a bar across the day.
pub fn outlook(schedules: &[Schedule], first: DateTime<Utc>) -> Outlook {
    let horizon = first + OUTLOOK;
    let mut points = Vec::new();
    let mut at = Some(first);
    while let Some(t) = at.filter(|t| *t <= horizon) {
        if points.len() == OUTLOOK_POINTS {
            return Outlook { points: Vec::new(), busy: busy_stretches(schedules, first, horizon) };
        }
        points.push(t);
        at = next_of(schedules, t);
    }
    Outlook { points, busy: Vec::new() }
}

fn busy_stretches(schedules: &[Schedule], first: DateTime<Utc>, horizon: DateTime<Utc>) -> Vec<(DateTime<Utc>, DateTime<Utc>)> {
    let mut busy: Vec<(DateTime<Utc>, DateTime<Utc>)> = Vec::new();
    let mut at = Some(first);
    while let Some(t) = at.filter(|t| *t <= horizon) {
        let start = t - Duration::milliseconds(t.timestamp_millis().rem_euclid(SLICE_MS));
        let end = start + Duration::milliseconds(SLICE_MS);
        match busy.last_mut() {
            Some(last) if last.1 >= start => last.1 = last.1.max(end),
            _ => busy.push((start, end)),
        }
        // Occurrences fall on whole seconds, so the first one after `end - 1 s` is the first from
        // `end` on — and never one before `t`, so the walk always moves forward.
        at = next_of(schedules, (end - Duration::seconds(1)).max(t));
    }
    busy
}

/// What the loop does when it looks at the clock.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    /// Not yet; look again at or before this instant.
    Wait(DateTime<Utc>),
    /// The occurrence is due: fire for `scheduled`, then wait for `next`.
    Fire { scheduled: DateTime<Utc>, late: bool, next: Option<DateTime<Utc>> },
    /// An occurrence was missed while the computer slept and the trigger does not catch up.
    Skip { scheduled: DateTime<Utc>, next: Option<DateTime<Utc>> },
}

/// Given the occurrence the loop was waiting for and the time now, what to do. Later than
/// [`ON_TIME`] means it was missed; then the trigger fires once if it catches up, and either way
/// the next occurrence is the first one after *now*, so a long sleep yields one run, not many.
pub fn decide(schedules: &[Schedule], pending: DateTime<Utc>, now: DateTime<Utc>, catch_up: bool) -> Decision {
    if now < pending {
        return Decision::Wait(pending);
    }
    let next = next_of(schedules, now);
    let late = now - pending > ON_TIME;
    if late && !catch_up {
        Decision::Skip { scheduled: pending, next }
    } else {
        Decision::Fire { scheduled: pending, late, next }
    }
}

/// A short human sentence for a schedule, for the Programación view and the node's subtitle.
pub fn describe(params: &Value, spanish: bool) -> String {
    let mode = text(params, "mode");
    let holidays = params.get("skipHolidays").and_then(Value::as_bool) == Some(true) && mode != "once";
    let said = describe_when(params, &mode, spanish);
    if holidays {
        let country = text(params, "holidayCountry");
        let country = if country.is_empty() { "CL".to_string() } else { country.to_uppercase() };
        return if spanish { format!("{said}, sin feriados ({country})") } else { format!("{said}, not on holidays ({country})") };
    }
    said
}

fn describe_when(params: &Value, mode: &str, spanish: bool) -> String {
    match mode {
        "once" => {
            let at = text(params, "onceAt");
            if spanish { format!("una vez, {at}") } else { format!("once, {at}") }
        }
        "cron" => text(params, "cron"),
        "times" => {
            let times: Vec<String> = params
                .get("at")
                .and_then(Value::as_array)
                .map(|list| list.iter().filter_map(Value::as_str).map(str::to_string).collect())
                .unwrap_or_default();
            let days: Vec<&str> = params
                .get("days")
                .and_then(Value::as_array)
                .map(|list| list.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default();
            let names_es = ["lun", "mar", "mié", "jue", "vie", "sáb", "dom"];
            let names_en = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
            let names = if spanish { names_es } else { names_en };
            let day_text = if days.len() == 7 {
                if spanish { "todos los días".to_string() } else { "every day".to_string() }
            } else if days == ["mon", "tue", "wed", "thu", "fri"] {
                if spanish { "lun–vie".to_string() } else { "Mon–Fri".to_string() }
            } else {
                days.iter()
                    .filter_map(|d| WEEKDAYS.iter().position(|w| w == d).map(|i| names[i]))
                    .collect::<Vec<_>>()
                    .join(", ")
            };
            if spanish {
                format!("{day_text} a las {}", times.join(", "))
            } else {
                format!("{day_text} at {}", times.join(", "))
            }
        }
        _ => {
            let every = params.get("every").and_then(Value::as_f64).unwrap_or(15.0) as i64;
            let unit = text(params, "unit");
            let (one, many) = match (unit.as_str(), spanish) {
                ("hours", true) => ("hora", "horas"),
                ("days", true) => ("día", "días"),
                (_, true) => ("minuto", "minutos"),
                ("hours", false) => ("hour", "hours"),
                ("days", false) => ("day", "days"),
                (_, false) => ("minute", "minutes"),
            };
            match (every == 1, spanish) {
                (true, true) => format!("cada {one}"),
                (false, true) => format!("cada {every} {many}"),
                (true, false) => format!("every {one}"),
                (false, false) => format!("every {every} {many}"),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn utc(text: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(text).unwrap().with_timezone(&Utc)
    }

    fn params(value: Value) -> Value {
        crate::flows::params::with_defaults("trigger.schedule", &value)
    }

    #[test]
    fn every_fifteen_minutes_lands_on_the_quarter_hours() {
        let s = parse_all(&params(json!({"mode": "interval", "every": 15, "unit": "minutes", "timezone": "UTC"})), None).unwrap();
        assert_eq!(next_of(&s, utc("2026-10-05T10:22:10Z")), Some(utc("2026-10-05T10:30:00Z")));
        assert_eq!(next_of(&s, utc("2026-10-05T10:30:00Z")), Some(utc("2026-10-05T10:45:00Z")));
    }

    #[test]
    fn a_step_that_does_not_divide_the_day_restarts_at_midnight() {
        let s = parse_all(&params(json!({"mode": "interval", "every": 7, "unit": "hours", "timezone": "UTC"})), None).unwrap();
        // 00, 07, 14, 21 — and then midnight, not 04:00 tomorrow.
        assert_eq!(next_of(&s, utc("2026-10-05T21:30:00Z")), Some(utc("2026-10-06T00:00:00Z")));
    }

    #[test]
    fn times_on_weekdays_in_a_zone() {
        // 09:00 and 17:30, Monday to Friday, in Santiago (UTC-3 in October).
        let s = parse_all(
            &params(json!({"mode": "times", "at": ["09:00", "17:30"], "days": ["mon", "tue", "wed", "thu", "fri"], "timezone": "America/Santiago"})),
            None,
        )
        .unwrap();
        assert_eq!(s.len(), 2);
        // Friday 2026-10-09 18:00 local = 21:00Z → next is Monday 09:00 local = 12:00Z.
        assert_eq!(next_of(&s, utc("2026-10-09T21:00:00Z")), Some(utc("2026-10-12T12:00:00Z")));
        // Monday 10:00 local → 17:30 local the same day.
        assert_eq!(next_of(&s, utc("2026-10-12T13:00:00Z")), Some(utc("2026-10-12T20:30:00Z")));
    }

    /// Madrid moves from 02:00 to 03:00 on 2026-03-29: a daily 02:30 has no 02:30 that night, and
    /// on 2026-10-25 the hour 02:00–03:00 happens twice. Either way the job runs once per day.
    #[test]
    fn daylight_saving_runs_once_per_day() {
        let s = parse_all(&params(json!({"mode": "cron", "cron": "30 2 * * *", "timezone": "Europe/Madrid"})), None).unwrap();
        let spring = next_of(&s, utc("2026-03-28T02:00:00Z")).unwrap();
        let after_spring = next_of(&s, spring).unwrap();
        assert!(after_spring - spring >= Duration::hours(23), "{spring} then {after_spring}");
        let autumn = next_of(&s, utc("2026-10-24T02:00:00Z")).unwrap();
        let after_autumn = next_of(&s, autumn).unwrap();
        assert!(after_autumn - autumn >= Duration::hours(23), "{autumn} then {after_autumn}");
        assert!(after_autumn - autumn <= Duration::hours(25), "{autumn} then {after_autumn}");
    }

    #[test]
    fn waking_up_fires_once_or_skips() {
        let s = parse_all(&params(json!({"mode": "interval", "every": 15, "unit": "minutes", "timezone": "UTC"})), None).unwrap();
        let pending = utc("2026-10-05T03:00:00Z");
        // On time.
        assert_eq!(
            decide(&s, pending, utc("2026-10-05T03:00:01Z"), true),
            Decision::Fire { scheduled: pending, late: false, next: Some(utc("2026-10-05T03:15:00Z")) }
        );
        // Asleep until 08:05: one catch-up run, then 08:15 — not twenty runs.
        assert_eq!(
            decide(&s, pending, utc("2026-10-05T08:05:00Z"), true),
            Decision::Fire { scheduled: pending, late: true, next: Some(utc("2026-10-05T08:15:00Z")) }
        );
        assert_eq!(
            decide(&s, pending, utc("2026-10-05T08:05:00Z"), false),
            Decision::Skip { scheduled: pending, next: Some(utc("2026-10-05T08:15:00Z")) }
        );
        assert_eq!(decide(&s, pending, utc("2026-10-05T02:59:00Z"), true), Decision::Wait(pending));
    }

    #[test]
    fn a_sparse_schedule_is_listed_one_by_one() {
        let s = parse_all(&params(json!({"mode": "interval", "every": 15, "unit": "minutes", "timezone": "UTC"})), None).unwrap();
        let first = utc("2026-10-06T22:15:00Z");
        let outlook = outlook(&s, first);
        assert!(outlook.busy.is_empty());
        // Both ends included: 22:15 today to 22:15 tomorrow is 96 steps, 97 runs.
        assert_eq!(outlook.points.len(), 97);
        assert_eq!(outlook.points.first(), Some(&first));
        assert_eq!(outlook.points.last(), Some(&utc("2026-10-07T22:15:00Z")));
    }

    /// The ruler's old bug: every minute is 1440 runs a day, the list stopped at 300 — five hours of
    /// bar, then a day that looked empty and was not.
    #[test]
    fn every_minute_is_busy_the_whole_day() {
        let s = parse_all(&params(json!({"mode": "interval", "every": 1, "unit": "minutes", "timezone": "UTC"})), None).unwrap();
        let outlook = outlook(&s, utc("2026-10-06T22:12:00Z"));
        assert!(outlook.points.is_empty());
        assert_eq!(outlook.busy, vec![(utc("2026-10-06T22:10:00Z"), utc("2026-10-07T22:15:00Z"))]);
    }

    #[test]
    fn a_busy_schedule_keeps_its_gaps() {
        // Every minute from 09:00 to 17:59: 540 a day, busy only during those hours.
        let s = parse_all(&params(json!({"mode": "cron", "cron": "* 9-17 * * *", "timezone": "UTC"})), None).unwrap();
        let first = next_of(&s, utc("2026-10-06T08:00:00Z")).unwrap();
        assert_eq!(
            outlook(&s, first).busy,
            vec![
                (utc("2026-10-06T09:00:00Z"), utc("2026-10-06T18:00:00Z")),
                // A day after the first run, both ends included.
                (utc("2026-10-07T09:00:00Z"), utc("2026-10-07T09:05:00Z")),
            ]
        );
    }

    #[test]
    fn a_cron_every_second_walks_slices_not_seconds() {
        let s = parse_all(&params(json!({"mode": "cron", "cron": "* * * * * *", "timezone": "UTC"})), None).unwrap();
        let outlook = outlook(&s, utc("2026-10-06T22:12:07Z"));
        assert_eq!(outlook.busy, vec![(utc("2026-10-06T22:10:00Z"), utc("2026-10-07T22:15:00Z"))]);
    }

    #[test]
    fn the_outlook_runs_a_day_past_the_next_occurrence() {
        // Weekdays at 09:00 in Santiago, computed on Friday evening: the list starts at Monday's
        // run, so the ruler already has it on Sunday afternoon.
        let s = parse_all(
            &params(json!({"mode": "times", "at": ["09:00"], "days": ["mon", "tue", "wed", "thu", "fri"], "timezone": "America/Santiago"})),
            None,
        )
        .unwrap();
        let first = next_of(&s, utc("2026-10-09T21:00:00Z")).unwrap();
        assert_eq!(outlook(&s, first).points, vec![utc("2026-10-12T12:00:00Z"), utc("2026-10-13T12:00:00Z")]);
    }

    #[test]
    fn bad_input_says_what_is_wrong() {
        assert!(parse_all(&params(json!({"mode": "cron", "cron": "not cron"})), None).unwrap_err().contains("cron"));
        assert!(parse_all(&params(json!({"mode": "times", "at": ["25:00"], "days": ["mon"]})), None).unwrap_err().contains("25:00"));
        assert!(parse_all(&params(json!({"mode": "times", "at": ["09:00"], "days": []})), None).is_err());
        assert!(parse_all(&params(json!({"mode": "interval", "timezone": "Mars/Base"})), None).unwrap_err().contains("Mars/Base"));
    }

    #[test]
    fn descriptions_read_like_the_form() {
        assert_eq!(describe(&params(json!({"mode": "interval", "every": 15, "unit": "minutes"})), true), "cada 15 minutos");
        assert_eq!(describe(&params(json!({"mode": "interval", "every": 1, "unit": "hours"})), false), "every hour");
        assert_eq!(
            describe(&params(json!({"mode": "times", "at": ["09:00"], "days": ["mon", "tue", "wed", "thu", "fri"]})), true),
            "lun–vie a las 09:00"
        );
    }

    #[test]
    fn once_fires_once_in_its_zone() {
        let s = parse_all(&params(json!({"mode": "once", "onceAt": "2026-12-24 09:00", "timezone": "America/Santiago"})), None).unwrap();
        // Santiago is UTC−3 in December (summer time).
        assert_eq!(next_of(&s, utc("2026-12-01T00:00:00Z")), Some(utc("2026-12-24T12:00:00Z")));
        assert_eq!(next_of(&s, utc("2026-12-24T12:00:00Z")), None, "and never again");
        assert!(parse_all(&params(json!({"mode": "once", "onceAt": "mañana"})), None).is_err());
        assert!(describe(&params(json!({"mode": "once", "onceAt": "2026-12-24 09:00"})), true).starts_with("una vez"));
        assert!(describe(&params(json!({"mode": "times", "at": ["09:00"], "skipHolidays": true, "holidayCountry": "cl"})), true).ends_with("sin feriados (CL)"));
    }

}
