#![cfg(target_os = "linux")]

use openscreen_compositor::{
    compositor::Compositor,
    config::Cfg,
    d3d::Gpu,
    pipeline::{run_composited_multi, ClipSource, ExportParams},
};
use std::path::PathBuf;

// Existing synthetic sources: a two-second screen and a 41/60-second camera.
fn fixture(name: &str) -> String {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
        .to_string_lossy()
        .into_owned()
}

fn export_frames(requested_end: f64) -> u64 {
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock")
        .as_nanos();
    let directory =
        std::env::temp_dir().join(format!("klippt-camera-tail-{}-{nonce}", std::process::id()));
    std::fs::create_dir(&directory).expect("export directory");
    let output = directory.join("render.mp4");
    let gpu = Gpu::create_auto(false).expect("Vulkan export backend");
    let comp = Compositor::new_sized(&gpu, 64, 64).expect("compositor");
    let clip = ClipSource {
        screen: fixture("seek-eof-vfr.mp4"),
        webcam: fixture("seek-eof-fragmented.mp4"),
        source_start_sec: 0.0,
        source_end_sec: requested_end,
        webcam_offset_sec: 0.0,
        has_audio: false,
        clean_microphone: None,
    };
    let params = ExportParams {
        width: 64,
        height: 64,
        fps: Some(60),
        ..ExportParams::default()
    };
    let stats = run_composited_multi(
        &[clip],
        output.to_str().expect("output path"),
        &gpu,
        &comp,
        &Cfg::c8(),
        &params,
        &mut |_| Ok(()),
    )
    .expect("render and finalize shorter-camera export");
    std::fs::remove_dir_all(directory).expect("remove test export");
    stats.frames
}

#[test]
fn shorter_camera_holds_its_last_frame_without_trimming_the_screen() {
    let frames = export_frames(2.0);
    assert_eq!(
        frames, 120,
        "camera EOF must not shorten the screen timeline"
    );
}

#[test]
fn screen_eof_still_bounds_a_request_beyond_the_screen_media() {
    let frames = export_frames(3.0);
    assert_eq!(frames, 120, "screen media remains the authoritative bound");
}
