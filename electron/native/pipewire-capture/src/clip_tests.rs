use super::*;
use crate::request::Request;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

static NEXT: AtomicUsize = AtomicUsize::new(0);
struct Fixture {
    directory: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let directory = std::env::temp_dir().join(format!(
            "klippt-clips-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&directory).expect("test directory");
        Self { directory }
    }
    fn request(&self) -> Request {
        serde_json::from_value(serde_json::json!({
            "outputs": { "screenPath": self.directory.join("recording-clip-0001.mp4") },
            "cursor": { "mode": "system" }, "video": { "fps": 30, "bitrate": 1000000 }
        }))
        .expect("request")
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.directory).expect("clean test directory");
    }
}
fn frame() -> shim::Frame {
    shim::Frame {
        pixels: vec![0x40; 320 * 240 * 4],
        stride: 320 * 4,
        width: 320,
        height: 240,
        video_format: shim::constants().video_format_bgrx,
        pts_ns: -1,
        crop: shim::CropRect {
            x: 0,
            y: 0,
            width: 320,
            height: 240,
        },
        has_crop: true,
    }
}
fn values(bytes: &[u8]) -> Vec<serde_json::Value> {
    String::from_utf8_lossy(bytes)
        .lines()
        .map(|line| serde_json::from_str(line).expect("NDJSON"))
        .collect()
}
fn decode(path: &str) -> Vec<f32> {
    let output = std::process::Command::new("ffmpeg")
        .args([
            "-v",
            "error",
            "-i",
            path,
            "-map",
            "0:a:0",
            "-f",
            "f32le",
            "-acodec",
            "pcm_f32le",
            "-",
        ])
        .output()
        .expect("ffmpeg decode");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    output
        .stdout
        .chunks_exact(4)
        .map(|bytes| f32::from_le_bytes(bytes.try_into().expect("sample")))
        .collect()
}
fn tone(frames: usize) -> Vec<f32> {
    (0..frames)
        .flat_map(|index| {
            let sample = (index as f32 * 440.0 * std::f32::consts::TAU / 48000.0).sin() * 0.3;
            [sample, sample]
        })
        .collect()
}
fn assert_video(path: &str) {
    let output = std::process::Command::new("ffmpeg")
        .args([
            "-v", "error", "-i", path, "-map", "0:v:0", "-f", "null", "-",
        ])
        .output()
        .expect("ffmpeg video decode");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn static_source_continue_creates_a_second_readable_clip_after_encoded_ack() {
    let fixture = Fixture::new();
    let mut clips = Clips::new(fixture.request(), Vec::new(), Some(Backend::Software));
    let mut bytes = Vec::new();
    let mut emitter = Emitter::new(&mut bytes, false);
    clips.connected();
    clips.frame(frame(), &mut emitter).expect("first frame");
    std::thread::sleep(Duration::from_millis(100));
    clips.pause(&mut emitter).expect("pause");
    let first_duration = clips.completed[0].duration_ms;
    std::thread::sleep(Duration::from_millis(120));
    clips.resume(&mut emitter).expect("cached resume");
    assert_eq!(
        clips
            .writer
            .as_ref()
            .expect("second writer")
            .encoded_frames(),
        1
    );
    clips.stop(&mut emitter).expect("stop");
    assert!(first_duration >= 100);
    assert_eq!(clips.completed.len(), 2);
    assert!(
        clips.completed[1].duration_ms < 100,
        "paused time must not enter the new clip"
    );
    for clip in &clips.completed {
        assert_video(&clip.screen_video_path);
    }
    let events = values(&bytes);
    assert_eq!(
        events
            .iter()
            .filter(|value| value["event"] == "recording-started")
            .count(),
        1
    );
    let start = events
        .iter()
        .find(|value| value["event"] == "recording-started")
        .expect("start");
    assert_eq!(
        start["captureBounds"],
        serde_json::json!({ "x":0, "y":0, "width":320, "height":240 })
    );
    let names: Vec<_> = events
        .iter()
        .map(|event| event["event"].as_str().unwrap())
        .collect();
    assert!(names
        .windows(3)
        .any(|part| part == ["clip-finalizing", "clip-finalized", "recording-paused"]));
    let resume = events
        .iter()
        .find(|value| value["event"] == "recording-resumed")
        .expect("resume");
    assert_eq!(resume["clipIndex"], 1);
    assert_eq!(
        events.last().expect("stop")["clips"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}

#[test]
fn source_audio_is_readable_unboosted_and_paused_pcm_never_enters_the_next_clip() {
    let fixture = Fixture::new();
    let ring = Arc::new(shim::AudioRing::new(2, 48000, 2));
    let source = AudioSource {
        label: "microphone",
        ring: ring.clone(),
        gain: 0.0,
        bitrate: 128000,
    };
    let mut clips = Clips::new(fixture.request(), vec![source], Some(Backend::Software));
    let mut bytes = Vec::new();
    let mut emitter = Emitter::new(&mut bytes, false);
    clips.frame(frame(), &mut emitter).expect("start");
    std::thread::sleep(Duration::from_millis(140));
    ring.push_for_test(&tone(4800));
    clips.advance(&mut emitter).expect("audio");
    clips.pause(&mut emitter).expect("pause");
    assert!(
        Arc::ptr_eq(&clips.audio[0].ring, &ring),
        "capture retains the original ring"
    );
    ring.push_for_test(&tone(48000));
    clips.advance(&mut emitter).expect("discard paused audio");
    clips.resume(&mut emitter).expect("resume cached source");
    ring.push_for_test(&tone(4800));
    clips.advance(&mut emitter).expect("second audio");
    clips.stop(&mut emitter).expect("stop");
    for clip in &clips.completed {
        let original = decode(clip.microphone_audio_path.as_deref().expect("source path"));
        assert!(
            original.len() < 16000,
            "one second of paused audio leaked into the clip"
        );
        assert!(
            original.iter().any(|sample| sample.abs() > 0.15),
            "zero gain must not attenuate the original"
        );
        let mix = decode(&clip.screen_video_path);
        assert!(
            mix.iter().all(|sample| sample.abs() < 0.001),
            "compatibility mix honors microphone mute"
        );
    }
    assert!(clips.completed[0].microphone_audio_offset_ms.unwrap() >= 30.0);
    assert!(clips.completed[1].microphone_audio_offset_ms.unwrap() < 30.0);
    let events = values(&bytes);
    assert_eq!(
        events
            .iter()
            .filter(|value| value["event"] == "original-started")
            .count(),
        2
    );
}

#[test]
fn missing_source_prevents_clip_commit_but_finalizes_the_screen_file() {
    let fixture = Fixture::new();
    let ring = Arc::new(shim::AudioRing::new(2, 48000, 2));
    let mut clips = Clips::new(
        fixture.request(),
        vec![AudioSource {
            label: "system",
            ring,
            gain: 1.0,
            bitrate: 128000,
        }],
        Some(Backend::Software),
    );
    let mut bytes = Vec::new();
    let mut emitter = Emitter::new(&mut bytes, false);
    clips.frame(frame(), &mut emitter).expect("start");
    assert!(clips.pause(&mut emitter).is_err());
    assert!(clips.completed.is_empty());
    assert!(!values(&bytes)
        .iter()
        .any(|value| value["event"] == "clip-finalized" || value["event"] == "recording-paused"));
    assert_video(
        fixture
            .directory
            .join("recording-clip-0001.mp4")
            .to_str()
            .unwrap(),
    );
}

#[test]
fn a_prepared_writer_and_buffered_pcm_are_insufficient_for_audio_readiness() {
    let fixture = Fixture::new();
    let mut writer = crate::originals::OriginalWriter::open(
        &fixture.directory.join("capture.mp4"),
        "system",
        128000,
    )
    .expect("open");
    assert!(!writer.started());
    writer
        .push(&[0.1, 0.1], 200.0)
        .expect("buffer partial AAC block");
    assert!(
        !writer.started(),
        "PCM buffering has not appended an AAC packet"
    );
    writer.push(&tone(4096), 300.0).expect("append AAC packets");
    assert!(writer.started());
    let start = writer.take_started().expect("original appended");
    assert!(
        start.offset_ms > 190.0,
        "offset follows the first PCM, not the later packet emission"
    );
    assert!(writer.take_started().is_none());
    writer.finish().expect("finalize");
}

#[test]
fn first_frame_timeout_is_bounded_and_not_applied_to_static_active_sources() {
    let fixture = Fixture::new();
    let mut clips = Clips::new(fixture.request(), Vec::new(), Some(Backend::Software));
    let mut emitter = Emitter::new(Vec::new(), false);
    clips.awaiting_since = Some(Instant::now() - Duration::from_secs(9));
    assert!(clips
        .advance(&mut emitter)
        .unwrap_err()
        .contains("eight seconds"));
    clips.frame(frame(), &mut emitter).expect("valid frame");
    clips.awaiting_since = Some(Instant::now() - Duration::from_secs(9));
    clips
        .advance(&mut emitter)
        .expect("static frame remains valid");
    clips.stop(&mut emitter).expect("stop");
}

#[test]
fn a_failed_first_frame_never_acknowledges_recording() {
    let fixture = Fixture::new();
    let mut clips = Clips::new(fixture.request(), Vec::new(), Some(Backend::Software));
    let mut invalid = frame();
    invalid.video_format = u32::MAX;
    let mut bytes = Vec::new();
    assert!(clips
        .frame(invalid, &mut Emitter::new(&mut bytes, false))
        .is_err());
    assert!(!values(&bytes)
        .iter()
        .any(|value| value["event"] == "recording-started"));
}

#[test]
fn legacy_output_path_keeps_one_file_across_pause_and_resume() {
    let fixture = Fixture::new();
    let path = fixture.directory.join("legacy.mp4");
    let request =
        serde_json::from_value(serde_json::json!({ "outputPath": path })).expect("legacy request");
    let mut clips = Clips::new(request, Vec::new(), Some(Backend::Software));
    let mut bytes = Vec::new();
    let mut emitter = Emitter::new(&mut bytes, false);
    clips.frame(frame(), &mut emitter).expect("start");
    clips.pause(&mut emitter).expect("pause");
    std::thread::sleep(Duration::from_millis(100));
    clips.resume(&mut emitter).expect("resume");
    clips.stop(&mut emitter).expect("stop");
    assert_eq!(clips.completed.len(), 1);
    assert_eq!(clips.completed[0].screen_video_path, path.to_str().unwrap());
    assert!(clips.completed[0].duration_ms < 100);
    assert_video(path.to_str().unwrap());
}

#[test]
fn paths_follow_mac_conventions_without_doubling_the_clip_suffix() {
    assert_eq!(
        clip_path(Path::new("/tmp/capture-clip-0001.mp4"), 1),
        PathBuf::from("/tmp/capture-clip-0002.mp4")
    );
    assert_eq!(
        clip_path(Path::new("/tmp/capture"), 0),
        PathBuf::from("/tmp/capture-clip-0001.mp4")
    );
}

#[test]
fn both_audio_sources_get_independent_originals_and_their_own_first_sample_offsets() {
    let fixture = Fixture::new();
    let system = Arc::new(shim::AudioRing::new(2, 48000, 2));
    let microphone = Arc::new(shim::AudioRing::new(2, 48000, 2));
    let mut clips = Clips::new(
        fixture.request(),
        vec![
            AudioSource {
                label: "system",
                ring: system.clone(),
                gain: 1.0,
                bitrate: 128000,
            },
            AudioSource {
                label: "microphone",
                ring: microphone.clone(),
                gain: 1.0,
                bitrate: 128000,
            },
        ],
        Some(Backend::Software),
    );
    let mut bytes = Vec::new();
    let mut emitter = Emitter::new(&mut bytes, false);
    clips.frame(frame(), &mut emitter).expect("screen");
    std::thread::sleep(Duration::from_millis(60));
    system.push_for_test(&tone(2400));
    clips.advance(&mut emitter).expect("system starts first");
    std::thread::sleep(Duration::from_millis(120));
    microphone.push_for_test(&tone(2400));
    clips.advance(&mut emitter).expect("microphone joins later");
    clips.stop(&mut emitter).expect("finalize every source");
    let clip = &clips.completed[0];
    assert!(clip.microphone_audio_offset_ms.unwrap() > clip.system_audio_offset_ms.unwrap() + 80.0);
    for path in [
        clip.system_audio_path.as_deref().unwrap(),
        clip.microphone_audio_path.as_deref().unwrap(),
        &clip.screen_video_path,
    ] {
        assert!(decode(path).iter().any(|sample| sample.abs() > 0.1));
    }
    assert_eq!(
        values(&bytes)
            .iter()
            .filter(|event| event["event"] == "original-started")
            .count(),
        2
    );
}

#[test]
fn sub_aac_block_source_fails_the_readiness_deadline_after_screen_started() {
    let fixture = Fixture::new();
    let ring = Arc::new(shim::AudioRing::new(2, 48000, 2));
    let mut clips = Clips::new(
        fixture.request(),
        vec![AudioSource {
            label: "system",
            ring: ring.clone(),
            gain: 1.0,
            bitrate: 128000,
        }],
        Some(Backend::Software),
    );
    let mut bytes = Vec::new();
    let mut emitter = Emitter::new(&mut bytes, false);
    clips.frame(frame(), &mut emitter).expect("screen frame");
    ring.push_for_test(&[0.1, 0.1]);
    clips
        .advance(&mut emitter)
        .expect("buffering PCM is allowed while waiting");
    std::thread::sleep(Duration::from_millis(2050));
    assert!(clips
        .advance(&mut emitter)
        .unwrap_err()
        .contains("two seconds"));
    assert!(values(&bytes)
        .iter()
        .any(|event| event["event"] == "recording-started"));
    assert!(!values(&bytes)
        .iter()
        .any(|event| event["event"] == "original-started"));
}

#[test]
fn a_terminal_writer_failure_preserves_committed_clips_without_committing_the_failed_clip() {
    let fixture = Fixture::new();
    let mut clips = Clips::new(fixture.request(), Vec::new(), Some(Backend::Software));
    let mut bytes = Vec::new();
    let mut emitter = Emitter::new(&mut bytes, false);
    clips.frame(frame(), &mut emitter).expect("first clip");
    clips.pause(&mut emitter).expect("first commit");
    clips.resume(&mut emitter).expect("next clip");
    clips.fail("source disconnected");
    assert!(clips.stop(&mut emitter).is_err());
    assert_eq!(clips.completed.len(), 1);
    let events = values(&bytes);
    let stopped = events.last().unwrap();
    assert_eq!(stopped["event"], "recording-stopped");
    assert_eq!(stopped["clips"].as_array().unwrap().len(), 1);
    assert_eq!(stopped["warning"]["message"], "source disconnected");
    assert_video(
        fixture
            .directory
            .join("recording-clip-0002.mp4")
            .to_str()
            .unwrap(),
    );
}

#[test]
fn pause_then_stop_never_reopens_or_mutates_the_committed_clip() {
    let fixture = Fixture::new();
    let mut clips = Clips::new(fixture.request(), Vec::new(), Some(Backend::Software));
    let mut emitter = Emitter::new(Vec::new(), false);
    clips.frame(frame(), &mut emitter).expect("clip");
    clips.pause(&mut emitter).expect("pause");
    let path = &clips.completed[0].screen_video_path;
    let before = std::fs::read(path).unwrap();
    let committed = clips.completed.clone();
    clips.stop(&mut emitter).expect("stop while paused");
    assert_eq!(clips.completed, committed);
    assert_eq!(
        std::fs::read(&committed[0].screen_video_path).unwrap(),
        before
    );
}

#[test]
fn an_in_progress_source_original_has_readable_fragments_before_finalization() {
    let fixture = Fixture::new();
    let screen = fixture.directory.join("source-clip-0001.mp4");
    let mut writer =
        crate::originals::OriginalWriter::open(&screen, "system", 128000).expect("source writer");
    writer
        .push(&tone(96000), 2000.0)
        .expect("two seconds of source audio");
    let started = writer.take_started().expect("actual source packet");
    let bytes = std::fs::read(&started.path).expect("live source file");
    assert!(bytes.windows(4).any(|tag| tag == b"moov"));
    assert!(bytes.windows(4).any(|tag| tag == b"moof"));
    assert!(decode(&started.path)
        .iter()
        .any(|sample| sample.abs() > 0.1));
    writer.finish().expect("source finalize");
}

#[test]
fn paused_encode_changes_apply_to_the_next_file_and_leave_the_first_untouched() {
    let fixture = Fixture::new();
    let mut clips = Clips::new(fixture.request(), Vec::new(), Some(Backend::Software));
    let mut emitter = Emitter::new(Vec::new(), false);
    clips.frame(frame(), &mut emitter).expect("first screen");
    std::thread::sleep(Duration::from_millis(80));
    clips.pause(&mut emitter).expect("first commit");
    let first_path = clips.completed[0].screen_video_path.clone();
    let first_bytes = std::fs::read(&first_path).unwrap();
    let mut next = clips.request.clone();
    next.video.as_mut().unwrap().fps = Some(60);
    next.video.as_mut().unwrap().bitrate = Some(2000000);
    clips
        .request
        .validate_reconfigure(&next)
        .expect("valid encode setup");
    clips.request = next;
    clips.resume(&mut emitter).expect("second screen");
    std::thread::sleep(Duration::from_millis(80));
    clips.stop(&mut emitter).expect("second commit");
    let probe = std::process::Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=r_frame_rate",
            "-of",
            "csv=p=0",
        ])
        .arg(&clips.completed[1].screen_video_path)
        .output()
        .expect("probe next clip");
    assert!(probe.status.success());
    assert_eq!(String::from_utf8_lossy(&probe.stdout).trim(), "60/1");
    assert_eq!(std::fs::read(first_path).unwrap(), first_bytes);
}
