//! Shared export settings used by the macOS, Windows, and Linux encoder pipelines.

use crate::ffi::{
    av_dict_free, av_dict_set, av_packet_free, avformat_free_context, avformat_write_header,
    avio_closep, sn_fmt_set_pb, AVFormatContext, AVIOContext, AVPacket,
};
use std::ffi::CString;
use std::ptr;

pub const MIN_VIDEO_BITRATE: u32 = 1_000_000;
pub const MAX_VIDEO_BITRATE: u32 = 200_000_000;

/// Owns the raw FFmpeg output resources used by every MP4 pipeline.
///
/// Native cancellation returns through `?` from frame and finalization
/// checkpoints. Keeping these pointers in one guard makes every such return
/// close the staging file and free the muxer and packet.
pub(crate) struct MuxOutputGuard {
    context: *mut AVFormatContext,
    io: *mut AVIOContext,
    packet: *mut AVPacket,
}

impl MuxOutputGuard {
    pub(crate) fn new() -> Self {
        Self {
            context: ptr::null_mut(),
            io: ptr::null_mut(),
            packet: ptr::null_mut(),
        }
    }

    pub(crate) fn context(&self) -> *mut AVFormatContext {
        self.context
    }

    pub(crate) fn context_mut(&mut self) -> *mut *mut AVFormatContext {
        &mut self.context
    }

    pub(crate) fn io_mut(&mut self) -> *mut *mut AVIOContext {
        &mut self.io
    }

    pub(crate) fn packet(&self) -> *mut AVPacket {
        self.packet
    }

    pub(crate) fn packet_mut(&mut self) -> *mut *mut AVPacket {
        &mut self.packet
    }

    pub(crate) unsafe fn bind_io(&self) {
        sn_fmt_set_pb(self.context, self.io);
    }
}

impl Drop for MuxOutputGuard {
    fn drop(&mut self) {
        unsafe {
            if !self.packet.is_null() {
                av_packet_free(&mut self.packet);
            }
            if !self.io.is_null() {
                if !self.context.is_null() {
                    sn_fmt_set_pb(self.context, ptr::null_mut());
                }
                avio_closep(&mut self.io);
            }
            if !self.context.is_null() {
                avformat_free_context(self.context);
                self.context = ptr::null_mut();
            }
        }
    }
}

/// Uses the app's requested bitrate when present. Older callers keep the historical
/// resolution-scaled fallback so the native API remains backwards compatible.
pub fn resolve_video_bitrate(width: u32, height: u32, requested: Option<u32>) -> i64 {
    requested.map(i64::from).unwrap_or_else(|| {
        ((width as i64 * height as i64 * 8_000_000) / (1920 * 1080)).max(2_000_000)
    })
}

pub fn validate_video_bitrate(bitrate: u32) -> Result<u32, String> {
    if !(MIN_VIDEO_BITRATE..=MAX_VIDEO_BITRATE).contains(&bitrate) {
        return Err(format!(
            "video bitrate must be between {} and {} bits/s, got {bitrate}",
            MIN_VIDEO_BITRATE, MAX_VIDEO_BITRATE
        ));
    }
    Ok(bitrate)
}

/// Bytes to reserve for the MP4 index at the front of the file. At worst a sample
/// costs 44 bytes (size, timing, composition offset, sync, and its own chunk's
/// offset and table entry); 64 leaves margin. One MiB covers headers and track
/// boxes. The muxer fails rather than truncating if a sample count
/// was underestimated, so callers pass an upper bound.
pub fn mp4_index_reserve_bytes(video_samples: u64, audio_samples: u64) -> u64 {
    64 * (video_samples + audio_samples) + 1024 * 1024
}

/// Writes the header with the index reserved at the front (`moov_size`), so the
/// finished file is written once. `+faststart` instead rewrites every byte of the
/// file after the trailer to move the index there.
pub unsafe fn write_mp4_header_with_index_reserve(
    output: *mut AVFormatContext,
    reserve_bytes: u64,
) -> anyhow::Result<()> {
    let key = CString::new("moov_size")?;
    let value = CString::new(reserve_bytes.min(i32::MAX as u64).to_string())?;
    let mut options = ptr::null_mut();
    crate::ffi::averr(
        av_dict_set(&mut options, key.as_ptr(), value.as_ptr(), 0),
        "set moov_size",
    )?;
    let result = crate::ffi::averr(avformat_write_header(output, &mut options), "write_header");
    av_dict_free(&mut options);
    result
}

/// Writes the MP4 header with `faststart`, so FFmpeg moves `moov` before media data at trailer
/// time. YouTube recommends this layout and browsers can begin playback before full download.
pub unsafe fn write_mp4_header(output: *mut AVFormatContext) -> anyhow::Result<()> {
    let key = CString::new("movflags")?;
    let value = CString::new("+faststart")?;
    let mut options = ptr::null_mut();
    crate::ffi::averr(
        av_dict_set(&mut options, key.as_ptr(), value.as_ptr(), 0),
        "set movflags=faststart",
    )?;
    let result = crate::ffi::averr(avformat_write_header(output, &mut options), "write_header");
    av_dict_free(&mut options);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn index_reserve_covers_every_sample_plus_headers() {
        assert_eq!(mp4_index_reserve_bytes(0, 0), 1024 * 1024);
        // 63 minutes at 60 fps with 48 kHz AAC: about 26 MB, against 35 GB of media.
        let video = 63 * 60 * 60;
        let audio = (63 * 60 * 48_000u64).div_ceil(1024);
        assert_eq!(
            mp4_index_reserve_bytes(video, audio),
            64 * (video + audio) + 1024 * 1024
        );
    }

    #[test]
    fn requested_bitrate_overrides_the_legacy_resolution_fallback() {
        assert_eq!(
            resolve_video_bitrate(1920, 1080, Some(30_000_000)),
            30_000_000
        );
        assert_eq!(
            resolve_video_bitrate(3840, 2160, Some(80_000_000)),
            80_000_000
        );
    }

    #[test]
    fn missing_bitrate_keeps_old_native_callers_compatible() {
        assert_eq!(resolve_video_bitrate(1920, 1080, None), 8_000_000);
        assert_eq!(resolve_video_bitrate(640, 360, None), 2_000_000);
    }

    #[test]
    fn rejects_unsafe_or_accidental_bitrate_values() {
        assert!(validate_video_bitrate(0).is_err());
        assert!(validate_video_bitrate(500_000).is_err());
        assert!(validate_video_bitrate(80_000_000).is_ok());
        assert!(validate_video_bitrate(250_000_000).is_err());
    }
}
