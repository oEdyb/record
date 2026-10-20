//! Real-media export benchmark. Run explicitly on a Mac with a JSON spec:
//! `OPENSCREEN_EXPORT_BENCH=/path/spec.json cargo test -p openscreen-compositor --release \
//!   --test mac_export_bench -- --ignored --nocapture`
//! The spec names copies of recordings (never library originals), an output path, the
//! export size/fps/bitrate/codec and an optional scene JSON file, the same scene the app sends.
#![cfg(target_os = "macos")]
use openscreen_compositor::{
    compositor::Compositor,
    config,
    d3d::Gpu,
    frame_geometry::live_params_from_scene,
    pipeline::{self, ClipSource, ExportCodec, ExportParams},
    scene::Scene,
    ExportProgress,
};
use serde_json::Value;
use std::time::Instant;

fn number(value: &Value, key: &str) -> Option<f64> {
    value.get(key).and_then(Value::as_f64)
}

#[test]
#[ignore = "real-media export benchmark; competes with running exports"]
fn export_benchmark() {
    let spec_path = std::env::var("OPENSCREEN_EXPORT_BENCH").expect("OPENSCREEN_EXPORT_BENCH");
    let spec: Value = serde_json::from_str(&std::fs::read_to_string(&spec_path).unwrap()).unwrap();
    let clips: Vec<ClipSource> = spec["clips"]
        .as_array()
        .expect("clips")
        .iter()
        .map(|clip| {
            let screen = clip["screen"].as_str().unwrap().to_owned();
            ClipSource {
                webcam: clip
                    .get("webcam")
                    .and_then(Value::as_str)
                    .unwrap_or(&screen)
                    .to_owned(),
                screen,
                source_start_sec: number(clip, "start").unwrap_or(0.0),
                source_end_sec: number(clip, "end").expect("clip end"),
                webcam_offset_sec: number(clip, "webcamOffset").unwrap_or(0.0),
                has_audio: clip
                    .get("hasAudio")
                    .and_then(Value::as_bool)
                    .unwrap_or(true),
                clean_microphone: None,
            }
        })
        .collect();
    let scene = spec
        .get("scene")
        .and_then(Value::as_str)
        .map(|path| Scene::from_json(&std::fs::read_to_string(path).unwrap()).unwrap());
    let params = ExportParams {
        width: number(&spec, "width").unwrap() as u32 & !1,
        height: number(&spec, "height").unwrap() as u32 & !1,
        fps: Some(number(&spec, "fps").unwrap_or(60.0) as u32),
        codec: if spec.get("codec").and_then(Value::as_str) == Some("h265") {
            ExportCodec::H265
        } else {
            ExportCodec::H264
        },
        bitrate: number(&spec, "bitrate").map(|b| b as u32),
        normalize_audio: false,
        even_volume: false,
        ..ExportParams::default()
    };
    let out = spec["out"].as_str().expect("out").to_owned();
    let _ = std::fs::remove_file(&out);
    let gpu = Gpu::create_auto(false).unwrap();
    let mut cfg = config::all().pop().unwrap();
    cfg.zoom = false;
    cfg.layout_anim = false;
    cfg.mblur_n = 1;
    if let Some(scene) = &scene {
        cfg.bg_blur = scene.effects.blur;
        cfg.cursor = scene.cursor.show;
    } else {
        cfg.cursor = false;
    }
    let comp = Compositor::new_sized(&gpu, params.width, params.height).unwrap();
    if let Some(scene) = &scene {
        comp.set_live_params(live_params_from_scene(scene));
    }
    comp.set_scene(scene);
    let timer = Instant::now();
    let (mut video_done, mut audio_done) = (0.0, 0.0);
    let stats =
        pipeline::run_composited_multi(&clips, &out, &gpu, &comp, &cfg, &params, &mut |p| {
            match p {
                ExportProgress::VideoFlushed(_) => video_done = timer.elapsed().as_secs_f64(),
                ExportProgress::AudioFlushed(_) => audio_done = timer.elapsed().as_secs_f64(),
                _ => {}
            }
            Ok(())
        })
        .unwrap();
    let wall = timer.elapsed().as_secs_f64();
    eprintln!(
        "BENCH phases: video_s={video_done:.2} audio_s={:.2} trailer_s={:.2}",
        audio_done - video_done,
        wall - audio_done
    );
    let bytes = std::fs::metadata(&out).unwrap().len();
    eprintln!(
        "BENCH export: {}x{}@{} frames={} video_s={:.2} wall_s={wall:.2} fps={:.1} realtime={:.2}x bytes={bytes} mbps={:.2} decoder={} compositor={} encoder={} hardware={} fallback={}",
        params.width,
        params.height,
        params.fps.unwrap(),
        stats.frames,
        stats.video_duration_s,
        stats.frames as f64 / wall,
        stats.video_duration_s / wall,
        bytes as f64 * 8.0 / stats.video_duration_s / 1e6,
        stats.decoder_path,
        stats.compositor_backend,
        stats.encoder_name,
        stats.encoder_hardware,
        stats.encoder_fallback,
    );
}
