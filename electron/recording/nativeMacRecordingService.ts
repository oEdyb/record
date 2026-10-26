import fs from "node:fs/promises";
import path from "node:path";
import {
	mergeNativeMacStoppedClips,
	removePreviousNativeMacClip,
	restoreRemovedNativeMacClip,
} from "../../src/lib/nativeMacClipSession";
import type {
	NativeMacCaptureTelemetry,
	NativeMacOriginalStarted,
	NativeMacRecordingFailure,
	NativeMacRecordingRequest,
	NativeMacRecordingStartResult,
} from "../../src/lib/nativeMacRecording";
import type {
	CursorCaptureMode,
	RecordingSession,
	RecordingSessionClip,
} from "../../src/lib/recordingSession";
import { normalizeRecordingOriginals } from "../../src/lib/recordingSession";
import { writeJsonDurably } from "../filesystem/durableJson";
import {
	NativeMacHelperClient,
	NativeMacPauseError,
	NativeMacResumeRejectedError,
} from "./nativeMacHelperClient";
import {
	clearNativeMacRecoveryJournal,
	nativeMacJournalCoveredBy,
	persistNativeMacRecoveryJournal,
	restoreNativeMacRecoverySession,
} from "./nativeMacRecoveryJournal";
import {
	freeDiskBytes,
	helperImportantUsageBytes,
	RecordingStorageMonitor,
	type RecordingStorageStatus,
	storageStartError,
} from "./recordingStorage";

const RECORDING_FILE_PREFIX = "recording-";
const RECORDING_SESSION_SUFFIX = ".session.json";

type ResolvedCapture = {
	config: NativeMacRecordingRequest;
	cursorCaptureMode: CursorCaptureMode;
};

export type NativeMacCaptureHelper = Pick<
	NativeMacHelperClient,
	| "captureBounds"
	| "output"
	| "isRunning"
	| "kill"
	| "waitForStart"
	| "pause"
	| "reconfigure"
	| "resume"
	| "stop"
> &
	Partial<Pick<NativeMacHelperClient, "waitForSourceSelected" | "arm">>;

export type NativeMacRecordingServiceDependencies = {
	/** Names each start step as it finishes, for the start timing log. */
	onStartStage?: (stage: string) => void;
	/** Names each Stop step as it finishes, for the stop timing log. */
	onStopStage?: (stage: string) => void;
	recordingsDir: string;
	now: () => number;
	findHelperPath: () => Promise<string | null>;
	createHelper: (
		helperPath: string,
		config: NativeMacRecordingRequest,
		onFatalError: (failure: NativeMacRecordingFailure) => void,
		onOriginalStarted: (original: NativeMacOriginalStarted) => void,
	) => NativeMacCaptureHelper;
	resolveCapture: (
		request: NativeMacRecordingRequest,
		recordingId: number,
		outputPath: string,
	) => ResolvedCapture;
	prepareCapturePermissions: (request: NativeMacRecordingRequest) => Promise<void>;
	startCursor: (startTimeMs: number) => Promise<boolean>;
	stopCursor: () => Promise<void>;
	clearCursor: () => void;
	finalizeCursor: (input: {
		clips: RecordingSessionClip[];
		pauseRanges: Array<{ startMs: number; endMs: number }>;
		offsetMs: number;
	}) => Promise<void>;
	registerMediaLinks: (
		screenVideoPath: string,
		cursorCaptureMode: CursorCaptureMode,
	) => Promise<void>;
	onSessionStored: (session: RecordingSession) => void;
	onRecordingStateChange: (recording: boolean) => void;
	onFatalError: (failure: NativeMacRecordingFailure) => void;
	/** The app stopped a take on its own; the HUD still shows it recording until told. */
	onAppStopped?: (recordingId: number, signal: AbortSignal) => void | Promise<void>;
	pendingRendererRecordingId?: () => number | null;
	freeDiskBytes?: (directory: string) => Promise<number>;
	/** Minutes of space left at the current write rate fell to 5 or 1. */
	onStorageLow?: (status: RecordingStorageStatus) => void;
	/** Free space is nearly gone; the live clip must close while it still can. */
	onStorageCritical?: (status: RecordingStorageStatus) => void;
};

export type NativeMacRecordingStopResult = {
	success: boolean;
	path?: string;
	session?: RecordingSession;
	message?: string;
	warning?: string;
	discarded?: boolean;
	error?: string;
	telemetry?: NativeMacCaptureTelemetry;
};

/** Owns one native recording and serializes its lifecycle commands. */
export class NativeMacRecordingService {
	private prepared = false;
	private preparationToken = 0;
	private preparing = false;
	private helper: NativeMacCaptureHelper | null = null;
	private targetPath: string | null = null;
	private recordingId: number | null = null;
	private captureConfig: NativeMacRecordingRequest | null = null;
	private cursorOffsetMs = 0;
	private cursorCaptureMode: CursorCaptureMode = "editable-overlay";
	private cursorRecordingStartMs = 0;
	private cursorTelemetryStarted = false;
	private clipCursorModes = new Map<number, CursorCaptureMode>();
	private pauseStartedAtMs: number | null = null;
	private pauseRanges: Array<{ startMs: number; endMs: number }> = [];
	private paused = false;
	private clips: RecordingSessionClip[] = [];
	private activeClipIndex: number | null = null;
	private fatalError: NativeMacRecordingFailure | null = null;
	private commandChain: Promise<void> = Promise.resolve();
	private lastDiagnosticOutput = "";
	private sessionGeneration = 0;
	private originals = new Map<number, Partial<RecordingSessionClip>>();
	private rendererWebcamPaths = new Set<string>();
	private recoveryWrites: Promise<void> = Promise.resolve();
	private acceptsOriginalMetadata = false;
	/** A take the app stopped on its own (quit), kept until the HUD's own Stop collects it. */
	private appStoppedResult: NativeMacRecordingStopResult | null = null;
	private stopOperation: Promise<NativeMacRecordingStopResult> | null = null;
	private readonly storage: RecordingStorageMonitor;

	constructor(private readonly deps: NativeMacRecordingServiceDependencies) {
		this.storage = new RecordingStorageMonitor({
			directory: deps.recordingsDir,
			now: deps.now,
			freeBytes: (directory) => this.freeDiskBytes(directory),
			onLow: (status) => deps.onStorageLow?.(status),
			onCritical: (status) => {
				if (this.isRunning() && !this.paused) deps.onStorageCritical?.(status);
			},
		});
	}

	private freeDiskBytes(directory: string): Promise<number> {
		if (this.deps.freeDiskBytes) return this.deps.freeDiskBytes(directory);
		return freeDiskBytes(directory, async (target) => {
			const helperPath = await this.deps.findHelperPath();
			return helperPath ? helperImportantUsageBytes(helperPath, target) : null;
		});
	}

	get captureBounds() {
		return this.helper?.captureBounds ?? null;
	}

	get diagnosticOutput(): string {
		return this.helper?.output ?? this.lastDiagnosticOutput;
	}

	isRunning(): boolean {
		return Boolean(this.helper?.isRunning());
	}

	/** Committed clips with a microphone original, for the on-demand transcript. */
	transcriptClipListing(): {
		recordingId: number | null;
		clips: Array<{ index: number; microphoneAudioPath: string; durationMs: number }>;
		live: boolean;
	} {
		return {
			recordingId: this.recordingId,
			clips: this.clips.flatMap((clip) =>
				!clip.removed && clip.microphoneAudioPath
					? [
							{
								index: clip.index,
								microphoneAudioPath: clip.microphoneAudioPath,
								durationMs: clip.durationMs,
							},
						]
					: [],
			),
			live: this.isRunning() && !this.paused,
		};
	}

	prepare(request: NativeMacRecordingRequest): Promise<NativeMacRecordingStartResult> {
		if (this.isRunning() || this.preparing)
			return Promise.resolve({
				success: false,
				error: "Native capture is already running or preparing.",
			});
		this.preparing = true;
		return this.start({ ...request, deferStart: true });
	}

	/** Deliberately outside the command queue: source selection has no deadline. */
	async cancelPrepare(): Promise<void> {
		if (!this.preparing && !this.prepared) return;
		this.preparationToken += 1;
		this.preparing = false;
		this.prepared = false;
		await this.helper?.kill();
	}

	start(request: NativeMacRecordingRequest): Promise<NativeMacRecordingStartResult> {
		const preparationToken = this.preparationToken;
		return this.enqueue(async () => {
			if (this.prepared && !request.deferStart) {
				try {
					const helper = this.requireHelper();
					if (
						request.recordingId !== this.recordingId ||
						!this.targetPath ||
						this.recordingId === null
					)
						throw new Error("Prepared capture belongs to a different recording.");
					const { config } = this.deps.resolveCapture(request, this.recordingId, this.targetPath);
					if (this.captureConfigKey(config) !== this.captureConfigKey(this.captureConfig))
						throw new Error("Capture settings changed after portal selection. Start again.");
					if (!helper.arm) throw new Error("Native capture does not support deferred start.");
					this.prepared = false;
					helper.arm();
					await helper.waitForStart();
					await this.recoveryWrites;
					if (!helper.isRunning() || this.fatalError)
						throw new Error(this.fatalError?.message ?? "Native capture exited during startup.");
					this.cursorOffsetMs = Math.max(0, this.deps.now() - this.cursorRecordingStartMs);
					this.storage.start();
					this.deps.onRecordingStateChange(true);
					return { success: true, recordingId: this.recordingId, path: this.targetPath };
				} catch (error) {
					await this.helper?.kill();
					this.reset();
					return { success: false, error: this.errorMessage(error) };
				}
			}
			if (this.isRunning()) {
				return { success: false, error: "Native capture is already running." };
			}
			this.appStoppedResult = null;
			const helperPath = await this.deps.findHelperPath();
			if (!helperPath) {
				this.preparing = false;
				return { success: false, error: "Native capture helper is not available." };
			}
			if (!request?.source?.sourceId && request.platform !== "linux") {
				this.preparing = false;
				return { success: false, error: "Native capture request is missing a source." };
			}

			try {
				const recordingId = Number.isFinite(request.recordingId)
					? (request.recordingId as number)
					: this.deps.now();
				const outputPath = path.join(
					this.deps.recordingsDir,
					`${RECORDING_FILE_PREFIX}${recordingId}-clip-0001.mp4`,
				);
				let { config, cursorCaptureMode } = this.deps.resolveCapture(
					request,
					recordingId,
					outputPath,
				);
				await this.deps.prepareCapturePermissions(request);
				this.deps.onStartStage?.("permissions-checked");
				await fs.mkdir(this.deps.recordingsDir, { recursive: true });
				const storageError = storageStartError(await this.freeDiskBytes(this.deps.recordingsDir));
				if (storageError) {
					this.preparing = false;
					return { success: false, error: storageError };
				}

				const cursorStartTimeMs = this.deps.now();
				if (cursorCaptureMode === "editable-overlay") {
					this.cursorTelemetryStarted = await this.deps.startCursor(cursorStartTimeMs);
					if (!this.cursorTelemetryStarted) {
						cursorCaptureMode = "system";
						config = this.withSystemCursor(config);
						this.deps.clearCursor();
					}
				} else {
					this.deps.clearCursor();
				}
				this.initializeSession(recordingId, outputPath, config, cursorCaptureMode);
				this.deps.onStartStage?.("cursor-ready");
				await this.persistRecoverySession();
				this.deps.onStartStage?.("recovery-saved");
				this.cursorRecordingStartMs = cursorStartTimeMs;
				this.cursorTelemetryStarted = cursorCaptureMode === "editable-overlay";

				if (request.deferStart && preparationToken !== this.preparationToken)
					throw new Error("Source selection cancelled.");
				const generation = this.sessionGeneration;
				const helper = this.deps.createHelper(
					helperPath,
					config,
					(failure) => {
						if (generation !== this.sessionGeneration) return;
						this.paused = true;
						this.fatalError = failure;
						void this.persistRecoverySession().catch((error) => {
							console.warn("[capture-mac] could not preserve interruption status:", error);
						});
						this.deps.onFatalError(failure);
					},
					(original) => this.storeOriginalStarted(original, generation),
				);
				this.helper = helper;
				this.deps.onStartStage?.("helper-spawned");
				if (request.deferStart) {
					if (!helper.waitForSourceSelected)
						throw new Error("Native capture does not support source preparation.");
					await helper.waitForSourceSelected();
					if (preparationToken !== this.preparationToken || !helper.isRunning())
						throw new Error("Source selection cancelled.");
					this.preparing = false;
					this.prepared = true;
					return { success: true, recordingId, path: outputPath, helperPath };
				}
				await helper.waitForStart();
				// The journal written before the helper spawned already covers this clip. Originals
				// reported before readiness queued their own entries; wait only for those instead of
				// a further durable rewrite on the way to the HUD's first second.
				await this.recoveryWrites;
				this.deps.onStartStage?.("recovery-updated");
				if (!helper.isRunning() || this.fatalError) {
					throw new Error(this.fatalError?.message ?? "Native capture exited during startup.");
				}
				this.cursorOffsetMs = Math.max(0, this.deps.now() - cursorStartTimeMs);
				this.storage.start();
				this.deps.onRecordingStateChange(true);
				return { success: true, recordingId, path: outputPath, helperPath };
			} catch (error) {
				const failedRecordingId = this.recordingId;
				await this.deps.stopCursor();
				// A helper that outlives its kill window must not leave the service
				// claiming a running capture; finish the cleanup and report both errors.
				const terminationError = await this.helper?.kill().then(
					() => null,
					(killError: unknown) => killError,
				);
				this.acceptsOriginalMetadata = false;
				await this.recoveryWrites.catch(() => undefined);
				if (
					failedRecordingId !== null &&
					!(await restoreNativeMacRecoverySession(this.deps.recordingsDir, failedRecordingId))
				) {
					await this.serializeRecoveryMutation(() =>
						clearNativeMacRecoveryJournal(this.deps.recordingsDir, failedRecordingId),
					).catch(() => undefined);
				}
				this.reset();
				return {
					success: false,
					error: terminationError
						? `${this.errorMessage(error)} ${this.errorMessage(terminationError)}`
						: this.errorMessage(error),
				};
			}
		});
	}

	/** Quitting mid-take stops the capture so its clips finalize normally. The
	 * recovery journal still covers a helper that does not answer in time. */
	async stopBeforeQuit(timeoutMs = 15_000): Promise<boolean> {
		if (this.prepared || this.preparing) {
			await this.cancelPrepare();
			return false;
		}
		const existingStop = this.stopOperation;
		const recordingId = this.recordingId ?? this.deps.pendingRendererRecordingId?.() ?? null;
		if (!this.isRunning() && !existingStop && recordingId === null) return false;
		const stop = existingStop ?? (this.helper ? this.stop(false) : null);
		const completion = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		await Promise.race([
			Promise.resolve(stop)
				.then(async (result) => {
					if (result && !existingStop) this.appStoppedResult = result;
					if (recordingId !== null && !completion.signal.aborted)
						await this.deps.onAppStopped?.(recordingId, completion.signal);
				})
				.catch((error: unknown) => {
					console.warn("[capture-mac] Stop before quit failed:", error);
				}),
			new Promise<void>((resolve) => {
				timer = setTimeout(() => {
					console.warn(
						`[capture-mac] Stop before quit did not finish in ${timeoutMs} ms; camera sources may be incomplete; quitting.`,
					);
					completion.abort();
					resolve();
				}, timeoutMs);
			}),
		]);
		clearTimeout(timer);
		completion.abort();
		return true;
	}

	pause() {
		return this.enqueue(async () => {
			const helper = this.requireHelper();
			if (this.paused) return { success: true };
			let finalizedClip: RecordingSessionClip | undefined;
			try {
				this.pauseStartedAtMs = this.deps.now();
				finalizedClip = await helper.pause();
				this.paused = true;
				if (finalizedClip) {
					finalizedClip = {
						...finalizedClip,
						cursorCaptureMode:
							this.clipCursorModes.get(finalizedClip.index) ?? this.cursorCaptureMode,
					};
					if (!this.clips.some((clip) => clip.index === finalizedClip?.index)) {
						this.clips.push(finalizedClip);
						this.clips.sort((a, b) => a.index - b.index);
					}
				}
				this.activeClipIndex = null;
				await this.persistLiveSession();
				return { success: true, clip: finalizedClip, paused: true };
			} catch (error) {
				const helperPaused = error instanceof NativeMacPauseError && error.helperPaused;
				// Record the helper's state before saving: a failed save must not leave
				// the HUD counting while the helper has stopped writing.
				if (helperPaused) this.paused = true;
				else if (!this.paused) this.pauseStartedAtMs = null;
				if (error instanceof NativeMacPauseError && error.clip) {
					finalizedClip = {
						...error.clip,
						cursorCaptureMode: this.clipCursorModes.get(error.clip.index) ?? this.cursorCaptureMode,
					};
					if (!this.clips.some((clip) => clip.index === finalizedClip?.index)) {
						this.clips.push(finalizedClip);
						this.clips.sort((a, b) => a.index - b.index);
					}
					this.activeClipIndex = null;
					await this.persistLiveSession().catch((persistError: unknown) => {
						console.warn(
							"[capture-mac] could not save the session after Pause failed:",
							persistError,
						);
					});
				}
				return {
					success: false,
					...(finalizedClip ? { clip: finalizedClip } : {}),
					paused: this.paused,
					error: this.errorMessage(error),
				};
			}
		});
	}

	/** Rebuilds the capture while the user is still choosing, so Continue only resumes. */
	prepareResume(request: NativeMacRecordingRequest) {
		return this.enqueue(async () => {
			const helper = this.helper;
			if (
				!helper ||
				!this.paused ||
				this.fatalError ||
				this.recordingId === null ||
				!this.targetPath ||
				(!request.source?.sourceId && request.platform !== "linux")
			) {
				return { success: true, prepared: false };
			}
			try {
				await this.deps.prepareCapturePermissions(request);
				const { config } = this.deps.resolveCapture(request, this.recordingId, this.targetPath);
				if (this.captureConfigKey(config) !== this.captureConfigKey(this.captureConfig)) {
					await helper.reconfigure(config);
					this.captureConfig = config;
				}
				return { success: true, prepared: true };
			} catch (error) {
				return { success: false, prepared: false, error: this.errorMessage(error) };
			}
		});
	}

	resume(request?: NativeMacRecordingRequest) {
		return this.enqueue(async () => {
			const helper = this.requireHelper();
			if (!this.paused) return { success: true };
			let resumeRequested = false;
			try {
				const storageError = storageStartError(await this.freeDiskBytes(this.deps.recordingsDir));
				if (storageError) return { success: false, paused: true, error: storageError };
				if (request) {
					if (
						this.recordingId === null ||
						!this.targetPath ||
						(!request.source?.sourceId && request.platform !== "linux")
					) {
						return { success: false, error: "The next clip setup is incomplete." };
					}
					await this.deps.prepareCapturePermissions(request);
					let { config, cursorCaptureMode } = this.deps.resolveCapture(
						request,
						this.recordingId,
						this.targetPath,
					);
					if (cursorCaptureMode === "editable-overlay" && !this.cursorTelemetryStarted) {
						this.cursorTelemetryStarted = await this.deps.startCursor(this.cursorRecordingStartMs);
						if (!this.cursorTelemetryStarted) {
							cursorCaptureMode = "system";
							config = this.withSystemCursor(config);
							this.deps.clearCursor();
						}
					}
					if (this.captureConfigKey(config) !== this.captureConfigKey(this.captureConfig)) {
						await helper.reconfigure(config);
						this.captureConfig = config;
					}
					this.cursorCaptureMode = cursorCaptureMode;
				}
				resumeRequested = true;
				const clipIndex = await helper.resume();
				this.completeCursorPauseRange();
				this.paused = false;
				this.activeClipIndex = clipIndex;
				this.clipCursorModes.set(clipIndex, this.cursorCaptureMode);
				this.storage.rearm();
				await this.persistRecoverySession();
				return { success: true, clipIndex };
			} catch (error) {
				const rejectedIndex =
					error instanceof NativeMacResumeRejectedError ? error.clipIndex : null;
				let safelyPaused =
					resumeRequested &&
					rejectedIndex !== null &&
					rejectedIndex ===
						Math.max(this.activeClipIndex ?? -1, ...this.clips.map((clip) => clip.index)) + 1 &&
					helper.isRunning() &&
					!this.fatalError;
				if (safelyPaused && rejectedIndex !== null) {
					const metadataChanged = this.originals.delete(rejectedIndex);
					this.clipCursorModes.delete(rejectedIndex);
					try {
						if (metadataChanged) await this.persistRecoverySession();
					} catch (recoveryError) {
						if (!this.fatalError) {
							this.fatalError = {
								code: "capture-recovery-failed",
								message: `Rejected clip recovery metadata could not be cleared: ${this.errorMessage(recoveryError)}`,
							};
							this.deps.onFatalError(this.fatalError);
						}
						return { success: false, error: this.fatalError.message };
					}
					safelyPaused = helper.isRunning() && !this.fatalError;
				}
				if (resumeRequested && !this.fatalError && !safelyPaused) {
					this.fatalError = { code: "capture-resume-failed", message: this.errorMessage(error) };
					this.deps.onFatalError(this.fatalError);
				}
				return {
					success: false,
					...(safelyPaused ? { paused: true } : {}),
					error: this.errorMessage(error),
				};
			}
		});
	}

	removePreviousClip() {
		return this.enqueue(async () => {
			this.requireHelper();
			const removal = removePreviousNativeMacClip(this.clips);
			if (!removal.removed) return { success: true };
			const previousClips = this.clips;
			this.clips = removal.clips;
			try {
				// The recovery journal is the crash-time authority. Commit it before
				// reporting success so a stale journal can never resurrect this clip.
				await this.persistRecoverySession();
			} catch (error) {
				this.clips = previousClips;
				throw error;
			}
			await this.persistManifestBestEffort();
			return { success: true, clip: removal.removed };
		});
	}

	restoreRemovedClip(clipIndex: number) {
		return this.enqueue(async () => {
			this.requireHelper();
			if (!Number.isSafeInteger(clipIndex) || clipIndex < 0) {
				throw new Error("The clip to restore is invalid.");
			}
			const restoration = restoreRemovedNativeMacClip(this.clips, clipIndex);
			if (!restoration.restored) {
				throw new Error("The removed clip is no longer available to restore.");
			}
			const previousClips = this.clips;
			this.clips = restoration.clips;
			try {
				await this.persistRecoverySession();
			} catch (error) {
				this.clips = previousClips;
				throw error;
			}
			await this.persistManifestBestEffort();
			return { success: true, clip: restoration.restored };
		});
	}

	stop(discard = false): Promise<NativeMacRecordingStopResult> {
		if (this.stopOperation) return this.stopOperation;
		const operation = this.enqueue(async () => {
			const helper = this.helper;
			if (!helper) {
				const appStopped = this.appStoppedResult;
				this.appStoppedResult = null;
				if (appStopped && !discard) return appStopped;
				return { success: false, error: "Native capture is not running." };
			}
			const preferredPath = this.targetPath;
			const recordingId = this.recordingId ?? this.deps.now();
			const cursorCaptureMode = this.cursorCaptureMode;
			let stoppedPaths: string[] = [];
			try {
				this.completeCursorPauseRange();
				await this.recoveryWrites.catch(() => undefined);
				let stopped: Awaited<ReturnType<NativeMacCaptureHelper["stop"]>>;
				try {
					if (!helper.isRunning()) throw new Error("The native capture helper exited early.");
					this.deps.onStopStage?.("helper-stop-sent");
					stopped = await helper.stop({
						screenPath: preferredPath ?? "",
						clips: this.clips,
					});
					this.acceptsOriginalMetadata = false;
					await this.recoveryWrites.catch(() => undefined);
					stoppedPaths = [stopped.screenPath, ...stopped.clips.map((clip) => clip.screenVideoPath)];
					this.deps.onStopStage?.("helper-stopped");
				} catch (error) {
					await helper.kill();
					this.acceptsOriginalMetadata = false;
					await this.recoveryWrites.catch(() => undefined);
					const recoveredSession = discard
						? null
						: await restoreNativeMacRecoverySession(this.deps.recordingsDir, recordingId);
					const recoveredClips = recoveredSession?.clips ?? this.clips;
					if (!discard && !recoveredClips.some((clip) => !clip.removed)) throw error;
					const recoveredActiveClip = recoveredClips.some(
						(clip) => !clip.removed && clip.provisionalDuration,
					);
					stopped = {
						screenPath: recoveredSession?.screenVideoPath ?? preferredPath ?? "",
						clips: recoveredClips,
						...(!discard
							? {
									warning: {
										code: "capture-stop-failed",
										message: [
											recoveredActiveClip
												? `The active clip was recovered from fragmented MP4 after capture stopped unexpectedly: ${this.errorMessage(error)}`
												: `The active clip could not be recovered: ${this.errorMessage(error)}`,
											...(recoveredSession?.recoveryWarnings ?? []),
										].join(" "),
									},
								}
							: {}),
					};
				}
				this.clips = mergeNativeMacStoppedClips(stopped.clips, this.clips).map((clip) => {
					const camera = this.originals.get(clip.index);
					return {
						...(camera?.webcamVideoPath && this.rendererWebcamPaths.has(camera.webcamVideoPath)
							? { webcamVideoPath: camera.webcamVideoPath, webcamOffsetMs: camera.webcamOffsetMs }
							: {}),
						...clip,
						cursorCaptureMode:
							clip.cursorCaptureMode ??
							this.clipCursorModes.get(clip.index) ??
							this.cursorCaptureMode,
					};
				});
				if (!discard) {
					// Probing every source takes ~130 ms; skip it when the helper's final
					// event already reported everything the journal knows about.
					const recovery = (await nativeMacJournalCoveredBy(
						this.deps.recordingsDir,
						recordingId,
						this.clips,
					))
						? null
						: await restoreNativeMacRecoverySession(this.deps.recordingsDir, recordingId);
					// A failed original finalization can still leave readable fragments.
					// Keep the committed screen duration; only attach explicitly timed,
					// validated originals that its final event could not include.
					this.clips = this.clips.map((clip) => {
						if (clip.removed) return clip;
						const recovered = recovery?.clips?.find(
							(candidate) => candidate.index === clip.index && !candidate.removed,
						);
						return recovered ? { ...normalizeRecordingOriginals(recovered), ...clip } : clip;
					});
					const recoveredTail = recovery?.clips?.find(
						(clip) =>
							!clip.removed &&
							clip.provisionalDuration &&
							!this.clips.some((known) => known.index === clip.index),
					);
					if (recoveredTail) {
						this.clips.push(recoveredTail);
						this.clips.sort((left, right) => left.index - right.index);
						const recoveryMessage =
							"The unfinished active clip was recovered from its fragmented MP4.";
						stopped = {
							...stopped,
							screenPath: recovery?.screenVideoPath ?? stopped.screenPath,
							warning: {
								code: stopped.warning?.code ?? "fragmented-clip-recovered",
								message: [stopped.warning?.message, recoveryMessage].filter(Boolean).join(" "),
							},
						};
					}
				}
				if (this.cursorTelemetryStarted) await this.deps.stopCursor();
				else this.deps.clearCursor();
				this.deps.onStopStage?.("cursor-stopped");
				if (discard) {
					this.deps.clearCursor();
					const discoveredPaths = await this.findSessionMediaPaths(recordingId);
					await this.removeDiscardedSessionFiles(recordingId, [
						preferredPath ?? "",
						...stoppedPaths,
						...this.clips.map((clip) => clip.screenVideoPath),
						...discoveredPaths,
					]);
					await this.serializeRecoveryMutation(() =>
						clearNativeMacRecoveryJournal(this.deps.recordingsDir, recordingId),
					);
					return {
						success: true,
						discarded: true,
						...(stopped.telemetry ? { telemetry: stopped.telemetry } : {}),
					};
				}

				const keptClips = this.clips.filter((clip) => !clip.removed);
				if (keptClips.length === 0) {
					throw new Error(
						stopped.warning?.message ??
							this.fatalError?.message ??
							"The recording did not contain a completed clip.",
					);
				}
				const screenVideoPath = keptClips[0].screenVideoPath || stopped.screenPath || preferredPath;
				if (!screenVideoPath) throw new Error("Native capture did not return an output path.");

				const interruption = this.fatalError ?? stopped.warning;
				const session: RecordingSession = {
					screenVideoPath,
					...(interruption ? { interruption: { ...interruption } } : {}),
					createdAt: recordingId,
					cursorCaptureMode,
					schemaVersion: 2,
					clips: this.clips,
				};
				await writeJsonDurably(this.manifestPath(recordingId), session);
				this.deps.onStopStage?.("session-written");
				await this.serializeRecoveryMutation(() =>
					persistNativeMacRecoveryJournal(this.deps.recordingsDir, session),
				).catch((error) => {
					console.warn("[capture-mac] could not update recovery journal after Stop:", error);
				});
				this.deps.onSessionStored(session);
				this.deps.onStopStage?.("session-stored");
				let cursorWarning: string | undefined;
				if (this.cursorTelemetryStarted) {
					try {
						await this.deps.finalizeCursor({
							clips: this.clips,
							pauseRanges: this.pauseRanges,
							offsetMs: this.cursorOffsetMs,
						});
					} catch (error) {
						cursorWarning = `Cursor data could not be saved: ${this.errorMessage(error)}`;
						this.deps.clearCursor();
					}
				}
				this.deps.onStopStage?.("cursor-finalized");
				await Promise.all(
					keptClips.map((clip) =>
						this.deps.registerMediaLinks(
							clip.screenVideoPath,
							clip.cursorCaptureMode ?? cursorCaptureMode,
						),
					),
				);
				this.deps.onStopStage?.("media-linked");
				const warnings = [
					stopped.warning?.message,
					this.fatalError?.code === "capture-recovery-failed" ? this.fatalError.message : undefined,
					cursorWarning,
				].filter((value): value is string => Boolean(value));
				return {
					success: true,
					path: screenVideoPath,
					session,
					message: stopped.warning
						? "Native recording recovered without the failed final clip"
						: "Native recording session stored successfully",
					...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}),
					...(stopped.telemetry ? { telemetry: stopped.telemetry } : {}),
				};
			} catch (error) {
				await this.deps.stopCursor().catch(() => undefined);
				return { success: false, error: this.errorMessage(error) };
			} finally {
				if (helper.isRunning())
					await helper.kill().catch((killError: unknown) => {
						console.warn("[capture-mac] capture helper did not exit after Stop:", killError);
					});
				this.deps.onStopStage?.("helper-exited");
				this.acceptsOriginalMetadata = false;
				await this.recoveryWrites.catch(() => undefined);
				this.reset();
				this.deps.onRecordingStateChange(false);
			}
		});
		this.stopOperation = operation;
		const clear = () => {
			if (this.stopOperation === operation) this.stopOperation = null;
		};
		void operation.then(clear, clear);
		return operation;
	}

	private initializeSession(
		recordingId: number,
		outputPath: string,
		config: NativeMacRecordingRequest,
		cursorCaptureMode: CursorCaptureMode,
	): void {
		this.sessionGeneration += 1;
		this.originals = new Map();
		this.rendererWebcamPaths.clear();
		this.acceptsOriginalMetadata = true;
		this.recordingId = recordingId;
		this.targetPath = outputPath;
		this.captureConfig = config;
		this.cursorOffsetMs = 0;
		this.cursorCaptureMode = cursorCaptureMode;
		this.cursorTelemetryStarted = false;
		this.clipCursorModes = new Map([[0, cursorCaptureMode]]);
		this.pauseStartedAtMs = null;
		this.pauseRanges = [];
		this.paused = false;
		this.clips = [];
		this.activeClipIndex = 0;
		this.fatalError = null;
		this.lastDiagnosticOutput = "";
	}

	private reset(): void {
		this.prepared = false;
		this.preparing = false;
		this.storage.stop();
		this.sessionGeneration += 1;
		this.originals = new Map();
		this.rendererWebcamPaths.clear();
		this.acceptsOriginalMetadata = false;
		this.lastDiagnosticOutput = this.helper?.output ?? this.lastDiagnosticOutput;
		this.helper = null;
		this.targetPath = null;
		this.recordingId = null;
		this.captureConfig = null;
		this.cursorOffsetMs = 0;
		this.cursorCaptureMode = "editable-overlay";
		this.cursorRecordingStartMs = 0;
		this.cursorTelemetryStarted = false;
		this.clipCursorModes = new Map();
		this.pauseStartedAtMs = null;
		this.pauseRanges = [];
		this.paused = false;
		this.clips = [];
		this.activeClipIndex = null;
		this.fatalError = null;
	}

	private completeCursorPauseRange(endMs = this.deps.now()): void {
		if (this.pauseStartedAtMs === null || this.cursorRecordingStartMs <= 0) return;
		this.pauseRanges.push({
			startMs: Math.max(0, this.pauseStartedAtMs - this.cursorRecordingStartMs),
			endMs: Math.max(0, endMs - this.cursorRecordingStartMs),
		});
		this.pauseStartedAtMs = null;
	}

	private async persistLiveSession(): Promise<void> {
		const session = this.manifestSession();
		if (!session) return;
		await writeJsonDurably(this.manifestPath(session.createdAt), session);
		await this.persistRecoverySessionBestEffort();
	}

	private async persistManifestBestEffort(): Promise<void> {
		const session = this.manifestSession();
		if (!session) return;
		try {
			await writeJsonDurably(this.manifestPath(session.createdAt), session);
		} catch (error) {
			console.warn("[capture-mac] could not update recording manifest:", error);
		}
	}

	private manifestSession(): RecordingSession | null {
		if (this.recordingId === null || !this.targetPath) return null;
		const screenVideoPath =
			this.clips.find((clip) => !clip.removed)?.screenVideoPath ??
			this.clips[0]?.screenVideoPath ??
			this.targetPath;
		return {
			schemaVersion: 2,
			...(this.fatalError ? { interruption: { ...this.fatalError } } : {}),
			createdAt: this.recordingId,
			screenVideoPath,
			cursorCaptureMode: this.cursorCaptureMode,
			clips: this.clips,
		};
	}

	private async persistRecoverySession(): Promise<void> {
		const session = this.recoverySession();
		if (!session) return;
		await this.serializeRecoveryMutation(() =>
			persistNativeMacRecoveryJournal(this.deps.recordingsDir, session),
		);
	}

	private async serializeRecoveryMutation(mutation: () => Promise<void>): Promise<void> {
		const generation = this.sessionGeneration;
		const write = this.recoveryWrites
			.catch(() => undefined)
			.then(async () => {
				if (generation === this.sessionGeneration) await mutation();
			});
		this.recoveryWrites = write;
		await write;
	}

	async registerRendererWebcam(
		recordingId: number,
		original: NativeMacOriginalStarted,
	): Promise<boolean> {
		if (this.recordingId !== recordingId || this.stopOperation || !this.acceptsOriginalMetadata)
			return false;
		if (original.key !== "webcamVideoPath") return false;
		const generation = this.sessionGeneration;
		const file = await fs.lstat(original.path);
		if (!file.isFile() || file.isSymbolicLink() || file.size === 0) return false;
		if (
			generation !== this.sessionGeneration ||
			this.recordingId !== recordingId ||
			this.stopOperation
		)
			return false;
		this.storeOriginalStarted(original, generation);
		if (this.originals.get(original.clipIndex)?.webcamVideoPath !== original.path) return false;
		this.rendererWebcamPaths.add(original.path);
		await this.recoveryWrites;
		return true;
	}

	private storeOriginalStarted(original: NativeMacOriginalStarted, generation: number): void {
		if (generation !== this.sessionGeneration || !this.targetPath || !this.acceptsOriginalMetadata)
			return;
		const maximumIndex =
			Math.max(this.activeClipIndex ?? -1, ...this.clips.map((clip) => clip.index)) + 1;
		if (original.clipIndex > maximumIndex || original.clipIndex < 0) return;
		const stem = this.clipPath(original.clipIndex).slice(0, -4);
		const suffix =
			original.key === "webcamVideoPath"
				? "webcam"
				: original.key === "microphoneAudioPath"
					? "microphone"
					: "system";
		const expectedPaths = [`${stem}-${suffix}.mov`];
		if (original.key === "webcamVideoPath")
			expectedPaths.push(`${stem}-webcam.webm`, `${stem}-webcam.mp4`);
		if (!expectedPaths.includes(path.resolve(original.path))) return;
		const originals = this.originals.get(original.clipIndex) ?? {};
		const offsetKey =
			original.key === "webcamVideoPath"
				? "webcamOffsetMs"
				: original.key === "microphoneAudioPath"
					? "microphoneAudioOffsetMs"
					: "systemAudioOffsetMs";
		this.originals.set(original.clipIndex, {
			...originals,
			[original.key]: original.path,
			[offsetKey]: original.offsetMs,
		});
		void this.persistRecoverySession().catch((error) => {
			if (generation !== this.sessionGeneration || this.fatalError) return;
			this.paused = true;
			this.fatalError = {
				code: "capture-recovery-failed",
				message: `Original recording recovery metadata could not be saved: ${this.errorMessage(error)}`,
			};
			this.deps.onFatalError(this.fatalError);
		});
	}

	private async persistRecoverySessionBestEffort(): Promise<void> {
		try {
			await this.persistRecoverySession();
		} catch (error) {
			console.warn("[capture-mac] could not update recovery journal:", error);
		}
	}

	private recoverySession(): RecordingSession | null {
		if (this.recordingId === null || !this.targetPath) return null;
		const recoveryClips = this.clips.map((clip) => ({
			...this.originals.get(clip.index),
			...clip,
		}));
		const provisionalIndices = new Set(this.originals.keys());
		if (this.activeClipIndex !== null) provisionalIndices.add(this.activeClipIndex);
		for (const index of provisionalIndices) {
			if (recoveryClips.some((clip) => clip.index === index)) continue;
			recoveryClips.push({
				...this.originals.get(index),
				index,
				screenVideoPath: this.clipPath(index),
				durationMs: 60_000,
				provisionalDuration: true,
				cursorCaptureMode: this.clipCursorModes.get(index) ?? this.cursorCaptureMode,
			});
		}
		recoveryClips.sort((left, right) => left.index - right.index);
		const screenVideoPath =
			recoveryClips.find((clip) => !clip.removed)?.screenVideoPath ?? this.targetPath;
		return {
			schemaVersion: 2,
			...(this.fatalError ? { interruption: { ...this.fatalError } } : {}),
			createdAt: this.recordingId,
			screenVideoPath,
			cursorCaptureMode: this.cursorCaptureMode,
			clips: recoveryClips,
		};
	}

	private clipPath(index: number): string {
		if (!this.targetPath) return "";
		const parsed = path.parse(this.targetPath);
		const suffix = "-clip-0001";
		const base = parsed.name.endsWith(suffix) ? parsed.name.slice(0, -suffix.length) : parsed.name;
		return path.join(parsed.dir, `${base}-clip-${String(index + 1).padStart(4, "0")}${parsed.ext}`);
	}

	private manifestPath(recordingId: number): string {
		return path.join(
			this.deps.recordingsDir,
			`${RECORDING_FILE_PREFIX}${recordingId}${RECORDING_SESSION_SUFFIX}`,
		);
	}

	private captureConfigKey(config: NativeMacRecordingRequest | null): string {
		if (!config) return "";
		const excludedWindowIds = [...(config.source.excludedWindowIds ?? [])].sort(
			(left, right) => left - right,
		);
		const excludedProcessIds = [...(config.source.excludedProcessIds ?? [])].sort(
			(left, right) => left - right,
		);
		// The helper hides the app by process when it can, so its own window list
		// changes nothing in the capture and must not cost a rebuild.
		const hidesByProcess = excludedProcessIds.length > 0;
		const source: NativeMacRecordingRequest["source"] = { ...config.source };
		delete source.excludedWindowIds;
		delete source.excludedProcessIds;
		// Bounds are resolved from the helper's last reported frame, so they change as a
		// consequence of a rebuild; they never describe a different capture.
		delete source.bounds;
		return JSON.stringify({
			...config,
			deferStart: undefined,
			startTiming: undefined,
			source: {
				...source,
				...(excludedWindowIds.length > 0 && !hidesByProcess ? { excludedWindowIds } : {}),
				...(hidesByProcess ? { excludedProcessIds } : {}),
			},
		});
	}

	private withSystemCursor(config: NativeMacRecordingRequest): NativeMacRecordingRequest {
		return {
			...config,
			video: { ...config.video, hideSystemCursor: false },
			cursor: { mode: "system" },
		};
	}

	private async findSessionMediaPaths(recordingId: number): Promise<string[]> {
		const prefix = `${RECORDING_FILE_PREFIX}${recordingId}-clip-`;
		try {
			const entries = await fs.readdir(this.deps.recordingsDir, { withFileTypes: true });
			return entries
				.filter((entry) => entry.isFile() && entry.name.startsWith(prefix))
				.map((entry) => path.join(this.deps.recordingsDir, entry.name));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
	}

	private async removeDiscardedSessionFiles(recordingId: number, paths: string[]): Promise<void> {
		const mediaPaths = [...new Set(paths.filter(Boolean))];
		await Promise.all([
			...mediaPaths.flatMap((mediaPath) => [
				fs.rm(mediaPath, { force: true }),
				fs.rm(`${mediaPath}.cursor.json`, { force: true }),
			]),
			fs.rm(this.manifestPath(recordingId), { force: true }),
		]);
	}

	private requireHelper(): NativeMacCaptureHelper {
		if (!this.helper?.isRunning()) throw new Error("Native capture is not running.");
		return this.helper;
	}

	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.commandChain.then(operation, operation);
		this.commandChain = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private errorMessage(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}
}
