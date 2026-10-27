/*
 * PipeWire audio capture: the system mix and the microphone.
 *
 * WHY THIS IS A SEPARATE CONNECTION FROM THE VIDEO.
 *
 * The screen arrives over the fd the portal handed us from OpenPipeWireRemote.
 * That remote is deliberately restricted: it exposes the one screencast node the
 * user approved and nothing else. There is no audio on it, and there is no
 * portal that grants audio the way ScreenCast grants pixels — the ScreenCast
 * interface has no audio option at all.
 *
 * So audio comes from the session's own PipeWire daemon, over the ordinary
 * socket, with pw_context_connect rather than pw_context_connect_fd. That works
 * for a .deb/AppImage build, which runs unsandboxed. Inside a Flatpak it would
 * need the `--socket=pipewire` permission; there is no way to ask for it at
 * runtime, so a sandboxed build simply gets no audio and says so rather than
 * recording silence.
 *
 * SYSTEM AUDIO IS A SINK MONITOR. `PW_KEY_STREAM_CAPTURE_SINK=true` turns a
 * capture stream into one that links to a SINK's monitor ports instead of a
 * source — that is, to what is being played rather than to a microphone. It is
 * the same mechanism `pw-record --target` uses and what OBS's audio capture
 * does; without it the stream links to the default source and records the
 * microphone twice.
 */

#include "pw_shim.h"

#include "pw_internal.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <spa/param/audio/format-utils.h>
#include <spa/pod/builder.h>
#include <spa/utils/result.h>
#include <spa/utils/string.h>

#define OSC_AUDIO_MAX_LINKS 64

struct osc_pw_audio {
    struct pw_thread_loop *loop;
    struct pw_context *context;
    struct pw_core *core;
    struct pw_stream *stream;
    struct spa_hook stream_listener;
    struct osc_pw_audio_callbacks callbacks;
    uint32_t channels;
    int has_buffer_time;
    char *target_name;
    uint32_t target_node;
    struct pw_registry *peer_registry;
    struct spa_hook peer_registry_listener;
    struct spa_hook peer_core_listener;
    uint32_t peer_links[OSC_AUDIO_MAX_LINKS];
    size_t peer_link_count;
    int peer_sync_seq;
    int peer_streaming;
    int peer_allowed;
    int peer_failed;
};

static void osc_audio_on_process(void *userdata);

static void osc_audio_peer_fail(struct osc_pw_audio *audio, const char *message)
{
    audio->peer_allowed = 0;
    if (audio->peer_failed) {
        return;
    }
    audio->peer_failed = 1;
    if (audio->callbacks.on_state != NULL) {
        audio->callbacks.on_state(audio->callbacks.user, "error", message);
    }
}

static void osc_audio_peer_sync(struct osc_pw_audio *audio)
{
    audio->peer_allowed = 0;
    if (audio->peer_failed) {
        return;
    }
    audio->peer_sync_seq = pw_core_sync(audio->core, PW_ID_CORE, audio->peer_sync_seq);
    if (audio->peer_sync_seq < 0) {
        osc_audio_peer_fail(audio, "could not verify the selected audio source");
    }
}

static void osc_audio_peer_done(void *data, uint32_t id, int seq)
{
    struct osc_pw_audio *audio = data;
    if (id != PW_ID_CORE || seq != audio->peer_sync_seq || audio->peer_failed) {
        return;
    }
    /* The core barrier covers the registry's preceding peer events. Discard
     * queued PCM while admission is closed: it predates that verification. */
    audio->peer_allowed = 0;
    osc_audio_on_process(audio);
    audio->peer_allowed = audio->peer_streaming && audio->target_node != PW_ID_ANY &&
        audio->peer_link_count > 0;
}

static void osc_audio_peer_core_error(void *data, uint32_t id, int seq, int result,
                                      const char *message)
{
    (void)id;
    (void)seq;
    if (result < 0) {
        osc_audio_peer_fail(data, message != NULL ? message : "audio peer verification failed");
    }
}

static const struct pw_core_events osc_audio_peer_core_events = {
    PW_VERSION_CORE_EVENTS,
    .done = osc_audio_peer_done,
    .error = osc_audio_peer_core_error,
};

static void osc_audio_peer_global(void *data, uint32_t id, uint32_t permissions,
                                   const char *type, uint32_t version,
                                   const struct spa_dict *props)
{
    struct osc_pw_audio *audio = data;
    (void)permissions;
    (void)version;
    if (audio->peer_failed || props == NULL || type == NULL) {
        return;
    }
    if (strcmp(type, PW_TYPE_INTERFACE_Node) == 0) {
        const char *name = spa_dict_lookup(props, PW_KEY_NODE_NAME);
        if (name != NULL && strcmp(name, audio->target_name) == 0) {
            if (audio->target_node != PW_ID_ANY && audio->target_node != id) {
                osc_audio_peer_fail(audio, "the selected audio source name is ambiguous");
                return;
            }
            audio->target_node = id;
        }
        return;
    }
    if (strcmp(type, PW_TYPE_INTERFACE_Link) != 0) {
        return;
    }
    uint32_t input, output;
    const char *input_text = spa_dict_lookup(props, PW_KEY_LINK_INPUT_NODE);
    const char *output_text = spa_dict_lookup(props, PW_KEY_LINK_OUTPUT_NODE);
    if (input_text == NULL || !spa_atou32(input_text, &input, 10) ||
        input != osc_audio_api.stream_get_node_id(audio->stream)) {
        return;
    }
    if (output_text == NULL || !spa_atou32(output_text, &output, 10) ||
        audio->target_node == PW_ID_ANY || output != audio->target_node) {
        osc_audio_peer_fail(audio, "PipeWire linked a different audio source than the selected input");
        return;
    }
    for (size_t i = 0; i < audio->peer_link_count; ++i) {
        if (audio->peer_links[i] == id) {
            return;
        }
    }
    if (audio->peer_link_count == OSC_AUDIO_MAX_LINKS) {
        osc_audio_peer_fail(audio, "the selected audio source exceeded the link limit");
        return;
    }
    audio->peer_links[audio->peer_link_count++] = id;
    osc_audio_peer_sync(audio);
}

static void osc_audio_peer_remove(void *data, uint32_t id)
{
    struct osc_pw_audio *audio = data;
    if (id == audio->target_node) {
        osc_audio_peer_fail(audio, "the selected audio source disappeared");
        return;
    }
    for (size_t i = 0; i < audio->peer_link_count; ++i) {
        if (audio->peer_links[i] == id) {
            audio->peer_links[i] = audio->peer_links[--audio->peer_link_count];
            osc_audio_peer_sync(audio);
            return;
        }
    }
}

static const struct pw_registry_events osc_audio_peer_registry_events = {
    PW_VERSION_REGISTRY_EVENTS,
    .global = osc_audio_peer_global,
    .global_remove = osc_audio_peer_remove,
};

static void osc_audio_watch_peers(struct osc_pw_audio *audio)
{
    if (audio->peer_failed || audio->peer_registry != NULL) {
        return;
    }
    if (osc_audio_api.stream_get_node_id(audio->stream) == PW_ID_ANY) {
        if (audio->peer_streaming) {
            osc_audio_peer_fail(audio, "the audio stream has no verifiable node identity");
        }
        return;
    }
    /* Start after our stream has a bound node ID. The registry's initial dump
     * includes any links created before this listener was installed. */
    audio->peer_registry = pw_core_get_registry(audio->core, PW_VERSION_REGISTRY, 0);
    if (audio->peer_registry == NULL) {
        osc_audio_peer_fail(audio, "could not observe the selected audio source");
        return;
    }
    pw_core_add_listener(audio->core, &audio->peer_core_listener,
                         &osc_audio_peer_core_events, audio);
    pw_registry_add_listener(audio->peer_registry, &audio->peer_registry_listener,
                             &osc_audio_peer_registry_events, audio);
}

static void osc_audio_on_state_changed(void *userdata, enum pw_stream_state old,
                                       enum pw_stream_state state, const char *error)
{
    struct osc_pw_audio *audio = userdata;

    (void)old;
    if (audio->target_name != NULL) {
        audio->peer_streaming = state == PW_STREAM_STATE_STREAMING;
        audio->peer_allowed = 0;
        if (state == PW_STREAM_STATE_ERROR || state == PW_STREAM_STATE_UNCONNECTED) {
            audio->peer_failed = 1;
        }
        if (state == PW_STREAM_STATE_PAUSED || state == PW_STREAM_STATE_STREAMING) {
            osc_audio_watch_peers(audio);
            if (audio->peer_registry != NULL) {
                osc_audio_peer_sync(audio);
            }
        }
    }
    if (audio->callbacks.on_state != NULL) {
        audio->callbacks.on_state(audio->callbacks.user,
                                  osc_audio_api.stream_state_as_string(state), error);
    }
}

static void osc_audio_on_param_changed(void *userdata, uint32_t id, const struct spa_pod *param)
{
    struct osc_pw_audio *audio = userdata;
    struct spa_audio_info_raw info;

    if (param == NULL || id != SPA_PARAM_Format) {
        return;
    }
    memset(&info, 0, sizeof(info));
    if (spa_format_audio_raw_parse(param, &info) < 0) {
        return;
    }
    /*
     * Recorded so osc_audio_on_process knows how many floats make one frame.
     * The stream adapter honours what we asked for, but reading back what was
     * actually negotiated is what keeps a mono device from being interpreted as
     * interleaved stereo and played back at double speed.
     */
    audio->channels = info.channels;
}

static void osc_audio_on_process(void *userdata)
{
    struct osc_pw_audio *audio = userdata;
    struct pw_buffer *b;

    while ((b = osc_audio_api.stream_dequeue_buffer(audio->stream)) != NULL) {
        struct spa_data *data = b->buffer->datas;

        if ((audio->target_name == NULL || audio->peer_allowed) &&
            b->buffer->n_datas > 0 && data != NULL && data->data != NULL && data->chunk != NULL &&
            audio->callbacks.on_samples != NULL) {
            uint32_t offset;
            uint32_t size;

            /* Same untrusted-producer clamping as the video path: `chunk` lives
             * in memory another process writes. */
            offset = SPA_MIN(data->chunk->offset, data->maxsize);
            size = SPA_MIN(data->chunk->size, data->maxsize - offset);
            if (size >= sizeof(float)) {
                const float *samples = SPA_PTROFF(data->data, offset, const float);

                audio->callbacks.on_samples(audio->callbacks.user, samples,
                                            size / (uint32_t)sizeof(float),
                                            audio->has_buffer_time ? b->time : 0);
            }
        }
        osc_audio_api.stream_queue_buffer(audio->stream, b);
    }
}

static const struct pw_stream_events osc_audio_stream_events = {
    PW_VERSION_STREAM_EVENTS,
    .state_changed = osc_audio_on_state_changed,
    .param_changed = osc_audio_on_param_changed,
    .process = osc_audio_on_process,
};

struct osc_pw_audio *osc_pw_audio_start(const char *target_object, int capture_sink,
                                        uint32_t rate, uint32_t channels,
                                        const struct osc_pw_audio_callbacks *callbacks, char *err,
                                        size_t err_len)
{
    struct osc_pw_audio *audio;
    struct pw_properties *props;
    uint8_t storage[1024];
    struct spa_pod_builder builder = SPA_POD_BUILDER_INIT(storage, sizeof(storage));
    const struct spa_pod *params[1];
    struct spa_audio_info_raw info;
    int result;

    if (osc_audio_api.stream_new == NULL) {
        osc_pw_set_error(err, err_len, "osc_pw_audio_start called before osc_pw_load");
        return NULL;
    }

    audio = calloc(1, sizeof(*audio));
    if (audio == NULL) {
        osc_pw_set_error(err, err_len, "out of memory");
        return NULL;
    }
    audio->callbacks = *callbacks;
    audio->channels = channels;
    audio->target_node = PW_ID_ANY;
    /* pw_buffer grew in 1.0.5. Never read the trailing field from an older
     * library's shorter allocation (Ubuntu 22.04 ships an older runtime). */
    {
        unsigned int major = 0, minor = 0, micro = 0;
        const char *version = osc_pw_library_version();
        if (version != NULL && sscanf(version, "%u.%u.%u", &major, &minor, &micro) == 3) {
            audio->has_buffer_time = major > 1 ||
                (major == 1 && (minor > 0 || micro >= 5));
        }
    }

    audio->loop = osc_audio_api.thread_loop_new("openscreen-audio", NULL);
    if (audio->loop == NULL) {
        osc_pw_set_error(err, err_len, "pw_thread_loop_new failed");
        free(audio);
        return NULL;
    }

    osc_audio_api.thread_loop_lock(audio->loop);

    audio->context =
        osc_audio_api.context_new(osc_audio_api.thread_loop_get_loop(audio->loop), NULL, 0);
    if (audio->context == NULL) {
        osc_pw_set_error(err, err_len, "pw_context_new failed");
        goto fail;
    }

    /* The session's own daemon, not the portal's restricted remote. */
    audio->core = osc_audio_api.context_connect(audio->context, NULL, 0);
    if (audio->core == NULL) {
        osc_pw_set_error(err, err_len,
                         "pw_context_connect failed: no PipeWire session is reachable "
                         "(in a sandbox this needs the pipewire socket permission)");
        goto fail;
    }

    if (target_object != NULL && target_object[0] != '\0') {
        audio->target_name = strdup(target_object);
        if (audio->target_name == NULL) {
            osc_pw_set_error(err, err_len, "out of memory");
            goto fail;
        }
    }
    props = osc_audio_api.properties_new(PW_KEY_MEDIA_TYPE, "Audio", PW_KEY_MEDIA_CATEGORY,
                                         "Capture", PW_KEY_MEDIA_ROLE, "Production", NULL);
    if (props == NULL) {
        osc_pw_set_error(err, err_len, "pw_properties_new failed");
        goto fail;
    }
    if (capture_sink) {
        /* Link to a SINK's monitor ports — what is being played — rather than
         * to a source. Without this the stream records the microphone. */
        osc_audio_api.properties_set(props, PW_KEY_STREAM_CAPTURE_SINK, "true");
    }
    if (target_object != NULL && target_object[0] != '\0') {
        osc_audio_api.properties_set(props, PW_KEY_TARGET_OBJECT, target_object);
        /* Ubuntu 22.04's WirePlumber 0.4.8 reads node.target rather than
         * target.object. Both accept the resolved PipeWire node name. */
        osc_audio_api.properties_set(props, "node.target", target_object);
        /* An explicitly selected microphone must never become another device
         * when its target disappears or cannot be linked. Default capture has
         * no target and intentionally keeps the session manager's policy. */
        osc_audio_api.properties_set(props, "node.dont-fallback", "true");
        osc_audio_api.properties_set(props, PW_KEY_NODE_DONT_RECONNECT, "true");
    }

    audio->stream = osc_audio_api.stream_new(audio->core, "openscreen-audio", props);
    if (audio->stream == NULL) {
        osc_pw_set_error(err, err_len, "pw_stream_new failed");
        goto fail;
    }

    osc_audio_api.stream_add_listener(audio->stream, &audio->stream_listener,
                                      &osc_audio_stream_events, audio);

    /*
     * A single fixed format, not a choice. pw_stream inserts an adapter node
     * that resamples and remixes whatever the device runs at, so asking for
     * exactly what the AAC encoder wants costs nothing and removes every
     * conversion from this process.
     */
    memset(&info, 0, sizeof(info));
    info.format = SPA_AUDIO_FORMAT_F32;
    info.rate = rate;
    info.channels = channels;
    params[0] = spa_format_audio_raw_build(&builder, SPA_PARAM_EnumFormat, &info);
    if (params[0] == NULL) {
        osc_pw_set_error(err, err_len, "the audio EnumFormat POD did not fit its builder");
        goto fail;
    }

    /* No PW_STREAM_FLAG_RT_PROCESS: osc_audio_on_process takes a mutex on the
     * Rust side, which is not allowed on PipeWire's realtime thread. */
    result = osc_audio_api.stream_connect(audio->stream, PW_DIRECTION_INPUT, PW_ID_ANY,
                                          PW_STREAM_FLAG_AUTOCONNECT |
                                              PW_STREAM_FLAG_MAP_BUFFERS,
                                          params, 1);
    if (result < 0) {
        osc_pw_set_error(err, err_len, "pw_stream_connect failed: %s", spa_strerror(result));
        goto fail;
    }

    osc_audio_api.thread_loop_unlock(audio->loop);

    if (osc_audio_api.thread_loop_start(audio->loop) < 0) {
        osc_pw_set_error(err, err_len, "pw_thread_loop_start failed");
        osc_audio_api.thread_loop_lock(audio->loop);
        goto fail;
    }

    return audio;

fail:
    audio->peer_failed = 1;
    osc_audio_api.thread_loop_unlock(audio->loop);
    if (audio->stream != NULL) {
        osc_audio_api.stream_destroy(audio->stream);
    }
    if (audio->peer_registry != NULL) {
        osc_audio_api.proxy_destroy((struct pw_proxy *)audio->peer_registry);
    }
    if (audio->core != NULL) {
        osc_audio_api.core_disconnect(audio->core);
    }
    if (audio->context != NULL) {
        osc_audio_api.context_destroy(audio->context);
    }
    osc_audio_api.thread_loop_destroy(audio->loop);
    free(audio->target_name);
    free(audio);
    return NULL;
}

void osc_pw_audio_stop(struct osc_pw_audio *audio)
{
    if (audio == NULL) {
        return;
    }
    /* Stop the loop BEFORE destroying anything it might still be running a
     * callback against; this joins the thread. */
    osc_audio_api.thread_loop_stop(audio->loop);
    audio->peer_failed = 1;
    if (audio->stream != NULL) {
        osc_audio_api.stream_destroy(audio->stream);
    }
    if (audio->peer_registry != NULL) {
        osc_audio_api.proxy_destroy((struct pw_proxy *)audio->peer_registry);
    }
    if (audio->core != NULL) {
        osc_audio_api.core_disconnect(audio->core);
    }
    if (audio->context != NULL) {
        osc_audio_api.context_destroy(audio->context);
    }
    osc_audio_api.thread_loop_destroy(audio->loop);
    free(audio->target_name);
    free(audio);
}

/* ---------------------------------------------------------------------------
 * Enumeration of audio sources
 *
 * WHY THIS IS NEEDED AT ALL. The app's microphone picker lists Chromium's
 * `MediaDeviceInfo`, whose `deviceId` is an opaque hash and whose `label` is a
 * human string. Neither is a PipeWire `node.name`, and `PW_KEY_TARGET_OBJECT`
 * accepts only a node name (or a serial). With no target, pw_stream connects to
 * the session DEFAULT source — which is why a user who picked their built-in
 * microphone in the HUD got the empty headphone jack recorded instead.
 *
 * So the helper enumerates the graph itself and resolves the label against
 * `node.description`, which is exactly the string Chromium surfaces as the
 * device label on a PipeWire system.
 * ------------------------------------------------------------------------- */

struct osc_pw_enum {
    struct pw_main_loop *loop;
    struct pw_context *context;
    struct pw_core *core;
    struct pw_registry *registry;
    struct spa_hook registry_listener;
    struct spa_hook core_listener;
    int sync_seq;
    struct spa_source *timeout;
    int completed;
    int failed;
    char *error;
    size_t error_len;
    /* Caller's buffer, filled as "name\037description\036" records. */
    char *out;
    size_t out_len;
    size_t out_used;
};

static void osc_enum_append(struct osc_pw_enum *e, const char *name, const char *desc)
{
    size_t need;

    if (name == NULL || name[0] == '\0') {
        return;
    }
    if (desc == NULL) {
        desc = "";
    }
    /* +2 for the two separators, +1 for the trailing NUL the Rust side reads. */
    need = strlen(name) + strlen(desc) + 3;
    if (e->out_used + need > e->out_len) {
        return; /* Buffer full: report what fits rather than truncating a record. */
    }
    e->out_used += (size_t)snprintf(e->out + e->out_used, e->out_len - e->out_used,
                                    "%s\037%s\036", name, desc);
}

static void osc_enum_on_global(void *data, uint32_t id, uint32_t permissions, const char *type,
                               uint32_t version, const struct spa_dict *props)
{
    struct osc_pw_enum *e = data;
    const char *media_class;

    (void)id;
    (void)permissions;
    (void)version;
    if (props == NULL || type == NULL || strcmp(type, PW_TYPE_INTERFACE_Node) != 0) {
        return;
    }
    media_class = spa_dict_lookup(props, PW_KEY_MEDIA_CLASS);
    /* Virtual sources include processed microphones such as EasyEffects.
     * Sink monitors remain separate system-audio capture targets. */
    if (media_class == NULL ||
        (strcmp(media_class, "Audio/Source") != 0 &&
         strcmp(media_class, "Audio/Source/Virtual") != 0)) {
        return;
    }
    osc_enum_append(e, spa_dict_lookup(props, PW_KEY_NODE_NAME),
                    spa_dict_lookup(props, PW_KEY_NODE_DESCRIPTION));
}

static const struct pw_registry_events osc_enum_registry_events = {
    PW_VERSION_REGISTRY_EVENTS,
    .global = osc_enum_on_global,
};

static void osc_enum_on_core_done(void *data, uint32_t id, int seq)
{
    struct osc_pw_enum *e = data;

    /* The registry replays every existing global BEFORE answering our sync, so
     * a matching `done` means the initial dump is complete. Without this we
     * would have to guess at a timeout and would race a busy graph. */
    if (id == PW_ID_CORE && seq == e->sync_seq) {
        e->completed = 1;
        osc_audio_api.main_loop_quit(e->loop);
    }
}

static void osc_enum_on_timeout(void *data, uint64_t expirations)
{
    struct osc_pw_enum *e = data;
    (void)expirations;
    e->failed = 1;
    osc_pw_set_error(e->error, e->error_len, "PipeWire audio registry did not respond within one second");
    osc_audio_api.main_loop_quit(e->loop);
}

static void osc_enum_on_core_error(void *data, uint32_t id, int seq, int result,
                                   const char *message)
{
    struct osc_pw_enum *e = data;
    (void)seq;
    if (id != PW_ID_CORE || result >= 0) {
        return;
    }
    e->failed = 1;
    osc_pw_set_error(e->error, e->error_len, "PipeWire audio registry failed: %s",
                     message != NULL ? message : "connection lost");
    osc_audio_api.main_loop_quit(e->loop);
}

static const struct pw_core_events osc_enum_core_events = {
    PW_VERSION_CORE_EVENTS,
    .done = osc_enum_on_core_done,
    .error = osc_enum_on_core_error,
};

int osc_pw_list_audio_sources(char *out, size_t out_len, char *err, size_t err_len)
{
    struct osc_pw_enum e;
    int result = -1;

    if (osc_audio_api.main_loop_new == NULL) {
        osc_pw_set_error(err, err_len, "osc_pw_list_audio_sources called before osc_pw_load");
        return -1;
    }
    memset(&e, 0, sizeof(e));
    e.out = out;
    e.out_len = out_len;
    e.error = err;
    e.error_len = err_len;
    if (out_len > 0) {
        out[0] = '\0';
    }

    /* A plain main loop, not the thread loop the streams use: this call is
     * synchronous by design — it runs the loop until the registry dump is done
     * and then returns, so there is no thread to hand off to. */
    e.loop = osc_audio_api.main_loop_new(NULL);
    if (e.loop == NULL) {
        osc_pw_set_error(err, err_len, "pw_main_loop_new failed");
        return -1;
    }
    e.context = osc_audio_api.context_new(osc_audio_api.main_loop_get_loop(e.loop), NULL, 0);
    if (e.context == NULL) {
        osc_pw_set_error(err, err_len, "pw_context_new failed");
        goto out;
    }
    e.core = osc_audio_api.context_connect(e.context, NULL, 0);
    if (e.core == NULL) {
        osc_pw_set_error(err, err_len, "pw_context_connect failed: no PipeWire session reachable");
        goto out;
    }
    e.registry = pw_core_get_registry(e.core, PW_VERSION_REGISTRY, 0);
    if (e.registry == NULL) {
        osc_pw_set_error(err, err_len, "pw_core_get_registry failed");
        goto out;
    }

    pw_registry_add_listener(e.registry, &e.registry_listener, &osc_enum_registry_events, &e);
    pw_core_add_listener(e.core, &e.core_listener, &osc_enum_core_events, &e);
    e.sync_seq = pw_core_sync(e.core, PW_ID_CORE, 0);
    if (e.sync_seq < 0) {
        osc_pw_set_error(err, err_len, "PipeWire audio registry sync failed");
        goto out;
    }
    struct pw_loop *loop = osc_audio_api.main_loop_get_loop(e.loop);
    struct timespec deadline = { .tv_sec = 1 };
    e.timeout = pw_loop_add_timer(loop, osc_enum_on_timeout, &e);
    if (e.timeout == NULL || pw_loop_update_timer(loop, e.timeout, &deadline, NULL, false) < 0) {
        osc_pw_set_error(err, err_len, "could not arm the audio registry deadline");
        goto out;
    }

    if (osc_audio_api.main_loop_run(e.loop) < 0) {
        osc_pw_set_error(err, err_len, "PipeWire audio registry loop failed");
    } else if (e.completed && !e.failed) {
        result = 0;
    } else if (!e.failed) {
        osc_pw_set_error(err, err_len, "PipeWire audio registry closed before sync");
    }

out:
    if (e.timeout != NULL) {
        pw_loop_destroy_source(osc_audio_api.main_loop_get_loop(e.loop), e.timeout);
    }
    if (e.registry != NULL) {
        osc_audio_api.proxy_destroy((struct pw_proxy *)e.registry);
    }
    if (e.core != NULL) {
        osc_audio_api.core_disconnect(e.core);
    }
    if (e.context != NULL) {
        osc_audio_api.context_destroy(e.context);
    }
    osc_audio_api.main_loop_destroy(e.loop);
    return result;
}
