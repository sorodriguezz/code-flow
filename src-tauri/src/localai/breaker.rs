//! Stops the app from starting a local engine over and over when it cannot start.
//!
//! The inline completion asks for an engine on **every keystroke**, and a start that fails (a model
//! that no longer fits in memory, a binary the system will not run) used to be retried a second later,
//! and a second after that. A server that unpacks or maps gigabytes each time it fails is how a start
//! loop fills a disk or leaves the machine swapping; the same bug was found in another desktop app,
//! whose answer was to stop auto-starting after three failed starts. This is that rule, once.
//!
//! Three failed starts in a row open the breaker. While open nothing is started — the caller gets the
//! reason and the time to try again — and after [`COOL_DOWN`] **one** attempt is allowed through: if it
//! works the count is cleared, if it fails the breaker opens again. A person picking a model or pressing
//! "start" in Settings clears it at once ([`Breaker::reset`]), because they are the "user acts" that ends
//! the pause.

use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Failed starts in a row that open the breaker.
pub const LIMIT: u32 = 3;
/// How long it stays open.
pub const COOL_DOWN: Duration = Duration::from_secs(5 * 60);

#[derive(Default)]
pub struct Breaker {
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    failures: u32,
    open_until: Option<Instant>,
}

impl Breaker {
    pub const fn new() -> Self {
        Self { state: Mutex::new(State { failures: 0, open_until: None }) }
    }

    /// `Ok` when a start may be attempted; `Err` with the seconds left when the breaker is open.
    pub fn allow(&self) -> Result<(), u64> {
        self.allow_at(Instant::now())
    }

    fn allow_at(&self, now: Instant) -> Result<(), u64> {
        let Ok(mut state) = self.state.lock() else { return Ok(()) };
        match state.open_until {
            Some(until) if now < until => Err((until - now).as_secs().max(1)),
            Some(_) => {
                // Cooled down: one attempt through. A failure re-opens it at once because the count
                // is still at the limit.
                state.open_until = None;
                Ok(())
            }
            None => Ok(()),
        }
    }

    /// A start failed.
    pub fn failed(&self) {
        self.failed_at(Instant::now());
    }

    fn failed_at(&self, now: Instant) {
        if let Ok(mut state) = self.state.lock() {
            state.failures += 1;
            if state.failures >= LIMIT {
                state.open_until = Some(now + COOL_DOWN);
            }
        }
    }

    /// A start worked.
    pub fn succeeded(&self) {
        self.reset();
    }

    /// The person acted: forget everything.
    pub fn reset(&self) {
        if let Ok(mut state) = self.state.lock() {
            *state = State::default();
        }
    }
}

/// The sentence for a refused start.
pub fn paused_message(seconds: u64) -> String {
    format!(
        "The local engine failed to start {LIMIT} times in a row, so starts are paused for {} more minute(s). \
         Choosing a model in Settings › AI engines › Local model tries again at once.",
        seconds.div_ceil(60)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn it_opens_after_three_failures_in_a_row_and_not_before() {
        let breaker = Breaker::new();
        let now = Instant::now();
        for _ in 0..LIMIT - 1 {
            breaker.failed_at(now);
            assert!(breaker.allow_at(now).is_ok());
        }
        breaker.failed_at(now);
        assert!(breaker.allow_at(now).is_err());
    }

    #[test]
    fn a_success_in_between_keeps_it_closed() {
        let breaker = Breaker::new();
        let now = Instant::now();
        breaker.failed_at(now);
        breaker.failed_at(now);
        breaker.succeeded();
        breaker.failed_at(now);
        breaker.failed_at(now);
        assert!(breaker.allow_at(now).is_ok(), "two failures after a success is not three in a row");
    }

    #[test]
    fn after_the_cool_down_one_attempt_goes_through_and_a_failure_reopens_it() {
        let breaker = Breaker::new();
        let now = Instant::now();
        (0..LIMIT).for_each(|_| breaker.failed_at(now));
        let later = now + COOL_DOWN + Duration::from_secs(1);
        assert!(breaker.allow_at(later).is_ok());
        breaker.failed_at(later);
        assert!(breaker.allow_at(later).is_err(), "the one attempt failed: open again");
    }

    #[test]
    fn the_person_acting_clears_it_at_once() {
        let breaker = Breaker::new();
        let now = Instant::now();
        (0..LIMIT).for_each(|_| breaker.failed_at(now));
        assert!(breaker.allow_at(now).is_err());
        breaker.reset();
        assert!(breaker.allow_at(now).is_ok());
    }

    #[test]
    fn the_message_says_how_long_and_how_to_try_again() {
        let text = paused_message(250);
        assert!(text.contains("5 more minute") && text.contains("Local model"));
    }
}
