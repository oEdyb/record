import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AxcutDocument, CleanVoiceRecipe } from "../../src/lib/ai-edition/schema";
import { pruneCleanVoiceCacheAtStartup } from "./cleanVoiceCacheRetention";
import {
	CleanVoiceCancelledError,
	type CleanVoiceEngineIdentity,
	type CleanVoiceProcessor,
	readWaveInfo,
	sha256File,
} from "./cleanVoiceWorker";

const CACHE_VERSION = 2;
const EXTRACTION_VERSION = "isolated-qac-mono-f32-48k-v1";
const OUTPUT_FILE = "clean-microphone.wav";
const PREVIEW_FILE = "preview-audio.m4a";
const MANIFEST_FILE = "manifest.json";

type NaturalRecipe = Extract<CleanVoiceRecipe, { mode: "natural" }>;
export type CleanVoiceThermalState = "unknown" | "nominal" | "fair" | "serious" | "critical";
export type CleanVoiceJobPhase =
	| "queued"
	| "checking-cache"
	| "processing"
	| "ready"
	| "failed"
	| "cancelled";

export interface CleanVoiceJobStatus {
	projectId: string;
	assetId: string;
	phase: CleanVoiceJobPhase;
	message?: string;
	cleanMicrophonePath?: string;
	previewAudioPath?: string;
	cacheKey?: string;
}

export interface CleanVoiceResolvedStem {
	projectId: string;
	assetId: string;
	path: string;
	previewPath: string;
	cacheKey: string;
	recipe: NaturalRecipe;
}

interface DesiredJob {
	projectId: string;
	assetId: string;
	sourcePath: string;
	recipe: NaturalRecipe;
	signature: string;
}

interface ActiveJob {
	assetKey: string;
	signature: string;
	controller: AbortController;
}

interface SourceIdentity {
	resolvedPath: string;
	dev: string;
	ino: string;
	size: string;
	mtimeNs: string;
	ctimeNs: string;
}

interface CacheLink {
	version: 1;
	requestKey: string;
	cacheKey: string;
}

interface CacheManifest {
	version: 1;
	cacheKey: string;
	createdAt: string;
	extractionVersion: string;
	input: {
		rawSha256: string;
		sampleRate: number;
		sampleCount: number;
	};
	output: {
		file: typeof OUTPUT_FILE;
		sha256: string;
		sampleRate: number;
		sampleCount: number;
	};
	preview: {
		file: typeof PREVIEW_FILE;
		sha256: string;
		bytes: number;
	};
	engine: CleanVoiceEngineIdentity;
	recipe: NaturalRecipe;
	quality: {
		delaySamples: number;
		inputPeak: number;
		outputPeak: number;
		realTimeFactor: number;
	};
}

export interface CleanVoiceServiceOptions {
	cacheRoot: string;
	/** Only the GUI startup caller holding the single-instance lock may enable this. */
	pruneCompletedEntriesOnStartup?: boolean;
	processor: CleanVoiceProcessor;
	onStatus?: (status: CleanVoiceJobStatus) => void;
}

function jsonHash(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function assetKey(projectId: string, assetId: string): string {
	return `${projectId}\0${assetId}`;
}

function recipeIdentity(recipe: NaturalRecipe): string {
	return JSON.stringify({
		version: recipe.version,
		mode: recipe.mode,
		engine: recipe.engine,
		attenuationLimitDb: recipe.attenuationLimitDb,
		postFilter: recipe.postFilter,
	});
}

function sameEngine(a: CleanVoiceEngineIdentity, b: CleanVoiceEngineIdentity): boolean {
	return (
		a.id === b.id &&
		a.commit === b.commit &&
		a.modelSha256 === b.modelSha256 &&
		a.helperSha256 === b.helperSha256
	);
}

function isNaturalRecipe(recipe: CleanVoiceRecipe | undefined): recipe is NaturalRecipe {
	return recipe?.mode === "natural";
}

async function sourceIdentity(sourcePath: string): Promise<SourceIdentity> {
	const resolvedPath = path.resolve(sourcePath);
	const info = await fs.stat(resolvedPath, { bigint: true });
	if (!info.isFile()) throw new Error("Clean Voice source is not a file");
	return {
		resolvedPath,
		dev: info.dev.toString(),
		ino: info.ino.toString(),
		size: info.size.toString(),
		mtimeNs: info.mtimeNs.toString(),
		ctimeNs: info.ctimeNs.toString(),
	};
}

async function syncDirectory(directoryPath: string): Promise<void> {
	if (process.platform === "win32") return;
	const handle = await fs.open(directoryPath, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
	const directory = path.dirname(filePath);
	await fs.mkdir(directory, { recursive: true });
	const temporaryPath = path.join(
		directory,
		`.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
	);
	let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
	try {
		handle = await fs.open(temporaryPath, "wx", 0o600);
		await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
		await handle.sync();
		await handle.close();
		handle = null;
		await fs.rename(temporaryPath, filePath);
		await syncDirectory(directory);
	} catch (error) {
		await handle?.close().catch(() => undefined);
		await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
		throw error;
	}
}

function parseLink(value: unknown): CacheLink | null {
	if (!value || typeof value !== "object") return null;
	const link = value as Partial<CacheLink>;
	return link.version === 1 &&
		typeof link.requestKey === "string" &&
		/^[a-f0-9]{64}$/.test(link.requestKey) &&
		typeof link.cacheKey === "string" &&
		/^[a-f0-9]{64}$/.test(link.cacheKey)
		? (link as CacheLink)
		: null;
}

function parseManifest(value: unknown): CacheManifest | null {
	if (!value || typeof value !== "object") return null;
	const manifest = value as Partial<CacheManifest>;
	if (
		manifest.version !== 1 ||
		typeof manifest.cacheKey !== "string" ||
		manifest.extractionVersion !== EXTRACTION_VERSION ||
		!manifest.input ||
		!manifest.output ||
		!manifest.preview ||
		!manifest.engine ||
		!manifest.recipe ||
		!manifest.quality ||
		manifest.output.file !== OUTPUT_FILE ||
		manifest.preview.file !== PREVIEW_FILE
	) {
		return null;
	}
	return manifest as CacheManifest;
}

export class CleanVoiceService {
	private readonly entriesDir: string;
	private readonly linksDir: string;
	private readonly stagingDir: string;
	private readonly desired = new Map<string, DesiredJob>();
	private readonly pending: string[] = [];
	private readonly pendingSet = new Set<string>();
	private readonly failures = new Map<string, string>();
	private readonly statuses = new Map<string, CleanVoiceJobStatus>();
	private readonly resolved = new Map<string, CleanVoiceResolvedStem>();
	private readonly resolvedSignatures = new Map<string, string>();
	private readonly verifiedEntries = new Set<string>();
	private readonly projectGenerations = new Map<string, number>();
	private readonly ready: Promise<void>;
	private active: ActiveJob | null = null;
	private recordingActive = false;
	private thermalState: CleanVoiceThermalState = "unknown";
	private disposed = false;

	constructor(private readonly options: CleanVoiceServiceOptions) {
		this.entriesDir = path.join(options.cacheRoot, "entries");
		this.linksDir = path.join(options.cacheRoot, "links");
		this.stagingDir = path.join(options.cacheRoot, "staging");
		this.ready = this.recover();
	}

	async syncDocument(document: AxcutDocument): Promise<void> {
		const generation = (this.projectGenerations.get(document.project.id) ?? 0) + 1;
		this.projectGenerations.set(document.project.id, generation);
		const inspectionFailures: CleanVoiceJobStatus[] = [];
		const candidates = await Promise.all(
			document.assets.map(async (asset): Promise<DesiredJob | null> => {
				const recipe = asset.cleanVoice;
				if (!isNaturalRecipe(recipe)) return null;
				try {
					const source = await sourceIdentity(asset.originalPath);
					const signature = jsonHash({ source, recipe: recipeIdentity(recipe) });
					return {
						projectId: document.project.id,
						assetId: asset.id,
						sourcePath: source.resolvedPath,
						recipe,
						signature,
					};
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					console.warn(`[clean-voice] cannot inspect ${asset.id}: ${message}`);
					inspectionFailures.push({
						projectId: document.project.id,
						assetId: asset.id,
						phase: "failed",
						message,
					});
					return null;
				}
			}),
		);
		const next = candidates.filter((job): job is DesiredJob => job !== null);
		if (this.disposed || this.projectGenerations.get(document.project.id) !== generation) return;

		const nextKeys = new Set(next.map((job) => assetKey(job.projectId, job.assetId)));
		for (const [key, current] of this.desired) {
			if (current.projectId === document.project.id && !nextKeys.has(key)) this.removeDesired(key);
		}
		for (const status of inspectionFailures) this.publishStatus(status);
		for (const job of next) {
			const key = assetKey(job.projectId, job.assetId);
			const previous = this.desired.get(key);
			this.desired.set(key, job);
			if (previous?.signature !== job.signature) {
				this.failures.delete(key);
				this.resolved.delete(key);
				this.resolvedSignatures.delete(key);
				if (this.active?.assetKey === key) this.active.controller.abort();
			}
			this.enqueue(key);
		}
		void this.pump();
	}

	setRecordingActive(active: boolean): void {
		if (this.recordingActive === active || this.disposed) return;
		this.recordingActive = active;
		if (active) {
			this.active?.controller.abort();
			return;
		}
		this.enqueueAllDesired();
		void this.pump();
	}

	setThermalState(state: CleanVoiceThermalState): void {
		if (this.thermalState === state || this.disposed) return;
		this.thermalState = state;
		if (state === "serious" || state === "critical") {
			this.active?.controller.abort();
			return;
		}
		this.enqueueAllDesired();
		void this.pump();
	}

	getResolvedStem(projectId: string, assetId: string): CleanVoiceResolvedStem | null {
		return this.resolved.get(assetKey(projectId, assetId)) ?? null;
	}

	getStatuses(projectId: string, assetIds: string[]): CleanVoiceJobStatus[] {
		return assetIds.flatMap((assetId) => {
			const status = this.statuses.get(assetKey(projectId, assetId));
			return status ? [status] : [];
		});
	}

	dispose(): void {
		this.disposed = true;
		this.active?.controller.abort();
		this.pending.length = 0;
		this.pendingSet.clear();
		this.desired.clear();
	}

	private async recover(): Promise<void> {
		await Promise.all([
			fs.mkdir(this.entriesDir, { recursive: true }),
			fs.mkdir(this.linksDir, { recursive: true }),
			fs.mkdir(this.stagingDir, { recursive: true }),
		]);
		if (this.options.pruneCompletedEntriesOnStartup) {
			await pruneCleanVoiceCacheAtStartup(this.options.cacheRoot).catch((error) => {
				console.warn("[clean-voice] startup cache retention failed:", error);
			});
		}
		const orphaned = await fs.readdir(this.stagingDir).catch(() => []);
		await Promise.all(
			orphaned.map((name) =>
				fs.rm(path.join(this.stagingDir, name), { recursive: true, force: true }),
			),
		);
	}

	private isSuspended(): boolean {
		return (
			this.recordingActive || this.thermalState === "serious" || this.thermalState === "critical"
		);
	}

	private emit(job: DesiredJob, phase: CleanVoiceJobPhase, message?: string): void {
		const resolved =
			phase === "ready" ? this.resolved.get(assetKey(job.projectId, job.assetId)) : null;
		const status: CleanVoiceJobStatus = {
			projectId: job.projectId,
			assetId: job.assetId,
			phase,
			...(message ? { message } : {}),
			...(resolved
				? {
						cleanMicrophonePath: resolved.path,
						previewAudioPath: resolved.previewPath,
						cacheKey: resolved.cacheKey,
					}
				: {}),
		};
		this.publishStatus(status);
	}

	private publishStatus(status: CleanVoiceJobStatus): void {
		this.statuses.set(assetKey(status.projectId, status.assetId), status);
		this.options.onStatus?.(status);
	}

	private removeDesired(key: string): void {
		this.desired.delete(key);
		this.failures.delete(key);
		this.resolved.delete(key);
		this.resolvedSignatures.delete(key);
		this.statuses.delete(key);
		this.pendingSet.delete(key);
		if (this.active?.assetKey === key) this.active.controller.abort();
	}

	private enqueue(key: string): void {
		const job = this.desired.get(key);
		if (
			!job ||
			this.pendingSet.has(key) ||
			(this.active?.assetKey === key && this.active.signature === job.signature) ||
			this.resolvedSignatures.get(key) === job.signature ||
			this.failures.get(key) === job.signature
		) {
			return;
		}
		this.pendingSet.add(key);
		this.pending.push(key);
		this.emit(job, "queued");
	}

	private enqueueAllDesired(): void {
		for (const key of this.desired.keys()) this.enqueue(key);
	}

	private async pump(): Promise<void> {
		await this.ready;
		if (this.disposed || this.active || this.isSuspended()) return;
		for (;;) {
			const key = this.pending.shift();
			if (!key) return;
			this.pendingSet.delete(key);
			const job = this.desired.get(key);
			if (!job || this.failures.get(key) === job.signature) continue;
			const controller = new AbortController();
			this.active = { assetKey: key, signature: job.signature, controller };
			void this.run(job, controller.signal)
				.catch(() => undefined)
				.finally(() => {
					if (this.active?.controller === controller) this.active = null;
					if (!this.disposed && !this.isSuspended()) {
						this.enqueueAllDesired();
						void this.pump();
					}
				});
			return;
		}
	}

	private async run(job: DesiredJob, signal: AbortSignal): Promise<void> {
		const key = assetKey(job.projectId, job.assetId);
		try {
			this.emit(job, "checking-cache");
			const resolved = await this.resolveOrProcess(job, signal);
			if (signal.aborted || this.desired.get(key)?.signature !== job.signature) return;
			this.resolved.set(key, resolved);
			this.resolvedSignatures.set(key, job.signature);
			this.failures.delete(key);
			this.emit(job, "ready");
		} catch (error) {
			if (error instanceof CleanVoiceCancelledError || signal.aborted) {
				this.emit(job, "cancelled");
				if (this.desired.get(key)?.signature === job.signature) this.enqueue(key);
				return;
			}
			this.failures.set(key, job.signature);
			const message = error instanceof Error ? error.message : String(error);
			this.emit(job, "failed", message);
			console.warn(`[clean-voice] ${job.assetId} failed: ${message}`);
		}
	}

	private async resolveOrProcess(
		job: DesiredJob,
		signal: AbortSignal,
	): Promise<CleanVoiceResolvedStem> {
		const engine = await this.options.processor.identity();
		const source = await sourceIdentity(job.sourcePath);
		const requestKey = jsonHash({
			version: CACHE_VERSION,
			extractionVersion: EXTRACTION_VERSION,
			source,
			engine,
			recipe: recipeIdentity(job.recipe),
		});
		const linked = await this.readLinkedEntry(requestKey, engine, job.recipe, signal);
		if (linked) return { ...linked, projectId: job.projectId, assetId: job.assetId };
		if (signal.aborted) throw new CleanVoiceCancelledError();

		this.emit(job, "processing");
		const staging = path.join(this.stagingDir, `job-${process.pid}-${randomUUID()}`);
		await fs.mkdir(staging, { mode: 0o700 });
		let published = false;
		try {
			const artifact = await this.options.processor.process({
				sourcePath: source.resolvedPath,
				recipe: job.recipe,
				stagingDir: staging,
				signal,
			});
			if (signal.aborted) throw new CleanVoiceCancelledError();
			if (!sameEngine(artifact.engine, engine)) {
				throw new Error("Clean Voice engine changed during processing");
			}
			const cacheKey = jsonHash({
				version: CACHE_VERSION,
				extractionVersion: EXTRACTION_VERSION,
				rawSha256: artifact.rawSha256,
				sampleRate: artifact.sampleRate,
				sampleCount: artifact.inputSamples,
				engine,
				recipe: recipeIdentity(job.recipe),
			});
			const manifest: CacheManifest = {
				version: 1,
				cacheKey,
				createdAt: new Date().toISOString(),
				extractionVersion: EXTRACTION_VERSION,
				input: {
					rawSha256: artifact.rawSha256,
					sampleRate: artifact.sampleRate,
					sampleCount: artifact.inputSamples,
				},
				output: {
					file: OUTPUT_FILE,
					sha256: artifact.outputSha256,
					sampleRate: artifact.sampleRate,
					sampleCount: artifact.outputSamples,
				},
				preview: {
					file: PREVIEW_FILE,
					sha256: artifact.previewSha256,
					bytes: artifact.previewBytes,
				},
				engine,
				recipe: job.recipe,
				quality: {
					delaySamples: artifact.delaySamples,
					inputPeak: artifact.inputPeak,
					outputPeak: artifact.outputPeak,
					realTimeFactor: artifact.realTimeFactor,
				},
			};
			await fs.rm(artifact.rawPath, { force: true });
			await writeJsonAtomically(path.join(staging, MANIFEST_FILE), manifest);
			await Promise.all(
				[artifact.cleanPath, artifact.previewPath].map(async (artifactPath) => {
					const handle = await fs.open(artifactPath, "r");
					try {
						await handle.sync();
					} finally {
						await handle.close();
					}
				}),
			);
			await syncDirectory(staging);

			const entryPath = path.join(this.entriesDir, cacheKey);
			const existing = await this.validateEntry(cacheKey, engine, job.recipe, signal);
			if (existing) {
				await fs.rm(staging, { recursive: true, force: true });
			} else {
				await fs.rm(entryPath, { recursive: true, force: true });
				await fs.rename(staging, entryPath);
				await syncDirectory(this.entriesDir);
				this.verifiedEntries.add(cacheKey);
			}
			published = true;
			await writeJsonAtomically(path.join(this.linksDir, `${requestKey}.json`), {
				version: 1,
				requestKey,
				cacheKey,
			} satisfies CacheLink);
			return {
				projectId: job.projectId,
				assetId: job.assetId,
				path: path.join(entryPath, OUTPUT_FILE),
				previewPath: path.join(entryPath, PREVIEW_FILE),
				cacheKey,
				recipe: job.recipe,
			};
		} finally {
			if (!published) await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
		}
	}

	private async readLinkedEntry(
		requestKey: string,
		engine: CleanVoiceEngineIdentity,
		recipe: NaturalRecipe,
		signal: AbortSignal,
	): Promise<Omit<CleanVoiceResolvedStem, "projectId" | "assetId"> | null> {
		const linkPath = path.join(this.linksDir, `${requestKey}.json`);
		try {
			const link = parseLink(JSON.parse(await fs.readFile(linkPath, "utf8")));
			if (!link || link.requestKey !== requestKey) throw new Error("invalid link");
			const valid = await this.validateEntry(link.cacheKey, engine, recipe, signal);
			if (!valid) throw new Error("invalid cache entry");
			return {
				path: path.join(this.entriesDir, link.cacheKey, OUTPUT_FILE),
				previewPath: path.join(this.entriesDir, link.cacheKey, PREVIEW_FILE),
				cacheKey: link.cacheKey,
				recipe,
			};
		} catch (error) {
			if (signal.aborted || error instanceof CleanVoiceCancelledError) throw error;
			await fs.rm(linkPath, { force: true }).catch(() => undefined);
			return null;
		}
	}

	private async validateEntry(
		cacheKey: string,
		engine: CleanVoiceEngineIdentity,
		recipe: NaturalRecipe,
		signal: AbortSignal,
	): Promise<boolean> {
		if (this.verifiedEntries.has(cacheKey)) return true;
		const entryPath = path.join(this.entriesDir, cacheKey);
		try {
			const manifest = parseManifest(
				JSON.parse(await fs.readFile(path.join(entryPath, MANIFEST_FILE), "utf8")),
			);
			if (
				!manifest ||
				manifest.cacheKey !== cacheKey ||
				!sameEngine(manifest.engine, engine) ||
				recipeIdentity(manifest.recipe) !== recipeIdentity(recipe) ||
				manifest.input.sampleRate !== manifest.output.sampleRate ||
				manifest.input.sampleCount !== manifest.output.sampleCount
			) {
				return false;
			}
			const outputPath = path.join(entryPath, OUTPUT_FILE);
			const previewPath = path.join(entryPath, PREVIEW_FILE);
			const [wave, hash, previewHash, previewStat] = await Promise.all([
				readWaveInfo(outputPath),
				sha256File(outputPath, signal),
				sha256File(previewPath, signal),
				fs.stat(previewPath),
			]);
			if (
				wave.channels !== 1 ||
				wave.sampleRate !== manifest.output.sampleRate ||
				wave.sampleCount !== manifest.output.sampleCount ||
				hash !== manifest.output.sha256 ||
				manifest.preview.file !== PREVIEW_FILE ||
				!previewStat.isFile() ||
				previewStat.size !== manifest.preview.bytes ||
				previewHash !== manifest.preview.sha256
			) {
				return false;
			}
			this.verifiedEntries.add(cacheKey);
			return true;
		} catch (error) {
			if (signal.aborted || error instanceof CleanVoiceCancelledError) throw error;
			return false;
		}
	}
}
