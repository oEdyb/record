use super::*;

#[test]
fn recording_is_readable_before_the_writer_closes() {
    let output = std::env::temp_dir().join(format!("klippt-fragments-{}.mp4", std::process::id()));
    let mut encoder = VideoEncoder::open(
        VideoParams {
            width: 320,
            height: 240,
            fps: 30,
            bitrate: 1_000_000,
        },
        Some(Backend::Software),
        |_, _| {},
    )
    .expect("software encoder");
    let mut muxer = Muxer::create(&output).expect("muxer");
    let track = muxer.add_stream(encoder.codec_context()).expect("track");
    muxer.write_header().expect("header");
    let frame = [0, 0, 255, 255].repeat(320 * 240);
    for pts in 0..90 {
        encoder
            .submit(&frame, 320 * 4, ff::AV_PIX_FMT_BGRA, pts, |packet| {
                muxer.write(track, packet)
            })
            .expect("encode");
    }
    let bytes = std::fs::read(&output).expect("read live output");
    assert!(
        bytes.windows(4).any(|tag| tag == b"moov"),
        "live file needs its track index"
    );
    assert!(
        bytes.windows(4).any(|tag| tag == b"moof"),
        "live file needs readable media fragments"
    );
    let probe = std::process::Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=codec_name,color_range,color_space,color_transfer,color_primaries",
            "-of",
            "json",
        ])
        .arg(&output)
        .output()
        .expect("ffprobe");
    assert!(
        probe.status.success(),
        "{}",
        String::from_utf8_lossy(&probe.stderr)
    );
    let media: serde_json::Value = serde_json::from_slice(&probe.stdout).expect("probe JSON");
    let stream = &media["streams"][0];
    assert_eq!(stream["codec_name"], "h264");
    assert_eq!(stream["color_range"], "tv");
    for field in ["color_space", "color_transfer", "color_primaries"] {
        assert_eq!(stream[field], "bt709", "{field}");
    }
    encoder
        .finish(|packet| muxer.write(track, packet))
        .expect("flush");
    muxer.finish().expect("finish");
    let decoded = std::process::Command::new("ffmpeg")
        .args(["-v", "error", "-i"])
        .arg(&output)
        .args([
            "-frames:v",
            "1",
            "-pix_fmt",
            "yuv420p",
            "-f",
            "rawvideo",
            "-",
        ])
        .output()
        .expect("decode RGB conversion");
    assert!(
        decoded.status.success(),
        "{}",
        String::from_utf8_lossy(&decoded.stderr)
    );
    assert_eq!(decoded.stdout.len(), 320 * 240 * 3 / 2);
    // Full-range red maps to limited-range BT.709 (63, 102, 240).
    // BT.601 would produce luma near 81 despite the BT.709 container tags.
    for (offset, expected) in [
        (160 * 320 + 160, 63u8),
        (320 * 240 + 80 * 160 + 80, 102),
        (320 * 240 * 5 / 4 + 80 * 160 + 80, 240),
    ] {
        assert!(
            decoded.stdout[offset].abs_diff(expected) <= 3,
            "converted component at {offset}: {}",
            decoded.stdout[offset]
        );
    }
    std::fs::remove_file(output).expect("remove owned test output");
}

/// A microphone that goes quiet without an error (unplugged, stalled graph) stops
/// the mix producing AAC packets. By default libavformat's interleaver then holds
/// up to ten seconds of encoded screen frames in memory waiting for that track,
/// so a helper crash loses them all rather than the last fragment.
#[test]
fn a_stalled_audio_track_does_not_hold_screen_frames_back_from_disk() {
    const FPS: i64 = 30;
    let output = std::env::temp_dir().join(format!("klippt-stalled-{}.mp4", std::process::id()));
    let mut video = VideoEncoder::open(
        VideoParams {
            width: 320,
            height: 240,
            fps: FPS as i32,
            bitrate: 1_000_000,
        },
        Some(Backend::Software),
        |_, _| {},
    )
    .expect("software encoder");
    let mut audio = AudioEncoder::open(128_000).expect("audio encoder");
    let mut muxer = Muxer::create(&output).expect("muxer");
    let video_track = muxer.add_stream(video.codec_context()).expect("video");
    let audio_track = muxer.add_stream(audio.codec_context()).expect("audio");
    muxer.write_header().expect("header");

    let tone: Vec<f32> = (0..48_000 * 2)
        .map(|index| (index as f32 * 0.03).sin() * 0.3)
        .collect();
    let frame = [0, 0, 255, 255].repeat(320 * 240);
    // A quarter second of sound, then the source goes silent for six seconds of
    // screen. Real time does not matter: libavformat compares timestamps.
    audio
        .push(&tone[..24_000], |packet| muxer.write(audio_track, packet))
        .expect("audio before the stall");
    for pts in 0..FPS * 6 {
        video
            .submit(&frame, 320 * 4, ff::AV_PIX_FMT_BGRA, pts, |packet| {
                muxer.write(video_track, packet)
            })
            .expect("encode");
    }

    let probe = std::process::Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-count_packets",
            "-show_entries",
            "stream=nb_read_packets",
            "-of",
            "csv=p=0",
        ])
        .arg(&output)
        .output()
        .expect("ffprobe");
    let on_disk: i64 = String::from_utf8_lossy(&probe.stdout)
        .trim()
        .trim_end_matches(',')
        .parse()
        .unwrap_or(0);
    assert!(
        on_disk >= FPS * 4,
        "a crash now would lose {} of {} screen frames",
        FPS * 6 - on_disk,
        FPS * 6
    );

    // The source returns. Audio older than the screen already on disk must still
    // land in the file: it is positioned by timestamp, not by file order.
    audio
        .push(&tone[24_000..], |packet| muxer.write(audio_track, packet))
        .expect("audio after the stall");
    audio
        .finish(|packet| muxer.write(audio_track, packet))
        .expect("audio flush");
    video
        .finish(|packet| muxer.write(video_track, packet))
        .expect("video flush");
    muxer.finish().expect("trailer");
    let decoded = std::process::Command::new("ffmpeg")
        .args(["-v", "error", "-i"])
        .arg(&output)
        .args(["-map", "0:a:0", "-f", "f32le", "-acodec", "pcm_f32le", "-"])
        .output()
        .expect("decode audio");
    assert!(
        decoded.status.success() && decoded.stderr.is_empty(),
        "{}",
        String::from_utf8_lossy(&decoded.stderr)
    );
    // Two seconds of stereo f32, give or take the AAC priming and final padding.
    assert!(
        decoded.stdout.len() >= 48_000 * 2 * 4,
        "audio after the stall was lost: {} bytes",
        decoded.stdout.len()
    );
    std::fs::remove_file(output).expect("remove owned test output");
}
