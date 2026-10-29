import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * Manages the lifetime of the on-disk model artifact used by the STT stack.
 *
 * The model is a single GGML file downloaded from HuggingFace
 * (`ggerganov/whisper.cpp` — the model-file repo predates and is separate
 * from the `ggml-org` GitHub org the engine itself now lives under;
 * `ggml-org/whisper.cpp` on HuggingFace is a different, access-gated repo
 * and returns 401 on every file including README.md — confirmed by curl).
 * whisper.cpp bakes precision into the file, so
 * there is no runtime `--int8` flag; OpenScreen ships the q8_0 quantized
 * `small` multilingual model by default.
 *
 * The file is verified by SHA-256 and written atomically (via .partial rename)
 * to prevent partial downloads from being treated as complete.
 *
 * Word timestamps come from whisper.cpp's native DTW token timestamps. The
 * separate sub-megabyte Silero model supplies speech probabilities for the
 * editor's Shorten Pauses workflow; it is downloaded only when Speech mode is
 * used and is not required for captions.
 */

/** `parakeet-v3` is the Core ML export (macOS); `parakeet-v3-onnx` is the same model for sherpa-onnx (Linux). */
export type SttModelId = "parakeet-v3" | "parakeet-v3-onnx" | "whisper" | "silero-vad";

export interface SttModelFile {
	/** Relative path within the model directory (e.g. "ggml-small-q8_0.bin"). */
	name: string;
	/** HuggingFace resolve URL for this file. */
	url: string;
	/** Expected SHA-256 hex digest; null to skip verification. */
	expectedSha256: string | null;
	/** Approximate download size in bytes (for progress reporting). */
	approximateBytes: number;
}

export interface SttModelDescriptor {
	/** Display + cache directory name. */
	cacheDir: string;
	/** HuggingFace repo identifier (e.g. "ggerganov/whisper.cpp"). */
	repoId: string;
	/** Immutable upstream revision used by every artifact URL. */
	revision: string;
	/** List of model files to download (currently a single GGML file). */
	files: SttModelFile[];
}

const MODEL_BASE = "https://huggingface.co";
// ponytail: this is deliberately NOT "ggml-org/whisper.cpp" — that HF repo
// (matching the GitHub org the engine now lives under) is access-gated and
// returns 401 Unauthorized on every file, confirmed by curl. whisper.cpp's
// own models/download-ggml-model.sh pulls from ggerganov/whisper.cpp, the
// long-standing public model-file repo that never moved when the engine's
// GitHub org was renamed.
const MODEL_REPO = "ggerganov/whisper.cpp";
const MODEL_FILE = "ggml-small-q8_0.bin";
// Pinned to a commit rather than `main` so `expectedSha256` is an invariant and
// not a bet: `main` is a mutable branch pointer, and a re-upload under it would
// now invalidate every cache in the field at once instead of merely breaking new
// installs. This revision was checked against HuggingFace's paths-info API — its
// LFS oid for MODEL_FILE is exactly the digest below.
const MODEL_REVISION = "5359861c739e955e79d9a303bcbc70fb988958b1";
const VAD_REPO = "ggml-org/whisper-vad";
const VAD_FILE = "ggml-silero-v6.2.0.bin";
const VAD_REVISION = "9ffd54a1e1ee413ddf265af9913beaf518d1639b";
const PARAKEET_REPO = "FluidInference/parakeet-tdt-0.6b-v3-coreml";
const PARAKEET_REVISION = "7dd20fe6b1797d35f5e3307e8b1732d9a178edfe";
// The k2-fsa INT8 ONNX export of the same Parakeet TDT 0.6B v3, which the Linux helper
// (electron/native/parakeet-linux) runs on the CPU. Digests checked against this revision.
const PARAKEET_ONNX_REPO = "csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8";
const PARAKEET_ONNX_REVISION = "2bda32ec70b097a55adaa07d9a7173915b43cc78";

function parakeetOnnxFile(
	name: string,
	expectedSha256: string,
	approximateBytes: number,
): SttModelFile {
	return {
		name,
		url: `${MODEL_BASE}/${PARAKEET_ONNX_REPO}/resolve/${PARAKEET_ONNX_REVISION}/${name}`,
		expectedSha256,
		approximateBytes,
	};
}

function parakeetFile(
	name: string,
	expectedSha256: string,
	approximateBytes: number,
): SttModelFile {
	return {
		name,
		url: `${MODEL_BASE}/${PARAKEET_REPO}/resolve/${PARAKEET_REVISION}/${name}`,
		expectedSha256,
		approximateBytes,
	};
}

export const STT_MODELS: Record<SttModelId, SttModelDescriptor> = {
	"parakeet-v3": {
		cacheDir: "parakeet-tdt-0.6b-v3",
		repoId: PARAKEET_REPO,
		revision: PARAKEET_REVISION,
		// Only the INT8 runtime files FluidAudio 0.15.6 loads. The upstream
		// snapshot also contains INT4, source mlpackages, and older joint graphs;
		// downloading those would add more than 2 GB that Klippt never opens.
		files: [
			parakeetFile(
				"Preprocessor.mlmodelc/analytics/coremldata.bin",
				"c9beeb989c8d66f8be11df59bc6df277ec76cee404f6865b46243835ef562f6d",
				243,
			),
			parakeetFile(
				"Preprocessor.mlmodelc/coremldata.bin",
				"dbde3f2300842c1fd51ef3ff948a0bcffe65ffd2dca10707f2509f32c1d65b1d",
				486,
			),
			parakeetFile(
				"Preprocessor.mlmodelc/metadata.json",
				"2a98699e22d279dd37fa1d238aeb1c6db1df0d6fad687775324157689d8f3acf",
				2_841,
			),
			parakeetFile(
				"Preprocessor.mlmodelc/model.mil",
				"4b8518a956450fec57f06c2a21bdffc26973f7f1fa6842fb38fe917f896b6b93",
				28_181,
			),
			parakeetFile(
				"Preprocessor.mlmodelc/weights/weight.bin",
				"129b76e3aeafa8afa3ea76d995b964b145fe83700d579f6ff42c4c38fa0968ea",
				491_072,
			),
			parakeetFile(
				"Encoder.mlmodelc/analytics/coremldata.bin",
				"42e638870d73f26b332918a3496ce36793fbb413a81cbd3d16ba01328637a105",
				243,
			),
			parakeetFile(
				"Encoder.mlmodelc/coremldata.bin",
				"d48034a167a82e88fc3df64f60af963ab3983538271175b8319e7d5720a0fb86",
				485,
			),
			parakeetFile(
				"Encoder.mlmodelc/metadata.json",
				"da24da9cca943fb29d7fa8e376d57fca7cb3aa08ca51b956b0b0e56813f087e9",
				2_921,
			),
			parakeetFile(
				"Encoder.mlmodelc/model.mil",
				"ed7b19156ca29fa7dfd6891deb9fda4b0e8893f68597c985d135736546a43808",
				959_769,
			),
			parakeetFile(
				"Encoder.mlmodelc/weights/weight.bin",
				"e2020f323703477a5b21d7c2d282c403e371afb5962e79877e3033e73ba6f421",
				445_187_200,
			),
			parakeetFile(
				"Decoder.mlmodelc/analytics/coremldata.bin",
				"4238c4e81ecd0dc94bd7dfbb60f7e2cc824107c1ffe0387b8607b72833dba350",
				243,
			),
			parakeetFile(
				"Decoder.mlmodelc/coremldata.bin",
				"18647af085d87bd8f3121c8a9b4d4564c1ede038dab63d295b4e745cf2d7fb99",
				554,
			),
			parakeetFile(
				"Decoder.mlmodelc/metadata.json",
				"a39e93cd8371b8ded92635c7804fcd0590f0d1dd9415c6d19a0484be073077d9",
				3_427,
			),
			parakeetFile(
				"Decoder.mlmodelc/model.mil",
				"ef2a0a281695398a62fde86ac269c68f73d5b578d7ed3b31f2ba91a2d1ea1f35",
				13_110,
			),
			parakeetFile(
				"Decoder.mlmodelc/weights/weight.bin",
				"48adf0f0d47c406c8253d4f7fef967436a39da14f5a65e66d5a4b407be355d41",
				23_604_992,
			),
			parakeetFile(
				"JointDecisionv3.mlmodelc/analytics/coremldata.bin",
				"26def4bf73dd56d29dee21c8ef97cb8969e62f6120ed1adc91e46828e2737b6c",
				243,
			),
			parakeetFile(
				"JointDecisionv3.mlmodelc/coremldata.bin",
				"f5fc08b741400f0088492c9e839418b1e18522f19cba28d361dd030c5f398342",
				521,
			),
			parakeetFile(
				"JointDecisionv3.mlmodelc/metadata.json",
				"d9307211b9a37e0f0ac260c7660b1571a3de25841035cfdf9b58fd40425f890f",
				3_453,
			),
			parakeetFile(
				"JointDecisionv3.mlmodelc/model.mil",
				"be60732943389a047175111a83f8839f3eb39d4803adafa828a0871b2f39818d",
				11_775,
			),
			parakeetFile(
				"JointDecisionv3.mlmodelc/weights/weight.bin",
				"4e0e63d840032f7f07ddb1d64446051166281e5491bf22da8a945c41f6eedb3e",
				12_642_764,
			),
			parakeetFile(
				"parakeet_vocab.json",
				"7ec60e05f1b24480736ec0eed40900f4626bce1fa9a60fd700ec7e2a59198735",
				151_122,
			),
		],
	},
	"parakeet-v3-onnx": {
		cacheDir: "parakeet-tdt-0.6b-v3-onnx",
		repoId: PARAKEET_ONNX_REPO,
		revision: PARAKEET_ONNX_REVISION,
		files: [
			parakeetOnnxFile(
				"tokens.txt",
				"d58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d",
				93_939,
			),
			parakeetOnnxFile(
				"decoder.int8.onnx",
				"179e50c43d1a9de79c8a24149a2f9bac6eb5981823f2a2ed88d655b24248db4e",
				11_845_275,
			),
			parakeetOnnxFile(
				"joiner.int8.onnx",
				"3164c13fc2821009440d20fcb5fdc78bff28b4db2f8d0f0b329101719c0948b3",
				6_355_277,
			),
			parakeetOnnxFile(
				"encoder.int8.onnx",
				"acfc2b4456377e15d04f0243af540b7fe7c992f8d898d751cf134c3a55fd2247",
				652_184_281,
			),
		],
	},
	whisper: {
		cacheDir: "whisper-ggml",
		repoId: MODEL_REPO,
		revision: MODEL_REVISION,
		files: [
			{
				name: MODEL_FILE,
				url: `${MODEL_BASE}/${MODEL_REPO}/resolve/${MODEL_REVISION}/${MODEL_FILE}`,
				expectedSha256: "49C8FB02B65E6049D5FA6C04F81F53B867B5EC9540406812C643F177317F779F",
				approximateBytes: 264_000_000,
			},
		],
	},
	"silero-vad": {
		cacheDir: "silero-vad",
		repoId: VAD_REPO,
		revision: VAD_REVISION,
		files: [
			{
				name: VAD_FILE,
				url: `${MODEL_BASE}/${VAD_REPO}/resolve/${VAD_REVISION}/${VAD_FILE}`,
				expectedSha256: "2AA269B785EEB53A82983A20501DDF7C1D9C48E33AB63A41391AC6C9F7FB6987",
				approximateBytes: 885_098,
			},
		],
	},
};

export function modelPaths(baseDir: string): Record<SttModelId, string> {
	return {
		"parakeet-v3": path.join(baseDir, STT_MODELS["parakeet-v3"].cacheDir),
		"parakeet-v3-onnx": path.join(baseDir, STT_MODELS["parakeet-v3-onnx"].cacheDir),
		whisper: path.join(baseDir, STT_MODELS.whisper.cacheDir, MODEL_FILE),
		"silero-vad": path.join(baseDir, STT_MODELS["silero-vad"].cacheDir, VAD_FILE),
	};
}

/**
 * True when the GGML model file exists and is non-empty.
 */
export async function areModelsPresent(baseDir: string): Promise<boolean> {
	const paths = modelPaths(baseDir);
	try {
		const s = await stat(paths.whisper);
		return s.isFile() && s.size > 0;
	} catch {
		return false;
	}
}

/** Hash a file as a bounded stream. Cancellation destroys the read immediately. */
export async function sha256OfFile(filePath: string, signal?: AbortSignal): Promise<string> {
	if (signal?.aborted) throw signal.reason;
	return await new Promise<string>((resolve, reject) => {
		const hash = createHash("sha256");
		const input = createReadStream(filePath, { highWaterMark: 1024 * 1024 });
		let settled = false;
		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			fn();
		};
		const onAbort = () => input.destroy(signal?.reason);
		signal?.addEventListener("abort", onAbort, { once: true });
		input.on("data", (chunk) => {
			hash.update(chunk);
		});
		input.once("error", (error) => finish(() => reject(error)));
		input.once("end", () => finish(() => resolve(hash.digest("hex"))));
	});
}

const MAX_ATTEMPTS = 6;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt: number, retryAfter: string | null): number {
	if (retryAfter) {
		const secs = Number(retryAfter);
		if (Number.isFinite(secs)) return Math.min(60_000, secs * 1000);
		const at = Date.parse(retryAfter);
		if (!Number.isNaN(at)) return Math.min(60_000, Math.max(0, at - Date.now()));
	}
	return Math.min(60_000, 2_000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 1000);
}

async function fetchWithRetry(url: string, fetcher: typeof fetch): Promise<Response> {
	let lastErr: unknown;
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		try {
			const res = await fetcher(url, {
				headers: { "user-agent": "klippt-stt" },
			});
			if (res.ok && res.body) return res;
			if (res.status >= 400 && res.status < 500 && !RETRYABLE_STATUS.has(res.status)) {
				throw new Error(`Failed to download ${url}: HTTP ${res.status} ${res.statusText}`);
			}
			if (RETRYABLE_STATUS.has(res.status) && attempt < MAX_ATTEMPTS) {
				await sleep(backoffMs(attempt, res.headers.get("retry-after")));
				continue;
			}
			throw new Error(`Failed to download ${url}: HTTP ${res.status} ${res.statusText}`);
		} catch (err) {
			lastErr = err;
			if (err instanceof Error && err.message.startsWith("Failed to download")) {
				throw err;
			}
			if (attempt >= MAX_ATTEMPTS) throw err;
			await sleep(backoffMs(attempt, null));
		}
	}
	throw lastErr;
}

export interface DownloadOptions {
	/** Called with cumulative bytes for progress reporting. */
	onProgress?: (bytes: number) => void;
	/** Override fetch (for tests); defaults to `globalThis.fetch`. */
	fetcher?: typeof fetch;
}

/**
 * Stream a model file to disk atomically (<filename>.partial → rename on
 * success), optionally verify the SHA-256.
 *
 * If the file already exists, is non-empty, and matches the expected hash,
 * skips the download; otherwise a replacement is fetched and the stale copy is
 * only displaced once that replacement has itself been verified.
 */
async function ensureFile(
	filePath: string,
	fileUrl: string,
	expectedSha256: string | null,
	options: DownloadOptions = {},
): Promise<void> {
	if (existsSync(filePath)) {
		const s = await stat(filePath);
		if (s.isFile() && s.size > 0) {
			if (!expectedSha256) return;
			const actual = await sha256OfFile(filePath);
			if (actual.toLowerCase() === expectedSha256.toLowerCase()) return;
			// Deliberately leave the stale file where it is. Moving it aside now
			// would buy nothing — the rename at the end of this function is already
			// atomic, so there is no window to close — while costing the user their
			// only model if the replacement never lands (offline, HF 5xx, ENOSPC)
			// and stranding 264 MB that nothing ever cleans up.
		}
	}

	await mkdir(path.dirname(filePath), { recursive: true });

	const fetcher = options.fetcher ?? fetch;
	const res = await fetchWithRetry(fileUrl, fetcher);
	const tmp = `${filePath}.partial`;
	let downloaded = 0;

	const source = Readable.fromWeb(res.body as never);
	source.on("data", (chunk: Buffer | Uint8Array) => {
		downloaded += chunk.length;
		options.onProgress?.(downloaded);
	});
	const { createWriteStream } = await import("node:fs");
	await pipeline(source, createWriteStream(tmp));

	if (expectedSha256) {
		const actual = await sha256OfFile(tmp);
		if (actual.toLowerCase() !== expectedSha256.toLowerCase()) {
			// Drop the bad download and keep whatever was already on disk: when both
			// copies mismatch, the bytes the user has been running are exactly the
			// ones worth diagnosing. The cleanup is guarded because a Windows AV
			// scanner still holding the handle raises EPERM/EBUSY, and that bare
			// errno would escape in place of the mismatch message below.
			await rm(tmp, { force: true }).catch(() => undefined);
			throw new Error(
				`SHA-256 mismatch for ${path.basename(filePath)}: expected ${expectedSha256}, got ${actual}`,
			);
		}
	}
	await rename(tmp, filePath);
}

export interface EnsureModelsOptions {
	baseDir: string;
	/** Models to ensure; defaults to the cross-platform Whisper fallback. */
	only?: SttModelId[];
	onProgress?: (event: {
		id: SttModelId;
		file: string;
		downloadedBytes: number;
		totalBytes: number;
	}) => void;
	fetcher?: typeof fetch;
}

/** Ensure the selected model files are present locally; downloads with progress + retry. */
export async function ensureModels(opts: EnsureModelsOptions): Promise<void> {
	// Captions keep their existing default. The VAD model is opt-in so opening a
	// transcript never gains a second download as a side effect.
	const targets = (opts.only ?? (["whisper"] as SttModelId[])).map((id) => ({
		id,
		descriptor: STT_MODELS[id],
		filePath: modelPaths(opts.baseDir)[id],
	}));

	for (const { id, descriptor, filePath } of targets) {
		const modelRoot = descriptor.files.length === 1 ? path.dirname(filePath) : filePath;
		await mkdir(modelRoot, { recursive: true });
		const totalBytes = descriptor.files.reduce((sum, file) => sum + file.approximateBytes, 0);
		let completedBytes = 0;
		let lastReportedBytes = -4 * 1024 * 1024;

		for (const file of descriptor.files) {
			const targetPath = descriptor.files.length === 1 ? filePath : path.join(modelRoot, file.name);
			await ensureFile(targetPath, file.url, file.expectedSha256, {
				onProgress: (bytes) => {
					const aggregateBytes = completedBytes + bytes;
					// Network streams can produce tens of thousands of tiny chunks for
					// Parakeet's 425 MB encoder. The UI needs useful progress, not one
					// renderer event per chunk.
					if (aggregateBytes - lastReportedBytes < 4 * 1024 * 1024 && aggregateBytes < totalBytes) {
						return;
					}
					lastReportedBytes = aggregateBytes;
					opts.onProgress?.({
						id,
						file: file.name,
						downloadedBytes: aggregateBytes,
						totalBytes,
					});
				},
				fetcher: opts.fetcher,
			});
			completedBytes += file.approximateBytes;
		}
		opts.onProgress?.({
			id,
			file: descriptor.files.at(-1)?.name ?? "",
			downloadedBytes: totalBytes,
			totalBytes,
		});
	}
}
