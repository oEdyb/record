import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	summarizeMetric,
	type WorkloadReport,
	WorkloadTelemetryService,
} from "./workloadTelemetry";

let directory = "";
let now = 1_000;

async function readOnlyReport(): Promise<WorkloadReport> {
	const names = await fs.readdir(directory);
	const reports = names.filter((name) => name.endsWith(".json"));
	expect(reports).toHaveLength(1);
	return JSON.parse(await fs.readFile(path.join(directory, reports[0]), "utf8"));
}

function createService(options: { maxReports?: number; maxReportAgeMs?: number } = {}) {
	return new WorkloadTelemetryService({
		rootDirectory: directory,
		now: () => now,
		createId: () => `workload-${now}`,
		sampleResources: vi.fn(async () => ({
			mainPrivateMemoryKb: 42,
			appWorkingSetKb: 84,
			appCpuPercent: 12.5,
			diskAvailableBytes: 10 * 1_024 * 1_024 * 1_024,
			thermalState: "nominal" as const,
		})),
		setInterval: vi.fn(() => 1 as unknown as ReturnType<typeof setInterval>),
		clearInterval: vi.fn(),
		...options,
	});
}

beforeEach(async () => {
	directory = await fs.mkdtemp(path.join(os.tmpdir(), "klippt-workloads-"));
	now = 1_000;
});

afterEach(async () => {
	await fs.rm(directory, { recursive: true, force: true });
});

describe("workload telemetry", () => {
	it("reports a failed preview write to the bounded quit guard", async () => {
		await fs.mkdir(path.join(directory, "workload-1000.json"));
		const service = createService();
		service.begin({ kind: "preview", operation: "native-preview", platform: "linux" });
		await expect(service.finishPreviewsBeforeQuit()).rejects.toThrow(
			"Workload report persistence failed",
		);
	});

	it("durably completes live previews on clean quit without completing other workloads", async () => {
		const service = createService();
		const preview = service.begin({
			kind: "preview",
			operation: "native-preview",
			platform: "linux",
		});
		service.startPhase(preview, "preview-active");
		now++;
		const failed = service.begin({
			kind: "preview",
			operation: "native-preview",
			platform: "linux",
		});
		service.finish(failed, "failed", "preview-failed");
		now++;
		const capture = service.begin({
			kind: "capture",
			operation: "linux-pipewire",
			platform: "linux",
		});
		now++;
		const exporting = service.begin({
			kind: "export",
			operation: "native-video-export",
			platform: "linux",
		});
		now = 2_000;
		await service.finishPreviewsBeforeQuit();
		const readReport = async (id: string): Promise<WorkloadReport> =>
			JSON.parse(await fs.readFile(path.join(directory, `${id}.json`), "utf8"));
		expect(await readReport(preview)).toMatchObject({
			status: "succeeded",
			endedAtEpochMs: 2_000,
			durationMs: 1_000,
			phases: [{ phase: "preview-active", endedAtElapsedMs: 1_000 }],
		});
		expect(
			(await readReport(preview)).events.filter((event) => event.code === "preview-completed"),
		).toHaveLength(1);
		expect((await readReport(failed)).status).toBe("failed");
		expect((await readReport(capture)).status).toBe("running");
		expect((await readReport(exporting)).status).toBe("running");
		const restarted = createService();
		await restarted.initialize();
		expect((await readReport(preview)).status).toBe("succeeded");
		expect((await readReport(capture)).status).toBe("interrupted");
		expect((await readReport(exporting)).status).toBe("interrupted");
		restarted.dispose();
	});

	it("writes a local running journal without private string fields", async () => {
		const service = createService();
		const id = service.begin({
			kind: "capture",
			operation: "screen-capturekit",
			platform: "darwin",
			configuration: { requestedVideoFps: 60, requestedCameraFps: 30 },
			diskDirectory: "/Users/private/recordings",
		});
		await service.flush();

		const report = await readOnlyReport();
		expect(report.id).toBe(id);
		expect(report.status).toBe("running");
		expect(report.configuration).toEqual({ requestedVideoFps: 60, requestedCameraFps: 30 });
		expect(JSON.stringify(report)).not.toContain("/Users/private");
		expect(report.privacy.localOnly).toBe(true);
		service.dispose();
	});

	it("records bounded metrics, phases, resource samples, and percentiles", async () => {
		const service = createService();
		const id = service.begin({
			kind: "export",
			operation: "native-video-export",
			platform: "darwin",
		});
		service.startPhase(id, "export-encode");
		for (const value of [10, 20, 30, 40, 50]) {
			service.observe(id, "export.throughput_fps", value);
		}
		now = 6_000;
		await service.sampleNow();
		service.endPhase(id, "export-encode");
		service.addMediaPath(id, "videotoolbox-hardware");
		service.event(id, "export-completed");
		service.finish(id, "succeeded");
		await service.flush();

		const report = await readOnlyReport();
		expect(report.status).toBe("succeeded");
		expect(report.durationMs).toBe(5_000);
		expect(report.phases).toEqual([
			{ phase: "export-encode", startedAtElapsedMs: 0, endedAtElapsedMs: 5_000 },
		]);
		expect(report.metrics["export.throughput_fps"]).toMatchObject({
			count: 5,
			min: 10,
			max: 50,
			mean: 30,
			p50: 30,
			p95: 48,
			p99: 49.6,
		});
		expect(report.resources[0]).toMatchObject({ elapsedMs: 5_000, mainPrivateMemoryKb: 42 });
		expect(report.mediaPaths).toEqual(["videotoolbox-hardware"]);
		service.dispose();
	});

	it("marks an unfinished journal as interrupted on the next launch", async () => {
		const first = createService();
		first.begin({
			kind: "capture",
			operation: "linux-pipewire",
			platform: "linux",
		});
		first.startPhase("workload-1000", "capture-active");
		await first.flush();
		first.dispose();

		now = 11_000;
		const second = createService();
		await second.initialize();
		const report = await readOnlyReport();
		expect(report.status).toBe("interrupted");
		expect(report.durationMs).toBe(10_000);
		expect(report.failureCode).toBe("unknown");
		expect(report.phases).toEqual([
			{ phase: "capture-active", startedAtElapsedMs: 0, endedAtElapsedMs: 10_000 },
		]);
		second.dispose();
	});

	it("recovers when the diagnostics directory disappears during startup", async () => {
		const service = createService();
		const actualReaddir = fs.readdir;
		let allowRead!: () => void;
		const blockedRead = new Promise<void>((resolve) => {
			allowRead = resolve;
		});
		const readdir = vi.spyOn(fs, "readdir").mockImplementation(async (...args) => {
			await blockedRead;
			return actualReaddir(...args);
		});
		try {
			const initializing = service.initialize();
			await vi.waitFor(() => expect(readdir).toHaveBeenCalled());
			await fs.rm(directory, { recursive: true, force: true });
			allowRead();
			await expect(initializing).resolves.toBeUndefined();
		} finally {
			readdir.mockRestore();
		}
	});

	it("keeps sampling failures out of the recording path", async () => {
		const service = new WorkloadTelemetryService({
			rootDirectory: directory,
			now: () => now,
			createId: () => "workload-failure",
			sampleResources: async () => {
				throw new Error("/Users/private/secret.mov");
			},
			setInterval: () => 1 as unknown as ReturnType<typeof setInterval>,
			clearInterval: () => undefined,
		});
		const id = service.begin({
			kind: "capture",
			operation: "browser-media-recorder",
			platform: "darwin",
		});
		await expect(service.sampleNow()).resolves.toBeUndefined();
		service.finish(id, "succeeded");
		await service.flush();
		expect(JSON.stringify(await readOnlyReport())).not.toContain("secret.mov");
		service.dispose();
	});

	it("prunes old reports by age and count", async () => {
		for (let index = 0; index < 4; index += 1) {
			now = 1_000 + index * 1_000;
			const service = createService({ maxReports: 2, maxReportAgeMs: 2_500 });
			const id = service.begin({
				kind: "export",
				operation: "native-video-export",
				platform: "darwin",
			});
			service.finish(id, "succeeded");
			await service.flush();
			service.dispose();
		}
		const names = (await fs.readdir(directory)).filter((name) => name.endsWith(".json"));
		expect(names).toHaveLength(2);
	});

	it("ignores non-finite values", () => {
		expect(summarizeMetric([1, Number.NaN, Number.POSITIVE_INFINITY, 3])).toMatchObject({
			count: 2,
			mean: 2,
		});
	});

	it("accepts a native percentile summary without storing raw samples", async () => {
		const service = createService();
		const id = service.begin({
			kind: "capture",
			operation: "screen-capturekit",
			platform: "darwin",
		});
		service.setMetricSummary(id, "microphone.timestamp_drift_ms", {
			count: 100,
			min: -2,
			max: 4,
			mean: 0.5,
			p50: 0.2,
			p95: 2,
			p99: 3.5,
		});
		service.finish(id, "succeeded");
		await service.flush();
		expect((await readOnlyReport()).metrics["microphone.timestamp_drift_ms"]).toMatchObject({
			count: 100,
			p95: 2,
		});
		service.dispose();
	});

	it("keeps preview reports local and emits disk pressure only once", async () => {
		const service = new WorkloadTelemetryService({
			rootDirectory: directory,
			now: () => now,
			createId: () => "preview-1",
			sampleResources: async () => ({ diskAvailableBytes: 4 * 1_024 * 1_024 * 1_024 }),
			setInterval: () => 1 as unknown as ReturnType<typeof setInterval>,
			clearInterval: () => undefined,
		});
		const id = service.begin({
			kind: "preview",
			operation: "native-preview",
			platform: "darwin",
			configuration: { previewWidthPx: 1280, previewHeightPx: 720 },
		});
		await service.sampleNow();
		await service.sampleNow();
		service.finish(id, "succeeded");
		await service.flush();

		const report = await readOnlyReport();
		expect(report.kind).toBe("preview");
		expect(report.configuration).toMatchObject({ previewWidthPx: 1280, previewHeightPx: 720 });
		expect(report.events.filter((event) => event.code === "disk-pressure")).toHaveLength(1);
		service.dispose();
	});
});
