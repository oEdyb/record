/**
 * The small product surface shown in the current Klippt alpha.
 *
 * Hidden features stay implemented and keep their document compatibility. A
 * later product slice can expose them again without restoring inherited UI by
 * accident across several unrelated components.
 */
export const PRODUCT_SURFACE = Object.freeze({
	agentEditor: false,
	mediaWorkspace: false,
	captions: false,
	transcript: false,
});

export type OptionalEditorFacet = "captions" | "transcript";

export function isOptionalEditorFacetVisible(facet: OptionalEditorFacet): boolean {
	return facet === "captions" ? PRODUCT_SURFACE.captions : PRODUCT_SURFACE.transcript;
}

export const AUTOMATIC_TRANSCRIPTION_ENABLED =
	PRODUCT_SURFACE.captions || PRODUCT_SURFACE.transcript;
