//! Output-time music/SFX. Preview stems and export use the same bounded PCM mixer.
//! The pinned native audio decoder owns seek/resample/track selection; this module
//! adds linear envelopes and sums before program mastering. It never edits sources.
use super::{
    decode_clip_audio_inner,
    spool::{PcmSpool, BLOCK},
    AUDIO_OUTPUT_SAMPLE_RATE,
};
use anyhow::{ensure, Context, Result};
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::Path;

pub const MAX_OVERLAYS: usize = 256;
pub const MAX_DURATION_SEC: f64 = 10_800.0;
const SAMPLE_RATE: f64 = AUDIO_OUTPUT_SAMPLE_RATE as f64;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AudioOverlay {
    pub id: String,
    pub source_path: String,
    pub start_sec: f64,
    pub end_sec: f64,
    pub source_offset_sec: f64,
    pub gain: f64,
    pub fade_in_sec: f64,
    pub fade_out_sec: f64,
}

pub fn validate_overlays(overlays: &[AudioOverlay]) -> Result<()> {
    ensure!(
        overlays.len() <= MAX_OVERLAYS,
        "audio overlays exceed {MAX_OVERLAYS}"
    );
    let mut ids = std::collections::HashSet::new();
    for overlay in overlays {
        ensure!(
            !overlay.id.is_empty() && overlay.id.len() <= 256 && ids.insert(&overlay.id),
            "audio overlay id is empty, too long or duplicated"
        );
        ensure!(
            overlay.source_path.len() <= 4096
                && Path::new(&overlay.source_path).is_absolute()
                && !overlay.source_path.contains('\0'),
            "audio overlay source must be an absolute local file path"
        );
        for value in [
            overlay.start_sec,
            overlay.end_sec,
            overlay.source_offset_sec,
            overlay.fade_in_sec,
            overlay.fade_out_sec,
        ] {
            ensure!(
                value.is_finite() && (0.0..=MAX_DURATION_SEC).contains(&value),
                "invalid audio overlay time"
            );
        }
        let duration = overlay.end_sec - overlay.start_sec;
        ensure!(
            duration > 0.0 && sample(overlay.end_sec) > sample(overlay.start_sec),
            "audio overlay must contain at least one output sample"
        );
        ensure!(
            overlay.source_offset_sec + duration <= MAX_DURATION_SEC,
            "audio overlay source window exceeds limit"
        );
        ensure!(
            overlay.gain.is_finite() && (0.0..=4.0).contains(&overlay.gain),
            "audio overlay gain must be in 0..4"
        );
        ensure!(
            overlay.fade_in_sec + overlay.fade_out_sec <= duration + 1e-9,
            "audio overlay fades exceed its duration"
        );
    }
    Ok(())
}

fn sample(seconds: f64) -> usize {
    (seconds * SAMPLE_RATE).round() as usize
}

/// Sum unclipped overlay samples so the final program master sees the real peaks.
/// Source windows past EOF are zero-padded by the existing decoder. Media validation
/// in the caller should constrain those windows to probed source durations.
pub(crate) fn mix_into_program(
    program: &mut PcmSpool,
    overlays: &[AudioOverlay],
    check: &mut dyn FnMut() -> Result<()>,
) -> Result<()> {
    validate_overlays(overlays)?;
    if overlays.is_empty() {
        return Ok(());
    }
    ensure!(
        program.samples <= sample(MAX_DURATION_SEC),
        "audio overlay program exceeds three hours"
    );
    for overlay in overlays {
        check()?;
        ensure!(
            std::fs::metadata(&overlay.source_path)
                .with_context(|| format!("audio overlay {} source unavailable", overlay.id))?
                .is_file(),
            "audio overlay {} source is not a regular file",
            overlay.id
        );
        let start = sample(overlay.start_sec);
        let end = sample(overlay.end_sec).min(program.samples);
        if start >= end {
            continue;
        }
        // Decode only the audible source window, one overlay at a time. This reuses
        // the existing tagged-track selection and 48 kHz stereo resampling.
        let mut source = unsafe {
            decode_clip_audio_inner(
                &overlay.source_path,
                overlay.source_offset_sec,
                overlay.source_offset_sec + (end - start) as f64 / SAMPLE_RATE,
                check,
            )
        }
        .with_context(|| format!("audio overlay {} decode failed", overlay.id))?
        .with_context(|| format!("audio overlay {} has no audio stream", overlay.id))?;
        for offset in (0..end - start).step_by(BLOCK) {
            check()?;
            let count = BLOCK.min(end - start - offset);
            let mut mixed = program.read(start + offset, count)?;
            for stem in [&mut source.bed, &mut source.microphone]
                .into_iter()
                .flatten()
            {
                let block = stem.read(offset, count)?;
                for channel in 0..2 {
                    for index in 0..count {
                        let elapsed = (offset + index) as f64 / SAMPLE_RATE;
                        let duration = (sample(overlay.end_sec) - start) as f64 / SAMPLE_RATE;
                        let fade_in = if overlay.fade_in_sec > 0.0 {
                            (elapsed / overlay.fade_in_sec).min(1.0)
                        } else {
                            1.0
                        };
                        let fade_out = if overlay.fade_out_sec > 0.0 {
                            ((duration - elapsed - 1.0 / SAMPLE_RATE).max(0.0)
                                / overlay.fade_out_sec)
                                .min(1.0)
                        } else {
                            1.0
                        };
                        mixed[channel][index] +=
                            block[channel][index] * (overlay.gain * fade_in * fade_out) as f32;
                    }
                }
            }
            program.write(start + offset, &mixed)?;
        }
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StemRequest {
    audio_overlays: Vec<AudioOverlay>,
    duration_sec: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StemStats {
    sample_rate: u32,
    channels: u16,
    frames: usize,
    duration_sec: f64,
    format: &'static str,
}

/// Writes a new float32 WAV; refuses existing destinations. Callers own cache keys,
/// publication and cleanup. Errors/cancellation remove only this call's new file.
pub fn render_stem_json(
    request_json: &str,
    output_path: &str,
    check: &mut dyn FnMut() -> Result<()>,
) -> Result<String> {
    ensure!(
        request_json.len() <= 4 * 1024 * 1024,
        "audio stem request exceeds 4 MiB"
    );
    let request: StemRequest = serde_json::from_str(request_json)?;
    validate_overlays(&request.audio_overlays)?;
    ensure!(
        request.duration_sec.is_finite()
            && request.duration_sec > 0.0
            && request.duration_sec <= MAX_DURATION_SEC,
        "invalid audio stem duration"
    );
    ensure!(
        Path::new(output_path).is_absolute() && output_path.len() <= 4096,
        "audio stem output must be an absolute local path"
    );
    check()?;
    let mut program = PcmSpool::new()?;
    program.resize(sample(request.duration_sec))?;
    mix_into_program(&mut program, &request.audio_overlays, check)?;
    check()?;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(output_path)
        .context("cannot create new audio stem")?;
    let result = (|| -> Result<()> {
        let data_bytes = u32::try_from(
            program
                .samples
                .checked_mul(8)
                .context("audio stem size overflow")?,
        )?;
        file.write_all(b"RIFF")?;
        file.write_all(
            &data_bytes
                .checked_add(48)
                .context("audio stem RIFF size overflow")?
                .to_le_bytes(),
        )?;
        file.write_all(b"WAVEfmt ")?;
        file.write_all(&16u32.to_le_bytes())?;
        file.write_all(&3u16.to_le_bytes())?; // IEEE float; retain headroom above unity.
        file.write_all(&2u16.to_le_bytes())?;
        file.write_all(&48_000u32.to_le_bytes())?;
        file.write_all(&384_000u32.to_le_bytes())?;
        file.write_all(&8u16.to_le_bytes())?;
        file.write_all(&32u16.to_le_bytes())?;
        file.write_all(b"fact")?;
        file.write_all(&4u32.to_le_bytes())?;
        file.write_all(&(program.samples as u32).to_le_bytes())?;
        file.write_all(b"data")?;
        file.write_all(&data_bytes.to_le_bytes())?;
        for offset in (0..program.samples).step_by(BLOCK) {
            check()?;
            let block = program.read(offset, BLOCK.min(program.samples - offset))?;
            let mut bytes = Vec::with_capacity(block[0].len() * 8);
            for index in 0..block[0].len() {
                bytes.extend_from_slice(&block[0][index].to_le_bytes());
                bytes.extend_from_slice(&block[1][index].to_le_bytes());
            }
            file.write_all(&bytes)?;
        }
        file.sync_all()?;
        check()?;
        Ok(())
    })();
    drop(file);
    if result.is_err() {
        let _ = std::fs::remove_file(output_path);
    }
    result?;
    serde_json::to_string(&StemStats {
        sample_rate: 48_000,
        channels: 2,
        frames: program.samples,
        duration_sec: program.samples as f64 / SAMPLE_RATE,
        format: "float32-wav",
    })
    .map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Fixture(std::path::PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "klippt-overlay-test-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn path(&self, name: &str) -> String {
            self.0.join(name).to_str().unwrap().to_owned()
        }
        fn source(&self) -> String {
            let path = self.path("source.wav");
            let count = 24_000u32;
            let mut bytes = b"RIFF".to_vec();
            bytes.extend((36 + count * 4).to_le_bytes());
            bytes.extend(b"WAVEfmt ");
            bytes.extend(16u32.to_le_bytes());
            bytes.extend(1u16.to_le_bytes());
            bytes.extend(2u16.to_le_bytes());
            bytes.extend(48_000u32.to_le_bytes());
            bytes.extend(192_000u32.to_le_bytes());
            bytes.extend(4u16.to_le_bytes());
            bytes.extend(16u16.to_le_bytes());
            bytes.extend(b"data");
            bytes.extend((count * 4).to_le_bytes());
            for i in 0..count {
                let value: i16 = if i < 4800 { 4096 } else { 8192 };
                bytes.extend(value.to_le_bytes());
                bytes.extend(value.to_le_bytes());
            }
            std::fs::write(&path, bytes).unwrap();
            path
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn overlay(path: &str) -> AudioOverlay {
        AudioOverlay {
            id: "music".into(),
            source_path: path.into(),
            start_sec: 0.1,
            end_sec: 0.3,
            source_offset_sec: 0.1,
            gain: 1.0,
            fade_in_sec: 0.0,
            fade_out_sec: 0.0,
        }
    }
    fn silence(seconds: f64) -> PcmSpool {
        let mut spool = PcmSpool::new().unwrap();
        spool.resize(sample(seconds)).unwrap();
        spool
    }
    fn at(spool: &mut PcmSpool, seconds: f64) -> f32 {
        spool.read(sample(seconds), 1).unwrap()[0][0]
    }

    #[test]
    fn output_placement_source_offset_gain_and_overlap_use_the_same_sample_grid() {
        let fixture = Fixture::new();
        let mut first = overlay(&fixture.source());
        first.gain = 0.5;
        let mut second = first.clone();
        second.id = "sfx".into();
        second.start_sec = 0.2;
        second.end_sec = 0.4;
        let mut program = silence(0.5);
        mix_into_program(&mut program, &[first, second], &mut || Ok(())).unwrap();
        assert_eq!(at(&mut program, 0.05), 0.0);
        assert!((at(&mut program, 0.15) - 0.125).abs() < 1e-6);
        assert!((at(&mut program, 0.25) - 0.25).abs() < 1e-6);
        assert!((at(&mut program, 0.35) - 0.125).abs() < 1e-6);
        assert_eq!(at(&mut program, 0.45), 0.0);
        assert_eq!(program.samples, 24_000);
    }

    #[test]
    fn fade_endpoints_are_silent_and_gain_is_not_clamped_before_mastering() {
        let fixture = Fixture::new();
        let mut clip = overlay(&fixture.source());
        clip.gain = 4.0;
        clip.fade_in_sec = 0.05;
        clip.fade_out_sec = 0.05;
        let mut program = silence(0.5);
        mix_into_program(&mut program, &[clip.clone()], &mut || Ok(())).unwrap();
        assert_eq!(at(&mut program, 0.1), 0.0);
        assert!((at(&mut program, 0.125) - 0.5).abs() < 1e-5);
        assert!((at(&mut program, 0.2) - 1.0).abs() < 1e-6);
        assert_eq!(program.read(sample(0.3) - 1, 1).unwrap()[0][0], 0.0);
        clip.id = "second".into();
        mix_into_program(&mut program, &[clip], &mut || Ok(())).unwrap();
        assert!((at(&mut program, 0.2) - 2.0).abs() < 1e-6);
    }

    #[test]
    fn absent_overlays_leave_existing_program_unchanged() {
        let mut program = silence(0.1);
        program.write(0, &vec![vec![0.25; 12]; 2]).unwrap();
        mix_into_program(&mut program, &[], &mut || anyhow::bail!("must not run")).unwrap();
        assert_eq!(program.read(0, 12).unwrap(), vec![vec![0.25; 12]; 2]);
        assert_eq!(program.samples, 4800);
    }

    #[test]
    fn invalid_values_duplicate_ids_and_missing_sources_fail_loudly() {
        let fixture = Fixture::new();
        let valid = overlay(&fixture.path("missing.wav"));
        let mut program = silence(0.5);
        assert!(
            mix_into_program(&mut program, &[valid.clone()], &mut || Ok(()))
                .unwrap_err()
                .to_string()
                .contains("source unavailable")
        );
        assert!(validate_overlays(&[valid.clone(), valid.clone()]).is_err());
        for bad in [f64::NAN, f64::INFINITY, -1.0, 4.1] {
            let mut clip = valid.clone();
            clip.gain = bad;
            assert!(validate_overlays(&[clip]).is_err());
        }
        let mut clip = valid;
        clip.fade_in_sec = 1.0;
        assert!(validate_overlays(&[clip]).is_err());
    }

    #[test]
    fn cancelled_mixing_stops_before_decode() {
        let fixture = Fixture::new();
        let mut program = silence(0.5);
        let error = mix_into_program(&mut program, &[overlay(&fixture.source())], &mut || {
            anyhow::bail!("cancelled")
        })
        .unwrap_err();
        assert_eq!(error.to_string(), "cancelled");
        assert_eq!(at(&mut program, 0.2), 0.0);
    }

    #[test]
    fn preview_wav_contains_the_same_unclipped_samples_and_cannot_overwrite() {
        let fixture = Fixture::new();
        let mut clip = overlay(&fixture.source());
        clip.gain = 4.0;
        let mut second = clip.clone();
        second.id = "second".into();
        let request =
            serde_json::json!({"audioOverlays":[clip,second],"durationSec":0.5}).to_string();
        let output = fixture.path("preview.wav");
        let stats: serde_json::Value =
            serde_json::from_str(&render_stem_json(&request, &output, &mut || Ok(())).unwrap())
                .unwrap();
        assert_eq!(stats["frames"], 24000);
        let bytes = std::fs::read(&output).unwrap();
        assert_eq!(&bytes[..4], b"RIFF");
        let offset = 56 + sample(0.2) * 8;
        assert!(
            (f32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap()) - 2.0).abs() < 1e-6
        );
        // The same FFmpeg decoder can consume the float WAV cache.
        let mut decoded = unsafe { decode_clip_audio_inner(&output, 0.0, 0.5, &mut || Ok(())) }
            .unwrap()
            .unwrap();
        assert!((at(decoded.bed.as_mut().unwrap(), 0.2) - 2.0).abs() < 1e-6);
        assert!(render_stem_json(&request, &output, &mut || Ok(())).is_err());
        assert_eq!(std::fs::read(&output).unwrap(), bytes);
    }

    #[test]
    fn cancelled_wav_write_removes_only_its_new_partial_file() {
        let fixture = Fixture::new();
        let output = fixture.path("cancelled.wav");
        let mut checks = 0;
        let result = render_stem_json(
            r#"{"audioOverlays":[],"durationSec":0.5}"#,
            &output,
            &mut || {
                checks += 1;
                if checks == 4 {
                    anyhow::bail!("cancelled");
                }
                Ok(())
            },
        );
        assert!(result.is_err());
        assert!(!Path::new(&output).exists());
    }
}
