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
use starship_battery::{Manager, State};

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
    let minutes_left = if plugged_in && !charging {
        None
    } else {
        batteries
            .iter()
            .filter_map(|battery| {
                let remaining =
                    if charging { battery.time_to_full() } else { battery.time_to_empty() };
                remaining.map(|time| (f64::from(time.value) / 60.0).round() as i64)
            })
            // The one that runs out first is the one that matters; a sum would promise a runway the
            // machine does not have.
            .min()
            .filter(|minutes| *minutes > 0)
    };

    Some(PowerStatus {
        percent: percent.clamp(0.0, 100.0),
        plugged_in,
        charging,
        minutes_left,
    })
}

#[cfg(test)]
mod tests {
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
