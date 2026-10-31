//! Candidate readiness is separate from the unbounded human portal wait.
use crate::shim::CursorEvent;
use std::time::{Duration, Instant};

const FIRST_FRAME_TIMEOUT: Duration = Duration::from_secs(8);

pub struct Readiness {
    connected_at: Instant,
}

impl Readiness {
    pub fn new(connected_at: Instant) -> Self {
        Self { connected_at }
    }

    pub fn expired(&self, now: Instant) -> bool {
        now.saturating_duration_since(self.connected_at) >= FIRST_FRAME_TIMEOUT
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
        let ready = Readiness::new(connected);
        assert!(!ready.expired(connected + Duration::from_secs(7)));
        assert!(ready.expired(connected + Duration::from_secs(8)));
    }
}
