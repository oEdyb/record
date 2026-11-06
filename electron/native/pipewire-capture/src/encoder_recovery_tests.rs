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

const KILL_TEST_OUTPUT: &str = "KLIPPT_KILL_TEST_OUTPUT";
const KILL_TEST_STALLED_AUDIO: &str = "KLIPPT_KILL_TEST_STALLED_AUDIO";
const KILL_TEST_SECONDS: i64 = 8;
const KILL_TEST_FPS: i64 = 30;

/// Runs in a child process: writes a take through the real encoders and muxer,
/// reports that it has done so, then waits for the parent to kill it.
#[test]
#[ignore = "child of the SIGKILL tests; it never exits on its own"]
fn take_that_waits_to_be_killed() {
    let output = std::path::PathBuf::from(std::env::var_os(KILL_TEST_OUTPUT).expect("output path"));
    let stalled = std::env::var_os(KILL_TEST_STALLED_AUDIO).is_some();
    let mut video = VideoEncoder::open(
        VideoParams {
            width: 320,
            height: 240,
            fps: KILL_TEST_FPS as i32,
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

    let frame = [0, 0, 255, 255].repeat(320 * 240);
    let stereo_samples_per_frame = (48_000 * 2 / KILL_TEST_FPS) as usize;
    let tone: Vec<f32> = (0..stereo_samples_per_frame)
        .map(|index| (index as f32 * 0.03).sin() * 0.3)
        .collect();
    for pts in 0..KILL_TEST_FPS * KILL_TEST_SECONDS {
        if !stalled || pts < KILL_TEST_FPS / 4 {
            audio
                .push(&tone, |packet| muxer.write(audio_track, packet))
                .expect("audio");
        }
        video
            .submit(&frame, 320 * 4, ff::AV_PIX_FMT_BGRA, pts, |packet| {
                muxer.write(video_track, packet)
            })
            .expect("encode");
    }
    std::fs::write(output.with_extension("written"), b"").expect("marker");
    loop {
        std::thread::sleep(std::time::Duration::from_secs(60));
    }
}

/// Starts a real take in a child process, sends it SIGKILL and counts the screen
/// frames ffprobe can still read from the file left behind.
fn screen_frames_after_sigkill(name: &str, stalled_audio: bool) -> i64 {
    let output =
        std::env::temp_dir().join(format!("klippt-kill-{name}-{}.mp4", std::process::id()));
    let marker = output.with_extension("written");
    let mut command = std::process::Command::new(std::env::current_exe().expect("test binary"));
    command
        .args([
            "--exact",
            "encoder::recovery_tests::take_that_waits_to_be_killed",
            "--ignored",
        ])
        .env(KILL_TEST_OUTPUT, &output)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    if stalled_audio {
        command.env(KILL_TEST_STALLED_AUDIO, "1");
    }
    let mut child = command.spawn().expect("start take");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(120);
    while !marker.exists() {
        assert!(std::time::Instant::now() < deadline, "take never finished");
        assert!(child.try_wait().expect("poll take").is_none(), "take died");
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    child.kill().expect("SIGKILL");
    child.wait().expect("reap");

    let probe = std::process::Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-count_frames",
            "-show_entries",
            "stream=nb_read_frames",
            "-of",
            "csv=p=0",
        ])
        .arg(&output)
        .output()
        .expect("ffprobe");
    let frames = String::from_utf8_lossy(&probe.stdout)
        .trim()
        .trim_end_matches(',')
        .parse()
        .unwrap_or(0);
    std::fs::remove_file(&output).expect("remove owned test output");
    std::fs::remove_file(&marker).expect("remove owned test marker");
    frames
}

#[test]
fn sigkill_with_a_stalled_microphone_keeps_all_but_the_last_seconds_of_screen() {
    let frames = screen_frames_after_sigkill("stalled", true);
    eprintln!("stalled audio: {frames} of 240 screen frames readable after SIGKILL");
    assert!(frames >= KILL_TEST_FPS * 6, "{frames} of 240 screen frames");
}

#[test]
fn sigkill_with_healthy_audio_keeps_all_but_the_last_seconds_of_screen() {
    let frames = screen_frames_after_sigkill("healthy", false);
    eprintln!("healthy audio: {frames} of 240 screen frames readable after SIGKILL");
    assert!(frames >= KILL_TEST_FPS * 6, "{frames} of 240 screen frames");
}

#[test]
fn illegal_encoder_and_mux_moves_preserve_every_completed_track() {
    let output =
        std::env::temp_dir().join(format!("klippt-codec-lifecycle-{}.mp4", std::process::id()));
    let mut video = VideoEncoder::open(
        VideoParams {
            width: 160,
            height: 120,
            fps: 30,
            bitrate: 500_000,
        },
        Some(Backend::Software),
        |_, _| {},
    )
    .expect("software encoder");
    let mut audio = AudioEncoder::open(96_000).expect("AAC encoder");
    let mut muxer = Muxer::create(&output).expect("muxer");
    let video_track = muxer
        .add_stream(video.codec_context())
        .expect("video track");
    let audio_track = muxer
        .add_stream(audio.codec_context())
        .expect("audio track");
    muxer.write_header().expect("header");
    assert!(
        muxer.write_header().is_err(),
        "duplicate header must reject before libavformat"
    );
    assert!(muxer.add_stream(video.codec_context()).is_err());
    let pixels = [20, 40, 180, 255].repeat(160 * 120);
    for pts in 0..15 {
        video
            .submit(&pixels, 160 * 4, ff::AV_PIX_FMT_BGRA, pts, |packet| {
                muxer.write(video_track, packet)
            })
            .expect("video frame");
    }
    audio
        .push(&vec![0.0; 24_000 * AUDIO_CHANNELS], |packet| {
            muxer.write(audio_track, packet)
        })
        .expect("audio samples");
    audio
        .finish(|packet| muxer.write(audio_track, packet))
        .expect("audio drain");
    video
        .finish(|packet| muxer.write(video_track, packet))
        .expect("video drain");
    assert!(video.stage(&pixels, 160 * 4, ff::AV_PIX_FMT_BGRA).is_err());
    assert!(video
        .encode_staged(15, |_| panic!("finished video emitted a packet"))
        .is_err());
    assert!(audio
        .push(&[0.0; AUDIO_CHANNELS], |_| panic!(
            "finished audio accepted input"
        ))
        .is_err());
    video
        .finish(|_| panic!("duplicate video drain emitted a packet"))
        .expect("idempotent completed drain");
    audio
        .finish(|_| panic!("duplicate audio drain emitted a packet"))
        .expect("idempotent completed drain");
    muxer.finish().expect("trailer");
    let probe = std::process::Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-count_frames",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=nb_read_frames",
            "-of",
            "default=nokey=1:noprint_wrappers=1",
        ])
        .arg(&output)
        .output()
        .expect("count all video frames");
    assert!(
        probe.status.success(),
        "{}",
        String::from_utf8_lossy(&probe.stderr)
    );
    assert_eq!(String::from_utf8_lossy(&probe.stdout).trim(), "15");
    let tracks = std::process::Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-show_entries",
            "stream=codec_type",
            "-of",
            "csv=p=0",
        ])
        .arg(&output)
        .output()
        .expect("inspect all tracks");
    assert!(tracks.status.success());
    let track_types = String::from_utf8_lossy(&tracks.stdout);
    assert!(track_types.lines().any(|line| line == "video"));
    assert!(track_types.lines().any(|line| line == "audio"));
    let decoded = std::process::Command::new("ffmpeg")
        .args(["-nostdin", "-v", "error", "-xerror", "-threads", "1", "-i"])
        .arg(&output)
        .args(["-map", "0", "-f", "null", "-"])
        .output()
        .expect("fully decode both completed tracks");
    assert!(
        decoded.status.success(),
        "{}",
        String::from_utf8_lossy(&decoded.stderr)
    );
    let _ = std::fs::remove_file(output);
}

#[test]
fn an_interrupted_aac_drain_can_still_deliver_its_remaining_packets() {
    let mut audio = AudioEncoder::open(96_000).expect("AAC encoder");
    audio
        .push(&vec![0.0; 512 * AUDIO_CHANNELS], |_| Ok(()))
        .expect("partial audio block");
    let failed = audio.finish(|_| Err("injected packet sink failure".to_owned()));
    assert!(failed.is_err());
    assert!(audio.push(&[0.0; AUDIO_CHANNELS], |_| Ok(())).is_err());
    let mut retained = 0;
    audio
        .finish(|_| {
            retained += 1;
            Ok(())
        })
        .expect("retry must drain remaining packets");
    assert!(
        retained > 0,
        "a failed drain must not become a falsely completed drain"
    );
}
