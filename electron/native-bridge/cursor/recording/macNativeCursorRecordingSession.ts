import { type ChildProcessByStdio, spawn } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import { type Rectangle, screen, systemPreferences } from "electron";
import type {
	CursorRecordingData,
	CursorRecordingSample,
	KeyboardActivitySample,
	NativeCursorAsset,
	NativeCursorType,
} from "../../../../src/native/contracts";
import { clamp } from "../../../../src/utils/math";
import {
	type MacMouseButtonTransition,
	normalizeMacMouseButtonTransitions,
	resolveMacKeyboardDirectionExcluded,
	resolveMacMouseInteraction,
} from "./macInputEvents";
import type { CursorRecordingSession } from "./session";

interface MacCursorAssetPayload {
	id: string;
	imageDataUrl: string;
	width: number;
	height: number;
	hotspotX: number;
	hotspotY: number;
	scaleFactor?: number;
}

interface MacNativeCursorRecordingSessionOptions {
	getDisplayBounds: () => Rectangle | null;
	isDirectionExcludedPoint?: (point: { x: number; y: number }) => boolean;
	maxSamples: number;
	sampleIntervalMs: number;
	startTimeMs?: number;
}

interface MacKeyboardActivityEvent {
	timestampMs: number;
	focusX: number;
	focusY: number;
	focusSource?: "caret" | "target";
	targetX: number;
	targetY: number;
	targetWidth: number;
	targetHeight: number;
	targetProcessId?: number;
	contextIdentity?: string;
	targetIdentity?: string;
}

type MacCursorEvent =
	| {
			type: "ready";
			timestampMs: number;
			accessibilityTrusted?: boolean;
			mouseTapReady?: boolean;
			keyboardTapReady?: boolean;
	  }
	| {
			type: "sample";
			timestampMs: number;
			cursorType?: NativeCursorType | null;
			assetId?: string | null;
			asset?: MacCursorAssetPayload | null;
			leftButtonDown?: boolean;
			leftButtonPressed?: boolean;
			leftButtonReleased?: boolean;
			mouseButtonTransitions?: MacMouseButtonTransition[];
			keyboardActivityEvents?: MacKeyboardActivityEvent[];
			typingKeyDownCount?: number;
			typingFocusX?: number;
			typingFocusY?: number;
			typingTargetX?: number;
			typingTargetY?: number;
			typingTargetWidth?: number;
			typingTargetHeight?: number;
			targetProcessId?: number;
			contextIdentity?: string;
	  };

const HELPER_NAME = "openscreen-macos-cursor-helper";
const READY_TIMEOUT_MS = 5_000;

function helperCandidates() {
	const envPath = process.env.OPENSCREEN_MAC_CURSOR_HELPER_EXE?.trim();
	const appRoot = process.env.APP_ROOT ? path.resolve(process.env.APP_ROOT) : process.cwd();
	const archTag = process.arch === "arm64" ? "darwin-arm64" : "darwin-x64";
	const resourceRoot =
		typeof process.resourcesPath === "string"
			? process.resourcesPath
			: path.join(appRoot, "resources");

	return [
		envPath,
		path.join(appRoot, "electron", "native", "screencapturekit", "build", HELPER_NAME),
		path.join(appRoot, "electron", "native", "bin", archTag, HELPER_NAME),
		path.join(resourceRoot, "electron", "native", "bin", archTag, HELPER_NAME),
	].filter((candidate): candidate is string => Boolean(candidate));
}

function findMacCursorHelperPath() {
	for (const candidate of helperCandidates()) {
		try {
			accessSync(candidate, fsConstants.X_OK);
			return candidate;
		} catch {
			// Try the next helper location.
		}
	}

	return null;
}

export async function requestMacCursorAccessibilityAccess() {
	if (process.platform !== "darwin") {
		return { success: true, granted: true, status: "granted" };
	}

	try {
		systemPreferences.isTrustedAccessibilityClient(true);
	} catch {
		// Continue with helper probing; it can trigger the same macOS prompt.
	}

	const helperPath = findMacCursorHelperPath();
	if (!helperPath) {
		return { success: true, granted: false, status: "missing-helper" };
	}

	return new Promise<{ success: boolean; granted: boolean; status: string; error?: string }>(
		(resolve) => {
			const child = spawn(helperPath, [JSON.stringify({ sampleIntervalMs: 250 })], {
				stdio: ["ignore", "pipe", "pipe"],
			});
			let settled = false;
			let lineBuffer = "";
			const finish = (result: {
				success: boolean;
				granted: boolean;
				status: string;
				error?: string;
			}) => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(timer);
				if (!child.killed) {
					child.kill("SIGTERM");
				}
				resolve(result);
			};
			const timer = setTimeout(() => {
				finish({
					success: false,
					granted: false,
					status: "timeout",
					error: "Timed out waiting for macOS cursor helper",
				});
			}, READY_TIMEOUT_MS);

			child.stdout.setEncoding("utf8");
			child.stdout.on("data", (chunk: string) => {
				lineBuffer += chunk;
				const lines = lineBuffer.split(/\r?\n/);
				lineBuffer = lines.pop() ?? "";
				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed) {
						continue;
					}
					try {
						const event = JSON.parse(trimmed) as MacCursorEvent;
						if (event.type === "ready") {
							finish({
								success: true,
								granted: event.accessibilityTrusted === true,
								status: event.accessibilityTrusted === true ? "granted" : "not-determined",
							});
							return;
						}
					} catch {
						// Ignore non-JSON helper output.
					}
				}
			});

			child.once("error", (error) => {
				finish({
					success: false,
					granted: false,
					status: "error",
					error: error.message,
				});
			});
			child.once("exit", (code, signal) => {
				finish({
					success: false,
					granted: false,
					status: "exited",
					error: `macOS cursor helper exited before ready (code=${code}, signal=${signal})`,
				});
			});
		},
	);
}

function normalizeCursorType(value: unknown): NativeCursorType | null {
	return value === "arrow" || value === "pointer" || value === "text" ? value : null;
}

export class MacNativeCursorRecordingSession implements CursorRecordingSession {
	private samples: CursorRecordingSample[] = [];
	private keyboardActivity: KeyboardActivitySample[] = [];
	private assets = new Map<string, NativeCursorAsset>();
	private process: ChildProcessByStdio<null, Readable, Readable> | null = null;
	private lineBuffer = "";
	private startTimeMs = 0;
	private fallbackInterval: NodeJS.Timeout | null = null;
	private readyResolve: (() => void) | null = null;
	private readyReject: ((error: Error) => void) | null = null;
	private readyTimer: NodeJS.Timeout | null = null;
	private previousLeftButtonDown = false;
	private consecutiveOutsideSamples = 0;
	private previousDirectionContextId: string | null = null;
	// Hide only after this many consecutive out-of-bounds samples (~100ms at 33ms interval).
	// Fast swipes that briefly exit the display are clipped by clip-path instead of disappearing.
	private static readonly OUTSIDE_HIDE_THRESHOLD = 3;

	constructor(private readonly options: MacNativeCursorRecordingSessionOptions) {}

	async start(): Promise<void> {
		this.samples = [];
		this.keyboardActivity = [];
		this.assets.clear();
		this.lineBuffer = "";
		this.startTimeMs = this.options.startTimeMs ?? Date.now();
		this.previousLeftButtonDown = false;
		this.consecutiveOutsideSamples = 0;
		this.previousDirectionContextId = null;

		try {
			systemPreferences.isTrustedAccessibilityClient(true);
		} catch {
			// Without Accessibility, text/pointer affordance detection is unavailable;
			// bitmaps are still captured natively via NSCursor.
		}

		const helperPath = findMacCursorHelperPath();
		if (!helperPath) {
			this.startPositionOnlyFallback();
			return;
		}

		const child = spawn(
			helperPath,
			[
				JSON.stringify({
					sampleIntervalMs: this.options.sampleIntervalMs,
				}),
			],
			{
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		this.process = child;

		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => this.handleStdoutChunk(chunk));
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			const message = chunk.trim();
			if (message) {
				console.error("[cursor-macos]", message);
			}
		});
		child.once("exit", (code, signal) => {
			this.rejectReady(
				new Error(`macOS cursor helper exited before ready (code=${code}, signal=${signal})`),
			);
			this.process = null;
		});
		child.once("error", (error) => {
			this.rejectReady(error);
			this.process = null;
		});

		try {
			await this.waitUntilReady();
		} catch (error) {
			this.killHelperProcess(child);
			this.process = null;
			console.warn("[cursor-macos] falling back to position-only cursor telemetry:", error);
			this.startPositionOnlyFallback();
		}
	}

	async stop(): Promise<CursorRecordingData> {
		const child = this.process;
		this.process = null;
		this.clearReadyState();

		if (this.fallbackInterval) {
			clearInterval(this.fallbackInterval);
			this.fallbackInterval = null;
		}

		if (child) {
			this.killHelperProcess(child);
		}

		return {
			version: 5,
			provider: this.assets.size > 0 ? "native" : "none",
			samples: this.samples,
			assets: [...this.assets.values()],
			keyboardActivity: this.keyboardActivity,
		};
	}

	private startPositionOnlyFallback() {
		this.captureSample(Date.now(), null, null, false, false, false);
		this.fallbackInterval = setInterval(() => {
			this.captureSample(Date.now(), null, null, false, false, false);
		}, this.options.sampleIntervalMs);
	}

	private rememberAsset(asset: MacCursorAssetPayload | null | undefined) {
		if (!asset?.id || this.assets.has(asset.id)) {
			return;
		}

		const cursor = screen.getCursorScreenPoint();
		const displayScaleFactor = screen.getDisplayNearestPoint(cursor).scaleFactor;
		this.assets.set(asset.id, {
			id: asset.id,
			platform: "darwin",
			imageDataUrl: asset.imageDataUrl,
			width: asset.width,
			height: asset.height,
			hotspotX: asset.hotspotX,
			hotspotY: asset.hotspotY,
			scaleFactor: asset.scaleFactor ?? displayScaleFactor,
		});
	}

	private handleStdoutChunk(chunk: string) {
		this.lineBuffer += chunk;
		const lines = this.lineBuffer.split(/\r?\n/);
		this.lineBuffer = lines.pop() ?? "";

		for (const line of lines) {
			const trimmedLine = line.trim();
			if (!trimmedLine) {
				continue;
			}

			try {
				this.handleEvent(JSON.parse(trimmedLine) as MacCursorEvent);
			} catch (error) {
				console.error("Failed to parse macOS cursor helper output:", error, trimmedLine);
			}
		}
	}

	private handleEvent(payload: MacCursorEvent) {
		if (payload.type === "ready") {
			if (payload.accessibilityTrusted === false) {
				console.warn(
					"[cursor-macos] Accessibility is not trusted; text/pointer affordance detection disabled (bitmap capture still active).",
				);
			}
			if (payload.accessibilityTrusted === true && payload.keyboardTapReady === false) {
				console.warn("[cursor-macos] Keyboard activity tap is unavailable.");
			}
			this.resolveReady();
			return;
		}

		if (payload.type === "sample") {
			this.rememberAsset(payload.asset);
			const cursorType = normalizeCursorType(payload.cursorType);
			const assetId = payload.assetId ?? null;
			const directionContextId =
				typeof payload.contextIdentity === "string" && payload.contextIdentity
					? payload.contextIdentity
					: typeof payload.targetProcessId === "number" && Number.isFinite(payload.targetProcessId)
						? `process-${Math.round(payload.targetProcessId)}`
						: undefined;
			const transitions = normalizeMacMouseButtonTransitions(payload.mouseButtonTransitions);
			if (transitions.length > 0) {
				for (const transition of transitions) {
					const isDown = transition.kind === "down";
					this.captureSample(
						transition.timestampMs,
						cursorType,
						assetId,
						isDown,
						isDown,
						!isDown,
						{
							x: transition.x,
							y: transition.y,
						},
						true,
						directionContextId,
					);
				}
				this.captureSample(
					payload.timestampMs,
					cursorType,
					assetId,
					payload.leftButtonDown === true,
					false,
					false,
					undefined,
					false,
					directionContextId,
				);
			} else {
				this.captureSample(
					payload.timestampMs,
					cursorType,
					assetId,
					payload.leftButtonDown === true,
					payload.leftButtonPressed === true,
					payload.leftButtonReleased === true,
					undefined,
					true,
					directionContextId,
				);
			}
			if (Array.isArray(payload.keyboardActivityEvents)) {
				for (const activity of payload.keyboardActivityEvents) {
					this.captureKeyboardActivity(activity);
				}
			} else {
				this.captureLegacyKeyboardActivity(payload);
			}
		}
	}

	private captureLegacyKeyboardActivity(payload: Extract<MacCursorEvent, { type: "sample" }>) {
		const values = [
			payload.typingKeyDownCount,
			payload.typingFocusX,
			payload.typingFocusY,
			payload.typingTargetX,
			payload.typingTargetY,
			payload.typingTargetWidth,
			payload.typingTargetHeight,
		];
		if (!values.every((value) => typeof value === "number" && Number.isFinite(value))) return;

		const count = Math.round(payload.typingKeyDownCount!);
		if (count <= 0) return;
		this.captureKeyboardActivity(
			{
				timestampMs: payload.timestampMs,
				focusX: payload.typingFocusX!,
				focusY: payload.typingFocusY!,
				targetX: payload.typingTargetX!,
				targetY: payload.typingTargetY!,
				targetWidth: payload.typingTargetWidth!,
				targetHeight: payload.typingTargetHeight!,
			},
			count,
		);
	}

	private captureKeyboardActivity(payload: MacKeyboardActivityEvent, count = 1) {
		const values = [
			payload.timestampMs,
			payload.focusX,
			payload.focusY,
			payload.targetX,
			payload.targetY,
			payload.targetWidth,
			payload.targetHeight,
		];
		if (!values.every(Number.isFinite) || count <= 0) return;
		const bounds = this.options.getDisplayBounds();
		if (!bounds) return;
		const width = Math.max(1, bounds.width);
		const height = Math.max(1, bounds.height);
		const focusX = payload.focusX;
		const focusY = payload.focusY;
		const normalizedX = (focusX - bounds.x) / width;
		const normalizedY = (focusY - bounds.y) / height;
		if (normalizedX < 0 || normalizedX > 1 || normalizedY < 0 || normalizedY > 1) return;

		const targetLeft = clamp((payload.targetX - bounds.x) / width, 0, 1);
		const targetTop = clamp((payload.targetY - bounds.y) / height, 0, 1);
		const targetRight = clamp((payload.targetX + payload.targetWidth - bounds.x) / width, 0, 1);
		const targetBottom = clamp((payload.targetY + payload.targetHeight - bounds.y) / height, 0, 1);
		const directionExcluded = resolveMacKeyboardDirectionExcluded({
			focusPointExcluded:
				this.options.isDirectionExcludedPoint?.({ x: focusX, y: focusY }) === true,
			focusSource: payload.focusSource,
			hostProcessId: process.pid,
			targetProcessId: payload.targetProcessId,
		});
		const directionContextId =
			typeof payload.contextIdentity === "string" && payload.contextIdentity
				? payload.contextIdentity
				: typeof payload.targetProcessId === "number" && Number.isFinite(payload.targetProcessId)
					? `process-${Math.round(payload.targetProcessId)}`
					: undefined;
		this.keyboardActivity.push({
			timeMs: Math.max(0, payload.timestampMs - this.startTimeMs),
			cx: normalizedX,
			cy: normalizedY,
			count,
			...(payload.focusSource === "caret" || payload.focusSource === "target"
				? { focusSource: payload.focusSource }
				: {}),
			targetRect: {
				x: targetLeft,
				y: targetTop,
				width: Math.max(0, targetRight - targetLeft),
				height: Math.max(0, targetBottom - targetTop),
			},
			...(directionExcluded ? { directionExcluded: true } : {}),
			...(directionContextId ? { directionContextId } : {}),
			...(typeof payload.targetIdentity === "string" && payload.targetIdentity
				? { directionTargetId: payload.targetIdentity }
				: {}),
		});

		if (this.keyboardActivity.length > this.options.maxSamples) {
			this.keyboardActivity.shift();
		}
	}

	private captureSample(
		timestampMs: number,
		cursorType: NativeCursorType | null,
		assetId: string | null,
		leftButtonDown: boolean,
		leftButtonPressed: boolean,
		leftButtonReleased: boolean,
		cursorPoint?: { x: number; y: number },
		inferStateTransition = true,
		directionContextId?: string,
	) {
		const cursor = cursorPoint ?? screen.getCursorScreenPoint();
		const bounds = this.options.getDisplayBounds() ?? screen.getDisplayNearestPoint(cursor).bounds;
		const width = Math.max(1, bounds.width);
		const height = Math.max(1, bounds.height);
		const normalizedX = (cursor.x - bounds.x) / width;
		const normalizedY = (cursor.y - bounds.y) / height;
		const isOutsideDisplay =
			normalizedX < 0 || normalizedX > 1 || normalizedY < 0 || normalizedY > 1;
		// Brief exits (under THRESHOLD samples) clip to the canvas edge via clip-path instead
		// of snapping invisible. Sustained exits (>=THRESHOLD, ~100ms) mark visible=false to
		// avoid ghost cursors and motion trails from multi-display movement.
		if (isOutsideDisplay) {
			this.consecutiveOutsideSamples++;
		} else {
			this.consecutiveOutsideSamples = 0;
		}
		const visible =
			this.consecutiveOutsideSamples < MacNativeCursorRecordingSession.OUTSIDE_HIDE_THRESHOLD;
		const interactionType = resolveMacMouseInteraction({
			leftButtonDown,
			leftButtonPressed,
			leftButtonReleased,
			previousLeftButtonDown: this.previousLeftButtonDown,
			inferStateTransition,
		});
		this.previousLeftButtonDown = leftButtonDown;

		const directionExcluded = this.options.isDirectionExcludedPoint?.(cursor) === true;
		const directionContextChanged =
			Boolean(directionContextId) &&
			Boolean(this.previousDirectionContextId) &&
			directionContextId !== this.previousDirectionContextId;
		if (directionContextId) this.previousDirectionContextId = directionContextId;
		this.samples.push({
			timeMs: Math.max(0, timestampMs - this.startTimeMs),
			cx: clamp(normalizedX, 0, 1),
			cy: clamp(normalizedY, 0, 1),
			visible,
			interactionType,
			...(directionExcluded ? { directionExcluded: true } : {}),
			...(assetId ? { assetId } : {}),
			...(cursorType ? { cursorType } : {}),
			...(directionContextId ? { directionContextId } : {}),
			...(directionContextChanged ? { directionContextChanged: true } : {}),
		});

		if (this.samples.length > this.options.maxSamples) {
			this.samples.shift();
		}
	}

	private waitUntilReady() {
		return new Promise<void>((resolve, reject) => {
			this.readyResolve = resolve;
			this.readyReject = reject;
			this.readyTimer = setTimeout(() => {
				this.rejectReady(new Error("Timed out waiting for macOS cursor helper"));
			}, READY_TIMEOUT_MS);
		});
	}

	private resolveReady() {
		const resolve = this.readyResolve;
		this.clearReadyState();
		resolve?.();
	}

	private rejectReady(error: Error) {
		const reject = this.readyReject;
		this.clearReadyState();
		reject?.(error);
	}

	private clearReadyState() {
		if (this.readyTimer) {
			clearTimeout(this.readyTimer);
			this.readyTimer = null;
		}
		this.readyResolve = null;
		this.readyReject = null;
	}

	private killHelperProcess(child: ChildProcessByStdio<null, Readable, Readable>) {
		if (child.killed) {
			return;
		}

		child.kill("SIGTERM");
		setTimeout(() => {
			if (!child.killed) {
				child.kill("SIGKILL");
			}
		}, 500).unref();
	}
}
