/**
 * The download page reads the owned update manifest at runtime, so a new release needs no site
 * rebuild. latest.json is written by scripts/stage-update-release.mjs.
 */

export const UPDATE_BASE_URL = "https://updates.dyberg.co/klippt";
export const MINIMUM_MACOS = "macOS 13 Ventura";

export type MacDownload = { version: string; url: string; sizeBytes?: number };

function isOwnedDownload(value: unknown): value is string {
	if (typeof value !== "string") return false;
	try {
		const url = new URL(value);
		return url.origin === "https://updates.dyberg.co" && url.pathname.startsWith("/klippt/");
	} catch {
		return false;
	}
}

function field(value: unknown, key: string): unknown {
	return value && typeof value === "object"
		? Object.entries(value).find(([k]) => k === key)?.[1]
		: undefined;
}

export async function fetchMacDownload(signal?: AbortSignal): Promise<MacDownload | null> {
	const response = await fetch(`${UPDATE_BASE_URL}/latest.json`, { cache: "no-store", signal });
	if (!response.ok) return null;
	const manifest: unknown = await response.json();
	const version = field(manifest, "version");
	const url = field(field(manifest, "downloads"), "darwin-arm64");
	if (typeof version !== "string" || !isOwnedDownload(url)) return null;
	const fileName = decodeURIComponent(url.split("/").pop() ?? "");
	const size = field(field(field(manifest, "artifacts"), fileName), "size");
	return { version, url, sizeBytes: typeof size === "number" ? size : undefined };
}

export function formatSize(bytes: number | undefined): string {
	return bytes ? `${Math.round(bytes / 1048576)} MB` : "";
}
