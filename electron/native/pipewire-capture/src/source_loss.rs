//! Classifies terminal capture-source loss separately from stream negotiation.
//! The app saves a live take loudly, or preserves a user pause for reselection.
//! PipeWire can remove a producer without disconnecting its consumer stream;
//! the C shim also observes registry removal of the selected source node.

/// What the main loop does with a state change of the current stream.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// Nothing to do: still negotiating, or the dead stream's teardown noise.
    Ignore,
    /// End the take loudly, as before. Startup failures and the legacy
    /// single-file protocol keep this.
    Fatal,
    /// The source is gone but the take is intact: warn `source-inactive`, let the
    /// app save a live take, and refuse Continue until a replacement source is adopted.
    SourceLost,
}

/// Facts about the take at the moment of a stream state change.
#[derive(Debug, Clone, Copy)]
pub struct Take {
    /// The stream this message belongs to is still the adopted one.
    pub has_session: bool,
    /// Clip-native request (`outputs` present). The legacy protocol cannot pause
    /// and reselect, so a lost stream still ends it.
    pub clip_native: bool,
    /// A clip has already been confirmed. Before that, loss is a startup failure.
    pub started: bool,
}

/// The source-loss warning shared with the recording service.
pub fn inactive_warning(error: Option<&str>) -> crate::events::Event {
    crate::events::Event::Warning {
        code: "source-inactive".into(),
        message: error.map_or_else(
            || "The captured content closed.".into(),
            |detail| format!("The captured content closed ({detail})."),
        ),
    }
}

#[derive(Debug, Default)]
pub struct SourceHealth {
    lost: bool,
}

impl SourceHealth {
    #[cfg(test)]
    pub fn is_lost(&self) -> bool {
        self.lost
    }

    /// Classify a PipeWire stream state change; marks the source lost when it is.
    pub fn on_stream_state(&mut self, state: &str, error: Option<&str>, take: Take) -> Outcome {
        // Anything the dead stream reports after we noticed is teardown noise.
        // Treating a late error as fatal would turn a graceful pause into an exit.
        if self.lost {
            return Outcome::Ignore;
        }
        let gone = error.is_some() || (state == "unconnected" && take.has_session);
        if !gone {
            return Outcome::Ignore;
        }
        if take.clip_native && take.started && take.has_session {
            self.lost = true;
            return Outcome::SourceLost;
        }
        Outcome::Fatal
    }

    /// `Err` with the reason Continue must be refused while no source is live.
    pub fn check_resume(&self) -> Result<(), &'static str> {
        if self.lost {
            Err("The recorded window closed. Choose a source before continuing.")
        } else {
            Ok(())
        }
    }

    /// A replacement source was adopted: the take can continue.
    pub fn reselected(&mut self) {
        self.lost = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn running() -> Take {
        Take {
            has_session: true,
            clip_native: true,
            started: true,
        }
    }

    #[test]
    fn unconnected_after_start_reports_source_loss() {
        let mut health = SourceHealth::default();
        assert_eq!(
            health.on_stream_state("unconnected", None, running()),
            Outcome::SourceLost
        );
        assert!(health.is_lost());
    }

    #[test]
    fn a_stream_error_after_start_is_also_source_loss() {
        // PipeWire daemon restart or node removal can arrive as an error state.
        let mut health = SourceHealth::default();
        assert_eq!(
            health.on_stream_state("error", Some("node removed"), running()),
            Outcome::SourceLost
        );
    }

    #[test]
    fn ordinary_transitions_are_ignored() {
        let mut health = SourceHealth::default();
        for state in ["connecting", "paused", "streaming"] {
            assert_eq!(
                health.on_stream_state(state, None, running()),
                Outcome::Ignore,
                "{state}"
            );
        }
        assert!(!health.is_lost());
    }

    #[test]
    fn unconnected_without_a_session_is_not_a_loss() {
        // The old condition: the replaced session's own teardown must not count.
        let mut health = SourceHealth::default();
        let take = Take {
            has_session: false,
            ..running()
        };
        assert_eq!(
            health.on_stream_state("unconnected", None, take),
            Outcome::Ignore
        );
    }

    #[test]
    fn loss_before_the_first_confirmed_clip_still_fails_the_start() {
        let mut health = SourceHealth::default();
        let take = Take {
            started: false,
            ..running()
        };
        assert_eq!(
            health.on_stream_state("unconnected", None, take),
            Outcome::Fatal
        );
        assert_eq!(
            health.on_stream_state("error", Some("target not found"), take),
            Outcome::Fatal
        );
        assert!(!health.is_lost());
    }

    #[test]
    fn the_legacy_single_file_protocol_still_ends_on_loss() {
        let mut health = SourceHealth::default();
        let take = Take {
            clip_native: false,
            ..running()
        };
        assert_eq!(
            health.on_stream_state("unconnected", None, take),
            Outcome::Fatal
        );
        assert_eq!(
            health.on_stream_state("error", Some("boom"), take),
            Outcome::Fatal
        );
    }

    #[test]
    fn teardown_noise_after_the_loss_never_ends_the_take() {
        let mut health = SourceHealth::default();
        assert_eq!(
            health.on_stream_state("unconnected", None, running()),
            Outcome::SourceLost
        );
        // Warned once; the dead stream's follow-ups are silent, errors included.
        assert_eq!(
            health.on_stream_state("unconnected", None, running()),
            Outcome::Ignore
        );
        assert_eq!(
            health.on_stream_state("error", Some("target not found"), running()),
            Outcome::Ignore
        );
    }

    #[test]
    fn continue_is_refused_until_a_source_is_reselected() {
        let mut health = SourceHealth::default();
        assert_eq!(health.check_resume(), Ok(()));
        health.on_stream_state("unconnected", None, running());
        assert!(health.check_resume().is_err());
        // Refusing is repeatable: the app may retry before choosing.
        assert!(health.check_resume().is_err());
        health.reselected();
        assert_eq!(health.check_resume(), Ok(()));
    }

    #[test]
    fn a_reselected_source_can_be_lost_again() {
        let mut health = SourceHealth::default();
        health.on_stream_state("unconnected", None, running());
        health.reselected();
        assert_eq!(
            health.on_stream_state("unconnected", None, running()),
            Outcome::SourceLost
        );
        assert!(health.check_resume().is_err());
    }

    #[test]
    fn loss_while_paused_is_recorded_so_continue_is_refused() {
        // The window can close during Pause. The app is already paused, but
        // Continue must not wait on a stream that is never coming back.
        let mut health = SourceHealth::default();
        assert_eq!(
            health.on_stream_state("unconnected", None, running()),
            Outcome::SourceLost
        );
        assert_eq!(
            health.check_resume(),
            Err("The recorded window closed. Choose a source before continuing.")
        );
    }

    /// The wire contract the Electron side already parses: a `warning` named
    /// `source-inactive`, then a retryable `clip-resume-rejected` on Continue.
    #[test]
    fn loss_and_refused_continue_use_the_existing_protocol_events() {
        use crate::clips::Clips;
        use crate::events::Emitter;

        let request: crate::request::Request = serde_json::from_value(serde_json::json!({
            "outputs": { "screenPath": "/tmp/never-opened-clip-0001.mp4" },
            "cursor": { "mode": "system" }, "video": { "fps": 30, "bitrate": 1000000 }
        }))
        .expect("request");
        let clips = Clips::new(request, Vec::new(), None);
        let mut out = Vec::new();
        let mut emitter = Emitter::new(&mut out, false);

        let mut health = SourceHealth::default();
        let outcome = health.on_stream_state("unconnected", None, running());
        assert_eq!(outcome, Outcome::SourceLost);
        emitter.emit(&inactive_warning(None)).unwrap();
        let refusal = health.check_resume().unwrap_err();
        clips.reject_resume(&mut emitter, refusal.into());

        let lines: Vec<serde_json::Value> = String::from_utf8(out)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(lines[0]["event"], "warning");
        assert_eq!(lines[0]["code"], "source-inactive");
        assert_eq!(lines[1]["event"], "error");
        assert_eq!(lines[1]["code"], "clip-resume-rejected");
        assert_eq!(lines[1]["message"], refusal);
    }

    #[test]
    fn the_warning_keeps_the_pipewire_detail_when_there_is_one() {
        let crate::events::Event::Warning { message, .. } = inactive_warning(Some("node removed"))
        else {
            panic!("not a warning");
        };
        assert_eq!(message, "The captured content closed (node removed).");
    }
}
