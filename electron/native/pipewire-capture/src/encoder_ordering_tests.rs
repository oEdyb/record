use crate::encoder::{AudioEncoder, Backend, Muxer, VideoEncoder, VideoParams};
use crate::ffmpeg as ff;
use std::path::{Path, PathBuf};
use std::process::Command;

fn output(name: &str) -> PathBuf {
    {
        let directory = std::env::var_os("TMPDIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                PathBuf::from(std::env::var_os("HOME").expect("home"))
                    .join(".cache/klippt-work/native-tests")
            });
        std::fs::create_dir_all(&directory).expect("native test cache");
        directory.join(format!("encoder-{name}-{}.mp4", std::process::id()))
    }
}

fn video() -> VideoEncoder {
    VideoEncoder::open(
        VideoParams {
            width: 160,
            height: 120,
            fps: 30,
            bitrate: 500_000,
        },
        Some(Backend::Software),
        |_, _| {},
    )
    .expect("software video encoder")
}

fn decode_audio(path: &Path) -> Vec<u8> {
    let decoded = Command::new("ffmpeg")
        .args(["-nostdin", "-v", "error", "-xerror", "-threads", "1", "-i"])
        .arg(path)
        .args(["-map", "0:a:0", "-acodec", "pcm_f32le", "-f", "f32le", "-"])
        .output()
        .expect("decode complete AAC track");
    assert!(
        decoded.status.success() && decoded.stderr.is_empty(),
        "{}: {}",
        path.display(),
        String::from_utf8_lossy(&decoded.stderr)
    );
    decoded.stdout
}

fn count_video(path: &Path) -> i64 {
    let probe = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-count_frames",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=nb_read_frames",
            "-of",
            "csv=p=0",
        ])
        .arg(path)
        .output()
        .expect("count all video frames");
    assert!(
        probe.status.success() && probe.stderr.is_empty(),
        "{probe:?}"
    );
    String::from_utf8(probe.stdout)
        .unwrap()
        .trim()
        .trim_end_matches(',')
        .parse()
        .unwrap()
}

fn tone(samples: usize) -> Vec<f32> {
    (0..samples)
        .flat_map(|index| {
            let value = (index as f32 * 0.07).sin() * 0.2;
            [value, -value]
        })
        .collect()
}

#[test]
fn packet_before_header_is_rejected_without_consuming_the_picture() {
    let path = output("premature-packet");
    let mut encoder = video();
    let mut muxer = Muxer::create(&path).unwrap();
    let track = muxer.add_stream(encoder.codec_context()).unwrap();
    let frame = [20, 40, 180, 255].repeat(160 * 120);
    assert!(!encoder.has_staged_frame());
    assert!(encoder
        .encode_staged(0, |_| panic!("empty encoder emitted data"))
        .is_err());
    assert!(encoder
        .stage(&frame[..10], 160 * 4, ff::AV_PIX_FMT_BGRA)
        .is_err());
    assert!(!encoder.has_staged_frame());
    encoder
        .submit(&frame, 160 * 4, ff::AV_PIX_FMT_BGRA, 0, |packet| {
            let before = unsafe { ((*packet).pts, (*packet).dts, (*packet).size) };
            let error = muxer.write(track, packet).expect_err("header is absent");
            assert!(error.contains("Configured"), "{error}");
            assert_eq!(
                unsafe { ((*packet).pts, (*packet).dts, (*packet).size) },
                before
            );
            muxer.write_header()?;
            muxer.write(track, packet)
        })
        .unwrap();
    assert!(encoder
        .stage(&frame[..10], 160 * 4, ff::AV_PIX_FMT_BGRA)
        .is_err());
    assert!(encoder.has_staged_frame());
    encoder
        .encode_staged(1, |packet| muxer.write(track, packet))
        .unwrap();
    encoder.finish(|packet| muxer.write(track, packet)).unwrap();
    muxer.finish().unwrap();
    assert_eq!(count_video(&path), 2);
    eprintln!("row11 premature packet: 2/2 pictures fully decoded");
}

fn audio_drain(name: &str, drain_failures: usize) -> Vec<u8> {
    let path = output(name);
    let mut encoder = AudioEncoder::open(96_000).unwrap();
    let mut muxer = Muxer::create(&path).unwrap();
    let track = muxer.add_stream(encoder.codec_context()).unwrap();
    muxer.write_header().unwrap();
    encoder
        .push(&tone(4_608), |packet| muxer.write(track, packet))
        .unwrap();
    for _ in 0..drain_failures {
        let mut delivered = 0;
        let result = encoder.finish(|packet| {
            muxer.write(track, packet)?;
            delivered += 1;
            Err("sink error after accepting the packet".to_owned())
        });
        assert!(result.is_err(), "injected drain error not reached");
        assert_eq!(delivered, 1);
        assert!(encoder
            .push(&[], |_| panic!("interrupted drain reopened"))
            .is_err());
    }
    encoder.finish(|packet| muxer.write(track, packet)).unwrap();
    encoder
        .finish(|_| panic!("completed drain emitted duplicate packets"))
        .unwrap();
    muxer.finish().unwrap();
    decode_audio(&path)
}

#[test]
fn aac_retries_after_padding_and_null_drain_match_uninterrupted_decode() {
    let clean = audio_drain("aac-clean", 0);
    let interrupted = audio_drain("aac-two-interruptions", 2);
    assert!(!clean.is_empty());
    assert_eq!(
        interrupted, clean,
        "a retry lost or duplicated decoded audio"
    );
    eprintln!(
        "row11 AAC drain retries: {} decoded bytes identical",
        clean.len()
    );
}

fn audio_with_mux_failure(name: &str, inject: bool, destructor: bool) -> Vec<u8> {
    let path = output(name);
    let mut encoder = AudioEncoder::open(96_000).unwrap();
    let mut muxer = Muxer::create(&path).unwrap();
    let track = muxer.add_stream(encoder.codec_context()).unwrap();
    muxer.write_header().unwrap();
    let mut injected = false;
    encoder
        .push(&tone(4_608), |packet| {
            if inject && !injected {
                unsafe {
                    let mut invalid = ff::av_packet_clone(packet);
                    assert!(!invalid.is_null());
                    (*invalid).pts = (*invalid).dts - 1;
                    let rejected = muxer.write(track, invalid);
                    ff::av_packet_free(&mut invalid);
                    let error = rejected.expect_err("actual FFmpeg must reject pts < dts");
                    assert!(error.contains("av_interleaved_write_frame"), "{error}");
                    eprintln!("row11 injected actual FFmpeg mux failure: {error}");
                }
                injected = true;
            }
            muxer.write(track, packet)
        })
        .unwrap();
    assert_eq!(injected, inject);
    let mut flushed = 0;
    encoder
        .finish(|packet| {
            flushed += 1;
            muxer.write(track, packet)
        })
        .unwrap();
    assert!(
        flushed > 0,
        "test did not exercise draining after a mux failure"
    );
    if destructor {
        drop(muxer);
    } else {
        muxer.finish().unwrap();
    }
    let decoded = decode_audio(&path);
    eprintln!(
        "row11 {name}: {flushed} drain packets, {} decoded bytes",
        decoded.len()
    );
    decoded
}

#[test]
fn actual_mux_error_still_writes_every_queued_aac_packet_on_finish() {
    let clean = audio_with_mux_failure("mux-clean", false, false);
    let recovered = audio_with_mux_failure("mux-error-finish", true, false);
    assert_eq!(
        recovered, clean,
        "a mux write error blocked or damaged later AAC packets"
    );
}

#[test]
fn actual_mux_error_still_finalizes_every_queued_aac_packet_on_drop() {
    let clean = audio_with_mux_failure("mux-clean-drop", false, true);
    let recovered = audio_with_mux_failure("mux-error-drop", true, true);
    assert_eq!(recovered, clean, "destructor or repair removed valid audio");
}

#[test]
fn empty_encoders_finish_once_and_reject_late_input() {
    let mut video = video();
    video
        .finish(|_| panic!("empty video emitted a packet"))
        .unwrap();
    video.finish(|_| panic!("empty video redrained")).unwrap();
    assert!(!video.has_staged_frame());
    let frame = [20, 40, 180, 255].repeat(160 * 120);
    assert!(video.stage(&frame, 160 * 4, ff::AV_PIX_FMT_BGRA).is_err());
    assert!(video.encode_staged(0, |_| Ok(())).is_err());
    let mut audio = AudioEncoder::open(96_000).unwrap();
    audio.finish(|_| Ok(())).unwrap();
    audio.finish(|_| panic!("empty audio redrained")).unwrap();
    assert!(audio.push(&tone(128), |_| Ok(())).is_err());
    let path = output("no-stream");
    assert!(Muxer::create(&path).unwrap().finish().is_err());
}
