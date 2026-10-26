//! Candidate readiness is separate from the unbounded human portal wait.
use crate::{
    portal::SourceKind,
    shim::{CursorEvent, Frame},
};
use std::time::{Duration, Instant};

const FIRST_FRAME_TIMEOUT: Duration = Duration::from_secs(8);
const MAX_FRAMES_AWAITING_CROP: usize = 8;

pub struct Readiness {
    connected_at: Instant,
    kind: Option<SourceKind>,
    frames_awaiting_crop: usize,
}

impl Readiness {
    pub fn new(kind: Option<SourceKind>, connected_at: Instant) -> Self {
        Self {
            connected_at,
            kind,
            frames_awaiting_crop: 0,
        }
    }

    pub fn expired(&self, now: Instant) -> bool {
        now.saturating_duration_since(self.connected_at) >= FIRST_FRAME_TIMEOUT
    }

    pub fn accepts(&mut self, frame: &Frame) -> bool {
        if self.kind == Some(SourceKind::Window)
            && !frame.has_crop
            && self.frames_awaiting_crop < MAX_FRAMES_AWAITING_CROP
        {
            self.frames_awaiting_crop += 1;
            return false;
        }
        true
    }
}

/// Position-only metadata does not invalidate the most recent cursor sprite.
pub fn remember_cursor(saved: &mut Option<CursorEvent>, mut update: CursorEvent) {
    if update.bitmap.is_none() {
        if let Some(previous) = saved.take() {
            update.bitmap = previous.bitmap;
            update.hotspot_x = previous.hotspot_x;
            update.hotspot_y = previous.hotspot_y;
        }
    }
    *saved = Some(update);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candidate_keeps_its_sprite_and_hotspot_through_position_only_updates() {
        use crate::shim::CursorBitmap;
        let mut cursor = None;
        remember_cursor(
            &mut cursor,
            CursorEvent {
                x: 1,
                y: 2,
                hotspot_x: 3,
                hotspot_y: 4,
                id: 9,
                bitmap: Some(CursorBitmap {
                    format: 1,
                    width: 1,
                    height: 1,
                    stride: 4,
                    pixels: vec![11, 22, 33, 44],
                }),
            },
        );
        remember_cursor(
            &mut cursor,
            CursorEvent {
                x: 20,
                y: 30,
                hotspot_x: 0,
                hotspot_y: 0,
                id: 9,
                bitmap: None,
            },
        );
        let adopted = cursor.expect("candidate cursor at adoption");
        assert_eq!((adopted.x, adopted.y), (20, 30));
        assert_eq!((adopted.hotspot_x, adopted.hotspot_y), (3, 4));
        assert_eq!(
            adopted.bitmap.expect("retained sprite").pixels,
            [11, 22, 33, 44]
        );
    }

    #[test]
    fn readiness_deadline_starts_at_connection_not_picker_creation() {
        let connected = Instant::now();
        let ready = Readiness::new(None, connected);
        assert!(!ready.expired(connected + Duration::from_secs(7)));
        assert!(ready.expired(connected + Duration::from_secs(8)));
    }

    #[test]
    fn windows_wait_for_crop_but_static_full_streams_remain_selectable() {
        let mut ready = Readiness::new(Some(SourceKind::Window), Instant::now());
        for _ in 0..MAX_FRAMES_AWAITING_CROP {
            assert!(!ready.accepts(&Frame::default()));
        }
        assert!(ready.accepts(&Frame::default()));
    }

    #[test]
    fn cropped_windows_and_monitors_are_ready_on_the_first_frame() {
        let mut window = Readiness::new(Some(SourceKind::Window), Instant::now());
        assert!(window.accepts(&Frame {
            has_crop: true,
            ..Frame::default()
        }));
        let mut monitor = Readiness::new(Some(SourceKind::Monitor), Instant::now());
        assert!(monitor.accepts(&Frame::default()));
    }
}
