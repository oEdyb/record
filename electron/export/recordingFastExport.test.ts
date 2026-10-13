import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	parseRecordingSourceMetadata,
	RecordingVideoPacketAccumulator,
	runRecordingFfmpeg,
} from "./recordingFastExport";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));

const video =
	"  Stream #0:0[0x1](und): Video: h264 (High) (avc1), yuv420p(progressive), 1920x1080, 2000 kb/s, 20.81 fps, 60 tbr, 600 tbn\n";
const audio = (index: number, language = "und") =>
	`  Stream #0:${index}[0x${index + 1}](${language}): Audio: aac (LC), 48000 Hz, stereo, fltp, 384 kb/s\n`;
const header = (tracks = "") =>
	`  Duration: 00:02:00.00, start: 0.000000, bitrate: 2000 kb/s\n${video}${tracks}`;

describe("recording source metadata", () => {
	it("uses nominal capture cadence instead of sparse average fps", () => {
		expect(parseRecordingSourceMetadata(header(audio(1)))).toEqual({
			codec: "h264",
			width: 1920,
			height: 1080,
			fps: 60,
			audioStreamIndex: 1,
		});
		expect(
			parseRecordingSourceMetadata(
				header(audio(1).replace("aac (LC)", "aac (LC) (mp4a / 0x6134706D)")),
			)?.audioStreamIndex,
		).toBe(1);
		expect(
			parseRecordingSourceMetadata(header().replace("20.81 fps, 60 tbr", "57.36 fps, 58 tbr")),
		).toMatchObject({ fps: 58 });
	});
	it("selects the intended mix rather than an isolated microphone/system stream", () => {
		expect(
			parseRecordingSourceMetadata(header(audio(1, "qab") + audio(2, "qac") + audio(3, "qaa")))
				?.audioStreamIndex,
		).toBe(3);
		expect(parseRecordingSourceMetadata(header(audio(1, "qab") + audio(2, "qac")))).toBeNull();
		expect(parseRecordingSourceMetadata(header(audio(1) + audio(2)))).toBeNull();
	});
	it("recognizes silent recordings and rejects ambiguous role metadata", () => {
		expect(parseRecordingSourceMetadata(header())?.audioStreamIndex).toBeNull();
		expect(parseRecordingSourceMetadata(header(audio(1, "qaa") + audio(2, "qaa")))).toBeNull();
		expect(
			parseRecordingSourceMetadata(
				header(audio(1, "qaa") + "    title : screenrec.microphone.v1\n"),
			),
		).toBeNull();
	});
	it.each([
		["h264 (High)", "vp9"],
		["yuv420p(progressive)", "yuv420p10le(progressive)"],
		["yuv420p(progressive)", "yuv420p(top first)"],
		["1920x1080", "1920x1080 [SAR 2:1 DAR 32:9]"],
		["start: 0.000000", "start: 0.040000"],
		["48000 Hz", "44100 Hz"],
		["stereo", "mono"],
	])("declines unsupported source metadata %s", (from, to) => {
		expect(parseRecordingSourceMetadata(header(audio(1)).replace(from, to))).toBeNull();
	});
	it("declines rotation and additional video streams", () => {
		expect(
			parseRecordingSourceMetadata(header() + "      displaymatrix: rotation of 90.00 degrees\n"),
		).toBeNull();
		expect(parseRecordingSourceMetadata(header() + video.replace("#0:0", "#0:1"))).toBeNull();
	});
});

describe("recording FFmpeg child lifetime", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
	});
	function child() {
		const result = Object.assign(new EventEmitter(), {
			stdout: new PassThrough(),
			stderr: new PassThrough(),
			kill: vi.fn(() => true),
		});
		spawn.mockReturnValue(result);
		return result;
	}
	it("waits for closed file handles after an abort error", async () => {
		const process = child();
		const controller = new AbortController();
		const done = vi.fn();
		const operation = runRecordingFfmpeg("ffmpeg", [], controller.signal, 10_000).catch(
			(error: unknown) => {
				done();
				return error;
			},
		);
		controller.abort();
		process.emit("error", Object.assign(new Error("cancel"), { name: "AbortError" }));
		await Promise.resolve();
		expect(done).not.toHaveBeenCalled();
		process.emit("close", null);
		expect(await operation).toMatchObject({ name: "AbortError" });
		expect(spawn.mock.calls[0]?.[2]).toMatchObject({
			killSignal: "SIGKILL",
			signal: controller.signal,
		});
	});
	it("waits for close after a spawn failure and does not swallow the error", async () => {
		const process = child();
		const error = new Error("binary unavailable");
		const operation = runRecordingFfmpeg("ffmpeg", [], new AbortController().signal, 10_000);
		process.emit("error", error);
		process.emit("close", -2);
		await expect(operation).rejects.toBe(error);
	});
	it("kills a timed-out child and waits for its close before rejecting", async () => {
		vi.useFakeTimers();
		const process = child();
		const done = vi.fn();
		const operation = runRecordingFfmpeg("ffmpeg", [], new AbortController().signal, 10).catch(
			(error: unknown) => {
				done();
				return error;
			},
		);
		await vi.advanceTimersByTimeAsync(10);
		expect(process.kill).toHaveBeenCalledWith("SIGKILL");
		expect(done).not.toHaveBeenCalled();
		process.emit("close", null);
		expect(await operation).toMatchObject({ message: expect.stringContaining("timed out") });
	});
	it("streams progress and bounds diagnostics while awaiting successful close", async () => {
		const process = child();
		const progress = vi.fn();
		const operation = runRecordingFfmpeg(
			"ffmpeg",
			[],
			new AbortController().signal,
			10_000,
			progress,
		);
		process.stdout.write("frame=60\n");
		process.stderr.write("x".repeat(100_000));
		process.emit("close", 0);
		expect(progress).toHaveBeenCalledWith("frame=60\n");
		expect((await operation).length).toBe(64 * 1024);
	});
	it("kills and awaits close when packet/progress processing fails", async () => {
		const process = child();
		const error = new Error("invalid packet proof");
		const settled = vi.fn();
		const operation = runRecordingFfmpeg("ffmpeg", [], new AbortController().signal, 10_000, () => {
			throw error;
		}).catch((failure: unknown) => {
			settled();
			return failure;
		});
		process.stdout.write("invalid");
		expect(process.kill).toHaveBeenCalledWith("SIGKILL");
		await Promise.resolve();
		expect(settled).not.toHaveBeenCalled();
		process.emit("close", null);
		expect(await operation).toBe(error);
	});
});

describe("recording packet timestamp proof", () => {
	const hashes = ["a".repeat(32), "b".repeat(32), "c".repeat(32)];
	const original = `#tb 0: 1/600\n0, -20, 0, 10, 7, ${hashes[0]}\n0, -10, 10, 1, 7, ${hashes[1]}\n0, 0, 11, 1, 7, ${hashes[2]}\n`;
	const remuxed = `#tb 0: 1/19200\n0, -640, 0, 320, 7, ${hashes[0]}\n0, -320, 320, 32, 7, ${hashes[1]}\n0, 0, 352, 32, 7, ${hashes[2]}\n`;
	const proof = (text: string) => {
		const accumulator = new RecordingVideoPacketAccumulator();
		accumulator.append(text.slice(0, 25));
		accumulator.append(text.slice(25));
		return accumulator.finish();
	};
	it("proves closing-frame packet and PTS/DTS identity despite remux time-base changes", () => {
		expect(proof(remuxed)).toEqual(proof(original));
		expect(proof(original).frames).toBe(3);
		expect(proof(original).averageFps).toBeCloseTo((2 * 600) / 11, 4);
	});
	it.each([
		(remuxed: string) => remuxed.replace("320, 32", "321, 32"),
		(remuxed: string) => remuxed.replace("-640", "-641"),
		(remuxed: string) => remuxed.replace(hashes[1]!, "d".repeat(32)),
	])("detects changed presentation/decode timing or encoded payload", (change) => {
		expect(proof(change(remuxed)).digest).not.toBe(proof(original).digest);
	});
	it("rejects incomplete or invalid packet proof", () => {
		expect(() => proof(original.trimEnd())).toThrow("Incomplete");
		expect(() => proof(original.replace("1/600", "0/600"))).toThrow("Unable to prove");
	});
});
