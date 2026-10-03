import { expect, it, vi } from "vitest";

const inspect = vi.hoisted(() => vi.fn());
vi.mock("../stt/sourceAudio", () => ({ inspectSourceAudioLayout: inspect }));

import { probeAudioImport } from "./probeAudioImport";

it("requires a bounded audio duration, not just a valid video container", async () => {
	inspect.mockResolvedValue({ hasAudio: false, durationSec: 12 });
	await expect(probeAudioImport("/tmp/silent.mp4")).rejects.toThrow();
	inspect.mockResolvedValue({ hasAudio: true, durationSec: null });
	await expect(probeAudioImport("/tmp/stream.mp3")).rejects.toThrow();
	inspect.mockResolvedValue({ hasAudio: true, durationSec: 10801 });
	await expect(probeAudioImport("/tmp/long.wav")).rejects.toThrow();
	inspect.mockResolvedValue({ hasAudio: true, durationSec: 12.5 });
	await expect(probeAudioImport("/tmp/music.wav")).resolves.toBe(12.5);
});
