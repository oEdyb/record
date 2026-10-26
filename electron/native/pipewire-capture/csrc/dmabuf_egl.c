/* EGL DMA-BUF import, without link-time dependencies on the desktop stack. */
#include "dmabuf_egl.h"

#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES2/gl2.h>
#include <GLES2/gl2ext.h>
#include <dlfcn.h>
#include <fcntl.h>
#include <unistd.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* At most 256 MiB of reused staging memory (including 8K RGBA). Never allocate
 * from unchecked compositor dimensions, even when the driver accepts them. */
#define OSC_MAX_READBACK_BYTES (UINT64_C(256) * 1024 * 1024)
#define OSC_EGL_FUNCTIONS(X) \
    X(eglGetProcAddress) \
    X(eglInitialize) \
    X(eglTerminate) \
    X(eglQueryString) \
    X(eglGetError) \
    X(eglBindAPI) \
    X(eglChooseConfig) \
    X(eglCreateContext) \
    X(eglDestroyContext) \
    X(eglCreatePbufferSurface) \
    X(eglDestroySurface) \
    X(eglMakeCurrent) \
    X(eglReleaseThread)
#define OSC_GL_FUNCTIONS(X) \
    X(glGetString) \
    X(glGetIntegerv) \
    X(glGetError) \
    X(glGenTextures) \
    X(glDeleteTextures) \
    X(glBindTexture) \
    X(glTexParameteri) \
    X(glGenFramebuffers) \
    X(glDeleteFramebuffers) \
    X(glBindFramebuffer) \
    X(glFramebufferTexture2D) \
    X(glCheckFramebufferStatus) \
    X(glPixelStorei) \
    X(glReadPixels) \
    X(glCreateShader) \
    X(glShaderSource) \
    X(glCompileShader) \
    X(glGetShaderiv) \
    X(glDeleteShader) \
    X(glCreateProgram) \
    X(glAttachShader) \
    X(glBindAttribLocation) \
    X(glLinkProgram) \
    X(glGetProgramiv) \
    X(glDeleteProgram) \
    X(glUseProgram) \
    X(glTexImage2D) \
    X(glActiveTexture) \
    X(glViewport) \
    X(glVertexAttribPointer) \
    X(glEnableVertexAttribArray) \
    X(glDisableVertexAttribArray) \
    X(glDrawArrays)

struct wl_display;
struct gbm_device;
struct osc_format_modifiers {
    uint32_t fourcc;
    size_t count;
    uint64_t values[OSC_DMABUF_MAX_MODIFIERS];
};
struct osc_dmabuf_egl {
  void *egl_lib, *gl_lib, *wayland_lib;
  struct wl_display *wayland;
  struct wl_display *(*connect)(const char *name);
  void (*disconnect)(struct wl_display *display);
#define OSC_DECLARE(name) __typeof__(&name) name;
  OSC_EGL_FUNCTIONS(OSC_DECLARE)
  OSC_GL_FUNCTIONS(OSC_DECLARE)
#undef OSC_DECLARE
  PFNEGLGETPLATFORMDISPLAYEXTPROC get_platform_display;
  PFNEGLCREATEIMAGEKHRPROC create_image;
  PFNEGLDESTROYIMAGEKHRPROC destroy_image;
  PFNEGLQUERYDMABUFMODIFIERSEXTPROC query_modifiers;
  PFNEGLQUERYDMABUFFORMATSEXTPROC query_formats;
  struct osc_format_modifiers formats[4];
  PFNGLEGLIMAGETARGETTEXTURE2DOESPROC image_target;
  EGLDisplay display;
  EGLContext context;
  EGLSurface surface;
  int initialized, modifiers;
  GLint max_texture_size;
  GLuint external_program;
  uint8_t *pixels;
  size_t capacity;
};

static int has_extension(const char *list, const char *name) {
  const char *match;
  size_t length = strlen(name);
  if (list == NULL)
    return 0;
  while ((match = strstr(list, name)) != NULL) {
    if ((match == list || match[-1] == ' ') &&
        (match[length] == '\0' || match[length] == ' '))
      return 1;
    list = match + length;
  }
  return 0;
}

static int egl_failure(struct osc_dmabuf_egl *r, char *err, size_t len,
                       const char *step) {
  snprintf(err, len, "%s failed (EGL 0x%04x)", step, r->eglGetError());
  return -1;
}

static int release_context(struct osc_dmabuf_egl *r, char *err, size_t len) {
  if (!r->eglMakeCurrent(r->display, EGL_NO_SURFACE, EGL_NO_SURFACE,
                         EGL_NO_CONTEXT))
    return egl_failure(r, err, len, "eglMakeCurrent(release)");
  if (!r->eglReleaseThread())
    return egl_failure(r, err, len, "eglReleaseThread");
  return 0;
}

static int load_libraries(struct osc_dmabuf_egl *r, char *err, size_t len) {
  r->egl_lib = dlopen("libEGL.so.1", RTLD_NOW | RTLD_LOCAL);
  r->gl_lib = dlopen("libGLESv2.so.2", RTLD_NOW | RTLD_LOCAL);
  r->wayland_lib = dlopen("libwayland-client.so.0", RTLD_NOW | RTLD_LOCAL);
  if (!r->egl_lib || !r->gl_lib || !r->wayland_lib) {
    snprintf(err, len,
             "EGL readback requires libEGL.so.1, libGLESv2.so.2 and "
             "libwayland-client.so.0");
    return -1;
  }
#define OSC_LOAD(lib, field, symbol)                                           \
  do {                                                                         \
    *(void **)(&r->field) = dlsym(r->lib, symbol);                             \
    if (!r->field) {                                                           \
      snprintf(err, len, "EGL readback missing %s", symbol);                   \
      return -1;                                                               \
    }                                                                          \
  } while (0)
#define OSC_LOAD_EGL(name) OSC_LOAD(egl_lib, name, #name);
#define OSC_LOAD_GL(name) OSC_LOAD(gl_lib, name, #name);
  OSC_EGL_FUNCTIONS(OSC_LOAD_EGL)
  OSC_GL_FUNCTIONS(OSC_LOAD_GL)
  OSC_LOAD(wayland_lib, connect, "wl_display_connect");
  OSC_LOAD(wayland_lib, disconnect, "wl_display_disconnect");
#undef OSC_LOAD_GL
#undef OSC_LOAD_EGL
#undef OSC_LOAD
#define OSC_PROC(field, name) r->field = (void *)r->eglGetProcAddress(name)
  OSC_PROC(get_platform_display, "eglGetPlatformDisplayEXT");
  OSC_PROC(create_image, "eglCreateImageKHR");
  OSC_PROC(destroy_image, "eglDestroyImageKHR");
  OSC_PROC(query_modifiers, "eglQueryDmaBufModifiersEXT");
  OSC_PROC(query_formats, "eglQueryDmaBufFormatsEXT");
  OSC_PROC(image_target, "glEGLImageTargetTexture2DOES");
#undef OSC_PROC
  if (!r->get_platform_display || !r->create_image || !r->destroy_image ||
      !r->image_target) {
    snprintf(err, len, "EGL readback missing platform/image entry points");
    return -1;
  }
  return 0;
}

static int initialize_display(struct osc_dmabuf_egl *r, char *err, size_t len) {
  const char *extensions;
  r->wayland = r->connect(NULL);
  if (!r->wayland) {
    snprintf(err, len, "wl_display_connect failed for EGL DMA-BUF import");
    return -1;
  }
  r->display =
      r->get_platform_display(EGL_PLATFORM_WAYLAND_EXT, r->wayland, NULL);
  if (r->display == EGL_NO_DISPLAY)
    return egl_failure(r, err, len, "EGL Wayland display");
  if (!r->eglInitialize(r->display, NULL, NULL))
    return egl_failure(r, err, len, "eglInitialize(Wayland)");
  r->initialized = 1;
  extensions = r->eglQueryString(r->display, EGL_EXTENSIONS);
  if (!has_extension(extensions, "EGL_EXT_image_dma_buf_import") ||
      !has_extension(extensions, "EGL_KHR_image_base")) {
    snprintf(err, len, "Wayland EGL display lacks DMA-BUF image import");
    return -1;
  }
  r->modifiers =
      has_extension(extensions, "EGL_EXT_image_dma_buf_import_modifiers") &&
      r->query_modifiers && r->query_formats;
  return 0;
}

static GLuint compile_shader(struct osc_dmabuf_egl *r, GLenum type,
                             const char *source) {
  GLint compiled = 0;
  GLuint shader = r->glCreateShader(type);
  if (!shader)
    return 0;
  r->glShaderSource(shader, 1, &source, NULL);
  r->glCompileShader(shader);
  r->glGetShaderiv(shader, GL_COMPILE_STATUS, &compiled);
  if (compiled)
    return shader;
  r->glDeleteShader(shader);
  return 0;
}

/* NVIDIA's implicit DMA-BUF images can require an external texture even for
 * RGBA. Sample it into our own ordinary RGBA attachment before glReadPixels. */
static int initialize_external_program(struct osc_dmabuf_egl *r, char *err,
                                       size_t len) {
  static const char vertex[] =
      "attribute vec2 position; varying vec2 uv;"
      "void main(){uv=position*0.5+0.5;gl_Position=vec4(position,0.0,1.0);}";
  static const char fragment[] =
      "#extension GL_OES_EGL_image_external : require\n"
      "precision highp float; varying vec2 uv; uniform samplerExternalOES "
      "image;"
      "void main(){gl_FragColor=texture2D(image,uv);}";
  GLint linked = 0;
  GLuint vs = compile_shader(r, GL_VERTEX_SHADER, vertex);
  GLuint fs = compile_shader(r, GL_FRAGMENT_SHADER, fragment);
  if (vs && fs) {
    r->external_program = r->glCreateProgram();
    r->glAttachShader(r->external_program, vs);
    r->glAttachShader(r->external_program, fs);
    r->glBindAttribLocation(r->external_program, 0, "position");
    r->glLinkProgram(r->external_program);
    r->glGetProgramiv(r->external_program, GL_LINK_STATUS, &linked);
  }
  if (vs)
    r->glDeleteShader(vs);
  if (fs)
    r->glDeleteShader(fs);
  if (!linked || r->glGetError() != GL_NO_ERROR) {
    snprintf(err, len,
             "external DMA-BUF readback shader compilation/link failed");
    return -1;
  }
  return 0;
}

static int initialize_context(struct osc_dmabuf_egl *r, char *err, size_t len) {
  EGLConfig config;
  EGLint count = 0;
  int surfaceless = has_extension(r->eglQueryString(r->display, EGL_EXTENSIONS),
                                  "EGL_KHR_surfaceless_context");
  const EGLint config_attrs[] = {EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT,
                                 EGL_SURFACE_TYPE,
                                 surfaceless ? 0 : EGL_PBUFFER_BIT, EGL_NONE};
  const EGLint context_attrs[] = {EGL_CONTEXT_CLIENT_VERSION, 2, EGL_NONE};
  const EGLint surface_attrs[] = {EGL_WIDTH, 1, EGL_HEIGHT, 1, EGL_NONE};
  if (!r->eglBindAPI(EGL_OPENGL_ES_API))
    return egl_failure(r, err, len, "eglBindAPI");
  if (!r->eglChooseConfig(r->display, config_attrs, &config, 1, &count) ||
      count != 1)
    return egl_failure(r, err, len, "eglChooseConfig");
  r->context =
      r->eglCreateContext(r->display, config, EGL_NO_CONTEXT, context_attrs);
  if (r->context == EGL_NO_CONTEXT)
    return egl_failure(r, err, len, "eglCreateContext");
  if (!surfaceless) {
    r->surface = r->eglCreatePbufferSurface(r->display, config, surface_attrs);
    if (r->surface == EGL_NO_SURFACE)
      return egl_failure(r, err, len, "eglCreatePbufferSurface");
  }
  if (!r->eglMakeCurrent(r->display, r->surface, r->surface, r->context))
    return egl_failure(r, err, len, "eglMakeCurrent");
  if (!has_extension((const char *)r->glGetString(GL_EXTENSIONS),
                     "GL_OES_EGL_image")) {
    snprintf(err, len, "OpenGL ES lacks GL_OES_EGL_image");
    release_context(r, err, len);
    return -1;
  }
  r->glGetIntegerv(GL_MAX_TEXTURE_SIZE, &r->max_texture_size);
  if (r->glGetError() != GL_NO_ERROR || r->max_texture_size <= 0) {
    snprintf(err, len, "OpenGL ES texture size query failed");
    release_context(r, err, len);
    return -1;
  }
  if (has_extension((const char *)r->glGetString(GL_EXTENSIONS),
                    "GL_OES_EGL_image_external") &&
      initialize_external_program(r, err, len)) {
    release_context(r, err, len);
    return -1;
  }
  return release_context(r, err, len);
}

/* EGL's modifier query does not expose plane counts. Ask GBM on the DRM
 * render node belonging to THIS EGL display; never the machine's default GPU.
 * These three dynamically loaded GBM calls need no GBM build-time headers. */
static int initialize_modifiers(struct osc_dmabuf_egl *r, char *err, size_t len)
{
    PFNEGLQUERYDISPLAYATTRIBEXTPROC display_attrib =
        (void *)r->eglGetProcAddress("eglQueryDisplayAttribEXT");
    PFNEGLQUERYDEVICESTRINGEXTPROC device_string =
        (void *)r->eglGetProcAddress("eglQueryDeviceStringEXT");
    EGLAttrib device_value = 0;
    const uint32_t fourccs[] = { OSC_DRM_FOURCC('X','R','2','4'),
        OSC_DRM_FOURCC('X','B','2','4'), OSC_DRM_FOURCC('A','R','2','4'),
        OSC_DRM_FOURCC('A','B','2','4') };
    if (!r->modifiers || !display_attrib || !device_string ||
        !display_attrib(r->display, EGL_DEVICE_EXT, &device_value)) {
        snprintf(err, len, "EGL device/modifier queries unavailable");
        return -1;
    }
    const char *node = device_string((EGLDeviceEXT)device_value, EGL_DRM_RENDER_NODE_FILE_EXT);
    if (!node) { snprintf(err, len, "EGL display has no DRM render node"); return -1; }
    void *library = dlopen("libgbm.so.1", RTLD_NOW | RTLD_LOCAL);
    if (!library) { snprintf(err, len, "single-plane DMA-BUF negotiation requires libgbm.so.1"); return -1; }
    struct gbm_device *(*create_device)(int) = dlsym(library, "gbm_create_device");
    void (*destroy_device)(struct gbm_device *) = dlsym(library, "gbm_device_destroy");
    int (*plane_count)(struct gbm_device *, uint32_t, uint64_t) =
        dlsym(library, "gbm_device_get_format_modifier_plane_count");
    int fd = -1, result = -1;
    struct gbm_device *gbm = NULL;
    if (!create_device || !destroy_device || !plane_count) {
        snprintf(err, len, "GBM lacks modifier plane-count query");
        goto done;
    }
    fd = open(node, O_RDWR | O_CLOEXEC);
    if (fd >= 0) gbm = create_device(fd);
    if (!gbm) { snprintf(err, len, "GBM could not open EGL render node %s", node); goto done; }
    EGLint supported_formats[256], format_count = 0;
    if (!r->query_formats(r->display, 256, supported_formats, &format_count)) {
        egl_failure(r, err, len, "eglQueryDmaBufFormatsEXT");
        goto done;
    }
    for (size_t f = 0; f < 4; f++) {
        int supported = 0;
        for (EGLint i = 0; i < format_count && i < 256; i++) {
            if ((uint32_t)supported_formats[i] == fourccs[f]) supported = 1;
        }
        if (!supported) continue;
        EGLuint64KHR modifiers[OSC_DMABUF_MAX_MODIFIERS];
        EGLBoolean external[OSC_DMABUF_MAX_MODIFIERS];
        EGLint count = 0;
        struct osc_format_modifiers *format = &r->formats[f];
        format->fourcc = fourccs[f];
        if (!r->query_modifiers(r->display, (EGLint)format->fourcc,
                OSC_DMABUF_MAX_MODIFIERS, modifiers, external, &count)) {
            egl_failure(r, err, len, "eglQueryDmaBufModifiersEXT");
            goto done;
        }
        for (EGLint i = 0; i < count && i < OSC_DMABUF_MAX_MODIFIERS; i++) {
            if (modifiers[i] != OSC_DRM_FORMAT_MOD_INVALID &&
                (!external[i] || r->external_program) &&
                plane_count(gbm, format->fourcc, modifiers[i]) == 1) {
                format->values[format->count++] = modifiers[i];
            }
        }
    }
    result = 0;
done:
    if (gbm) destroy_device(gbm);
    if (fd >= 0) close(fd);
    dlclose(library);
    return result;
}

size_t osc_dmabuf_egl_modifiers(const struct osc_dmabuf_egl *r,
                                uint32_t fourcc, const uint64_t **modifiers)
{
    *modifiers = NULL;
    if (!r) return 0;
    for (size_t i = 0; i < 4; i++) {
        if (r->formats[i].fourcc == fourcc) {
            *modifiers = r->formats[i].values;
            return r->formats[i].count;
        }
    }
    return 0;
}

struct osc_dmabuf_egl *osc_dmabuf_egl_create(char *err, size_t len) {
  struct osc_dmabuf_egl *r = calloc(1, sizeof(*r));
  if (!r) {
    snprintf(err, len, "EGL reader allocation failed");
    return NULL;
  }
  if (load_libraries(r, err, len) || initialize_display(r, err, len) ||
      initialize_context(r, err, len) || initialize_modifiers(r, err, len)) {
    osc_dmabuf_egl_destroy(r);
    return NULL;
  }
  return r;
}

void osc_dmabuf_egl_destroy(struct osc_dmabuf_egl *r) {
  if (!r)
    return;
  /* No context is left current across API calls. The owner joins PipeWire
   * before destroying, so no GL object or import can still be in flight. */
  if (r->external_program) {
    char error[128];
    if (r->eglMakeCurrent(r->display, r->surface, r->surface, r->context)) {
      r->glDeleteProgram(r->external_program);
      if (release_context(r, error, sizeof(error)))
        fprintf(stderr, "%s\n", error);
    } else {
      egl_failure(r, error, sizeof(error), "eglMakeCurrent(teardown)");
      fprintf(stderr, "%s\n", error);
    }
  }
  if (r->context != EGL_NO_CONTEXT &&
      !r->eglDestroyContext(r->display, r->context))
    fprintf(stderr, "eglDestroyContext failed (EGL 0x%04x)\n",
            r->eglGetError());
  if (r->surface != EGL_NO_SURFACE &&
      !r->eglDestroySurface(r->display, r->surface))
    fprintf(stderr, "eglDestroySurface failed (EGL 0x%04x)\n",
            r->eglGetError());
  if (r->initialized && !r->eglTerminate(r->display))
    fprintf(stderr, "eglTerminate failed (EGL 0x%04x)\n", r->eglGetError());
  if (r->wayland)
    r->disconnect(r->wayland);
  if (r->wayland_lib)
    dlclose(r->wayland_lib);
  if (r->gl_lib)
    dlclose(r->gl_lib);
  if (r->egl_lib)
    dlclose(r->egl_lib);
  free(r->pixels);
  free(r);
}

static int modifier_supported(struct osc_dmabuf_egl *r, uint32_t fourcc,
                              uint64_t modifier) {
    const uint64_t *modifiers;
    if (modifier == OSC_DRM_FORMAT_MOD_INVALID) return 1;
    size_t count = osc_dmabuf_egl_modifiers(r, fourcc, &modifiers);
    for (size_t i = 0; i < count; i++) {
        if (modifiers[i] == modifier) return 1;
    }
  return 0;
}

static int validate_frame(struct osc_dmabuf_egl *r, int fd, uint32_t w,
                          uint32_t h, uint32_t fourcc, uint64_t offset,
                          int32_t stride, uint64_t modifier, char *err,
                          size_t len) {
  int rgb = fourcc == OSC_DRM_FOURCC('X', 'B', '2', '4') ||
            fourcc == OSC_DRM_FOURCC('X', 'R', '2', '4') ||
            fourcc == OSC_DRM_FOURCC('A', 'B', '2', '4') ||
            fourcc == OSC_DRM_FOURCC('A', 'R', '2', '4');
  if (!rgb || fd < 0 || !w || !h || w > (uint32_t)r->max_texture_size ||
      h > (uint32_t)r->max_texture_size || offset > INT_MAX || stride <= 0 ||
      (uint64_t)stride < (uint64_t)w * 4 ||
      (uint64_t)w * h * 4 > OSC_MAX_READBACK_BYTES) {
    snprintf(err, len, "invalid or oversized single-plane RGB DMA-BUF");
    return -1;
  }
  if (!modifier_supported(r, fourcc, modifier)) {
    snprintf(err, len, "DMA-BUF modifier is not supported for EGL texture import");
    return -1;
  }
  return 0;
}

static GLuint external_attachment(struct osc_dmabuf_egl *r, uint32_t w,
                                  uint32_t h) {
  GLuint texture = 0;
  r->glGenTextures(1, &texture);
  r->glBindTexture(GL_TEXTURE_2D, texture);
  r->glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
  r->glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
  r->glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, (GLsizei)w, (GLsizei)h, 0, GL_RGBA,
                  GL_UNSIGNED_BYTE, NULL);
  return texture;
}

static void draw_external(struct osc_dmabuf_egl *r, uint32_t w, uint32_t h) {
  static const GLfloat vertices[] = {-1, -1, 1, -1, -1, 1, 1, 1};
  r->glViewport(0, 0, (GLsizei)w, (GLsizei)h);
  r->glUseProgram(r->external_program);
  /* Sampler's initial uniform value is texture unit zero. */
  r->glVertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, 0, vertices);
  r->glEnableVertexAttribArray(0);
  r->glDrawArrays(GL_TRIANGLE_STRIP, 0, 4);
  r->glDisableVertexAttribArray(0);
  r->glUseProgram(0);
}

static int read_image(struct osc_dmabuf_egl *r, EGLImageKHR image, uint32_t w,
                      uint32_t h, char *err, size_t len) {
  GLuint texture = 0, attachment = 0, fbo = 0;
  GLenum target = r->external_program ? GL_TEXTURE_EXTERNAL_OES : GL_TEXTURE_2D;
  GLenum error, status;
  int result = -1;
  r->glActiveTexture(GL_TEXTURE0);
  r->glGenTextures(1, &texture);
  r->glBindTexture(target, texture);
  r->glTexParameteri(target, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
  r->glTexParameteri(target, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
  r->glTexParameteri(target, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
  r->glTexParameteri(target, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
  r->image_target(target, image);
  error = r->glGetError();
  if (error != GL_NO_ERROR) {
    snprintf(err, len, "glEGLImageTargetTexture2DOES failed (GL 0x%04x)",
             error);
    goto done;
  }
  if (r->external_program)
    attachment = external_attachment(r, w, h);
  r->glGenFramebuffers(1, &fbo);
  r->glBindFramebuffer(GL_FRAMEBUFFER, fbo);
  r->glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D,
                            r->external_program ? attachment : texture, 0);
  status = r->glCheckFramebufferStatus(GL_FRAMEBUFFER);
  error = r->glGetError();
  if (status != GL_FRAMEBUFFER_COMPLETE || error != GL_NO_ERROR) {
    snprintf(err, len,
             "DMA-BUF framebuffer incomplete (status 0x%04x, GL 0x%04x)",
             status, error);
    goto done;
  }
  if (r->external_program)
    draw_external(r, w, h);
  /* EGL imports expose buffer row zero at texture coordinate zero. Both
   * paths preserve that row order; no compositor/display transform applies. */
  r->glPixelStorei(GL_PACK_ALIGNMENT, 1);
  r->glReadPixels(0, 0, (GLsizei)w, (GLsizei)h, GL_RGBA, GL_UNSIGNED_BYTE,
                  r->pixels);
  error = r->glGetError();
  if (error != GL_NO_ERROR) {
    snprintf(err, len, "glReadPixels failed (GL 0x%04x)", error);
    goto done;
  }
  result = 0;
done:
  r->glBindFramebuffer(GL_FRAMEBUFFER, 0);
  r->glBindTexture(target, 0);
  r->glBindTexture(GL_TEXTURE_2D, 0);
  if (attachment)
    r->glDeleteTextures(1, &attachment);
  if (fbo)
    r->glDeleteFramebuffers(1, &fbo);
  if (texture)
    r->glDeleteTextures(1, &texture);
  error = r->glGetError();
  if (error != GL_NO_ERROR) {
    snprintf(err, len, "EGL readback cleanup failed (GL 0x%04x)", error);
    result = -1;
  }
  return result;
}

static EGLImageKHR create_dmabuf_image(struct osc_dmabuf_egl *r, int fd,
    uint32_t w, uint32_t h, uint32_t fourcc, uint64_t offset, int32_t stride,
    uint64_t modifier)
{
    EGLint attrs[17] = { EGL_WIDTH, (EGLint)w, EGL_HEIGHT, (EGLint)h,
        EGL_LINUX_DRM_FOURCC_EXT, (EGLint)fourcc, EGL_DMA_BUF_PLANE0_FD_EXT, fd,
        EGL_DMA_BUF_PLANE0_OFFSET_EXT, (EGLint)offset,
        EGL_DMA_BUF_PLANE0_PITCH_EXT, stride };
  if (modifier != OSC_DRM_FORMAT_MOD_INVALID) {
    attrs[12] = EGL_DMA_BUF_PLANE0_MODIFIER_LO_EXT;
    attrs[13] = (EGLint)(modifier & UINT32_MAX);
    attrs[14] = EGL_DMA_BUF_PLANE0_MODIFIER_HI_EXT;
    attrs[15] = (EGLint)(modifier >> 32);
    attrs[16] = EGL_NONE;
  } else {
    attrs[12] = EGL_NONE;
  }
    return r->create_image(r->display, EGL_NO_CONTEXT, EGL_LINUX_DMA_BUF_EXT, NULL, attrs);
}

int osc_dmabuf_egl_read(struct osc_dmabuf_egl *r, int fd, uint32_t w,
                        uint32_t h, uint32_t fourcc, uint64_t offset,
                        int32_t stride, uint64_t modifier, const uint8_t **rgba,
                        size_t *size, char *err, size_t len) {
  EGLImageKHR image;
  size_t bytes;
  int result;
  *rgba = NULL;
  *size = 0;
  if (!r) {
    snprintf(err, len, "EGL DMA-BUF reader unavailable");
    return -1;
  }
  if (validate_frame(r, fd, w, h, fourcc, offset, stride, modifier, err, len))
    return -1;
  bytes = (size_t)w * h * 4;
  if (r->capacity < bytes) {
    uint8_t *pixels = realloc(r->pixels, bytes);
    if (!pixels) {
      snprintf(err, len, "EGL readback allocation failed");
      return -1;
    }
    r->pixels = pixels;
    r->capacity = bytes;
  }
  if (!r->eglMakeCurrent(r->display, r->surface, r->surface, r->context))
    return egl_failure(r, err, len, "eglMakeCurrent(read)");
  image = create_dmabuf_image(r, fd, w, h, fourcc, offset, stride, modifier);
  if (image == EGL_NO_IMAGE_KHR) {
    egl_failure(r, err, len, "eglCreateImageKHR(DMA-BUF)");
    release_context(r, err, len);
    return -1;
  }
  result = read_image(r, image, w, h, err, len);
  if (!r->destroy_image(r->display, image))
    result = egl_failure(r, err, len, "eglDestroyImageKHR");
  if (release_context(r, err, len))
    return -1;
  if (result)
    return -1;
  *rgba = r->pixels;
  *size = bytes;
  return 0;
}

#ifdef OSC_DMABUF_EGL_TEST
/* Native GPU integration test; no portal or screen recording. From crate root:
 * cc -std=gnu11 -Wall -Wextra -Werror -DOSC_DMABUF_EGL_TEST csrc/dmabuf_egl.c \
 *    -ldl -lgbm -lpthread -o /tmp/osc-dmabuf-test
 * /tmp/osc-dmabuf-test /dev/dri/renderD128
 * GBM headers/runtime are test-only. The device must belong to the compositor's
 * GPU and support linear writable allocation. Distinct rows/channels catch
 * flips, swizzles, padding errors and incorrect external texture sampling. */
#include <assert.h>
#include <fcntl.h>
#include <gbm.h>
#include <pthread.h>
#include <unistd.h>

#ifdef OSC_PW_FRAME_TEST
/* Add -DOSC_PW_FRAME_TEST csrc/pw_shim.c -Ivendor/pipewire-1.0.5/include
 * to the native test command to cover zero-size PipeWire DMA-BUF admission. */
extern int osc_pw_test_modifier_pod(struct osc_dmabuf_egl *);
extern int osc_pw_test_dmabuf_admission(struct osc_dmabuf_egl *, int, uint32_t,
                                       int32_t, uint64_t);
#endif

struct test_frame {
  struct osc_dmabuf_egl *reader;
  uint32_t fourcc, stride;
  uint64_t modifier;
  int fd;
};

static void *test_readback(void *userdata) {
  struct test_frame *frame = userdata;
  char error[256];
  const uint8_t *pixels = NULL;
  size_t size = 0;
  for (int iteration = 0; iteration < 3; iteration++) {
    int result =
        osc_dmabuf_egl_read(frame->reader, frame->fd, 64, 64, frame->fourcc, 0,
                            (int32_t)frame->stride, frame->modifier, &pixels,
                            &size, error, sizeof(error));
    if (result)
      fprintf(stderr, "%s\n", error);
    assert(result == 0 && size == 64 * 64 * 4);
    for (int y = 0; y < 64; y++) {
      for (int x = 0; x < 64; x++) {
        const uint8_t expected[] = {10 + x, 20 + y, 30, 255};
        assert(memcmp(pixels + (y * 64 + x) * 4, expected, 4) == 0);
      }
    }
  }
  return NULL;
}

static void test_rejections(struct osc_dmabuf_egl *reader) {
  char error[256];
  const uint8_t *pixels;
  size_t size;
  const uint64_t invalid[][4] = {
      {0, 0, 256, OSC_DRM_FORMAT_MOD_INVALID},
      {64, UINT64_MAX, 256, OSC_DRM_FORMAT_MOD_INVALID},
      {64, 0, 4, OSC_DRM_FORMAT_MOD_INVALID},
      {64, 0, 256, UINT64_C(0x0300000000000001)}};
  for (size_t i = 0; i < sizeof(invalid) / sizeof(invalid[0]); i++) {
    assert(osc_dmabuf_egl_read(reader, 0, (uint32_t)invalid[i][0], 64,
                               GBM_FORMAT_ARGB8888, invalid[i][1],
                               (int32_t)invalid[i][2], invalid[i][3], &pixels,
                               &size, error, sizeof(error)) == -1);
    assert(pixels == NULL && size == 0);
  }
}

static void test_format(struct osc_dmabuf_egl *reader,
                        struct gbm_device *device, uint32_t fourcc) {
  struct gbm_bo *bo = gbm_bo_create(device, 64, 64, fourcc,
                                    GBM_BO_USE_LINEAR | GBM_BO_USE_WRITE);
  uint32_t stride;
  void *mapping;
  pthread_t worker;
  assert(bo != NULL);
  uint8_t *bytes =
      gbm_bo_map(bo, 0, 0, 64, 64, GBM_BO_TRANSFER_WRITE, &stride, &mapping);
  assert(bytes != NULL);
  int blue_first =
      fourcc == GBM_FORMAT_ARGB8888 || fourcc == GBM_FORMAT_XRGB8888;
  for (int y = 0; y < 64; y++) {
    for (int x = 0; x < 64; x++) {
      uint8_t pixel[] = {blue_first ? 30 : 10 + x, 20 + y,
                         blue_first ? 10 + x : 30, 255};
      memcpy(bytes + y * stride + x * 4, pixel, 4);
    }
  }
  gbm_bo_unmap(bo, mapping);
  struct test_frame frame = {reader, fourcc, gbm_bo_get_stride(bo),
                             OSC_DRM_FORMAT_MOD_INVALID, gbm_bo_get_fd(bo)};
  assert(frame.fd >= 0);
  for (int implicit = 0; implicit < 2; implicit++) {
    frame.modifier =
        implicit ? OSC_DRM_FORMAT_MOD_INVALID : OSC_DRM_FORMAT_MOD_LINEAR;
    assert(pthread_create(&worker, NULL, test_readback, &frame) == 0);
    assert(pthread_join(worker, NULL) == 0);
  }
#ifdef OSC_PW_FRAME_TEST
  assert(osc_pw_test_dmabuf_admission(reader, frame.fd, fourcc,
      (int32_t)frame.stride, frame.modifier) == 0);
#endif
  close(frame.fd);
  gbm_bo_destroy(bo);
}

/* Exercise the producer side too: allocate a queried explicit layout, bind it
 * as a render target, and verify our external-texture readback from that FD. */
static void test_rendered_modifier(struct osc_dmabuf_egl *r, struct gbm_device *device)
{
    const uint64_t *modifiers;
    const uint32_t fourcc = GBM_FORMAT_XRGB8888;
    size_t count = osc_dmabuf_egl_modifiers(r, fourcc, &modifiers);
    struct gbm_bo *bo = gbm_bo_create_with_modifiers2(device, 64, 64, fourcc,
        modifiers, (unsigned)count, GBM_BO_USE_RENDERING);
    assert(bo != NULL && gbm_bo_get_plane_count(bo) == 1);
    int fd = gbm_bo_get_fd(bo);
    uint64_t modifier = gbm_bo_get_modifier(bo);
    uint32_t stride = gbm_bo_get_stride(bo), offset = gbm_bo_get_offset(bo, 0);
    assert(fd >= 0 && modifier != OSC_DRM_FORMAT_MOD_INVALID);
    assert(r->eglMakeCurrent(r->display, r->surface, r->surface, r->context));
    EGLImageKHR image = create_dmabuf_image(r, fd, 64, 64, fourcc, offset, (int32_t)stride, modifier);
    assert(image != EGL_NO_IMAGE_KHR);
    GLuint texture, fbo;
    r->glGenTextures(1, &texture);
    r->glBindTexture(GL_TEXTURE_2D, texture);
    r->image_target(GL_TEXTURE_2D, image);
    r->glGenFramebuffers(1, &fbo);
    r->glBindFramebuffer(GL_FRAMEBUFFER, fbo);
    r->glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, texture, 0);
    assert(r->glCheckFramebufferStatus(GL_FRAMEBUFFER) == GL_FRAMEBUFFER_COMPLETE);
    PFNGLCLEARCOLORPROC clear_color = (void *)r->eglGetProcAddress("glClearColor");
    PFNGLCLEARPROC clear = (void *)r->eglGetProcAddress("glClear");
    PFNGLFINISHPROC finish = (void *)r->eglGetProcAddress("glFinish");
    assert(clear_color && clear && finish);
    clear_color(1, 0, 0, 1);
    clear(GL_COLOR_BUFFER_BIT);
    finish();
    assert(r->glGetError() == GL_NO_ERROR);
    r->glBindFramebuffer(GL_FRAMEBUFFER, 0);
    char error[256];
    assert(release_context(r, error, sizeof(error)) == 0);
    const uint8_t *pixels;
    size_t size;
    assert(osc_dmabuf_egl_read(r, fd, 64, 64, fourcc, offset, (int32_t)stride,
        modifier, &pixels, &size, error, sizeof(error)) == 0);
    for (size_t i = 0; i < size; i += 4) {
        const uint8_t expected[] = { 255, 0, 0, 255 };
        assert(memcmp(pixels + i, expected, 4) == 0);
    }
    assert(r->eglMakeCurrent(r->display, r->surface, r->surface, r->context));
    r->glDeleteFramebuffers(1, &fbo);
    r->glDeleteTextures(1, &texture);
    assert(r->destroy_image(r->display, image));
    assert(release_context(r, error, sizeof(error)) == 0);
    close(fd);
    gbm_bo_destroy(bo);
    printf("Explicit modifier 0x%llx: allocation, render-target import, GPU render and RGBA readback passed\n",
        (unsigned long long)modifier);
}

int main(int argc, char **argv) {
  char error[256];
  assert(argc == 2);
  struct osc_dmabuf_egl *reader = osc_dmabuf_egl_create(error, sizeof(error));
  if (!reader)
    fprintf(stderr, "%s\n", error);
  assert(reader != NULL);
  test_rejections(reader);
#ifdef OSC_PW_FRAME_TEST
  assert(osc_pw_test_modifier_pod(reader) == 0);
#endif
  int fd = open(argv[1], O_RDWR | O_CLOEXEC);
  assert(fd >= 0);
  struct gbm_device *device = gbm_create_device(fd);
  assert(device != NULL);
  const uint32_t formats[] = {GBM_FORMAT_ARGB8888, GBM_FORMAT_ABGR8888,
                              GBM_FORMAT_XRGB8888, GBM_FORMAT_XBGR8888};
  for (size_t i = 0; i < sizeof(formats) / sizeof(formats[0]); i++)
    test_format(reader, device, formats[i]);
  test_rendered_modifier(reader, device);
  osc_dmabuf_egl_destroy(reader); /* Main-thread teardown after worker joins. */
  gbm_device_destroy(device);
  close(fd);
  puts("DMA-BUF EGL: four RGB formats, LINEAR/INVALID, RGBA channels, row "
       "order, repeated worker reads passed");
  return 0;
}
#endif
