#include <libavformat/avformat.h>
#include <libavcodec/avcodec.h>

/* Compile field access against the pinned headers when bindgen makes the
 * format context opaque. Never duplicate FFmpeg struct offsets in Rust. */
AVStream *osc_format_stream(AVFormatContext *context, unsigned index) {
    return context->streams[index];
}

int osc_format_open_io(AVFormatContext *context, const char *path) {
    return avio_open(&context->pb, path, AVIO_FLAG_WRITE);
}

int osc_format_close_io(AVFormatContext *context) {
    return avio_closep(&context->pb);
}

/* Codec callbacks and private layout stay on the C side of the SDK boundary. */
void osc_codec_configure_video(AVCodecContext *context, int width, int height,
                               int fps, int pixel_format, int64_t bitrate) {
    context->width = width;
    context->height = height;
    context->time_base = (AVRational){1, fps};
    context->framerate = (AVRational){fps, 1};
    context->pix_fmt = pixel_format;
    context->bit_rate = bitrate;
    context->color_range = AVCOL_RANGE_MPEG;
    context->colorspace = AVCOL_SPC_BT709;
    context->color_primaries = AVCOL_PRI_BT709;
    context->color_trc = AVCOL_TRC_BT709;
    context->gop_size = fps > 1 ? fps / 2 : 1;
    context->max_b_frames = 0;
    context->flags |= AV_CODEC_FLAG_GLOBAL_HEADER;
}

void *osc_codec_private_data(AVCodecContext *context) {
    return context->priv_data;
}

int osc_codec_ref_hardware_frames(AVCodecContext *context, AVBufferRef *frames) {
    context->hw_frames_ctx = av_buffer_ref(frames);
    return context->hw_frames_ctx != NULL;
}

void osc_codec_configure_audio(AVCodecContext *context, int rate, int channels,
                               int64_t bitrate) {
    context->sample_rate = rate;
    context->sample_fmt = AV_SAMPLE_FMT_FLTP;
    context->bit_rate = bitrate;
    context->time_base = (AVRational){1, rate};
    av_channel_layout_default(&context->ch_layout, channels);
    context->flags |= AV_CODEC_FLAG_GLOBAL_HEADER;
}

int osc_codec_frame_size(const AVCodecContext *context) {
    return context->frame_size;
}

AVRational osc_codec_time_base(const AVCodecContext *context) {
    return context->time_base;
}
