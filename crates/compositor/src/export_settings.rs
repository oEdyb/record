//! Shared export settings used by the macOS, Windows, and Linux encoder pipelines.

use crate::ffi::{av_dict_free, av_dict_set, avformat_write_header, AVFormatContext};
use std::ffi::CString;
use std::ptr;

pub const MIN_VIDEO_BITRATE: u32 = 1_000_000;
pub const MAX_VIDEO_BITRATE: u32 = 200_000_000;

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
