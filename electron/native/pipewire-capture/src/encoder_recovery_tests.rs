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
