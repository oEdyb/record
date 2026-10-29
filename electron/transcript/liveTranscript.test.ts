import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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
		words: [{ word: id, startSec: 0.1, endSec: 0.4, confidence: 0.9 }],
		detectedLanguage: "en",
	}));
});

describe("LiveTranscriptService", () => {
	it("transcribes committed clips in order, reports progress, and caches text and word times on disk", async () => {
		const service = makeService();
		const result = await service.refresh();

		expect(result.status).toBe("idle");
		expect(result.clips.map((entry) => entry.text)).toEqual(["text clip-0", "text clip-1"]);
		expect(result.clips[1]?.words).toEqual([
			{ word: "clip-1", startSec: 0.1, endSec: 0.4, confidence: 0.9 },
		]);
		expect(extract).toHaveBeenCalledTimes(2);
		expect(extract.mock.calls[0]?.[1]).toBe("/rec/clip-0-microphone.mov");
		expect(snapshots.map((s) => s.progress)).toContainEqual({ done: 1, total: 2 });
		const cached = JSON.parse(await readFile(path.join(dir, "cache", "7.json"), "utf8"));
		expect(Object.values(cached).map((entry) => (entry as { text: string }).text)).toEqual([
			"text clip-0",
			"text clip-1",
		]);
	});

	it("reads a text-only cache from before word times without transcribing again", async () => {
		await mkdir(path.join(dir, "cache"), { recursive: true });
		await writeFile(
			path.join(dir, "cache", "7.json"),
			JSON.stringify({
				"7:0:/rec/clip-0-microphone.mov": "old clip-0",
				"7:1:/rec/clip-1-microphone.mov": "old clip-1",
			}),
		);
		const result = await makeService().refresh();

		expect(transcribe).not.toHaveBeenCalled();
		expect(result.clips.map((entry) => entry.text)).toEqual(["old clip-0", "old clip-1"]);
		expect(result.clips.map((entry) => entry.words)).toEqual([null, null]);
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
		expect(result.clips[0]?.words?.[0]?.word).toBe("clip-0");
	});

	it("refuses to run while a take is live and not paused", async () => {
		listing = { ...listing, live: true };
		const result = await makeService().refresh();

		expect(result.status).toBe("blocked");
		expect(transcribe).not.toHaveBeenCalled();
	});

	it("stops before the next clip when the take continues during a pass", async () => {
		transcribe.mockImplementationOnce(async ({ id }: { id: string }) => {
			listing = { ...listing, live: true };
			return { id, text: `text ${id}`, detectedLanguage: "en" };
		});
		const result = await makeService().refresh();

		expect(transcribe).toHaveBeenCalledOnce();
		expect(result.status).toBe("blocked");
		expect(result.clips.map((entry) => entry.text)).toEqual(["text clip-0", null]);
		const cached = JSON.parse(await readFile(path.join(dir, "cache", "7.json"), "utf8"));
		expect(Object.values(cached).map((entry) => (entry as { text: string }).text)).toEqual([
			"text clip-0",
		]);
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
		expect(result.error).toMatch(/speech helper|Apple Silicon/);
		expect(transcribe).not.toHaveBeenCalled();
	});

	it("transcribes after a clip only when the model is already on disk", async () => {
		const ensureModel = vi.fn(async () => "/models/parakeet");
		const missing = makeService({ modelReady: () => false, ensureModel });
		expect(missing.refreshAfterClip()).toBeNull();
		expect(ensureModel).not.toHaveBeenCalled();

		const result = await makeService({ modelReady: () => true }).refreshAfterClip();
		expect(result?.clips.map((entry) => entry.text)).toEqual(["text clip-0", "text clip-1"]);
	});

	it("runs once more when a clip finishes during a pass", async () => {
		let release: () => void = () => undefined;
		transcribe.mockImplementationOnce(async ({ id }: { id: string }) => {
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return { id, text: `text ${id}`, detectedLanguage: "en" };
		});
		const service = makeService();
		const first = service.refresh();
		await vi.waitFor(() => expect(transcribe).toHaveBeenCalledOnce());
		listing = { ...listing, clips: [...listing.clips, clip(2)] };
		const second = service.refresh();
		release();
		await first;
		const result = await second;

		expect(result.clips.map((entry) => entry.text)).toEqual([
			"text clip-0",
			"text clip-1",
			"text clip-2",
		]);
	});

	it("keeps the final clip of a stopped take after the recorder resets", async () => {
		const service = makeService();
		service.rememberStoppedTake({ ...listing, clips: [...listing.clips, clip(2)] });
		listing = { recordingId: null, clips: [], live: false };
		const result = await service.refresh();

		expect(result.recordingId).toBe(7);
		expect(result.clips.map((entry) => entry.text)).toEqual([
			"text clip-0",
			"text clip-1",
			"text clip-2",
		]);
	});

	it("leaves a clip cut short by a resume unfinished, not failed", async () => {
		const service = makeService({
			transcriber: () => ({
				transcribe: transcribe as never,
				stop: () => undefined,
			}),
		});
		transcribe.mockImplementationOnce(async () => {
			listing = { ...listing, live: true };
			service.interrupt();
			throw new Error("Parakeet helper stopped.");
		});
		const result = await service.refresh();

		expect(result.status).toBe("blocked");
		expect(result.clips[0]).toMatchObject({ text: null, error: null });
		expect(transcribe).toHaveBeenCalledOnce();
	});
});
