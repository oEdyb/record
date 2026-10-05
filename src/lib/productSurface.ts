/**
 * The small product surface shown in the current Klippt alpha.
 *
 * Hidden features stay implemented and keep their document compatibility. A
 * later product slice can expose them again without restoring inherited UI by
 * accident across several unrelated components.
 */
export const PRODUCT_SURFACE = Object.freeze({
	recordingOnly: true,
	agentEditor: false,
	mediaWorkspace: false,
	captions: true,
	transcript: true,
	automaticTranscription: false,
});
