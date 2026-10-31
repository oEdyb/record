//! Native multi-clip export audio: FFmpeg decodes source tracks, swresample converts them to
//! planar 48 kHz stereo f32, WSOLA applies speed regions, and one AAC encoder feeds the video
//! muxer.

use crate::ffi::*;
use crate::regions::SpeedSegment;
use anyhow::{bail, Result};
use ebur128::{EbuR128, Mode};
use std::collections::VecDeque;
use std::f32::consts::PI;
use std::ffi::CString;
use std::ptr;

pub const AUDIO_OUTPUT_SAMPLE_RATE: i32 = 48_000;
pub const AUDIO_OUTPUT_CHANNELS: usize = 2;
pub const AUDIO_BITRATE: i64 = 384_000;
// Ten milliseconds at 48 kHz. This short equal-power fade removes clicks at
// structural cuts without making speech boundaries sound softened.
pub const AUDIO_BOUNDARY_FADE_SAMPLES: usize = 480;
pub const DEFAULT_TARGET_LUFS: f64 = -14.5;
pub const MIN_TARGET_LUFS: f64 = -30.0;
pub const MAX_TARGET_LUFS: f64 = -9.0;
pub const DEFAULT_TRUE_PEAK_CEILING_DBTP: f64 = -2.0;
pub const MIN_TRUE_PEAK_CEILING_DBTP: f64 = -6.0;
pub const MAX_TRUE_PEAK_CEILING_DBTP: f64 = -1.0;
const MAX_AUTOMATIC_GAIN_DB: f64 = 12.0;
const MAX_CLIP_DIALOGUE_GAIN_DB: f64 = 6.0;
const MIN_DIALOGUE_LUFS: f64 = -50.0;
const CLIP_DIALOGUE_TRUE_PEAK_HEADROOM_DBTP: f64 = -1.0;
const LIMITER_LOOKAHEAD_MS: f64 = 5.0;
const LIMITER_ATTACK_MS: f64 = 1.0;
const LIMITER_RELEASE_MS: f64 = 120.0;
const PREVIEW_MIX_TRACK_TITLE: &str = "screenrec.mix.v1";
const SYSTEM_TRACK_TITLE: &str = "screenrec.system.v1";
const MICROPHONE_TRACK_TITLE: &str = "screenrec.microphone.v1";
const PREVIEW_MIX_TRACK_LANGUAGE: &str = "qaa";
const SYSTEM_TRACK_LANGUAGE: &str = "qab";
const MICROPHONE_TRACK_LANGUAGE: &str = "qac";

// Valeurs partagées : `AVERROR(EAGAIN)` dépend de la plateforme (-11 vs -35), et ce
// module est compilé sur les deux. Cf. `crate::ffi`.
use crate::ffi::{AVERROR_EAGAIN, AVERROR_EOF};
const AVSEEK_FLAG_BACKWARD: i32 = 1;
const DEFAULT_FRAME_SEC: f64 = 0.04;
const MIN_FRAME_SEC: f64 = 0.005;
const DEFAULT_SEARCH_SEC: f64 = 0.01;
const TARGET_GRAINS: usize = 8;
const PASSTHROUGH_EPSILON: f64 = 1e-3;

pub type PlanarPcm = Vec<Vec<f32>>;

#[path = "audio_spool.rs"]
pub(crate) mod spool;

#[path = "audio_overlay.rs"]
pub mod overlays;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AudioMasteringSettings {
    enabled: bool,
    target_lufs: f64,
    true_peak_ceiling_dbtp: f64,
}

impl AudioMasteringSettings {
    pub fn new(enabled: bool, target_lufs: f64, true_peak_ceiling_dbtp: f64) -> Self {
        let target_lufs = if target_lufs.is_finite() {
            target_lufs.clamp(MIN_TARGET_LUFS, MAX_TARGET_LUFS)
        } else {
            DEFAULT_TARGET_LUFS
        };
        let true_peak_ceiling_dbtp = if true_peak_ceiling_dbtp.is_finite() {
            true_peak_ceiling_dbtp.clamp(MIN_TRUE_PEAK_CEILING_DBTP, MAX_TRUE_PEAK_CEILING_DBTP)
        } else {
            DEFAULT_TRUE_PEAK_CEILING_DBTP
        };
        Self {
            enabled,
            target_lufs,
            true_peak_ceiling_dbtp,
        }
    }
}

impl Default for AudioMasteringSettings {
    fn default() -> Self {
        Self::new(true, DEFAULT_TARGET_LUFS, DEFAULT_TRUE_PEAK_CEILING_DBTP)
    }
}

/// Source stems kept separate until clip-level dialogue matching is complete.
/// Old recordings have only `bed`; tagged ScreenRec recordings put the mic in
/// `microphone`, so system audio never moves when dialogue is corrected.
pub struct DecodedClipAudio {
    bed: Option<PlanarPcm>,
    microphone: Option<PlanarPcm>,
}

impl DecodedClipAudio {
    pub fn into_mixed(self) -> PlanarPcm {
        match (self.bed, self.microphone) {
            (Some(bed), Some(microphone)) => {
                let sample_count = bed
                    .iter()
                    .chain(microphone.iter())
                    .map(Vec::len)
                    .max()
                    .unwrap_or(0);
                mix_aligned_tracks(&[(0.0, &bed), (0.0, &microphone)], 0.0, sample_count)
            }
            (Some(bed), None) => bed,
            (None, Some(microphone)) => microphone,
            (None, None) => vec![Vec::new(); AUDIO_OUTPUT_CHANNELS],
        }
    }
}

fn replace_microphone(raw: &mut DecodedClipAudio, clean: DecodedClipAudio) -> bool {
    let replacement = clean.microphone.or(clean.bed);
    if let Some(replacement) = replacement {
        raw.microphone = Some(replacement);
        true
    } else {
        false
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ClipDialogueAdjustment {
    pub input_lufs: f64,
    pub reference_lufs: f64,
    pub applied_gain_db: f64,
    pub limited_by_gain_cap: bool,
    pub limited_by_true_peak: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct AudioMasteringStats {
    pub enabled: bool,
    pub analyzed: bool,
    pub applied_gain_db: f64,
    pub input_lufs: Option<f64>,
    pub output_lufs: Option<f64>,
    pub input_true_peak_dbtp: Option<f64>,
    pub output_true_peak_dbtp: Option<f64>,
    pub limited_by_true_peak: bool,
    pub limited_by_gain_cap: bool,
    pub warning: Option<String>,
}

impl AudioMasteringStats {
    pub(crate) fn disabled() -> Self {
        Self {
            enabled: false,
            analyzed: false,
            applied_gain_db: 0.0,
            input_lufs: None,
            output_lufs: None,
            input_true_peak_dbtp: None,
            output_true_peak_dbtp: None,
            limited_by_true_peak: false,
            limited_by_gain_cap: false,
            warning: None,
        }
    }

    fn skipped(warning: String) -> Self {
        Self {
            enabled: true,
            warning: Some(warning),
            ..Self::disabled()
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct AudioMeasurement {
    integrated_lufs: f64,
    true_peak_dbtp: f64,
}

fn measure_program_audio(pcm: &PlanarPcm) -> std::result::Result<AudioMeasurement, String> {
    let frame_count = pcm
        .iter()
        .take(AUDIO_OUTPUT_CHANNELS)
        .map(Vec::len)
        .min()
        .unwrap_or(0);
    if pcm.len() < AUDIO_OUTPUT_CHANNELS
        || frame_count < (AUDIO_OUTPUT_SAMPLE_RATE as usize * 4 / 10)
    {
        return Err("Audio is shorter than the 400 ms EBU R128 analysis window.".to_string());
    }

    let mut analyzer = EbuR128::new(
        AUDIO_OUTPUT_CHANNELS as u32,
        AUDIO_OUTPUT_SAMPLE_RATE as u32,
        Mode::I | Mode::TRUE_PEAK,
    )
    .map_err(|error| format!("Could not start EBU R128 analysis: {error}"))?;
    let planes: Vec<&[f32]> = pcm
        .iter()
        .take(AUDIO_OUTPUT_CHANNELS)
        .map(|plane| &plane[..frame_count])
        .collect();
    analyzer
        .add_frames_planar_f32(&planes)
        .map_err(|error| format!("Could not analyze audio: {error}"))?;
    let integrated_lufs = analyzer
        .loudness_global()
        .map_err(|error| format!("Could not measure integrated loudness: {error}"))?;
    if !integrated_lufs.is_finite() {
        return Err("Audio is silent, so integrated loudness is undefined.".to_string());
    }

    let true_peak = (0..AUDIO_OUTPUT_CHANNELS)
        .filter_map(|channel| analyzer.true_peak(channel as u32).ok())
        .fold(0.0_f64, f64::max);
    let true_peak_dbtp = if true_peak > 0.0 {
        20.0 * true_peak.log10()
    } else {
        f64::NEG_INFINITY
    };
    Ok(AudioMeasurement {
        integrated_lufs,
        true_peak_dbtp,
    })
}

fn required_limiter_gain(pcm: &PlanarPcm, frame: usize, ceiling: f32) -> f32 {
    let peak = pcm
        .iter()
        .take(AUDIO_OUTPUT_CHANNELS)
        .map(|plane| plane[frame].abs())
        .fold(0.0_f32, f32::max);
    if peak > ceiling {
        ceiling / peak
    } else {
        1.0
    }
}

fn enqueue_limiter_gain(queue: &mut VecDeque<(usize, f32)>, frame: usize, gain: f32) {
    while queue.back().is_some_and(|(_, queued)| *queued >= gain) {
        queue.pop_back();
    }
    queue.push_back((frame, gain));
}

/// Applies a stereo-linked offline peak limiter with bounded look-ahead memory. The shared gain
/// envelope preserves channel balance and releases slowly enough to avoid a hard clip. A final
/// EBU R128 true-peak measurement still guards inter-sample peaks.
fn apply_peak_limiter(pcm: &mut PlanarPcm, ceiling_dbtp: f64) -> bool {
    let frame_count = pcm
        .iter()
        .take(AUDIO_OUTPUT_CHANNELS)
        .map(Vec::len)
        .min()
        .unwrap_or(0);
    if pcm.len() < AUDIO_OUTPUT_CHANNELS || frame_count == 0 {
        return false;
    }

    let ceiling = 10.0_f32.powf((ceiling_dbtp / 20.0) as f32);
    let lookahead_frames = (LIMITER_LOOKAHEAD_MS * 0.001 * AUDIO_OUTPUT_SAMPLE_RATE as f64)
        .round()
        .max(1.0) as usize;
    let attack_coefficient =
        1.0 - (-1.0 / (LIMITER_ATTACK_MS * 0.001 * AUDIO_OUTPUT_SAMPLE_RATE as f64)).exp();
    let release_coefficient =
        1.0 - (-1.0 / (LIMITER_RELEASE_MS * 0.001 * AUDIO_OUTPUT_SAMPLE_RATE as f64)).exp();
    let mut lookahead_minima = VecDeque::with_capacity(lookahead_frames + 1);
    let initial_end = frame_count.min(lookahead_frames + 1);
    let mut engaged = false;
    for frame in 0..initial_end {
        let gain = required_limiter_gain(pcm, frame, ceiling);
        engaged |= gain < 1.0;
        enqueue_limiter_gain(&mut lookahead_minima, frame, gain);
    }

    let mut applied_gain = lookahead_minima
        .front()
        .map(|(_, gain)| *gain)
        .unwrap_or(1.0);
    for frame in 0..frame_count {
        while lookahead_minima
            .front()
            .is_some_and(|(queued_frame, _)| *queued_frame < frame)
        {
            lookahead_minima.pop_front();
        }
        let required_gain = lookahead_minima
            .front()
            .map(|(_, gain)| *gain)
            .unwrap_or(1.0);
        applied_gain = if required_gain < applied_gain - f32::EPSILON {
            applied_gain + ((required_gain - applied_gain) * attack_coefficient as f32)
        } else if required_gain > applied_gain + f32::EPSILON {
            applied_gain + ((1.0 - applied_gain) * release_coefficient as f32)
        } else {
            applied_gain
        };
        for plane in pcm.iter_mut().take(AUDIO_OUTPUT_CHANNELS) {
            plane[frame] *= applied_gain;
        }

        let next_frame = frame + lookahead_frames + 1;
        if next_frame < frame_count {
            let gain = required_limiter_gain(pcm, next_frame, ceiling);
            engaged |= gain < 1.0;
            enqueue_limiter_gain(&mut lookahead_minima, next_frame, gain);
        }
    }

    engaged
}

fn apply_uniform_gain(pcm: &mut PlanarPcm, gain_db: f64) {
    if gain_db.abs() < 0.01 {
        return;
    }
    let gain = 10.0_f32.powf((gain_db / 20.0) as f32);
    for plane in pcm.iter_mut().take(AUDIO_OUTPUT_CHANNELS) {
        for sample in plane {
            *sample *= gain;
        }
    }
}

/// Matches speech-bearing microphone stems to the median clip level. This is
/// not per-clip target normalization: the recording stays at its natural
/// overall level, while only large clip-to-clip voice jumps are reduced.
pub fn match_clip_dialogue_levels(
    clips: &mut [Option<DecodedClipAudio>],
    enabled: bool,
) -> Vec<Option<ClipDialogueAdjustment>> {
    let mut adjustments = vec![None; clips.len()];
    if !enabled {
        return adjustments;
    }

    let measured = clips
        .iter()
        .enumerate()
        .filter_map(|(index, clip)| {
            let microphone = clip.as_ref()?.microphone.as_ref()?;
            let measurement = measure_program_audio(microphone).ok()?;
            (measurement.integrated_lufs >= MIN_DIALOGUE_LUFS).then_some((index, measurement))
        })
        .collect::<Vec<_>>();
    if measured.len() < 2 {
        return adjustments;
    }

    let mut loudness = measured
        .iter()
        .map(|(_, measurement)| measurement.integrated_lufs)
        .collect::<Vec<_>>();
    loudness.sort_by(f64::total_cmp);
    let midpoint = loudness.len() / 2;
    let reference_lufs = if loudness.len() % 2 == 0 {
        (loudness[midpoint - 1] + loudness[midpoint]) / 2.0
    } else {
        loudness[midpoint]
    };

    for (index, measurement) in measured {
        let requested_gain_db = reference_lufs - measurement.integrated_lufs;
        let capped_gain_db =
            requested_gain_db.clamp(-MAX_CLIP_DIALOGUE_GAIN_DB, MAX_CLIP_DIALOGUE_GAIN_DB);
        let true_peak_headroom_db =
            (CLIP_DIALOGUE_TRUE_PEAK_HEADROOM_DBTP - measurement.true_peak_dbtp).max(0.0);
        let applied_gain_db = if capped_gain_db > 0.0 {
            capped_gain_db.min(true_peak_headroom_db)
        } else {
            capped_gain_db
        };
        if applied_gain_db.abs() >= 0.01 {
            let gain = 10.0_f32.powf((applied_gain_db / 20.0) as f32);
            if let Some(microphone) = clips[index]
                .as_mut()
                .and_then(|clip| clip.microphone.as_mut())
            {
                for plane in microphone.iter_mut().take(AUDIO_OUTPUT_CHANNELS) {
                    for sample in plane {
                        *sample *= gain;
                    }
                }
            }
        }
        adjustments[index] = Some(ClipDialogueAdjustment {
            input_lufs: measurement.integrated_lufs,
            reference_lufs,
            applied_gain_db,
            limited_by_gain_cap: (capped_gain_db - requested_gain_db).abs() >= 0.01,
            limited_by_true_peak: applied_gain_db + 0.01 < capped_gain_db,
        });
    }
    adjustments
}

/// Measures and masters the fully edited program. Capture files stay unchanged. A bounded
/// make-up gain raises normal dialogue, an offline linked limiter controls short peaks, and a
/// final true-peak trim protects the output ceiling.
pub fn master_program_audio(
    pcm: &mut PlanarPcm,
    settings: AudioMasteringSettings,
) -> AudioMasteringStats {
    if !settings.enabled {
        return AudioMasteringStats::disabled();
    }
    let input = match measure_program_audio(pcm) {
        Ok(measurement) => measurement,
        Err(warning) => return AudioMasteringStats::skipped(warning),
    };

    let requested_gain_db = settings.target_lufs - input.integrated_lufs;
    let mut applied_gain_db = requested_gain_db.min(MAX_AUTOMATIC_GAIN_DB);
    apply_uniform_gain(pcm, applied_gain_db);

    let mut limiter_engaged = apply_peak_limiter(pcm, settings.true_peak_ceiling_dbtp);
    let mut after_limiter = measure_program_audio(pcm).unwrap_or(input);
    for _ in 0..2 {
        let remaining_gain_db = MAX_AUTOMATIC_GAIN_DB - applied_gain_db;
        let residual_gain_db = (settings.target_lufs - after_limiter.integrated_lufs)
            .max(0.0)
            .min(remaining_gain_db);
        if residual_gain_db < 0.05 {
            break;
        }
        apply_uniform_gain(pcm, residual_gain_db);
        applied_gain_db += residual_gain_db;
        limiter_engaged |= apply_peak_limiter(pcm, settings.true_peak_ceiling_dbtp);
        after_limiter = measure_program_audio(pcm).unwrap_or(after_limiter);
    }
    let true_peak_trim_db = if after_limiter.true_peak_dbtp > settings.true_peak_ceiling_dbtp {
        settings.true_peak_ceiling_dbtp - after_limiter.true_peak_dbtp
    } else {
        0.0
    };
    if true_peak_trim_db < -0.01 {
        apply_uniform_gain(pcm, true_peak_trim_db);
    }

    let output = measure_program_audio(pcm).unwrap_or(input);
    let limited_by_true_peak = limiter_engaged || true_peak_trim_db < -0.01;
    let missed_target = output.integrated_lufs < settings.target_lufs - 0.5;
    let limited_by_gain_cap = missed_target && applied_gain_db >= MAX_AUTOMATIC_GAIN_DB - 0.01;
    let warning = if limited_by_gain_cap && missed_target {
        Some(format!(
            "Normalization stopped at the {MAX_AUTOMATIC_GAIN_DB:.0} dB automatic gain limit."
        ))
    } else if limited_by_true_peak && missed_target {
        Some(format!(
            "Normalization stopped below {:.1} LUFS to keep pre-encode true peaks at or below {:.1} dBTP.",
            settings.target_lufs, settings.true_peak_ceiling_dbtp
        ))
    } else {
        None
    };

    AudioMasteringStats {
        enabled: true,
        analyzed: true,
        applied_gain_db,
        input_lufs: Some(input.integrated_lufs),
        output_lufs: Some(output.integrated_lufs),
        input_true_peak_dbtp: input
            .true_peak_dbtp
            .is_finite()
            .then_some(input.true_peak_dbtp),
        output_true_peak_dbtp: output
            .true_peak_dbtp
            .is_finite()
            .then_some(output.true_peak_dbtp),
        limited_by_true_peak,
        limited_by_gain_cap,
        warning,
    }
}

extern "C" {
    fn sn_fmt_stream(s: *mut AVFormatContext, i: i32) -> *mut AVStream;
    // bindgen rend `AVFormatContext` opaque (atteinte seulement par pointeur), d'où l'accesseur
    // compilé contre les vrais headers — voir shim.c.
    fn sn_fmt_nb_streams(s: *mut AVFormatContext) -> u32;
    fn sn_fmt_stream_metadata(
        s: *mut AVFormatContext,
        i: i32,
        key: *const std::ffi::c_char,
    ) -> *const std::ffi::c_char;
}

fn is_source_track(title: Option<&str>, language: Option<&str>) -> bool {
    matches!(title, Some(SYSTEM_TRACK_TITLE | MICROPHONE_TRACK_TITLE))
        || matches!(
            language,
            Some(SYSTEM_TRACK_LANGUAGE | MICROPHONE_TRACK_LANGUAGE)
        )
}

fn is_microphone_track(title: Option<&str>, language: Option<&str>) -> bool {
    title == Some(MICROPHONE_TRACK_TITLE) || language == Some(MICROPHONE_TRACK_LANGUAGE)
}

fn should_decode_audio_track(
    title: Option<&str>,
    language: Option<&str>,
    has_source_tracks: bool,
) -> bool {
    !has_source_tracks
        || (title != Some(PREVIEW_MIX_TRACK_TITLE) && language != Some(PREVIEW_MIX_TRACK_LANGUAGE))
}

unsafe fn audio_track_tag(fmt: *mut AVFormatContext, index: i32, key: &[u8]) -> Option<String> {
    let value = sn_fmt_stream_metadata(fmt, index, key.as_ptr() as *const std::ffi::c_char);
    (!value.is_null()).then(|| {
        std::ffi::CStr::from_ptr(value)
            .to_string_lossy()
            .into_owned()
    })
}

fn averr(ret: i32, ctx: &str) -> Result<()> {
    if ret < 0 {
        // Surtout pas `[0i8; 256]` : `c_char` est signé sur x86_64 mais NON SIGNÉ sur
        // aarch64, donc un i8 en dur fait du `*mut c_char` d'av_strerror une erreur de
        // type sur arm64.
        let mut buf = [0 as std::ffi::c_char; 256];
        unsafe { av_strerror(ret, buf.as_mut_ptr(), buf.len()) };
        let msg = unsafe { std::ffi::CStr::from_ptr(buf.as_ptr()) }.to_string_lossy();
        bail!("{ctx}: {ret} ({msg})");
    }
    Ok(())
}

struct AudioResampler {
    ctx: *mut SwrContext,
    input_rate: i32,
}

impl AudioResampler {
    unsafe fn from_frame(frame: *mut AVFrame, dctx: *mut AVCodecContext) -> Result<Self> {
        let mut output_layout = AVChannelLayout::default();
        av_channel_layout_default(&mut output_layout, AUDIO_OUTPUT_CHANNELS as i32);

        let mut fallback_layout = AVChannelLayout::default();
        let input_layout = if (*frame).ch_layout.nb_channels > 0 {
            &(*frame).ch_layout as *const AVChannelLayout
        } else if (*dctx).ch_layout.nb_channels > 0 {
            &(*dctx).ch_layout as *const AVChannelLayout
        } else {
            av_channel_layout_default(&mut fallback_layout, 1);
            &fallback_layout as *const AVChannelLayout
        };
        let input_rate = if (*frame).sample_rate > 0 {
            (*frame).sample_rate
        } else {
            (*dctx).sample_rate
        };
        if input_rate <= 0 {
            av_channel_layout_uninit(&mut output_layout);
            av_channel_layout_uninit(&mut fallback_layout);
            bail!("fréquence audio source invalide");
        }

        let mut ctx: *mut SwrContext = ptr::null_mut();
        let ret = swr_alloc_set_opts2(
            &mut ctx,
            &output_layout,
            AVSampleFormat::AV_SAMPLE_FMT_FLTP,
            AUDIO_OUTPUT_SAMPLE_RATE,
            input_layout,
            (*frame).format as AVSampleFormat::Type,
            input_rate,
            0,
            ptr::null_mut(),
        );
        av_channel_layout_uninit(&mut output_layout);
        av_channel_layout_uninit(&mut fallback_layout);
        averr(ret, "swr_alloc_set_opts2")?;
        if ctx.is_null() {
            bail!("swr_alloc_set_opts2: contexte nul");
        }
        averr(swr_init(ctx), "swr_init")?;
        Ok(Self { ctx, input_rate })
    }

    unsafe fn push(&mut self, frame: *mut AVFrame, output: &mut PlanarPcm) -> Result<()> {
        let out_capacity = swr_get_out_samples(self.ctx, (*frame).nb_samples).max(1) as usize;
        let mut planes = vec![vec![0.0f32; out_capacity]; AUDIO_OUTPUT_CHANNELS];
        let mut output_ptrs: Vec<*mut u8> = planes
            .iter_mut()
            .map(|plane| plane.as_mut_ptr() as *mut u8)
            .collect();
        let input_ptrs = (*frame).extended_data as *const *const u8;
        let converted = swr_convert(
            self.ctx,
            output_ptrs.as_mut_ptr(),
            out_capacity as i32,
            input_ptrs,
            (*frame).nb_samples,
        );
        averr(converted, "swr_convert")?;
        for channel in 0..AUDIO_OUTPUT_CHANNELS {
            planes[channel].truncate(converted as usize);
            output[channel].extend_from_slice(&planes[channel]);
        }
        Ok(())
    }

    unsafe fn flush(&mut self, output: &mut PlanarPcm) -> Result<()> {
        loop {
            let delay = swr_get_delay(self.ctx, self.input_rate as i64);
            if delay <= 0 {
                break;
            }
            let out_capacity =
                (((delay * AUDIO_OUTPUT_SAMPLE_RATE as i64) + self.input_rate as i64 - 1)
                    / self.input_rate as i64
                    + 32) as usize;
            let mut planes = vec![vec![0.0f32; out_capacity]; AUDIO_OUTPUT_CHANNELS];
            let mut output_ptrs: Vec<*mut u8> = planes
                .iter_mut()
                .map(|plane| plane.as_mut_ptr() as *mut u8)
                .collect();
            let converted = swr_convert(
                self.ctx,
                output_ptrs.as_mut_ptr(),
                out_capacity as i32,
                ptr::null(),
                0,
            );
            averr(converted, "swr_convert(flush)")?;
            if converted == 0 {
                break;
            }
            for channel in 0..AUDIO_OUTPUT_CHANNELS {
                planes[channel].truncate(converted as usize);
                output[channel].extend_from_slice(&planes[channel]);
            }
        }
        Ok(())
    }
}

impl Drop for AudioResampler {
    fn drop(&mut self) {
        unsafe { swr_free(&mut self.ctx) };
    }
}

/// Un décodeur + resampler par piste audio du conteneur, tous alimentés par la même passe de
/// démux. Chaque piste produit du f32 planaire 48 kHz stéréo recadré sur la même fenêtre
/// source, si bien que le mixage final est une simple somme échantillon par échantillon.
struct AudioTrackDecoder {
    stream_index: i32,
    dctx: *mut AVCodecContext,
    tb_sec: f64,
    resampler: Option<AudioResampler>,
    decoded: spool::PcmSpool,
    origin_sec: Option<f64>,
    reached_end: bool,
    decoder_eof: bool,
    microphone: bool,
}

impl Drop for AudioTrackDecoder {
    fn drop(&mut self) {
        unsafe { avcodec_free_context(&mut self.dctx) };
    }
}

/// Décode uniquement la fenêtre source conservée. Le seek audio retombe sur une trame
/// antérieure ; l'origine pts du premier bloc resamplé permet ensuite de couper précisément la
/// prélecture sans supposer que la piste commence à t=0.
///
/// All legacy audio tracks are decoded and mixed. New macOS clips contain an HTML preview mix
/// plus tagged source tracks. In that case, ignore the preview mix because summing all three
/// tracks would double each source. Untagged tracks keep the legacy multi-track behavior
/// from issue #108.
pub fn decode_clip_audio(
    path: &str,
    source_start_sec: f64,
    source_end_sec: f64,
) -> Result<Option<DecodedClipAudio>> {
    unsafe {
        decode_clip_audio_inner(path, source_start_sec, source_end_sec, &mut || Ok(()))?
            .map(spool::SpoolClip::into_memory)
            .transpose()
    }
}

/// Decode the untouched bed from the recording and replace only its tagged microphone.
/// A missing or unreadable derived stem falls back to the complete raw clip. This keeps
/// preview/export activation reversible and prevents a partial clean route from dropping
/// system audio or silencing dialogue.
pub fn decode_clip_audio_with_clean_microphone(
    path: &str,
    clean_microphone_path: Option<&str>,
    source_start_sec: f64,
    source_end_sec: f64,
) -> Result<Option<DecodedClipAudio>> {
    let Some(mut raw) = decode_clip_audio(path, source_start_sec, source_end_sec)? else {
        return Ok(None);
    };
    let Some(clean_path) = clean_microphone_path else {
        return Ok(Some(raw));
    };
    match decode_clip_audio(clean_path, source_start_sec, source_end_sec) {
        Ok(Some(clean)) => {
            if !replace_microphone(&mut raw, clean) {
                eprintln!(
                    "[audio] Clean Voice stem has no decodable audio; raw microphone retained"
                );
            }
        }
        Ok(None) => {
            eprintln!("[audio] Clean Voice stem has no audio stream; raw microphone retained")
        }
        Err(error) => eprintln!(
            "[audio] Clean Voice stem failed validation ({error:#}); raw microphone retained"
        ),
    }
    Ok(Some(raw))
}

#[derive(Default)]
struct AudioDecodeResources {
    fmt: *mut AVFormatContext,
    packet: *mut AVPacket,
    frame: *mut AVFrame,
}

impl Drop for AudioDecodeResources {
    fn drop(&mut self) {
        unsafe {
            av_frame_free(&mut self.frame);
            av_packet_free(&mut self.packet);
            avformat_close_input(&mut self.fmt);
        }
    }
}

unsafe fn decode_clip_audio_inner(
    path: &str,
    source_start_sec: f64,
    source_end_sec: f64,
    check: &mut dyn FnMut() -> Result<()>,
) -> Result<Option<spool::SpoolClip>> {
    let mut resources = AudioDecodeResources::default();
    let cpath = CString::new(path)?;
    averr(
        avformat_open_input(
            &mut resources.fmt,
            cpath.as_ptr(),
            ptr::null_mut(),
            ptr::null_mut(),
        ),
        "audio open_input",
    )?;
    let fmt = resources.fmt;
    averr(
        avformat_find_stream_info(fmt, ptr::null_mut()),
        "audio find_stream_info",
    )?;
    // Enumerate first so preview-mix filtering knows whether any tagged source track exists.
    let mut audio_streams = Vec::new();
    for index in 0..sn_fmt_nb_streams(fmt) as i32 {
        let stream = sn_fmt_stream(fmt, index);
        if (*(*stream).codecpar).codec_type == AVMediaType::AVMEDIA_TYPE_AUDIO {
            audio_streams.push((
                index,
                audio_track_tag(fmt, index, b"title\0"),
                audio_track_tag(fmt, index, b"language\0"),
            ));
        }
    }
    let audio_stream_count = audio_streams.len();
    let has_source_tracks = audio_streams
        .iter()
        .any(|(_, title, language)| is_source_track(title.as_deref(), language.as_deref()));
    let mut tracks: Vec<AudioTrackDecoder> = Vec::new();
    for (index, title, language) in audio_streams {
        if !should_decode_audio_track(title.as_deref(), language.as_deref(), has_source_tracks) {
            continue;
        }
        let stream = sn_fmt_stream(fmt, index);
        let codecpar = (*stream).codecpar;
        // Une piste qu'on ne sait pas ouvrir est ignorée, pas fatale : avant ce mixage une
        // seule piste était ouverte, donc une piste annexe exotique ne pouvait pas casser un
        // export. Le `bail!` plus bas garantit qu'on ne perd pas l'audio en silence pour
        // autant — c'est précisément le défaut qu'on corrige ici.
        let decoder = avcodec_find_decoder((*codecpar).codec_id);
        if decoder.is_null() {
            continue;
        }
        let decoded = spool::PcmSpool::new()?;
        let mut dctx = avcodec_alloc_context3(decoder);
        if dctx.is_null() {
            bail!("audio avcodec_alloc_context3");
        }
        if avcodec_parameters_to_context(dctx, codecpar) < 0
            || avcodec_open2(dctx, decoder, ptr::null_mut()) < 0
        {
            avcodec_free_context(&mut dctx);
            continue;
        }
        let time_base = (*stream).time_base;
        tracks.push(AudioTrackDecoder {
            stream_index: index,
            dctx,
            tb_sec: if time_base.den != 0 {
                time_base.num as f64 / time_base.den as f64
            } else {
                0.0
            },
            resampler: None,
            decoded,
            origin_sec: None,
            reached_end: false,
            decoder_eof: false,
            microphone: is_microphone_track(title.as_deref(), language.as_deref()),
        });
    }
    if tracks.is_empty() {
        if audio_stream_count > 0 {
            bail!("audio : {audio_stream_count} piste(s) présentes, aucune décodable");
        }
        return Ok(None);
    }

    // Un seul seek : il repositionne le conteneur entier. On le cale sur la première piste
    // audio puis on vide tous les décodeurs. Si une autre piste reprend légèrement après le
    // début de la fenêtre demandée, son recadrage (plus bas) la zéro-padde devant — le
    // décalage inter-pistes est absorbé là, pas ici.
    let seek_tb_sec = tracks[0].tb_sec;
    let seek_stream_index = tracks[0].stream_index;
    if seek_tb_sec > 0.0 {
        let target = (source_start_sec / seek_tb_sec).floor() as i64;
        if av_seek_frame(fmt, seek_stream_index, target, AVSEEK_FLAG_BACKWARD) >= 0 {
            for track in tracks.iter_mut() {
                avcodec_flush_buffers(track.dctx);
            }
        }
    }

    resources.packet = av_packet_alloc();
    resources.frame = av_frame_alloc();
    let packet = resources.packet;
    let frame = resources.frame;
    anyhow::ensure!(
        !packet.is_null() && !frame.is_null(),
        "audio packet/frame allocation failed"
    );
    let mut input_eof = false;

    // Une seule passe de démux alimente tous les décodeurs : chaque paquet est routé vers la
    // piste dont il porte l'index. On continue tant qu'AU MOINS une piste a encore quelque
    // chose à produire.
    while tracks.iter().any(|t| !t.reached_end && !t.decoder_eof) {
        check()?;
        if !input_eof {
            let read = av_read_frame(fmt, packet);
            if read == AVERROR_EOF {
                for track in tracks.iter_mut() {
                    avcodec_send_packet(track.dctx, ptr::null());
                }
                input_eof = true;
            } else {
                averr(read, "audio av_read_frame")?;
                let packet_stream = (*packet).stream_index;
                if let Some(track) = tracks
                    .iter_mut()
                    .find(|t| t.stream_index == packet_stream && !t.reached_end)
                {
                    averr(avcodec_send_packet(track.dctx, packet), "audio send_packet")?;
                }
                av_packet_unref(packet);
            }
        }

        for track in tracks.iter_mut() {
            if track.reached_end || track.decoder_eof {
                continue;
            }
            loop {
                let ret = avcodec_receive_frame(track.dctx, frame);
                if ret == AVERROR_EOF {
                    track.decoder_eof = true;
                    break;
                }
                if ret == AVERROR_EAGAIN {
                    if input_eof {
                        track.decoder_eof = true;
                    }
                    break;
                }
                averr(ret, "audio receive_frame")?;

                let pts = (*frame).best_effort_timestamp;
                let frame_sec = if pts != i64::MIN && track.tb_sec > 0.0 {
                    pts as f64 * track.tb_sec
                } else {
                    track.origin_sec.unwrap_or(source_start_sec)
                };
                if frame_sec >= source_end_sec {
                    track.reached_end = true;
                    av_frame_unref(frame);
                    break;
                }
                if track.origin_sec.is_none() {
                    track.origin_sec = Some(frame_sec);
                }
                if track.resampler.is_none() {
                    track.resampler = Some(AudioResampler::from_frame(frame, track.dctx)?);
                }
                let mut block = vec![Vec::new(); AUDIO_OUTPUT_CHANNELS];
                track.resampler.as_mut().unwrap().push(frame, &mut block)?;
                track.decoded.append(&block)?;
                av_frame_unref(frame);
            }
        }
    }

    for track in tracks.iter_mut() {
        if let Some(r) = track.resampler.as_mut() {
            let mut block = vec![Vec::new(); AUDIO_OUTPUT_CHANNELS];
            r.flush(&mut block)?;
            track.decoded.append(&block)?;
        }
    }

    let target_samples = (((source_end_sec - source_start_sec).max(0.0)
        * AUDIO_OUTPUT_SAMPLE_RATE as f64)
        .round()) as usize;
    spool::align_tracks(&mut tracks, source_start_sec, target_samples, check).map(Some)
}

/// Recadre chaque piste sur la MÊME fenêtre (`target_samples` échantillons à partir de
/// `source_start_sec`) puis les somme. Une piste dont le premier paquet décodé arrive après le
/// début de la fenêtre est zéro-paddée devant ; la prélecture d'une piste décodée trop tôt (le
/// seek retombe sur une trame antérieure) est coupée. C'est ce recadrage qui absorbe les
/// décalages de départ entre pistes, si bien que le mixage lui-même n'est qu'une somme.
///
/// Séparé du décodage pour être testable sans ffmpeg.
fn mix_aligned_tracks(
    tracks: &[(f64, &PlanarPcm)],
    source_start_sec: f64,
    target_samples: usize,
) -> PlanarPcm {
    let mut mixed = vec![vec![0.0f32; target_samples]; AUDIO_OUTPUT_CHANNELS];
    for &(origin_sec, decoded) in tracks {
        let relative_start =
            ((source_start_sec - origin_sec) * AUDIO_OUTPUT_SAMPLE_RATE as f64).round() as i64;
        let (src_start, dst_start) = if relative_start >= 0 {
            (relative_start as usize, 0usize)
        } else {
            (0usize, (-relative_start) as usize)
        };
        for channel in 0..AUDIO_OUTPUT_CHANNELS {
            if src_start >= decoded[channel].len() || dst_start >= target_samples {
                continue;
            }
            let count = (decoded[channel].len() - src_start).min(target_samples - dst_start);
            for offset in 0..count {
                mixed[channel][dst_start + offset] += decoded[channel][src_start + offset];
            }
        }
    }
    // Sommer plusieurs pistes peut dépasser la pleine échelle : on écrête. Sur une source
    // mono-piste, sommer dans un buffer nul est l'identité et on n'écrête pas — le comportement
    // d'avant ce mixage est conservé tel quel.
    if tracks.len() > 1 {
        for plane in mixed.iter_mut() {
            for sample in plane.iter_mut() {
                *sample = sample.clamp(-1.0, 1.0);
            }
        }
    }
    mixed
}

fn hann(length: usize) -> Vec<f32> {
    let mut window = vec![0.0; length];
    for (i, value) in window.iter_mut().enumerate() {
        *value = 0.5 - 0.5 * ((2.0 * PI * i as f32) / (length - 1) as f32).cos();
    }
    window
}

/// Port direct du WSOLA web. Tous les canaux partagent les positions choisies sur un downmix
/// mono, sinon deux recherches indépendantes déplaceraient l'image stéréo.
pub struct WsolaTimeStretcher {
    channels: usize,
    passthrough: bool,
    n: usize,
    hs: usize,
    ha: f64,
    search_radius: i64,
    window: Vec<f32>,
    buf: PlanarPcm,
    mono: Vec<f32>,
    buf_start: i64,
    /// Décalage de lecture dans `buf`/`mono`. `discard_below` ne recopiait pas moins que le
    /// reste du buffer à chaque grain : la région entière est poussée d'un coup, donc pour
    /// 65 M d'échantillons cela faisait ~N²/(2·ha) ≈ 1,1e12 f32 recopiés par canal — le vrai
    /// coût du chemin WSOLA, devant la recherche par grain. On avance un curseur et on ne
    /// compacte que lorsque la tête dépasse la moitié du buffer, ce qui rend le total O(N).
    buf_head: usize,
    out: PlanarPcm,
    win_sum: Vec<f32>,
    out_start: usize,
    ideal_pos: f64,
    grain_pos: i64,
    frame: usize,
    placed_any: bool,
}

impl WsolaTimeStretcher {
    pub fn new(
        sample_rate: i32,
        channels: usize,
        speed: f64,
        expected_output_samples: usize,
    ) -> Self {
        let channels = channels.max(1);
        let passthrough = (speed - 1.0).abs() < PASSTHROUGH_EPSILON;
        let mut n = (sample_rate as f64 * DEFAULT_FRAME_SEC).round() as usize;
        n = n.max(4);
        if n % 2 != 0 {
            n += 1;
        }
        let mut hs = n / 2;
        if expected_output_samples > 0 {
            let min_hs = 2usize.max(((sample_rate as f64 * MIN_FRAME_SEC) / 2.0).round() as usize);
            let target_hs = expected_output_samples / TARGET_GRAINS;
            hs = hs.min(min_hs.max(target_hs));
        }
        let n = hs * 2;
        let search_radius =
            ((sample_rate as f64 * DEFAULT_SEARCH_SEC).round() as usize).min(hs) as i64;
        Self {
            channels,
            passthrough,
            n,
            hs,
            ha: hs as f64 * speed,
            search_radius,
            window: hann(n),
            buf: vec![Vec::new(); channels],
            mono: Vec::new(),
            buf_start: 0,
            buf_head: 0,
            out: vec![Vec::new(); channels],
            win_sum: Vec::new(),
            out_start: 0,
            ideal_pos: 0.0,
            grain_pos: 0,
            frame: 0,
            placed_any: false,
        }
    }

    pub fn push(&mut self, planar: &[Vec<f32>]) -> PlanarPcm {
        if self.passthrough {
            return (0..self.channels)
                .map(|channel| {
                    planar
                        .get(channel)
                        .or_else(|| planar.first())
                        .cloned()
                        .unwrap_or_default()
                })
                .collect();
        }
        self.append(planar);
        self.process(false)
    }

    pub fn flush(&mut self) -> PlanarPcm {
        if self.passthrough {
            return self.empty_chunk();
        }
        self.process(true)
    }

    fn empty_chunk(&self) -> PlanarPcm {
        vec![Vec::new(); self.channels]
    }

    fn append(&mut self, planar: &[Vec<f32>]) {
        let add_len = planar.first().map(|p| p.len()).unwrap_or(0);
        if add_len == 0 {
            return;
        }
        for channel in 0..self.channels {
            if let Some(source) = planar.get(channel).or_else(|| planar.first()) {
                self.buf[channel].extend_from_slice(&source[..add_len.min(source.len())]);
                if source.len() < add_len {
                    let target_len = self.buf[channel].len() + add_len - source.len();
                    self.buf[channel].resize(target_len, 0.0);
                }
            }
        }
        for i in 0..add_len {
            let mut sum = 0.0f32;
            for channel in 0..self.channels {
                sum += planar
                    .get(channel)
                    .and_then(|p| p.get(i))
                    .or_else(|| planar.first().and_then(|p| p.get(i)))
                    .copied()
                    .unwrap_or(0.0);
            }
            self.mono.push(sum / self.channels as f32);
        }
    }

    fn buf_len(&self) -> usize {
        self.buf[0].len() - self.buf_head
    }

    fn buf_end(&self) -> i64 {
        self.buf_start + self.buf_len() as i64
    }

    fn sample_at(&self, channel: usize, absolute_index: i64) -> f32 {
        let index = absolute_index - self.buf_start;
        if index < 0 {
            0.0
        } else {
            self.buf[channel]
                .get(self.buf_head + index as usize)
                .copied()
                .unwrap_or(0.0)
        }
    }

    fn mono_at(&self, absolute_index: i64) -> f32 {
        let index = absolute_index - self.buf_start;
        if index < 0 {
            0.0
        } else {
            self.mono
                .get(self.buf_head + index as usize)
                .copied()
                .unwrap_or(0.0)
        }
    }

    fn process(&mut self, final_chunk: bool) -> PlanarPcm {
        let mut emitted = self.empty_chunk();
        // Pas de garde anti-stagnation ici : `search_target` croît de `ha > 0` à chaque tour
        // et `grain_pos` ne s'en écarte que de `search_radius` au plus, donc le break sur
        // `buf_end` finit toujours par tomber. Une garde de plus tronquerait `emitted` — la
        // région sortirait muette pour tout signal — sans jamais se déclencher.
        loop {
            let search_target = (self.ideal_pos + self.ha).round() as i64;
            let required_end = (self.grain_pos + self.n as i64)
                .max(self.grain_pos + self.hs as i64 + self.n as i64)
                .max(search_target + self.search_radius + self.n as i64);
            if !final_chunk && self.buf_end() < required_end {
                break;
            }
            if self.grain_pos + self.n as i64 > self.buf_end() {
                break;
            }

            self.place_grain(self.grain_pos);
            let placed_frame = self.frame;
            let reference_start = self.grain_pos + self.hs as i64;
            let best_delta = self.find_best_delta(reference_start, search_target);
            self.grain_pos = search_target + best_delta;
            self.ideal_pos += self.ha;
            self.frame += 1;

            self.collect(placed_frame * self.hs, &mut emitted);
            self.discard_below(self.grain_pos);
        }
        if final_chunk {
            self.collect_all(&mut emitted);
        }
        emitted
    }

    fn place_grain(&mut self, position: i64) {
        let output_absolute = self.frame * self.hs;
        self.ensure_out(output_absolute + self.n);
        let base = output_absolute - self.out_start;
        for channel in 0..self.channels {
            for k in 0..self.n {
                let sample = self.sample_at(channel, position + k as i64);
                self.out[channel][base + k] += sample * self.window[k];
            }
        }
        for k in 0..self.n {
            self.win_sum[base + k] += self.window[k];
        }
        self.placed_any = true;
    }

    fn find_best_delta(&self, reference_start: i64, target: i64) -> i64 {
        if reference_start + self.n as i64 > self.buf_end() {
            return 0;
        }
        let mut reference_energy = 0.0f32;
        for k in 0..self.n {
            let sample = self.mono_at(reference_start + k as i64);
            reference_energy += sample * sample;
        }
        if reference_energy == 0.0 {
            return 0;
        }

        let mut best_delta = 0;
        let mut best_score = f32::NEG_INFINITY;
        let low = (-self.search_radius).max(self.buf_start - target);
        let high = self
            .search_radius
            .min(self.buf_end() - self.n as i64 - target);
        for delta in low..=high {
            let candidate_start = target + delta;
            let mut dot = 0.0f32;
            let mut energy = 0.0f32;
            for k in 0..self.n {
                let candidate = self.mono_at(candidate_start + k as i64);
                dot += candidate * self.mono_at(reference_start + k as i64);
                energy += candidate * candidate;
            }
            let score = if energy > 0.0 {
                dot / energy.sqrt()
            } else {
                0.0
            };
            if score > best_score {
                best_score = score;
                best_delta = delta;
            }
        }
        best_delta
    }

    fn ensure_out(&mut self, absolute_end: usize) {
        let needed = absolute_end - self.out_start;
        if needed <= self.out[0].len() {
            return;
        }
        let next_len = needed.max(self.out[0].len() * 2).max(self.n * 4);
        for channel in 0..self.channels {
            self.out[channel].resize(next_len, 0.0);
        }
        self.win_sum.resize(next_len, 0.0);
    }

    fn collect(&mut self, absolute_end: usize, emitted: &mut PlanarPcm) {
        let count = absolute_end.saturating_sub(self.out_start);
        if count == 0 {
            return;
        }
        for channel in 0..self.channels {
            for i in 0..count {
                let weight = self.win_sum[i];
                let mut sample = self.out[channel][i];
                if weight > 1e-6 {
                    sample /= weight;
                }
                emitted[channel].push(sample);
            }
            self.out[channel] = self.out[channel][count..].to_vec();
        }
        self.win_sum = self.win_sum[count..].to_vec();
        self.out_start = absolute_end;
    }

    fn collect_all(&mut self, emitted: &mut PlanarPcm) {
        if !self.placed_any {
            return;
        }
        let end = (self.frame - 1) * self.hs + self.n;
        self.collect(end, emitted);
    }

    fn discard_below(&mut self, absolute_index: i64) {
        let drop_count = absolute_index - self.buf_start;
        if drop_count <= 0 {
            return;
        }
        self.buf_head += (drop_count as usize).min(self.buf_len());
        self.buf_start = absolute_index;
        // Compactage amorti : ne recopier que lorsque la tête consommée dépasse ce qui
        // reste laisse un coût total en O(N) au lieu du O(N²) d'une recopie par grain.
        if self.buf_head > self.buf[0].len() - self.buf_head {
            let head = self.buf_head;
            for channel in 0..self.channels {
                self.buf[channel].drain(..head);
            }
            self.mono.drain(..head);
            self.buf_head = 0;
        }
    }
}

fn stretch_pcm_to_length(pcm: &[Vec<f32>], target_samples: usize) -> PlanarPcm {
    if target_samples == 0 {
        return vec![Vec::new(); AUDIO_OUTPUT_CHANNELS];
    }
    let source_samples = pcm.first().map(|channel| channel.len()).unwrap_or(0);
    if source_samples == 0 {
        return vec![vec![0.0; target_samples]; AUDIO_OUTPUT_CHANNELS];
    }
    if source_samples.abs_diff(target_samples) <= 1 {
        let mut exact = vec![vec![0.0; target_samples]; AUDIO_OUTPUT_CHANNELS];
        for channel in 0..AUDIO_OUTPUT_CHANNELS {
            if let Some(source) = pcm.get(channel) {
                let count = source.len().min(target_samples);
                exact[channel][..count].copy_from_slice(&source[..count]);
            }
        }
        return exact;
    }

    let speed = source_samples as f64 / target_samples as f64;

    // atempo d'abord : le WSOLA ci-dessous fait le même time-stretch préservant la hauteur,
    // mais coûte un ordre de grandeur de plus. Mesuré en release sur une région de 5 min
    // (14,4 M échantillons) : 0,6 s contre 20 s à 1,25×, 4,9 s contre 55 s à 0,25× — et
    // c'est le WSOLA APRÈS la correction de `discard_below`, qui recopiait tout le buffer
    // restant à chaque grain et faisait tenir un export mesuré (65,4 M échantillons) plus de
    // dix minutes sans finir, l'export paraissant figé à ~80 %. `avfilter_atempo_stretch`
    // rend `None` si la chaîne ne monte pas, si le sink négocie un format inattendu ou si la
    // sortie reste plus courte que la cible ; le WSOLA reste alors le chemin de repli exact
    // d'avant, en journalisant la raison.
    if let Some(stretched) = unsafe { avfilter_atempo_stretch(pcm, target_samples, speed) } {
        return stretched;
    }

    let mut stretcher = WsolaTimeStretcher::new(
        AUDIO_OUTPUT_SAMPLE_RATE,
        AUDIO_OUTPUT_CHANNELS,
        speed,
        target_samples,
    );
    let chunks = [stretcher.push(pcm), stretcher.flush()];
    let mut exact = vec![vec![0.0; target_samples]; AUDIO_OUTPUT_CHANNELS];
    for channel in 0..AUDIO_OUTPUT_CHANNELS {
        let mut written = 0usize;
        for chunk in &chunks {
            let source = &chunk[channel];
            let count = source.len().min(target_samples - written);
            if count > 0 {
                exact[channel][written..written + count].copy_from_slice(&source[..count]);
                written += count;
            }
            if written == target_samples {
                break;
            }
        }
    }
    exact
}

/// Plafond du nombre d'étages atempo chaînés.
///
/// `speed` vient de `source_samples / target_samples`, pas de l'éditeur : une scène corrompue
/// où une poignée d'échantillons vise une cible d'une heure donne un ratio arbitrairement
/// petit, et le chaînage par 0.5 empile alors une trentaine d'étages — plus d'un millier pour
/// un subnormal — chacun avec sa fenêtre d'analyse et sa perte d'amorçage. Huit couvre
/// jusqu'à 0.5⁸ ≈ 0,0039, soit vingt-cinq fois sous `MIN_PLAYBACK_SPEED` (0,1) ; au-delà on
/// rend `None` et le WSOLA, qui n'a pas de bornes, prend le relais.
const ATEMPO_MAX_STAGES: usize = 8;

/// Découpe un facteur de vitesse en facteurs que `atempo` accepte individuellement : le
/// filtre n'admet que [0.5, 100.0], on chaîne donc les dépassements (0.2 → [0.5, 0.5, 0.8],
/// 250 → [100.0, 2.5]) — le produit des facteurs reconstitue la vitesse demandée.
///
/// Rend `None` au-delà de `ATEMPO_MAX_STAGES` maillons. La borne haute est chaînée elle
/// aussi : `MAX_PLAYBACK_SPEED` vaut 100 donc un seul étage suffit à tout ce que l'éditeur
/// produit, mais `speed` est un rapport de longueurs quantifiées, pas la vitesse cliquée, et
/// rien ne garantit qu'il reste sous la borne du filtre.
fn atempo_factors(speed: f64) -> Option<Vec<f64>> {
    let mut factors = Vec::new();
    let mut remaining = speed;
    while remaining > 100.0 || remaining < 0.5 {
        if factors.len() >= ATEMPO_MAX_STAGES {
            return None;
        }
        if remaining > 100.0 {
            factors.push(100.0);
            remaining /= 100.0;
        } else {
            factors.push(0.5);
            remaining /= 0.5;
        }
    }
    factors.push(remaining);
    Some(factors)
}

/// RAII : libère le graphe même en sortie précoce sur erreur.
struct FilterGraphGuard(*mut AVFilterGraph);

impl Drop for FilterGraphGuard {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { avfilter_graph_free(&mut self.0) };
        }
    }
}

/// RAII : libère la trame de drain même en sortie précoce sur erreur.
struct FrameGuard(*mut AVFrame);

impl Drop for FrameGuard {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { av_frame_free(&mut self.0) };
        }
    }
}

/// Taille des trames poussées vers le graphe. Le drain est entrelacé avec l'alimentation
/// (cf. `atempo_drain`) : sans cela `av_buffersrc_add_frame` empile toute la région dans la
/// file du buffersrc — ~523 Mo pour une speed region stéréo de 20 min, en plus du slice
/// d'entrée et de l'accumulateur de sortie.
const ATEMPO_FEED_CHUNK: usize = 4096;

/// Rallonge de silence poussée derrière la région avant l'EOF, par étage atempo.
///
/// atempo laisse tomber la dernière fenêtre de chaque étage. En prolongeant l'entrée d'un
/// silence, la fenêtre perdue devient du silence et le contenu réel sort en entier : mesuré
/// sur le pin ffmpeg n8.1.2 (48 kHz stéréo), le manque tombe de 981 à 217 échantillons pour
/// un étage 0.5×, de 2 735 à 553 pour deux, de 8 234 à 2 676 pour quatre. Au-delà la courbe
/// est plate — un tail 16× plus grand ne change plus rien — ce qui reste est traité par la
/// correction de tempo de `avfilter_atempo_stretch`.
const ATEMPO_PRIME_TAIL: usize = 4096;

/// Marge de sécurité, en échantillons, sur la longueur demandée à la passe corrigée.
///
/// Le manque de la seconde passe n'est pas exactement celui mesuré à la première (le tempo
/// a bougé de moins de 1 %, la chaîne est la même). Viser 64 échantillons de plus fait
/// tomber le résidu du côté du surplus, tronqué : 1,3 ms de contenu en moins plutôt qu'un
/// trou de silence.
const ATEMPO_LENGTH_GUARD: usize = 64;

/// Longueur du silence à pousser derrière la région pour une chaîne donnée.
fn atempo_prime_tail(factors: &[f64], speed: f64) -> usize {
    ATEMPO_PRIME_TAIL
        .saturating_mul(factors.len() + 1)
        .saturating_mul(speed.max(1.0).ceil() as usize)
}

/// Vide le buffersink dans `stretched`, sans jamais y garder plus de `keep` échantillons par
/// plan, et compte dans `produced` TOUT ce qui est sorti — y compris ce qui est jeté.
///
/// Les deux chiffres servent à des choses différentes : `stretched` est le résultat, alors
/// que `produced` mesure ce que la chaîne a réellement rendu pour une entrée de longueur
/// connue, donc son manque (cf. `avfilter_atempo_stretch`).
///
/// Rend `Some(true)` sur EOF, `Some(false)` quand le graphe n'a plus rien de prêt (EAGAIN),
/// `None` sur une vraie panne — l'appelant retombe alors sur WSOLA.
unsafe fn atempo_drain(
    sink_ctx: *mut AVFilterContext,
    frame: *mut AVFrame,
    emit: &mut dyn FnMut(PlanarPcm) -> Option<()>,
    kept: &mut usize,
    keep: usize,
    produced: &mut usize,
) -> Option<bool> {
    loop {
        let ret = av_buffersink_get_frame(sink_ctx, frame);
        if ret == AVERROR_EAGAIN {
            return Some(false);
        }
        if ret == AVERROR_EOF {
            return Some(true);
        }
        if ret < 0 {
            eprintln!(
                "[openscreen-compositor] atempo: av_buffersink_get_frame a échoué (ret={ret}), repli WSOLA"
            );
            return None;
        }
        let count = (*frame).nb_samples.max(0) as usize;
        let channels = (*frame).ch_layout.nb_channels.max(0) as usize;
        // La chaîne est épinglée en flt entrelacé de bout en bout (cf. `avfilter_atempo_stretch`) ;
        // tout autre format signifie que la négociation a fait autre chose que ce qu'on a
        // demandé, et le désentrelacement ci-dessous lirait n'importe quoi.
        if (*frame).format != AVSampleFormat::AV_SAMPLE_FMT_FLT as i32
            || channels != AUDIO_OUTPUT_CHANNELS
        {
            eprintln!(
                "[openscreen-compositor] atempo: trame de sortie inattendue (format={} canaux={channels}), repli WSOLA",
                (*frame).format
            );
            av_frame_unref(frame);
            return None;
        }
        let wanted = count.min(keep.saturating_sub(*kept));
        if wanted > 0 {
            let interleaved = *(*frame).extended_data.add(0) as *const f32;
            let samples = std::slice::from_raw_parts(interleaved, count * AUDIO_OUTPUT_CHANNELS);
            let block = (0..AUDIO_OUTPUT_CHANNELS)
                .map(|channel| {
                    (0..wanted)
                        .map(|index| samples[index * AUDIO_OUTPUT_CHANNELS + channel])
                        .collect()
                })
                .collect();
            emit(block)?;
            *kept += wanted;
        }
        *produced += count;
        av_frame_unref(frame);
    }
}

/// Monte `abuffer → atempo… → abuffersink`, y pousse `pcm` suivi de `prime_tail` échantillons
/// de silence, et rend le nombre total d'échantillons sortis — `stretched` en reçoit les
/// `keep` premiers.
///
/// La chaîne est épinglée en **flt entrelacé** 48 kHz stéréo, pas en fltp : `af_atempo`
/// n'annonce que des formats packed (U8/S16/S32/FLT/DBL, cf. son `query_formats`), donc un
/// abuffer en fltp fait insérer un aresample de conversion et rend une branche planaire du
/// drain inatteignable — mesuré, le sink négociait déjà `AV_SAMPLE_FMT_FLT`. En demandant flt
/// des deux côtés il n'y a aucun filtre de conversion dans le graphe, et l'entrelacement est
/// absorbé par la recopie qu'on fait de toute façon.
unsafe fn atempo_stream_pass(
    source_samples: usize,
    read: &mut dyn FnMut(usize, usize) -> Option<PlanarPcm>,
    emit: &mut dyn FnMut(PlanarPcm) -> Option<()>,
    factors: &[f64],
    prime_tail: usize,
    keep: usize,
) -> Option<usize> {
    let graph_guard = FilterGraphGuard(avfilter_graph_alloc());
    let graph = graph_guard.0;
    if graph.is_null() {
        return None;
    }

    let abuffer_name = CString::new("abuffer").ok()?;
    let abuffersink_name = CString::new("abuffersink").ok()?;
    let atempo_name = CString::new("atempo").ok()?;
    let abuffer = avfilter_get_by_name(abuffer_name.as_ptr());
    let abuffersink = avfilter_get_by_name(abuffersink_name.as_ptr());
    let atempo = avfilter_get_by_name(atempo_name.as_ptr());
    if abuffer.is_null() || abuffersink.is_null() || atempo.is_null() {
        return None;
    }

    let create_filter = |graph: *mut AVFilterGraph,
                         filter: *const AVFilter,
                         name: &str,
                         args: Option<&str>,
                         options: &[(&str, &str)]|
     -> Option<*mut AVFilterContext> {
        let cname = CString::new(name).ok()?;
        let cargs = match args {
            Some(args) => Some(CString::new(args).ok()?),
            None => None,
        };
        let ctx = avfilter_graph_alloc_filter(graph, filter, cname.as_ptr());
        if ctx.is_null() {
            eprintln!("[openscreen-compositor] atempo: alloc_filter({name}) a rendu null");
            return None;
        }
        // Les options typées se posent entre l'alloc et l'init — `avfilter_init_str` fige la
        // négociation. Un échec n'est pas fatal : l'abuffer porte déjà le format, ceci ne fait
        // que l'imposer aussi côté sink pour qu'aucun build ffmpeg ne puisse y glisser un
        // aresample. Le drain vérifie le format reçu de toute façon.
        for (key, value) in options {
            let ckey = CString::new(*key).ok()?;
            let cvalue = CString::new(*value).ok()?;
            let ret = av_opt_set(
                ctx as *mut std::ffi::c_void,
                ckey.as_ptr(),
                cvalue.as_ptr(),
                AV_OPT_SEARCH_CHILDREN as i32,
            );
            if ret < 0 {
                eprintln!(
                    "[openscreen-compositor] atempo: av_opt_set({name}.{key}={value}) a échoué (ret={ret}), négociation laissée libre"
                );
            }
        }
        // `map_or` consommerait `cargs` et le pointeur rendu par la closure serait dangling
        // avant même l'appel — on emprunte donc pour la durée de l'appel.
        let args_ptr = match &cargs {
            Some(args) => args.as_ptr(),
            None => ptr::null(),
        };
        let ret = avfilter_init_str(ctx, args_ptr);
        if ret < 0 {
            eprintln!(
                "[openscreen-compositor] atempo: init_str({name}, {:?}) a échoué (ret={ret})",
                args.unwrap_or("")
            );
            return None;
        }
        Some(ctx)
    };

    let rate = AUDIO_OUTPUT_SAMPLE_RATE;
    let src_ctx = create_filter(
        graph,
        abuffer,
        "in",
        Some(&format!(
            "time_base=1/{rate}:sample_rate={rate}:sample_fmt=flt:channel_layout=stereo"
        )),
        &[],
    )?;
    let sink_ctx = create_filter(graph, abuffersink, "out", None, &[("sample_fmts", "flt")])?;

    let mut previous = src_ctx;
    for (index, factor) in factors.iter().enumerate() {
        let stage = create_filter(
            graph,
            atempo,
            &format!("atempo{index}"),
            Some(&format!("{factor}")),
            &[],
        )?;
        if avfilter_link(previous, 0, stage, 0) < 0 {
            eprintln!("[openscreen-compositor] atempo: avfilter_link a échoué au maillon {index}");
            return None;
        }
        previous = stage;
    }
    if avfilter_link(previous, 0, sink_ctx, 0) < 0 {
        eprintln!("[openscreen-compositor] atempo: avfilter_link vers le sink a échoué");
        return None;
    }
    if avfilter_graph_config(graph, ptr::null_mut()) < 0 {
        eprintln!("[openscreen-compositor] atempo: avfilter_graph_config a échoué");
        return None;
    }

    let sink_frame = FrameGuard(av_frame_alloc());
    if sink_frame.0.is_null() {
        return None;
    }

    // Alimentation : le PCM passe par trames flt de 4096 échantillons, prolongé par la
    // rallonge de silence. `av_buffersrc_add_frame` déplace les références du frame dans le
    // graphe ; on alloue donc une trame neuve par tranche et on la libère après envoi (le
    // shell est vide à ce point). Le drain est entrelacé ici : sans lui la file du buffersrc
    // porterait toute la région d'un coup. La condition d'arrêt est l'entrée épuisée, PAS
    // « on a de quoi remplir la cible » — s'arrêter là couperait la rallonge, et les derniers
    // grains du contenu réel resteraient dans le graphe.
    let total_input = source_samples.saturating_add(prime_tail);
    let mut offset = 0usize;
    let mut produced = 0usize;
    let mut kept = 0usize;
    let mut drained_to_eof = false;
    while offset < total_input {
        let count = ATEMPO_FEED_CHUNK.min(total_input - offset);
        let mut frame = av_frame_alloc();
        if frame.is_null() {
            eprintln!("[openscreen-compositor] atempo: av_frame_alloc (feed) a échoué");
            return None;
        }
        (*frame).format = AVSampleFormat::AV_SAMPLE_FMT_FLT as i32;
        (*frame).sample_rate = rate;
        (*frame).nb_samples = count as i32;
        av_channel_layout_default(&mut (*frame).ch_layout, AUDIO_OUTPUT_CHANNELS as i32);
        if av_frame_get_buffer(frame, 0) < 0 {
            eprintln!("[openscreen-compositor] atempo: av_frame_get_buffer (feed) a échoué");
            av_frame_free(&mut frame);
            return None;
        }
        // Un seul plan en flt : on écrit entrelacé. Le `write_bytes` couvre à la fois les
        // canaux absents d'une source mono et la rallonge de silence finale.
        let destination = *(*frame).extended_data.add(0) as *mut f32;
        ptr::write_bytes(destination, 0, count * AUDIO_OUTPUT_CHANNELS);
        let available = source_samples.saturating_sub(offset).min(count);
        if available > 0 {
            let block = match read(offset, available) {
                Some(block) => block,
                None => {
                    av_frame_free(&mut frame);
                    return None;
                }
            };
            for channel in 0..AUDIO_OUTPUT_CHANNELS {
                for index in 0..available {
                    *destination.add(index * AUDIO_OUTPUT_CHANNELS + channel) =
                        block[channel][index];
                }
            }
        }
        (*frame).pts = offset as i64;
        let ret = av_buffersrc_add_frame(src_ctx, frame);
        av_frame_free(&mut frame);
        if ret < 0 {
            eprintln!("[openscreen-compositor] atempo: av_buffersrc_add_frame (offset={offset}) a échoué (ret={ret})");
            return None;
        }
        offset += count;
        if atempo_drain(sink_ctx, sink_frame.0, emit, &mut kept, keep, &mut produced)? {
            drained_to_eof = true;
            break;
        }
    }

    // EOF : le graphe vide alors ses derniers grains.
    if !drained_to_eof {
        if av_buffersrc_add_frame(src_ctx, ptr::null_mut()) < 0 {
            eprintln!("[openscreen-compositor] atempo: flush du buffersrc a échoué, repli WSOLA");
            return None;
        }
        atempo_drain(sink_ctx, sink_frame.0, emit, &mut kept, keep, &mut produced)?;
    }
    Some(produced)
}

unsafe fn atempo_pass(
    pcm: &[Vec<f32>],
    factors: &[f64],
    prime_tail: usize,
    keep: usize,
    stretched: &mut PlanarPcm,
) -> Option<usize> {
    atempo_stream_pass(
        pcm.first()?.len(),
        &mut |offset, count| {
            Some(
                (0..AUDIO_OUTPUT_CHANNELS)
                    .map(|channel| {
                        (offset..offset + count)
                            .map(|i| {
                                pcm.get(channel)
                                    .and_then(|p| p.get(i))
                                    .copied()
                                    .unwrap_or(0.0)
                            })
                            .collect()
                    })
                    .collect(),
            )
        },
        &mut |block| {
            for (plane, samples) in stretched.iter_mut().zip(block) {
                plane.extend(samples);
            }
            Some(())
        },
        factors,
        prime_tail,
        keep,
    )
}

/// Étire le PCM d'un facteur `speed` via une chaîne `abuffer → atempo… → abuffersink` montée
/// en processus, dans l'avfilter LGPL déjà vendored avec l'app (avfilter-11.dll /
/// libavfilter.so.11 / libavfilter.11.dylib voyagent dans le même lot que avcodec — cf.
/// scripts/fetch-ffmpeg.mjs qui copie TOUTES les av*.dll du build BtbN).
///
/// **Deux passes.** atempo ne rend pas exactement `n/tempo` échantillons : il en manque un
/// nombre fixe par chaîne, indépendant de la longueur de l'entrée (mesuré sur n8.1.2 :
/// ~217 pour un étage, ~550 pour deux, ~2 700 pour quatre, soit jusqu'à 56 ms à 0,1×). Le
/// manque ne se rattrape pas en poussant plus d'entrée — c'est une différence de durée
/// rendue, pas une queue retenue — et le combler par des zéros collait un trou de silence
/// devant le segment suivant, puisque le crossfade equal-power ne couvre que les frontières
/// de clip, jamais la concaténation par segment. La première passe mesure donc le manque sur
/// le contenu réel, sans rien garder, et la seconde demande `cible + manque` pour que le
/// contenu remplisse la cible ; le surplus est tronqué. Aux vitesses > 1 le manque est nul et
/// la seconde passe est sautée.
///
/// Retourne `None` sur toute défaillance (montage, négociation, exécution, sortie plus courte
/// que la cible) : l'appelant retombe alors sur le WSOLA d'origine.
unsafe fn avfilter_atempo_stretch(
    pcm: &[Vec<f32>],
    target_samples: usize,
    speed: f64,
) -> Option<PlanarPcm> {
    if !speed.is_finite() || speed <= 0.0 || target_samples == 0 {
        return None;
    }
    let source_samples = pcm.first().map(|plane| plane.len()).unwrap_or(0);
    if source_samples == 0 {
        return None;
    }

    let planes = |capacity: usize| -> PlanarPcm {
        (0..AUDIO_OUTPUT_CHANNELS)
            .map(|_| Vec::with_capacity(capacity))
            .collect()
    };

    let factors = atempo_factors(speed)?;
    let prime_tail = atempo_prime_tail(&factors, speed);
    let mut stretched = planes(target_samples);
    let produced = atempo_pass(pcm, &factors, prime_tail, target_samples, &mut stretched)?;
    let expected = ((source_samples + prime_tail) as f64 / speed).round() as usize;
    let shortfall = expected.saturating_sub(produced);

    if shortfall > 0 {
        // Le contenu réel s'arrête `shortfall` échantillons avant la cible, et ce qui suit
        // dans `stretched` n'est que la rallonge de silence étirée. On rejoue en demandant
        // une cible plus longue du même montant : la chaîne étant la même, elle en perd
        // autant, et le contenu tombe cette fois pile sur `target_samples`.
        let corrected_target = target_samples + shortfall + ATEMPO_LENGTH_GUARD;
        let corrected_speed = source_samples as f64 / corrected_target as f64;
        let corrected_factors = atempo_factors(corrected_speed)?;
        let corrected_tail = atempo_prime_tail(&corrected_factors, corrected_speed);
        let mut corrected = planes(target_samples);
        atempo_pass(
            pcm,
            &corrected_factors,
            corrected_tail,
            target_samples,
            &mut corrected,
        )?;
        if corrected[0].len() >= target_samples {
            stretched = corrected;
        }
    }

    // Plus court que la cible : la chaîne n'a pas fait son travail. On rend `None` — compléter
    // par des zéros exporterait un trou en se faisant passer pour un succès, et le contrat de
    // `stretch_pcm_to_length` est un repli WSOLA sur échec.
    if stretched[0].len() < target_samples {
        eprintln!(
            "[openscreen-compositor] atempo: sortie de {} échantillons pour une cible de {target_samples} (vitesse {speed}, {} étages), repli WSOLA",
            stretched[0].len(),
            factors.len()
        );
        return None;
    }
    Some(stretched)
}

/// Découpe le PCM gardé avec les mêmes spans et la même quantification frame que la vidéo.
pub fn stretch_clip_pcm_by_speed(
    pcm: &[Vec<f32>],
    speed_segments: &[SpeedSegment],
    output_fps: f64,
) -> PlanarPcm {
    let total_source_samples = pcm.first().map(|channel| channel.len()).unwrap_or(0);
    let mut source_cursor = 0usize;
    let mut chunks: Vec<PlanarPcm> = Vec::with_capacity(speed_segments.len());
    for segment in speed_segments {
        let input_samples = ((segment.end_sec - segment.start_sec)
            * AUDIO_OUTPUT_SAMPLE_RATE as f64)
            .round()
            .max(0.0) as usize;
        let input_start = source_cursor;
        let input_end = (input_start + input_samples).min(total_source_samples);
        source_cursor = input_start + input_samples;
        let output_samples = ((segment.frame_count as f64 / output_fps)
            * AUDIO_OUTPUT_SAMPLE_RATE as f64)
            .round()
            .max(0.0) as usize;
        if input_end <= input_start {
            chunks.push(vec![vec![0.0; output_samples]; AUDIO_OUTPUT_CHANNELS]);
            continue;
        }
        let slice: PlanarPcm = (0..AUDIO_OUTPUT_CHANNELS)
            .map(|channel| pcm[channel][input_start..input_end].to_vec())
            .collect();
        chunks.push(stretch_pcm_to_length(&slice, output_samples));
    }

    let mut output = vec![Vec::new(); AUDIO_OUTPUT_CHANNELS];
    for chunk in chunks {
        for channel in 0..AUDIO_OUTPUT_CHANNELS {
            output[channel].extend_from_slice(&chunk[channel]);
        }
    }
    output
}

pub fn stretch_decoded_clip_audio_by_speed(
    audio: DecodedClipAudio,
    speed_segments: &[SpeedSegment],
    output_fps: f64,
) -> DecodedClipAudio {
    DecodedClipAudio {
        bed: audio
            .bed
            .map(|pcm| stretch_clip_pcm_by_speed(&pcm, speed_segments, output_fps)),
        microphone: audio
            .microphone
            .map(|pcm| stretch_clip_pcm_by_speed(&pcm, speed_segments, output_fps)),
    }
}

pub fn finalize_decoded_clip_audio(
    mut clips: Vec<Option<DecodedClipAudio>>,
    match_dialogue: bool,
) -> Vec<Option<PlanarPcm>> {
    match_clip_dialogue_levels(&mut clips, match_dialogue);
    clips
        .into_iter()
        .map(|clip| clip.map(DecodedClipAudio::into_mixed))
        .collect()
}

#[derive(Clone, Copy)]
pub struct AudioConcatSegmentPlan {
    pub start_sample: usize,
    pub sample_count: usize,
    pub silence: bool,
}

pub struct AudioConcatPlan {
    pub total_samples: usize,
    pub segments: Vec<AudioConcatSegmentPlan>,
}

/// Les offsets sont la somme ENTIÈRE des longueurs arrondies clip par clip ; recalculer depuis
/// une durée cumulée ferait dériver les jonctions sur une longue timeline.
pub fn build_audio_concat_plan(
    output_frame_counts: &[u64],
    has_audio: &[bool],
    output_fps: f64,
) -> AudioConcatPlan {
    let mut cursor = 0usize;
    let mut segments = Vec::with_capacity(output_frame_counts.len());
    for (index, &frame_count) in output_frame_counts.iter().enumerate() {
        let sample_count = if output_fps > 0.0 {
            ((frame_count as f64 / output_fps) * AUDIO_OUTPUT_SAMPLE_RATE as f64)
                .round()
                .max(0.0) as usize
        } else {
            0
        };
        segments.push(AudioConcatSegmentPlan {
            start_sample: cursor,
            sample_count,
            silence: !has_audio.get(index).copied().unwrap_or(false),
        });
        cursor += sample_count;
    }
    AudioConcatPlan {
        total_samples: cursor,
        segments,
    }
}

pub fn assemble_concatenated_pcm(
    clip_pcm: &[Option<PlanarPcm>],
    plan: &AudioConcatPlan,
) -> PlanarPcm {
    let mut output = vec![vec![0.0f32; plan.total_samples]; AUDIO_OUTPUT_CHANNELS];
    for (index, segment) in plan.segments.iter().enumerate() {
        if segment.sample_count == 0 || segment.silence {
            continue;
        }
        let Some(Some(pcm)) = clip_pcm.get(index) else {
            continue;
        };
        for channel in 0..AUDIO_OUTPUT_CHANNELS {
            let Some(source) = pcm.get(channel) else {
                continue;
            };
            let count = segment.sample_count.min(source.len());
            output[channel][segment.start_sample..segment.start_sample + count]
                .copy_from_slice(&source[..count]);
        }
    }

    for boundary in plan.segments.windows(2) {
        let current = boundary[0];
        let next = boundary[1];
        let fade = AUDIO_BOUNDARY_FADE_SAMPLES
            .min(current.sample_count / 2)
            .min(next.sample_count / 2);
        if fade == 0 {
            continue;
        }
        let tail_start = current.start_sample + current.sample_count - fade;
        for channel in 0..AUDIO_OUTPUT_CHANNELS {
            for k in 0..fade {
                let phase = (k as f32 / fade as f32) * PI * 0.5;
                output[channel][tail_start + k] *= phase.cos();
                output[channel][next.start_sample + k] *= phase.sin();
            }
        }
    }
    output
}

/// Encodeur AAC attaché au muxer avant son header. Les paquets utilisent le même interleaver
/// que la vidéo ; les pts restent en unités échantillon jusqu'au rescale vers l'AVStream.
pub(crate) struct AacEncoder {
    context: *mut AVCodecContext,
    stream: *mut AVStream,
    packet: *mut AVPacket,
    sample_offset: usize,
}

impl AacEncoder {
    pub(crate) unsafe fn open(output: *mut AVFormatContext) -> Result<Self> {
        // AudioToolbox's AAC encoder is about six times faster than FFmpeg's own
        // (40 s against 263 s for 40 minutes of stereo on M5) and takes 16-bit input.
        #[cfg(target_os = "macos")]
        let candidates = [
            ("aac_at", AVSampleFormat::AV_SAMPLE_FMT_S16),
            ("aac", AVSampleFormat::AV_SAMPLE_FMT_FLTP),
        ];
        #[cfg(not(target_os = "macos"))]
        let candidates = [("aac", AVSampleFormat::AV_SAMPLE_FMT_FLTP)];
        let mut opened = None;
        for (name, sample_fmt) in candidates {
            if let Some(context) = Self::open_codec(name, sample_fmt)? {
                opened = Some(context);
                break;
            }
        }
        let Some(context) = opened else {
            bail!("no AAC encoder in this FFmpeg build");
        };

        let stream = avformat_new_stream(output, ptr::null());
        if stream.is_null() {
            bail!("aac avformat_new_stream");
        }
        averr(
            avcodec_parameters_from_context((*stream).codecpar, context),
            "aac parameters_from_context",
        )?;
        (*stream).time_base = (*context).time_base;
        let packet = av_packet_alloc();
        if packet.is_null() {
            bail!("aac av_packet_alloc");
        }
        Ok(Self {
            context,
            stream,
            packet,
            sample_offset: 0,
        })
    }

    /// Opens `name` at the output format, or `None` when this build lacks it or refuses it.
    unsafe fn open_codec(
        name: &str,
        sample_fmt: AVSampleFormat::Type,
    ) -> Result<Option<*mut AVCodecContext>> {
        let name = CString::new(name)?;
        let codec = avcodec_find_encoder_by_name(name.as_ptr());
        if codec.is_null() {
            return Ok(None);
        }
        let mut context = avcodec_alloc_context3(codec);
        if context.is_null() {
            bail!("aac avcodec_alloc_context3");
        }
        (*context).sample_fmt = sample_fmt;
        (*context).sample_rate = AUDIO_OUTPUT_SAMPLE_RATE;
        (*context).bit_rate = AUDIO_BITRATE;
        (*context).time_base = AVRational {
            num: 1,
            den: AUDIO_OUTPUT_SAMPLE_RATE,
        };
        av_channel_layout_default(&mut (*context).ch_layout, AUDIO_OUTPUT_CHANNELS as i32);
        // MP4 keeps the decoder configuration in the track header, not in each packet.
        (*context).flags |= crate::ffi::AV_CODEC_FLAG_GLOBAL_HEADER as i32;
        if avcodec_open2(context, codec, ptr::null_mut()) < 0 {
            avcodec_free_context(&mut context);
            return Ok(None);
        }
        Ok(Some(context))
    }

    pub(crate) unsafe fn encode_block(
        &mut self,
        pcm: &[Vec<f32>],
        output: *mut AVFormatContext,
    ) -> Result<()> {
        let total_samples = pcm.first().map(|channel| channel.len()).unwrap_or(0);
        let frame_size = if (*self.context).frame_size > 0 {
            (*self.context).frame_size as usize
        } else {
            1024
        };
        let mut offset = 0usize;
        while offset < total_samples {
            let sample_count = frame_size.min(total_samples - offset);
            let mut frame = av_frame_alloc();
            if frame.is_null() {
                bail!("aac av_frame_alloc");
            }
            (*frame).format = (*self.context).sample_fmt as i32;
            (*frame).sample_rate = AUDIO_OUTPUT_SAMPLE_RATE;
            (*frame).nb_samples = sample_count as i32;
            averr(
                av_channel_layout_copy(&mut (*frame).ch_layout, &(*self.context).ch_layout),
                "aac channel_layout_copy",
            )?;
            averr(av_frame_get_buffer(frame, 0), "aac frame_get_buffer")?;
            averr(av_frame_make_writable(frame), "aac frame_make_writable")?;
            if (*self.context).sample_fmt == AVSampleFormat::AV_SAMPLE_FMT_S16 {
                let destination = std::slice::from_raw_parts_mut(
                    (*frame).data[0] as *mut i16,
                    sample_count * AUDIO_OUTPUT_CHANNELS,
                );
                interleave_s16(pcm, offset, destination);
            } else {
                for channel in 0..AUDIO_OUTPUT_CHANNELS {
                    let destination = *(*frame).extended_data.add(channel) as *mut f32;
                    ptr::write_bytes(destination, 0, sample_count);
                    if let Some(source) = pcm.get(channel) {
                        let available = source.len().saturating_sub(offset).min(sample_count);
                        if available > 0 {
                            ptr::copy_nonoverlapping(
                                source.as_ptr().add(offset),
                                destination,
                                available,
                            );
                        }
                    }
                }
            }
            (*frame).pts = (self.sample_offset + offset) as i64;
            averr(avcodec_send_frame(self.context, frame), "aac send_frame")?;
            self.drain(output)?;
            av_frame_free(&mut frame);
            offset += sample_count;
        }
        self.sample_offset += total_samples;
        Ok(())
    }

    pub(crate) unsafe fn finish(&mut self, output: *mut AVFormatContext) -> Result<()> {
        averr(avcodec_send_frame(self.context, ptr::null()), "aac flush")?;
        self.drain(output)
    }

    unsafe fn drain(&mut self, output: *mut AVFormatContext) -> Result<()> {
        loop {
            let ret = avcodec_receive_packet(self.context, self.packet);
            if ret == AVERROR_EAGAIN || ret == AVERROR_EOF {
                return Ok(());
            }
            averr(ret, "aac receive_packet")?;
            (*self.packet).stream_index = (*self.stream).index;
            av_packet_rescale_ts(
                self.packet,
                (*self.context).time_base,
                (*self.stream).time_base,
            );
            averr(
                av_interleaved_write_frame(output, self.packet),
                "aac interleaved_write_frame",
            )?;
            av_packet_unref(self.packet);
        }
    }
}

/// Writes `destination.len() / channels` frames of planar float PCM from `offset` as
/// interleaved 16-bit samples, clipping to full scale and padding missing samples with silence.
fn interleave_s16(pcm: &[Vec<f32>], offset: usize, destination: &mut [i16]) {
    for (index, sample) in destination.iter_mut().enumerate() {
        let channel = index % AUDIO_OUTPUT_CHANNELS;
        let value = pcm
            .get(channel)
            .and_then(|source| source.get(offset + index / AUDIO_OUTPUT_CHANNELS))
            .copied()
            .unwrap_or(0.0);
        *sample = (value.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16;
    }
}

impl Drop for AacEncoder {
    fn drop(&mut self) {
        unsafe {
            av_packet_free(&mut self.packet);
            avcodec_free_context(&mut self.context);
        }
    }
}

#[cfg(test)]
mod tests {
    /// Un sinus 440 Hz de `secs` secondes sur les deux canaux.
    fn sine(secs: f64) -> PlanarPcm {
        let total = (secs * AUDIO_OUTPUT_SAMPLE_RATE as f64).round() as usize;
        let mut pcm: PlanarPcm = vec![Vec::with_capacity(total); AUDIO_OUTPUT_CHANNELS];
        for i in 0..total {
            let t = i as f32 / AUDIO_OUTPUT_SAMPLE_RATE as f32;
            let sample = (2.0 * PI * 440.0 * t).sin() * 0.5;
            for channel in 0..AUDIO_OUTPUT_CHANNELS {
                pcm[channel].push(sample);
            }
        }
        pcm
    }

    /// Hauteur mesurée par passages à zéro montants sur une fenêtre d'une seconde.
    fn pitch_hz(plane: &[f32], start: usize) -> usize {
        let window = (AUDIO_OUTPUT_SAMPLE_RATE as usize).min(plane.len().saturating_sub(start + 1));
        (start..start + window)
            .filter(|&i| plane[i] <= 0.0 && plane[i + 1] > 0.0)
            .count()
    }

    /// Énergie RMS des `count` derniers échantillons.
    fn tail_rms(plane: &[f32], count: usize) -> f32 {
        let start = plane.len().saturating_sub(count);
        let slice = &plane[start..];
        if slice.is_empty() {
            return 0.0;
        }
        (slice.iter().map(|v| v * v).sum::<f32>() / slice.len() as f32).sqrt()
    }

    /// Les presets réellement cliquables dans l'éditeur (`SPEED_OPTIONS`), plus les bornes
    /// `MIN_PLAYBACK_SPEED` / `MAX_PLAYBACK_SPEED` de `src/components/video-editor/types.ts`.
    const EDITOR_SPEEDS: [f64; 13] = [
        0.1, 0.25, 0.5, 0.75, 1.25, 1.5, 1.75, 2.0, 3.0, 4.0, 5.0, 10.0, 100.0,
    ];

    #[test]
    fn atempo_covers_every_editor_speed_without_a_silent_tail() {
        // Le bug que ce test verrouille : atempo n'émet jamais sa dernière fenêtre, et
        // compléter le manque par des zéros collait jusqu'à 181 ms de blanc (0,1×, quatre
        // étages) devant le segment suivant — un dropout audible dans un export « réussi ».
        // La rallonge de silence en entrée fait sortir les derniers grains pour de bon, donc
        // la fin de région doit porter autant de signal que son milieu, à toute vitesse et
        // sur des spans courts comme longs.
        for &speed in &EDITOR_SPEEDS {
            for &secs in &[0.05f64, 0.5, 3.0] {
                let pcm = sine(secs);
                let source = pcm[0].len();
                let target = (source as f64 / speed).round() as usize;
                if target == 0 {
                    continue;
                }
                let stretched = unsafe { avfilter_atempo_stretch(&pcm, target, speed) }
                    .unwrap_or_else(|| {
                        panic!("atempo doit couvrir {speed}× sur {secs}s (cible {target})")
                    });
                for plane in &stretched {
                    assert_eq!(plane.len(), target, "vitesse {speed}× durée {secs}s");
                }
                // 10 ms de queue : le zero-padding d'avant en laissait au moins 5 ms à 0,1×.
                // Le trou : un silence numérique en fin de région. Zéro tolérance — la
                // correction de tempo est faite pour que le contenu tombe pile sur la cible.
                let trailing_silence = stretched[0].iter().rev().take_while(|v| **v == 0.0).count();
                assert_eq!(
                    trailing_silence, 0,
                    "{trailing_silence} échantillons de silence en fin de région à {speed}× sur {secs}s"
                );
                let tail = (AUDIO_OUTPUT_SAMPLE_RATE as usize / 100).min(target);
                assert!(
                    tail_rms(&stretched[0], tail) > 0.05,
                    "queue sans énergie à {speed}× sur {secs}s : rms={}",
                    tail_rms(&stretched[0], tail)
                );
            }
        }
    }

    #[test]
    fn atempo_preserves_pitch_through_a_chain_of_stages() {
        // 0,25× et 0,1× sortent des bornes [0.5, 100] d'un seul atempo et passent donc par
        // la chaîne multi-étages — le cas que le test d'origine (1,25×, un seul maillon)
        // ne touchait pas, alors que 0,25× est un preset de la liste déroulante.
        for &speed in &[0.1f64, 0.25, 0.5] {
            let pcm = sine(2.0);
            let target = (pcm[0].len() as f64 / speed).round() as usize;
            let stretched = unsafe { avfilter_atempo_stretch(&pcm, target, speed) }
                .unwrap_or_else(|| panic!("la chaîne atempo doit monter à {speed}×"));
            let measured = pitch_hz(&stretched[0], target / 2);
            assert!(
                (measured as f64 - 440.0).abs() <= 2.0,
                "hauteur à {speed}× : {measured} Hz (un rééchantillonnage la déplacerait)"
            );
        }
    }

    #[test]
    fn stretch_pcm_to_length_is_exact_at_every_editor_speed() {
        // Contrat de bout en bout, repli WSOLA compris : quelle que soit la branche prise,
        // la longueur rendue est exactement celle que le plan de concaténation attend.
        for &speed in &EDITOR_SPEEDS {
            let pcm = sine(0.5);
            let target = (pcm[0].len() as f64 / speed).round() as usize;
            let stretched = stretch_pcm_to_length(&pcm, target);
            assert_eq!(stretched.len(), AUDIO_OUTPUT_CHANNELS);
            for plane in &stretched {
                assert_eq!(plane.len(), target, "vitesse {speed}×");
            }
        }
    }

    #[test]
    fn wsola_fallback_still_stretches_and_keeps_pitch() {
        // Le chemin de repli reste atteignable (avfilter absent d'un build, graphe qui ne
        // monte pas) et sa recopie de buffer a été remplacée par un curseur de lecture :
        // ce test verrouille qu'il rend toujours la bonne durée à la bonne hauteur.
        let pcm = sine(2.0);
        let speed = 0.5;
        let target = (pcm[0].len() as f64 / speed).round() as usize;
        let mut stretcher = WsolaTimeStretcher::new(
            AUDIO_OUTPUT_SAMPLE_RATE,
            AUDIO_OUTPUT_CHANNELS,
            speed,
            target,
        );
        let mut emitted: PlanarPcm = vec![Vec::new(); AUDIO_OUTPUT_CHANNELS];
        for chunk in [stretcher.push(&pcm), stretcher.flush()] {
            for channel in 0..AUDIO_OUTPUT_CHANNELS {
                emitted[channel].extend_from_slice(&chunk[channel]);
            }
        }
        // Le WSOLA vise la durée sans la garantir à l'échantillon près : c'est
        // `stretch_pcm_to_length` qui recadre. On tolère 1 % ici.
        let produced = emitted[0].len() as f64;
        assert!(
            (produced - target as f64).abs() / (target as f64) < 0.02,
            "WSOLA a rendu {produced} pour une cible de {target}"
        );
        let measured = pitch_hz(&emitted[0], target / 2);
        assert!(
            (measured as f64 - 440.0).abs() <= 3.0,
            "hauteur WSOLA : {measured} Hz"
        );
    }

    #[test]
    fn atempo_factors_split_out_of_range_speeds() {
        // Dans les bornes : un seul maillon.
        assert_eq!(atempo_factors(1.25), Some(vec![1.25]));
        assert_eq!(atempo_factors(0.5), Some(vec![0.5]));
        // Hors bornes : chaîne dont le produit reconstitue la vitesse.
        assert_eq!(atempo_factors(0.2), Some(vec![0.5, 0.5, 0.8]));
        assert_eq!(atempo_factors(250.0), Some(vec![100.0, 2.5]));
        for speed in [0.07f64, 0.3, 1.0, 3.7, 4_000.0] {
            let product: f64 = atempo_factors(speed)
                .expect("dans le plafond")
                .iter()
                .product();
            assert!(
                (product - speed).abs() < 1e-9,
                "produit={product} attendu={speed}"
            );
        }
        // MIN_PLAYBACK_SPEED tient largement dans le plafond.
        assert_eq!(atempo_factors(0.1).map(|f| f.len()), Some(4));
    }

    #[test]
    fn atempo_declines_a_chain_it_would_have_to_stack() {
        // `speed` est `source_samples / target_samples`, pas la vitesse cliquée : une scène
        // corrompue où une poignée d'échantillons vise une cible d'une heure produit un
        // ratio arbitrairement petit. Sans plafond le chaînage empilait une trentaine
        // d'étages — plus d'un millier pour un subnormal — chacun avec sa perte d'amorçage.
        assert_eq!(atempo_factors(1.0 / 48_000.0 / 3_600.0), None);
        assert_eq!(atempo_factors(f64::MIN_POSITIVE), None);
        assert_eq!(atempo_factors(1e30), None);
        // Et le repli tient le contrat de longueur : c'est le WSOLA qui prend la main.
        let pcm = sine(0.05);
        let target = pcm[0].len() * 5_000;
        let stretched = stretch_pcm_to_length(&pcm, target);
        for plane in &stretched {
            assert_eq!(plane.len(), target);
        }
    }

    use super::*;

    /// Même contenu sur les deux canaux : le mixage travaille canal par canal, donc asserter sur
    /// un seul suffit, mais les deux plans doivent exister (le format de sortie est stéréo).
    fn planar(samples: &[f32]) -> PlanarPcm {
        vec![samples.to_vec(), samples.to_vec()]
    }

    #[test]
    fn s16_interleaving_clips_and_pads_with_silence() {
        let pcm = vec![vec![0.5, 2.0], vec![-1.0]];
        let mut out = [7_i16; 6];
        interleave_s16(&pcm, 0, &mut out);
        assert_eq!(out, [16_384, -32_767, 32_767, 0, 0, 0]);
        interleave_s16(&pcm, 1, &mut out[..2]);
        assert_eq!(&out[..2], &[32_767, 0]);
    }

    #[test]
    fn single_track_passes_through_unchanged() {
        let track = planar(&[0.25, -0.5, 0.75]);
        let mixed = mix_aligned_tracks(&[(0.0, &track)], 0.0, 3);
        assert_eq!(mixed[0], vec![0.25, -0.5, 0.75]);
        assert_eq!(mixed[1], vec![0.25, -0.5, 0.75]);
    }

    #[test]
    fn structural_cut_fade_is_ten_milliseconds() {
        assert_eq!(
            AUDIO_BOUNDARY_FADE_SAMPLES,
            AUDIO_OUTPUT_SAMPLE_RATE as usize / 100
        );
    }

    #[test]
    fn single_track_is_not_clamped() {
        // Promesse de non-régression : une source mono-piste ressort telle quelle, y compris
        // hors pleine échelle. Seul le mixage multipiste écrête.
        let track = planar(&[1.5, -1.5]);
        let mixed = mix_aligned_tracks(&[(0.0, &track)], 0.0, 2);
        assert_eq!(mixed[0], vec![1.5, -1.5]);
    }

    #[test]
    fn silent_first_track_does_not_swallow_the_microphone() {
        // Le cas de l'issue #108 : l'enregistreur natif macOS écrit l'audio système en première
        // piste (silencieuse si rien ne joue) et le micro en seconde. `av_find_best_stream` ne
        // rendait que la première, et l'export sortait muet.
        let system_audio = planar(&[0.0, 0.0, 0.0]);
        let microphone = planar(&[0.3, -0.4, 0.5]);
        let mixed = mix_aligned_tracks(&[(0.0, &system_audio), (0.0, &microphone)], 0.0, 3);
        assert_eq!(mixed[0], vec![0.3, -0.4, 0.5]);
    }

    #[test]
    fn clean_voice_replaces_only_the_microphone() {
        let bed = planar(&[0.1, 0.1]);
        let raw_microphone = planar(&[0.2, 0.2]);
        let clean_microphone = planar(&[0.3, 0.3]);
        let mut raw = DecodedClipAudio {
            bed: Some(bed),
            microphone: Some(raw_microphone),
        };
        let clean = DecodedClipAudio {
            bed: Some(clean_microphone),
            microphone: None,
        };

        assert!(replace_microphone(&mut raw, clean));
        assert_eq!(raw.into_mixed()[0], vec![0.4, 0.4]);
    }

    #[test]
    fn tagged_source_tracks_replace_the_preview_mix_during_export() {
        assert!(!should_decode_audio_track(
            Some(PREVIEW_MIX_TRACK_TITLE),
            None,
            true,
        ));
        assert!(!should_decode_audio_track(
            None,
            Some(PREVIEW_MIX_TRACK_LANGUAGE),
            true,
        ));
        assert!(should_decode_audio_track(
            Some(SYSTEM_TRACK_TITLE),
            None,
            true,
        ));
        assert!(should_decode_audio_track(
            None,
            Some(MICROPHONE_TRACK_LANGUAGE),
            true,
        ));
        assert!(should_decode_audio_track(
            Some("commentary"),
            Some("eng"),
            true,
        ));
        assert!(should_decode_audio_track(
            Some(PREVIEW_MIX_TRACK_TITLE),
            None,
            false,
        ));
        assert!(should_decode_audio_track(None, None, false));
    }

    fn stereo_sine(amplitude: f32, seconds: usize) -> PlanarPcm {
        let samples = (0..AUDIO_OUTPUT_SAMPLE_RATE as usize * seconds)
            .map(|index| {
                let phase = 2.0 * PI * 1_000.0 * index as f32 / AUDIO_OUTPUT_SAMPLE_RATE as f32;
                amplitude * phase.sin()
            })
            .collect::<Vec<_>>();
        vec![samples.clone(), samples]
    }

    fn decoded_microphone(amplitude: f32) -> DecodedClipAudio {
        DecodedClipAudio {
            bed: None,
            microphone: Some(stereo_sine(amplitude, 1)),
        }
    }

    #[test]
    fn clip_dialogue_consistency_matches_microphone_stems_to_the_median() {
        let mut clips = vec![
            Some(decoded_microphone(0.03)),
            Some(decoded_microphone(0.06)),
            Some(decoded_microphone(0.12)),
        ];

        let adjustments = match_clip_dialogue_levels(&mut clips, true);
        let measured = clips
            .iter()
            .map(|clip| {
                measure_program_audio(clip.as_ref().unwrap().microphone.as_ref().unwrap())
                    .unwrap()
                    .integrated_lufs
            })
            .collect::<Vec<_>>();

        assert!(measured
            .iter()
            .all(|lufs| (lufs - measured[1]).abs() < 0.08));
        assert!(adjustments[0].as_ref().unwrap().applied_gain_db > 5.9);
        assert!(adjustments[1].as_ref().unwrap().applied_gain_db.abs() < 0.01);
        assert!(adjustments[2].as_ref().unwrap().applied_gain_db < -5.9);
    }

    #[test]
    fn clip_dialogue_consistency_does_not_change_the_system_audio_bed() {
        let bed = stereo_sine(0.2, 1);
        let mut clips = vec![
            Some(DecodedClipAudio {
                bed: Some(bed.clone()),
                microphone: Some(stereo_sine(0.02, 1)),
            }),
            Some(decoded_microphone(0.08)),
        ];

        match_clip_dialogue_levels(&mut clips, true);

        assert_eq!(clips[0].as_ref().unwrap().bed.as_ref().unwrap(), &bed);
    }

    #[test]
    fn clip_dialogue_consistency_is_a_noop_when_disabled() {
        let bed = stereo_sine(0.2, 1);
        let microphone = stereo_sine(0.02, 1);
        let mut clips = vec![
            Some(DecodedClipAudio {
                bed: Some(bed.clone()),
                microphone: Some(microphone.clone()),
            }),
            Some(decoded_microphone(0.08)),
        ];

        let adjustments = match_clip_dialogue_levels(&mut clips, false);

        assert_eq!(adjustments, vec![None, None]);
        assert_eq!(clips[0].as_ref().unwrap().bed.as_ref().unwrap(), &bed);
        assert_eq!(
            clips[0].as_ref().unwrap().microphone.as_ref().unwrap(),
            &microphone
        );
    }

    #[test]
    fn clip_dialogue_consistency_ignores_room_tone_and_legacy_mixes() {
        let legacy_mix = stereo_sine(0.04, 1);
        let mut clips = vec![
            Some(decoded_microphone(0.00001)),
            Some(DecodedClipAudio {
                bed: Some(legacy_mix.clone()),
                microphone: None,
            }),
            Some(decoded_microphone(0.08)),
        ];

        let adjustments = match_clip_dialogue_levels(&mut clips, true);

        assert_eq!(adjustments, vec![None, None, None]);
        assert_eq!(
            clips[1].as_ref().unwrap().bed.as_ref().unwrap(),
            &legacy_mix
        );
    }

    #[test]
    fn program_mastering_reaches_the_loudness_target_without_crossing_true_peak() {
        let mut pcm = stereo_sine(0.1, 1);
        let stats = master_program_audio(&mut pcm, AudioMasteringSettings::default());
        assert!(stats.analyzed);
        assert!((stats.output_lufs.unwrap() - DEFAULT_TARGET_LUFS).abs() < 0.1);
        assert!(stats.output_true_peak_dbtp.unwrap() <= DEFAULT_TRUE_PEAK_CEILING_DBTP + 0.01);
        assert!(!stats.limited_by_true_peak);
    }

    #[test]
    fn youtube_delivery_preset_uses_the_conservative_loudness_and_peak_targets() {
        assert_eq!(DEFAULT_TARGET_LUFS, -14.5);
        assert_eq!(DEFAULT_TRUE_PEAK_CEILING_DBTP, -2.0);
    }

    #[test]
    fn program_mastering_uses_a_custom_loudness_and_peak_target() {
        let mut pcm = stereo_sine(0.04, 2);
        let settings = AudioMasteringSettings::new(true, -18.0, -3.0);

        let stats = master_program_audio(&mut pcm, settings);

        assert!((stats.output_lufs.unwrap() - -18.0).abs() < 0.1);
        assert!(stats.output_true_peak_dbtp.unwrap() <= -3.0 + 0.01);
    }

    #[test]
    fn audio_mastering_settings_replace_non_finite_values_with_defaults() {
        let settings = AudioMasteringSettings::new(true, f64::NAN, f64::INFINITY);

        assert_eq!(settings, AudioMasteringSettings::default());
    }

    #[test]
    fn program_mastering_raises_quiet_dialogue_with_isolated_loud_transients() {
        let mut pcm = stereo_sine(0.06, 4);
        for sample_index in [0, 24_000, 96_000, 168_000] {
            pcm[0][sample_index] = 0.95;
            pcm[1][sample_index] = 0.95;
        }

        let stats = master_program_audio(&mut pcm, AudioMasteringSettings::default());

        assert!(stats.limited_by_true_peak);
        assert!((stats.output_lufs.unwrap() - DEFAULT_TARGET_LUFS).abs() < 0.5);
        assert!(stats.output_true_peak_dbtp.unwrap() <= DEFAULT_TRUE_PEAK_CEILING_DBTP + 0.01);
    }

    #[test]
    fn program_mastering_does_not_boost_a_quiet_program_past_true_peak() {
        let mut pcm = stereo_sine(0.001, 1);
        pcm[0][24_000] = 0.95;
        pcm[1][24_000] = 0.95;
        let stats = master_program_audio(&mut pcm, AudioMasteringSettings::default());
        assert!(stats.limited_by_true_peak);
        assert!(stats.output_true_peak_dbtp.unwrap() <= DEFAULT_TRUE_PEAK_CEILING_DBTP + 0.01);
        assert!(stats.output_lufs.unwrap() < DEFAULT_TARGET_LUFS);
        assert!(stats.warning.is_some());
    }

    #[test]
    fn program_mastering_reports_the_gain_cap_when_it_is_the_active_limit() {
        let mut pcm = stereo_sine(0.001, 1);
        let stats = master_program_audio(&mut pcm, AudioMasteringSettings::default());

        assert!(stats.limited_by_gain_cap);
        assert!(!stats.limited_by_true_peak);
        assert_eq!(stats.applied_gain_db, MAX_AUTOMATIC_GAIN_DB);
        assert!(stats
            .warning
            .unwrap()
            .contains("12 dB automatic gain limit"));
    }

    #[test]
    fn program_mastering_leaves_silence_unchanged() {
        let mut pcm = vec![vec![0.0; 48_000], vec![0.0; 48_000]];
        let stats = master_program_audio(&mut pcm, AudioMasteringSettings::default());
        assert!(!stats.analyzed);
        assert_eq!(stats.applied_gain_db, 0.0);
        assert!(stats.warning.unwrap().contains("silent"));
        assert!(pcm.iter().flatten().all(|sample| *sample == 0.0));
    }

    #[test]
    fn tracks_are_summed() {
        let a = planar(&[0.1, 0.2]);
        let b = planar(&[0.2, 0.3]);
        let mixed = mix_aligned_tracks(&[(0.0, &a), (0.0, &b)], 0.0, 2);
        assert!((mixed[0][0] - 0.3).abs() < 1e-6);
        assert!((mixed[0][1] - 0.5).abs() < 1e-6);
    }

    #[test]
    fn multi_track_sum_is_clamped_to_full_scale() {
        let a = planar(&[0.8, -0.8]);
        let b = planar(&[0.8, -0.8]);
        let mixed = mix_aligned_tracks(&[(0.0, &a), (0.0, &b)], 0.0, 2);
        assert_eq!(mixed[0], vec![1.0, -1.0]);
    }

    #[test]
    fn a_track_starting_late_is_zero_padded_at_the_front() {
        // La piste commence 1 ms après le début de la fenêtre demandée : 48 échantillons de
        // silence devant, son contenu ensuite. Sans ce recadrage, sommer désalignerait les pistes.
        let late = planar(&[0.5; 8]);
        let mixed = mix_aligned_tracks(&[(0.001, &late)], 0.0, 64);
        assert_eq!(&mixed[0][..48], &[0.0f32; 48][..]);
        assert_eq!(&mixed[0][48..56], &[0.5f32; 8][..]);
        assert_eq!(&mixed[0][56..], &[0.0f32; 8][..]);
    }

    #[test]
    fn a_track_decoded_early_has_its_prefetch_trimmed() {
        // Le seek audio retombe sur une trame antérieure à la fenêtre : cette prélecture est
        // coupée, pas mixée.
        let mut samples = vec![0.0f32; 48];
        samples.extend_from_slice(&[0.5; 8]);
        let early = planar(&samples);
        let mixed = mix_aligned_tracks(&[(-0.001, &early)], 0.0, 8);
        assert_eq!(mixed[0], vec![0.5; 8]);
    }
}
