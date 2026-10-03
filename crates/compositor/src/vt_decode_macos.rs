//! Bounded decode-ahead for non-reordering MP4/MOV video. The consumer owns demux;
//! VideoToolbox callbacks only retain output and signal the consumer.
use crate::ffi;
use anyhow::{anyhow, bail, Result};
use core_foundation::{
    base::{CFRelease, CFTypeRef, TCFType},
    boolean::CFBoolean,
    data::CFData,
    dictionary::CFDictionary,
    number::CFNumber,
    string::{CFString, CFStringRef},
};
use std::{
    collections::VecDeque,
    ffi::{c_void, CStr},
    ptr,
    sync::{Condvar, Mutex, MutexGuard},
};

type Ref = *mut c_void;
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct CMTime {
    value: i64,
    timescale: i32,
    flags: u32,
    epoch: i64,
}
#[repr(C)]
struct Timing {
    duration: CMTime,
    pts: CMTime,
    dts: CMTime,
}
#[repr(C)]
struct Callback {
    function: unsafe extern "C" fn(Ref, Ref, i32, u32, Ref, CMTime, CMTime),
    context: Ref,
}

#[link(name = "CoreMedia", kind = "framework")]
extern "C" {
    static kCMFormatDescriptionExtension_SampleDescriptionExtensionAtoms: CFStringRef;
    fn CMVideoFormatDescriptionCreate(
        a: CFTypeRef,
        codec: u32,
        w: i32,
        h: i32,
        extensions: CFTypeRef,
        out: *mut Ref,
    ) -> i32;
    fn CMBlockBufferCreateWithMemoryBlock(
        a: CFTypeRef,
        memory: Ref,
        len: usize,
        block_allocator: CFTypeRef,
        custom: CFTypeRef,
        offset: usize,
        data_len: usize,
        flags: u32,
        out: *mut Ref,
    ) -> i32;
    fn CMBlockBufferReplaceDataBytes(
        src: *const c_void,
        block: Ref,
        offset: usize,
        len: usize,
    ) -> i32;
    fn CMSampleBufferCreateReady(
        a: CFTypeRef,
        block: Ref,
        format: Ref,
        count: isize,
        timing_count: isize,
        timing: *const Timing,
        size_count: isize,
        sizes: *const usize,
        out: *mut Ref,
    ) -> i32;
}
#[link(name = "VideoToolbox", kind = "framework")]
extern "C" {
    static kVTVideoDecoderSpecification_EnableHardwareAcceleratedVideoDecoder: CFStringRef;
    static kVTDecompressionPropertyKey_UsingHardwareAcceleratedVideoDecoder: CFStringRef;
    static kVTDecompressionPropertyKey_RealTime: CFStringRef;
    static kVTDecompressionPropertyKey_OutputPoolRequestedMinimumBufferCount: CFStringRef;
    fn VTDecompressionSessionCreate(
        a: CFTypeRef,
        format: Ref,
        spec: CFTypeRef,
        attrs: CFTypeRef,
        callback: *const Callback,
        out: *mut Ref,
    ) -> i32;
    fn VTSessionSetProperty(session: Ref, key: CFStringRef, value: CFTypeRef) -> i32;
    fn VTSessionCopyProperty(
        session: Ref,
        key: CFStringRef,
        a: CFTypeRef,
        out: *mut CFTypeRef,
    ) -> i32;
    fn VTDecompressionSessionDecodeFrame(
        session: Ref,
        sample: Ref,
        flags: u32,
        context: Ref,
        info: *mut u32,
    ) -> i32;
    fn VTDecompressionSessionFinishDelayedFrames(session: Ref) -> i32;
    fn VTDecompressionSessionWaitForAsynchronousFrames(session: Ref) -> i32;
    fn VTDecompressionSessionInvalidate(session: Ref);
}
#[link(name = "CoreVideo", kind = "framework")]
extern "C" {
    static kCVPixelBufferPixelFormatTypeKey: CFStringRef;
    static kCVPixelBufferIOSurfacePropertiesKey: CFStringRef;
    static kCVPixelBufferMetalCompatibilityKey: CFStringRef;
    fn CVPixelBufferRetain(pb: Ref) -> Ref;
    fn CVPixelBufferRelease(pb: Ref);
    fn CVPixelBufferGetWidth(pb: Ref) -> usize;
    fn CVPixelBufferGetHeight(pb: Ref) -> usize;
}
struct OwnedCf(Ref);
impl Drop for OwnedCf {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CFRelease(self.0) };
        }
    }
}
struct Output {
    pb: Ref,
    pts: CMTime,
}
// Each retained, immutable pixel buffer has a single owner until moved into AVBufferRef.
unsafe impl Send for Output {}
impl Drop for Output {
    fn drop(&mut self) {
        unsafe { CVPixelBufferRelease(self.pb) };
    }
}
impl Output {
    unsafe fn into_frame(self, into: *mut ffi::AVFrame, pts: i64) -> Result<()> {
        let buffer = ffi::av_buffer_create(
            self.pb.cast(),
            0,
            Some(release_pixel_buffer),
            ptr::null_mut(),
            0,
        );
        if buffer.is_null() {
            bail!("av_buffer_create (async VT)");
        }
        (*into).buf[0] = buffer;
        (*into).format = ffi::AVPixelFormat::AV_PIX_FMT_VIDEOTOOLBOX as i32;
        (*into).width = CVPixelBufferGetWidth(self.pb) as i32;
        (*into).height = CVPixelBufferGetHeight(self.pb) as i32;
        (*into).data[3] = self.pb.cast();
        (*into).pts = pts;
        (*into).best_effort_timestamp = pts;
        std::mem::forget(self); // AVBufferRef now owns the retained pixel buffer.
        Ok(())
    }
}
#[derive(Default)]
struct State {
    queue: VecDeque<Output>,
    in_flight: usize,
    error: Option<i32>,
}
struct Shared {
    state: Mutex<State>,
    ready: Condvar,
}
impl Shared {
    fn lock(&self) -> MutexGuard<'_, State> {
        match self.state.lock() {
            Ok(s) => s,
            Err(e) => e.into_inner(),
        }
    }
}
unsafe extern "C" fn output_callback(
    context: Ref,
    _: Ref,
    status: i32,
    _: u32,
    image: Ref,
    pts: CMTime,
    _: CMTime,
) {
    let shared = &*(context as *const Shared);
    let mut state = shared.lock();
    if status != 0 {
        state.error = Some(status);
    } else if !image.is_null() {
        CVPixelBufferRetain(image);
        state.queue.push_back(Output { pb: image, pts });
    }
    state.in_flight = state.in_flight.saturating_sub(1);
    shared.ready.notify_one();
}
unsafe extern "C" fn release_pixel_buffer(_: Ref, data: *mut u8) {
    CVPixelBufferRelease(data.cast());
}
fn check(status: i32, operation: &str) -> Result<()> {
    if status != 0 {
        bail!("{operation}: OSStatus={status}");
    }
    Ok(())
}

// VTErrors.h: async=bit 0, do-not-output=bit 1, temporal=bit 3.
fn decode_flags(packet_flags: i32) -> u32 {
    let discard = packet_flags & ffi::AV_PKT_FLAG_DISCARD as i32 != 0;
    (1 << 0) | (1 << 3) | if discard { 1 << 1 } else { 0 }
}

pub(crate) struct AsyncDecoder {
    session: OwnedCf,
    format: OwnedCf,
    // Stable address, alive until session invalidation and all callbacks finish.
    shared: Box<Shared>,
    tb: ffi::AVRational,
    limit: usize,
    eof: bool,
    last_pts: Option<i64>,
    path: String,
    pub(crate) hardware: bool,
}
impl AsyncDecoder {
    pub(crate) unsafe fn eligible(
        fmt: *mut ffi::AVFormatContext,
        ctx: *mut ffi::AVCodecContext,
        par: *mut ffi::AVCodecParameters,
    ) -> bool {
        let input = (*fmt).iformat;
        !input.is_null()
            && !(*input).name.is_null()
            && CStr::from_ptr((*input).name)
                .to_bytes()
                .split(|b| *b == b',')
                .any(|n| n == b"mov")
            && matches!(
                (*par).codec_id,
                ffi::AVCodecID::AV_CODEC_ID_H264 | ffi::AVCodecID::AV_CODEC_ID_HEVC
            )
            && (*par).video_delay == 0
            && (*ctx).has_b_frames == 0
            && (*par).extradata_size > 0
            && !(*par).extradata.is_null()
            && *(*par).extradata == 1
    }
    pub(crate) unsafe fn new(
        par: *mut ffi::AVCodecParameters,
        tb: ffi::AVRational,
        path: &str,
    ) -> Result<Self> {
        if tb.num <= 0 || tb.den <= 0 {
            bail!("invalid video time base in {path}");
        }
        let limit = match std::env::var("OPENSCREEN_VT_INFLIGHT") {
            Ok(s) => s
                .parse::<usize>()
                .ok()
                .filter(|n| (1..=64).contains(n))
                .ok_or_else(|| anyhow!("OPENSCREEN_VT_INFLIGHT must be 1..=64"))?,
            Err(_) => 4,
        };
        let hevc = (*par).codec_id == ffi::AVCodecID::AV_CODEC_ID_HEVC;
        let atoms = CFDictionary::from_CFType_pairs(&[(
            CFString::new(if hevc { "hvcC" } else { "avcC" }).as_CFType(),
            CFData::from_buffer(std::slice::from_raw_parts(
                (*par).extradata,
                (*par).extradata_size as usize,
            ))
            .as_CFType(),
        )]);
        let extensions = CFDictionary::from_CFType_pairs(&[(
            CFString::wrap_under_get_rule(
                kCMFormatDescriptionExtension_SampleDescriptionExtensionAtoms,
            )
            .as_CFType(),
            atoms.as_CFType(),
        )]);
        let mut decoder = Self {
            session: OwnedCf(ptr::null_mut()),
            format: OwnedCf(ptr::null_mut()),
            shared: Box::new(Shared {
                state: Mutex::new(State {
                    queue: VecDeque::with_capacity(limit),
                    ..State::default()
                }),
                ready: Condvar::new(),
            }),
            tb,
            limit,
            eof: false,
            last_pts: None,
            path: path.to_owned(),
            hardware: false,
        };
        check(
            CMVideoFormatDescriptionCreate(
                ptr::null(),
                if hevc {
                    u32::from_be_bytes(*b"hvc1")
                } else {
                    u32::from_be_bytes(*b"avc1")
                },
                (*par).width,
                (*par).height,
                extensions.as_CFTypeRef(),
                &mut decoder.format.0,
            ),
            "CMVideoFormatDescriptionCreate",
        )?;
        let spec = CFDictionary::from_CFType_pairs(&[(
            CFString::wrap_under_get_rule(
                kVTVideoDecoderSpecification_EnableHardwareAcceleratedVideoDecoder,
            )
            .as_CFType(),
            CFBoolean::true_value().as_CFType(),
        )]);
        let empty: CFDictionary<CFString, CFString> = CFDictionary::from_CFType_pairs(&[]);
        let attrs = CFDictionary::from_CFType_pairs(&[
            (
                CFString::wrap_under_get_rule(kCVPixelBufferPixelFormatTypeKey).as_CFType(),
                CFNumber::from(u32::from_be_bytes(*b"420v") as i32).as_CFType(),
            ),
            (
                CFString::wrap_under_get_rule(kCVPixelBufferIOSurfacePropertiesKey).as_CFType(),
                empty.as_CFType(),
            ),
            (
                CFString::wrap_under_get_rule(kCVPixelBufferMetalCompatibilityKey).as_CFType(),
                CFBoolean::true_value().as_CFType(),
            ),
        ]);
        let callback = Callback {
            function: output_callback,
            context: (&*decoder.shared as *const Shared).cast_mut().cast(),
        };
        check(
            VTDecompressionSessionCreate(
                ptr::null(),
                decoder.format.0,
                spec.as_CFTypeRef(),
                attrs.as_CFTypeRef(),
                &callback,
                &mut decoder.session.0,
            ),
            "VTDecompressionSessionCreate",
        )?;
        check(
            VTSessionSetProperty(
                decoder.session.0,
                kVTDecompressionPropertyKey_RealTime,
                CFBoolean::false_value().as_CFTypeRef(),
            ),
            "VT RealTime=false",
        )?;
        // Apple's SDK forbids setting both RealTime and MaximizePowerEfficiency.
        // Leave the latter at its documented NULL/false default.
        check(
            VTSessionSetProperty(
                decoder.session.0,
                kVTDecompressionPropertyKey_OutputPoolRequestedMinimumBufferCount,
                CFNumber::from((2 * limit + 2) as i32).as_CFTypeRef(),
            ),
            "VT output pool minimum",
        )?;
        let mut hardware: CFTypeRef = ptr::null();
        check(
            VTSessionCopyProperty(
                decoder.session.0,
                kVTDecompressionPropertyKey_UsingHardwareAcceleratedVideoDecoder,
                ptr::null(),
                &mut hardware,
            ),
            "VT hardware query",
        )?;
        if !hardware.is_null() {
            let value = CFBoolean::wrap_under_create_rule(hardware.cast());
            decoder.hardware = bool::from(value);
        }
        eprintln!(
            "[decode] async VideoToolbox session for {path}: hardware={} inflight={limit}",
            decoder.hardware
        );
        Ok(decoder)
    }
    pub(crate) fn path_label(&self) -> String {
        format!("videotoolbox-async(inflight={})", self.limit)
    }
    fn time(&self, pts: i64) -> Result<CMTime> {
        if pts == i64::MIN {
            return Ok(CMTime::default());
        }
        Ok(CMTime {
            value: pts
                .checked_mul(self.tb.num as i64)
                .ok_or_else(|| anyhow!("timestamp overflow in {}", self.path))?,
            timescale: self.tb.den,
            flags: 1,
            epoch: 0,
        })
    }
    fn pts(&self, time: CMTime) -> i64 {
        if time.flags & 1 == 0 || time.flags & 0x1c != 0 || time.timescale <= 0 {
            return i64::MIN;
        }
        unsafe {
            ffi::av_rescale_q(
                time.value,
                ffi::AVRational {
                    num: 1,
                    den: time.timescale,
                },
                self.tb,
            )
        }
    }
    unsafe fn submit(&mut self, packet: *mut ffi::AVPacket) -> Result<()> {
        if (*packet).size <= 0 || (*packet).data.is_null() {
            bail!("empty video packet in {}", self.path);
        }
        let size = (*packet).size as usize;
        let mut block = OwnedCf(ptr::null_mut());
        check(
            CMBlockBufferCreateWithMemoryBlock(
                ptr::null(),
                ptr::null_mut(),
                size,
                ptr::null(),
                ptr::null(),
                0,
                size,
                1,
                &mut block.0,
            ),
            "CMBlockBufferCreateWithMemoryBlock",
        )?;
        check(
            CMBlockBufferReplaceDataBytes((*packet).data.cast(), block.0, 0, size),
            "CMBlockBufferReplaceDataBytes",
        )?;
        let timing = Timing {
            duration: self.time((*packet).duration)?,
            pts: self.time(if (*packet).pts == i64::MIN {
                (*packet).dts
            } else {
                (*packet).pts
            })?,
            dts: self.time((*packet).dts)?,
        };
        let mut sample = OwnedCf(ptr::null_mut());
        check(
            CMSampleBufferCreateReady(
                ptr::null(),
                block.0,
                self.format.0,
                1,
                1,
                &timing,
                1,
                &size,
                &mut sample.0,
            ),
            "CMSampleBufferCreateReady",
        )?;
        // A callback may run synchronously, before DecodeFrame returns.
        self.shared.lock().in_flight += 1;
        let mut info = 0;
        let status = VTDecompressionSessionDecodeFrame(
            self.session.0,
            sample.0,
            decode_flags((*packet).flags),
            ptr::null_mut(),
            &mut info,
        );
        if status != 0 {
            let mut state = self.shared.lock();
            state.in_flight -= 1; // Apple's contract: no callback on submission error.
            state.error = Some(status);
        }
        check(status, "VTDecompressionSessionDecodeFrame")
    }
    unsafe fn drain(&self) -> Result<()> {
        let finish = VTDecompressionSessionFinishDelayedFrames(self.session.0);
        let wait = VTDecompressionSessionWaitForAsynchronousFrames(self.session.0);
        check(finish, "VTDecompressionSessionFinishDelayedFrames")?;
        check(wait, "VTDecompressionSessionWaitForAsynchronousFrames")
    }
    pub(crate) unsafe fn reset(&mut self) -> Result<()> {
        self.drain()?;
        *self.shared.lock() = State {
            queue: VecDeque::with_capacity(self.limit),
            ..State::default()
        };
        self.eof = false;
        self.last_pts = None;
        Ok(())
    }
    pub(crate) unsafe fn receive_into(
        &mut self,
        fmt: *mut ffi::AVFormatContext,
        vidx: i32,
        packet: *mut ffi::AVPacket,
        into: *mut ffi::AVFrame,
    ) -> Result<bool> {
        ffi::av_frame_unref(into);
        loop {
            let mut state = self.shared.lock();
            if let Some(error) = state.error {
                bail!("VideoToolbox decode error {error} in {}", self.path);
            }
            // Refill before delivery, counting queued outputs too. Otherwise fast
            // callbacks drain the queue first and collapse decode-ahead to one frame.
            if !self.eof && state.in_flight + state.queue.len() < self.limit {
                drop(state);
                let status = ffi::av_read_frame(fmt, packet);
                if status == ffi::AVERROR_EOF {
                    self.eof = true;
                    self.drain()?;
                } else {
                    ffi::averr(status, "read_frame (async VT)")?;
                    let result = if (*packet).stream_index == vidx {
                        self.submit(packet)
                    } else {
                        Ok(())
                    };
                    ffi::av_packet_unref(packet);
                    result?;
                }
                continue;
            }
            if let Some(output) = state.queue.pop_front() {
                drop(state);
                let pts = self.pts(output.pts);
                if pts != i64::MIN {
                    if self.last_pts.is_some_and(|last| pts < last) {
                        bail!("non-monotonic VideoToolbox PTS in {}; reopen with OPENSCREEN_MAC_DECODE=ffmpeg-videotoolbox", self.path);
                    }
                    debug_assert!(self.last_pts.is_none_or(|last| pts >= last));
                    self.last_pts = Some(pts);
                }
                output.into_frame(into, pts)?;
                return Ok(true);
            }
            if self.eof && state.in_flight == 0 {
                return Ok(false);
            }
            // Temporal processing may hold callbacks indefinitely, even for a
            // stream without B-frames. Request delayed output before waiting at
            // capacity; never hold the callback mutex across a VT call.
            drop(state);
            check(
                VTDecompressionSessionFinishDelayedFrames(self.session.0),
                "VTDecompressionSessionFinishDelayedFrames (backpressure)",
            )?;
            let state = self.shared.lock();
            if state.queue.is_empty() && state.error.is_none() && state.in_flight >= self.limit {
                drop(match self.shared.ready.wait(state) {
                    Ok(s) => s,
                    Err(e) => e.into_inner(),
                });
            }
        }
    }
}
impl Drop for AsyncDecoder {
    fn drop(&mut self) {
        if !self.session.0.is_null() {
            unsafe {
                let _ = self.drain();
                VTDecompressionSessionInvalidate(self.session.0);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn without_session(tb: ffi::AVRational) -> AsyncDecoder {
        AsyncDecoder {
            session: OwnedCf(ptr::null_mut()),
            format: OwnedCf(ptr::null_mut()),
            shared: Box::new(Shared {
                state: Mutex::new(State::default()),
                ready: Condvar::new(),
            }),
            tb,
            limit: 4,
            eof: false,
            last_pts: None,
            path: "timestamp-test.mp4".into(),
            hardware: false,
        }
    }

    #[test]
    fn timestamps_preserve_nonunit_timebase_negative_and_missing_pts() {
        let decoder = without_session(ffi::AVRational {
            num: 1001,
            den: 60000,
        });
        for pts in [i64::MIN, -120, -1, 0, 1, 59940] {
            assert_eq!(decoder.pts(decoder.time(pts).unwrap()), pts);
        }
        assert_eq!(
            decoder.pts(CMTime {
                value: 1001,
                timescale: 30000,
                flags: 1,
                epoch: 0
            }),
            2
        );
        assert_eq!(
            decoder.pts(CMTime {
                value: 0,
                timescale: 0,
                flags: 1,
                epoch: 0
            }),
            i64::MIN
        );
        assert!(decoder.time(i64::MAX).is_err());
    }

    #[test]
    fn discarded_preroll_decodes_without_display_and_retires_callback() {
        assert_eq!(decode_flags(0), 9);
        assert_eq!(decode_flags(ffi::AV_PKT_FLAG_DISCARD as i32), 11);
        let decoder = without_session(ffi::AVRational { num: 1, den: 600 });
        decoder.shared.lock().in_flight = 1;
        unsafe {
            output_callback(
                (&*decoder.shared as *const Shared).cast_mut().cast(),
                ptr::null_mut(),
                0,
                2,
                ptr::null_mut(),
                CMTime::default(),
                CMTime::default(),
            );
        }
        let state = decoder.shared.lock();
        assert_eq!(state.in_flight, 0);
        assert!(state.error.is_none() && state.queue.is_empty());
    }

    #[test]
    fn callback_error_retires_submission_without_queueing_output() {
        let decoder = without_session(ffi::AVRational { num: 1, den: 600 });
        decoder.shared.lock().in_flight = 1;
        unsafe {
            output_callback(
                (&*decoder.shared as *const Shared).cast_mut().cast(),
                ptr::null_mut(),
                -12909,
                0,
                ptr::null_mut(),
                CMTime::default(),
                CMTime::default(),
            );
        }
        let state = decoder.shared.lock();
        assert_eq!(state.in_flight, 0);
        assert_eq!(state.error, Some(-12909));
        assert!(state.queue.is_empty());
    }

    #[test]
    fn callback_pixel_buffer_survives_frame_clone_and_queue_cleanup() {
        #[link(name = "CoreVideo", kind = "framework")]
        extern "C" {
            fn CVPixelBufferCreate(
                a: CFTypeRef,
                w: usize,
                h: usize,
                format: u32,
                attrs: CFTypeRef,
                out: *mut Ref,
            ) -> i32;
        }
        unsafe {
            let mut pb = ptr::null_mut();
            assert_eq!(
                CVPixelBufferCreate(
                    ptr::null(),
                    64,
                    64,
                    u32::from_be_bytes(*b"420v"),
                    ptr::null(),
                    &mut pb
                ),
                0
            );
            let owner = OwnedCf(pb);
            let decoder = without_session(ffi::AVRational { num: 1, den: 600 });
            decoder.shared.lock().in_flight = 2;
            for pts in [10, 20] {
                output_callback(
                    (&*decoder.shared as *const Shared).cast_mut().cast(),
                    ptr::null_mut(),
                    0,
                    0,
                    pb,
                    decoder.time(pts).unwrap(),
                    CMTime::default(),
                );
            }
            assert_eq!(decoder.shared.lock().in_flight, 0);
            let output = decoder.shared.lock().queue.pop_front().unwrap();
            let mut frame = ffi::av_frame_alloc();
            assert!(!frame.is_null());
            output.into_frame(frame, 10).unwrap();
            let mut clone = ffi::av_frame_clone(frame);
            assert!(!clone.is_null());
            ffi::av_frame_free(&mut frame);
            decoder.shared.lock().queue.clear();
            drop(owner);
            assert_eq!((*clone).pts, 10);
            assert_eq!((*clone).best_effort_timestamp, 10);
            assert_eq!(CVPixelBufferGetWidth((*clone).data[3].cast()), 64);
            assert_eq!(CVPixelBufferGetHeight((*clone).data[3].cast()), 64);
            ffi::av_frame_free(&mut clone);
        }
    }

    #[test]
    fn eligibility_rejects_reordering_annex_b_and_other_containers() {
        unsafe {
            let fmt = ffi::avformat_alloc_context();
            let mut ctx = ffi::avcodec_alloc_context3(ptr::null());
            let mut par = ffi::avcodec_parameters_alloc();
            assert!(!fmt.is_null() && !ctx.is_null() && !par.is_null());
            (*fmt).iformat = ffi::av_find_input_format(c"mov".as_ptr());
            (*par).codec_id = ffi::AVCodecID::AV_CODEC_ID_H264;
            let mut data = [1u8; 8];
            (*par).extradata = data.as_mut_ptr();
            (*par).extradata_size = data.len() as i32;
            assert!(AsyncDecoder::eligible(fmt, ctx, par));
            (*par).video_delay = 1;
            assert!(!AsyncDecoder::eligible(fmt, ctx, par));
            (*par).video_delay = 0;
            (*ctx).has_b_frames = 1;
            assert!(!AsyncDecoder::eligible(fmt, ctx, par));
            (*ctx).has_b_frames = 0;
            *(*par).extradata = 0;
            assert!(!AsyncDecoder::eligible(fmt, ctx, par));
            *(*par).extradata = 1;
            (*fmt).iformat = ffi::av_find_input_format(c"matroska".as_ptr());
            assert!(!AsyncDecoder::eligible(fmt, ctx, par));
            (*par).extradata = ptr::null_mut();
            ffi::avcodec_parameters_free(&mut par);
            ffi::avcodec_free_context(&mut ctx);
            ffi::avformat_free_context(fmt);
        }
    }
}
