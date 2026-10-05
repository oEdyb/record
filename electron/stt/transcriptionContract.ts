/**
 * Shared types for the native speech-to-text pipeline. The renderer talks to
 * the main process through these types; the main-process STT modules talk to
 * each other through them. No runtime imports — keeps the contract folder
 * cheap to share with renderer + main + test code.
 *
 * ponytail: the renderer doesn't import the `SttBackend` union (only the
 * `Stt*Segment` shapes), so renaming the literals is safe — the wire types
 * other than `SttBackend` are unchanged from the previous whisper.cpp-based
 * contract and don't need to move.
 */

/** Stable product roles. They describe the captured source, not a guessed person. */
export type SttSourceRole = "you" | "system" | "unknown-mixed";
