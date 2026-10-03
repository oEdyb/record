#![cfg(any(target_os = "macos", windows))]

#[cfg(target_os = "macos")]
use openscreen_compositor::pipeline::Decoder;
use openscreen_compositor::{compositor::Compositor, config::Cfg, d3d::Gpu, live::Player};
use std::path::Path;

// Generated from FFmpeg testsrc2, 64x64, 2 seconds at 30fps, with frames 20–29
// removed by select (timestamps retained), H.264 VideoToolbox. No external media.
const VFR: &[u8] = include_bytes!("fixtures/seek-eof-vfr.mp4");

unsafe fn check_seek(path: &Path, end_target: f64, last_pts: f64, earlier: f64) {
    let gpu = Gpu::create_auto(false).unwrap();
    let comp = Compositor::new_sized(&gpu, 64, 64).unwrap();
    #[cfg(target_os = "macos")]
    {
        let mut decoder = Decoder::open(path.to_str().unwrap(), &gpu).unwrap();
        let frame = decoder.seek_to(end_target).unwrap();
        assert!(
            !frame.is_null(),
            "fresh seek inside the final frame interval returned EOF"
        );
        assert!((decoder.cur_time_sec() - last_pts).abs() < 0.0001);
        assert!((*frame).width > 0 && (*frame).height > 0);
        comp.compose_frame(frame, frame, 0.0, &Cfg::c8(), std::ptr::null(), None)
            .unwrap();

        // EOF must not unref the frame retained by the decoder, including GPU storage.
        assert!(decoder.next().unwrap().is_null());
        let retained = decoder.cur_frame();
        assert!((*retained).width > 0 && (*retained).height > 0);
        comp.compose_frame(retained, retained, 0.0, &Cfg::c8(), std::ptr::null(), None)
            .unwrap();
        for _ in 0..3 {
            let frame = decoder.seek_to(end_target).unwrap();
            assert!(!frame.is_null());
            assert!((decoder.cur_time_sec() - last_pts).abs() < 0.0001);
            comp.compose_frame(frame, frame, 0.0, &Cfg::c8(), std::ptr::null(), None)
                .unwrap();
        }

        assert!(!decoder.seek_to(0.0).unwrap().is_null());
        assert!(decoder.cur_time_sec().abs() < 0.0001);
        assert!(!decoder.seek_to(earlier).unwrap().is_null());
        let frame = decoder.seek_to(end_target).unwrap();
        assert!(!frame.is_null(), "reused forward seek returned EOF");
        assert!((decoder.cur_time_sec() - last_pts).abs() < 0.0001);
        comp.compose_frame(frame, frame, 0.0, &Cfg::c8(), std::ptr::null(), None)
            .unwrap();
    }
    let source = path.to_str().unwrap();
    let mut player = Player::open(source, source, &gpu).unwrap();
    player
        .set_active_clip(source, source, 0.0, end_target)
        .unwrap();
    assert!((player.screen_time_sec() - last_pts).abs() < 0.0001);
    assert!(player.step(&comp, &Cfg::c8(), end_target).unwrap());
    assert!(player.seek_active(earlier).unwrap());
    for _ in 0..3 {
        assert!(player.seek_active(end_target).unwrap());
        assert!((player.screen_time_sec() - last_pts).abs() < 0.0001);
        assert!(player.step(&comp, &Cfg::c8(), end_target).unwrap());
    }
    assert!(player.seek_active(0.0).unwrap());
    assert!(player.screen_time_sec().abs() < 0.0001);
}

#[test]
fn vfr_seek_keeps_last_valid_frame_at_eof() {
    let path = std::env::temp_dir().join(format!("klippt-seek-eof-{}.mp4", std::process::id()));
    std::fs::write(&path, VFR).unwrap();
    unsafe {
        check_seek(&path, 1.99, 59.0 / 30.0, 1.9);
    }
    let gpu = Gpu::create_auto(false).unwrap();
    let mut player =
        unsafe { Player::open(path.to_str().unwrap(), path.to_str().unwrap(), &gpu).unwrap() };
    unsafe {
        assert!(player.seek_active(0.7).unwrap());
        assert!(
            (player.screen_time_sec() - 1.0).abs() < 0.0001,
            "normal seek must still select first PTS at or after target"
        );
    }
    drop(player);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn real_recording_end_seek_regression() {
    let Ok(path) = std::env::var("OPENSCREEN_EOF_MEDIA") else {
        return;
    };
    unsafe {
        check_seek(Path::new(&path), 15.651, 15.616667, 15.2);
    }
}

#[test]
fn corrupt_media_does_not_produce_a_retained_frame() {
    let path = std::env::temp_dir().join(format!("klippt-seek-invalid-{}.mp4", std::process::id()));
    std::fs::write(&path, b"invalid media").unwrap();
    let gpu = Gpu::create_auto(false).unwrap();
    assert!(unsafe { Player::open(path.to_str().unwrap(), path.to_str().unwrap(), &gpu) }.is_err());
    std::fs::remove_file(path).unwrap();
}
