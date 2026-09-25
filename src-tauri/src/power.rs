//! Whether this machine is running on battery, and how much of it is left.
//!
//! **A desktop reports nothing at all.** No battery is not "a battery at 100%" — it is a machine
//! the question does not apply to, and the status bar draws nothing rather than a permanently full
//! icon nobody would ever look at twice. That is why [`status`] returns an `Option` and not a
//! struct with a `has_battery` flag: the caller cannot forget to check one that isn't there.
//!
//! Read natively, never by shelling out. `pmset`, `WMIC` and `upower` would all answer this, and
//! all three cost a subprocess — which on Windows means a console window flashing on screen every
//! time the reading refreshes (see [`crate::proc`]). A poll that visibly interrupts the user is
//! worse than no poll.

use serde::Serialize;
use starship_battery::{Battery, Manager, State};

/// What the machine's power situation is, when it has one.
#[derive(Debug, Clone, Serialize)]
pub struct PowerStatus {
    /// 0–100, across every battery the machine has.
    pub percent: f64,
    /// Whether mains power is connected.
    pub plugged_in: bool,
    /// Whether it is actively taking charge — a distinct thing from [`Self::plugged_in`], since a
    /// laptop sitting at 100% on the mains is plugged in and charging nothing.
    pub charging: bool,
    /// Runway at the current rate: to empty while discharging, to full while charging. `None` when
    /// the OS will not estimate it, which it routinely refuses to do for the first minutes after a
    /// cable is moved.
    pub minutes_left: Option<i64>,
}

/// What a battery gauge reports, in minutes, when it has no estimate yet.
///
/// The Smart Battery "unknown" value, 0xFFFF. On macOS starship-battery hands the gauge's own
/// `TimeRemaining` through untouched and filters only `i32::MAX`, so for the first minutes after the
/// cable comes out — while the gauge is still measuring — 65535 minutes arrived here as a real runway:
/// "quedan 1092 h 15 min" at 8% (user report, 2026-09-25). `pmset -g batt` says "(no estimate)" at
/// the same moment, and so should we.
const GAUGE_UNKNOWN_MINUTES: i64 = 0xFFFF;

/// The longest runway believed, per direction: the bounds starship-battery itself applies on the
/// platforms where it computes the estimate from energy and draw (Windows, Linux). macOS reads the
/// gauge's figure instead and gets no bound at all, so it is applied here, once, for every platform.
const MAX_MINUTES_TO_FULL: i64 = 10 * 60;
const MAX_MINUTES_TO_EMPTY: i64 = 10 * 24 * 60;

/// A runway in whole minutes, or `None` for anything that is not one: nothing left, the gauge's
/// "unknown", or a figure no battery could honour.
fn runway_minutes(seconds: f64, charging: bool) -> Option<i64> {
    let minutes = (seconds / 60.0).round() as i64;
    let max = if charging { MAX_MINUTES_TO_FULL } else { MAX_MINUTES_TO_EMPTY };
    (minutes > 0 && minutes != GAUGE_UNKNOWN_MINUTES && minutes <= max).then_some(minutes)
}

/// macOS's own time to empty: the smoothed estimate its battery menu and `pmset -g batt` show.
///
/// Not the gauge's `TimeRemaining`, which is what starship-battery reads and which follows the draw
/// of the moment — on one machine a few minutes apart it said 49 and then 14 (a build was running)
/// while macOS said "(no estimate)" and then "0:58". A runway that disagrees with the one the OS
/// shows beside it reads as wrong whichever of the two is nearer the truth. `None` while macOS is
/// still estimating (it answers -1, `kIOPSTimeRemainingUnknown`) and on the mains (-2,
/// `kIOPSTimeRemainingUnlimited`). There is no such call for time to full, so charging keeps the
/// gauge's figure — which is steadier while charging, the current being set by the charger.
#[cfg(target_os = "macos")]
fn os_minutes_to_empty() -> Option<i64> {
    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn IOPSGetTimeRemainingEstimate() -> f64;
    }
    // SAFETY: takes nothing and returns a plain `CFTimeInterval`; a read of powerd's estimate.
    let seconds = unsafe { IOPSGetTimeRemainingEstimate() };
    if seconds > 0.0 { runway_minutes(seconds, false) } else { None }
}

/// The runway worth showing: to full while charging, to empty while discharging.
fn runway(batteries: &[Battery], charging: bool) -> Option<i64> {
    #[cfg(target_os = "macos")]
    {
        if !charging {
            return os_minutes_to_empty();
        }
    }
    batteries
        .iter()
        .filter_map(|battery| {
            let remaining = if charging { battery.time_to_full() } else { battery.time_to_empty() };
            // `Time` is in seconds whatever unit the platform read it in.
            remaining.and_then(|time| runway_minutes(f64::from(time.value), charging))
        })
        // The one that runs out first is the one that matters; a sum would promise a runway the
        // machine does not have.
        .min()
}

/// Reads the batteries, or `None` for a machine that has none.
///
/// `None` also covers the read failing outright. That is deliberate: the honest fallback for "we
/// could not tell" is the same as for a desktop — say nothing — because the alternative is an error
/// state in a status bar about a detail nobody asked to be told about.
pub fn status() -> Option<PowerStatus> {
    let manager = Manager::new().ok()?;
    let batteries: Vec<_> = manager.batteries().ok()?.flatten().collect();
    if batteries.is_empty() {
        return None;
    }

    // Summed as energy, not averaged as percentages: a machine with two cells of different sizes
    // (which is most of the ones that have two) would otherwise report a figure that is neither
    // battery's and matches nothing the OS shows.
    let mut energy = 0.0_f64;
    let mut capacity = 0.0_f64;
    for battery in &batteries {
        energy += f64::from(battery.energy().value);
        capacity += f64::from(battery.energy_full().value);
    }

    let percent = if capacity > 0.0 {
        (energy / capacity) * 100.0
    } else {
        // No usable capacity reading — fall back to the OS's own percentage, averaged. Worse, but
        // it is what a single-battery laptop with a quirky firmware still answers correctly.
        let sum: f64 = batteries
            .iter()
            .map(|battery| f64::from(battery.state_of_charge().value))
            .sum();
        (sum / batteries.len() as f64) * 100.0
    };

    let charging = batteries.iter().any(|battery| battery.state() == State::Charging);
    // Discharging is the only state that certainly means unplugged. `Full` is plugged and idle,
    // and `Unknown` — which some firmware reports indefinitely while on the mains — is treated as
    // plugged for the same reason: claiming a plugged-in laptop is on battery would be the wrong
    // way to be wrong, since it is the claim that would make someone go looking for a cable.
    let plugged_in = !batteries.iter().any(|battery| battery.state() == State::Discharging);

    // Only two states have a countdown worth reporting. Plugged in and *not* charging has neither:
    // nothing is filling, and the time-to-empty the OS may still offer describes a machine that
    // would have to be unplugged first — shown beside a plug icon it reads as "your battery is
    // draining", which is the opposite of what is happening.
    let minutes_left = if plugged_in && !charging { None } else { runway(&batteries, charging) };

    Some(PowerStatus {
        percent: percent.clamp(0.0, 100.0),
        plugged_in,
        charging,
        minutes_left,
    })
}

#[cfg(test)]
mod tests {
    use super::runway_minutes;

    const MINUTE: f64 = 60.0;

    #[test]
    fn a_real_runway_is_kept() {
        assert_eq!(runway_minutes(49.0 * MINUTE, false), Some(49));
        assert_eq!(runway_minutes(3.0 * 60.0 * MINUTE, true), Some(180));
        assert_eq!(runway_minutes(5.0 * 24.0 * 60.0 * MINUTE, false), Some(7200));
    }

    /// The report: the gauge's "unknown", shown as "quedan 1092 h 15 min".
    #[test]
    fn the_gauge_unknown_value_is_no_estimate() {
        assert_eq!(runway_minutes(65535.0 * MINUTE, false), None);
        assert_eq!(runway_minutes(65535.0 * MINUTE, true), None);
    }

    #[test]
    fn nothing_left_or_past_belief_is_no_estimate() {
        assert_eq!(runway_minutes(0.0, false), None);
        assert_eq!(runway_minutes(11.0 * 60.0 * MINUTE, true), None);
        assert_eq!(runway_minutes(11.0 * 24.0 * 60.0 * MINUTE, false), None);
        // Windows' own "unknown", should a platform ever pass it through in seconds.
        assert_eq!(runway_minutes(f64::from(u32::MAX), false), None);
    }

    /// Prints what this machine actually reports. `#[ignore]` because the answer depends entirely
    /// on the hardware it runs on — a desktop correctly prints nothing, which no assertion could
    /// tell apart from a broken read.
    ///
    /// ```text
    /// cargo test --lib power::tests::what_this_machine_reports -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore = "depends on the machine's hardware"]
    fn what_this_machine_reports() {
        match super::status() {
            Some(status) => println!("{status:#?}"),
            None => println!("no battery — desktop, or unreadable; the UI draws nothing"),
        }
    }
}
