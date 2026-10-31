# Studio review frame readiness

Finish keeps Studio visible until the review canvas has painted the current take's screen.
The main-process 1.5-second timeout remains the fallback. During a finishing take, the
loading cover uses the same canvas evidence as `review-ready`.

## Boundary and source evidence

The repository's native implementation is the primary source for this contract:

- `crates/compositor/src/live.rs`: `Player::recompose` returns false before a screen frame
  exists. The paused render loop previously ignored that result and published readback
  even on its first tick. It now publishes only after successful composition and propagates
  composition errors. The shared live path also serves Linux; the packet shape is unchanged.
- `src/native/hooks/useNativeCompositorView.ts`: `notePreviewPaintedFrame` runs after
  `transferFromImageBitmap` or `putImageData`, so this evidence describes canvas pixels.
- `src/native/useNativePlaybackSync.ts`: a transport anchor identifies the document, view,
  screen path, generation and clip. `previewSettledFrames.ts` accepts painted evidence only
  for that anchor, a positive generation, and finite source time within the primary screen
  clip's half-open source interval.

The shell subscribes to that existing evidence store. Hidden HTML video callbacks no longer
establish handoff readiness. Video decode and stage readiness remain additional requirements.

## Verification

- Renderer regression: cold and warm handoffs reject generation zero, stale generation,
  wrong document/source, wrong clip, nonfinite time and clip end; accept matching pixels.
  The targeted shell, settled-frame and playback-sync tests pass (27 tests).
- Native regression: an actual offscreen live view publishes nothing before screen decode,
  then publishes the applied transport generation. Cargo tests for `openscreen-compositor`
  and `compositor-view-napi` pass (273 passed, 4 ignored).
- App and test TypeScript checks, Biome on touched TypeScript files, and rustfmt on `live.rs`
  pass. Full npm suite: 3333 passed, 8 known policy failures, 5 skipped.
- macOS addon rebuilt with `npm run build:native:compositor:mac`; local helper staging
  populated from the existing development checkout and its provenance refreshed.
- Linux cross-check attempted; this Mac lacks `x86_64-unknown-linux-gnu` Rust core/std.
  No Linux compilation or desktop result is claimed.

The installed app was not replaced, quit, driven or used to play sound. Parent verification
still needs cold and warm Stop → Finish screen captures against the rebuilt app.
