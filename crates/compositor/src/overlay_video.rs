use crate::d3d::Gpu;
use crate::ffi::AVFrame;
use crate::pipeline::Decoder;
use crate::scene::{Scene, SceneVideoOverlay, VideoOverlayFit, VideoOverlayRect};
use crate::timeline_walk::{frame_step, FrameStep, NextFrameTime};
use anyhow::{ensure, Result};
use std::collections::{HashMap, HashSet};
use std::time::Instant;

pub(crate) fn timing_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| std::env::var_os("OPENSCREEN_COMPOSE_TIMING").is_some())
}

#[derive(Debug, Clone)]
pub struct ActiveOverlay {
    pub id: String,
    pub rect: Option<VideoOverlayRect>,
    pub fit: VideoOverlayFit,
    pub opacity: f32,
}

fn active_overlay(scene: &Scene, source_t_sec: f64) -> Option<&SceneVideoOverlay> {
    scene
        .video_overlays
        .iter()
        .filter(|region| {
            region
                .clip_index
                .is_none_or(|index| index == scene.active_clip_index)
                && region.start_sec <= source_t_sec
                && source_t_sec < region.end_sec
        })
        .max_by(|a, b| a.start_sec.total_cmp(&b.start_sec))
}

fn overlay_time(region: &SceneVideoOverlay, source_t_sec: f64) -> f64 {
    region.source_offset_sec + (source_t_sec - region.start_sec)
}

fn needs_seek(current: Option<f64>, next: NextFrameTime, target: f64) -> bool {
    match current {
        None => true,
        Some(current) if target < current => true,
        Some(current) => {
            target - current > 1.0 && frame_step(next, 0.0, target) == FrameStep::Commit
        }
    }
}

unsafe fn position_overlay(
    decoder: &mut Decoder,
    fresh: bool,
    target: f64,
) -> Result<*const AVFrame> {
    ensure!(target.is_finite(), "invalid overlay source time");
    let target = target.max(0.0);
    let current = (!fresh && !decoder.cur_frame().is_null()).then(|| decoder.cur_time_sec());
    let next = if current.is_some() {
        decoder.peek_next_time_sec()?
    } else {
        NextFrameTime::Unknown
    };
    if needs_seek(current, next, target) {
        // seek_to returns the first PTS >= its target; back off for VFR hold.
        let seek_target = decoder
            .available_duration_sec()
            .filter(|t| t.is_finite() && *t > 0.0)
            .map_or(target, |duration| target.min(duration));
        let mut lookback = 1.0;
        loop {
            let anchor = (seek_target - lookback).max(0.0);
            if !fresh
                && decoder.cur_time_sec() <= target
                && (decoder.cur_time_sec() - anchor).abs() < 1.0 / decoder.fps().max(1.0)
            {
                break;
            }
            ensure!(
                !decoder.seek_to(anchor)?.is_null(),
                "overlay has no video frame"
            );
            if decoder.cur_time_sec() <= target || anchor == 0.0 {
                break;
            }
            lookback *= 2.0;
        }
    }
    loop {
        let next = decoder.peek_next_time_sec()?;
        match frame_step(next, 0.0, target) {
            FrameStep::Commit => {
                ensure!(
                    !decoder.commit_peek()?.is_null(),
                    "overlay decode returned no frame"
                );
            }
            FrameStep::CommitAndStop => {
                ensure!(
                    !decoder.commit_peek()?.is_null(),
                    "overlay decode returned no frame"
                );
                break;
            }
            FrameStep::Hold => break,
        }
    }
    let frame = decoder.cur_frame();
    ensure!(!frame.is_null(), "overlay has no video frame");
    Ok(frame)
}

#[derive(Clone, Debug, PartialEq)]
struct OverlayKey {
    clip_index: usize,
    id: String,
    path: String,
    start: f64,
    end: f64,
    offset: f64,
}

impl OverlayKey {
    fn new(region: &SceneVideoOverlay, clip_index: usize) -> Self {
        Self {
            clip_index,
            id: region.id.clone(),
            path: region.path.clone(),
            start: region.start_sec,
            end: region.end_sec,
            offset: region.source_offset_sec,
        }
    }
}

struct PendingOverlay {
    key: OverlayKey,
    target: f64,
    worker: std::thread::JoinHandle<Result<Decoder>>,
}

fn next_overlay(scene: &Scene, index: usize, now: f64, lead: f64) -> Option<(OverlayKey, f64)> {
    let mut remaining_lead = lead;
    for clip_index in index..scene.clips.len() {
        let clip = &scene.clips[clip_index];
        let from = if clip_index == index {
            now
        } else {
            clip.source_start_sec
        };
        let until = clip.source_end_sec.min(from + remaining_lead);
        let at = |time: f64| {
            scene
                .video_overlays
                .iter()
                .filter(|r| {
                    r.clip_index.is_none_or(|i| i == clip_index)
                        && r.start_sec <= time
                        && time < r.end_sec
                })
                .max_by(|a, b| a.start_sec.total_cmp(&b.start_sec))
        };
        let current = if clip_index == index { at(from) } else { None };
        let mut events = vec![from];
        for region in &scene.video_overlays {
            if region.clip_index.is_none_or(|i| i == clip_index) {
                events.extend([region.start_sec, region.end_sec]);
            }
        }
        events.sort_by(f64::total_cmp);
        for time in events {
            if time < from || time > until || time >= clip.source_end_sec {
                continue;
            }
            let Some(region) = at(time) else {
                continue;
            };
            if current.is_some_and(|r| std::ptr::eq(r, region)) {
                continue;
            }
            return Some((
                OverlayKey::new(region, clip_index),
                overlay_time(region, time).max(0.0),
            ));
        }
        remaining_lead -= (clip.source_end_sec - from).max(0.0);
        if remaining_lead <= 0.0 {
            break;
        }
    }
    None
}

#[derive(Default)]
pub(crate) struct OverlayDecoders {
    decs: HashMap<String, Decoder>,
    failed: HashSet<String>,
    live: bool,
    active: Option<OverlayKey>,
    pending: Option<PendingOverlay>,
}

impl OverlayDecoders {
    pub(crate) fn live() -> Self {
        Self {
            live: true,
            ..Self::default()
        }
    }

    pub(crate) fn prepare_ahead(
        &mut self,
        scene: &Scene,
        index: usize,
        now: f64,
        lead: f64,
        gpu: &Gpu,
    ) {
        let next = next_overlay(scene, index, now, lead);
        if let Some(pending) = &self.pending {
            let still_needed = next
                .as_ref()
                .is_some_and(|(key, target)| *key == pending.key && *target == pending.target)
                || (pending.key.clip_index == index
                    && pending.key.start <= now
                    && now < pending.key.end
                    && self.active.as_ref() != Some(&pending.key)
                    && scene
                        .video_overlays
                        .iter()
                        .any(|r| OverlayKey::new(r, index) == pending.key));
            if still_needed || !pending.worker.is_finished() {
                return;
            }
            self.pending = None;
        }
        let Some((key, target)) = next else {
            return;
        };
        if self.failed.contains(&key.path) {
            return;
        }
        let gpu = Gpu {
            device: gpu.device.clone(),
            context: gpu.context.clone(),
            feature_level: gpu.feature_level,
            backend: gpu.backend,
        };
        let path = key.path.clone();
        let worker = std::thread::spawn(move || {
            let started = Instant::now();
            let result = (|| unsafe {
                let mut decoder = Decoder::open(&path, &gpu)?;
                position_overlay(&mut decoder, true, target)?;
                Ok(decoder)
            })();
            if timing_enabled() {
                eprintln!(
                    "[overlay-preload] target={target:.6} ms={:.3} ok={}",
                    started.elapsed().as_secs_f64() * 1000.0,
                    result.is_ok()
                );
            }
            result
        });
        self.pending = Some(PendingOverlay {
            key,
            target,
            worker,
        });
    }

    fn adopt_prepared(&mut self, key: &OverlayKey, target: f64) {
        if self.active.as_ref() == Some(key) {
            return;
        }
        let ready = self.pending.as_ref().is_some_and(|p| {
            p.key == *key && p.target <= target && target - p.target < 1.0 && p.worker.is_finished()
        });
        if ready {
            if let Some(pending) = self.pending.take() {
                match pending.worker.join() {
                    Ok(Ok(decoder)) => {
                        self.decs.insert(key.path.clone(), decoder);
                        if timing_enabled() {
                            eprintln!("[overlay-adopt] id={} target={target:.6}", key.id);
                        }
                    }
                    Ok(Err(error)) => {
                        eprintln!("[video-overlay] preparation failed: {error:#}");
                    }
                    Err(_) => {
                        eprintln!("[video-overlay] preparation worker panicked");
                    }
                }
            }
        }
        self.active = Some(key.clone());
    }

    pub(crate) unsafe fn frame_at(
        &mut self,
        scene: Option<&Scene>,
        source_t_sec: f64,
        gpu: &Gpu,
    ) -> Result<(*const AVFrame, Option<ActiveOverlay>)> {
        let active = scene.and_then(|scene| active_overlay(scene, source_t_sec));
        self.decs.retain(|path, _| {
            if self.live {
                return active.is_some_and(|r| r.path == *path);
            }
            scene.is_some_and(|scene| {
                scene
                    .video_overlays
                    .iter()
                    .any(|region| region.path == *path)
            })
        });
        let Some(region) = active else {
            self.active = None;
            return Ok((std::ptr::null(), None));
        };
        if self.failed.contains(&region.path) {
            return Ok((std::ptr::null(), None));
        }
        let target = overlay_time(region, source_t_sec);
        let started = Instant::now();
        if self.live {
            self.adopt_prepared(
                &OverlayKey::new(region, scene.map_or(0, |s| s.active_clip_index)),
                target,
            );
        }
        let mut open_ms = 0.0;
        let mut position_ms = 0.0;
        let result = (|| -> Result<*const AVFrame> {
            ensure!(target.is_finite(), "invalid overlay source time");
            let fresh = !self.decs.contains_key(&region.path);
            if fresh {
                let opened = Instant::now();
                self.decs
                    .insert(region.path.clone(), Decoder::open(&region.path, gpu)?);
                open_ms = opened.elapsed().as_secs_f64() * 1000.0;
            }
            let decoder = self
                .decs
                .get_mut(&region.path)
                .ok_or_else(|| anyhow::anyhow!("overlay decoder unavailable"))?;
            let positioning = Instant::now();
            let frame = position_overlay(decoder, fresh, target)?;
            position_ms = positioning.elapsed().as_secs_f64() * 1000.0;
            Ok(frame)
        })();
        if timing_enabled() {
            eprintln!("[overlay-timing] id={} source={source_t_sec:.6} target={target:.6} open_ms={open_ms:.3} position_ms={position_ms:.3} total_ms={:.3}", region.id, started.elapsed().as_secs_f64() * 1000.0);
        }
        match result {
            Ok(frame) => Ok((
                frame,
                Some(ActiveOverlay {
                    id: region.id.clone(),
                    rect: region.rect,
                    fit: region.fit,
                    opacity: region.opacity.clamp(0.0, 1.0),
                }),
            )),
            Err(error) => {
                eprintln!("[video-overlay] {} ({}): {error:#}", region.id, region.path);
                self.failed.insert(region.path.clone());
                self.decs.remove(&region.path);
                Ok((std::ptr::null(), None))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scene() -> Scene {
        Scene::from_json(r##"{
            "clips":[],
            "layout":{"preset":"no-webcam","webcamSize":1,"webcamShape":"rectangle","webcamMirror":false,"webcamPosition":null,"webcamReactiveZoom":false},
            "effects":{"padding":0,"blur":false,"shadow":0,"roundnessFrac":0,"motionBlur":0},
            "background":{"kind":"color","color":"#000000"},"zoomRegions":[],
            "cursor":{"show":false,"size":1,"smoothing":0,"motionBlur":0,"clickBounce":0,"clipToBounds":false,"theme":"default"},
            "cropByClip":[],"output":{"width":128,"height":128,"fps":30}
        }"##).unwrap()
    }

    fn region(id: &str, start: f64, end: f64, clip_index: Option<usize>) -> SceneVideoOverlay {
        SceneVideoOverlay {
            id: id.into(),
            clip_index,
            start_sec: start,
            end_sec: end,
            path: "/broll.mp4".into(),
            source_offset_sec: 4.0,
            fit: VideoOverlayFit::Cover,
            rect: None,
            opacity: 1.0,
        }
    }

    fn clip(start: f64, end: f64) -> crate::scene::SceneClip {
        crate::scene::SceneClip {
            screen_path: String::new(),
            webcam_path: String::new(),
            source_start_sec: start,
            source_end_sec: end,
            webcam_offset_sec: 0.0,
            has_audio: false,
        }
    }

    #[test]
    fn preparation_selects_next_visible_region_and_resumed_overlap() {
        let mut scene = scene();
        scene.clips = vec![clip(0.0, 20.0)];
        scene.video_overlays = vec![
            region("old", 2.0, 15.0, None),
            region("new", 5.0, 8.0, None),
        ];
        assert!(next_overlay(&scene, 0, 0.0, 1.5).is_none());
        let (key, target) = next_overlay(&scene, 0, 1.0, 1.5).unwrap();
        assert_eq!((key.id.as_str(), target), ("old", 4.0));
        assert_eq!(next_overlay(&scene, 0, 4.0, 1.5).unwrap().0.id, "new");
        let (key, target) = next_overlay(&scene, 0, 7.0, 1.5).unwrap();
        assert_eq!((key.id.as_str(), target), ("old", 10.0));
    }

    #[test]
    fn preparation_crosses_trimmed_clip_start_with_correct_offset_and_identity() {
        let mut scene = scene();
        scene.clips = vec![clip(0.0, 10.0), clip(30.0, 35.0)];
        scene.video_overlays = vec![region("next", 28.0, 34.0, Some(1))];
        assert!(next_overlay(&scene, 0, 8.0, 1.5).is_none());
        let (key, target) = next_overlay(&scene, 0, 9.0, 1.5).unwrap();
        assert_eq!(key.clip_index, 1);
        assert_eq!(target, 6.0);
        assert!(next_overlay(&scene, 1, 34.0, 1.5).is_none());
        let mut changed = scene.video_overlays[0].clone();
        changed.source_offset_sec += 1.0;
        assert_ne!(key, OverlayKey::new(&changed, 1));
        assert_ne!(key, OverlayKey::new(&scene.video_overlays[0], 0));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn live_preparation_preserves_frame_selection_warm_decoder_and_bounded_retention() {
        let gpu = Gpu::create_auto(false).unwrap();
        let mut scene = scene();
        scene.clips = vec![clip(0.0, 10.0)];
        let mut overlay = region("prepared", 1.0, 8.0, Some(0));
        overlay.path = format!(
            "{}/tests/fixtures/seek-eof-vfr.mp4",
            env!("CARGO_MANIFEST_DIR")
        );
        overlay.source_offset_sec = 0.5;
        scene.video_overlays.push(overlay);
        let mut live = OverlayDecoders::live();
        let mut sync = OverlayDecoders::default();
        live.prepare_ahead(&scene, 0, 0.0, 1.5, &gpu);
        let deadline = Instant::now() + std::time::Duration::from_secs(10);
        while !live.pending.as_ref().unwrap().worker.is_finished() {
            assert!(Instant::now() < deadline);
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
        for time in [1.0, 1.3, 2.0, 5.0, 1.1] {
            unsafe {
                let (frame, _) = live.frame_at(Some(&scene), time, &gpu).unwrap();
                assert!(!frame.is_null());
                sync.frame_at(Some(&scene), time, &gpu).unwrap();
            }
            assert!(live.pending.is_none());
            assert_eq!(live.decs.len(), 1);
            let path = &scene.video_overlays[0].path;
            assert_eq!(unsafe { live.decs[path].cur_time_sec() }, unsafe {
                sync.decs[path].cur_time_sec()
            });
        }
        scene.video_overlays.clear();
        unsafe {
            live.frame_at(Some(&scene), 6.0, &gpu).unwrap();
        }
        assert!(live.decs.is_empty());
        assert!(live.active.is_none());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn stale_running_preparation_cannot_spawn_more_workers_or_replace_active_decoder() {
        let gpu = Gpu::create_auto(false).unwrap();
        let mut scene = scene();
        scene.clips = vec![clip(0.0, 10.0)];
        scene.video_overlays = vec![region("new", 1.0, 8.0, Some(0))];
        let (release, wait) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            wait.recv().unwrap();
            anyhow::bail!("cancelled fixture")
        });
        let thread_id = worker.thread().id();
        let mut live = OverlayDecoders::live();
        live.pending = Some(PendingOverlay {
            key: OverlayKey::new(&region("stale", 1.0, 8.0, Some(0)), 0),
            target: 4.0,
            worker,
        });
        for _ in 0..10 {
            live.prepare_ahead(&scene, 0, 0.0, 1.5, &gpu);
            assert_eq!(
                live.pending.as_ref().unwrap().worker.thread().id(),
                thread_id
            );
        }
        let key = OverlayKey::new(&scene.video_overlays[0], 0);
        live.adopt_prepared(&key, 4.0);
        assert!(live.decs.is_empty());
        release.send(()).unwrap();
        let deadline = Instant::now() + std::time::Duration::from_secs(10);
        while !live.pending.as_ref().unwrap().worker.is_finished() {
            assert!(Instant::now() < deadline);
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
        scene.video_overlays.clear();
        live.prepare_ahead(&scene, 0, 0.0, 1.5, &gpu);
        assert!(live.pending.is_none());
    }

    #[test]
    fn old_scenes_default_to_no_video_overlays() {
        assert!(scene().video_overlays.is_empty());
    }

    #[test]
    fn sparse_future_frame_and_eof_hold_without_discarding_lookahead() {
        assert!(!needs_seek(Some(0.0), NextFrameTime::At(5.0), 1.1));
        assert!(!needs_seek(Some(0.0), NextFrameTime::At(5.0), 1.2));
        assert!(!needs_seek(Some(2.0), NextFrameTime::Eof, 90.0));
        assert!(!needs_seek(Some(0.0), NextFrameTime::Unknown, 90.0));
        assert!(needs_seek(Some(0.0), NextFrameTime::At(1.0), 5.0));
        assert!(needs_seek(Some(5.0), NextFrameTime::At(6.0), 2.0));
        assert!(needs_seek(None, NextFrameTime::Unknown, 0.0));
    }

    #[test]
    fn parses_fixed_json_contract_including_rect_and_clip_index() {
        let overlay: SceneVideoOverlay = serde_json::from_str(
            r#"{
            "id":"vo_1","clipIndex":3,"startSec":12,"endSec":18.5,
            "path":"/broll.mp4","sourceOffsetSec":4,"fit":"contain",
            "rect":{"x":0.1,"y":0.2,"w":0.5,"h":0.6},"opacity":0.7
        }"#,
        )
        .unwrap();
        assert_eq!(overlay.clip_index, Some(3));
        assert_eq!(overlay.fit, VideoOverlayFit::Contain);
        assert_eq!(overlay.rect.unwrap().w, 0.5);
        assert_eq!(overlay.source_offset_sec, 4.0);
        assert_eq!(overlay.opacity, 0.7);
    }

    #[test]
    fn active_interval_includes_start_and_excludes_end() {
        let mut scene = scene();
        scene.video_overlays = vec![region("a", 12.0, 18.5, None)];
        assert!(active_overlay(&scene, 11.99).is_none());
        assert_eq!(active_overlay(&scene, 12.0).unwrap().id, "a");
        assert!(active_overlay(&scene, 18.5).is_none());
    }

    #[test]
    fn latest_start_wins_independent_of_array_order() {
        let mut scene = scene();
        scene.video_overlays = vec![
            region("new", 14.0, 16.0, None),
            region("old", 12.0, 18.5, None),
        ];
        assert_eq!(active_overlay(&scene, 15.0).unwrap().id, "new");
        assert_eq!(active_overlay(&scene, 16.0).unwrap().id, "old");
    }

    #[test]
    fn overlay_clock_is_source_offset_plus_clip_source_elapsed() {
        let overlay = region("a", 12.0, 18.5, None);
        assert_eq!(overlay_time(&overlay, 12.0), 4.0);
        assert_eq!(overlay_time(&overlay, 15.25), 7.25);
        assert_eq!(overlay_time(&overlay, 13.0), 5.0);
    }

    #[test]
    fn clip_window_filters_identity_and_overlap_without_rebasing_time() {
        let mut scene = scene();
        scene.video_overlays = vec![
            region("other-clip", 12.0, 18.0, Some(0)),
            region("owned", 12.0, 18.0, Some(3)),
            region("legacy", 11.0, 19.0, None),
            region("ends-at-start", 8.0, 12.0, Some(3)),
            region("starts-at-end", 18.0, 20.0, Some(3)),
        ];
        let clip = scene.for_clip_window(3, 12.0, 18.0);
        assert_eq!(
            clip.video_overlays
                .iter()
                .map(|r| r.id.as_str())
                .collect::<Vec<_>>(),
            ["owned", "legacy"]
        );
        assert_eq!(
            overlay_time(active_overlay(&clip, 13.0).unwrap(), 13.0),
            5.0
        );
        assert_eq!(scene.video_overlays.len(), 5);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn decoder_holds_vfr_and_eof_seeks_back_and_evicts_removed_paths() {
        let gpu = Gpu::create_auto(false).unwrap();
        let mut scene = scene();
        let mut overlay = region("vfr", 0.0, 100.0, None);
        overlay.path = format!(
            "{}/tests/fixtures/seek-eof-vfr.mp4",
            env!("CARGO_MANIFEST_DIR")
        );
        overlay.source_offset_sec = 0.0;
        let path = overlay.path.clone();
        scene.video_overlays.push(overlay);
        let mut decoders = OverlayDecoders::default();
        unsafe {
            for (target, expected) in [
                (0.0, 0.0),
                (0.7, 19.0 / 30.0),
                (1.5, 1.5),
                (4.0, 59.0 / 30.0),
                (8.0, 59.0 / 30.0),
                (0.5, 0.5),
            ] {
                let (frame, active) = decoders.frame_at(Some(&scene), target, &gpu).unwrap();
                assert!(!frame.is_null());
                assert_eq!(active.unwrap().id, "vfr");
                assert!(
                    (decoders.decs[&path].cur_time_sec() - expected).abs() < 0.001,
                    "target {target}"
                );
            }
            scene.video_overlays.clear();
            assert!(decoders
                .frame_at(Some(&scene), 0.0, &gpu)
                .unwrap()
                .0
                .is_null());
            assert!(decoders.decs.is_empty());
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn missing_overlay_is_cached_as_failed_and_does_not_abort() {
        let gpu = Gpu::create_auto(false).unwrap();
        let mut scene = scene();
        scene
            .video_overlays
            .push(region("missing", 0.0, 10.0, None));
        let mut decoders = OverlayDecoders::default();
        for _ in 0..3 {
            let (frame, active) = unsafe { decoders.frame_at(Some(&scene), 2.0, &gpu).unwrap() };
            assert!(frame.is_null() && active.is_none());
            assert_eq!(decoders.failed.len(), 1);
            assert!(decoders.decs.is_empty());
        }
    }
}
