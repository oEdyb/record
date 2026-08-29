import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import type { Rectangle } from "electron";
import {
	type NativeMacCaptureTelemetry,
	type NativeMacRecordingFailure,
	type NativeMacRecordingRequest,
	parseNativeMacRecordingClip,
} from "../../src/lib/nativeMacRecording";
import type { RecordingSessionClip } from "../../src/lib/recordingSession";

export type NativeMacStopResult = {
	screenPath: string;
	clips: RecordingSessionClip[];
	warning?: { code: string; message: string };
	telemetry?: NativeMacCaptureTelemetry;
};

type NativeMacHelperClientOptions = {
	onFatalError?: (failure: NativeMacRecordingFailure) => void;
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

/** One process-local protocol client. Late events cannot affect the next helper. */
export class NativeMacHelperClient {
	private readonly events = new EventEmitter();
	private outputBuffer = "";
	private lineBuffer = "";
	private bounds: Rectangle | null = null;
	private closed = false;
	private fatalReported = false;
	private stoppedResult: NativeMacStopResult | null = null;

	constructor(
		private readonly process: ChildProcessWithoutNullStreams,
		private readonly options: NativeMacHelperClientOptions = {},
	) {
		this.process.once("close", () => {
			this.closed = true;
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

		const gracefulExit = this.waitForClose(1_000);
		this.process.kill("SIGTERM");
		if (await gracefulExit) return;

		const forcedExit = this.waitForClose(1_000);
		this.process.kill("SIGKILL");
		if (await forcedExit) return;

		throw new Error("The native macOS capture helper did not exit after SIGKILL.");
	}

	async waitForStart(): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			const cleanup = this.observe({
				timeoutMs: 10_000,
				timeoutMessage: "Timed out waiting for native macOS capture to start",
				onEvent: (event) => {
					if (event.event === "recording-started") {
						cleanup();
						resolve();
					} else if (event.event === "error") {
						cleanup();
						reject(new Error(this.eventError(event, "Native macOS capture failed")));
					}
				},
				onClose: (code) => {
					cleanup();
					reject(
						new Error(
							this.outputBuffer.trim() ||
								`Native macOS capture exited before recording started (code=${code ?? "unknown"})`,
						),
					);
				},
				onError: reject,
			});
			this.replayBufferedEvents();
		});
	}

	async pause(): Promise<RecordingSessionClip | undefined> {
		this.requireWritableCommandChannel();
		const pending = new Promise<RecordingSessionClip | undefined>((resolve, reject) => {
			let finalizedClip: RecordingSessionClip | undefined;
			const cleanup = this.observe({
				timeoutMs: 30_000,
				timeoutMessage: "Timed out while finalizing the current macOS recording clip",
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
								this.eventError(event, "Native macOS pause failed"),
								event.code === "clip-finalize-failed",
								finalizedClip,
							),
						);
					}
				},
				onClose: () => reject(new Error("Native macOS capture exited while finalizing a clip")),
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
			timeoutMessage: "Timed out while applying the next macOS clip setup",
			exitMessage: "Native macOS capture exited while applying the next clip setup",
			fallbackError: "Native macOS reconfiguration failed",
		});
	}

	async resume(): Promise<number> {
		const event = await this.sendAndWait({
			command: "resume\n",
			event: "recording-resumed",
			timeoutMs: 10_000,
			timeoutMessage: "Timed out while starting the next macOS recording clip",
			exitMessage: "Native macOS capture exited while starting the next clip",
			fallbackError: "Native macOS resume failed",
		});
		const clipIndex = event.clipIndex;
		if (typeof clipIndex !== "number" || !Number.isInteger(clipIndex) || clipIndex < 0) {
			throw new Error("Native macOS resume did not return a valid clip index.");
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
				timeoutMessage: `Timed out waiting for native macOS capture to stop. Output path: ${fallback.screenPath}. Output: ${this.outputBuffer.trim()}`,
				onEvent: (event) => {
					if (event.event === "recording-stopped") {
						cleanup();
						resolve(this.stoppedResultFromEvent(event, fallback.screenPath));
					} else if (event.event === "error" && event.code !== "writer-failed-during-capture") {
						cleanup();
						reject(new Error(this.eventError(event, "Native macOS capture failed")));
					}
				},
				onClose: (code) => {
					cleanup();
					if (code === 0) {
						resolve({ screenPath: fallback.screenPath, clips: fallback.clips });
					} else {
						reject(
							new Error(
								this.outputBuffer.trim() ||
									`Native macOS capture exited with code=${code ?? "unknown"}`,
							),
						);
					}
				},
				onError: reject,
			});
		});
		// Register the waiter before the helper can answer.
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
						reject(new Error(this.eventError(event, input.fallbackError)));
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
		timeoutMs: number;
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
			clearTimeout(timer);
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
		const timer = setTimeout(() => {
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

	private attachOutputDrain(): void {
		const drain = (chunk: Buffer) => {
			const text = chunk.toString();
			this.outputBuffer += text;
			this.lineBuffer += text;
			const lines = this.lineBuffer.split(/\r?\n/);
			this.lineBuffer = lines.pop() ?? "";
			for (const line of lines) this.dispatchLine(line);
		};
		const cleanup = () => {
			this.process.stdout.off("data", drain);
			this.process.stderr.off("data", drain);
			this.process.off("close", cleanup);
			this.process.off("error", cleanup);
		};
		this.process.stdout.on("data", drain);
		this.process.stderr.on("data", drain);
		this.process.once("close", cleanup);
		this.process.once("error", cleanup);
	}

	private replayBufferedEvents(): void {
		for (const line of this.outputBuffer.split(/\r?\n/)) this.dispatchLine(line);
	}

	private dispatchLine(line: string): void {
		const event = this.parseEvent(line.trim());
		if (!event) return;
		const bounds = event.captureBounds as Rectangle | undefined;
		if (bounds && bounds.width > 0 && bounds.height > 0) this.bounds = bounds;
		if (event.event === "recording-stopped") {
			this.stoppedResult = this.stoppedResultFromEvent(event, "");
		}
		const fatalCode =
			event.event === "error" &&
			(event.code === "writer-failed-during-capture" ||
				event.code === "capture-stopped-with-error");
		if (fatalCode && !this.fatalReported) {
			this.fatalReported = true;
			this.options.onFatalError?.({
				code: String(event.code),
				message: String(event.message ?? "The current macOS recording clip failed."),
			});
		}
		this.events.emit("helper-event", event);
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
		if (
			numericFields.some(
				(field) =>
					typeof telemetry[field] !== "number" ||
					!Number.isFinite(telemetry[field]) ||
					(telemetry[field] as number) < 0,
			) ||
			(telemetry.audioMaxQueueBytes !== undefined &&
				(typeof telemetry.audioMaxQueueBytes !== "number" ||
					!Number.isFinite(telemetry.audioMaxQueueBytes) ||
					telemetry.audioMaxQueueBytes < 0)) ||
			(telemetry.writerMaxQueueDepth !== undefined &&
				(typeof telemetry.writerMaxQueueDepth !== "number" ||
					!Number.isFinite(telemetry.writerMaxQueueDepth) ||
					telemetry.writerMaxQueueDepth < 0)) ||
			typeof telemetry.lowPowerMode !== "boolean" ||
			!["unknown", "nominal", "fair", "serious", "critical"].includes(
				String(telemetry.thermalState),
			)
		) {
			return undefined;
		}
		const systemAudioDriftMs = this.parseMetricSummary(telemetry.systemAudioDriftMs);
		const screenTimestampDriftMs = this.parseMetricSummary(telemetry.screenTimestampDriftMs);
		const microphoneDriftMs = this.parseMetricSummary(telemetry.microphoneDriftMs);
		const fragmentFinalizeMs = this.parseMetricSummary(telemetry.fragmentFinalizeMs);
		const audioBlockMs = this.parseMetricSummary(telemetry.audioBlockMs);
		return {
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
			throw new Error("Native macOS capture command channel is closed.");
		}
	}

	private waitForClose(timeoutMs: number): Promise<boolean> {
		if (!this.isRunning()) return Promise.resolve(true);
		return new Promise((resolve) => {
			let settled = false;
			const finish = (closed: boolean) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
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
