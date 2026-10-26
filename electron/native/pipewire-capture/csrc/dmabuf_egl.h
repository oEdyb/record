#ifndef OSC_DMABUF_EGL_H
#define OSC_DMABUF_EGL_H

#include <stddef.h>
#include <stdint.h>

#define OSC_DMABUF_MAX_MODIFIERS 256

#define OSC_DRM_FORMAT_MOD_LINEAR UINT64_C(0)
#define OSC_DRM_FORMAT_MOD_INVALID UINT64_C(0x00ffffffffffffff)
#define OSC_DRM_FOURCC(a, b, c, d)                                             \
  ((uint32_t)(a) | ((uint32_t)(b) << 8) | ((uint32_t)(c) << 16) |              \
   ((uint32_t)(d) << 24))

struct osc_dmabuf_egl;

/* Select the compositor's GPU through a private Wayland connection. No default
 * EGL/GBM display: on hybrid systems that can silently select the wrong GPU.
 * The context is released before returning, and after each read, so destroy
 * may run on the caller after the PipeWire loop has been joined. Calls on one
 * reader must be serialized. EGL/GLES/Wayland and libgbm.so.1 (plane-count
 * queries) are dynamically loaded, never linked. */
struct osc_dmabuf_egl *osc_dmabuf_egl_create(char *err, size_t err_len);
void osc_dmabuf_egl_destroy(struct osc_dmabuf_egl *reader);

/* Borrowed, format-specific explicit modifiers supported by this EGL display
 * and verified as single-plane by GBM on its associated DRM render node. The
 * implicit INVALID sentinel is deliberately excluded from negotiation. */
size_t osc_dmabuf_egl_modifiers(const struct osc_dmabuf_egl *reader,
                                uint32_t fourcc, const uint64_t **modifiers);

/* Single-plane 32-bit RGB only. Does not own fd. INVALID omits modifier
 * attributes; explicit modifiers require the modifiers extension and a queried
 * texture import. External textures are sampled into an RGBA FBO. Returns
 * tightly packed RGBA, in buffer row order,
 * borrowed until the next read/destroy. Failure never returns pixel data.
 * GPU implicit synchronization applies; DMA_BUF_IOCTL_SYNC is for CPU mappings.
 * Source contracts: EGL_EXT_image_dma_buf_import{,_modifiers},
 * GL_OES_EGL_image. */
int osc_dmabuf_egl_read(struct osc_dmabuf_egl *reader, int fd, uint32_t width,
                        uint32_t height, uint32_t fourcc, uint64_t offset,
                        int32_t stride, uint64_t modifier, const uint8_t **rgba,
                        size_t *size, char *err, size_t err_len);

#endif
