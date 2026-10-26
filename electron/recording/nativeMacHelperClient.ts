import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import type { Rectangle } from "electron";
import {
	type NativeMacCaptureTelemetry,
	type NativeMacOriginalStarted,
	type NativeMacRecordingFailure,
	type NativeMacRecordingRequest,
	parseNativeMacOriginalStarted,
	parseNativeMacRecordingClip,
} from "../../src/lib/nativeMacRecording";
import type { RecordingSessionClip } from "../../src/lib/recordingSession";

/** SIGTERM finalizes the open clip (about 0.5 s under load) before the helper exits. */
export const HELPER_FINALIZE_GRACE_MS = 3_000;

export type NativeMacStopResult = {
	screenPath: string;
	clips: RecordingSessionClip[];
	warning?: { code: string; message: string };
	telemetry?: NativeMacCaptureTelemetry;
};

type NativeMacHelperClientOptions = {
	platform?: "linux";
	onProtocolEvent?: (event: Record<string, unknown>) => void;
	onFatalError?: (failure: NativeMacRecordingFailure) => void;
	onOriginalStarted?: (original: NativeMacOriginalStarted) => void;
	/** Every event the helper sends, by name, as it arrives. */
	onEvent?: (name: string) => void;
	/** Every warning the helper sends, with its code, message and timestamps. */
	onWarning?: (warning: Record<string, unknown>) => void;
};

export class NativeMacPauseError extends Error {
	readonly helperPaused: boolean;
	readonly clip?: RecordingSessionClip;

	constructor(message: string, helperPaused: boolean, clip?: RecordingSessionClip) {
		super(message);
		this.name = "NativeMacPauseError";
		this.helperPaused = helperPaused;
		this.clip = clip;
	}
}

export class NativeMacResumeRejectedError extends Error {
	constructor(
		message: string,
		readonly clipIndex: number,
	) {
		super(message);
		this.name = "NativeMacResumeRejectedError";
	}
}

/** One process-local protocol client. Late events cannot affect the next helper. */
export class NativeMacHelperClient {
	private readonly events = new EventEmitter();
	private outputBuffer = "";
	private lineBuffer = "";
	private bounds: Rectangle | null = null;
	private closed = false;
	private fatalReported = false;
	private recordingStarted = false;
	private sourceSelected = false;
	private startupError: string | null = null;
	private terminationRequested = false;
	private stoppedResult: NativeMacStopResult | null = null;
	private readonly reportedOriginals = new Set<string>();

	constructor(
		private readonly process: ChildProcessWithoutNullStreams,
		private readonly options: NativeMacHelperClientOptions = {},
	) {
		this.process.once("close", (code, signal) => {
			this.closed = true;
			if (this.recordingStarted && !this.terminationRequested && !this.stoppedResult) {
				this.reportFatalError({
					code: "capture-helper-exited",
					message: `Native capture exited unexpectedly (${signal ?? `code=${code ?? "unknown"}`}).`,
				});
			}
		});
		this.process.on("error", (error) => {
			if (this.recordingStarted && !this.terminationRequested && !this.stoppedResult) {
				this.reportFatalError({ code: "capture-helper-error", message: error.message });
			}
		});
		this.attachOutputDrain();
	}

	get output(): string {
		return this.outputBuffer;
	}

	get captureBounds(): Rectangle | null {
		return this.bounds;
	}

	isRunning(): boolean {
		return !this.closed && this.process.exitCode === null;
	}

	async kill(): Promise<void> {
		if (!this.isRunning()) return;
		this.terminationRequested = true;

		const gracefulExit = this.waitForClose(HELPER_FINALIZE_GRACE_MS);
		this.process.kill("SIGTERM");
		if (await gracefulExit) return;

		const forcedExit = this.waitForClose(1_000);
		this.process.kill("SIGKILL");
		if (await forcedExit) return;

		throw new Error("The native capture helper did not exit after SIGKILL.");
	}

	/** Portal consent is human-paced. Cancellation closes the process and rejects this waiter. */
	async waitForSourceSelected(): Promise<void> {
		if (this.startupError) throw new Error(this.startupError);
		if (!this.isRunning()) throw new Error("Native capture exited before source selection.");
		if (this.sourceSelected) return;
		await new Promise<void>((resolve, reject) => {
			const cleanup = this.observe({
				timeoutMs: null,
				timeoutMessage: "",
				onEvent: (event) => {
					if (event.event === "source-selected") {
						cleanup();
						resolve();
					}
					if (event.event === "error") {
						cleanup();
						reject(new Error(this.eventError(event, "Native source selection failed.")));
					}
				},
				onClose: () => reject(new Error("Native capture exited before source selection.")),
				onError: reject,
			});
		});
	}

	arm(): void {
		this.requireWritableCommandChannel();
		this.process.stdin.write("record\n");
	}

	async waitForStart(): Promise<void> {
		if (this.startupError) throw new Error(this.startupError);
		if (!this.isRunning()) {
			throw new Error("Native capture exited before start confirmation.");
		}
		if (this.recordingStarted) return;
		await new Promise<void>((resolve, reject) => {
			const cleanup = this.observe({
				timeoutMs: 10_000,
				timeoutMessage: "Timed out waiting for native capture to start",
				onEvent: (event) => {
					if (event.event === "recording-started") {
						cleanup();
						resolve();
					} else if (event.event === "error") {
						cleanup();
						reject(new Error(this.eventError(event, "Native capture failed")));
					}
				},
				onClose: (code) => {
					cleanup();
					reject(
						new Error(
							this.outputBuffer.trim() ||
								`Native capture exited before recording started (code=${code ?? "unknown"})`,
						),
					);
				},
				onError: reject,
			});
		});
	}

	async pause(): Promise<RecordingSessionClip | undefined> {
		this.requireWritableCommandChannel();
		const pending = new Promise<RecordingSessionClip | undefined>((resolve, reject) => {
			let finalizedClip: RecordingSessionClip | undefined;
			const cleanup = this.observe({
				timeoutMs: 30_000,
				timeoutMessage: "Timed out while finalizing the current recording clip",
				makeTimeoutError: (message) => new NativeMacPauseError(message, true, finalizedClip),
				onEvent: (event) => {
					if (event.event === "clip-finalized") {
						finalizedClip = parseNativeMacRecordingClip(event.clip) ?? undefined;
					} else if (event.event === "recording-paused") {
						cleanup();
						resolve(finalizedClip);
					} else if (event.event === "error") {
						cleanup();
						reject(
							new NativeMacPauseError(
								this.eventError(event, "Native pause failed"),
								event.code === "clip-finalize-failed",
								finalizedClip,
							),
						);
					}
				},
				onClose: () => reject(new Error("Native capture exited while finalizing a clip")),
				onError: reject,
			});
		});
		this.process.stdin.write("pause\n");
		return pending;
	}

	async reconfigure(request: NativeMacRecordingRequest): Promise<void> {
		await this.sendAndWait({
			command: `${JSON.stringify({ command: "reconfigure", request })}\n`,
			event: "recording-reconfigured",
			timeoutMs: 15_000,
			timeoutMessage: "Timed out while applying the next clip setup",
			exitMessage: "Native capture exited while applying the next clip setup",
			fallbackError: "Native reconfiguration failed",
		});
	}

	async resume(): Promise<number> {
		const event = await this.sendAndWait({
			command: "resume\n",
			event: "recording-resumed",
			timeoutMs: 10_000,
			timeoutMessage: "Timed out while starting the next recording clip",
			exitMessage: "Native capture exited while starting the next clip",
			fallbackError: "Native resume failed",
		});
		const clipIndex = event.clipIndex;
		if (typeof clipIndex !== "number" || !Number.isInteger(clipIndex) || clipIndex < 0) {
			throw new Error("Native resume did not return a valid clip index.");
		}
		return clipIndex;
	}

	async stop(fallback: {
		screenPath: string;
		clips: RecordingSessionClip[];
	}): Promise<NativeMacStopResult> {
		if (this.stoppedResult) {
			return {
				...this.stoppedResult,
				screenPath: this.stoppedResult.screenPath || fallback.screenPath,
			};
		}
		this.requireWritableCommandChannel();
		const pending = new Promise<NativeMacStopResult>((resolve, reject) => {
			const cleanup = this.observe({
				timeoutMs: 30_000,
				timeoutMessage: `Timed out waiting for native capture to stop. Output path: ${fallback.screenPath}. Output: ${this.outputBuffer.trim()}`,
				onEvent: (event) => {
					if (event.event === "recording-stopped") {
						cleanup();
						resolve(this.stoppedResultFromEvent(event, fallback.screenPath));
					} else if (event.event === "error" && event.code !== "writer-failed-during-capture") {
						cleanup();
						reject(new Error(this.eventError(event, "Native capture failed")));
					}
				},
				onClose: (code) => {
					cleanup();
					if (code === 0 && this.options.platform !== "linux") {
						resolve({ screenPath: fallback.screenPath, clips: fallback.clips });
					} else {
						reject(
							new Error(
								this.outputBuffer.trim() || `Native capture exited with code=${code ?? "unknown"}`,
							),
						);
					}
				},
				onError: reject,
			});
		});
		// Register the waiter before the helper can answer.
		this.terminationRequested = true;
		this.process.stdin.write("stop\n");
		return pending;
	}

	private async sendAndWait(input: {
		command: string;
		event: string;
		timeoutMs: number;
		timeoutMessage: string;
		exitMessage: string;
		fallbackError: string;
	}): Promise<Record<string, unknown>> {
		this.requireWritableCommandChannel();
		const pending = new Promise<Record<string, unknown>>((resolve, reject) => {
			const cleanup = this.observe({
				timeoutMs: input.timeoutMs,
				timeoutMessage: input.timeoutMessage,
				onEvent: (event) => {
					if (event.event === input.event) {
						cleanup();
						resolve(event);
					} else if (event.event === "error") {
						cleanup();
						const message = this.eventError(event, input.fallbackError);
						if (
							input.event === "recording-resumed" &&
							event.code === "clip-resume-rejected" &&
							typeof event.clipIndex === "number" &&
							Number.isInteger(event.clipIndex) &&
							event.clipIndex >= 0
						) {
							for (const id of this.reportedOriginals) {
								if (id.startsWith(`${event.clipIndex}:`)) this.reportedOriginals.delete(id);
							}
							reject(new NativeMacResumeRejectedError(message, event.clipIndex));
						} else reject(new Error(message));
					}
				},
				onClose: () => reject(new Error(input.exitMessage)),
				onError: reject,
			});
		});
		this.process.stdin.write(input.command);
		return pending;
	}

	private observe(input: {
		timeoutMs: number | null;
		timeoutMessage: string;
		makeTimeoutError?: (message: string) => Error;
		onEvent: (event: Record<string, unknown>) => void;
		onClose: (code: number | null) => void;
		onError?: (error: Error) => void;
	}): () => void {
		let active = true;
		const cleanup = () => {
			if (!active) return;
			active = false;
			if (timer) clearTimeout(timer);
			this.events.off("helper-event", input.onEvent);
			this.process.off("close", onClose);
			this.process.off("error", onError);
		};
		const onClose = (code: number | null) => {
			cleanup();
			input.onClose(code);
		};
		const onError = (error: Error) => {
			cleanup();
			input.onError?.(error);
		};
		const timer =
			input.timeoutMs === null
				? null
				: setTimeout(() => {
						cleanup();
						const error =
							input.makeTimeoutError?.(input.timeoutMessage) ?? new Error(input.timeoutMessage);
						input.onError?.(error);
					}, input.timeoutMs);

		this.events.on("helper-event", input.onEvent);
		this.process.once("close", onClose);
		this.process.once("error", onError);
		return cleanup;
	}

	/** Events arrive on stdout only. stderr text is kept for diagnostics but never parsed, so
	 * framework logging that lands mid-line cannot corrupt an event. */
	private attachOutputDrain(): void {
		const drain = (chunk: Buffer) => {
			const text = chunk.toString();
			this.outputBuffer = (this.outputBuffer + text).slice(-131_072);
			this.lineBuffer += text;
			const lines = this.lineBuffer.split(/\r?\n/);
			this.lineBuffer = lines.pop() ?? "";
			for (const line of lines) this.dispatchLine(line);
		};
		const keepDiagnostics = (chunk: Buffer) => {
			this.outputBuffer = (this.outputBuffer + chunk.toString()).slice(-131_072);
		};
		const cleanup = () => {
			this.process.stdout.off("data", drain);
			this.process.stderr.off("data", keepDiagnostics);
			this.process.off("close", cleanup);
			this.process.off("error", cleanup);
		};
		this.process.stdout.on("data", drain);
		this.process.stderr.on("data", keepDiagnostics);
		this.process.once("close", cleanup);
		this.process.once("error", cleanup);
	}

	private dispatchLine(line: string): void {
		const event = this.parseEvent(line.trim());
		if (!event) return;
		if (typeof event.event === "string") {
			const detail = typeof event.key === "string" ? event.key : event.code;
			const named = event.event === "warning" || typeof event.key === "string";
			this.options.onEvent?.(
				named && typeof detail === "string" ? `${event.event}:${detail}` : event.event,
			);
		}
		this.options.onProtocolEvent?.(event);
		if (event.event === "source-selected") this.sourceSelected = true;
		if (event.event === "error" && !this.recordingStarted)
			this.startupError = this.eventError(event, "Native capture failed.");
		if (event.event === "recording-started") this.recordingStarted = true;
		if (event.event === "warning") {
			console.warn(
				`[capture-mac] helper warning at ${new Date().toISOString()}:`,
				JSON.stringify(event),
			);
			this.options.onWarning?.(event);
		}
		const bounds = event.captureBounds as Rectangle | undefined;
		if (event.event === "original-started") {
			const original = parseNativeMacOriginalStarted(event);
			const id = original ? `${original.clipIndex}:${original.key}` : "";
			if (original && !this.reportedOriginals.has(id)) {
				this.reportedOriginals.add(id);
				this.options.onOriginalStarted?.(original);
			}
		}
		if (bounds && bounds.width > 0 && bounds.height > 0) this.bounds = bounds;
		if (event.event === "recording-stopped") {
			this.stoppedResult = this.stoppedResultFromEvent(event, "");
		}
		const fatalCode =
			event.event === "error" &&
			((this.options.platform === "linux" &&
				this.recordingStarted &&
				event.code !== "clip-resume-rejected" &&
				event.code !== "reconfigure-rejected") ||
				event.fatal === true ||
				event.code === "writer-failed-during-capture" ||
				event.code === "capture-stopped-with-error");
		if (fatalCode) {
			this.reportFatalError({
				code: String(event.code),
				message: String(event.message ?? "The current recording clip failed."),
			});
		}
		this.events.emit("helper-event", event);
	}

	private reportFatalError(failure: NativeMacRecordingFailure): void {
		if (this.fatalReported) return;
		this.fatalReported = true;
		this.options.onFatalError?.(failure);
	}

	private parseEvent(line: string): Record<string, unknown> | null {
		try {
			const parsed: unknown = JSON.parse(line);
			return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
		} catch {
			return null;
		}
	}

	private eventError(event: Record<string, unknown>, fallback: string): string {
		return String(event.message ?? event.code ?? fallback);
	}

	private parseWarning(value: unknown): NativeMacStopResult["warning"] {
		if (!value || typeof value !== "object") return undefined;
		const warning = value as Record<string, unknown>;
		return {
			code: String(warning.code ?? "final-clip-failed"),
			message: String(warning.message ?? "The final clip could not be saved."),
		};
	}

	private parseMetricSummary(value: unknown): NativeMacCaptureTelemetry["systemAudioDriftMs"] {
		if (!value || typeof value !== "object") return undefined;
		const summary = value as Record<string, unknown>;
		const fields = ["min", "max", "mean", "p50", "p95", "p99"] as const;
		if (
			typeof summary.count !== "number" ||
			!Number.isInteger(summary.count) ||
			summary.count < 1 ||
			fields.some((field) => typeof summary[field] !== "number" || !Number.isFinite(summary[field]))
		) {
			return undefined;
		}
		return {
			count: summary.count,
			min: summary.min as number,
			max: summary.max as number,
			mean: summary.mean as number,
			p50: summary.p50 as number,
			p95: summary.p95 as number,
			p99: summary.p99 as number,
		};
	}

	private parseCaptureTelemetry(value: unknown): NativeMacCaptureTelemetry | undefined {
		if (!value || typeof value !== "object") return undefined;
		const telemetry = value as Record<string, unknown>;
		const numericFields = [
			"requestedVideoFps",
			"deliveredVideoFps",
			"screenSamples",
			"completeScreenSamples",
			"idleScreenSamples",
			"blankScreenSamples",
			"suspendedScreenSamples",
			"startedScreenSamples",
			"stoppedScreenSamples",
			"otherScreenSamples",
			"appendedVideoFrames",
			"pendingVideoFrames",
			"appendFailures",
			"droppedVideoFrames",
			"systemAudioSamples",
			"microphoneAudioSamples",
		] as const;
		const optionalNumericFields = [
			"audioMaxQueueBytes",
			"writerMaxQueueDepth",
			"writerBackpressureEvents",
			"repeatedVideoFrames",
			"completeSourceVideoFps",
			"appendedCameraFrames",
			"originalBackpressureEvents",
			"originalMaxQueueDepth",
			"completeSourceCameraFps",
			"cameraSamples",
			"cameraDroppedFrames",
			"deliveredCameraFps",
		] as const;
		if (
			numericFields.some(
				(field) =>
					typeof telemetry[field] !== "number" ||
					!Number.isFinite(telemetry[field]) ||
					(telemetry[field] as number) < 0,
			) ||
			optionalNumericFields.some(
				(field) =>
					telemetry[field] !== undefined &&
					(typeof telemetry[field] !== "number" ||
						!Number.isFinite(telemetry[field]) ||
						(telemetry[field] as number) < 0),
			) ||
			typeof telemetry.lowPowerMode !== "boolean" ||
			!["unknown", "nominal", "fair", "serious", "critical"].includes(
				String(telemetry.thermalState),
			)
		) {
			return undefined;
		}
		const systemAudioDriftMs = this.parseMetricSummary(telemetry.systemAudioDriftMs);
		const screenTimestampDriftMs = this.parseMetricSummary(telemetry.screenTimestampDriftMs);
		const screenDeliveryAgeMs = this.parseMetricSummary(telemetry.screenDeliveryAgeMs);
		const completeScreenIntervalMs = this.parseMetricSummary(telemetry.completeScreenIntervalMs);
		const microphoneDriftMs = this.parseMetricSummary(telemetry.microphoneDriftMs);
		const fragmentFinalizeMs = this.parseMetricSummary(telemetry.fragmentFinalizeMs);
		const audioBlockMs = this.parseMetricSummary(telemetry.audioBlockMs);
		const optionalMetrics: Partial<NativeMacCaptureTelemetry> = {};
		for (const field of optionalNumericFields) {
			const value = telemetry[field];
			if (typeof value === "number") optionalMetrics[field] = value;
		}
		return {
			...optionalMetrics,
			requestedVideoFps: telemetry.requestedVideoFps as number,
			deliveredVideoFps: telemetry.deliveredVideoFps as number,
			screenSamples: telemetry.screenSamples as number,
			completeScreenSamples: telemetry.completeScreenSamples as number,
			idleScreenSamples: telemetry.idleScreenSamples as number,
			blankScreenSamples: telemetry.blankScreenSamples as number,
			suspendedScreenSamples: telemetry.suspendedScreenSamples as number,
			startedScreenSamples: telemetry.startedScreenSamples as number,
			stoppedScreenSamples: telemetry.stoppedScreenSamples as number,
			otherScreenSamples: telemetry.otherScreenSamples as number,
			appendedVideoFrames: telemetry.appendedVideoFrames as number,
			pendingVideoFrames: telemetry.pendingVideoFrames as number,
			appendFailures: telemetry.appendFailures as number,
			droppedVideoFrames: telemetry.droppedVideoFrames as number,
			systemAudioSamples: telemetry.systemAudioSamples as number,
			microphoneAudioSamples: telemetry.microphoneAudioSamples as number,
			...(typeof telemetry.audioMaxQueueBytes === "number"
				? { audioMaxQueueBytes: telemetry.audioMaxQueueBytes }
				: {}),
			...(typeof telemetry.writerMaxQueueDepth === "number"
				? { writerMaxQueueDepth: telemetry.writerMaxQueueDepth }
				: {}),
			lowPowerMode: telemetry.lowPowerMode as boolean,
			thermalState: telemetry.thermalState as NativeMacCaptureTelemetry["thermalState"],
			...(systemAudioDriftMs ? { systemAudioDriftMs } : {}),
			...(screenTimestampDriftMs ? { screenTimestampDriftMs } : {}),
			...(screenDeliveryAgeMs ? { screenDeliveryAgeMs } : {}),
			...(completeScreenIntervalMs ? { completeScreenIntervalMs } : {}),
			...(microphoneDriftMs ? { microphoneDriftMs } : {}),
			...(fragmentFinalizeMs ? { fragmentFinalizeMs } : {}),
			...(audioBlockMs ? { audioBlockMs } : {}),
		};
	}

	private stoppedResultFromEvent(
		event: Record<string, unknown>,
		fallbackScreenPath: string,
	): NativeMacStopResult {
		const clips = Array.isArray(event.clips)
			? event.clips
					.map(parseNativeMacRecordingClip)
					.filter((clip): clip is RecordingSessionClip => clip !== null)
			: [];
		const warning = this.parseWarning(event.warning);
		const telemetry = this.parseCaptureTelemetry(event.telemetry);
		return {
			screenPath: String(event.screenPath ?? fallbackScreenPath),
			clips,
			...(warning ? { warning } : {}),
			...(telemetry ? { telemetry } : {}),
		};
	}

	private requireWritableCommandChannel(): void {
		if (!this.process.stdin.writable) {
			throw new Error("Native capture command channel is closed.");
		}
	}

	private waitForClose(timeoutMs: number): Promise<boolean> {
		if (!this.isRunning()) return Promise.resolve(true);
		return new Promise((resolve) => {
			let settled = false;
			const finish = (closed: boolean) => {
				if (settled) return;
				settled = true;
				if (timer) clearTimeout(timer);
				this.process.off("close", onClose);
				resolve(closed);
			};
			const onClose = () => finish(true);
			const timer = setTimeout(() => finish(!this.isRunning()), timeoutMs);
			this.process.once("close", onClose);
			if (!this.isRunning()) finish(true);
		});
	}
}
