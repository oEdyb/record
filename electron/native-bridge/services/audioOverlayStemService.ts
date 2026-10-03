import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { audioClipSchema } from "../../../src/lib/ai-edition/schema/audioOverlays";
import { toKlipptMediaUrl } from "../../../src/lib/localMediaUrl";

const overlaySchema = z
	.strictObject({
		id: audioClipSchema.shape.id,
		sourcePath: z.string().min(1).max(4096),
		startSec: audioClipSchema.shape.startSec,
		endSec: audioClipSchema.shape.endSec,
		sourceOffsetSec: audioClipSchema.shape.sourceOffsetSec,
		gain: audioClipSchema.shape.gain,
		fadeInSec: audioClipSchema.shape.fadeInSec,
		fadeOutSec: audioClipSchema.shape.fadeOutSec,
	})
	.superRefine((overlay, ctx) => {
		const { sourcePath: _sourcePath, ...clip } = overlay;
		const result = audioClipSchema.safeParse({ ...clip, assetId: "audio" });
		if (!result.success)
			for (const issue of result.error.issues)
				ctx.addIssue({ code: "custom", message: issue.message, path: issue.path });
		if (Math.round(overlay.endSec * 48_000) <= Math.round(overlay.startSec * 48_000))
			ctx.addIssue({ code: "custom", message: "Audio clip must contain a sample" });
		if (overlay.sourceOffsetSec + overlay.endSec - overlay.startSec > 10_800)
			ctx.addIssue({ code: "custom", message: "Audio source window exceeds limit" });
	});
const overlaysSchema = z
	.array(overlaySchema)
	.max(256)
	.superRefine((clips, ctx) => {
		if (new Set(clips.map((clip) => clip.id)).size !== clips.length)
			ctx.addIssue({ code: "custom", message: "Duplicate audio overlay ID" });
	});
const requestSchema = z.strictObject({
	audioOverlays: overlaysSchema,
	durationSec: z.number().finite().positive().max(10_800),
});
type Request = z.infer<typeof requestSchema>;
const CACHE_FILE = /^[a-f0-9]{64}\.wav$/;
const PARTIAL_FILE = /^\.audio-overlay-[a-f0-9-]{36}\.wav$/;
const MAX_CACHE_BYTES = 4 * 1024 ** 3;

export interface AudioOverlayStemServiceOptions {
	cacheDirectory: string;
	resolveSourcePath: (sourcePath: string) => string | null;
	approveOutputPath: (outputPath: string) => Promise<string | null>;
	renderStem: (requestJson: string, outputPath: string, jobId: string) => Promise<string>;
	maxCacheBytes?: number;
}

/** Serialized bounded cache. Only approved source files reach the native decoder. */
export class AudioOverlayStemService {
	private tail: Promise<void> = Promise.resolve();
	private readonly pending = new Map<string, Promise<AudioOverlayStemResult>>();
	constructor(private readonly options: AudioOverlayStemServiceOptions) {}

	/** Export uses this same path gate, but keeps scene serialization owned by its caller. */
	validateSceneSources(sceneJson?: string | null): void {
		if (!sceneJson) return;
		const scene: unknown = JSON.parse(sceneJson);
		if (!scene || typeof scene !== "object") throw new Error("Invalid scene");
		const overlays = overlaysSchema.parse((scene as Record<string, unknown>).audioOverlays ?? []);
		this.approveSources(overlays);
	}

	private approveSources(overlays: Request["audioOverlays"]) {
		return overlays.map((overlay) => {
			const sourcePath = this.options.resolveSourcePath(overlay.sourcePath);
			if (!sourcePath || !path.isAbsolute(sourcePath))
				throw new Error("Audio source has not been approved for this project");
			return { ...overlay, sourcePath };
		});
	}

	private async fingerprint(request: Request) {
		const sources = await Promise.all(
			request.audioOverlays.map(async (overlay) => {
				const realPath = await fs.realpath(overlay.sourcePath);
				if (!this.options.resolveSourcePath(realPath))
					throw new Error("Audio source no longer has approval");
				const stat = await fs.stat(realPath);
				if (!stat.isFile()) throw new Error("Audio source is not a regular file");
				return { path: realPath, size: stat.size, modifiedMs: stat.mtimeMs, inode: stat.ino };
			}),
		);
		return createHash("sha256")
			.update(JSON.stringify({ version: 1, request, sources }))
			.digest("hex");
	}

	async get(input: unknown): Promise<AudioOverlayStemResult> {
		const parsed = requestSchema.parse(input);
		const request = { ...parsed, audioOverlays: this.approveSources(parsed.audioOverlays) };
		const frames = Math.round(request.durationSec * 48_000);
		if (frames < 1) throw new Error("Audio preview must contain at least one sample");
		const bytes = 56 + frames * 8;
		if (bytes > (this.options.maxCacheBytes ?? MAX_CACHE_BYTES))
			throw new Error("Audio preview exceeds cache capacity");
		const key = await this.fingerprint(request);
		const pending = this.pending.get(key);
		if (pending) return pending;
		if (this.pending.size >= 8)
			throw new Error("Audio preview is busy; retry after current changes finish");
		const promise = this.tail.then(() => this.generate(request, key, bytes, frames));
		this.tail = promise.then(
			() => undefined,
			() => undefined,
		);
		this.pending.set(key, promise);
		try {
			return await promise;
		} finally {
			this.pending.delete(key);
		}
	}

	private async validWave(filePath: string, bytes: number) {
		let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
		try {
			if (!(await fs.lstat(filePath)).isFile()) return false;
			handle = await fs.open(filePath, "r");
			if ((await handle.stat()).size !== bytes) return false;
			const header = Buffer.alloc(56);
			if ((await handle.read(header, 0, 56, 0)).bytesRead !== 56) return false;
			return (
				header.toString("ascii", 0, 4) === "RIFF" &&
				header.readUInt32LE(4) === bytes - 8 &&
				header.toString("ascii", 8, 16) === "WAVEfmt " &&
				header.readUInt32LE(16) === 16 &&
				header.readUInt16LE(20) === 3 &&
				header.readUInt16LE(22) === 2 &&
				header.readUInt32LE(24) === 48_000 &&
				header.readUInt32LE(28) === 384_000 &&
				header.readUInt16LE(32) === 8 &&
				header.readUInt16LE(34) === 32 &&
				header.toString("ascii", 36, 40) === "fact" &&
				header.readUInt32LE(40) === 4 &&
				header.readUInt32LE(44) === (bytes - 56) / 8 &&
				header.toString("ascii", 48, 52) === "data" &&
				header.readUInt32LE(52) === bytes - 56
			);
		} catch {
			return false;
		} finally {
			await handle?.close();
		}
	}

	private async makeRoom(bytes: number) {
		const directory = this.options.cacheDirectory;
		const files: Array<{ filePath: string; size: number; modifiedMs: number }> = [];
		for (const name of await fs.readdir(directory)) {
			if (!CACHE_FILE.test(name) && !PARTIAL_FILE.test(name)) continue;
			const filePath = path.join(directory, name);
			const stat = await fs.lstat(filePath);
			if (!stat.isFile()) continue;
			if (PARTIAL_FILE.test(name)) {
				await fs.rm(filePath);
				continue;
			}
			files.push({ filePath, size: stat.size, modifiedMs: stat.mtimeMs });
		}
		let total = files.reduce((sum, file) => sum + file.size, 0);
		let count = files.length;
		for (const file of files.sort((a, b) => a.modifiedMs - b.modifiedMs)) {
			if (total + bytes <= (this.options.maxCacheBytes ?? MAX_CACHE_BYTES) && count < 32) break;
			await fs.rm(file.filePath);
			total -= file.size;
			count--;
		}
		if (total + bytes > (this.options.maxCacheBytes ?? MAX_CACHE_BYTES))
			throw new Error("Cannot reserve audio preview cache space");
	}

	private async generate(
		request: Request,
		key: string,
		bytes: number,
		frames: number,
	): Promise<AudioOverlayStemResult> {
		if ((await this.fingerprint(request)) !== key)
			throw new Error("Audio source changed; retry preview");
		await fs.mkdir(this.options.cacheDirectory, { recursive: true });
		const outputPath = path.join(this.options.cacheDirectory, `${key}.wav`);
		if (!(await this.validWave(outputPath, bytes))) {
			await fs.rm(outputPath, { force: true });
			await this.makeRoom(bytes);
			const temporaryPath = path.join(
				this.options.cacheDirectory,
				`.audio-overlay-${randomUUID()}.wav`,
			);
			try {
				const result: unknown = JSON.parse(
					await this.options.renderStem(
						JSON.stringify(request),
						temporaryPath,
						`audio-overlay-${randomUUID()}`,
					),
				);
				z.object({
					sampleRate: z.literal(48_000),
					channels: z.literal(2),
					frames: z.literal(frames),
					format: z.literal("float32-wav"),
				}).parse(result);
				if (!(await this.validWave(temporaryPath, bytes)))
					throw new Error("Native audio preview produced an invalid WAV");
				if ((await this.fingerprint(request)) !== key)
					throw new Error("Audio source changed during preview generation");
				await fs.rename(temporaryPath, outputPath);
			} finally {
				await fs.rm(temporaryPath, { force: true });
			}
		}
		const sourcePath = await this.options.approveOutputPath(outputPath);
		if (!sourcePath) throw new Error("Cannot approve generated audio preview");
		await fs.utimes(outputPath, new Date(), new Date());
		return {
			sourcePath,
			sourceUrl: toKlipptMediaUrl(sourcePath),
			cacheKey: key,
			durationSec: frames / 48_000,
		};
	}
}

export interface AudioOverlayStemResult {
	sourcePath: string;
	sourceUrl: string;
	cacheKey: string;
	durationSec: number;
}
