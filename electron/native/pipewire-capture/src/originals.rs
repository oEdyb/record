//! Standalone, unboosted source audio. The ring has PCM but no host timestamps:
//! estimate its first sample from the drain boundary minus the block duration.
use crate::encoder::{AudioEncoder, Muxer, TrackId, AUDIO_CHANNELS, AUDIO_SAMPLE_RATE};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Original {
    #[serde(skip)]
    pub label: &'static str,
    pub path: String,
    pub offset_ms: f64,
}

pub struct OriginalWriter {
    encoder: AudioEncoder,
    muxer: Muxer,
    track: TrackId,
    path: PathBuf,
    label: &'static str,
    first: Option<Original>,
    pending_first: Option<Original>,
    reported: bool,
}

impl OriginalWriter {
    pub fn open(screen: &Path, label: &'static str, bitrate: i64) -> Result<Self, String> {
        let stem = screen
            .file_stem()
            .ok_or("screen path has no file stem")?
            .to_string_lossy();
        let path = screen.with_file_name(format!("{stem}-{label}.mov"));
        let encoder = AudioEncoder::open(bitrate)?;
        let mut muxer = Muxer::create(&path)?;
        let track = muxer.add_stream(encoder.codec_context())?;
        muxer.write_header()?;
        Ok(Self {
            encoder,
            muxer,
            track,
            path,
            label,
            first: None,
            pending_first: None,
            reported: false,
        })
    }

    pub fn push(&mut self, samples: &[f32], elapsed_ms: f64) -> Result<(), String> {
        if samples.is_empty() {
            return Ok(());
        }
        let duration_ms =
            samples.len() as f64 * 1000.0 / (AUDIO_SAMPLE_RATE as usize * AUDIO_CHANNELS) as f64;
        if self.pending_first.is_none() {
            self.pending_first = Some(Original {
                label: self.label,
                path: self.path.display().to_string(),
                offset_ms: (elapsed_ms - duration_ms).max(0.0),
            });
        }
        let track = self.track;
        let mut appended = false;
        self.encoder.push(samples, |packet| {
            self.muxer.write(track, packet)?;
            appended = true;
            Ok(())
        })?;
        if appended && self.first.is_none() {
            self.first = self.pending_first.clone();
        }

        Ok(())
    }

    pub fn take_started(&mut self) -> Option<Original> {
        if self.reported {
            return None;
        }
        let first = self.first.clone()?;
        self.reported = true;
        Some(first)
    }

    pub fn started(&self) -> bool {
        self.first.is_some()
    }

    pub fn finish(mut self) -> Result<Option<Original>, String> {
        let track = self.track;
        let mut appended = false;
        let encoded = self.encoder.finish(|packet| {
            self.muxer.write(track, packet)?;
            appended = true;
            Ok(())
        });
        if appended && self.first.is_none() {
            self.first = self.pending_first.clone();
        }
        let finalized = self.muxer.finish();
        encoded?;
        finalized?;
        Ok(self.first)
    }
}
