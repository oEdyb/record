//! Writers change on Pause/Continue; the portal, PipeWire stream and PCM rings do not.
use crate::capture::{AudioSource, Capture};
use crate::encoder::Backend;
use crate::events::{timestamp_ms, CaptureBounds, Emitter, Event, RecordingClip, RecordingWarning};
use crate::{portal::CursorMode, request::Request, shim};
use std::collections::HashSet;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

#[path = "clip_lifecycle.rs"]
mod lifecycle;
use lifecycle::{ClipLifecycle, ClipMove, History, Origin};

const FIRST_FRAME_TIMEOUT: Duration = Duration::from_secs(8);
const SOURCE_TIMEOUT: Duration = Duration::from_secs(2);

pub fn clip_path(requested: &Path, index: usize) -> PathBuf {
    let stem = requested.file_stem().unwrap_or_default().to_string_lossy();
    let base = stem.strip_suffix("-clip-0001").unwrap_or(&stem);
    let ext = requested
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("mp4");
    requested.with_file_name(format!("{base}-clip-{:04}.{ext}", index + 1))
}

pub struct Clips {
    pub request: Request,
    pub audio: Vec<AudioSource>,
    lifecycle: ClipLifecycle,
    latest: Option<shim::Frame>,
    completed: Vec<RecordingClip>,
    forced: Option<Backend>,
    position: (i32, i32),
    bounds: Option<CaptureBounds>,
    crop_warned: bool,
    dropped_frames: u64,
    last_pts_ns: Option<i64>,
    reported_originals: HashSet<&'static str>,
}

impl Clips {
    pub fn new(request: Request, audio: Vec<AudioSource>, forced: Option<Backend>) -> Self {
        Self {
            request,
            audio,
            forced,
            lifecycle: ClipLifecycle::default(),
            latest: None,
            completed: Vec::new(),
            position: (0, 0),
            bounds: None,
            crop_warned: false,
            dropped_frames: 0,
            last_pts_ns: None,
            reported_originals: HashSet::new(),
        }
    }

    pub fn set_dropped_frames(&mut self, count: u64) {
        self.dropped_frames = count;
    }

    pub fn fail(&mut self, message: &str) {
        let _ = self.lifecycle.transition(ClipMove::Fail(message.into()));
    }
    pub fn connected_if_waiting(&mut self) {
        if self.lifecycle.awaiting_since().is_none()
            && !self.lifecycle.started()
            && !self.lifecycle.paused()
        {
            self.connected();
        }
    }
    pub fn connected(&mut self) {
        let _ = self
            .lifecycle
            .transition(ClipMove::Connected(Instant::now()));
    }
    pub fn set_position(&mut self, position: Option<(i32, i32)>) {
        self.position = position.unwrap_or((0, 0));
    }
    /// Adopt only a usable candidate, after its portal/PipeWire connection succeeds.
    pub fn replace_source(
        &mut self,
        frame: shim::Frame,
        position: Option<(i32, i32)>,
    ) -> Result<(), String> {
        if !self.canonical() || !self.lifecycle.paused() || self.lifecycle.writer().is_some() {
            return Err("source selection requires a paused clip-native recording".into());
        }
        if frame.crop.width & !1 < 2 || frame.crop.height & !1 < 2 {
            return Err("replacement capture rectangle is too small to encode".into());
        }
        // Portal streams have independent PTS origins. Do not reject a new source
        // because its first timestamp precedes the previous source's final one.
        self.last_pts_ns = (frame.pts_ns >= 0).then_some(frame.pts_ns);
        self.latest = Some(frame);
        self.set_position(position);
        self.bounds = None;
        self.crop_warned = false;
        self.clear_audio();
        Ok(())
    }
    pub fn is_paused(&self) -> bool {
        self.lifecycle.paused()
    }
    /// A clip was confirmed at least once: the take is past startup.
    pub fn has_started(&self) -> bool {
        self.lifecycle.started()
    }
    pub fn has_writer(&self) -> bool {
        self.lifecycle.writer().is_some()
    }

    pub fn reject_resume<W: Write>(&self, emitter: &mut Emitter<W>, message: String) {
        let _ = emitter.emit(&Event::ClipResumeRejected {
            code: "clip-resume-rejected",
            clip_index: self.completed.len(),
            message,
        });
    }
    fn canonical(&self) -> bool {
        self.request.outputs.is_some()
    }

    fn clear_audio(&self) {
        for source in &self.audio {
            source.ring.clear();
        }
    }

    pub fn frame<W: Write>(
        &mut self,
        frame: shim::Frame,
        emitter: &mut Emitter<W>,
    ) -> Result<(), String> {
        self.lifecycle.transition(ClipMove::Frame)?;
        // Portal PTS is in the same stream clock across clips. Never replace a
        // cached frame with an older compositor delivery (negative means unknown).
        if frame.pts_ns >= 0 && self.last_pts_ns.is_some_and(|pts| frame.pts_ns < pts) {
            return Ok(());
        }
        if frame.pts_ns >= 0 {
            self.last_pts_ns = Some(frame.pts_ns);
        }
        self.latest = Some(frame);
        if self.lifecycle.paused() {
            return Ok(());
        }
        self.stage_latest(emitter)?;
        self.advance(emitter)
    }

    fn stage_latest<W: Write>(&mut self, emitter: &mut Emitter<W>) -> Result<(), String> {
        let Some(frame) = &self.latest else {
            return Ok(());
        };
        let Some(requested) = self.request.screen_path() else {
            return Ok(());
        };
        if self.lifecycle.writer().is_none() {
            let width = frame.crop.width & !1;
            let height = frame.crop.height & !1;
            if width < 2 || height < 2 {
                return Err("capture rectangle is too small to encode".into());
            }
            let path = if self.canonical() || !self.completed.is_empty() {
                clip_path(Path::new(requested), self.completed.len())
            } else {
                PathBuf::from(requested)
            };
            let (mut writer, selection) = Capture::start(
                &path,
                width,
                height,
                self.request.fps(),
                self.request.bitrate(),
                self.forced,
                self.audio.clone(),
            )?;
            if self.canonical() {
                writer.enable_originals()?;
            }
            emitter
                .emit(&Event::EncoderSelection {
                    video: selection.backend.as_str().into(),
                    rejected: selection.rejected,
                })
                .map_err(|error| error.to_string())?;
            self.bounds = Some(CaptureBounds {
                x: self.position.0,
                y: self.position.1,
                width,
                height,
            });
            self.lifecycle
                .transition(ClipMove::Prepared(Box::new(writer)))?;
            self.crop_warned = false;
            self.reported_originals.clear();
        }
        let writer = self
            .lifecycle
            .writer_mut()
            .ok_or("writer was not prepared")?;
        if writer.crop_diverged(frame) && !self.crop_warned {
            self.crop_warned = true;
            emitter
                .emit(&Event::Warning {
                    code: "crop-changed".into(),
                    message:
                        "source dimensions changed; the current clip retains its initial dimensions"
                            .into(),
                })
                .map_err(|error| error.to_string())?;
        }
        writer.stage(frame)
    }

    pub fn advance<W: Write>(&mut self, emitter: &mut Emitter<W>) -> Result<(), String> {
        if self.lifecycle.paused() {
            self.clear_audio();
            return Ok(());
        }
        let canonical = self.canonical();
        let origin = self.lifecycle.origin();
        let Some(writer) = self.lifecycle.writer_mut() else {
            if self.request.screen_path().is_some()
                && self
                    .lifecycle
                    .awaiting_since()
                    .is_some_and(|since| since.elapsed() >= FIRST_FRAME_TIMEOUT)
            {
                return Err("PipeWire supplied no usable screen frame within eight seconds".into());
            }
            self.clear_audio();
            return Ok(());
        };
        writer.advance()?;
        let index = self.completed.len();
        emit_originals(emitter, writer, index, &mut self.reported_originals)?;
        if writer.writer_stalled() {
            return Err("screen encoder appended no video packet for two seconds".into());
        }
        if canonical && !writer.sources_ready() && writer.elapsed() >= SOURCE_TIMEOUT {
            return Err("an enabled audio source supplied no samples within two seconds of the screen epoch".into());
        }
        if origin.is_some() && writer.ready() {
            let bounds = self.bounds.clone().ok_or("capture bounds missing")?;
            let started_at_ms = timestamp_ms().saturating_sub(writer.elapsed().as_millis() as u64);
            if origin.is_some_and(|origin| origin.history() == History::Unstarted) {
                emitter
                    .emit(&Event::RecordingStarted {
                        started_at_ms,
                        capture_bounds: bounds.clone(),
                    })
                    .map_err(|error| error.to_string())?;
            }
            if origin.is_some_and(Origin::resumed) {
                emitter
                    .emit(&Event::RecordingResumed {
                        clip_index: index,
                        started_at_ms,
                    })
                    .map_err(|error| error.to_string())?;
            }
            // Keep the old outputPath protocol usable as well.
            if !canonical {
                emitter
                    .emit(&Event::CaptureStarted {
                        timestamp_ms: timestamp_ms(),
                        path: self.request.screen_path().unwrap_or_default().into(),
                        width: bounds.width,
                        height: bounds.height,
                        fps: self.request.fps(),
                    })
                    .map_err(|error| error.to_string())?;
            }
            self.lifecycle.transition(ClipMove::Announced)?;
        }
        Ok(())
    }

    pub fn pause<W: Write>(&mut self, emitter: &mut Emitter<W>) -> Result<(), String> {
        if !self.lifecycle.paused() {
            if self.canonical() {
                self.finalize(emitter)?;
            } else if let Some(writer) = self.lifecycle.writer_mut() {
                writer.pause();
            }
            self.lifecycle.transition(ClipMove::Pause)?;
            self.clear_audio();
        }
        emitter
            .emit(&Event::RecordingPaused {})
            .map_err(|error| error.to_string())
    }

    pub fn resume<W: Write>(&mut self, emitter: &mut Emitter<W>) -> Result<(), String> {
        self.lifecycle
            .transition(ClipMove::Resume(Instant::now()))?;
        self.clear_audio();
        if let Some(writer) = self.lifecycle.writer_mut() {
            writer.resume();
        }
        // The cached image is valid even when a static source sends no damage.
        self.stage_latest(emitter)?;
        self.advance(emitter)
    }

    fn finalize<W: Write>(&mut self, emitter: &mut Emitter<W>) -> Result<(), String> {
        let Some(mut writer) = self.lifecycle.transition(ClipMove::TakeWriter)? else {
            return Ok(());
        };
        // Freeze before stdout, encoder catch-up or any file finalization can
        // add latency. close_boundary drains PCM once at that frozen boundary.
        let boundary = writer.close_boundary();
        emitter
            .emit(&Event::ClipFinalizing {
                clip_index: self.completed.len(),
            })
            .map_err(|error| error.to_string())?;
        for (label, samples) in writer.dropped_audio() {
            emitter
                .emit(&Event::Warning {
                    code: "audio-dropped".into(),
                    message: format!("{samples} {label} samples were lost before encoding; their intervals were replaced with silence"),
                })
                .map_err(|error| error.to_string())?;
        }
        let starts = emit_originals(
            emitter,
            &mut writer,
            self.completed.len(),
            &mut self.reported_originals,
        );
        let finalized = (*writer).finish();
        boundary?;
        starts?;
        let summary = finalized?;
        if let Some(failure) = self.lifecycle.failure() {
            return Err(failure.to_owned());
        }
        if summary.frames == 0 {
            return Err("cannot commit a clip with no encoded screen frames".into());
        }
        let mut clip = RecordingClip {
            index: self.completed.len(),
            screen_video_path: summary.path.display().to_string(),
            duration_ms: summary.duration_ms,
            cursor_capture_mode: if self.request.cursor_mode()? == CursorMode::Embedded {
                "system"
            } else {
                "editable-overlay"
            }
            .into(),
            microphone_audio_path: None,
            microphone_audio_offset_ms: None,
            system_audio_path: None,
            system_audio_offset_ms: None,
        };
        for original in summary.originals {
            if self.reported_originals.insert(original.label) {
                emit_original(emitter, &original, clip.index)?;
            }
            if original.label == "system" {
                clip.system_audio_path = Some(original.path);
                clip.system_audio_offset_ms = Some(original.offset_ms);
            } else {
                clip.microphone_audio_path = Some(original.path);
                clip.microphone_audio_offset_ms = Some(original.offset_ms);
            }
        }
        if !self.canonical() {
            emitter
                .emit(&Event::CaptureStopped {
                    timestamp_ms: timestamp_ms(),
                    path: clip.screen_video_path.clone(),
                    duration_ms: summary.duration_ms,
                    frames: summary.frames,
                    dropped: self.dropped_frames,
                    convert_ms: summary.stats.convert_ms(),
                    upload_ms: summary.stats.upload_ms(),
                    encode_ms: summary.stats.encode_ms(),
                })
                .map_err(|error| error.to_string())?;
        }
        emitter
            .emit(&Event::ClipFinalized { clip: clip.clone() })
            .map_err(|error| error.to_string())?;
        self.completed.push(clip);
        self.lifecycle.transition(ClipMove::Drained)?;
        Ok(())
    }

    pub fn stop<W: Write>(&mut self, emitter: &mut Emitter<W>) -> Result<(), String> {
        let finalized = self.finalize(emitter);
        if let Err(message) = &finalized {
            self.fail(message);
            emitter
                .emit(&Event::Error {
                    code: "clip-finalize-failed".into(),
                    message: message.clone(),
                })
                .map_err(|error| error.to_string())?;
        }
        if self.request.screen_path().is_some() {
            let screen_path = self
                .completed
                .first()
                .map(|clip| clip.screen_video_path.clone())
                .unwrap_or_else(|| self.request.screen_path().unwrap_or_default().into());
            emitter
                .emit(&Event::RecordingStopped {
                    screen_path,
                    clips: self.completed.clone(),
                    warning: self.lifecycle.failure().map(|message| RecordingWarning {
                        code: "final-clip-failed".into(),
                        message: message.to_owned(),
                    }),
                })
                .map_err(|error| error.to_string())?;
        }
        self.lifecycle.transition(ClipMove::Stop)?;
        finalized
    }
}

fn emit_originals<W: Write>(
    emitter: &mut Emitter<W>,
    writer: &mut Capture,
    index: usize,
    reported: &mut HashSet<&'static str>,
) -> Result<(), String> {
    for original in writer.take_started_originals() {
        reported.insert(original.label);
        emit_original(emitter, &original, index)?;
    }
    Ok(())
}

fn emit_original<W: Write>(
    emitter: &mut Emitter<W>,
    original: &crate::originals::Original,
    index: usize,
) -> Result<(), String> {
    let key = if original.label == "system" {
        "systemAudioPath"
    } else {
        "microphoneAudioPath"
    };
    emitter
        .emit(&Event::OriginalStarted {
            clip_index: index,
            key: key.into(),
            path: original.path.clone(),
            offset_ms: original.offset_ms,
        })
        .map_err(|error| error.to_string())
}

#[cfg(test)]
#[path = "clip_tests.rs"]
mod tests;
