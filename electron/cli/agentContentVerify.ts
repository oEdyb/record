import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { type AudioTrackSelection, audioTrackMapArgs, resolveFfmpeg } from "../media/audioPeaks";

/**
 * Content-level verification for agent edits (plan phase 6, detector half).
 *
 * WHY THIS EXISTS. Structural checks and transcripts cannot prove a cut did not
 * chop a word: the "experiment" and "yourselves" cuts passed every check while
 * the audio was audibly clipped. This module decodes the real audio around each
 * out point with ffmpeg and compares the level after the cut against the word
 * tail before it, and samples real frames at each edge so black or frozen
 * content becomes a finding instead of a surprise at export.
 *
 * Deliberately standalone: it takes a media path, an explicit audio-provenance
 * contract (which track/role to decode — `microphone` for speech clipping),
 * and edge times; never reads a project document, never prints, and returns
 * structured findings the check wiring maps onto `cut.clipped-word` /
 * `frame.black` / `frame.identical`. The requested track is validated against
 * the file's stream list before decoding; a missing role track or a decoder
 * failure comes back `unavailable`, never a silent fall-back to track 0.
 * Synchronous spawnSync calls keep it callable from any verify path; each
 * decode is a bounded window around one edge, so memory stays flat no matter
 * how long the recording is.
 */

export interface ContentVerifyEdge {
	/** Edge time in the media file's own clock (out point or overlay boundary). */
	timeSec: number;
	/** Caller correlation id (clip id, overlay id) — passed through, never read. */
	label?: string;
	/** `overlay` edges get frame sampling only; `cut` edges also get audio analysis. */
	kind?: "cut" | "overlay";
}

export type ContentFindingId = "cut.clipped-word" | "frame.black" | "frame.identical";

export interface ContentFinding {
	rule: ContentFindingId;
	severity: "error" | "warning";
	at: number;
	label?: string;
	message: string;
	evidence: Record<string, number | string>;
}

export interface CutAudioAnalysis {
	edge: ContentVerifyEdge;
	/**
	 * `no-audio` is a verified absence: the file has no audio track at all, or
	 * the edge sits past the end of the decoded audio. `unavailable` is a
	 * failure: the decoder, the stream listing, or the requested track was not
	 * usable, so nothing was verified — `error` carries the reason.
	 */
	status: "ok" | "no-audio" | "unavailable";
	error?: string;
	windowStartSec: number;
	/** RMS per 20 ms bucket across the decoded window, in dBFS. */
	bucketsDbFs: number[];
	tailDbFs: number | null;
	postDbFs: number | null;
	deltaDb: number | null;
	clipped: boolean;
}

export interface SampledFrame {
	edge: ContentVerifyEdge;
	status: "ok" | "no-video";
	path: string | null;
	meanLuma: number | null;
	maxLuma: number | null;
	/** sha1 of the 64x36 rgb24 pixels; equal hashes mean identical frames. */
	hash: string | null;
}

export interface ContentVerifyResult {
	status: "ok" | "ffmpeg-missing";
	findings: ContentFinding[];
	analyses: CutAudioAnalysis[];
	frames: SampledFrame[];
	filmstrip: string | null;
	/** Track the audio analysis decoded, or null when ffmpeg itself is missing. */
	audioTrack: AudioTrackReport | null;
}

/**
 * Explicit audio provenance for cut analysis: which track/role the speech
 * levels come from. `microphone` is the isolated speech track on native Klippt
 * recordings (language tag `qac`); `system` is `qab`; `mixed` is FFmpeg's
 * default stream, which on native recordings is the mix. The requested role is
 * validated against the file's stream list before any edge is decoded — a
 * missing role track reports `unavailable`, never a silent fall-back to
 * track 0.
 */
export interface AudioProvenance {
	role: AudioTrackSelection;
}

export interface AudioTrackReport {
	role: AudioTrackSelection;
	/** Language tag the role requires on native recordings; null for `mixed`. */
	requiredLanguage: string | null;
	/** Audio streams in the file; null when the stream listing itself failed. */
	audioStreams: number | null;
	/** The requested role resolved to a real track. */
	matched: boolean;
	/** Why the role cannot be analyzed; null when matched or verifiably no audio. */
	unavailable: string | null;
}

export interface ContentVerifyOptions {
	/** Explicit ffmpeg path; `null` forces the ffmpeg-missing status (tests). */
	ffmpeg?: string | null;
	/** When set, frames are sampled into this directory and the filmstrip is built. */
	outDirectory?: string;
	toleranceDb?: number;
	floorDbFs?: number;
}

/** Options for calls that decode audio: the provenance contract is required. */
export interface CutAnalysisOptions extends ContentVerifyOptions {
	audio: AudioProvenance;
}

export const RMS_WINDOW_SEC = 0.02;
export const WORD_TAIL_SEC = 0.12;
export const POST_CUT_SEC = 0.12;
export const CLIPPED_WORD_TOLERANCE_DB = 15;
/** A tail quieter than this is a pause, not a word: nothing can be clipped. */
export const TAIL_SPEECH_FLOOR_DBFS = -45;

const PCM_RATE = 16_000;
/** Half-width of the audio context decoded around each edge. */
const EDGE_CONTEXT_SEC = 0.6;
const DECODE_TIMEOUT_MS = 30_000;
const FRAME_WIDTH = 320;
const FRAME_HEIGHT = 180;
const STATS_WIDTH = 64;
const STATS_HEIGHT = 36;
const WAVE_WIDTH = 320;
const WAVE_HEIGHT = 64;
/** dBFS range mapped onto the waveform strip height. */
const WAVE_FLOOR_DBFS = -60;
const BLACK_MEAN_LUMA = 0.05;
const BLACK_MAX_LUMA = 0.1;

function runFfmpeg(ffmpeg: string, args: string[]) {
	return spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-nostdin", ...args], {
		timeout: DECODE_TIMEOUT_MS,
		maxBuffer: 16 * 1024 * 1024,
		windowsHide: true,
	});
}

interface EdgeAudio {
	pcm: Buffer;
	startSec: number;
}

type EdgeDecode =
	| { status: "ok"; audio: EdgeAudio }
	| /** Window decodes to zero samples (edge past the end of the audio). */ { status: "no-audio" }
	| { status: "unavailable"; error: string };

/** Language tag each isolated role carries on native Klippt recordings. */
const ROLE_LANGUAGE: Record<Exclude<AudioTrackSelection, "mixed">, string> = {
	microphone: "qac",
	system: "qab",
};

interface ListedAudioStream {
	index: number;
	language: string | null;
}

/**
 * Audio stream inventory from ffmpeg's own input dump, so no ffprobe install is
 * required. ffmpeg exits non-zero for `-i` without an output; the "Input #0"
 * header, not the exit code, is what proves the file was read. The dump needs
 * the default log level, so this does not use runFfmpeg's `-loglevel error`.
 */
function listAudioStreams(
	ffmpeg: string,
	mediaPath: string,
): { status: "ok"; streams: ListedAudioStream[] } | { status: "unavailable"; error: string } {
	const result = spawnSync(ffmpeg, ["-hide_banner", "-nostdin", "-i", mediaPath], {
		timeout: DECODE_TIMEOUT_MS,
		maxBuffer: 4 * 1024 * 1024,
		windowsHide: true,
	});
	if (result.error)
		return { status: "unavailable", error: `stream listing failed: ${result.error.message}` };
	const stderr = result.stderr?.toString() ?? "";
	if (!stderr.includes("Input #0"))
		return {
			status: "unavailable",
			error: `stream listing failed: ${stderr.trim().split("\n").pop() || `ffmpeg exited ${result.status}`}`,
		};
	const streams: ListedAudioStream[] = [];
	// `Stream #0:3[0x4](qac): Audio: aac ...` — the language tag is the
	// parenthesised code; `und` means untagged.
	const pattern = /Stream #0:(\d+)(?:\[[^\]]*\])?(?:\(([^)]*)\))?: Audio:/g;
	for (const match of stderr.matchAll(pattern))
		streams.push({
			index: Number(match[1]),
			language: match[2] && match[2] !== "und" ? match[2] : null,
		});
	return { status: "ok", streams };
}

interface AudioTrackPlan {
	report: AudioTrackReport;
	mapArgs: string[];
	/** Set when no per-edge decode may run: every cut edge gets this outcome. */
	forced?: EdgeDecode;
}

/**
 * Validate the requested role against the file's stream list before decoding.
 * A file with no audio at all is verified-absent (`no-audio`); a file with
 * audio that lacks the requested role is `unavailable` — analysing another
 * track would silently measure the wrong audio.
 */
function planAudioTrack(
	ffmpeg: string,
	mediaPath: string,
	role: AudioTrackSelection,
): AudioTrackPlan {
	const requiredLanguage = role === "mixed" ? null : ROLE_LANGUAGE[role];
	const listing = listAudioStreams(ffmpeg, mediaPath);
	if (listing.status === "unavailable")
		return {
			report: {
				role,
				requiredLanguage,
				audioStreams: null,
				matched: false,
				unavailable: listing.error,
			},
			mapArgs: [],
			forced: { status: "unavailable", error: listing.error },
		};
	const matched = requiredLanguage
		? listing.streams.some((stream) => stream.language === requiredLanguage)
		: listing.streams.length > 0;
	const report: AudioTrackReport = {
		role,
		requiredLanguage,
		audioStreams: listing.streams.length,
		matched,
		unavailable: null,
	};
	if (!listing.streams.length) return { report, mapArgs: [], forced: { status: "no-audio" } };
	if (!matched && requiredLanguage) {
		const seen = listing.streams.map((stream) => stream.language ?? "untagged").join(", ");
		const error = `media has ${listing.streams.length} audio streams (${seen}) but none tagged ${requiredLanguage} for the ${role} role; not falling back to another track`;
		report.unavailable = error;
		return { report, mapArgs: [], forced: { status: "unavailable", error } };
	}
	return { report, mapArgs: audioTrackMapArgs(role) };
}

/** PCM for [timeSec - 0.6, timeSec + 0.6] of the mapped track, clamped at 0. */
function decodeEdgeContext(
	ffmpeg: string,
	mediaPath: string,
	timeSec: number,
	mapArgs: string[],
): EdgeDecode {
	const startSec = Math.max(0, timeSec - EDGE_CONTEXT_SEC);
	const durationSec = timeSec + EDGE_CONTEXT_SEC - startSec;
	const result = runFfmpeg(ffmpeg, [
		"-ss",
		startSec.toFixed(3),
		"-i",
		mediaPath,
		...mapArgs,
		"-t",
		durationSec.toFixed(3),
		"-vn",
		"-ac",
		"1",
		"-ar",
		String(PCM_RATE),
		"-f",
		"s16le",
		"-",
	]);
	if (result.error)
		return { status: "unavailable", error: `decode failed: ${result.error.message}` };
	if (result.status !== 0)
		return {
			status: "unavailable",
			error: `decode failed: ffmpeg exited ${result.status}${
				result.stderr?.toString().trim()
					? `: ${result.stderr.toString().trim().split("\n").pop()}`
					: ""
			}`,
		};
	if (!result.stdout?.length) return { status: "no-audio" };
	return { status: "ok", audio: { pcm: result.stdout, startSec } };
}

/** RMS per 20 ms bucket over mono s16le PCM. Trailing partial buckets are dropped. */
export function pcmRmsBuckets(pcm: Buffer, windowSec = RMS_WINDOW_SEC, rate = PCM_RATE): number[] {
	const per = Math.max(1, Math.round(rate * windowSec));
	const samples = Math.floor(pcm.length / 2);
	const buckets: number[] = [];
	for (let b = 0; (b + 1) * per <= samples; b++) {
		let sum = 0;
		for (let i = 0; i < per; i++) {
			const value = pcm.readInt16LE((b * per + i) * 2) / 32768;
			sum += value * value;
		}
		buckets.push(Math.sqrt(sum / per));
	}
	return buckets;
}

export function rmsToDbFs(rms: number): number {
	return rms <= 0 ? -120 : Math.max(-120, 20 * Math.log10(rms));
}

function round1(value: number): number {
	return Math.round(value * 10) / 10;
}

/** Energy mean of bucket RMS values, in dBFS. */
function bucketLevelDbFs(buckets: number[]): number | null {
	if (!buckets.length) return null;
	let sum = 0;
	for (const rms of buckets) sum += rms * rms;
	return rmsToDbFs(Math.sqrt(sum / buckets.length));
}

/**
 * The phase-6 rule: an edge is consistent with clipped speech when the level
 * 0–120 ms after the out point stays within `toleranceDb` of the word tail. A
 * tail below `floorDbFs` is silence, so clean cuts at pauses cannot flag.
 */
export function isClippedWord(
	tailDbFs: number,
	postDbFs: number,
	toleranceDb = CLIPPED_WORD_TOLERANCE_DB,
	floorDbFs = TAIL_SPEECH_FLOOR_DBFS,
): boolean {
	if (tailDbFs < floorDbFs) return false;
	return postDbFs - tailDbFs >= -toleranceDb;
}

function analyzeDecodedEdge(
	edge: ContentVerifyEdge,
	decode: EdgeDecode,
	toleranceDb: number,
	floorDbFs: number,
): CutAudioAnalysis {
	if (decode.status === "unavailable")
		return {
			edge,
			status: "unavailable",
			error: decode.error,
			windowStartSec: Math.max(0, edge.timeSec - EDGE_CONTEXT_SEC),
			bucketsDbFs: [],
			tailDbFs: null,
			postDbFs: null,
			deltaDb: null,
			clipped: false,
		};
	if (decode.status === "no-audio")
		return {
			edge,
			status: "no-audio",
			windowStartSec: Math.max(0, edge.timeSec - EDGE_CONTEXT_SEC),
			bucketsDbFs: [],
			tailDbFs: null,
			postDbFs: null,
			deltaDb: null,
			clipped: false,
		};
	const audio = decode.audio;
	const rms = pcmRmsBuckets(audio.pcm);
	const center = (i: number) => audio.startSec + (i + 0.5) * RMS_WINDOW_SEC;
	const tail = rms.filter(
		(_, i) => center(i) >= edge.timeSec - WORD_TAIL_SEC && center(i) < edge.timeSec,
	);
	const post = rms.filter(
		(_, i) => center(i) >= edge.timeSec && center(i) <= edge.timeSec + POST_CUT_SEC + 1e-9,
	);
	const tailDbFs = bucketLevelDbFs(tail);
	const postDbFs = bucketLevelDbFs(post);
	if (tailDbFs === null || postDbFs === null)
		return {
			edge,
			status: "no-audio",
			windowStartSec: audio.startSec,
			bucketsDbFs: rms.map((v) => round1(rmsToDbFs(v))),
			tailDbFs,
			postDbFs,
			deltaDb: null,
			clipped: false,
		};
	const clipped = isClippedWord(tailDbFs, postDbFs, toleranceDb, floorDbFs);
	return {
		edge,
		status: "ok",
		windowStartSec: audio.startSec,
		bucketsDbFs: rms.map((v) => round1(rmsToDbFs(v))),
		tailDbFs: round1(tailDbFs),
		postDbFs: round1(postDbFs),
		deltaDb: round1(postDbFs - tailDbFs),
		clipped,
	};
}

function clippedWordFinding(analysis: CutAudioAnalysis): ContentFinding {
	const at = analysis.edge.timeSec;
	// The wiring labels edges `in:<clip>` / `out:<clip>`; say which side it is.
	const side = analysis.edge.label?.startsWith("in:") ? "In point" : "Out point";
	return {
		rule: "cut.clipped-word",
		severity: "error",
		at,
		...(analysis.edge.label ? { label: analysis.edge.label } : {}),
		// RMS continuity is evidence, not proof of a clipped word: name the
		// measurement and let the agent listen before re-cutting.
		message: `${side} ${at.toFixed(3)}s is consistent with clipped speech: the level 0–120 ms after the edge (${
			analysis.postDbFs
		} dBFS) stays within ${Math.abs(analysis.deltaDb ?? 0).toFixed(1)} dB of the word tail (${
			analysis.tailDbFs
		} dBFS). Listen at the edge or read the filmstrip before re-cutting.`,
		evidence: {
			tailDbFs: analysis.tailDbFs ?? Number.NaN,
			postDbFs: analysis.postDbFs ?? Number.NaN,
			deltaDb: analysis.deltaDb ?? Number.NaN,
			windowStartSec: analysis.windowStartSec,
		},
	};
}

function assertMediaPath(mediaPath: string) {
	if (!path.isAbsolute(mediaPath))
		throw new Error("VERIFY_MEDIA_INVALID: Expected an absolute path.");
	if (!fs.statSync(mediaPath, { throwIfNoEntry: false })?.isFile())
		throw new Error("VERIFY_MEDIA_INVALID: Expected an existing file.");
}

function assertEdges(edges: readonly ContentVerifyEdge[]) {
	for (const edge of edges)
		if (!Number.isFinite(edge.timeSec) || edge.timeSec < 0)
			throw new Error("VERIFY_EDGE_INVALID: Edge times must be finite, non-negative seconds.");
}

/**
 * Clipped-word analysis for cut out points. Cut edges only; pass overlay edges
 * to `sampleFramesAtEdges`. The audio provenance (`options.audio.role`) is
 * validated against the file's stream list first: a verified-absent track comes
 * back `no-audio`, an unusable decoder or a missing role track comes back
 * `unavailable` with the reason — never a silent fall-back to track 0.
 */
export function analyzeCutEdges(
	mediaPath: string,
	edges: readonly ContentVerifyEdge[],
	options: CutAnalysisOptions,
): {
	status: "ok" | "ffmpeg-missing";
	findings: ContentFinding[];
	analyses: CutAudioAnalysis[];
	audioTrack: AudioTrackReport | null;
} {
	assertMediaPath(mediaPath);
	assertEdges(edges);
	const ffmpeg = options.ffmpeg === undefined ? resolveFfmpeg() : options.ffmpeg;
	if (!ffmpeg) return { status: "ffmpeg-missing", findings: [], analyses: [], audioTrack: null };
	const track = planAudioTrack(ffmpeg, mediaPath, options.audio.role);
	const toleranceDb = options.toleranceDb ?? CLIPPED_WORD_TOLERANCE_DB;
	const floorDbFs = options.floorDbFs ?? TAIL_SPEECH_FLOOR_DBFS;
	const analyses = edges.map((edge) =>
		analyzeDecodedEdge(
			edge,
			track.forced ?? decodeEdgeContext(ffmpeg, mediaPath, edge.timeSec, track.mapArgs),
			toleranceDb,
			floorDbFs,
		),
	);
	return {
		status: "ok",
		analyses,
		findings: analyses.filter((a) => a.clipped).map(clippedWordFinding),
		audioTrack: track.report,
	};
}

function lumaStats(rgb: Buffer): { meanLuma: number; maxLuma: number } {
	let sum = 0;
	let max = 0;
	for (let i = 0; i + 2 < rgb.length; i += 3) {
		const luma = (0.299 * rgb[i] + 0.587 * rgb[i + 1] + 0.114 * rgb[i + 2]) / 255;
		sum += luma;
		if (luma > max) max = luma;
	}
	const pixels = Math.max(1, Math.floor(rgb.length / 3));
	return { meanLuma: sum / pixels, maxLuma: max };
}

function sampleFrame(
	ffmpeg: string,
	mediaPath: string,
	edge: ContentVerifyEdge,
	pngPath: string,
): SampledFrame {
	const at = edge.timeSec.toFixed(3);
	const stats = runFfmpeg(ffmpeg, [
		"-ss",
		at,
		"-i",
		mediaPath,
		"-frames:v",
		"1",
		"-vf",
		`scale=${STATS_WIDTH}:${STATS_HEIGHT}`,
		"-f",
		"rawvideo",
		"-pix_fmt",
		"rgb24",
		"-",
	]);
	if (stats.error || stats.status !== 0 || !stats.stdout?.length)
		return { edge, status: "no-video", path: null, meanLuma: null, maxLuma: null, hash: null };
	runFfmpeg(ffmpeg, [
		"-ss",
		at,
		"-i",
		mediaPath,
		"-frames:v",
		"1",
		"-vf",
		`scale=${FRAME_WIDTH}:${FRAME_HEIGHT}:force_original_aspect_ratio=decrease,pad=${FRAME_WIDTH}:${FRAME_HEIGHT}:(ow-iw)/2:(oh-ih)/2`,
		"-y",
		pngPath,
	]);
	const { meanLuma, maxLuma } = lumaStats(stats.stdout);
	return {
		edge,
		status: "ok",
		path: fs.existsSync(pngPath) ? pngPath : null,
		meanLuma,
		maxLuma,
		hash: createHash("sha1").update(stats.stdout).digest("hex"),
	};
}

/**
 * Real frame at each edge (cuts and overlay boundaries), plus `frame.black`
 * and `frame.identical` warnings. Frames land in `directory` as PNGs sized for
 * the filmstrip; the caller owns the directory.
 */
export function sampleFramesAtEdges(
	mediaPath: string,
	edges: readonly ContentVerifyEdge[],
	directory: string,
	options: ContentVerifyOptions = {},
): { status: "ok" | "ffmpeg-missing"; findings: ContentFinding[]; frames: SampledFrame[] } {
	assertMediaPath(mediaPath);
	assertEdges(edges);
	if (!path.isAbsolute(directory)) throw new Error("VERIFY_OUTPUT_INVALID: Use an absolute path.");
	const ffmpeg = options.ffmpeg === undefined ? resolveFfmpeg() : options.ffmpeg;
	if (!ffmpeg) return { status: "ffmpeg-missing", findings: [], frames: [] };
	fs.mkdirSync(directory, { recursive: true });
	const frames = edges.map((edge, i) =>
		sampleFrame(
			ffmpeg,
			mediaPath,
			edge,
			path.join(directory, `frame-${i}-${Math.round(edge.timeSec * 1000)}ms.png`),
		),
	);
	const findings: ContentFinding[] = [];
	let previous: SampledFrame | null = null;
	for (const frame of frames) {
		if (frame.status !== "ok") continue;
		const at = frame.edge.timeSec;
		const label = frame.edge.label ? { label: frame.edge.label } : {};
		if (
			frame.meanLuma !== null &&
			frame.meanLuma < BLACK_MEAN_LUMA &&
			(frame.maxLuma ?? 1) < BLACK_MAX_LUMA
		)
			findings.push({
				rule: "frame.black",
				severity: "warning",
				at,
				...label,
				message: `Frame at ${at.toFixed(3)}s is black (mean luma ${frame.meanLuma.toFixed(3)}).`,
				evidence: {
					meanLuma: round1(frame.meanLuma * 1000) / 1000,
					maxLuma: round1((frame.maxLuma ?? 0) * 1000) / 1000,
				},
			});
		if (previous?.hash && previous.hash === frame.hash)
			findings.push({
				rule: "frame.identical",
				severity: "warning",
				at,
				...label,
				message: `Frame at ${at.toFixed(3)}s is identical to the frame at ${previous.edge.timeSec.toFixed(3)}s; the picture does not change across the edge.`,
				evidence: { hash: frame.hash ?? "", previousTimeSec: previous.edge.timeSec },
			});
		previous = frame;
	}
	return { status: "ok", findings, frames };
}

const CRC_TABLE = (() => {
	const table = new Int32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c;
	}
	return table;
})();

function crc32(buffer: Buffer): number {
	let c = -1;
	for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
	return (c ^ -1) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body));
	return Buffer.concat([length, body, crc]);
}

/**
 * Minimal RGB PNG writer. The waveform strips are rendered from the PCM the
 * detector itself measured — a hand-rolled encoder keeps the strip honest
 * (the picture IS the evidence) and avoids a second audio decode per edge via
 * ffmpeg's showwavespic.
 */
export function encodePngRgb(width: number, height: number, rgb: Buffer): Buffer {
	if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1)
		throw new Error("VERIFY_IMAGE_INVALID: Width and height must be positive integers.");
	if (rgb.length !== width * height * 3)
		throw new Error("VERIFY_IMAGE_INVALID: RGB buffer size does not match dimensions.");
	const stride = width * 3 + 1;
	const raw = Buffer.alloc(stride * height);
	for (let y = 0; y < height; y++)
		rgb.copy(raw, y * stride + 1, y * width * 3, (y + 1) * width * 3);
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 2; // colour type: truecolour RGB
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk("IHDR", ihdr),
		pngChunk("IDAT", deflateSync(raw, { level: 9 })),
		pngChunk("IEND", Buffer.alloc(0)),
	]);
}

export interface WaveformRenderOptions {
	width?: number;
	height?: number;
	/** Media time of pcm sample 0. */
	startSec: number;
	/** Cut position — drawn as a red line. */
	markSec: number;
	/** Length of the post-cut danger zone highlighted after the mark. */
	highlightSec?: number;
}

const WAVE_BACKGROUND: readonly [number, number, number] = [15, 17, 21];
const WAVE_BAR: readonly [number, number, number] = [148, 163, 184];
const WAVE_BAR_POST: readonly [number, number, number] = [250, 204, 21];
const WAVE_MARK: readonly [number, number, number] = [248, 113, 113];

/** Waveform strip for one edge: dBFS-mapped symmetric bars, red line at the cut. */
export function renderWaveformStrip(pcm: Buffer, options: WaveformRenderOptions): Buffer {
	const width = options.width ?? WAVE_WIDTH;
	const height = options.height ?? WAVE_HEIGHT;
	if (!Number.isInteger(width) || !Number.isInteger(height) || width < 8 || height < 8)
		throw new Error("VERIFY_IMAGE_INVALID: Waveform strip must be at least 8x8.");
	const rgb = Buffer.alloc(width * height * 3);
	const fill = (x: number, y: number, color: readonly [number, number, number]) => {
		const offset = (y * width + x) * 3;
		rgb[offset] = color[0];
		rgb[offset + 1] = color[1];
		rgb[offset + 2] = color[2];
	};
	for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) fill(x, y, WAVE_BACKGROUND);
	const samples = Math.floor(pcm.length / 2);
	const durationSec = samples / PCM_RATE;
	const highlightSec = options.highlightSec ?? POST_CUT_SEC;
	const mid = Math.floor(height / 2);
	for (let x = 0; x < width; x++) {
		const from = Math.floor((x / width) * samples);
		const to = Math.max(from + 1, Math.floor(((x + 1) / width) * samples));
		let sum = 0;
		for (let i = from; i < to; i++) {
			const value = pcm.readInt16LE(i * 2) / 32768;
			sum += value * value;
		}
		const dbFs = rmsToDbFs(Math.sqrt(sum / (to - from)));
		const magnitude = Math.min(1, Math.max(0, (dbFs - WAVE_FLOOR_DBFS) / -WAVE_FLOOR_DBFS));
		const rows = Math.max(1, Math.round(magnitude * (mid - 2)));
		const columnTimeSec = options.startSec + ((x + 0.5) / width) * durationSec;
		const inPost =
			columnTimeSec >= options.markSec && columnTimeSec <= options.markSec + highlightSec;
		const color = inPost ? WAVE_BAR_POST : WAVE_BAR;
		for (let dy = -rows; dy <= rows; dy++) {
			const y = mid + dy;
			if (y >= 0 && y < height) fill(x, y, color);
		}
	}
	if (durationSec > 0) {
		const markX = Math.round(((options.markSec - options.startSec) / durationSec) * width - 0.5);
		if (markX >= 0 && markX < width) for (let y = 0; y < height; y++) fill(markX, y, WAVE_MARK);
	}
	return encodePngRgb(width, height, rgb);
}

/** One column per edge: frame on top, its local waveform underneath. */
function composeFilmstrip(
	ffmpeg: string,
	columns: readonly { framePath: string; wavePath: string }[],
	outPath: string,
) {
	const inputs = columns.flatMap((column) => ["-i", column.framePath, "-i", column.wavePath]);
	// tile(1) takes one sequence input, so columns are padded and joined with
	// hstack instead; every column is the same size, which hstack requires.
	const stacks = columns.map(
		(_, i) => `[${2 * i}:v][${2 * i + 1}:v]vstack=inputs=2,pad=iw+8:ih+16:4:8[c${i}]`,
	);
	let filter: string;
	if (columns.length === 1) {
		filter = stacks[0].replace("[c0]", "[out]");
	} else {
		const joins: string[] = [];
		for (let i = 1; i < columns.length; i++) {
			const left = i === 1 ? "[c0]" : `[h${i - 1}]`;
			const right = i === columns.length - 1 ? "[out]" : `[h${i}]`;
			joins.push(`${left}[c${i}]hstack=inputs=2${right}`);
		}
		filter = [...stacks, ...joins].join(";");
	}
	const result = runFfmpeg(ffmpeg, [
		...inputs,
		"-filter_complex",
		filter,
		"-map",
		"[out]",
		"-frames:v",
		"1",
		"-y",
		outPath,
	]);
	if (result.error || result.status !== 0 || !fs.existsSync(outPath))
		throw new Error(
			`VERIFY_FILMSTRIP_FAILED: ${result.error?.message ?? result.stderr?.toString().trim() ?? "no output"}`,
		);
}

/**
 * The phase-6 detector in one call: clipped-word audio analysis on cut edges,
 * frame sampling on every edge, and a filmstrip (frame over local waveform per
 * column) when `outDirectory` is set. Structured findings only — gating is the
 * caller's decision, and validation on positive/negative fixtures lives in the
 * colocated test.
 */
export function verifyContentAtEdges(
	mediaPath: string,
	edges: readonly ContentVerifyEdge[],
	options: CutAnalysisOptions,
): ContentVerifyResult {
	assertMediaPath(mediaPath);
	assertEdges(edges);
	const ffmpeg = options.ffmpeg === undefined ? resolveFfmpeg() : options.ffmpeg;
	if (!ffmpeg)
		return {
			status: "ffmpeg-missing",
			findings: [],
			analyses: [],
			frames: [],
			filmstrip: null,
			audioTrack: null,
		};
	const toleranceDb = options.toleranceDb ?? CLIPPED_WORD_TOLERANCE_DB;
	const floorDbFs = options.floorDbFs ?? TAIL_SPEECH_FLOOR_DBFS;
	const track = planAudioTrack(ffmpeg, mediaPath, options.audio.role);
	const decoded = edges.map(
		(edge) => track.forced ?? decodeEdgeContext(ffmpeg, mediaPath, edge.timeSec, track.mapArgs),
	);
	const analyses = edges
		.map((edge, i) => ({ edge, decode: decoded[i] }))
		.filter(({ edge }) => (edge.kind ?? "cut") === "cut")
		.map(({ edge, decode }) => analyzeDecodedEdge(edge, decode, toleranceDb, floorDbFs));
	const findings: ContentFinding[] = analyses.filter((a) => a.clipped).map(clippedWordFinding);
	let frames: SampledFrame[] = [];
	let filmstrip: string | null = null;
	if (options.outDirectory) {
		if (!path.isAbsolute(options.outDirectory))
			throw new Error("VERIFY_OUTPUT_INVALID: Use an absolute path.");
		const sampled = sampleFramesAtEdges(mediaPath, edges, options.outDirectory, {
			...options,
			ffmpeg,
		});
		frames = sampled.frames;
		findings.push(...sampled.findings);
		const silence = { pcm: Buffer.alloc(0), startSec: 0 };
		const columns = frames
			.map((frame, i) => {
				const decode = decoded[i];
				return { frame, audio: decode?.status === "ok" ? decode.audio : silence };
			})
			.filter(
				(column): column is { frame: SampledFrame & { path: string }; audio: EdgeAudio } =>
					column.frame.path !== null,
			)
			.map((column) => {
				const audio = column.audio.pcm.length
					? column.audio
					: {
							pcm: Buffer.alloc(0),
							startSec: Math.max(0, column.frame.edge.timeSec - EDGE_CONTEXT_SEC),
						};
				const wavePath = path.join(
					options.outDirectory!,
					`wave-${Math.round(column.frame.edge.timeSec * 1000)}ms.png`,
				);
				fs.writeFileSync(
					wavePath,
					renderWaveformStrip(audio.pcm, {
						startSec: audio.startSec,
						markSec: column.frame.edge.timeSec,
					}),
				);
				return { framePath: column.frame.path, wavePath };
			});
		if (columns.length) {
			filmstrip = path.join(options.outDirectory, "filmstrip.png");
			composeFilmstrip(ffmpeg, columns, filmstrip);
		}
	}
	return { status: "ok", findings, analyses, frames, filmstrip, audioTrack: track.report };
}
