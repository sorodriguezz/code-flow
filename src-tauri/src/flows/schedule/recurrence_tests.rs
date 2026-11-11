use chrono::{DateTime, Utc};
use serde_json::Value;

use super::{decide, describe, next_of, outlook, parse_all, zone_of_schedule, Decision, Schedule};

const TRIGGER: &str = "trigger.schedule";
const UTC: &str = "UTC";
const HOURLY_WINDOW: &str = r#"{"mode":"interval","every":1,"unit":"hours","timeWindow":true,"windowStart":"09:00","windowEnd":"17:00","timezone":"UTC"}"#;
const OFFSET_WINDOW: &str = r#"{"mode":"interval","every":45,"unit":"minutes","timeWindow":true,"windowStart":"09:10","windowEnd":"17:00","timezone":"UTC"}"#;
const SELECTED_DAYS_WINDOW: &str = r#"{"mode":"interval","every":1,"unit":"hours","intervalDays":["mon","wed","fri"],"timeWindow":true,"windowStart":"09:00","windowEnd":"17:00","timezone":"America/Santiago"}"#;
const SELECTED_DAYS: &str = r#"{"mode":"interval","every":15,"unit":"minutes","intervalDays":["mon","wed","fri"],"timezone":"UTC"}"#;
const WEEKLY_DEFAULTS: &str = r#"{"mode":"weekly","timezone":"UTC"}"#;
const WEEKLY_SELECTED: &str = r#"{"mode":"weekly","weekDays":["mon","wed","fri"],"at":["09:00","17:30"],"timezone":"UTC"}"#;
const MONTHLY_DEFAULTS: &str = r#"{"mode":"monthly","timezone":"UTC"}"#;
const MONTHLY_LAST_DAY: &str = r#"{"mode":"monthly","monthDay":31,"timezone":"UTC"}"#;
const MONTHLY_LEAP_DAY: &str = r#"{"mode":"monthly","monthDay":29,"timezone":"UTC"}"#;
const MONTHLY_TIMES: &str = r#"{"mode":"monthly","monthDay":15,"at":["09:00","17:30"],"timezone":"UTC","skipHolidays":true}"#;
const WINDOW_DST: &str = r#"{"mode":"interval","every":1,"unit":"hours","timeWindow":true,"windowStart":"09:00","windowEnd":"17:00","timezone":"Europe/Madrid"}"#;
const MIDNIGHT_DST: &str = r#"{"mode":"interval","every":1,"unit":"hours","intervalDays":["sun"],"timezone":"America/Santiago"}"#;
const INVALID_CASES: &[&str] = &[
    r#"{"mode":"interval","intervalDays":[]}"#,
    r#"{"mode":"interval","intervalDays":["unknown"]}"#,
    r#"{"mode":"interval","timeWindow":true,"windowStart":"18:00","windowEnd":"09:00"}"#,
    r#"{"mode":"interval","timeWindow":true,"windowStart":"09:00","windowEnd":"09:00"}"#,
    r#"{"mode":"interval","timeWindow":true,"windowStart":"25:00"}"#,
    r#"{"mode":"interval","timeWindow":true,"every":24,"unit":"hours"}"#,
    r#"{"mode":"weekly","weekDays":[]}"#,
    r#"{"mode":"monthly","monthDay":0}"#,
    r#"{"mode":"monthly","monthDay":32}"#,
    r#"{"mode":"monthly","monthDay":1.5}"#,
];
const MONDAY_EARLY: &str = "2026-10-05T08:59:00Z";
const MONDAY_NINE: &str = "2026-10-05T09:00:00Z";
const MONDAY_TEN: &str = "2026-10-05T10:00:00Z";
const MONDAY_NOON: &str = "2026-10-05T12:00:00Z";
const MONDAY_ONE: &str = "2026-10-05T13:00:00Z";
const MONDAY_BEFORE_END: &str = "2026-10-05T16:59:59Z";
const MONDAY_END: &str = "2026-10-05T17:00:00Z";
const MONDAY_NIGHT: &str = "2026-10-05T19:00:00Z";
const TUESDAY_NINE: &str = "2026-10-06T09:00:00Z";
const TUESDAY_NINE_TEN: &str = "2026-10-06T09:10:00Z";
const TUESDAY_NINE_FIFTY_FIVE: &str = "2026-10-06T09:55:00Z";
const TUESDAY_FOUR_FORTY: &str = "2026-10-06T16:40:00Z";
const TUESDAY_MIDNIGHT_BEFORE: &str = "2026-10-06T23:59:59Z";
const WEDNESDAY_MIDNIGHT: &str = "2026-10-07T00:00:00Z";
const WEDNESDAY_NINE: &str = "2026-10-07T09:00:00Z";
const WEDNESDAY_NINE_TEN: &str = "2026-10-07T09:10:00Z";
const WEDNESDAY_NINE_THIRTY: &str = "2026-10-07T09:30:00Z";
const WEDNESDAY_FIVE_THIRTY: &str = "2026-10-07T17:30:00Z";
const FRIDAY_EVENING: &str = "2026-10-09T20:00:00Z";
const NEXT_MONDAY_NINE: &str = "2026-10-12T09:00:00Z";
const MONDAY_FIVE_THIRTY: &str = "2026-10-05T17:30:00Z";
const MONDAY_SANTIAGO_MORNING: &str = "2026-10-12T12:00:00Z";
const JANUARY_END: &str = "2026-01-31T09:00:00Z";
const FEBRUARY_FIRST: &str = "2026-02-01T09:00:00Z";
const MARCH_END: &str = "2026-03-31T09:00:00Z";
const LEAP_JANUARY: &str = "2028-01-29T09:00:00Z";
const LEAP_FEBRUARY: &str = "2028-02-29T09:00:00Z";
const REGULAR_JANUARY: &str = "2027-01-29T09:00:00Z";
const REGULAR_MARCH: &str = "2027-03-29T09:00:00Z";
const MONTH_MORNING: &str = "2026-10-15T09:00:00Z";
const MONTH_EVENING: &str = "2026-10-15T17:30:00Z";
const NEXT_MONTH_MORNING: &str = "2026-11-15T09:00:00Z";
const BEFORE_DST: &str = "2026-03-28T16:00:00Z";
const AFTER_DST: &str = "2026-03-29T07:00:00Z";
const CHILE_BEFORE_DST: &str = "2026-09-05T12:00:00Z";
const CHILE_AFTER_DST: &str = "2026-09-06T04:00:00Z";
const WINDOW_DESCRIPTION: &str = "cada hora, de 09:00–17:00";
const MONTH_DESCRIPTION: &str = "cada mes, día 15 a las 09:00, 17:30, sin feriados (CL)";
const ENGLISH_MONTH_DESCRIPTION: &str = "every month, day 15 at 09:00, 17:30, not on holidays (CL)";
const ONE_POINT: usize = 1;

fn instant(raw: &str) -> DateTime<Utc> {
    let parsed = DateTime::parse_from_rfc3339(raw).unwrap();
    parsed.with_timezone(&Utc)
}

fn parameters(raw: &str) -> Value {
    let value = serde_json::from_str(raw).unwrap();
    crate::flows::params::with_defaults(TRIGGER, &value)
}

fn schedules(raw: &str) -> Vec<Schedule> {
    let params = parameters(raw);
    let parsed = parse_all(&params, None);
    parsed.unwrap()
}

fn assert_next(schedules: &[Schedule], after: &str, expected: &str) {
    let after = instant(after);
    let expected = instant(expected);
    let actual = next_of(schedules, after);
    assert_eq!(actual, Some(expected));
}

#[test]
fn hourly_window_includes_both_ends_and_restarts_the_next_day() {
    let schedules = schedules(HOURLY_WINDOW);
    assert_next(&schedules, MONDAY_EARLY, MONDAY_NINE);
    assert_next(&schedules, MONDAY_NINE, MONDAY_TEN);
    assert_next(&schedules, MONDAY_BEFORE_END, MONDAY_END);
    assert_next(&schedules, MONDAY_END, TUESDAY_NINE);
}

#[test]
fn an_arbitrary_interval_counts_from_the_start_of_the_window() {
    let schedules = schedules(OFFSET_WINDOW);
    assert_next(&schedules, TUESDAY_NINE_TEN, TUESDAY_NINE_FIFTY_FIVE);
    assert_next(&schedules, TUESDAY_FOUR_FORTY, WEDNESDAY_NINE_TEN);
}

#[test]
fn interval_days_and_holiday_zone_use_the_selected_timezone() {
    let schedules = schedules(SELECTED_DAYS_WINDOW);
    assert_next(&schedules, FRIDAY_EVENING, MONDAY_SANTIAGO_MORNING);
    let zone = zone_of_schedule(&schedules).unwrap();
    let zone_name = zone.name();
    let expected_zone = chrono_tz::America::Santiago.name();
    assert_eq!(zone_name, expected_zone);
    let first = instant(FRIDAY_EVENING);
    let outlook = outlook(&schedules, first);
    let point_count = outlook.points.len();
    assert_eq!(point_count, ONE_POINT);
}

#[test]
fn interval_day_selection_does_not_require_a_window() {
    let schedules = schedules(SELECTED_DAYS);
    assert_next(&schedules, TUESDAY_MIDNIGHT_BEFORE, WEDNESDAY_MIDNIGHT);
}

#[test]
fn weekly_starts_with_one_monday_and_accepts_multiple_days_and_times() {
    let weekly = schedules(WEEKLY_DEFAULTS);
    assert_next(&weekly, MONDAY_NINE, NEXT_MONDAY_NINE);
    let selected = schedules(WEEKLY_SELECTED);
    assert_next(&selected, MONDAY_END, MONDAY_FIVE_THIRTY);
    assert_next(&selected, TUESDAY_NINE, WEDNESDAY_NINE);
    assert_next(&selected, WEDNESDAY_NINE_THIRTY, WEDNESDAY_FIVE_THIRTY);
}

#[test]
fn monthly_follows_calendar_months_and_skips_missing_dates() {
    let monthly = schedules(MONTHLY_DEFAULTS);
    assert_next(&monthly, JANUARY_END, FEBRUARY_FIRST);
    let last_day = schedules(MONTHLY_LAST_DAY);
    assert_next(&last_day, JANUARY_END, MARCH_END);
    let leap_day = schedules(MONTHLY_LEAP_DAY);
    assert_next(&leap_day, LEAP_JANUARY, LEAP_FEBRUARY);
    assert_next(&leap_day, REGULAR_JANUARY, REGULAR_MARCH);
}

#[test]
fn monthly_times_remain_independent() {
    let monthly = schedules(MONTHLY_TIMES);
    assert_next(&monthly, MONTH_MORNING, MONTH_EVENING);
    assert_next(&monthly, MONTH_EVENING, NEXT_MONTH_MORNING);
}

#[test]
fn windows_and_midnight_intervals_survive_daylight_saving() {
    let window = schedules(WINDOW_DST);
    assert_next(&window, BEFORE_DST, AFTER_DST);
    let midnight = schedules(MIDNIGHT_DST);
    assert_next(&midnight, CHILE_BEFORE_DST, CHILE_AFTER_DST);
}

#[test]
fn waking_up_outside_the_window_skips_the_pending_run() {
    let schedules = schedules(HOURLY_WINDOW);
    let pending = instant(MONDAY_END);
    let now = instant(MONDAY_NIGHT);
    let next = instant(TUESDAY_NINE);
    let expected = Decision::Skip { scheduled: pending, next: Some(next) };
    let actual = decide(&schedules, pending, now, true);
    assert_eq!(actual, expected);
    let pending = instant(MONDAY_NINE);
    let now = instant(MONDAY_NOON);
    let next = instant(MONDAY_ONE);
    let expected = Decision::Fire { scheduled: pending, late: true, next: Some(next) };
    let actual = decide(&schedules, pending, now, true);
    assert_eq!(actual, expected);
}

#[test]
fn descriptions_include_the_window_monthly_date_and_holidays() {
    let window = parameters(HOURLY_WINDOW);
    let description = describe(&window, true);
    assert_eq!(description, WINDOW_DESCRIPTION);
    let monthly = parameters(MONTHLY_TIMES);
    let description = describe(&monthly, true);
    assert_eq!(description, MONTH_DESCRIPTION);
    let description = describe(&monthly, false);
    assert_eq!(description, ENGLISH_MONTH_DESCRIPTION);
}

#[test]
fn invalid_day_and_time_selections_are_rejected() {
    for raw in INVALID_CASES {
        let params = parameters(raw);
        let result = parse_all(&params, Some(UTC));
        let invalid = result.is_err();
        assert!(invalid, "{raw}");
    }
}
