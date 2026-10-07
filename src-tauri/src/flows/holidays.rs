//! Public holidays, by country and year — for "business days" in the Date node, «¿Horario hábil?» and
//! a schedule that skips holidays.
//!
//! **Where they come from.** Nager.Date's public API (`date.nager.at`, no key), national holidays
//! only (a holiday with `counties` is regional). Each country-year is cached on disk for a month and
//! in memory for the process, so a schedule deciding every fifteen seconds never waits on the
//! network. **Offline**, Chile — the default — is computed here (fixed dates, Easter, and the rules
//! that move San Pedro y San Pablo, the Encuentro de Dos Mundos and the Iglesias Evangélicas);
//! another country offline has none, and says so in the log of the node that asked.

use std::collections::{HashMap, HashSet};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use chrono::{Datelike, NaiveDate, Weekday};

static MEMORY: LazyLock<Mutex<HashMap<(String, i32), HashSet<NaiveDate>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

const CACHE_DAYS: u64 = 30;

fn cache_file(country: &str, year: i32) -> std::path::PathBuf {
    crate::paths::cache_dir().join("holidays").join(format!("{country}-{year}.json"))
}

fn normalise(country: &str) -> String {
    let c = country.trim().to_uppercase();
    if c.len() == 2 && c.chars().all(|ch| ch.is_ascii_alphabetic()) { c } else { "CL".into() }
}

/// The country a field names, as the two-letter code the calendar is kept under — empty is Chile.
/// Anything else is refused rather than read as Chile: "USA" or "Chile" used to skip Chile's
/// holidays without a word.
pub fn country_code(given: &str) -> Result<String, String> {
    let code = given.trim().to_uppercase();
    if code.is_empty() {
        return Ok("CL".into());
    }
    if code.len() == 2 && code.chars().all(|c| c.is_ascii_alphabetic()) {
        Ok(code)
    } else {
        Err(format!("“{}” is not a two-letter country code (CL, AR, US, ES…)", given.trim()))
    }
}

/// When each country-year was last asked for in the background (`known_now`).
static ASKED: LazyLock<Mutex<HashMap<(String, i32), std::time::Instant>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// How long a background ask waits before it is tried again.
const ASK_AGAIN: Duration = Duration::from_secs(15 * 60);

fn parse_dates(text: &str) -> Option<HashSet<NaiveDate>> {
    let list: Vec<String> = serde_json::from_str(text).ok()?;
    Some(list.iter().filter_map(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok()).collect())
}

/// What is known without asking anyone: memory, then a disk copy younger than a month.
pub fn cached(country: &str, year: i32) -> Option<HashSet<NaiveDate>> {
    let country = normalise(country);
    if let Some(found) = MEMORY.lock().ok().and_then(|m| m.get(&(country.clone(), year)).cloned()) {
        return Some(found);
    }
    let path = cache_file(&country, year);
    let fresh = std::fs::metadata(&path).ok()?.modified().ok()?.elapsed().ok()? < Duration::from_secs(CACHE_DAYS * 86_400);
    if !fresh {
        return None;
    }
    let dates = parse_dates(&std::fs::read_to_string(&path).ok()?)?;
    if let Ok(mut memory) = MEMORY.lock() {
        memory.insert((country, year), dates.clone());
    }
    Some(dates)
}

/// A country's holidays for a year: cached, fetched, or (Chile) computed. Never fails.
pub async fn for_year(country: &str, year: i32) -> HashSet<NaiveDate> {
    let country = normalise(country);
    if let Some(found) = cached(&country, year) {
        return found;
    }
    match fetch(&country, year).await {
        Ok(dates) => {
            let path = cache_file(&country, year);
            if let Some(dir) = path.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let mut list: Vec<String> = dates.iter().map(|d| d.format("%Y-%m-%d").to_string()).collect();
            list.sort();
            let _ = std::fs::write(&path, serde_json::to_string(&list).unwrap_or_default());
            if let Ok(mut memory) = MEMORY.lock() {
                memory.insert((country, year), dates.clone());
            }
            dates
        }
        Err(_) if country == "CL" => chile(year),
        Err(_) => HashSet::new(),
    }
}

/// Several years at once — the span a business-day calculation may walk.
pub async fn for_years(country: &str, years: std::ops::RangeInclusive<i32>) -> HashSet<NaiveDate> {
    let mut all = HashSet::new();
    for year in years {
        all.extend(for_year(country, year).await);
    }
    all
}

/// Starts fetching a country's next two years in the background, for the callers that cannot wait
/// (a schedule's `decide`), which read [`cached`] meanwhile.
pub fn warm(country: &str) {
    let country = normalise(country);
    let year = chrono::Local::now().year();
    if cached(&country, year).is_some() && cached(&country, year + 1).is_some() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let _ = for_year(&country, year).await;
        let _ = for_year(&country, year + 1).await;
    });
}

/// Holidays known now for `date`'s year, without waiting: the cache, else Chile's own computation.
///
/// What is not known yet is asked for in the background, at most every 15 minutes: a schedule
/// armed while offline, or one still running when a new year starts, learnt nothing until it was
/// armed again — and ran on every holiday meanwhile.
pub fn known_now(country: &str, year: i32) -> HashSet<NaiveDate> {
    let country = normalise(country);
    if let Some(found) = cached(&country, year) {
        return found;
    }
    let due = ASKED
        .lock()
        .map(|mut asked| {
            let key = (country.clone(), year);
            if asked.get(&key).is_some_and(|at| at.elapsed() < ASK_AGAIN) {
                return false;
            }
            asked.insert(key, std::time::Instant::now());
            true
        })
        .unwrap_or(false);
    if due {
        let asked = country.clone();
        tauri::async_runtime::spawn(async move {
            let _ = for_year(&asked, year).await;
        });
    }
    if country == "CL" { chile(year) } else { HashSet::new() }
}

async fn fetch(country: &str, year: i32) -> Result<HashSet<NaiveDate>, String> {
    let http = reqwest::Client::builder().timeout(Duration::from_secs(10)).build().map_err(|e| e.to_string())?;
    let response = http
        .get(format!("https://date.nager.at/api/v3/PublicHolidays/{year}/{country}"))
        .header("User-Agent", "CodeFlow")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("date.nager.at answered {}", response.status()));
    }
    let list: Vec<serde_json::Value> = response.json().await.map_err(|e| e.to_string())?;
    Ok(list
        .iter()
        // National ones: a holiday kept by some regions only lists them in `counties`.
        .filter(|h| h.get("global").and_then(serde_json::Value::as_bool).unwrap_or(true))
        .filter_map(|h| h.get("date").and_then(serde_json::Value::as_str))
        .filter_map(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok())
        .collect())
}

/// Easter Sunday (the anonymous Gregorian algorithm).
pub fn easter(year: i32) -> NaiveDate {
    let a = year % 19;
    let b = year / 100;
    let c = year % 100;
    let d = b / 4;
    let e = b % 4;
    let f = (b + 8) / 25;
    let g = (b - f + 1) / 3;
    let h = (19 * a + b - d - g + 15) % 30;
    let i = c / 4;
    let k = c % 4;
    let l = (32 + 2 * e + 2 * i - h - k) % 7;
    let m = (a + 11 * h + 22 * l) / 451;
    let month = (h + l - 7 * m + 114) / 31;
    let day = (h + l - 7 * m + 114) % 31 + 1;
    NaiveDate::from_ymd_opt(year, month as u32, day as u32).expect("a valid Easter date")
}

/// Ley 19.668: on a Tuesday, Wednesday or Thursday the holiday moves to the Monday before; on a
/// Friday, to the Monday after.
fn moved_to_monday(date: NaiveDate) -> NaiveDate {
    match date.weekday() {
        Weekday::Tue => date - chrono::Duration::days(1),
        Weekday::Wed => date - chrono::Duration::days(2),
        Weekday::Thu => date - chrono::Duration::days(3),
        Weekday::Fri => date + chrono::Duration::days(3),
        _ => date,
    }
}

/// Chile's national holidays, computed — the offline answer. The Pueblos Indígenas day follows the
/// June solstice, approximated as the 20th in a leap year and the 21st otherwise.
pub fn chile(year: i32) -> HashSet<NaiveDate> {
    let d = |m: u32, day: u32| NaiveDate::from_ymd_opt(year, m, day).expect("a valid date");
    let mut out: HashSet<NaiveDate> = [d(1, 1), d(5, 1), d(5, 21), d(7, 16), d(8, 15), d(9, 18), d(9, 19), d(11, 1), d(12, 8), d(12, 25)].into_iter().collect();
    let easter = easter(year);
    out.insert(easter - chrono::Duration::days(2));
    out.insert(easter - chrono::Duration::days(1));
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    out.insert(d(6, if leap { 20 } else { 21 }));
    out.insert(moved_to_monday(d(6, 29)));
    out.insert(moved_to_monday(d(10, 12)));
    // The Iglesias Evangélicas (Oct 31): a Tuesday moves to the Friday before, a Wednesday to the Friday after.
    let reformation = d(10, 31);
    out.insert(match reformation.weekday() {
        Weekday::Tue => reformation - chrono::Duration::days(4),
        Weekday::Wed => reformation + chrono::Duration::days(2),
        _ => reformation,
    });
    out
}

pub const MON_FRI: [Weekday; 5] = [Weekday::Mon, Weekday::Tue, Weekday::Wed, Weekday::Thu, Weekday::Fri];

/// `mon`…`sun` as weekdays; nothing recognisable is Monday to Friday.
pub fn workdays_from(names: &[String]) -> Vec<Weekday> {
    let days: Vec<Weekday> = names
        .iter()
        .filter_map(|n| match n.trim().to_lowercase().as_str() {
            "mon" => Some(Weekday::Mon),
            "tue" => Some(Weekday::Tue),
            "wed" => Some(Weekday::Wed),
            "thu" => Some(Weekday::Thu),
            "fri" => Some(Weekday::Fri),
            "sat" => Some(Weekday::Sat),
            "sun" => Some(Weekday::Sun),
            _ => None,
        })
        .collect();
    if days.is_empty() { MON_FRI.to_vec() } else { days }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_country_is_a_two_letter_code_or_refused() {
        assert_eq!(country_code("").unwrap(), "CL");
        assert_eq!(country_code(" us ").unwrap(), "US");
        assert!(country_code("USA").is_err());
        assert!(country_code("Chile").is_err());
    }

    fn date(text: &str) -> NaiveDate {
        NaiveDate::parse_from_str(text, "%Y-%m-%d").unwrap()
    }

    #[test]
    fn easter_dates() {
        assert_eq!(easter(2024), date("2024-03-31"));
        assert_eq!(easter(2025), date("2025-04-20"));
        assert_eq!(easter(2026), date("2026-04-05"));
    }

    #[test]
    fn chile_2026() {
        let holidays = chile(2026);
        for day in ["2026-01-01", "2026-04-03", "2026-04-04", "2026-05-01", "2026-05-21", "2026-06-21", "2026-07-16", "2026-08-15", "2026-09-18", "2026-09-19", "2026-11-01", "2026-12-08", "2026-12-25"] {
            assert!(holidays.contains(&date(day)), "{day}");
        }
        // San Pedro y San Pablo, Monday 29 June 2026 — already a Monday.
        assert!(holidays.contains(&date("2026-06-29")));
        // Encuentro de Dos Mundos: Monday 12 October 2026.
        assert!(holidays.contains(&date("2026-10-12")));
        // Iglesias Evangélicas: Saturday 31 October 2026 stays.
        assert!(holidays.contains(&date("2026-10-31")));
    }

    #[test]
    fn moving_rules() {
        // 2025-06-29 is a Sunday: it stays. 2023-06-29 was a Thursday: Monday 26.
        assert_eq!(moved_to_monday(date("2023-06-29")), date("2023-06-26"));
        // 2024-10-12 a Saturday: stays; 2023-10-12 a Thursday: Monday 9.
        assert_eq!(moved_to_monday(date("2023-10-12")), date("2023-10-09"));
        // 2023-10-31 a Tuesday: Friday 27.
        assert!(chile(2023).contains(&date("2023-10-27")));
    }

    #[test]
    fn business_days() {
        let holidays = chile(2026);
        let business = |day: &str| MON_FRI.contains(&date(day).weekday()) && !holidays.contains(&date(day));
        assert!(!business("2026-09-18"), "Fiestas Patrias");
        assert!(!business("2026-09-20"), "a Sunday");
        assert!(business("2026-09-21"));
        assert_eq!(workdays_from(&["sat".into(), "sun".into()]), vec![Weekday::Sat, Weekday::Sun]);
        assert_eq!(workdays_from(&[]).len(), 5);
    }
}
