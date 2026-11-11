use std::str::FromStr;

use chrono::{DateTime, Datelike, Duration, NaiveTime, TimeZone, Utc};
use chrono_tz::Tz;
use croner::Cron;
use serde_json::Value;

use super::{fields, local_midnight, text, Schedule};

const ZERO: i64 = 0;
const NO_FRACTION: f64 = 0.0;
const ONE: i64 = 1;
const WEEK_LENGTH: i64 = fields::WEEKDAYS.len() as i64;
const DAY: Duration = Duration::days(ONE);
const MINUTE: Duration = Duration::minutes(ONE);
const HOUR: Duration = Duration::hours(ONE);
const MILLISECOND: Duration = Duration::milliseconds(ONE);
const MINUTES_PER_DAY: i64 = 1440;
const DAY_MS: i64 = 86_400_000;
const WEEK_MINUTES: i64 = WEEK_LENGTH * MINUTES_PER_DAY;
const TIME_FORMAT: &str = "%H:%M";
const SECOND_TIME_FORMAT: &str = "%H:%M:%S";
const SECOND_FIELD: &str = "%-S";
const MINUTE_FIELD: &str = "%-M";
const HOUR_FIELD: &str = "%-H";
const ALL_DAYS: &str = "*";
const LIST_SEPARATOR: &str = ",";
const DESCRIPTION_SEPARATOR: &str = ", ";
const EMPTY: &str = "";
const DASH: &str = "–";
const CLOCK_ERROR: &str = "Write a time of day (HH:MM): ";
const DAYS_ERROR: &str = "Choose at least one valid day";
const TIMES_ERROR: &str = "Add at least one time of day";
const INTERVAL_ERROR: &str = "The interval has to be a finite number of at least 1";
const WINDOW_ERROR: &str = "The end of the time window must be later than its start";
const RESTRICTED_INTERVAL_ERROR: &str = "Time windows require an interval shorter than one day";
const MONTH_DAY_ERROR: &str = "Choose a whole day of the month between 1 and 31";
const DAY_NAMES_ES: &[&str] = &["lun", "mar", "mié", "jue", "vie", "sáb", "dom"];
const DAY_NAMES_EN: &[&str] = &["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const FROM_ES: &str = ", de ";
const FROM_EN: &str = ", from ";
const MONTH_ES: &str = "cada mes, día ";
const MONTH_EN: &str = "every month, day ";
const AT_ES: &str = " a las ";
const AT_EN: &str = " at ";

#[derive(Debug, Clone)]
pub struct RestrictedInterval {
    pub zone: Tz,
    schedule: Box<Schedule>,
    days: Vec<u32>,
    window: Option<(NaiveTime, NaiveTime)>,
    step: Duration,
}

fn clock(raw: &str) -> Result<NaiveTime, String> {
    let raw = raw.trim();
    let minutes = NaiveTime::parse_from_str(raw, TIME_FORMAT);
    let parsed = minutes.or_else(|_| NaiveTime::parse_from_str(raw, SECOND_TIME_FORMAT));
    parsed.map_err(|_| format!("{CLOCK_ERROR}{raw}"))
}

fn days(params: &Value, key: &str) -> Result<Vec<u32>, String> {
    let mut selected = Vec::new();
    let raw_days = params.get(key).and_then(Value::as_array);
    let Some(raw_days) = raw_days else {
        return Err(DAYS_ERROR.into());
    };
    for raw in raw_days {
        let day = raw.as_str().unwrap_or_default();
        let position = fields::WEEKDAYS.iter().position(|candidate| *candidate == day);
        let Some(position) = position else {
            return Err(DAYS_ERROR.into());
        };
        selected.push(position as u32);
    }
    selected.sort_unstable();
    selected.dedup();
    let empty = selected.is_empty();
    if empty {
        return Err(DAYS_ERROR.into());
    }
    Ok(selected)
}

pub fn parse_calendar(params: &Value, zone: Tz) -> Result<Vec<Schedule>, String> {
    let mode = text(params, fields::MODE);
    let monthly = mode == fields::MONTHLY;
    let (month_days, weekdays) = if monthly {
        let raw_day = params.get(fields::MONTH_DAY).and_then(Value::as_f64);
        let month_day = raw_day.unwrap_or(fields::MINIMUM_MONTH_DAY);
        let whole_day = month_day.fract() == NO_FRACTION;
        let valid = whole_day && month_day >= fields::MINIMUM_MONTH_DAY && month_day <= fields::MAXIMUM_MONTH_DAY;
        if !valid {
            return Err(MONTH_DAY_ERROR.into());
        }
        let day = month_day as u32;
        (day.to_string(), ALL_DAYS.to_string())
    } else {
        let days_key = if mode == fields::WEEKLY { fields::WEEK_DAYS } else { fields::DAYS };
        let selected = days(params, days_key)?;
        let cron_days: Vec<String> = selected.iter().map(|day| ((i64::from(*day) + ONE) % WEEK_LENGTH).to_string()).collect();
        let weekdays = cron_days.join(LIST_SEPARATOR);
        (ALL_DAYS.to_string(), weekdays)
    };
    let mut schedules = Vec::new();
    let raw_times = params.get(fields::AT).and_then(Value::as_array);
    let Some(raw_times) = raw_times else {
        return Err(TIMES_ERROR.into());
    };
    for raw in raw_times {
        let raw = raw.as_str().unwrap_or_default().trim();
        let empty = raw.is_empty();
        if empty {
            continue;
        }
        let time = clock(raw)?;
        let seconds = time.format(SECOND_FIELD);
        let minutes = time.format(MINUTE_FIELD);
        let hours = time.format(HOUR_FIELD);
        let line = format!("{seconds} {minutes} {hours} {month_days} {ALL_DAYS} {weekdays}");
        let cron = Cron::from_str(&line).map_err(|error| error.to_string())?;
        let schedule = Schedule::Cron { cron: Box::new(cron), zone };
        schedules.push(schedule);
    }
    let empty = schedules.is_empty();
    if empty {
        return Err(TIMES_ERROR.into());
    }
    Ok(schedules)
}

pub fn parse_interval(params: &Value, zone: Tz) -> Result<Vec<Schedule>, String> {
    let every = params.get(fields::EVERY).and_then(Value::as_f64).unwrap_or(fields::DEFAULT_INTERVAL);
    let finite = every.is_finite();
    if !finite || every < fields::MINIMUM_INTERVAL {
        return Err(INTERVAL_ERROR.into());
    }
    let unit_name = text(params, fields::UNIT);
    let unit_value = unit_name.as_str();
    let unit = match unit_value {
        fields::HOURS => HOUR,
        fields::DAYS => DAY,
        _ => MINUTE,
    };
    let count = every.floor().min(fields::MAXIMUM_INTERVAL) as i32;
    let step = unit * count;
    let schedule = Schedule::Every { step, zone };
    let restricted_days = params.get(fields::INTERVAL_DAYS);
    let has_day_selection = restricted_days.is_some();
    let selected = if has_day_selection {
        days(params, fields::INTERVAL_DAYS)?
    } else {
        let weekday_indices = ZERO..WEEK_LENGTH;
        weekday_indices.map(|index| index as u32).collect()
    };
    let window_requested = params.get(fields::TIME_WINDOW).and_then(Value::as_bool).unwrap_or_default();
    let window_enabled = window_requested && unit_name != fields::DAYS;
    let all_days = selected.len() == fields::WEEKDAYS.len();
    if all_days && !window_enabled {
        return Ok(vec![schedule]);
    }
    if window_enabled && step >= DAY {
        return Err(RESTRICTED_INTERVAL_ERROR.into());
    }
    let window = if window_enabled {
        let start_text = text(params, fields::WINDOW_START);
        let end_text = text(params, fields::WINDOW_END);
        let start = clock(&start_text)?;
        let end = clock(&end_text)?;
        if start >= end {
            return Err(WINDOW_ERROR.into());
        }
        Some((start, end))
    } else {
        None
    };
    let schedule = Box::new(schedule);
    let interval = RestrictedInterval { zone, schedule, days: selected, window, step };
    Ok(vec![Schedule::Restricted { interval }])
}

impl RestrictedInterval {
    pub fn allows(&self, at: DateTime<Utc>) -> bool {
        let local = at.with_timezone(&self.zone);
        let weekday = local.weekday().num_days_from_monday();
        let allowed_day = self.days.contains(&weekday);
        if !allowed_day {
            return false;
        }
        let Some((start, end)) = self.window else {
            return true;
        };
        let time = local.time();
        time >= start && time <= end
    }

    pub fn next_after(&self, after: DateTime<Utc>) -> Option<DateTime<Utc>> {
        let unrestricted_time = self.window.is_none();
        if unrestricted_time {
            return self.next_allowed_day(after);
        }
        let today = after.with_timezone(&self.zone).date_naive();
        let offsets = ZERO..=WEEK_LENGTH;
        for offset in offsets {
            let day_offset = Duration::days(offset);
            let date = today.checked_add_signed(day_offset)?;
            let weekday = date.weekday().num_days_from_monday();
            let allowed_day = self.days.contains(&weekday);
            if !allowed_day {
                continue;
            }
            if let Some((start, end)) = self.window {
                let local_start = date.and_time(start);
                let start_resolution = self.zone.from_local_datetime(&local_start);
                let Some(origin) = start_resolution.earliest() else {
                    continue;
                };
                let origin = origin.with_timezone(&Utc);
                let step_ms = self.step.num_milliseconds();
                let elapsed = (after - origin).num_milliseconds();
                let slot = if after < origin { ZERO } else { elapsed.div_euclid(step_ms) + ONE };
                let elapsed_offset = Duration::milliseconds(slot * step_ms);
                let candidate = origin + elapsed_offset;
                let candidate_local = candidate.with_timezone(&self.zone);
                let candidate_date = candidate_local.date_naive();
                let candidate_time = candidate_local.time();
                if candidate_date == date && candidate_time <= end {
                    return Some(candidate);
                }
            }
        }
        None
    }

    fn next_allowed_day(&self, after: DateTime<Utc>) -> Option<DateTime<Utc>> {
        let mut cursor = after;
        let step_ms = self.step.num_milliseconds();
        let whole_days = step_ms % DAY_MS == ZERO;
        let maximum_attempts = if whole_days || self.step < DAY { WEEK_LENGTH } else { WEEK_MINUTES };
        let attempts = ZERO..=maximum_attempts;
        for _ in attempts {
            let candidate = self.schedule.next_after(cursor)?;
            let allowed = self.allows(candidate);
            if allowed {
                return Some(candidate);
            }
            if self.step >= DAY {
                cursor = candidate;
                continue;
            }
            let date = candidate.with_timezone(&self.zone).date_naive();
            let tomorrow = date.succ_opt()?;
            let midnight = local_midnight(self.zone, tomorrow)?;
            cursor = midnight - MILLISECOND;
        }
        None
    }
}

pub fn describe_monthly(params: &Value, spanish: bool) -> String {
    let month = if spanish { MONTH_ES } else { MONTH_EN };
    let at = if spanish { AT_ES } else { AT_EN };
    let default_day = u64::from(fields::FIRST_MONTH_DAY);
    let day = params.get(fields::MONTH_DAY).and_then(Value::as_u64).unwrap_or(default_day);
    let times = params.get(fields::AT).and_then(Value::as_array);
    let times: Vec<&str> = times.into_iter().flatten().filter_map(Value::as_str).collect();
    let times = times.join(DESCRIPTION_SEPARATOR);
    format!("{month}{day}{at}{times}")
}

pub fn describe_restrictions(params: &Value, said: String, spanish: bool) -> String {
    let mode = text(params, fields::MODE);
    if mode != fields::INTERVAL {
        return said;
    }
    let selected = days(params, fields::INTERVAL_DAYS).unwrap_or_default();
    let all_days = selected.len() == fields::WEEKDAYS.len();
    let empty_days = selected.is_empty();
    let day_names = if spanish { DAY_NAMES_ES } else { DAY_NAMES_EN };
    let selected_names: Vec<&str> = selected.iter().map(|day| day_names[*day as usize]).collect();
    let day_text = selected_names.join(DESCRIPTION_SEPARATOR);
    let day_separator = if all_days || empty_days { EMPTY } else { DESCRIPTION_SEPARATOR };
    let day_text = if all_days || empty_days { EMPTY } else { day_text.as_str() };
    let window_requested = params.get(fields::TIME_WINDOW).and_then(Value::as_bool).unwrap_or_default();
    let unit = text(params, fields::UNIT);
    let window_enabled = window_requested && unit != fields::DAYS;
    if !window_enabled {
        return format!("{said}{day_separator}{day_text}");
    }
    let from = if spanish { FROM_ES } else { FROM_EN };
    let start = text(params, fields::WINDOW_START);
    let end = text(params, fields::WINDOW_END);
    format!("{said}{day_separator}{day_text}{from}{start}{DASH}{end}")
}
