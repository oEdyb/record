export const KLIPPT_SCHEME = "klippt";
export const KLIPPT_APP_ORIGIN = `${KLIPPT_SCHEME}://app`;
export const KLIPPT_MEDIA_PATH_PREFIX = "/__media__/";
export const KLIPPT_RESOURCE_PATH_PREFIX = "/__resources__/";

function encodeBase64Url(value: string): string {
	const bytes = new TextEncoder().encode(value);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value: string): string | null {
	try {
		const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
		const padding = "=".repeat((4 - (base64.length % 4)) % 4);
		const binary = atob(base64 + padding);
		const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return null;
	}
}

export function toKlipptMediaUrl(filePath: string): string {
	return `${KLIPPT_APP_ORIGIN}${KLIPPT_MEDIA_PATH_PREFIX}${encodeBase64Url(filePath)}`;
}

export function fromKlipptMediaUrl(mediaUrl: string): string | null {
	try {
		const url = new URL(mediaUrl);
		if (
			url.protocol !== `${KLIPPT_SCHEME}:` ||
			url.host !== "app" ||
			!url.pathname.startsWith(KLIPPT_MEDIA_PATH_PREFIX)
		) {
			return null;
		}
		const encodedPath = url.pathname.slice(KLIPPT_MEDIA_PATH_PREFIX.length);
		return encodedPath && !encodedPath.includes("/") ? decodeBase64Url(encodedPath) : null;
	} catch {
		return null;
	}
}
