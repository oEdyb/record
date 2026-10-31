export const VOICEOVER_VIDEO_LIMIT = 128 * 1024 * 1024;
export const VOICEOVER_AUDIO_LIMIT = 32 * 1024 * 1024;
export const VOICEOVER_OUTPUT_LIMIT = 144 * 1024 * 1024;
export const VOICEOVER_DURATION_LIMIT = 300;

export function checkVoiceoverDuration(duration: number): void {
	if (!Number.isFinite(duration) || duration <= 0 || duration > VOICEOVER_DURATION_LIMIT)
		throw new Error(
			"Voiceover mixing supports media up to 5 minutes. Mix longer recordings outside Klippt.",
		);
}

export async function readBoundedVoiceoverInput(
	url: string,
	maxBytes: number,
	signal?: AbortSignal,
): Promise<Blob> {
	const response = await fetch(url, { signal });
	if (!response.ok) throw new Error(`Failed to read voiceover mixing input: ${url}`);
	const reader = response.body?.getReader();
	if (!reader) throw new Error("Voiceover mixing input has no readable body.");
	const parts: Uint8Array<ArrayBuffer>[] = [];
	let size = 0;
	try {
		if (Number(response.headers.get("content-length")) > maxBytes)
			throw new Error(
				"Voiceover mixing input exceeds the memory limit. Mix larger files outside Klippt.",
			);
		while (true) {
			signal?.throwIfAborted();
			const { value, done } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > maxBytes)
				throw new Error(
					"Voiceover mixing input exceeds the memory limit. Mix larger files outside Klippt.",
				);
			parts.push(new Uint8Array(value));
		}
		return new Blob(parts);
	} finally {
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}
