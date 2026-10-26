# Decision ledger

The choices that shape the architecture, and the ones that were tried and rejected. This file
exists so nobody re-litigates a settled question or re-proposes a route that has already been
measured and lost. It is the only doc here that names things which no longer exist — everywhere
else, the docs describe what is.

A decision leaves this list only when the code stops honouring it.

## In force

| Decision | Why |
|---|---|
| **Linux shares the clip lifecycle, review UI, recovery journal and source handoff with macOS. Native helpers retain platform capture and encoding.** Linux is the next port, Windows follows (October 26, 2026). | One product model prevents platform-specific persistence and recovery drift. Linux uses portal/PipeWire, GPU DMA-BUF import when necessary, and NVENC/VAAPI/Vulkan with reported software fallback. See [Linux evidence](../../docs/linux-port-2026-10-26.md). |
| **The editor is archived; the review window is the only shell.** On 2026-10-05 the editor UI, in-app chat, `klippt agent` CLI, automatic direction, and speech-to-text were removed. The last source with them is the tag `archive/pre-cleanup-2026-10-05`. Windows and Linux capture code stays for later ports. | The product is recording-first: capture, review, untouched-source handoff, and One video export. Restoring from the tag is cheaper than maintaining unused surfaces. Existing projects still open and render their stored regions. See [editor-shell.md](editor-shell.md). |
| **One document is the single source of truth.** `AxcutDocument` (`src/lib/ai-edition/schema/index.ts`) holds the whole project; the review preview and the exporter are projections of it. No surface keeps parallel edit state. | Every desync bug this editor has had came from two surfaces owning the same fact. See [document-model.md](document-model.md). |
| **Modifiers are authored above the timeline and stored down on the clip.** Zoom, speed and annotation ranges are anchored to a clip, not to absolute timeline time. | Trimming or reordering a clip must carry its modifiers with it. Absolute anchoring silently desyncs preview from render. See [timeline-model.md](timeline-model.md). |
| **Clips on the timeline are always contiguous** — no gaps, no overlap. | The export segment loop and the audio junction logic both depend on it; permitting holes would double the state space for no user-visible gain. See [export-pipeline.md](export-pipeline.md). |
| **Native helpers own capture, timing and encoding; Electron owns session orchestration and persistence.** | Frame timing cannot be made reliable across an IPC boundary. See [recording.md](recording.md). |
| **Windows production recording does not silently fall back to `getDisplayMedia` / `MediaRecorder`.** A native path that fails, fails loudly. | A silent fallback produced recordings that were subtly worse with no signal to the user. |
| **Compositing and encoding run in one native Rust engine**, shared by live preview and export, with platform GPU backends such as D3D11 and Metal. | See [native-compositor.md](native-compositor.md), and [../engineering/rendering-performance.md](../engineering/rendering-performance.md) for the measurements that chose it. |
| **The inherited AI/LLM surface is hidden from the normal paid-alpha UI.** Its validated operations and the `klippt agent` CLI were archived on 2026-10-05. Local deterministic editing does not depend on an LLM. | Clip-native recording and the normal editor are the product. A second chat product must not clutter or delay the alpha path. See [ai-agent.md](ai-agent.md). |
| **The project file extension is `.klippt`.** Legacy `.openscreen` and `.axcut` files remain readable and are copied forward after validation without deleting the original. | Klippt needs its own project identity without breaking old projects or rollback. See [document-model.md](document-model.md). |
| **Migrations are forward-only.** A document is migrated up to the current `schemaVersion` on open and never written back down. | Round-tripping through an older schema loses fields silently. |
| **Projects store derived-media intent, not derived files or job state.** An asset can store an optional versioned Clean Voice recipe. App-owned content-addressed caches hold generated stems, manifests, progress and failures. | Raw recordings stay authoritative, projects stay portable, and a missing or corrupt cache can fall back to raw and rebuild without changing an edit. |
| **Captions are derived from the transcript, not injected as annotations.** | The earlier design generated annotation objects from captions, which then drifted from the transcript the moment either was edited. The transcript is the SSOT for spoken words. |
| **One package, one repository.** No sidecar process, no local HTTP server, no monorepo. | The editing engine was adopted from a project that had a Python worker and a Fastify server; both were replaced by in-process TypeScript and Electron IPC. Adding a second runtime back is a large, permanent cost. |
| **Production content uses `klippt://app`, not disabled web security.** Approved media is addressed through opaque, canonical, range-capable grants. Privileged IPC validates the top-level trusted renderer before application logic runs. | Local files and stored project content are untrusted inputs. A contained standard origin preserves browser security while keeping media seekable. See [native-bridge.md](native-bridge.md). |
| **The offscreen editor preview renders at visible CSS size.** Export resolves its own independent output size. | Multiplying the preview by Retina DPR created a 2560×1440 RGBA transfer for a 1280×720 panel and missed the 30 FPS readback budget. More preview pixels did not add visible editor detail. See [preview.md](preview.md). |

## Rejected, with the reason

Each of these was actually built or measured. Do not re-propose one without new evidence that
contradicts the reason given.

| Route | What happened |
|---|---|
| **Rust + wgpu native compositor** | Built as a POC. Zero-copy Vulkan video decode required driver features not available on the target hardware. The principle — a GPU-resident pipeline — was right; D3D11 delivers it without the driver dependency. |
| **Tauri / separate native core** | Would have split the app across two runtimes and two build systems to solve a problem that was measured to be in the compositor, not in Electron. |
| **Encoder pipelining** | Implemented and measured: a *loss* on the target integrated GPU, because encode and composite contend for the same queue. |
| **Software VP9 export** | Worked correctly end to end, but with no hardware VP9 encoder on the target GPU it was far too slow to ship. Removed rather than left as a trap. |
| **Proxy MP4 files for scrubbing** | Dropped in favour of streaming decode. If long-recording scrub latency becomes the top complaint again, the revival path is a per-asset "generate proxy" action, not a background pass over every import. |
| **Server-sent events for project changes** | Meaningless in a single-user desktop app; the document store already notifies every subscriber. |
| **Auto-generating annotations from captions** | See "captions are derived" above. |
| **React Query for the agent layer** | Planned during the merge, never adopted; the dependency is not in `package.json`. Plain IPC plus the document store covers it. |

## Surfaces that were removed

Older docs and code comments still refer to these. They are gone; the second column is where the
behaviour lives now.

| Removed | Replaced by |
|---|---|
| `VideoEditor` (the pre-merge editor) | the v4 editor, itself archived on 2026-10-05; now `src/components/ai-edition/RecordingReviewShell.tsx` |
| `TimelinePane.tsx` | archived with the v4 editor (`V4Timeline.tsx`, tag `archive/pre-cleanup-2026-10-05`) |
| `Titlebar.tsx`, `Bottombar.tsx` | archived with the v4 editor; now `RecordingReviewToolbar.tsx` |
| `RightPanelStack.tsx` | archived with the v4 editor (`FloatingInspector.tsx`) |
| `TranscriptEditor.tsx` | archived with the v4 editor (`CaptionsPane.tsx`); stored captions render through `src/lib/ai-edition/captions/` |
| Local transcription, the in-app chat, LLM providers, `klippt agent` | archived on 2026-10-05; see [transcription-and-captions.md](transcription-and-captions.md), [ai-agent.md](ai-agent.md), [llm-providers.md](llm-providers.md) |
| The browser-based exporter | the native compositor export path — see [export-pipeline.md](export-pipeline.md) |
| CTranslate2 speech-to-text | whisper.cpp — see [transcription-and-captions.md](transcription-and-captions.md) |
