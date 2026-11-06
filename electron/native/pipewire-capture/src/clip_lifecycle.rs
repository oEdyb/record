use crate::capture::Capture;
use std::time::Instant;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum History {
    Unstarted,
    Started,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Origin {
    Initial,
    ResumeBeforeStart,
    Continue,
}
impl Origin {
    pub fn history(self) -> History {
        if self == Self::Continue {
            History::Started
        } else {
            History::Unstarted
        }
    }
    pub fn resumed(self) -> bool {
        self != Self::Initial
    }
}

enum Phase {
    Waiting {
        origin: Origin,
        since: Option<Instant>,
    },
    Staged {
        origin: Origin,
        writer: Box<Capture>,
    },
    Writing {
        writer: Box<Capture>,
    },
    Paused {
        history: History,
        writer: Option<Box<Capture>>,
    },
    Draining {
        history: History,
    },
    Between {
        history: History,
    },
    Failed {
        message: String,
        previous: Box<Phase>,
    },
    Stopped {
        history: History,
    },
}
impl Phase {
    fn base(&self) -> &Self {
        match self {
            Self::Failed { previous, .. } => previous.base(),
            other => other,
        }
    }
    fn name(&self) -> &'static str {
        match self {
            Self::Waiting { .. } => "waiting",
            Self::Staged { .. } => "staged",
            Self::Writing { .. } => "writing",
            Self::Paused { .. } => "paused",
            Self::Draining { .. } => "draining",
            Self::Between { .. } => "between",
            Self::Failed { .. } => "failed",
            Self::Stopped { .. } => "stopped",
        }
    }
    fn history(&self) -> History {
        match self.base() {
            Self::Waiting { origin, .. } | Self::Staged { origin, .. } => origin.history(),
            Self::Writing { .. } => History::Started,
            Self::Paused { history, .. }
            | Self::Draining { history }
            | Self::Between { history }
            | Self::Stopped { history } => *history,
            Self::Failed { previous, .. } => previous.history(),
        }
    }
    fn writer(&self) -> Option<&Capture> {
        match self {
            Self::Staged { writer, .. } | Self::Writing { writer } => Some(writer),
            Self::Paused { writer, .. } => writer.as_deref(),
            Self::Failed { previous, .. } => previous.writer(),
            _ => None,
        }
    }
    fn writer_mut(&mut self) -> Option<&mut Capture> {
        match self {
            Self::Staged { writer, .. } | Self::Writing { writer } => Some(writer),
            Self::Paused { writer, .. } => writer.as_deref_mut(),
            Self::Failed { previous, .. } => previous.writer_mut(),
            _ => None,
        }
    }
}

pub(super) enum ClipMove {
    Connected(Instant),
    Prepared(Box<Capture>),
    Announced,
    Pause,
    Resume(Instant),
    TakeWriter,
    Drained,
    Fail(String),
    Stop,
    Frame,
}
impl ClipMove {
    fn name(&self) -> &'static str {
        match self {
            Self::Connected(_) => "connected",
            Self::Prepared(_) => "prepared",
            Self::Announced => "announced",
            Self::Pause => "pause",
            Self::Resume(_) => "resume",
            Self::TakeWriter => "take-writer",
            Self::Drained => "drained",
            Self::Fail(_) => "fail",
            Self::Stop => "stop",
            Self::Frame => "frame",
        }
    }
}

pub(super) struct ClipLifecycle {
    phase: Phase,
}
impl Default for ClipLifecycle {
    fn default() -> Self {
        Self {
            phase: Phase::Waiting {
                origin: Origin::Initial,
                since: None,
            },
        }
    }
}
impl ClipLifecycle {
    pub fn writer(&self) -> Option<&Capture> {
        self.phase.writer()
    }
    pub fn writer_mut(&mut self) -> Option<&mut Capture> {
        self.phase.writer_mut()
    }
    pub fn paused(&self) -> bool {
        matches!(self.phase.base(), Phase::Paused { .. })
    }
    pub fn started(&self) -> bool {
        self.phase.history() == History::Started
    }
    pub fn origin(&self) -> Option<Origin> {
        match self.phase.base() {
            Phase::Waiting { origin, .. } | Phase::Staged { origin, .. } => Some(*origin),
            _ => None,
        }
    }
    pub fn awaiting_since(&self) -> Option<Instant> {
        match self.phase.base() {
            Phase::Waiting { since, .. } => *since,
            _ => None,
        }
    }
    pub fn failure(&self) -> Option<&str> {
        match &self.phase {
            Phase::Failed { message, .. } => Some(message),
            _ => None,
        }
    }
    pub fn transition(&mut self, event: ClipMove) -> Result<Option<Box<Capture>>, String> {
        fn apply(phase: &mut Phase, event: ClipMove) -> Result<Option<Box<Capture>>, String> {
            let action = event.name();
            let name = phase.name();
            if let Phase::Failed { previous, .. } = phase {
                if matches!(event, ClipMove::Fail(_)) {
                    return Ok(None);
                }
                return apply(previous, event);
            }
            let history = phase.history();
            let old = std::mem::replace(phase, Phase::Stopped { history });
            let mut extracted = None;
            let next = match (old, event) {
                (Phase::Waiting { origin, .. }, ClipMove::Connected(since)) => Phase::Waiting {
                    origin,
                    since: Some(since),
                },
                (old, ClipMove::Frame)
                    if !matches!(
                        old,
                        Phase::Stopped { .. } | Phase::Draining { .. } | Phase::Between { .. }
                    ) =>
                {
                    old
                }
                (old, ClipMove::Connected(_)) if !matches!(old, Phase::Stopped { .. }) => old,
                (Phase::Waiting { origin, .. }, ClipMove::Prepared(writer)) => {
                    Phase::Staged { origin, writer }
                }
                (Phase::Staged { writer, .. }, ClipMove::Announced) => Phase::Writing { writer },
                (Phase::Waiting { .. }, ClipMove::Pause)
                | (Phase::Between { .. }, ClipMove::Pause) => Phase::Paused {
                    history,
                    writer: None,
                },
                (Phase::Staged { writer, .. }, ClipMove::Pause)
                | (Phase::Writing { writer }, ClipMove::Pause) => Phase::Paused {
                    history,
                    writer: Some(writer),
                },
                (old @ Phase::Paused { .. }, ClipMove::Pause) => old,
                (Phase::Paused { history, writer }, ClipMove::Resume(since)) => {
                    let origin = if history == History::Started {
                        Origin::Continue
                    } else {
                        Origin::ResumeBeforeStart
                    };
                    match writer {
                        Some(writer) => Phase::Staged { origin, writer },
                        None => Phase::Waiting {
                            origin,
                            since: Some(since),
                        },
                    }
                }
                (Phase::Staged { writer, .. }, ClipMove::TakeWriter)
                | (Phase::Writing { writer }, ClipMove::TakeWriter)
                | (
                    Phase::Paused {
                        writer: Some(writer),
                        ..
                    },
                    ClipMove::TakeWriter,
                ) => {
                    extracted = Some(writer);
                    Phase::Draining { history }
                }
                (old, ClipMove::TakeWriter) => old,
                (Phase::Draining { history }, ClipMove::Drained) => Phase::Between { history },
                (old, ClipMove::Fail(message)) => Phase::Failed {
                    message,
                    previous: Box::new(old),
                },
                (old, ClipMove::Stop) if old.writer().is_none() => Phase::Stopped { history },
                (old, _) => {
                    *phase = old;
                    let message = format!("illegal clip transition: {name} -> {action}");
                    eprintln!("[clip-lifecycle] {message}");
                    return Err(message);
                }
            };
            *phase = next;
            Ok(extracted)
        }
        apply(&mut self.phase, event)
    }
}
