//! Bounded cache of recently decoded frames for backward scrubbing in the live preview.
//!
//! The captures use a short GOP (one keyframe every 0.5 s) and frames without B-frames. A
//! backward step lands behind the decoder, so `Decoder::seek_to` must seek to the previous
//! keyframe and decode forward again. Measured on a 3420x2214 High-profile recording:
//! about 3.6 ms per decoded frame, so up to ~110 ms for one step at the end of a GOP.
//!
//! The decoder already produced those frames on its way to the current position. This cache
//! keeps references to the most recent ones (the same VideoToolbox pixel buffers, never a
//! copy or a rescale), so a backward step that stays inside the cached run is served
//! without decoding. The selected frame is exactly the one a keyframe seek would select:
//! the first frame whose time is at or after the target (see `first_at_or_after`).
//!
//! Memory is bounded by `SCRUB_CACHE_BUDGET_BYTES` (NV12 payload estimate) and
//! `SCRUB_CACHE_MAX_FRAMES`. Only the live preview's active screen decoder enables it; the
//! export never does.

use std::collections::VecDeque;

/// Upper bound for the retained NV12 payload of one cache. 3420x2214 frames (11.4 MB) give
/// 23 frames, so a miss inside a 30-frame GOP decodes at most 8 frames; 1080p gives the
/// frame cap. Held only while the preview is paused.
pub(crate) const SCRUB_CACHE_BUDGET_BYTES: usize = 256 << 20;
/// Upper bound on frames, whatever the resolution. One GOP of current captures is 30.
pub(crate) const SCRUB_CACHE_MAX_FRAMES: usize = 32;

/// Number of frames of `width`x`height` NV12 that fit in `budget_bytes`, capped at
/// `SCRUB_CACHE_MAX_FRAMES`. Fewer than 2 frames cannot serve a step, so it returns 0.
pub(crate) fn capacity_for(width: i32, height: i32, budget_bytes: usize) -> usize {
    if width <= 0 || height <= 0 {
        return 0;
    }
    let frame_bytes = (width as usize) * (height as usize) * 3 / 2;
    let n = (budget_bytes / frame_bytes.max(1)).min(SCRUB_CACHE_MAX_FRAMES);
    if n < 2 {
        0
    } else {
        n
    }
}

/// Index of the frame a keyframe seek to `threshold_pts` would return, if the cached run
/// proves it: the first frame with `pts >= threshold_pts`, AND a cached predecessor below
/// the threshold. Without that predecessor an uncached earlier frame could also qualify, so
/// index 0 is never a proof. `pts` must be strictly increasing (decode order of a stream
/// without reordering).
pub(crate) fn first_at_or_after(pts: &VecDeque<i64>, threshold_pts: f64) -> Option<usize> {
    let i = pts.iter().position(|&p| p as f64 >= threshold_pts)?;
    (i >= 1 && (pts[i - 1] as f64) < threshold_pts).then_some(i)
}

/// Owned references (`av_frame_ref`) to a contiguous run of decoded frames, in decode order.
/// The newest entry is the most recent frame the decoder committed from VideoToolbox.
pub(crate) struct ScrubCache {
    budget_bytes: usize,
    capacity: Option<usize>,
    frames: VecDeque<*mut crate::ffi::AVFrame>,
    pts: VecDeque<i64>,
    /// `Some(i)`: the decoder's current frame is `frames[i]` and newer cached frames follow
    /// it. `None`: the current frame is the newest decoded frame (or the cache is empty).
    behind: Option<usize>,
    /// Playback started: stop recording frames, but keep serving the cached ones the decoder
    /// is behind (they are the next frames to show) and release everything at the head.
    retiring: bool,
}

impl ScrubCache {
    pub(crate) fn new(budget_bytes: usize) -> Self {
        Self {
            budget_bytes,
            capacity: None,
            frames: VecDeque::new(),
            pts: VecDeque::new(),
            behind: None,
            retiring: false,
        }
    }

    /// See `retiring`. Releases at once when the decoder is already at its newest frame.
    pub(crate) fn retire(&mut self) {
        self.retiring = true;
        if self.behind.is_none() {
            self.clear();
        }
    }

    pub(crate) fn resume(&mut self) {
        self.retiring = false;
    }

    pub(crate) fn len(&self) -> usize {
        self.frames.len()
    }

    pub(crate) fn pts(&self) -> &VecDeque<i64> {
        &self.pts
    }

    /// Drops every reference. Called on any keyframe seek or rewind: the next decoded frame
    /// no longer follows the cached run.
    pub(crate) fn clear(&mut self) {
        for mut frame in self.frames.drain(..) {
            unsafe { crate::ffi::av_frame_free(&mut frame) };
        }
        self.pts.clear();
        self.behind = None;
    }

    /// Index of the frame after the current one when the decoder is behind its newest frame.
    pub(crate) fn next_index(&self) -> Option<usize> {
        self.behind.map(|i| i + 1)
    }

    /// Records a frame the decoder just committed from the stream (head mode only).
    pub(crate) unsafe fn push(&mut self, frame: *const crate::ffi::AVFrame) {
        debug_assert!(self.behind.is_none());
        if self.retiring {
            self.clear();
            return;
        }
        let pts = (*frame).best_effort_timestamp;
        let capacity = *self.capacity.get_or_insert_with(|| {
            capacity_for((*frame).width, (*frame).height, self.budget_bytes)
        });
        // Without a usable timestamp, or after a non-increasing one, the run is no longer a
        // proof of order. Start over rather than serve a frame a seek would not select.
        if capacity == 0 || pts == i64::MIN || self.pts.back().is_some_and(|&last| pts <= last) {
            self.clear();
            if capacity == 0 || pts == i64::MIN {
                return;
            }
        }
        let copy = crate::ffi::av_frame_alloc();
        if copy.is_null() {
            self.clear();
            return;
        }
        if crate::ffi::av_frame_ref(copy, frame) < 0 {
            let mut copy = copy;
            crate::ffi::av_frame_free(&mut copy);
            self.clear();
            return;
        }
        self.frames.push_back(copy);
        self.pts.push_back(pts);
        while self.frames.len() > capacity {
            if let Some(mut oldest) = self.frames.pop_front() {
                crate::ffi::av_frame_free(&mut oldest);
            }
            self.pts.pop_front();
        }
    }

    /// Makes `into` a new reference to cached frame `index` and moves the cursor there.
    /// Returns its pts.
    pub(crate) unsafe fn adopt(
        &mut self,
        index: usize,
        into: *mut crate::ffi::AVFrame,
    ) -> anyhow::Result<i64> {
        anyhow::ensure!(index < self.frames.len(), "scrub cache index out of range");
        crate::ffi::av_frame_unref(into);
        crate::ffi::averr(
            crate::ffi::av_frame_ref(into, self.frames[index]),
            "av_frame_ref (scrub cache)",
        )?;
        self.behind = (index + 1 < self.frames.len()).then_some(index);
        let pts = self.pts[index];
        if self.retiring && self.behind.is_none() {
            self.clear(); // `into` holds its own reference.
        }
        Ok(pts)
    }
}

impl Drop for ScrubCache {
    fn drop(&mut self) {
        self.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::timeline_walk::NextFrameTime;

    #[test]
    fn capacity_is_bounded_by_bytes_and_by_frame_count() {
        // 3420x2214 NV12 = 11.36 MB per frame -> 23 frames in 256 MiB.
        assert_eq!(capacity_for(3420, 2214, SCRUB_CACHE_BUDGET_BYTES), 23);
        assert_eq!(
            capacity_for(1920, 1080, SCRUB_CACHE_BUDGET_BYTES),
            SCRUB_CACHE_MAX_FRAMES
        );
        // 6K frames leave room for 8.
        assert_eq!(capacity_for(6016, 3384, SCRUB_CACHE_BUDGET_BYTES), 8);
        // A budget that holds a single frame cannot serve a step: disabled.
        assert_eq!(capacity_for(64, 64, 64 * 64 * 3 / 2), 0);
        assert_eq!(capacity_for(0, 64, SCRUB_CACHE_BUDGET_BYTES), 0);
    }

    fn fixture() -> String {
        format!(
            "{}/tests/fixtures/seek-eof-vfr.mp4",
            env!("CARGO_MANIFEST_DIR")
        )
    }

    unsafe fn open(budget: Option<usize>) -> crate::pipeline::Decoder {
        let gpu = crate::d3d::Gpu::create_auto(false).unwrap();
        let mut decoder = crate::pipeline::Decoder::open(&fixture(), &gpu).unwrap();
        assert!(
            decoder.decoder_path().contains("videotoolbox"),
            "fixture must take the hardware path the cache serves: {}",
            decoder.decoder_path()
        );
        if let Some(budget) = budget {
            decoder.enable_scrub_cache(budget);
        }
        decoder
    }

    /// Backward sweep in 1/90 s steps (finer than the 30 fps fixture, through its VFR hole
    /// between 0.633 s and 1.0 s), then forward hops: the cached decoder must select the
    /// same frame as a decoder without cache at every target, with far fewer keyframe seeks.
    #[test]
    fn cached_backward_steps_select_the_frames_a_keyframe_seek_selects() {
        unsafe {
            let mut cached = open(Some(SCRUB_CACHE_BUDGET_BYTES));
            let mut plain = open(None);
            let mut targets: Vec<f64> = (0..=180).rev().map(|i| i as f64 / 90.0).collect();
            targets.extend([0.5, 0.52, 0.45, 1.2, 1.1, 1.15, 0.9, 1.95, 1.9]);
            assert!(!cached.seek_to(1.98).unwrap().is_null());
            assert!(!plain.seek_to(1.98).unwrap().is_null());
            for &t in &targets {
                let a = cached.seek_to(t).unwrap();
                let b = plain.seek_to(t).unwrap();
                assert!(!a.is_null() && !b.is_null(), "no frame at {t}");
                assert_eq!(
                    cached.cur_time_sec(),
                    plain.cur_time_sec(),
                    "different frame selected for target {t}"
                );
                assert_eq!((*a).best_effort_timestamp, (*b).best_effort_timestamp);
            }
            assert!(
                cached.keyframe_seeks() * 3 < plain.keyframe_seeks(),
                "cache did not avoid keyframe seeks: {} vs {}",
                cached.keyframe_seeks(),
                plain.keyframe_seeks()
            );
        }
    }

    /// After a cache hit the decoder sits behind its newest frame. Reading on (playback or a
    /// forward scrub) must return the same contiguous frames as an uncached decoder, then
    /// continue from the stream without a gap.
    #[test]
    fn playback_after_a_cache_hit_continues_without_skipping_frames() {
        unsafe {
            let mut cached = open(Some(SCRUB_CACHE_BUDGET_BYTES));
            let mut plain = open(None);
            assert!(!cached.seek_to(0.36).unwrap().is_null());
            let seeks = cached.keyframe_seeks();
            assert!(!cached.seek_to(0.1).unwrap().is_null());
            assert_eq!(
                cached.keyframe_seeks(),
                seeks,
                "backward step was not a cache hit"
            );
            assert!(!plain.seek_to(0.1).unwrap().is_null());
            assert_eq!(cached.cur_time_sec(), plain.cur_time_sec());
            for _ in 0..30 {
                let NextFrameTime::At(next) = cached.peek_next_time_sec().unwrap() else {
                    panic!("cached decoder lost its next frame");
                };
                let expected = plain.next().unwrap();
                assert!(!expected.is_null());
                assert_eq!(next, plain.cur_time_sec());
                assert!(!cached.commit_peek().unwrap().is_null());
                assert_eq!(cached.cur_time_sec(), plain.cur_time_sec());
            }
            // A forward scrub inside the fast-path window also continues across the run.
            assert!(!cached.seek_to(1.3).unwrap().is_null());
            assert!(!plain.seek_to(1.3).unwrap().is_null());
            assert_eq!(cached.cur_time_sec(), plain.cur_time_sec());
        }
    }

    /// A superseded scrub seek stops mid-GOP without presenting; the decoder stays on a
    /// valid frame, and the newer (earlier) target is then served from the frames already
    /// decoded, identical to an uncached seek.
    #[test]
    fn superseded_seek_stops_early_and_the_newer_target_reuses_its_frames() {
        unsafe {
            let mut cached = open(Some(SCRUB_CACHE_BUDGET_BYTES));
            let mut plain = open(None);
            // Keyframes at 0.4 and 1.133 s: a seek to 1.12 decodes from 0.4 through the hole.
            assert!(!cached.seek_to(1.5).unwrap().is_null());
            let stop_after = |decoded: f64| decoded >= 0.5;
            assert!(cached.seek_to_unless(1.12, &stop_after).unwrap().is_none());
            assert!(cached.cur_time_sec() >= 0.5 && cached.cur_time_sec() < 0.6);
            let seeks = cached.keyframe_seeks();
            let frame = cached.seek_to(0.45).unwrap();
            assert!(!frame.is_null());
            assert_eq!(
                cached.keyframe_seeks(),
                seeks,
                "newer target was not a cache hit"
            );
            assert!(!plain.seek_to(0.45).unwrap().is_null());
            assert_eq!(cached.cur_time_sec(), plain.cur_time_sec());
            // Never superseded: same result as `seek_to`.
            let never = |_: f64| false;
            let a = cached.seek_to_unless(1.12, &never).unwrap().unwrap();
            assert!(!a.is_null());
            assert!(!plain.seek_to(1.12).unwrap().is_null());
            assert_eq!(cached.cur_time_sec(), plain.cur_time_sec());
        }
    }

    /// Play right after a backward scrub step: the decoder sits behind its newest frame.
    /// Retiring the cache must still hand out those frames in order (no jump ahead), then
    /// release everything once the decoder reaches the stream again. A hard disable (pooled
    /// decoder) must instead force the next seek to start from a keyframe.
    #[test]
    fn leaving_the_paused_state_behind_the_newest_frame_never_skips_frames() {
        unsafe {
            let mut cached = open(Some(SCRUB_CACHE_BUDGET_BYTES));
            let mut plain = open(None);
            assert!(!cached.seek_to(0.36).unwrap().is_null());
            assert!(!cached.seek_to(0.1).unwrap().is_null());
            assert!(
                cached.cached_next_index().is_some(),
                "expected a cache hit behind the head"
            );
            cached.retire_scrub_cache();
            assert!(!plain.seek_to(0.1).unwrap().is_null());
            for _ in 0..12 {
                assert!(!cached.next().unwrap().is_null());
                assert!(!plain.next().unwrap().is_null());
                assert_eq!(cached.cur_time_sec(), plain.cur_time_sec());
            }
            assert_eq!(
                cached.scrub_cache_len(),
                0,
                "retired cache kept frames past the head"
            );

            let mut pooled = open(Some(SCRUB_CACHE_BUDGET_BYTES));
            assert!(!pooled.seek_to(0.36).unwrap().is_null());
            assert!(!pooled.seek_to(0.1).unwrap().is_null());
            pooled.disable_scrub_cache();
            let seeks = pooled.keyframe_seeks();
            assert!(!pooled.seek_to(0.2).unwrap().is_null());
            assert_eq!(pooled.keyframe_seeks(), seeks + 1);
            assert!(!plain.seek_to(0.2).unwrap().is_null());
            assert_eq!(pooled.cur_time_sec(), plain.cur_time_sec());
        }
    }

    /// Pausing during playback seeks while the decoder holds a lookahead frame. A forward
    /// seek must still select the first frame at or after the target, not the one after it.
    #[test]
    fn a_pending_lookahead_frame_is_not_skipped_by_a_forward_seek() {
        unsafe {
            for budget in [Some(SCRUB_CACHE_BUDGET_BYTES), None] {
                let mut decoder = open(budget);
                let mut plain = open(None);
                assert!(!decoder.seek_to(0.0).unwrap().is_null());
                let NextFrameTime::At(next) = decoder.peek_next_time_sec().unwrap() else {
                    panic!("no lookahead frame");
                };
                let target = next - 0.003;
                assert!(!decoder.seek_to(target).unwrap().is_null());
                assert!(!plain.seek_to(target).unwrap().is_null());
                assert_eq!(decoder.cur_time_sec(), next);
                assert_eq!(decoder.cur_time_sec(), plain.cur_time_sec());
                // Backward cache hit with a lookahead pending, then reading on: no gap.
                assert!(!decoder.seek_to(0.3).unwrap().is_null());
                decoder.peek_next_time_sec().unwrap();
                assert!(!decoder.seek_to(0.2).unwrap().is_null());
                assert!(!plain.seek_to(0.2).unwrap().is_null());
                for _ in 0..8 {
                    assert!(!decoder.next().unwrap().is_null());
                    assert!(!plain.next().unwrap().is_null());
                    assert_eq!(decoder.cur_time_sec(), plain.cur_time_sec());
                }
            }
        }
    }

    #[test]
    fn cache_holds_at_most_its_budget_and_misses_beyond_it() {
        unsafe {
            // 64x64 NV12 frames: a budget of four frames.
            let mut cached = open(Some(64 * 64 * 3 / 2 * 4));
            assert!(!cached.seek_to(0.36).unwrap().is_null());
            assert_eq!(cached.scrub_cache_len(), 4);
            let seeks = cached.keyframe_seeks();
            // Two frames back is inside the run (the oldest entry only proves its successor).
            assert!(!cached.seek_to(0.36 - 2.0 / 30.0).unwrap().is_null());
            assert_eq!(cached.keyframe_seeks(), seeks);
            // Eight frames back is not: a real keyframe seek, same frame as without cache.
            assert!(!cached.seek_to(0.36 - 8.0 / 30.0).unwrap().is_null());
            assert_eq!(cached.keyframe_seeks(), seeks + 1);
            assert!(cached.scrub_cache_len() <= 4);
            let mut plain = open(None);
            assert!(!plain.seek_to(0.36 - 8.0 / 30.0).unwrap().is_null());
            assert_eq!(cached.cur_time_sec(), plain.cur_time_sec());
            cached.disable_scrub_cache();
            assert_eq!(cached.scrub_cache_len(), 0);
        }
    }

    #[test]
    fn lookup_matches_the_keyframe_seek_rule() {
        let pts: VecDeque<i64> = [10, 20, 30, 70, 80].into_iter().collect();
        // Exact hit and "first frame after" a target that falls in a VFR hole.
        assert_eq!(first_at_or_after(&pts, 20.0), Some(1));
        assert_eq!(first_at_or_after(&pts, 25.0), Some(2));
        assert_eq!(first_at_or_after(&pts, 50.0), Some(3));
        // The oldest frame has no cached predecessor: an uncached frame might qualify.
        assert_eq!(first_at_or_after(&pts, 10.0), None);
        assert_eq!(first_at_or_after(&pts, 5.0), None);
        // Past the newest frame: not a backward hit.
        assert_eq!(first_at_or_after(&pts, 81.0), None);
    }
}
