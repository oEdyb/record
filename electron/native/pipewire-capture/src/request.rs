use crate::{portal, DEFAULT_AUDIO_BITRATE, DEFAULT_FPS};
use serde::Deserialize;

#[derive(Debug, Default, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct VideoRequest {
    pub fps: Option<i32>,
    pub width: Option<i32>,
    pub height: Option<i32>,
    pub bitrate: Option<i64>,
}

/// Mirrors the `audio` block of `NativeWindowsRecordingRequest`
/// (src/lib/nativeWindowsRecording.ts) so the three platforms take the same
/// request shape.
#[derive(Debug, Default, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AudioRequest {
    pub system: SystemAudioRequest,
    pub microphone: MicrophoneRequest,
}

#[derive(Debug, Default, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SystemAudioRequest {
    pub enabled: bool,
}

#[derive(Debug, Default, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MicrophoneRequest {
    pub enabled: bool,
    /// A PipeWire node name (`node.name`), not the browser device id the UI
    /// carries: the two namespaces are unrelated and there is no mapping
    /// between them. Absent means the session default source.
    pub device_name: Option<String>,
    /// Linear multiplier the UI applies to microphone level.
    pub gain: Option<f32>,
}

#[derive(Debug, Default, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Request {
    /// Main-process-owned permission cache; never supplied by the renderer.
    pub portal_state_path: Option<std::path::PathBuf>,
    pub source: Option<serde_json::Value>,
    pub outputs: Option<Outputs>,
    pub cursor: Option<CursorRequest>,
    pub webcam: Option<serde_json::Value>,
    pub sample_interval_ms: Option<u64>,
    /// Where to write the MP4. Absent means cursor-only: no pixels are mapped,
    /// no encoder is opened, and the helper behaves exactly as Stage 1 did.
    pub output_path: Option<String>,
    /// `"metadata"` (default) keeps the pointer out of the pixels so the editor
    /// can draw its own; `"embedded"` asks the compositor to paint it in. These
    /// are the two halves of the HUD's cursor-mode toggle.
    pub cursor_mode: Option<String>,
    pub video: Option<VideoRequest>,
    pub audio: Option<AudioRequest>,
    /// Negotiate the portal, report `source-selected`, then WAIT for `record` on
    /// stdin before connecting to PipeWire.
    ///
    /// Splits "the user has chosen what to share" from "pixels are flowing", so a
    /// caller can put a countdown between them instead of counting down before
    /// the picker has even appeared. Defaults to false, which keeps the
    /// single-shot behaviour every existing caller relies on.
    pub defer_start: bool,
    /// Emit `ready` and exit, without ever calling the portal's `Start()`.
    ///
    /// Everything up to that point is non-interactive; `Start()` is the single
    /// call that raises the compositor's source picker. This flag is what makes
    /// the dlopen path, the portal connection and the cursor-mode check testable
    /// — in CI or by hand — without hijacking someone's screen.
    pub probe_only: bool,
}

#[derive(Debug, Default, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Outputs {
    pub screen_path: String,
}

#[derive(Debug, Default, Clone, PartialEq, Deserialize)]
pub struct CursorRequest {
    pub mode: String,
}

impl Request {
    pub fn portal_selection(&self) -> Option<crate::portal_grants::SelectionRequest> {
        self.portal_state_path.clone().map(|path| {
            if self
                .source
                .as_ref()
                .and_then(|source| source.get("sourceId"))
                .and_then(serde_json::Value::as_str)
                == Some("portal:choose")
            {
                crate::portal_grants::SelectionRequest::Choose(path)
            } else {
                crate::portal_grants::SelectionRequest::Reuse(path)
            }
        })
    }
    pub fn screen_path(&self) -> Option<&str> {
        self.outputs
            .as_ref()
            .map(|outputs| outputs.screen_path.as_str())
            .or(self.output_path.as_deref())
    }

    pub fn validate(&self) -> Result<(), String> {
        self.cursor_mode()?;
        if self
            .screen_path()
            .is_some_and(|path| path.trim().is_empty())
        {
            return Err("screenPath must not be empty".into());
        }
        if let Some(video) = &self.video {
            if video.fps.is_some_and(|fps| !(1..=240).contains(&fps))
                || video.bitrate.is_some_and(|rate| rate <= 0)
            {
                return Err("video fps must be 1..240 and bitrate must be positive".into());
            }
        }
        if self
            .audio
            .as_ref()
            .and_then(|audio| audio.microphone.gain)
            .is_some_and(|gain| !gain.is_finite() || gain < 0.0)
        {
            return Err("microphone gain must be finite and nonnegative".into());
        }
        Ok(())
    }

    fn audio_resolution(&self) -> AudioResolution {
        if self.outputs.is_some() {
            AudioResolution::Required
        } else {
            AudioResolution::BestEffort
        }
    }

    pub fn audio_topology(&self) -> (bool, bool, Option<&str>) {
        let Some(audio) = &self.audio else {
            return (false, false, None);
        };
        (
            audio.system.enabled,
            audio.microphone.enabled,
            audio.microphone.device_name.as_deref(),
        )
    }

    pub fn validate_reconfigure(&self, next: &Self) -> Result<(), String> {
        next.validate()?;
        if self.source != next.source {
            return Err(
                "Wayland source changes require a new portal session; stop and select a new source"
                    .into(),
            );
        }
        if self.cursor_mode()? != next.cursor_mode()? {
            return Err(
                "Wayland cursor mode is fixed by the portal grant; stop to change it".into(),
            );
        }
        if self.screen_path() != next.screen_path()
            || self.outputs.is_some() != next.outputs.is_some()
        {
            return Err("reconfigure cannot replace recording output paths".into());
        }
        let dimensions = |request: &Self| {
            request
                .video
                .as_ref()
                .map(|video| (video.width, video.height))
        };
        if dimensions(self) != dimensions(next) {
            return Err(
                "Linux records portal source pixels; changing requested dimensions is unsupported"
                    .into(),
            );
        }
        if self.webcam != next.webcam {
            return Err(
                "native Linux webcam reconfiguration is unsupported; use renderer camera capture"
                    .into(),
            );
        }
        Ok(())
    }

    pub fn resolve_cursor_mode(
        &mut self,
        offered: &[portal::CursorMode],
    ) -> Result<portal::CursorMode, String> {
        let requested = self.cursor_mode()?;
        let resolved = requested.resolve(offered);
        if resolved != requested {
            self.cursor = Some(CursorRequest {
                mode: resolved.as_str().into(),
            });
        }
        Ok(resolved)
    }

    pub fn cursor_mode(&self) -> Result<portal::CursorMode, String> {
        match self
            .cursor
            .as_ref()
            .map(|cursor| cursor.mode.as_str())
            .or(self.cursor_mode.as_deref())
        {
            None | Some("") | Some("metadata") | Some("editable-overlay") => {
                Ok(portal::CursorMode::Metadata)
            }
            Some("embedded") | Some("system") => Ok(portal::CursorMode::Embedded),
            Some("hidden") => Ok(portal::CursorMode::Hidden),
            Some(other) => Err(format!(
                "cursorMode must be one of metadata, embedded, hidden — got {other:?}"
            )),
        }
    }

    pub fn fps(&self) -> i32 {
        self.video
            .as_ref()
            .and_then(|video| video.fps)
            .filter(|fps| *fps > 0 && *fps <= 240)
            .unwrap_or(DEFAULT_FPS)
    }

    /// An explicit override, or `None` to let the encoder derive one from the
    /// size the compositor negotiates. `None` is the normal case: on Wayland the
    /// app cannot know the capture resolution in advance, so a bitrate chosen
    /// caller-side is a guess about a picture nobody has seen yet.
    pub fn bitrate(&self) -> Option<i64> {
        self.video
            .as_ref()
            .and_then(|video| video.bitrate)
            .filter(|bitrate| *bitrate > 0)
    }

    /// The audio streams to open, in the order they become MP4 tracks.
    ///
    /// Empty when no output file was requested: a cursor-only session has
    /// nothing to mux audio into, and opening a capture stream would show the
    /// user a recording indicator for a recording that is not happening.
    pub fn audio_sources(&self) -> Vec<AudioSourceConfig> {
        if self.screen_path().is_none() {
            return Vec::new();
        }
        let Some(audio) = self.audio.as_ref() else {
            return Vec::new();
        };
        let mut sources = Vec::new();
        if audio.system.enabled {
            sources.push(AudioSourceConfig {
                label: "system",
                resolution: self.audio_resolution(),
                target: None,
                // The default SINK's monitor: what is being played, not what a
                // microphone hears.
                capture_sink: true,
                gain: 1.0,
                bitrate: DEFAULT_AUDIO_BITRATE,
            });
        }
        if audio.microphone.enabled {
            sources.push(AudioSourceConfig {
                label: "microphone",
                resolution: self.audio_resolution(),
                target: audio.microphone.device_name.clone(),
                capture_sink: false,
                gain: audio.microphone.gain.unwrap_or(1.0),
                bitrate: DEFAULT_AUDIO_BITRATE,
            });
        }
        sources
    }
}

#[derive(PartialEq)]
pub enum AudioResolution {
    BestEffort,
    Required,
}

pub struct AudioSourceConfig {
    pub resolution: AudioResolution,
    pub label: &'static str,
    pub target: Option<String>,
    pub capture_sink: bool,
    pub gain: f32,
    pub bitrate: i64,
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request() -> Request {
        serde_json::from_value(serde_json::json!({
            "source": { "type":"display", "sourceId":"screen:123:0" },
            "outputs": { "screenPath":"/tmp/recording-clip-0001.mp4" },
            "video": { "fps":60, "width":1920, "height":1080, "bitrate":136000000 },
            "audio": { "system":{"enabled":true}, "microphone":{"enabled":true,"deviceName":"USB microphone","gain":0.0} },
            "cursor":{"mode":"system"}, "deferStart":true
        })).expect("Mac request")
    }
    #[test]
    fn grants_require_main_owned_state_and_explicit_choice_bypasses_reuse() {
        let mut request = request();
        assert!(request.portal_selection().is_none());
        request.portal_state_path = Some("/private/grant.json".into());
        assert!(matches!(
            request.portal_selection(),
            Some(crate::portal_grants::SelectionRequest::Reuse(_))
        ));
        request.source = Some(serde_json::json!({ "sourceId": "portal:choose" }));
        assert!(matches!(
            request.portal_selection(),
            Some(crate::portal_grants::SelectionRequest::Choose(_))
        ));
    }

    #[test]
    fn accepts_mac_request_without_treating_source_id_as_a_portal_target() {
        let request = request();
        request.validate().expect("valid");
        assert_eq!(request.screen_path(), Some("/tmp/recording-clip-0001.mp4"));
        assert_eq!(request.cursor_mode().unwrap(), portal::CursorMode::Embedded);
        assert_eq!(request.audio_sources().len(), 2);
        assert_eq!(request.audio_sources()[1].gain, 0.0);
        assert!(request.defer_start);
    }
    #[test]
    fn accepts_legacy_cursor_only_and_output_path_shapes() {
        let cursor: Request = serde_json::from_str("{}").unwrap();
        assert!(cursor.screen_path().is_none());
        assert!(cursor.audio_sources().is_empty());
        assert_eq!(cursor.cursor_mode().unwrap(), portal::CursorMode::Metadata);
        let video: Request =
            serde_json::from_str(r#"{"outputPath":"/tmp/legacy.mp4","cursorMode":"embedded"}"#)
                .unwrap();
        assert_eq!(video.screen_path(), Some("/tmp/legacy.mp4"));
        assert_eq!(video.cursor_mode().unwrap(), portal::CursorMode::Embedded);
    }
    #[test]
    fn rejects_paused_source_cursor_and_output_changes() {
        let current = request();
        let mut next = current.clone();
        next.source = Some(serde_json::json!({"sourceId":"screen:other"}));
        assert!(current
            .validate_reconfigure(&next)
            .unwrap_err()
            .contains("source changes"));
        next = current.clone();
        next.cursor.as_mut().unwrap().mode = "editable-overlay".into();
        assert!(current
            .validate_reconfigure(&next)
            .unwrap_err()
            .contains("cursor mode"));
        next = current.clone();
        next.outputs.as_mut().unwrap().screen_path = "/tmp/other.mp4".into();
        assert!(current.validate_reconfigure(&next).is_err());
    }
    #[test]
    fn accepts_paused_audio_gain_topology_and_encode_updates() {
        let current = request();
        let mut next = current.clone();
        next.video.as_mut().unwrap().fps = Some(30);
        next.video.as_mut().unwrap().bitrate = Some(68000000);
        next.audio.as_mut().unwrap().microphone.gain = Some(2.0);
        assert_eq!(current.audio_topology(), next.audio_topology());
        current
            .validate_reconfigure(&next)
            .expect("gain and encode changes");
        next.audio.as_mut().unwrap().system.enabled = false;
        assert_ne!(current.audio_topology(), next.audio_topology());
        current
            .validate_reconfigure(&next)
            .expect("source enable changes");
    }
    #[test]
    fn invalid_fps_and_gain_fail_instead_of_silently_defaulting() {
        let mut next = request();
        next.video.as_mut().unwrap().fps = Some(0);
        assert!(next.validate().is_err());
        next = request();
        next.audio.as_mut().unwrap().microphone.gain = Some(-1.0);
        assert!(next.validate().is_err());
    }
}

#[cfg(test)]
mod cursor_fallback_tests {
    use super::*;

    #[test]
    fn fallback_survives_reconfigure_and_records_editable_cursor_clips() {
        let mut request: Request = serde_json::from_str(r#"{"cursor":{"mode":"system"}}"#).unwrap();
        let mut next = request.clone();
        let offered = [portal::CursorMode::Metadata];
        assert_eq!(
            request.resolve_cursor_mode(&offered).unwrap(),
            portal::CursorMode::Metadata
        );
        next.resolve_cursor_mode(&offered).unwrap();
        assert!(request.validate_reconfigure(&next).is_ok());
        assert_eq!(request.cursor_mode().unwrap(), portal::CursorMode::Metadata);
    }
}
