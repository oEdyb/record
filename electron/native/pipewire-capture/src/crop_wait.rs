use crate::shim::{Frame, FrameMailbox};
use std::time::{Duration, Instant};

const MAX_CROP_WAIT: Duration = Duration::from_millis(500);

#[derive(Default)]
pub struct CropWait {
    since: Option<Instant>,
    held: Option<Frame>,
}

impl CropWait {
    pub fn due(&self, now: Instant) -> bool {
        self.held.is_some()
            && self
                .since
                .is_some_and(|since| now.saturating_duration_since(since) >= MAX_CROP_WAIT)
    }

    pub fn take(
        &mut self,
        next: Option<Frame>,
        mailbox: &FrameMailbox,
        window: bool,
        now: Instant,
    ) -> Option<Frame> {
        let frame = match next {
            Some(frame) => {
                if let Some(stale) = self.held.take() {
                    mailbox.recycle(stale.pixels);
                }
                frame
            }
            None => self.held.take()?,
        };
        if window && !frame.has_crop {
            let since = *self.since.get_or_insert(now);
            if now.saturating_duration_since(since) < MAX_CROP_WAIT {
                self.held = Some(frame);
                return None;
            }
        }
        Some(frame)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_single_still_window_frame_is_released_without_another_frame() {
        let mailbox = FrameMailbox::default();
        let mut wait = CropWait::default();
        let now = Instant::now();
        assert!(wait
            .take(
                Some(Frame {
                    pts_ns: 42,
                    ..Frame::default()
                }),
                &mailbox,
                true,
                now
            )
            .is_none());
        assert!(!wait.due(now + Duration::from_millis(499)));
        assert!(wait.due(now + MAX_CROP_WAIT));
        assert_eq!(
            wait.take(None, &mailbox, true, now + MAX_CROP_WAIT)
                .unwrap()
                .pts_ns,
            42
        );
        assert!(!wait.due(now + MAX_CROP_WAIT));
    }

    #[test]
    fn a_late_crop_supersedes_the_held_frame_immediately() {
        let mailbox = FrameMailbox::default();
        let mut wait = CropWait::default();
        let now = Instant::now();
        assert!(wait
            .take(Some(Frame::default()), &mailbox, true, now)
            .is_none());
        assert_eq!(
            wait.take(
                Some(Frame {
                    has_crop: true,
                    pts_ns: 99,
                    ..Frame::default()
                }),
                &mailbox,
                true,
                now + Duration::from_millis(50)
            )
            .unwrap()
            .pts_ns,
            99
        );
        assert!(!wait.due(now + MAX_CROP_WAIT));
    }

    #[test]
    fn new_crop_less_frames_do_not_restart_the_deadline() {
        let mailbox = FrameMailbox::default();
        let mut wait = CropWait::default();
        let now = Instant::now();
        for ms in [0, 200, 499] {
            assert!(wait
                .take(
                    Some(Frame {
                        pts_ns: ms,
                        ..Frame::default()
                    }),
                    &mailbox,
                    true,
                    now + Duration::from_millis(ms as u64)
                )
                .is_none());
        }
        assert_eq!(
            wait.take(None, &mailbox, true, now + MAX_CROP_WAIT)
                .unwrap()
                .pts_ns,
            499
        );
    }

    #[test]
    fn monitor_frames_are_never_held() {
        let mailbox = FrameMailbox::default();
        assert!(CropWait::default()
            .take(Some(Frame::default()), &mailbox, false, Instant::now())
            .is_some());
    }
}
