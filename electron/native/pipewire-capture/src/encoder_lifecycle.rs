#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EncoderLifecycle {
    VideoEmpty,
    VideoStaged,
    AudioOpen,
    Draining,
    DrainInterrupted,
    Finished,
}

#[derive(Clone, Copy, Debug)]
pub enum EncoderEvent {
    StageInput,
    FrameStaged,
    VideoInput,
    AudioInput,
    BeginDrain,
    DrainSucceeded,
    DrainFailed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EncoderAction {
    Proceed,
    AlreadyFinished,
}

impl EncoderLifecycle {
    pub fn has_staged_frame(self) -> bool {
        self == Self::VideoStaged
    }

    pub fn transition(&mut self, event: EncoderEvent) -> Result<EncoderAction, String> {
        use EncoderEvent as E;
        use EncoderLifecycle as S;
        let next = match (*self, event) {
            (S::VideoEmpty | S::VideoStaged, E::StageInput) => *self,
            (S::VideoEmpty | S::VideoStaged, E::FrameStaged) => S::VideoStaged,
            (S::VideoStaged, E::VideoInput) | (S::AudioOpen, E::AudioInput) => *self,
            (S::Finished, E::BeginDrain) => return Ok(EncoderAction::AlreadyFinished),
            (
                S::VideoEmpty | S::VideoStaged | S::AudioOpen | S::DrainInterrupted,
                E::BeginDrain,
            ) => S::Draining,
            (S::Draining, E::DrainSucceeded) => S::Finished,
            (S::Draining, E::DrainFailed) => S::DrainInterrupted,
            _ => {
                eprintln!("[encoder-lifecycle] illegal transition: {self:?} / {event:?}");
                return Err(
                    if *self == S::VideoEmpty && matches!(event, E::VideoInput) {
                        "encode_staged called before any frame was staged".to_owned()
                    } else {
                        format!("encoder {self:?} cannot accept {event:?}")
                    },
                );
            }
        };
        *self = next;
        Ok(EncoderAction::Proceed)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MuxHealth {
    Healthy,
    Failed,
}

impl MuxHealth {
    pub fn from_result(result: i32) -> Self {
        if result < 0 {
            Self::Failed
        } else {
            Self::Healthy
        }
    }

    fn combine(self, other: Self) -> Self {
        if self == Self::Failed || other == Self::Failed {
            Self::Failed
        } else {
            Self::Healthy
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MuxLifecycle {
    Allocated,
    Configured,
    Writing(MuxHealth),
    Finalizing(MuxHealth),
    Closed(MuxHealth),
}

#[derive(Clone, Copy, Debug)]
pub enum MuxEvent {
    StreamInput,
    StreamAdded,
    HeaderInput,
    HeaderWritten,
    PacketInput,
    WriteFailed,
    FinishInput,
    TrailerFinished(MuxHealth),
    IoClosed(MuxHealth),
}

impl MuxLifecycle {
    pub fn needs_trailer(self) -> bool {
        matches!(self, Self::Writing(_))
    }

    pub fn needs_repair(self) -> bool {
        matches!(
            self,
            Self::Writing(MuxHealth::Failed)
                | Self::Finalizing(MuxHealth::Failed)
                | Self::Closed(MuxHealth::Failed)
        )
    }

    pub fn transition(&mut self, event: MuxEvent) -> Result<(), String> {
        use MuxEvent as E;
        use MuxLifecycle as S;
        let next = match (*self, event) {
            (S::Allocated | S::Configured, E::StreamInput) => *self,
            (S::Allocated | S::Configured, E::StreamAdded) => S::Configured,
            (S::Configured, E::HeaderInput) => *self,
            (S::Configured, E::HeaderWritten) => S::Writing(MuxHealth::Healthy),
            (S::Writing(_), E::PacketInput | E::FinishInput) => *self,
            (S::Writing(_), E::WriteFailed) => S::Writing(MuxHealth::Failed),
            (S::Writing(health), E::TrailerFinished(result)) => {
                S::Finalizing(health.combine(result))
            }
            (S::Allocated | S::Configured, E::IoClosed(result)) => S::Closed(result),
            (S::Finalizing(health) | S::Closed(health), E::IoClosed(result)) => {
                S::Closed(health.combine(result))
            }
            _ => {
                eprintln!("[mux-lifecycle] illegal transition: {self:?} / {event:?}");
                return Err(match event {
                    E::StreamInput => {
                        "a stream cannot be added after the header is written".to_owned()
                    }
                    E::HeaderInput if *self == S::Allocated => {
                        "the output has no streams".to_owned()
                    }
                    _ => format!("MP4 muxer {self:?} cannot accept {event:?}"),
                });
            }
        };
        *self = next;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn illegal_input_after_drain_does_not_reopen_a_codec() {
        let mut state = EncoderLifecycle::VideoEmpty;
        assert!(state.transition(EncoderEvent::VideoInput).is_err());
        state.transition(EncoderEvent::FrameStaged).expect("staged");
        state.transition(EncoderEvent::BeginDrain).expect("drain");
        state
            .transition(EncoderEvent::DrainFailed)
            .expect("interruption");
        assert!(state.transition(EncoderEvent::StageInput).is_err());
        assert_eq!(state, EncoderLifecycle::DrainInterrupted);
        state
            .transition(EncoderEvent::BeginDrain)
            .expect("retry must drain");
        state
            .transition(EncoderEvent::DrainSucceeded)
            .expect("done");
        assert!(state.transition(EncoderEvent::VideoInput).is_err());
        assert_eq!(
            state.transition(EncoderEvent::BeginDrain),
            Ok(EncoderAction::AlreadyFinished)
        );
    }

    #[test]
    fn a_failed_mux_write_still_accepts_flush_packets_and_keeps_repair_required() {
        let mut state = MuxLifecycle::Allocated;
        assert!(state.transition(MuxEvent::HeaderInput).is_err());
        state.transition(MuxEvent::StreamAdded).expect("stream");
        state.transition(MuxEvent::HeaderWritten).expect("header");
        state
            .transition(MuxEvent::WriteFailed)
            .expect("write failure");
        state
            .transition(MuxEvent::PacketInput)
            .expect("queued footage must drain");
        state
            .transition(MuxEvent::FinishInput)
            .expect("Stop must finalize");
        state
            .transition(MuxEvent::TrailerFinished(MuxHealth::Healthy))
            .expect("trailer");
        state
            .transition(MuxEvent::IoClosed(MuxHealth::Healthy))
            .expect("close");
        assert!(state.needs_repair());
        let closed = state;
        assert!(state.transition(MuxEvent::PacketInput).is_err());
        assert_eq!(state, closed);
        assert!(state.needs_repair());
    }
}
