//! Opening and first-PCM readiness share one cancellable, bounded preparation.
use crate::{capture::AudioSource, events::Event, request::Request, shim::AudioSession};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{Duration, Instant};

const READY_TIMEOUT: Duration = Duration::from_secs(2);

pub enum Action {
    Reconfigure(Box<Request>),
    Resume,
}

pub struct Opened {
    pub sessions: Vec<AudioSession>,
    pub sources: Vec<AudioSource>,
    pub events: Vec<Event>,
    pub expected: usize,
}

struct Cancellation(Arc<AtomicBool>);
impl Drop for Cancellation {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}

pub struct Preparation {
    pub generation: u64,
    pub opened: Option<Opened>,
    pub action: Action,
    started: Instant,
    cancellation: Cancellation,
}

impl Preparation {
    pub fn new(generation: u64, action: Action) -> Self {
        Self {
            generation,
            opened: None,
            action,
            started: Instant::now(),
            cancellation: Cancellation(Arc::new(AtomicBool::new(false))),
        }
    }

    pub fn cancellation(&self) -> Arc<AtomicBool> {
        self.cancellation.0.clone()
    }

    pub fn poll(&self, now: Instant) -> Result<bool, String> {
        if now.saturating_duration_since(self.started) >= READY_TIMEOUT {
            return Err(
                "audio input preparation exceeded two seconds; recording remains paused".into(),
            );
        }
        let Some(opened) = &self.opened else {
            return Ok(false);
        };
        if opened.sessions.len() != opened.expected {
            return Err(
                "could not prepare every requested audio input; recording remains paused".into(),
            );
        }
        readiness(opened.sessions.iter().map(AudioSession::readiness))
    }
}

fn readiness(inputs: impl IntoIterator<Item = Result<bool, String>>) -> Result<bool, String> {
    let mut ready = true;
    for input in inputs {
        ready &= input?;
    }
    Ok(ready)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn waits_for_every_input_and_accepts_silent_pcm() {
        assert!(!readiness([Ok(true), Ok(false)]).unwrap());
        assert!(readiness([Ok(true), Ok(true)]).unwrap());
        assert!(readiness([]).unwrap());
    }

    #[test]
    fn a_failed_input_is_not_hidden_by_another_pending_input() {
        assert_eq!(
            readiness([Ok(false), Err("target lost".into())]),
            Err("target lost".into())
        );
    }

    #[test]
    fn opening_is_also_inside_the_preparation_deadline() {
        let pending = Preparation::new(1, Action::Resume);
        assert!(!pending.poll(pending.started).unwrap());
        assert!(pending.poll(pending.started + READY_TIMEOUT).is_err());
    }

    #[test]
    fn cancelling_opening_marks_its_worker_and_never_opens_a_writer() {
        let pending = Preparation::new(1, Action::Resume);
        let cancelled = pending.cancellation();
        assert!(!cancelled.load(Ordering::Acquire));
        drop(pending);
        assert!(cancelled.load(Ordering::Acquire));
    }

    #[test]
    fn disabling_audio_is_ready_without_waiting_for_a_source() {
        let mut pending = Preparation::new(1, Action::Resume);
        pending.opened = Some(Opened {
            sessions: Vec::new(),
            sources: Vec::new(),
            events: Vec::new(),
            expected: 0,
        });
        assert!(pending.poll(pending.started).unwrap());
    }
}
