//! Post-export validation for the file that is about to become user-visible.
//!
//! The encoder can finish after writing only part of a container when storage,
//! a codec, or a device fails late. This module reopens the completed staging
//! file through the same linked FFmpeg build, checks its declared contract, and
//! decodes both the opening and tail before the main process publishes it.

use std::ffi::CString;
use std::ptr;

use anyhow::{bail, Context, Result};

use crate::ffi::{
    av_channel_layout_compare, av_channel_layout_default, av_channel_layout_uninit, av_frame_alloc,
    av_frame_free, av_frame_unref, av_packet_alloc, av_packet_free, av_packet_unref, av_read_frame,
    av_seek_frame, avcodec_alloc_context3, avcodec_find_decoder, avcodec_flush_buffers,
    avcodec_free_context, avcodec_open2, avcodec_parameters_to_context, avcodec_receive_frame,
    avcodec_send_packet, averr, avformat_close_input, avformat_find_stream_info,
    avformat_open_input, sn_fmt_nb_streams, sn_fmt_stream, AVChannelLayout, AVCodecContext,
    AVCodecID, AVColorPrimaries, AVColorSpace, AVColorTransferCharacteristic, AVFormatContext,
    AVFrame, AVMediaType, AVPacket, AVRational, AVERROR_EAGAIN, AVERROR_EOF, AVSEEK_FLAG_BACKWARD,
};

const AV_TIME_BASE: f64 = 1_000_000.0;
const AV_NOPTS_VALUE: i64 = i64::MIN;
const MAX_PACKETS_PER_DECODE: usize = 20_000;

fn ensure_not_cancelled(is_cancelled: &dyn Fn() -> bool) -> Result<()> {
    if is_cancelled() {
        bail!("export verification cancelled");
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExpectedVideoCodec {
    H264,
    H265,
}

#[derive(Clone, Copy, Debug)]
pub struct VideoExportSpec {
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub duration_s: f64,
    pub codec: ExpectedVideoCodec,
}

#[derive(Clone, Copy, Debug)]
pub struct VideoExportVerification {
    pub duration_s: f64,
    pub fps: f64,
    pub video_streams: u32,
    pub audio_streams: u32,
    pub first_video_frame_s: f64,
    pub tail_video_frame_s: f64,
}

#[derive(Clone, Copy, Debug)]
pub struct GifExportSpec {
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub duration_s: f64,
}

#[derive(Clone, Copy, Debug)]
pub struct GifExportVerification {
    pub duration_s: f64,
    pub fps: f64,
    pub video_streams: u32,
    pub first_frame_s: f64,
    pub tail_frame_s: f64,
}

struct InputGuard {
    format: *mut AVFormatContext,
}

impl Drop for InputGuard {
    fn drop(&mut self) {
        unsafe {
            if !self.format.is_null() {
                avformat_close_input(&mut self.format);
            }
        }
    }
}

struct DecoderGuard {
    input: InputGuard,
    decoder: *mut AVCodecContext,
    packet: *mut AVPacket,
    frame: *mut AVFrame,
    stream_index: i32,
    time_base: AVRational,
}

impl Drop for DecoderGuard {
    fn drop(&mut self) {
        unsafe {
            if !self.frame.is_null() {
                av_frame_free(&mut self.frame);
            }
            if !self.packet.is_null() {
                av_packet_free(&mut self.packet);
            }
            if !self.decoder.is_null() {
                avcodec_free_context(&mut self.decoder);
            }
        }
    }
}

fn rational_value(value: AVRational) -> Option<f64> {
    if value.num <= 0 || value.den <= 0 {
        return None;
    }
    let result = f64::from(value.num) / f64::from(value.den);
    result.is_finite().then_some(result)
}

fn open_input(path: &str) -> Result<InputGuard> {
    let cpath = CString::new(path).context("export path contains an interior NUL")?;
    let mut format = ptr::null_mut();
    unsafe {
        averr(
            avformat_open_input(
                &mut format,
                cpath.as_ptr(),
                ptr::null_mut(),
                ptr::null_mut(),
            ),
            "export verification avformat_open_input",
        )?;
        if format.is_null() {
            bail!("export verification opened a null format context");
        }
        let mut guard = InputGuard { format };
        if let Err(error) = averr(
            avformat_find_stream_info(guard.format, ptr::null_mut()),
            "export verification avformat_find_stream_info",
        ) {
            avformat_close_input(&mut guard.format);
            return Err(error);
        }
        Ok(guard)
    }
}

/// Reads the playable video duration from a media container.
///
/// The container duration is preferred. When a demuxer cannot provide it, the
/// function falls back to the first video stream's duration and time base.
pub fn probe_media_duration(path: &str) -> Result<f64> {
    let input = open_input(path)?;
    unsafe {
        let duration_s = if (*input.format).duration > 0 {
            (*input.format).duration as f64 / AV_TIME_BASE
        } else {
            let (_, video_stream) = find_stream(input.format, AVMediaType::AVMEDIA_TYPE_VIDEO)?;
            let time_base = rational_value((*video_stream).time_base)
                .context("media video stream has an invalid time base")?;
            (*video_stream).duration as f64 * time_base
        };
        if !duration_s.is_finite() || duration_s <= 0.0 {
            bail!("media has no finite positive duration");
        }
        Ok(duration_s)
    }
}

unsafe fn find_stream(
    format: *mut AVFormatContext,
    media_type: AVMediaType::Type,
) -> Result<(i32, *mut crate::ffi::AVStream)> {
    for index in 0..sn_fmt_nb_streams(format) {
        let stream = sn_fmt_stream(format, index as i32);
        if stream.is_null() || (*stream).codecpar.is_null() {
            continue;
        }
        if (*(*stream).codecpar).codec_type == media_type {
            return Ok((index as i32, stream));
        }
    }
    bail!("export verification found no {media_type:?} stream")
}

fn open_decoder(path: &str, media_type: AVMediaType::Type) -> Result<DecoderGuard> {
    let input = open_input(path)?;
    unsafe {
        let (stream_index, stream) = find_stream(input.format, media_type)?;
        let parameters = (*stream).codecpar;
        let codec = avcodec_find_decoder((*parameters).codec_id);
        if codec.is_null() {
            bail!(
                "export verification found no decoder for codec {}",
                (*parameters).codec_id
            );
        }
        let mut decoder = avcodec_alloc_context3(codec);
        if decoder.is_null() {
            bail!("export verification could not allocate a decoder");
        }
        if let Err(error) = averr(
            avcodec_parameters_to_context(decoder, parameters),
            "export verification avcodec_parameters_to_context",
        )
        .and_then(|_| {
            averr(
                avcodec_open2(decoder, codec, ptr::null_mut()),
                "export verification avcodec_open2",
            )
        }) {
            avcodec_free_context(&mut decoder);
            return Err(error);
        }
        let mut packet = av_packet_alloc();
        let mut frame = av_frame_alloc();
        if packet.is_null() || frame.is_null() {
            if !packet.is_null() {
                av_packet_free(&mut packet);
            }
            if !frame.is_null() {
                av_frame_free(&mut frame);
            }
            avcodec_free_context(&mut decoder);
            bail!("export verification could not allocate packet/frame buffers");
        }
        Ok(DecoderGuard {
            input,
            decoder,
            packet,
            frame,
            stream_index,
            time_base: (*stream).time_base,
        })
    }
}

unsafe fn receive_frame_at_or_after(
    decoder: &mut DecoderGuard,
    minimum_timestamp: i64,
    is_cancelled: &dyn Fn() -> bool,
) -> Result<Option<i64>> {
    loop {
        ensure_not_cancelled(is_cancelled)?;
        let result = avcodec_receive_frame(decoder.decoder, decoder.frame);
        if result == AVERROR_EAGAIN || result == AVERROR_EOF {
            return Ok(None);
        }
        averr(result, "export verification avcodec_receive_frame")?;
        let timestamp = (*decoder.frame).best_effort_timestamp;
        av_frame_unref(decoder.frame);
        if timestamp == AV_NOPTS_VALUE {
            bail!("export decoded a frame without a timestamp");
        }
        if timestamp >= minimum_timestamp {
            return Ok(Some(timestamp));
        }
    }
}

unsafe fn send_packet_and_receive(
    decoder: &mut DecoderGuard,
    minimum_timestamp: i64,
    is_cancelled: &dyn Fn() -> bool,
) -> Result<Option<i64>> {
    loop {
        ensure_not_cancelled(is_cancelled)?;
        let sent = avcodec_send_packet(decoder.decoder, decoder.packet);
        if sent == AVERROR_EAGAIN {
            if let Some(timestamp) =
                receive_frame_at_or_after(decoder, minimum_timestamp, is_cancelled)?
            {
                return Ok(Some(timestamp));
            }
            continue;
        }
        averr(sent, "export verification avcodec_send_packet")?;
        return receive_frame_at_or_after(decoder, minimum_timestamp, is_cancelled);
    }
}

fn decode_frame_at(
    path: &str,
    media_type: AVMediaType::Type,
    target_s: f64,
    is_cancelled: &dyn Fn() -> bool,
) -> Result<f64> {
    ensure_not_cancelled(is_cancelled)?;
    let mut decoder = open_decoder(path, media_type)?;
    let time_base = rational_value(decoder.time_base)
        .context("export stream has an invalid decoder time base")?;
    let target_timestamp = (target_s.max(0.0) / time_base).floor() as i64;
    unsafe {
        averr(
            av_seek_frame(
                decoder.input.format,
                decoder.stream_index,
                target_timestamp,
                AVSEEK_FLAG_BACKWARD,
            ),
            "export verification av_seek_frame",
        )?;
        avcodec_flush_buffers(decoder.decoder);
        let mut last_dts = AV_NOPTS_VALUE;
        for _ in 0..MAX_PACKETS_PER_DECODE {
            ensure_not_cancelled(is_cancelled)?;
            let read = av_read_frame(decoder.input.format, decoder.packet);
            if read < 0 {
                if read != AVERROR_EOF {
                    averr(read, "export verification av_read_frame")?;
                }
                averr(
                    avcodec_send_packet(decoder.decoder, ptr::null()),
                    "export verification decoder flush",
                )?;
                if let Some(timestamp) =
                    receive_frame_at_or_after(&mut decoder, target_timestamp, is_cancelled)?
                {
                    return Ok(timestamp as f64 * time_base);
                }
                break;
            }
            if (*decoder.packet).stream_index != decoder.stream_index {
                av_packet_unref(decoder.packet);
                continue;
            }
            let dts = (*decoder.packet).dts;
            if dts == AV_NOPTS_VALUE {
                av_packet_unref(decoder.packet);
                bail!("export packet has no decode timestamp");
            }
            if last_dts != AV_NOPTS_VALUE && dts < last_dts {
                av_packet_unref(decoder.packet);
                bail!("export stream decode timestamps move backwards");
            }
            last_dts = dts;
            let decoded = send_packet_and_receive(&mut decoder, target_timestamp, is_cancelled);
            av_packet_unref(decoder.packet);
            if let Some(timestamp) = decoded? {
                return Ok(timestamp as f64 * time_base);
            }
        }
    }
    bail!("export stream did not decode a frame near {target_s:.3}s")
}

fn count_timed_packets(
    path: &str,
    media_type: AVMediaType::Type,
    is_cancelled: &dyn Fn() -> bool,
) -> Result<u64> {
    let decoder = open_decoder(path, media_type)?;
    let mut packets = 0_u64;
    let mut last_dts = AV_NOPTS_VALUE;
    unsafe {
        loop {
            ensure_not_cancelled(is_cancelled)?;
            let read = av_read_frame(decoder.input.format, decoder.packet);
            if read == AVERROR_EOF {
                break;
            }
            averr(read, "export verification av_read_frame")?;
            if (*decoder.packet).stream_index == decoder.stream_index {
                let dts = (*decoder.packet).dts;
                let pts = (*decoder.packet).pts;
                if dts == AV_NOPTS_VALUE || pts == AV_NOPTS_VALUE {
                    av_packet_unref(decoder.packet);
                    bail!("export packet has missing timing information");
                }
                if last_dts != AV_NOPTS_VALUE && dts < last_dts {
                    av_packet_unref(decoder.packet);
                    bail!("export packet timestamps move backwards");
                }
                last_dts = dts;
                packets += 1;
            }
            av_packet_unref(decoder.packet);
        }
    }
    if packets == 0 {
        bail!("export stream contains no timed packets");
    }
    Ok(packets)
}

fn codec_id(expected: ExpectedVideoCodec) -> AVCodecID::Type {
    match expected {
        ExpectedVideoCodec::H264 => AVCodecID::AV_CODEC_ID_H264,
        ExpectedVideoCodec::H265 => AVCodecID::AV_CODEC_ID_HEVC,
    }
}

unsafe fn is_stereo_layout(layout: *const AVChannelLayout) -> bool {
    let mut stereo = AVChannelLayout::default();
    av_channel_layout_default(&mut stereo, 2);
    let matches = av_channel_layout_compare(layout, &stereo) == 0;
    av_channel_layout_uninit(&mut stereo);
    matches
}

/// Reopens and validates the staged MP4 before the main process publishes it.
pub fn verify_video_export(path: &str, spec: VideoExportSpec) -> Result<VideoExportVerification> {
    verify_video_export_with_cancel(path, spec, &|| false)
}

pub fn verify_video_export_with_cancel(
    path: &str,
    spec: VideoExportSpec,
    is_cancelled: &dyn Fn() -> bool,
) -> Result<VideoExportVerification> {
    ensure_not_cancelled(is_cancelled)?;
    if spec.width < 2
        || spec.height < 2
        || !spec.fps.is_finite()
        || spec.fps <= 0.0
        || !spec.duration_s.is_finite()
        || spec.duration_s <= 0.0
    {
        bail!("export verification received an invalid expected media contract");
    }

    let input = open_input(path)?;
    let mut video_streams = 0;
    let mut audio_streams = 0;
    let mut video_stream = ptr::null_mut();
    unsafe {
        for index in 0..sn_fmt_nb_streams(input.format) {
            ensure_not_cancelled(is_cancelled)?;
            let stream = sn_fmt_stream(input.format, index as i32);
            if stream.is_null() || (*stream).codecpar.is_null() {
                continue;
            }
            match (*(*stream).codecpar).codec_type {
                AVMediaType::AVMEDIA_TYPE_VIDEO => {
                    video_streams += 1;
                    video_stream = stream;
                }
                AVMediaType::AVMEDIA_TYPE_AUDIO => audio_streams += 1,
                _ => {}
            }
        }
        if video_streams != 1 || video_stream.is_null() {
            bail!("export must contain exactly one video stream, found {video_streams}");
        }
        if audio_streams != 1 {
            bail!("export must contain exactly one audio stream, found {audio_streams}");
        }

        let video = (*video_stream).codecpar;
        if (*video).width != spec.width as i32 || (*video).height != spec.height as i32 {
            bail!(
                "export dimensions are {}x{}, expected {}x{}",
                (*video).width,
                (*video).height,
                spec.width,
                spec.height
            );
        }
        if (*video).codec_id != codec_id(spec.codec) {
            bail!(
                "export video codec is {}, expected {}",
                (*video).codec_id,
                codec_id(spec.codec)
            );
        }

        let color_fields = [
            (*video).color_primaries == AVColorPrimaries::AVCOL_PRI_UNSPECIFIED,
            (*video).color_trc == AVColorTransferCharacteristic::AVCOL_TRC_UNSPECIFIED,
            (*video).color_space == AVColorSpace::AVCOL_SPC_UNSPECIFIED,
        ];
        if color_fields.iter().any(|unspecified| *unspecified)
            && color_fields.iter().any(|unspecified| !*unspecified)
        {
            bail!("export carries an incomplete color-description triplet");
        }

        // For constant-frame-rate MP4, r_frame_rate is the stream cadence.
        // avg_frame_rate divides frame count by the timestamp span from the
        // first frame to the last frame and therefore omits one final frame
        // duration (for example 60 frames at 30 fps can report 1800/59).
        let fps = rational_value((*video_stream).r_frame_rate)
            .or_else(|| rational_value((*video_stream).avg_frame_rate))
            .context("export has no valid frame rate")?;
        if (fps - spec.fps).abs() > 0.02 {
            bail!("export frame rate is {fps:.6}, expected {:.6}", spec.fps);
        }

        let duration_s = if (*input.format).duration > 0 {
            (*input.format).duration as f64 / AV_TIME_BASE
        } else {
            let time_base = rational_value((*video_stream).time_base)
                .context("export video stream has an invalid time base")?;
            (*video_stream).duration as f64 * time_base
        };
        let duration_tolerance = (2.0 / spec.fps).max(0.25);
        if !duration_s.is_finite()
            || duration_s <= 0.0
            || (duration_s - spec.duration_s).abs() > duration_tolerance
        {
            bail!(
                "export duration is {duration_s:.6}s, expected {:.6}s (tolerance {duration_tolerance:.3}s)",
                spec.duration_s
            );
        }

        for index in 0..sn_fmt_nb_streams(input.format) {
            ensure_not_cancelled(is_cancelled)?;
            let stream = sn_fmt_stream(input.format, index as i32);
            if stream.is_null()
                || (*stream).codecpar.is_null()
                || (*(*stream).codecpar).codec_type != AVMediaType::AVMEDIA_TYPE_AUDIO
            {
                continue;
            }
            let audio = (*stream).codecpar;
            if (*audio).codec_id != AVCodecID::AV_CODEC_ID_AAC
                || (*audio).sample_rate != 48_000
                || !is_stereo_layout(&(*audio).ch_layout)
            {
                bail!(
                    "export audio contract is codec={}, rate={}, channels={}",
                    (*audio).codec_id,
                    (*audio).sample_rate,
                    (*audio).ch_layout.nb_channels
                );
            }
        }

        drop(input);
        ensure_not_cancelled(is_cancelled)?;
        let first_video_frame_s =
            decode_frame_at(path, AVMediaType::AVMEDIA_TYPE_VIDEO, 0.0, is_cancelled)?;
        let decode_tolerance = (2.0 / spec.fps).max(0.05);
        let tail_target_s = (spec.duration_s - decode_tolerance).max(0.0);
        let tail_video_frame_s = decode_frame_at(
            path,
            AVMediaType::AVMEDIA_TYPE_VIDEO,
            tail_target_s,
            is_cancelled,
        )?;
        let first_audio_frame_s =
            decode_frame_at(path, AVMediaType::AVMEDIA_TYPE_AUDIO, 0.0, is_cancelled)?;
        let tail_audio_frame_s = decode_frame_at(
            path,
            AVMediaType::AVMEDIA_TYPE_AUDIO,
            tail_target_s,
            is_cancelled,
        )?;
        if first_video_frame_s > duration_tolerance || first_audio_frame_s > duration_tolerance {
            bail!("export opening media is not decodable near time zero");
        }
        if tail_video_frame_s + decode_tolerance < tail_target_s {
            bail!(
                "export tail decoded at {tail_video_frame_s:.6}s, before target {tail_target_s:.6}s"
            );
        }
        if tail_audio_frame_s + decode_tolerance < tail_target_s {
            bail!(
                "export audio tail decoded at {tail_audio_frame_s:.6}s, before target {tail_target_s:.6}s"
            );
        }

        Ok(VideoExportVerification {
            duration_s,
            fps,
            video_streams,
            audio_streams,
            first_video_frame_s,
            tail_video_frame_s,
        })
    }
}

/// Reopens and validates the staged GIF before the main process publishes it.
pub fn verify_gif_export(path: &str, spec: GifExportSpec) -> Result<GifExportVerification> {
    verify_gif_export_with_cancel(path, spec, &|| false)
}

pub fn verify_gif_export_with_cancel(
    path: &str,
    spec: GifExportSpec,
    is_cancelled: &dyn Fn() -> bool,
) -> Result<GifExportVerification> {
    ensure_not_cancelled(is_cancelled)?;
    if spec.width == 0
        || spec.height == 0
        || !spec.fps.is_finite()
        || spec.fps <= 0.0
        || !spec.duration_s.is_finite()
        || spec.duration_s <= 0.0
    {
        bail!("GIF verification received an invalid expected media contract");
    }

    let input = open_input(path)?;
    let mut video_streams = 0;
    let mut audio_streams = 0;
    let mut video_stream = ptr::null_mut();
    unsafe {
        for index in 0..sn_fmt_nb_streams(input.format) {
            ensure_not_cancelled(is_cancelled)?;
            let stream = sn_fmt_stream(input.format, index as i32);
            if stream.is_null() || (*stream).codecpar.is_null() {
                continue;
            }
            match (*(*stream).codecpar).codec_type {
                AVMediaType::AVMEDIA_TYPE_VIDEO => {
                    video_streams += 1;
                    video_stream = stream;
                }
                AVMediaType::AVMEDIA_TYPE_AUDIO => audio_streams += 1,
                _ => {}
            }
        }
        if video_streams != 1 || video_stream.is_null() || audio_streams != 0 {
            bail!(
                "GIF must contain one video stream and no audio, found video={video_streams}, audio={audio_streams}"
            );
        }
        let video = (*video_stream).codecpar;
        if (*video).codec_id != AVCodecID::AV_CODEC_ID_GIF {
            bail!("GIF stream uses unexpected codec {}", (*video).codec_id);
        }
        if (*video).width != spec.width as i32 || (*video).height != spec.height as i32 {
            bail!(
                "GIF dimensions are {}x{}, expected {}x{}",
                (*video).width,
                (*video).height,
                spec.width,
                spec.height
            );
        }
        let duration_s = if (*input.format).duration > 0 {
            (*input.format).duration as f64 / AV_TIME_BASE
        } else {
            let time_base = rational_value((*video_stream).time_base)
                .context("GIF stream has an invalid time base")?;
            (*video_stream).duration as f64 * time_base
        };
        let duration_tolerance = 0.15;
        if !duration_s.is_finite()
            || duration_s <= 0.0
            || (duration_s - spec.duration_s).abs() > duration_tolerance
        {
            bail!(
                "GIF duration is {duration_s:.6}s, expected {:.6}s (tolerance {duration_tolerance:.3}s)",
                spec.duration_s
            );
        }

        drop(input);
        ensure_not_cancelled(is_cancelled)?;
        // GIF is variable-frame-rate: its integer-centisecond delays can make
        // FFmpeg's avg_frame_rate report the shortest delay instead of the
        // whole animation rate. Count timed image packets and divide by the
        // validated duration so the check follows playback, not one delay.
        let frame_count = count_timed_packets(path, AVMediaType::AVMEDIA_TYPE_VIDEO, is_cancelled)?;
        let fps = frame_count as f64 / duration_s;
        let fps_tolerance = (1.0 / duration_s).max(0.02);
        if (fps - spec.fps).abs() > fps_tolerance {
            bail!("GIF frame rate is {fps:.6}, expected {:.6}", spec.fps);
        }
        let first_frame_s =
            decode_frame_at(path, AVMediaType::AVMEDIA_TYPE_VIDEO, 0.0, is_cancelled)?;
        let frame_tolerance = (2.0 / spec.fps).max(0.05);
        let tail_target_s = (spec.duration_s - frame_tolerance).max(0.0);
        let tail_frame_s = decode_frame_at(
            path,
            AVMediaType::AVMEDIA_TYPE_VIDEO,
            tail_target_s,
            is_cancelled,
        )?;
        if tail_frame_s + frame_tolerance < tail_target_s {
            bail!("GIF tail decoded at {tail_frame_s:.6}s, before target {tail_target_s:.6}s");
        }

        Ok(GifExportVerification {
            duration_s,
            fps,
            video_streams,
            first_frame_s,
            tail_frame_s,
        })
    }
}
