// @vitest-environment node
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { inflateSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveFfmpeg } from "../media/audioPeaks";
import {
	analyzeCutEdges,
	encodePngRgb,
	isClippedWord,
	pcmRmsBuckets,
	renderWaveformStrip,
	rmsToDbFs,
	sampleFramesAtEdges,
	verifyContentAtEdges,
} from "./agentContentVerify";

const ROOT = path.resolve(__dirname, "..", "..");

function s16(values: number[]): Buffer {
	const buffer = Buffer.alloc(values.length * 2);
	for (const [i, value] of values.entries()) buffer.writeInt16LE(value, i * 2);
	return buffer;
}

function constantPcm(amplitude: number, samples: number): Buffer {
	return s16(new Array<number>(samples).fill(Math.min(32767, Math.round(amplitude * 32768))));
}

/** Chunk-walking PNG reader for assertions on the module's own encoder. */
function pngInfo(png: Buffer) {
	expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
	let offset = 8;
	const idat: Buffer[] = [];
	let width = 0;
	let height = 0;
	while (offset < png.length) {
		const length = png.readUInt32BE(offset);
		const type = png.subarray(offset + 4, offset + 8).toString("ascii");
		const data = png.subarray(offset + 8, offset + 8 + length);
		if (type === "IHDR") {
			width = data.readUInt32BE(0);
			height = data.readUInt32BE(4);
		}
		if (type === "IDAT") idat.push(data);
		offset += 12 + length;
	}
	return { width, height, raw: inflateSync(Buffer.concat(idat)) };
}

describe("RMS buckets and levels", () => {
	it("computes RMS per 20 ms window over mono s16le", () => {
		// 3 windows of 320 samples at 16 kHz: silence, half-scale, full-scale.
		const pcm = Buffer.concat([constantPcm(0, 320), constantPcm(0.5, 320), constantPcm(1, 320)]);
		const buckets = pcmRmsBuckets(pcm);
		expect(buckets).toHaveLength(3);
		expect(buckets[0]).toBe(0);
		expect(buckets[1]).toBeCloseTo(0.5, 3);
		expect(buckets[2]).toBeCloseTo(1, 3);
	});

	it("drops a trailing partial window instead of guessing", () => {
		expect(pcmRmsBuckets(constantPcm(0.5, 320 + 100))).toHaveLength(1);
	});

	it("maps RMS to dBFS with a silence clamp", () => {
		expect(rmsToDbFs(1)).toBe(0);
		expect(rmsToDbFs(0.5)).toBeCloseTo(-6.02, 2);
		expect(rmsToDbFs(0)).toBe(-120);
		expect(rmsToDbFs(1e-9)).toBe(-120);
	});
});

describe("clipped-word rule", () => {
	it("flags when the post-cut level holds within 15 dB of the word tail", () => {
		expect(isClippedWord(-27, -27.5)).toBe(true);
		expect(isClippedWord(-27, -12.1)).toBe(true);
		expect(isClippedWord(-27, -12)).toBe(true);
	});

	it("passes when the audio drops away after the cut", () => {
		expect(isClippedWord(-27, -42.1)).toBe(false);
		expect(isClippedWord(-27, -120)).toBe(false);
	});

	it("never flags a cut at silence, however flat the level", () => {
		expect(isClippedWord(-60, -60)).toBe(false);
		expect(isClippedWord(-45.1, -45.1)).toBe(false);
		expect(isClippedWord(-44.9, -44.9)).toBe(true);
	});
});

describe("minimal PNG encoder and waveform strip", () => {
	it("writes a parseable PNG with the requested dimensions", () => {
		const rgb = Buffer.alloc(4 * 3 * 3, 128);
		const png = encodePngRgb(4, 3, rgb);
		const info = pngInfo(png);
		expect(info.width).toBe(4);
		expect(info.height).toBe(3);
		// One filter byte (0) per scanline, then the RGB payload verbatim.
		expect(info.raw).toHaveLength(3 * (4 * 3 + 1));
		for (let y = 0; y < 3; y++) {
			expect(info.raw[y * 13]).toBe(0);
			expect(info.raw.subarray(y * 13 + 1, (y + 1) * 13)).toEqual(
				rgb.subarray(y * 12, (y + 1) * 12),
			);
		}
	});

	it("rejects a buffer that does not match the dimensions", () => {
		expect(() => encodePngRgb(4, 3, Buffer.alloc(10))).toThrow("VERIFY_IMAGE_INVALID");
	});

	it("renders loud audio as bars and the cut position as a red line", () => {
		// 0.6 s of full-scale square-ish signal; cut at the middle.
		const pcm = constantPcm(1, 9600);
		const png = renderWaveformStrip(pcm, { width: 320, height: 64, startSec: 0, markSec: 0.3 });
		const info = pngInfo(png);
		expect(info.width).toBe(320);
		expect(info.height).toBe(64);
		const stride = 320 * 3 + 1;
		const pixel = (x: number, y: number) => [
			info.raw[y * stride + 1 + x * 3],
			info.raw[y * stride + 2 + x * 3],
			info.raw[y * stride + 3 + x * 3],
		];
		// The mark column is red top to bottom.
		expect(pixel(160, 0)).toEqual([248, 113, 113]);
		expect(pixel(160, 63)).toEqual([248, 113, 113]);
		// Full-scale audio fills the bar column beside the mark; the background is dark.
		expect(pixel(100, 32)).not.toEqual([15, 17, 21]);
		expect(pixel(100, 0)).toEqual([15, 17, 21]);
	});

	it("renders silence as a flat strip", () => {
		const png = renderWaveformStrip(constantPcm(0, 9600), { startSec: 0, markSec: 0.3 });
		const info = pngInfo(png);
		const stride = 320 * 3 + 1;
		// A non-mark column stays background everywhere except the 1-row minimum bar.
		expect(info.raw[1 + 100 * 3]).toBe(15);
		expect(info.raw[1 + 100 * 3 + 1]).toBe(17);
		expect(info.raw[stride * 63 + 1 + 100 * 3]).toBe(15);
	});
});

describe("input validation", () => {
	it("rejects relative or missing media paths and bad edge times", () => {
		const audio = { audio: { role: "microphone" as const }, ffmpeg: null };
		expect(() => analyzeCutEdges("relative.mp4", [], audio)).toThrow("VERIFY_MEDIA_INVALID");
		expect(() => analyzeCutEdges("/no/such/file.mp4", [], audio)).toThrow("VERIFY_MEDIA_INVALID");
		expect(() =>
			analyzeCutEdges(path.join(ROOT, "package.json"), [{ timeSec: -1 }], audio),
		).toThrow("VERIFY_EDGE_INVALID");
	});

	it("reports ffmpeg-missing instead of throwing when no binary exists", () => {
		const result = analyzeCutEdges(path.join(ROOT, "package.json"), [{ timeSec: 1 }], {
			ffmpeg: null,
			audio: { role: "microphone" },
		});
		expect(result.status).toBe("ffmpeg-missing");
		expect(result.findings).toEqual([]);
		expect(result.audioTrack).toBeNull();
	});
});

// Integration: real ffmpeg, real decodes. The synthesized speech fixture is
// 220 Hz word bursts (0.6 s on, 0.4 s off) on a single untagged track, analyzed
// with the `mixed` role; the committed tests/fixtures/speech-*.m4a files hold
// the real "experiment"/"yourselves" recordings (separate describe below).
// Skipped where the native ffmpeg is not staged (CI), like audioPeaks.test.ts.
const staged = resolveFfmpeg(ROOT);
describe.runIf(staged)("clipped-word detection on real audio", () => {
	const ffmpeg = staged as string;
	let directory: string;
	let speech: string;

	beforeAll(() => {
		directory = mkdtempSync(path.join(tmpdir(), "klippt-content-verify-"));
		speech = path.join(directory, "speech.m4a");
		const created = spawnSync(ffmpeg, [
			"-hide_banner",
			"-loglevel",
			"error",
			"-y",
			"-f",
			"lavfi",
			"-i",
			"sine=frequency=220:duration=4,volume=volume='if(between(mod(t,1),0,0.6),0.5,0)':eval=frame",
			"-c:a",
			"aac",
			speech,
		]);
		expect(created.status).toBe(0);
	});

	afterAll(() => {
		rmSync(directory, { recursive: true, force: true });
	});

	it("flags cuts that land mid-word", () => {
		// Bursts span [0,0.6], [1.0,1.6], [2.0,2.6], [3.0,3.6].
		const result = analyzeCutEdges(speech, [{ timeSec: 1.3, label: "clip-a" }, { timeSec: 2.45 }], {
			audio: { role: "mixed" },
		});
		expect(result.status).toBe("ok");
		expect(result.audioTrack).toMatchObject({ role: "mixed", audioStreams: 1, matched: true });
		expect(result.analyses.map((a) => a.clipped)).toEqual([true, true]);
		expect(result.findings).toHaveLength(2);
		expect(result.findings[0]).toMatchObject({
			rule: "cut.clipped-word",
			severity: "error",
			at: 1.3,
			label: "clip-a",
		});
		// RMS continuity is evidence, not a verdict: the message says so.
		expect(result.findings[0].message).toContain("consistent with clipped speech");
		expect(result.findings[0].message).toContain("Out point 1.300s");
		// Mid-word means the level barely changes across the cut.
		expect(Math.abs(result.analyses[0].deltaDb ?? 0)).toBeLessThan(6);
		expect(result.analyses[0].windowStartSec).toBeCloseTo(0.7, 3);
		expect(result.analyses[0].bucketsDbFs.length).toBeGreaterThanOrEqual(59);
	});

	it("names the in-point side for right-side edges", () => {
		const result = analyzeCutEdges(speech, [{ timeSec: 1.3, label: "in:clip-b" }], {
			audio: { role: "mixed" },
		});
		expect(result.findings[0].message).toContain("In point 1.300s");
	});

	it("passes clean cuts at silence and right after a word ends", () => {
		const result = analyzeCutEdges(speech, [{ timeSec: 1.8 }, { timeSec: 0.65 }], {
			audio: { role: "mixed" },
		});
		expect(result.analyses.map((a) => a.status)).toEqual(["ok", "ok"]);
		expect(result.analyses.every((a) => !a.clipped)).toBe(true);
		expect(result.findings).toEqual([]);
		// The 1.8 s cut sits in a pause: the tail is below the speech floor.
		expect(result.analyses[0].tailDbFs).toBeLessThan(-45);
	});

	it("flags a mid-word trim of the existing committed tone fixture", () => {
		// peaks-sample.m4a is a constant 5 s tone: any interior out point has the
		// "word" continuing at full level after the cut — the detector must flag it.
		const fixture = path.join(ROOT, "electron", "media", "__fixtures__", "peaks-sample.m4a");
		if (!existsSync(fixture)) return;
		const result = analyzeCutEdges(fixture, [{ timeSec: 2.5 }], { audio: { role: "mixed" } });
		expect(result.analyses[0].clipped).toBe(true);
		expect(result.findings[0].rule).toBe("cut.clipped-word");
	});

	it("reports no-audio past EOF instead of failing", () => {
		const result = analyzeCutEdges(speech, [{ timeSec: 99 }], { audio: { role: "mixed" } });
		expect(result.analyses[0].status).toBe("no-audio");
		expect(result.findings).toEqual([]);
	}, 60_000);
});

describe.runIf(staged)("frame sampling and the filmstrip", () => {
	const ffmpeg = staged as string;
	let directory: string;
	let video: string;

	beforeAll(() => {
		directory = mkdtempSync(path.join(tmpdir(), "klippt-content-frames-"));
		video = path.join(directory, "cuts.mkv");
		// 1 s moving testsrc, 1 s black, 1 s static colour; word-burst audio.
		const created = spawnSync(ffmpeg, [
			"-hide_banner",
			"-loglevel",
			"error",
			"-y",
			"-f",
			"lavfi",
			"-i",
			"testsrc2=size=320x180:rate=10:duration=1",
			"-f",
			"lavfi",
			"-i",
			"color=black:size=320x180:rate=10:duration=1",
			"-f",
			"lavfi",
			"-i",
			"color=0x224466:size=320x180:rate=10:duration=1",
			"-f",
			"lavfi",
			"-i",
			"sine=frequency=220:duration=3,volume=volume='if(between(mod(t,1),0,0.6),0.5,0)':eval=frame",
			"-filter_complex",
			"[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]",
			"-map",
			"[v]",
			"-map",
			"3:a",
			"-c:v",
			"ffv1",
			"-c:a",
			"pcm_s16le",
			video,
		]);
		expect(created.status).toBe(0);
	});

	afterAll(() => {
		rmSync(directory, { recursive: true, force: true });
	});

	it("warns on black frames and identical frames across an edge", () => {
		const out = path.join(directory, "frames");
		const result = sampleFramesAtEdges(
			video,
			[{ timeSec: 0.5 }, { timeSec: 1.5 }, { timeSec: 2.2 }, { timeSec: 2.6 }],
			out,
		);
		expect(result.frames.map((f) => f.status)).toEqual(["ok", "ok", "ok", "ok"]);
		for (const frame of result.frames) expect(existsSync(frame.path as string)).toBe(true);
		expect(result.findings).toContainEqual(
			expect.objectContaining({ rule: "frame.black", severity: "warning", at: 1.5 }),
		);
		expect(result.findings).toContainEqual(
			expect.objectContaining({ rule: "frame.identical", severity: "warning", at: 2.6 }),
		);
		// Moving testsrc and the first static-colour sample raise no warnings.
		expect(result.findings.filter((f) => f.at === 0.5 || f.at === 2.2)).toEqual([]);
	});

	it("reports no-video on audio-only media", () => {
		const audioOnly = path.join(directory, "only.m4a");
		const created = spawnSync(ffmpeg, [
			"-hide_banner",
			"-loglevel",
			"error",
			"-y",
			"-f",
			"lavfi",
			"-i",
			"sine=frequency=440:duration=1",
			"-c:a",
			"aac",
			audioOnly,
		]);
		expect(created.status).toBe(0);
		const result = sampleFramesAtEdges(audioOnly, [{ timeSec: 0.5 }], path.join(directory, "av"));
		expect(result.frames[0].status).toBe("no-video");
		expect(result.findings).toEqual([]);
	});

	it("builds a filmstrip with the waveform under each frame and full findings", () => {
		const out = path.join(directory, "verify");
		const result = verifyContentAtEdges(
			video,
			[{ timeSec: 0.3, label: "cut-a" }, { timeSec: 1.5 }, { timeSec: 2.6, kind: "overlay" }],
			{ outDirectory: out, audio: { role: "mixed" } },
		);
		expect(result.status).toBe("ok");
		// Overlay edges get frames but no clipped-word analysis.
		expect(result.analyses).toHaveLength(2);
		expect(result.frames).toHaveLength(3);
		// Both cut edges sit inside word bursts ([0,0.6] and [1.0,1.6]).
		expect(result.findings.filter((f) => f.rule === "cut.clipped-word").map((f) => f.at)).toEqual([
			0.3, 1.5,
		]);
		expect(result.findings).toContainEqual(
			expect.objectContaining({ rule: "frame.black", at: 1.5 }),
		);
		expect(result.filmstrip).toBe(path.join(out, "filmstrip.png"));
		const strip = pngInfo(readFileSync(result.filmstrip as string));
		// 3 columns of (320+8) px padding-joined; rows are 180 frame + 64 wave + 16 pad.
		expect(strip.width).toBe(3 * 328);
		expect(strip.height).toBe(180 + 64 + 16);
	}, 60_000);
});

// Finding 5 (wave-one review): automatic stream selection hid a clipped word on
// the microphone track behind a silent first track. The detector now requires
// an explicit, validated role. The two-track fixture mirrors the review's
// two-track.mkv repro: silent first track, clipped speech on the second.
describe.runIf(staged)("explicit audio track selection", () => {
	const ffmpeg = staged as string;
	let directory: string;
	let twoTrack: string;

	beforeAll(() => {
		directory = mkdtempSync(path.join(tmpdir(), "klippt-track-select-"));
		twoTrack = path.join(directory, "two-track.m4a");
		// Track 0: silence tagged qaa (the mix slot). Track 1: constant speech-level
		// tone tagged qac (the isolated microphone) — a cut at 1.0 s is mid-word.
		const created = spawnSync(ffmpeg, [
			"-hide_banner",
			"-loglevel",
			"error",
			"-y",
			"-f",
			"lavfi",
			"-i",
			"anullsrc=r=48000:cl=mono:d=2",
			"-f",
			"lavfi",
			"-i",
			"sine=frequency=220:duration=2",
			"-map",
			"0:a",
			"-map",
			"1:a",
			"-metadata:s:a:0",
			"language=qaa",
			"-metadata:s:a:1",
			"language=qac",
			"-c:a",
			"aac",
			twoTrack,
		]);
		expect(created.status).toBe(0);
	});

	afterAll(() => {
		rmSync(directory, { recursive: true, force: true });
	});

	it("analyzes the requested microphone track, not the silent first track", () => {
		const result = analyzeCutEdges(twoTrack, [{ timeSec: 1 }], { audio: { role: "microphone" } });
		expect(result.audioTrack).toMatchObject({
			role: "microphone",
			requiredLanguage: "qac",
			audioStreams: 2,
			matched: true,
			unavailable: null,
		});
		expect(result.analyses[0]).toMatchObject({ status: "ok", clipped: true });
		expect(result.findings[0].rule).toBe("cut.clipped-word");
	});

	it("documents why: automatic (mixed) selection decodes the silent track", () => {
		// The pre-repair behavior: FFmpeg's default stream is the silent qaa
		// track, so the same edge reports silence and no finding. Explicit role
		// selection is the fix; this pins the failure mode it replaces.
		const result = analyzeCutEdges(twoTrack, [{ timeSec: 1 }], { audio: { role: "mixed" } });
		expect(result.analyses[0].status).toBe("ok");
		expect(result.analyses[0].tailDbFs).toBeLessThan(-45);
		expect(result.findings).toEqual([]);
	});

	it("reports unavailable instead of falling back when the role track is absent", () => {
		// Single untagged track: no qac microphone track exists to analyze.
		const speech = path.join(directory, "single.m4a");
		const created = spawnSync(ffmpeg, [
			"-hide_banner",
			"-loglevel",
			"error",
			"-y",
			"-f",
			"lavfi",
			"-i",
			"sine=frequency=220:duration=2",
			"-c:a",
			"aac",
			speech,
		]);
		expect(created.status).toBe(0);
		const result = analyzeCutEdges(speech, [{ timeSec: 1 }], { audio: { role: "microphone" } });
		expect(result.status).toBe("ok");
		expect(result.audioTrack).toMatchObject({ matched: false, audioStreams: 1 });
		expect(result.audioTrack?.unavailable).toContain("qac");
		expect(result.analyses[0].status).toBe("unavailable");
		expect(result.analyses[0].error).toContain("not falling back");
		expect(result.findings).toEqual([]);
	});
});

// Finding 6 (wave-one review): executable/timeout/decode errors used to
// collapse into `no-audio`, looking like verified-absent audio. They must come
// back `unavailable` with the reason; only a genuinely audio-less stream is
// `no-audio`.
describe.runIf(staged)("unavailable is distinct from verified-absent audio", () => {
	const ffmpeg = staged as string;
	let directory: string;
	let speech: string;

	beforeAll(() => {
		directory = mkdtempSync(path.join(tmpdir(), "klippt-unavailable-"));
		speech = path.join(directory, "speech.m4a");
		const created = spawnSync(ffmpeg, [
			"-hide_banner",
			"-loglevel",
			"error",
			"-y",
			"-f",
			"lavfi",
			"-i",
			"sine=frequency=220:duration=2",
			"-c:a",
			"aac",
			speech,
		]);
		expect(created.status).toBe(0);
	});

	afterAll(() => {
		rmSync(directory, { recursive: true, force: true });
	});

	it("a missing decoder binary reports unavailable, never no-audio", () => {
		const result = analyzeCutEdges(speech, [{ timeSec: 1 }], {
			ffmpeg: "/no/such/ffmpeg",
			audio: { role: "mixed" },
		});
		expect(result.status).toBe("ok");
		expect(result.analyses[0].status).toBe("unavailable");
		expect(result.analyses[0].error).toBeTruthy();
		expect(result.audioTrack?.matched).toBe(false);
		expect(result.audioTrack?.unavailable).toBeTruthy();
		expect(result.findings).toEqual([]);
	});

	it("an undecodable file reports unavailable, never no-audio", () => {
		// package.json exists (passes media validation) but ffmpeg cannot read it.
		const result = analyzeCutEdges(path.join(ROOT, "package.json"), [{ timeSec: 1 }], {
			audio: { role: "mixed" },
		});
		expect(result.analyses[0].status).toBe("unavailable");
		expect(result.analyses[0].error).toContain("stream listing failed");
	});

	it("a file with no audio track is verified-absent (no-audio)", () => {
		const silent = path.join(directory, "video-only.mkv");
		const created = spawnSync(ffmpeg, [
			"-hide_banner",
			"-loglevel",
			"error",
			"-y",
			"-f",
			"lavfi",
			"-i",
			"testsrc2=size=64x64:rate=5:duration=1",
			"-c:v",
			"ffv1",
			silent,
		]);
		expect(created.status).toBe(0);
		const result = analyzeCutEdges(silent, [{ timeSec: 0.5 }], { audio: { role: "microphone" } });
		expect(result.audioTrack).toMatchObject({ audioStreams: 0, matched: false, unavailable: null });
		expect(result.analyses[0].status).toBe("no-audio");
		expect(result.analyses[0].error).toBeUndefined();
		expect(result.findings).toEqual([]);
	});
});

// Plan phase-6 acceptance: the real "experiment"/"yourselves" recordings from
// the Kimi project. Each fixture is a 1.6 s window (all three native audio
// tracks, tags preserved) around the cut, extracted read-only from
// ~/Library/Application Support/openscreen/recordings. The tightened times are
// the trims Olle heard clip the words (history entry a3a2885c after-state:
// experiment out 9.284645, yourselves out 8.596188); the restored times are the
// current trims (9.818 and 9.082). The cut sits at 0.8 s inside each fixture.
describe.runIf(staged)("real speech fixtures: experiment/yourselves tightened vs restored", () => {
	const fixtureDir = path.join(ROOT, "tests", "fixtures");
	const cases = [
		{ file: "speech-experiment-tightened.m4a", word: "experiment", clipped: true },
		{ file: "speech-experiment-restored.m4a", word: "experiment", clipped: false },
		{ file: "speech-yourselves-tightened.m4a", word: "yourselves", clipped: true },
		{ file: "speech-yourselves-restored.m4a", word: "yourselves", clipped: false },
	];

	it.each(cases)("microphone analysis of $file ($word) => clipped=$clipped", ({
		file,
		clipped,
	}) => {
		const media = path.join(fixtureDir, file);
		expect(existsSync(media)).toBe(true);
		const result = analyzeCutEdges(media, [{ timeSec: 0.8, label: `out:${file}` }], {
			audio: { role: "microphone" },
		});
		expect(result.status).toBe("ok");
		expect(result.audioTrack).toMatchObject({ matched: true, audioStreams: 3 });
		expect(result.analyses).toHaveLength(1);
		expect(result.analyses[0].status).toBe("ok");
		expect(result.analyses[0].clipped).toBe(clipped);
		if (clipped) {
			expect(result.findings).toHaveLength(1);
			expect(result.findings[0].rule).toBe("cut.clipped-word");
			// Evidence language with the measured levels, not a verdict.
			expect(result.findings[0].message).toContain("consistent with clipped speech");
			expect(result.findings[0].message).not.toContain("is mid-word");
		} else {
			// The restored cuts land in measured pauses (tail below the speech floor).
			expect(result.analyses[0].tailDbFs).toBeLessThan(-45);
			expect(result.findings).toEqual([]);
		}
	});

	it("an edge past the end of a tagged recording is no-audio, not unavailable", () => {
		const result = analyzeCutEdges(
			path.join(fixtureDir, "speech-experiment-restored.m4a"),
			[{ timeSec: 99 }],
			{
				audio: { role: "microphone" },
			},
		);
		expect(result.analyses[0].status).toBe("no-audio");
		expect(result.findings).toEqual([]);
	}, 60_000);
});
