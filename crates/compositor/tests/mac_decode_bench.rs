//! Run explicitly on a Mac. All modes run sequentially because selection uses env vars.
#![cfg(target_os = "macos")]
use openscreen_compositor::{
    compositor::Compositor,
    config::Cfg,
    d3d::Gpu,
    ffi,
    pipeline::{self, ClipSource, Decoder, ExportCodec, ExportParams},
};
use std::{
    ffi::c_void,
    hash::{DefaultHasher, Hasher},
    path::PathBuf,
    time::Instant,
};
#[link(name = "CoreVideo", kind = "framework")]
extern "C" {
    fn CVPixelBufferLockBaseAddress(pb: *mut c_void, flags: u64) -> i32;
    fn CVPixelBufferUnlockBaseAddress(pb: *mut c_void, flags: u64) -> i32;
    fn CVPixelBufferGetBaseAddressOfPlane(pb: *mut c_void, plane: usize) -> *const u8;
    fn CVPixelBufferGetBytesPerRowOfPlane(pb: *mut c_void, plane: usize) -> usize;
    fn CVPixelBufferGetWidthOfPlane(pb: *mut c_void, plane: usize) -> usize;
    fn CVPixelBufferGetHeightOfPlane(pb: *mut c_void, plane: usize) -> usize;
    fn CVPixelBufferGetPixelFormatType(pb: *mut c_void) -> u32;
}
unsafe fn hashes(frame: *mut ffi::AVFrame) -> [u64; 2] {
    assert_eq!(
        (*frame).format,
        ffi::AVPixelFormat::AV_PIX_FMT_VIDEOTOOLBOX as i32
    );
    let pb = (*frame).data[3].cast();
    assert!(!(*frame).data[3].is_null());
    assert_eq!(
        CVPixelBufferGetPixelFormatType(pb),
        u32::from_be_bytes(*b"420v")
    );
    assert_eq!(CVPixelBufferLockBaseAddress(pb, 1), 0);
    let result = std::array::from_fn(|plane| {
        let mut hash = DefaultHasher::new();
        let base = CVPixelBufferGetBaseAddressOfPlane(pb, plane);
        let stride = CVPixelBufferGetBytesPerRowOfPlane(pb, plane);
        let width = CVPixelBufferGetWidthOfPlane(pb, plane) * (plane + 1);
        assert!(!base.is_null() && stride >= width);
        for row in 0..CVPixelBufferGetHeightOfPlane(pb, plane) {
            hash.write(std::slice::from_raw_parts(base.add(row * stride), width));
        }
        hash.finish()
    });
    assert_eq!(CVPixelBufferUnlockBaseAddress(pb, 1), 0);
    result
}
struct EnvRestore(Vec<(&'static str, Option<std::ffi::OsString>)>);
impl Drop for EnvRestore {
    fn drop(&mut self) {
        for (key, value) in &self.0 {
            match value {
                Some(v) => std::env::set_var(key, v),
                None => std::env::remove_var(key),
            }
        }
    }
}
fn setting(key: &str, default: f64) -> f64 {
    std::env::var(key)
        .map(|v| v.parse().expect("numeric bench setting"))
        .unwrap_or(default)
}
#[test]
#[ignore = "real-media decode and export benchmark; competes with running exports"]
fn compare_async_videotoolbox() {
    let _restore = EnvRestore(
        ["OPENSCREEN_MAC_DECODE", "OPENSCREEN_VT_INFLIGHT"]
            .into_iter()
            .map(|k| (k, std::env::var_os(k)))
            .collect(),
    );
    let source = std::env::var("OPENSCREEN_BENCH_SOURCE").unwrap_or_else(|_| "/Users/olle/Library/Application Support/openscreen/recordings/recording-1789125415066-clip-0001.mp4".into());
    let start = setting("OPENSCREEN_BENCH_START", 100.0);
    let end = setting("OPENSCREEN_BENCH_END", 120.0);
    assert!(start.is_finite() && end.is_finite() && start >= 0.0 && end > start);
    let out_dir = PathBuf::from("/private/tmp/claude-501/-Users-olle-dev-screenrec/9d6411ec-97b1-4fa7-8f72-828c0027731f/scratchpad/bench-out");
    std::fs::create_dir_all(&out_dir).unwrap();
    let gpu = Gpu::create_auto(false).unwrap();
    let mut reference = None;
    let mut reference_hashes = None;
    eprintln!("BENCH noisy: a concurrent Klippt export may compete for hardware; source={source}, slice={start}..{end}");
    for (mode, inflight) in [
        ("ffmpeg-videotoolbox", 4),
        ("videotoolbox", 2),
        ("videotoolbox", 4),
        ("videotoolbox", 8),
        ("videotoolbox", 16),
    ] {
        std::env::set_var("OPENSCREEN_MAC_DECODE", mode);
        std::env::set_var("OPENSCREEN_VT_INFLIGHT", inflight.to_string());
        let label = if mode == "videotoolbox" {
            format!("videotoolbox-async(inflight={inflight})")
        } else {
            mode.into()
        };
        let timer = Instant::now();
        let mut decoder = Decoder::open(&source, &gpu).unwrap();
        let mut pts = Vec::new();
        unsafe {
            let mut frame = decoder.seek_to(start).unwrap();
            while !frame.is_null() && decoder.cur_time_sec() < end {
                pts.push((*frame).best_effort_timestamp);
                frame = decoder.next().unwrap();
            }
        }
        let wall = timer.elapsed().as_secs_f64();
        assert!(!pts.is_empty());
        assert!(
            pts.windows(2).all(|w| w[0] <= w[1]),
            "non-monotonic PTS: {label}"
        );
        eprintln!(
            "BENCH decode {label}: frames={} wall_s={wall:.6} fps={:.3}",
            pts.len(),
            pts.len() as f64 / wall
        );
        if let Some(expected) = &reference {
            assert_eq!(&pts, expected, "PTS identity: {label}");
        } else {
            reference = Some(pts);
        }
        // Separate pass: hashing must not pollute the decode-only throughput measurement.
        let mut content = Vec::new();
        unsafe {
            let mut frame = decoder.seek_to(start).unwrap();
            while !frame.is_null() && decoder.cur_time_sec() < end && content.len() < 60 {
                content.push(hashes(frame));
                frame = decoder.next().unwrap();
            }
        }
        assert_eq!(
            content.len(),
            60,
            "benchmark slice must contain at least 60 frames"
        );
        if let Some(expected) = &reference_hashes {
            assert_eq!(&content, expected, "Y/UV identity: {label}");
        } else {
            reference_hashes = Some(content);
        }
        drop(decoder);
        let params = ExportParams {
            width: 1920,
            height: 1080,
            fps: Some(30),
            codec: ExportCodec::H264,
            bitrate: None,
            normalize_audio: false,
            even_volume: false,
            target_lufs: openscreen_compositor::audio::DEFAULT_TARGET_LUFS,
            peak_ceiling_dbtp: openscreen_compositor::audio::DEFAULT_TRUE_PEAK_CEILING_DBTP,
        };
        let comp = Compositor::new_sized(&gpu, params.width, params.height).unwrap();
        let clip = ClipSource {
            screen: source.clone(),
            webcam: source.clone(),
            source_start_sec: start,
            source_end_sec: end,
            webcam_offset_sec: 0.0,
            has_audio: false,
            clean_microphone: None,
        };
        let out = out_dir.join(format!("{mode}-{inflight}.mp4"));
        let timer = Instant::now();
        let stats = pipeline::run_composited_multi(
            &[clip],
            out.to_str().unwrap(),
            &gpu,
            &comp,
            &Cfg::c8(),
            &params,
            &mut |_| Ok(()),
        )
        .unwrap();
        let wall = timer.elapsed().as_secs_f64();
        eprintln!(
            "BENCH export {label}: frames={} wall_s={wall:.6} fps={:.3} decoder={} encoder={}",
            stats.frames,
            stats.frames as f64 / wall,
            stats.decoder_path,
            stats.encoder_name
        );
        assert_eq!(
            stats.decoder_path, label,
            "requested decoder must actually run"
        );
        assert_eq!(stats.frames, ((end - start) * 30.0).round() as u64);
        assert_eq!(
            pipeline::probe_frame_count(out.to_str().unwrap()).unwrap(),
            stats.frames
        );
    }
    eprintln!("BENCH identity: all frame PTS and first 60 Y/UV hashes match across all five paths");
}
