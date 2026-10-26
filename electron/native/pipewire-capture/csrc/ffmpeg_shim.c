#include <libavformat/avformat.h>

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
