/* Offline tests for the actual callback/PCM boundary, without libpipewire. */
#include "pw_audio.c"
#include <assert.h>

struct osc_pw_audio_api osc_audio_api;
static uint32_t stream_node = 42;
static int samples_received, errors_received, buffers_queued, buffer_pending;
static const char *last_error;
static const char *state_name(enum pw_stream_state value)
{
    return value == PW_STREAM_STATE_ERROR ? "error" : "streaming";
}
static float pcm[4] = { 0.1f, 0.2f, 0.3f, 0.4f };
static struct spa_chunk chunk = { .size = sizeof(pcm) };
static struct spa_data buffer_data = { .data = pcm, .maxsize = sizeof(pcm), .chunk = &chunk };
static struct spa_buffer spa_buffer = { .n_datas = 1, .datas = &buffer_data };
static struct pw_buffer buffer = { .buffer = &spa_buffer };

void osc_pw_set_error(char *err, size_t length, const char *format, ...)
{
    va_list args;
    va_start(args, format);
    vsnprintf(err, length, format, args);
    va_end(args);
}

const char *osc_pw_library_version(void) { return "1.0.5"; }
static uint32_t node_id(struct pw_stream *stream) { (void)stream; return stream_node; }
static struct pw_buffer *dequeue(struct pw_stream *stream)
{
    (void)stream;
    if (!buffer_pending) return NULL;
    buffer_pending = 0;
    return &buffer;
}
static int queue(struct pw_stream *stream, struct pw_buffer *value)
{
    (void)stream;
    assert(value == &buffer);
    ++buffers_queued;
    return 0;
}
static void samples(void *user, const float *data, uint32_t count, uint64_t cycle)
{
    (void)user;
    (void)cycle;
    assert(data == pcm);
    samples_received += count;
}
static void state(void *user, const char *name, const char *error)
{
    (void)user;
    if (error != NULL) {
        assert(strcmp(name, "error") == 0);
        last_error = error;
        ++errors_received;
    }
}
static int sync_core(void *object, uint32_t id, int seq)
{
    (void)object;
    assert(id == PW_ID_CORE);
    return seq + 1;
}
static const struct pw_core_methods core_methods = {
    PW_VERSION_CORE_METHODS,
    .sync = sync_core,
};
static struct spa_interface core = SPA_INTERFACE_INIT(
    PW_TYPE_INTERFACE_Core, PW_VERSION_CORE, &core_methods, NULL);

static struct osc_pw_audio fresh_audio(void)
{
    samples_received = errors_received = buffers_queued = buffer_pending = 0;
    stream_node = 42;
    last_error = NULL;
    osc_audio_api.stream_get_node_id = node_id;
    osc_audio_api.stream_dequeue_buffer = dequeue;
    osc_audio_api.stream_queue_buffer = queue;
    osc_audio_api.stream_state_as_string = state_name;
    return (struct osc_pw_audio) {
        .target_name = "mic-a", .target_node = PW_ID_ANY,
        .core = (struct pw_core *)&core, .peer_streaming = 1,
        .callbacks = { .on_samples = samples, .on_state = state },
    };
}

static void source(struct osc_pw_audio *audio, uint32_t id)
{
    struct spa_dict_item items[] = { SPA_DICT_ITEM_INIT(PW_KEY_NODE_NAME, "mic-a") };
    struct spa_dict props = SPA_DICT_INIT_ARRAY(items);
    osc_audio_peer_global(audio, id, 0, PW_TYPE_INTERFACE_Node, 0, &props);
}

static void link_peer(struct osc_pw_audio *audio, uint32_t id, const char *output)
{
    struct spa_dict_item items[] = {
        SPA_DICT_ITEM_INIT(PW_KEY_LINK_INPUT_NODE, "42"),
        SPA_DICT_ITEM_INIT(PW_KEY_LINK_OUTPUT_NODE, output),
    };
    struct spa_dict props = SPA_DICT_INIT_ARRAY(items);
    osc_audio_peer_global(audio, id, 0, PW_TYPE_INTERFACE_Link, 0, &props);
}

static void deliver(struct osc_pw_audio *audio)
{
    buffer_pending = 1;
    osc_audio_on_process(audio);
}

static void valid_peer_waits_for_barrier_and_discards_earlier_pcm(void)
{
    struct osc_pw_audio audio = fresh_audio();
    deliver(&audio);
    source(&audio, 7);
    link_peer(&audio, 100, "7");
    int stale = audio.peer_sync_seq;
    link_peer(&audio, 101, "7");
    osc_audio_peer_done(&audio, PW_ID_CORE, stale);
    deliver(&audio);
    assert(samples_received == 0);
    buffer_pending = 1;
    osc_audio_peer_done(&audio, PW_ID_CORE, audio.peer_sync_seq);
    assert(samples_received == 0 && buffers_queued == 3);
    deliver(&audio);
    assert(samples_received == 4 && errors_received == 0);
    osc_audio_peer_remove(&audio, 100);
    deliver(&audio);
    assert(samples_received == 4);
    osc_audio_peer_done(&audio, PW_ID_CORE, audio.peer_sync_seq);
    deliver(&audio);
    assert(samples_received == 8);
    osc_audio_peer_remove(&audio, 101);
    osc_audio_peer_done(&audio, PW_ID_CORE, audio.peer_sync_seq);
    deliver(&audio);
    assert(samples_received == 8);
}

static void missing_or_wrong_peer_never_forwards_pcm(void)
{
    struct osc_pw_audio audio = fresh_audio();
    link_peer(&audio, 100, "8");
    assert(errors_received == 1 && last_error != NULL);
    source(&audio, 7);
    link_peer(&audio, 101, "7");
    osc_audio_peer_done(&audio, PW_ID_CORE, audio.peer_sync_seq);
    deliver(&audio);
    assert(samples_received == 0 && errors_received == 1);
    audio = fresh_audio();
    source(&audio, 7);
    link_peer(&audio, 100, "7");
    link_peer(&audio, 101, "8");
    osc_audio_peer_done(&audio, PW_ID_CORE, audio.peer_sync_seq);
    deliver(&audio);
    assert(samples_received == 0 && errors_received == 1);
    audio = fresh_audio();
    source(&audio, 7);
    link_peer(&audio, 100, "7");
    osc_audio_peer_done(&audio, PW_ID_CORE, audio.peer_sync_seq);
    audio.peer_registry = (struct pw_registry *)&core;
    osc_audio_on_state_changed(&audio, PW_STREAM_STATE_STREAMING, PW_STREAM_STATE_ERROR,
                                "capture failed");
    osc_audio_on_state_changed(&audio, PW_STREAM_STATE_ERROR, PW_STREAM_STATE_STREAMING, NULL);
    osc_audio_peer_done(&audio, PW_ID_CORE, audio.peer_sync_seq);
    deliver(&audio);
    assert(samples_received == 0 && errors_received == 1);
}

static void source_removal_and_identity_reuse_are_terminal(void)
{
    struct osc_pw_audio audio = fresh_audio();
    source(&audio, 7);
    link_peer(&audio, 100, "7");
    osc_audio_peer_done(&audio, PW_ID_CORE, audio.peer_sync_seq);
    deliver(&audio);
    osc_audio_peer_remove(&audio, 7);
    source(&audio, 7);
    link_peer(&audio, 101, "7");
    osc_audio_peer_done(&audio, PW_ID_CORE, audio.peer_sync_seq);
    deliver(&audio);
    assert(samples_received == 4 && errors_received == 1);
    audio = fresh_audio();
    source(&audio, 7);
    source(&audio, 8);
    deliver(&audio);
    assert(samples_received == 0 && errors_received == 1);
}

static void malformed_links_and_overflow_fail_closed(void)
{
    struct osc_pw_audio audio = fresh_audio();
    source(&audio, 7);
    link_peer(&audio, 100, "invalid");
    deliver(&audio);
    assert(samples_received == 0 && errors_received == 1);
    audio = fresh_audio();
    source(&audio, 7);
    for (uint32_t id = 100; id <= 100 + OSC_AUDIO_MAX_LINKS; ++id) link_peer(&audio, id, "7");
    osc_audio_peer_done(&audio, PW_ID_CORE, audio.peer_sync_seq);
    deliver(&audio);
    assert(samples_received == 0 && errors_received == 1);
}

static void core_failure_and_unknown_stream_do_not_admit_audio(void)
{
    struct osc_pw_audio audio = fresh_audio();
    source(&audio, 7);
    link_peer(&audio, 100, "7");
    osc_audio_peer_core_error(&audio, 0, 0, -1, "connection lost");
    osc_audio_peer_done(&audio, PW_ID_CORE, audio.peer_sync_seq);
    deliver(&audio);
    assert(samples_received == 0 && errors_received == 1);
    audio = fresh_audio();
    stream_node = PW_ID_ANY;
    osc_audio_watch_peers(&audio);
    deliver(&audio);
    assert(samples_received == 0 && errors_received == 1);
}

static void default_capture_is_not_gated(void)
{
    struct osc_pw_audio audio = fresh_audio();
    audio.target_name = NULL;
    deliver(&audio);
    assert(samples_received == 4 && errors_received == 0);
}

static void source_enumeration_includes_virtual_microphones_only(void)
{
    char output[1024] = { 0 };
    struct osc_pw_enum enumeration = { .out = output, .out_len = sizeof(output) };
    const char *classes[] = {
        "Audio/Source", "Audio/Source/Virtual", "Audio/Sink", "Audio/Sink/Virtual",
        "Stream/Input/Audio", "Stream/Output/Audio", "Audio/Source/Unknown", "Video/Source",
    };
    for (size_t index = 0; index < sizeof(classes) / sizeof(classes[0]); ++index) {
        struct spa_dict_item items[] = {
            SPA_DICT_ITEM_INIT(PW_KEY_MEDIA_CLASS, classes[index]),
            SPA_DICT_ITEM_INIT(PW_KEY_NODE_NAME, index == 1 ? "easyeffects_source" : "device"),
            SPA_DICT_ITEM_INIT(PW_KEY_NODE_DESCRIPTION, index == 1 ? "Easy Effects Source" : "Device"),
        };
        struct spa_dict props = SPA_DICT_INIT_ARRAY(items);
        osc_enum_on_global(&enumeration, (uint32_t)index, 0, PW_TYPE_INTERFACE_Node, 0, &props);
    }
    assert(strcmp(output,
                  "device\037Device\036easyeffects_source\037Easy Effects Source\036") == 0);
}

int main(void)
{
    valid_peer_waits_for_barrier_and_discards_earlier_pcm();
    missing_or_wrong_peer_never_forwards_pcm();
    source_removal_and_identity_reuse_are_terminal();
    malformed_links_and_overflow_fail_closed();
    core_failure_and_unknown_stream_do_not_admit_audio();
    default_capture_is_not_gated();
    source_enumeration_includes_virtual_microphones_only();
    puts("audio peer admission: seven offline scenarios passed");
}
