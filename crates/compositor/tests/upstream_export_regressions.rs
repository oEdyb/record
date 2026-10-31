#![cfg(target_os = "macos")]

use openscreen_compositor::{
    compositor::Compositor,
    config::Cfg,
    d3d::Gpu,
    pipeline::{self, ClipSource, ExportParams},
};

#[test]
fn missing_screen_or_camera_fails_instead_of_omitting_the_clip() {
    let gpu = Gpu::create(false).expect("Metal");
    let comp = Compositor::new_sized(&gpu, 64, 64).expect("compositor");
    let source = format!(
        "{}/tests/fixtures/seek-eof-vfr.mp4",
        env!("CARGO_MANIFEST_DIR")
    );
    for camera in [false, true] {
        let output = std::env::temp_dir().join(format!(
            "klippt-missing-{}-{camera}.mp4",
            std::process::id()
        ));
        let missing = format!("{}.missing", source);
        let clip = ClipSource {
            screen: if camera {
                source.clone()
            } else {
                missing.clone()
            },
            webcam: if camera { missing } else { String::new() },
            source_start_sec: 0.0,
            source_end_sec: 2.0,
            webcam_offset_sec: 0.0,
            has_audio: false,
            clean_microphone: None,
        };
        let params = ExportParams {
            width: 64,
            height: 64,
            fps: Some(30),
            ..Default::default()
        };
        let result = pipeline::run_composited_multi(
            &[clip],
            &output.to_string_lossy(),
            &gpu,
            &comp,
            &Cfg::c8(),
            &params,
            &mut |_| Ok(()),
        );
        let error = result.err().expect("missing source must abort export");
        let message = format!("{error:#}");
        assert!(message.contains("clip 1"), "{message}");
        assert!(
            message.contains(if camera { "camera" } else { "screen" }),
            "{message}"
        );
        if output.exists() {
            std::fs::remove_file(output).unwrap();
        }
    }
}
