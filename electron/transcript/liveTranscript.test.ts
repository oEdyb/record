import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	LiveTranscriptService,
	type TranscriptClipListing,
	type TranscriptSnapshot,
} from "./liveTranscript";

let dir: string;
let listing: TranscriptClipListing;
let extract: ReturnType<typeof vi.fn>;
let transcribe: ReturnType<typeof vi.fn>;
let snapshots: TranscriptSnapshot[];

function clip(index: number, durationMs = 1_000) {
	return { index, microphoneAudioPath: `/rec/clip-${index}-microphone.mov`, durationMs };
}

function makeService(
	overrides: Partial<ConstructorParameters<typeof LiveTranscriptService>[0]> = {},
) {
	return new LiveTranscriptService({
		listClips: () => listing,
		ffmpegPath: () => "/bin/ffmpeg",
		helperPath: () => "/bin/parakeet",
		ensureModel: async () => "/models/parakeet",
		tempDir: path.join(dir, "tmp"),
		cacheDir: path.join(dir, "cache"),
		onSnapshot: (snapshot) => snapshots.push(snapshot),
		now: () => 1,
		extract: extract as never,
		transcriber: () => ({ transcribe: transcribe as never, stop: vi.fn() }),
		...overrides,
	});
}

beforeEach(async () => {
	dir = await mkdtemp(path.join(tmpdir(), "klippt-transcript-"));
	listing = { recordingId: 7, clips: [clip(0), clip(1, 2_000)], live: false };
	snapshots = [];
	extract = vi.fn(async () => undefined);
	transcribe = vi.fn(async ({ id }: { id: string }) => ({
		id,
		text: `text ${id}`,
		detectedLanguage: "en",
	}));
});

describe("LiveTranscriptService", () => {
	it("transcribes committed clips in order, reports progress, and caches the text on disk", async () => {
		const service = makeService();
		const result = await service.refresh();

		expect(result.status).toBe("idle");
		expect(result.clips.map((entry) => entry.text)).toEqual(["text clip-0", "text clip-1"]);
		expect(extract).toHaveBeenCalledTimes(2);
		expect(extract.mock.calls[0]?.[1]).toBe("/rec/clip-0-microphone.mov");
		expect(snapshots.map((s) => s.progress)).toContainEqual({ done: 1, total: 2 });
		const cached = JSON.parse(await readFile(path.join(dir, "cache", "7.json"), "utf8"));
		expect(Object.values(cached)).toEqual(["text clip-0", "text clip-1"]);
	});

	it("only transcribes clips it has not seen on the next refresh", async () => {
		const service = makeService();
		await service.refresh();
		listing = { ...listing, clips: [...listing.clips, clip(2)] };
		const result = await service.refresh();

		expect(transcribe).toHaveBeenCalledTimes(3);
		expect(result.clips).toHaveLength(3);
		expect(result.clips[2]?.text).toBe("text clip-2");
	});

	it("reuses the on-disk cache in a fresh service", async () => {
		await makeService().refresh();
		transcribe.mockClear();
		const result = await makeService().refresh();

		expect(transcribe).not.toHaveBeenCalled();
		expect(result.clips.map((entry) => entry.text)).toEqual(["text clip-0", "text clip-1"]);
	});

	it("refuses to run while a take is live and not paused", async () => {
		listing = { ...listing, live: true };
		const result = await makeService().refresh();

		expect(result.status).toBe("blocked");
		expect(transcribe).not.toHaveBeenCalled();
	});

	it("keeps the last take after the recorder forgets it", async () => {
		const service = makeService();
		await service.refresh();
		listing = { recordingId: null, clips: [], live: false };
		const result = await service.refresh();

		expect(result.recordingId).toBe(7);
		expect(result.clips).toHaveLength(2);
	});

	it("records a per-clip error and keeps going", async () => {
		transcribe.mockImplementationOnce(async () => {
			throw new Error("helper choked");
		});
		const result = await makeService().refresh();

		expect(result.clips[0]).toMatchObject({ text: null, error: "helper choked" });
		expect(result.clips[1]?.text).toBe("text clip-1");
		expect(result.error).toBeNull();
	});

	it("reports a missing helper as the snapshot error", async () => {
		const result = await makeService({ helperPath: () => null }).refresh();

		expect(result.status).toBe("idle");
		expect(result.error).toMatch(/Apple Silicon/);
		expect(transcribe).not.toHaveBeenCalled();
	});
});
