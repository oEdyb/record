const SITE_URL = "https://klippt.app";

export const ORGANIZATION_ID = `${SITE_URL}/#organization`;
export const WEBSITE_ID = `${SITE_URL}/#website`;
export const SOFTWARE_ID = `${SITE_URL}/#software`;

export const SOFTWARE_APPLICATION_LD = {
	"@type": "SoftwareApplication",
	"@id": SOFTWARE_ID,
	name: "Klippt",
	applicationCategory: "MultimediaApplication",
	applicationSubCategory: "Screen Recorder and Video Editor",
	operatingSystem: "macOS",
	description:
		"A clip-native screen recorder and editor for Mac with pause-and-continue recording, editable automatic direction, camera emphasis, pause shortening, and local high-quality export.",
	url: SITE_URL,
	isAccessibleForFree: true,
	featureList: [
		"Clip-native pause and continue recording",
		"Remove the previous clip while recording",
		"Editable automatic screen direction and camera emphasis",
		"Speech-aware pause shortening",
		"16:9, 9:16, 1:1, and custom output layouts",
		"Local Apple Silicon preview and export",
	],
	publisher: { "@id": ORGANIZATION_ID },
};

export function jsonLd(...nodes: object[]): string {
	const body = nodes.length === 1 ? nodes[0] : { "@graph": nodes };
	return JSON.stringify({ "@context": "https://schema.org", ...body });
}
