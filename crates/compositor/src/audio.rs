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
    fn disabled() -> Self {
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
    decoded: PlanarPcm,
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
    unsafe { decode_clip_audio_inner(path, source_start_sec, source_end_sec) }
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

unsafe fn decode_clip_audio_inner(
    path: &str,
    source_start_sec: f64,
    source_end_sec: f64,
) -> Result<Option<DecodedClipAudio>> {
    let mut fmt: *mut AVFormatContext = ptr::null_mut();
    let cpath = CString::new(path)?;
    averr(
        avformat_open_input(&mut fmt, cpath.as_ptr(), ptr::null_mut(), ptr::null_mut()),
        "audio open_input",
    )?;
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
        let mut dctx = avcodec_alloc_context3(decoder);
        if dctx.is_null() {
            avformat_close_input(&mut fmt);
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
            decoded: vec![Vec::<f32>::new(); AUDIO_OUTPUT_CHANNELS],
            origin_sec: None,
            reached_end: false,
            decoder_eof: false,
            microphone: is_microphone_track(title.as_deref(), language.as_deref()),
        });
    }
    if tracks.is_empty() {
        avformat_close_input(&mut fmt);
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

    let mut packet = av_packet_alloc();
    let mut frame = av_frame_alloc();
    let mut input_eof = false;

    // Une seule passe de démux alimente tous les décodeurs : chaque paquet est routé vers la
    // piste dont il porte l'index. On continue tant qu'AU MOINS une piste a encore quelque
    // chose à produire.
    while tracks.iter().any(|t| !t.reached_end && !t.decoder_eof) {
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
                track
                    .resampler
                    .as_mut()
                    .unwrap()
                    .push(frame, &mut track.decoded)?;
                av_frame_unref(frame);
            }
        }
    }

    for track in tracks.iter_mut() {
        if let Some(r) = track.resampler.as_mut() {
            r.flush(&mut track.decoded)?;
        }
    }

    av_frame_free(&mut frame);
    av_packet_free(&mut packet);
    avformat_close_input(&mut fmt);

    let target_samples = (((source_end_sec - source_start_sec).max(0.0)
        * AUDIO_OUTPUT_SAMPLE_RATE as f64)
        .round()) as usize;
    let microphone_tracks: Vec<(f64, &PlanarPcm)> = tracks
        .iter()
        .filter(|track| track.microphone)
        .map(|track| (track.origin_sec.unwrap_or(source_start_sec), &track.decoded))
        .collect();
    let bed_tracks: Vec<(f64, &PlanarPcm)> = tracks
        .iter()
        .filter(|track| !track.microphone)
        .map(|track| (track.origin_sec.unwrap_or(source_start_sec), &track.decoded))
        .collect();
    Ok(Some(DecodedClipAudio {
        bed: (!bed_tracks.is_empty())
            .then(|| mix_aligned_tracks(&bed_tracks, source_start_sec, target_samples)),
        microphone: (!microphone_tracks.is_empty())
            .then(|| mix_aligned_tracks(&microphone_tracks, source_start_sec, target_samples)),
    }))
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

    fn buf_end(&self) -> i64 {
        self.buf_start + self.buf[0].len() as i64
    }

    fn sample_at(&self, channel: usize, absolute_index: i64) -> f32 {
        let index = absolute_index - self.buf_start;
        if index < 0 {
            0.0
        } else {
            self.buf[channel]
                .get(index as usize)
                .copied()
                .unwrap_or(0.0)
        }
    }

    fn mono_at(&self, absolute_index: i64) -> f32 {
        let index = absolute_index - self.buf_start;
        if index < 0 {
            0.0
        } else {
            self.mono.get(index as usize).copied().unwrap_or(0.0)
        }
    }

    fn process(&mut self, final_chunk: bool) -> PlanarPcm {
        let mut emitted = self.empty_chunk();
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
        let drop_count = drop_count as usize;
        for channel in 0..self.channels {
            self.buf[channel] =
                self.buf[channel][drop_count.min(self.buf[channel].len())..].to_vec();
        }
        self.mono = self.mono[drop_count.min(self.mono.len())..].to_vec();
        self.buf_start = absolute_index;
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
}

impl AacEncoder {
    pub(crate) unsafe fn open(output: *mut AVFormatContext) -> Result<Self> {
        let name = CString::new("aac")?;
        let codec = avcodec_find_encoder_by_name(name.as_ptr());
        if codec.is_null() {
            bail!("encodeur aac introuvable");
        }
        let context = avcodec_alloc_context3(codec);
        if context.is_null() {
            bail!("aac avcodec_alloc_context3");
        }
        (*context).sample_fmt = AVSampleFormat::AV_SAMPLE_FMT_FLTP;
        (*context).sample_rate = AUDIO_OUTPUT_SAMPLE_RATE;
        (*context).bit_rate = AUDIO_BITRATE;
        (*context).time_base = AVRational {
            num: 1,
            den: AUDIO_OUTPUT_SAMPLE_RATE,
        };
        av_channel_layout_default(&mut (*context).ch_layout, AUDIO_OUTPUT_CHANNELS as i32);
        averr(
            avcodec_open2(context, codec, ptr::null_mut()),
            "aac avcodec_open2",
        )?;

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
        })
    }

    pub(crate) unsafe fn encode(
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
            (*frame).pts = offset as i64;
            averr(avcodec_send_frame(self.context, frame), "aac send_frame")?;
            self.drain(output)?;
            av_frame_free(&mut frame);
            offset += sample_count;
        }
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
    use super::*;

    /// Même contenu sur les deux canaux : le mixage travaille canal par canal, donc asserter sur
    /// un seul suffit, mais les deux plans doivent exister (le format de sortie est stéréo).
    fn planar(samples: &[f32]) -> PlanarPcm {
        vec![samples.to_vec(), samples.to_vec()]
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
