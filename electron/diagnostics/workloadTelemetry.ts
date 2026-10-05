import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { writeJsonDurably } from "../filesystem/durableJson";

const FORMAT = "klippt-workload-v1" as const;
const SAMPLE_INTERVAL_MS = 5_000;
const PERSIST_INTERVAL_MS = 30_000;
const MAX_RESOURCE_SAMPLES = 2_160;
const MAX_METRIC_SAMPLES = 8_192;
const MAX_EVENTS = 1_024;
const DISK_PRESSURE_BYTES = 5 * 1_024 * 1_024 * 1_024;
const MAX_REPORTS = 100;
const MAX_REPORT_AGE_MS = 30 * 24 * 60 * 60 * 1_000;

type WorkloadKind = "capture" | "preview" | "export";
export type WorkloadOperation =
	| "screen-capturekit"
	| "windows-graphics-capture"
	| "linux-pipewire"
	| "browser-media-recorder"
	| "native-preview"
	| "native-video-export"
	| "native-gif-export";
export type WorkloadOutcome =
	| "running"
	| "succeeded"
	| "failed"
	| "cancelled"
	| "discarded"
	| "recovered"
	| "interrupted";
export type WorkloadPhase =
	| "capture-start"
	| "capture-active"
	| "clip-finalization"
	| "capture-stop"
	| "preview-active"
	| "export-decode"
	| "export-compose"
	| "export-encode"
	| "export-finalize";
export type WorkloadMetric =
	| "capture.requested_fps"
	| "capture.delivered_fps"
	| "camera.requested_fps"
	| "camera.delivered_fps"
	| "capture.pending_frames"
	| "capture.dropped_frames"
	| "capture.incomplete_frames"
	| "capture.timestamp_drift_ms"
	| "capture.source_delivery_age_ms"
	| "capture.source_frame_interval_ms"
	| "camera.timestamp_drift_ms"
	| "microphone.timestamp_drift_ms"
	| "system_audio.timestamp_drift_ms"
	| "writer.queue_depth"
	| "writer.fragment_finalize_ms"
	| "writer.stop_total_ms"
	| "preview.gpu_readback_ms"
	| "preview.native_boundary_ms"
	| "preview.ipc_ms"
	| "preview.browser_main_thread_ms"
	| "preview.draw_ms"
	| "export.phase_ms"
	| "export.throughput_fps"
	| "export.frames"
	| "export.media_duration_s"
	| "export.output_bytes"
	| "audio.block_ms"
	| "audio.queue_bytes"
	| "disk.write_latency_ms";
export type WorkloadEventCode =
	| "capture-started"
	| "capture-paused"
	| "capture-resumed"
	| "clip-finalized"
	| "preview-started"
	| "preview-completed"
	| "encoder-selected"
	| "encoder-fallback"
	| "disk-pressure"
	| "disk-full"
	| "thermal-pressure"
	| "export-started"
	| "export-completed";
export type WorkloadFailureCode =
	| "capture-start-failed"
	| "capture-runtime-failed"
	| "capture-stop-failed"
	| "writer-failed"
	| "helper-timeout"
	| "disk-full"
	| "preview-failed"
	| "export-failed"
	| "export-cancelled"
	| "unknown";
export type WorkloadFallbackCode =
	| "encoder-hardware-to-software"
	| "container-fragmented-to-plain"
	| "cursor-editable-to-system"
	| "capture-recovered-fragmented-output"
	| "clean-microphone-to-raw";
export type WorkloadMediaPath =
	| "stream-copy"
	| "packet-copy"
	| "identity-bypass"
	| "videotoolbox-hardware"
	| "videotoolbox-software"
	| "media-foundation-hardware"
	| "media-foundation-software"
	| "ffmpeg-hardware"
	| "ffmpeg-software"
	| "libopenh264-software"
	| "libkvazaar-software"
	| "amf-hardware"
	| "nvenc-hardware"
	| "qsv-hardware"
	| "videotoolbox-decoder"
	| "d3d11va-decoder"
	| "software-decoder"
	| "mixed-decoder"
	| "metal"
	| "d3d11"
	| "vulkan"
	| "software"
	| "unknown";

export interface WorkloadResourceSample {
	elapsedMs: number;
	mainPrivateMemoryKb?: number;
	appWorkingSetKb?: number;
	appCpuPercent?: number;
	systemAvailableMemoryKb?: number;
	gpuMemoryEstimatedBytes?: number;
	diskAvailableBytes?: number;
	thermalState?: "unknown" | "nominal" | "fair" | "serious" | "critical";
	lowPowerMode?: boolean;
	onBatteryPower?: boolean;
	cpuSpeedLimitPercent?: number;
	cameraPressure?: "unknown" | "nominal" | "fair" | "serious" | "critical" | "shutdown";
}

export interface WorkloadConfiguration {
	requestedVideoFps?: number;
	requestedCameraFps?: number;
	previewWidthPx?: number;
	previewHeightPx?: number;
	outputFps?: number;
	outputWidthPx?: number;
	outputHeightPx?: number;
	expectedFrames?: number;
	format?: "mp4" | "gif";
}

export interface WorkloadStart {
	kind: WorkloadKind;
	operation: WorkloadOperation;
	platform: NodeJS.Platform;
	configuration?: WorkloadConfiguration;
	diskDirectory?: string;
}

export interface WorkloadMetricSummary {
	count: number;
	min: number;
	max: number;
	mean: number;
	p50: number;
	p95: number;
	p99: number;
}

export interface WorkloadReport {
	format: typeof FORMAT;
	id: string;
	kind: WorkloadKind;
	operation: WorkloadOperation;
	platform: NodeJS.Platform;
	status: WorkloadOutcome;
	startedAtEpochMs: number;
	updatedAtEpochMs: number;
	endedAtEpochMs?: number;
	durationMs?: number;
	configuration: WorkloadConfiguration;
	phases: Array<{
		phase: WorkloadPhase;
		startedAtElapsedMs: number;
		endedAtElapsedMs?: number;
	}>;
	events: Array<{ code: WorkloadEventCode; elapsedMs: number; value?: number }>;
	fallbacks: WorkloadFallbackCode[];
	mediaPaths: WorkloadMediaPath[];
	failureCode?: WorkloadFailureCode;
	metrics: Partial<Record<WorkloadMetric, WorkloadMetricSummary>>;
	resources: WorkloadResourceSample[];
	privacy: {
		localOnly: true;
		excluded: readonly [
			"filenames and paths",
			"URLs",
			"project and window names",
			"transcripts",
			"cursor and keyboard events",
			"audio and video",
		];
	};
}

type ActiveWorkload = {
	report: WorkloadReport;
	diskDirectory?: string;
	metricSamples: Map<WorkloadMetric, number[]>;
	lastPersistedAtMs: number;
};

export interface WorkloadTelemetryDependencies {
	rootDirectory: string;
	sampleResources: (diskDirectory?: string) => Promise<Omit<WorkloadResourceSample, "elapsedMs">>;
	now?: () => number;
	createId?: () => string;
	setInterval?: (callback: () => void, delayMs: number) => ReturnType<typeof setInterval>;
	clearInterval?: (timer: ReturnType<typeof setInterval>) => void;
	maxReports?: number;
	maxReportAgeMs?: number;
}

function finite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1e15;
}

function safeConfiguration(value: WorkloadConfiguration | undefined): WorkloadConfiguration {
	if (!value) return {};
	const result: WorkloadConfiguration = {};
	for (const key of [
		"requestedVideoFps",
		"requestedCameraFps",
		"previewWidthPx",
		"previewHeightPx",
		"outputFps",
		"outputWidthPx",
		"outputHeightPx",
		"expectedFrames",
	] as const) {
		if (finite(value[key]) && value[key] >= 0) result[key] = value[key];
	}
	if (value.format === "mp4" || value.format === "gif") result.format = value.format;
	return result;
}

function percentile(sorted: readonly number[], quantile: number): number {
	if (sorted.length === 0) return 0;
	if (sorted.length === 1) return sorted[0];
	const index = (sorted.length - 1) * quantile;
	const lower = Math.floor(index);
	const upper = Math.ceil(index);
	const weight = index - lower;
	return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

export function summarizeMetric(samples: readonly number[]): WorkloadMetricSummary | undefined {
	const sorted = samples.filter(finite).sort((a, b) => a - b);
	if (sorted.length === 0) return undefined;
	const total = sorted.reduce((sum, value) => sum + value, 0);
	return {
		count: sorted.length,
		min: sorted[0],
		max: sorted.at(-1) ?? sorted[0],
		mean: total / sorted.length,
		p50: percentile(sorted, 0.5),
		p95: percentile(sorted, 0.95),
		p99: percentile(sorted, 0.99),
	};
}

function normalizeResourceSample(
	value: Omit<WorkloadResourceSample, "elapsedMs">,
	elapsedMs: number,
): WorkloadResourceSample {
	const sample: WorkloadResourceSample = { elapsedMs: Math.max(0, elapsedMs) };
	for (const key of [
		"mainPrivateMemoryKb",
		"appWorkingSetKb",
		"appCpuPercent",
		"systemAvailableMemoryKb",
		"gpuMemoryEstimatedBytes",
		"diskAvailableBytes",
		"cpuSpeedLimitPercent",
	] as const) {
		if (finite(value[key]) && value[key] >= 0) sample[key] = value[key];
	}
	if (
		value.thermalState === "unknown" ||
		value.thermalState === "nominal" ||
		value.thermalState === "fair" ||
		value.thermalState === "serious" ||
		value.thermalState === "critical"
	) {
		sample.thermalState = value.thermalState;
	}
	if (typeof value.lowPowerMode === "boolean") sample.lowPowerMode = value.lowPowerMode;
	if (typeof value.onBatteryPower === "boolean") sample.onBatteryPower = value.onBatteryPower;
	if (
		value.cameraPressure === "unknown" ||
		value.cameraPressure === "nominal" ||
		value.cameraPressure === "fair" ||
		value.cameraPressure === "serious" ||
		value.cameraPressure === "critical" ||
		value.cameraPressure === "shutdown"
	) {
		sample.cameraPressure = value.cameraPressure;
	}
	return sample;
}

function privacyContract(): WorkloadReport["privacy"] {
	return {
		localOnly: true,
		excluded: [
			"filenames and paths",
			"URLs",
			"project and window names",
			"transcripts",
			"cursor and keyboard events",
			"audio and video",
		],
	};
}

export class WorkloadTelemetryService {
	private readonly active = new Map<string, ActiveWorkload>();
	private readonly writes = new Set<Promise<void>>();
	private readonly writeChains = new Map<string, Promise<void>>();
	private readonly now: () => number;
	private readonly createId: () => string;
	private readonly setInterval_: WorkloadTelemetryDependencies["setInterval"];
	private readonly clearInterval_: WorkloadTelemetryDependencies["clearInterval"];
	private readonly maxReports: number;
	private readonly maxReportAgeMs: number;
	private sampler: ReturnType<typeof setInterval> | undefined;
	private initialization: Promise<void> | undefined;

	constructor(private readonly deps: WorkloadTelemetryDependencies) {
		this.now = deps.now ?? Date.now;
		this.createId = deps.createId ?? crypto.randomUUID;
		this.setInterval_ = deps.setInterval ?? setInterval;
		this.clearInterval_ = deps.clearInterval ?? clearInterval;
		this.maxReports = deps.maxReports ?? MAX_REPORTS;
		this.maxReportAgeMs = deps.maxReportAgeMs ?? MAX_REPORT_AGE_MS;
	}

	initialize(): Promise<void> {
		if (!this.initialization) this.initialization = this.recoverAndPrune();
		return this.initialization;
	}

	begin(input: WorkloadStart): string {
		const now = this.now();
		const id = this.createId();
		const report: WorkloadReport = {
			format: FORMAT,
			id,
			kind: input.kind,
			operation: input.operation,
			platform: input.platform,
			status: "running",
			startedAtEpochMs: now,
			updatedAtEpochMs: now,
			configuration: safeConfiguration(input.configuration),
			phases: [],
			events: [],
			fallbacks: [],
			mediaPaths: [],
			metrics: {},
			resources: [],
			privacy: privacyContract(),
		};
		this.active.set(id, {
			report,
			diskDirectory: input.diskDirectory,
			metricSamples: new Map(),
			lastPersistedAtMs: now,
		});
		this.schedulePersist(id);
		this.startSampler();
		return id;
	}

	configure(id: string, configuration: WorkloadConfiguration): void {
		const active = this.active.get(id);
		if (!active) return;
		active.report.configuration = {
			...active.report.configuration,
			...safeConfiguration(configuration),
		};
		active.report.updatedAtEpochMs = this.now();
	}

	observe(id: string, metric: WorkloadMetric, value: number): void {
		if (!finite(value)) return;
		const active = this.active.get(id);
		if (!active) return;
		const samples = active.metricSamples.get(metric) ?? [];
		if (samples.length >= MAX_METRIC_SAMPLES) samples.shift();
		samples.push(value);
		active.metricSamples.set(metric, samples);
		const summary = summarizeMetric(samples);
		if (summary) active.report.metrics[metric] = summary;
		active.report.updatedAtEpochMs = this.now();
	}

	setMetricSummary(id: string, metric: WorkloadMetric, summary: WorkloadMetricSummary): void {
		const active = this.active.get(id);
		if (
			!active ||
			!Number.isInteger(summary.count) ||
			summary.count < 1 ||
			![summary.min, summary.max, summary.mean, summary.p50, summary.p95, summary.p99].every(finite)
		) {
			return;
		}
		active.report.metrics[metric] = { ...summary };
		active.report.updatedAtEpochMs = this.now();
	}

	recordResourceSnapshot(id: string, value: Omit<WorkloadResourceSample, "elapsedMs">): void {
		const active = this.active.get(id);
		if (!active) return;
		const sample = normalizeResourceSample(value, this.now() - active.report.startedAtEpochMs);
		if (active.report.resources.length >= MAX_RESOURCE_SAMPLES) active.report.resources.shift();
		active.report.resources.push(sample);
		active.report.updatedAtEpochMs = this.now();
	}

	event(id: string, code: WorkloadEventCode, value?: number): void {
		const active = this.active.get(id);
		if (!active) return;
		if (active.report.events.length >= MAX_EVENTS) active.report.events.shift();
		active.report.events.push({
			code,
			elapsedMs: Math.max(0, this.now() - active.report.startedAtEpochMs),
			...(finite(value) ? { value } : {}),
		});
		active.report.updatedAtEpochMs = this.now();
	}

	addFallback(id: string, fallback: WorkloadFallbackCode): void {
		const active = this.active.get(id);
		if (!active || active.report.fallbacks.includes(fallback)) return;
		active.report.fallbacks.push(fallback);
		active.report.updatedAtEpochMs = this.now();
	}

	addMediaPath(id: string, mediaPath: WorkloadMediaPath): void {
		const active = this.active.get(id);
		if (!active || active.report.mediaPaths.includes(mediaPath)) return;
		active.report.mediaPaths.push(mediaPath);
		active.report.updatedAtEpochMs = this.now();
	}

	startPhase(id: string, phase: WorkloadPhase): void {
		const active = this.active.get(id);
		if (!active) return;
		const elapsedMs = Math.max(0, this.now() - active.report.startedAtEpochMs);
		const open = active.report.phases.find((entry) => entry.endedAtElapsedMs === undefined);
		if (open) open.endedAtElapsedMs = elapsedMs;
		active.report.phases.push({ phase, startedAtElapsedMs: elapsedMs });
		active.report.updatedAtEpochMs = this.now();
		this.schedulePersist(id);
	}

	endPhase(id: string, phase: WorkloadPhase): void {
		const active = this.active.get(id);
		if (!active) return;
		const open = [...active.report.phases]
			.reverse()
			.find((entry) => entry.phase === phase && entry.endedAtElapsedMs === undefined);
		if (open) open.endedAtElapsedMs = Math.max(0, this.now() - active.report.startedAtEpochMs);
		active.report.updatedAtEpochMs = this.now();
	}

	finish(
		id: string,
		outcome: Exclude<WorkloadOutcome, "running" | "interrupted">,
		failureCode?: WorkloadFailureCode,
	): void {
		const active = this.active.get(id);
		if (!active) return;
		const now = this.now();
		for (const phase of active.report.phases) {
			if (phase.endedAtElapsedMs === undefined) {
				phase.endedAtElapsedMs = Math.max(0, now - active.report.startedAtEpochMs);
			}
		}
		active.report.status = outcome;
		active.report.updatedAtEpochMs = now;
		active.report.endedAtEpochMs = now;
		active.report.durationMs = Math.max(0, now - active.report.startedAtEpochMs);
		if (outcome === "failed") active.report.failureCode = failureCode ?? "unknown";
		this.schedulePersist(id, true);
		this.active.delete(id);
		this.stopSamplerIfIdle();
	}

	async sampleNow(): Promise<void> {
		const entries = [...this.active.entries()];
		await Promise.all(
			entries.map(async ([id, active]) => {
				try {
					const raw = await this.deps.sampleResources(active.diskDirectory);
					this.recordResourceSnapshot(id, raw);
					const sample = active.report.resources.at(-1);
					if (!sample) return;
					if (
						sample.diskAvailableBytes === 0 &&
						!active.report.events.some((event) => event.code === "disk-full")
					) {
						this.event(id, "disk-full");
					} else if (
						sample.diskAvailableBytes !== undefined &&
						sample.diskAvailableBytes < DISK_PRESSURE_BYTES &&
						!active.report.events.some((event) => event.code === "disk-pressure")
					) {
						this.event(id, "disk-pressure", sample.diskAvailableBytes);
					}
					if (
						(sample.thermalState === "serious" || sample.thermalState === "critical") &&
						!active.report.events.some((event) => event.code === "thermal-pressure")
					) {
						this.event(id, "thermal-pressure");
					}
					if (this.now() - active.lastPersistedAtMs >= PERSIST_INTERVAL_MS) {
						active.lastPersistedAtMs = this.now();
						this.schedulePersist(id);
					}
				} catch {
					// Telemetry must never interrupt recording or export. A missing
					// sample is visible as a gap in the local report.
				}
			}),
		);
	}

	async listRecent(limit = 10): Promise<WorkloadReport[]> {
		await this.initialize();
		const entries = await fs
			.readdir(this.deps.rootDirectory, { withFileTypes: true })
			.catch(() => []);
		const reports: WorkloadReport[] = [];
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
			const report = await this.readReport(path.join(this.deps.rootDirectory, entry.name));
			if (report) reports.push(report);
		}
		return reports
			.sort((a, b) => b.startedAtEpochMs - a.startedAtEpochMs)
			.slice(0, Math.max(0, limit));
	}

	async flush(): Promise<void> {
		while (this.writes.size > 0) await Promise.all([...this.writes]);
	}

	dispose(): void {
		if (this.sampler) this.clearInterval_?.(this.sampler);
		this.sampler = undefined;
	}

	private startSampler(): void {
		if (this.sampler || this.active.size === 0) return;
		this.sampler = this.setInterval_?.(() => void this.sampleNow(), SAMPLE_INTERVAL_MS);
	}

	private stopSamplerIfIdle(): void {
		if (this.active.size > 0 || !this.sampler) return;
		this.clearInterval_?.(this.sampler);
		this.sampler = undefined;
	}

	private reportPath(id: string): string {
		return path.join(this.deps.rootDirectory, `${id}.json`);
	}

	private schedulePersist(id: string, final = false): void {
		const active = this.active.get(id);
		if (!active) return;
		const snapshot = structuredClone(active.report);
		const previous = this.writeChains.get(id) ?? Promise.resolve();
		const promise = previous
			.catch(() => undefined)
			.then(async () => {
				await this.initialize();
				await writeJsonDurably(this.reportPath(id), snapshot);
				if (final) await this.prune();
			})
			.catch(() => undefined);
		this.writeChains.set(id, promise);
		this.writes.add(promise);
		void promise.finally(() => {
			this.writes.delete(promise);
			if (this.writeChains.get(id) === promise) this.writeChains.delete(id);
		});
	}

	private async recoverAndPrune(): Promise<void> {
		await fs.mkdir(this.deps.rootDirectory, { recursive: true });
		const entries = await fs.readdir(this.deps.rootDirectory, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
			const filePath = path.join(this.deps.rootDirectory, entry.name);
			const report = await this.readReport(filePath);
			if (!report || report.status !== "running" || this.active.has(report.id)) continue;
			const now = this.now();
			const durationMs = Math.max(0, now - report.startedAtEpochMs);
			for (const phase of report.phases) {
				if (phase.endedAtElapsedMs === undefined) phase.endedAtElapsedMs = durationMs;
			}
			report.status = "interrupted";
			report.updatedAtEpochMs = now;
			report.endedAtEpochMs = now;
			report.durationMs = durationMs;
			report.failureCode = "unknown";
			await writeJsonDurably(filePath, report);
		}
		await this.prune();
	}

	private async readReport(filePath: string): Promise<WorkloadReport | null> {
		try {
			const value: unknown = JSON.parse(await fs.readFile(filePath, "utf8"));
			if (!value || typeof value !== "object") return null;
			const report = value as Partial<WorkloadReport>;
			if (
				report.format !== FORMAT ||
				typeof report.id !== "string" ||
				!finite(report.startedAtEpochMs) ||
				(report.kind !== "capture" && report.kind !== "preview" && report.kind !== "export")
			) {
				return null;
			}
			return report as WorkloadReport;
		} catch {
			return null;
		}
	}

	private async prune(): Promise<void> {
		const entries = await fs
			.readdir(this.deps.rootDirectory, { withFileTypes: true })
			.catch(() => []);
		const reports: Array<{ path: string; startedAtEpochMs: number }> = [];
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
			const filePath = path.join(this.deps.rootDirectory, entry.name);
			const report = await this.readReport(filePath);
			if (report) reports.push({ path: filePath, startedAtEpochMs: report.startedAtEpochMs });
		}
		reports.sort((a, b) => b.startedAtEpochMs - a.startedAtEpochMs);
		const cutoff = this.now() - this.maxReportAgeMs;
		await Promise.all(
			reports
				.filter((entry, index) => index >= this.maxReports || entry.startedAtEpochMs < cutoff)
				.map((entry) => fs.unlink(entry.path).catch(() => undefined)),
		);
	}
}
