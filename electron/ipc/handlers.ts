import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { constants as fsConstants, realpathSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DesktopCapturerSource } from "electron";
import {
	app,
	BrowserWindow,
	clipboard,
	desktopCapturer,
	dialog,
	ipcMain as electronIpcMain,
	powerMonitor,
	powerSaveBlocker,
	screen,
	shell,
	systemPreferences,
} from "electron";
import { APP_DISPLAY_NAME } from "../../src/lib/brand";
import {
	fromKlipptMediaUrl,
	KLIPPT_APP_ORIGIN,
	KLIPPT_RESOURCE_PATH_PREFIX,
	toKlipptMediaUrl,
} from "../../src/lib/localMediaUrl";
import {
	linuxClipRecordingRequest,
	type NativeLinuxRecordingRequest,
} from "../../src/lib/nativeLinuxRecording";
import {
	compactCursorRecordingPauseRanges,
	getNativeMacRecordingIdFromClipPath,
	shiftCursorRecordingToVideoStart,
	splitCursorRecordingForClips,
} from "../../src/lib/nativeMacClipSession";
import type {
	NativeMacCaptureTelemetry,
	NativeMacClipWebcamInput,
	NativeMacRecordingInterruption,
	NativeMacRecordingRequest,
	NativeMacRecordingStartResult,
} from "../../src/lib/nativeMacRecording";
import {
	parseNativeMacRecordingClip,
	parseNativeRecordingWebcamRegistration,
} from "../../src/lib/nativeMacRecording";
import type { NativeWindowsRecordingRequest } from "../../src/lib/nativeWindowsRecording";
import {
	isSupportedProjectFile,
	PROJECT_FILE_EXTENSION,
	SUPPORTED_PROJECT_FILE_EXTENSIONS,
	withCanonicalProjectExtension,
} from "../../src/lib/projectFileFormat";
import { nativeMacWebcamFileName } from "../../src/lib/recording/capturePolicy";
import {
	type CursorCaptureMode,
	normalizeCursorCaptureMode,
	normalizeProjectMedia,
	normalizeRecordingSession,
	normalizeRecordingWorkspaceContext,
	type ProjectMedia,
	type RecordedVideoAssetInput,
	type RecordingSession,
	type RecordingSessionClip,
	type RecordingWorkspaceContext,
	type StoreRecordedSessionInput,
} from "../../src/lib/recordingSession";
import type {
	CursorRecordingData,
	ProjectFileResult,
	ProjectPathResult,
} from "../../src/native/contracts";
import { DocumentService } from "../ai-edition/document-service";
import { privacySettingsPane, readCapturePermissions } from "../capturePermissions";
import { createDiagnosticReport, type DiagnosticRequest } from "../diagnostics/diagnostic-report";
import { createElectronWorkloadResourceSampler } from "../diagnostics/electronWorkloadResources";
import { mainLogBuffer } from "../diagnostics/main-log-buffer";
import { createWorkloadQuitGuard } from "../diagnostics/workloadQuitGuard";
import {
	type WorkloadFailureCode,
	type WorkloadOperation,
	WorkloadTelemetryService,
} from "../diagnostics/workloadTelemetry";
import { createEntitlementService } from "../entitlements/createService";
import { registerEntitlementIpc } from "../entitlements/ipc";
import { ExportTransactionError } from "../export/atomicExport";
import {
	cleanupOrphanedExportTemps,
	createVoiceoverTempPath,
	isVoiceoverTempPath,
} from "../export/voiceoverTemp";
import { writeJsonDurably } from "../filesystem/durableJson";
import { mainT } from "../i18n";
import { resolveFfmpeg } from "../media/audioPeaks";
import { CleanVoiceService, type CleanVoiceThermalState } from "../media/cleanVoiceService";
import {
	cleanVoiceHelperCandidates,
	createLocalCleanVoiceProcessor,
	resolveCleanVoiceHelper,
} from "../media/cleanVoiceWorker";
import {
	readCursorRecordingFile as readCursorRecordingFileFrom,
	readCursorTelemetryFile as readCursorTelemetryFileFrom,
} from "../media/cursorSidecar";
import { MediaAccessRegistry } from "../media/mediaAccessRegistry";
import {
	findMediaLinksByFingerprint,
	registerMediaLinks,
	resolveMediaLinkSources,
} from "../media/mediaLinksRegistry";
import { relinkProjectMedia } from "../media/projectMediaRelinker";
import { createCursorRecordingSession } from "../native-bridge/cursor/recording/factory";
import { requestMacCursorAccessibilityAccess } from "../native-bridge/cursor/recording/macNativeCursorRecordingSession";
import { findPipeWireCursorHelperPath } from "../native-bridge/cursor/recording/pipeWireCursorRecordingSession";
import type { CursorRecordingSession } from "../native-bridge/cursor/recording/session";
import { toHelperRect } from "../native-bridge/helperCoordinates";
import {
	CompositorViewService,
	type ExportSourceMetadata,
	type VideoBufferPublishSpec,
} from "../native-bridge/services/compositorViewService";
import { NiriCaptureWindowGuard } from "../niriCaptureWindowGuard";
import { activateNiriHud, rememberNiriHudPlacement } from "../niriHudFocus";
import { mergeEnumeratedSources } from "../recording/enumeratedSources";
import { LinuxClipCaptureMetadata } from "../recording/linuxClipCaptureMetadata";
import { LinuxRecordingHud } from "../recording/linuxRecordingHud";
import {
	buildNativeMacCaptureHelperCandidates,
	buildNativeWindowsCaptureHelperCandidates,
} from "../recording/nativeCaptureHelperPaths";
import { prepareNativeMacCapturePermissions } from "../recording/nativeMacCapturePermissions";
import { addNativeMacDisplayPrivacyExclusions } from "../recording/nativeMacCapturePrivacy";
import { NativeMacHelperClient } from "../recording/nativeMacHelperClient";
import { NativeMacRecordingService } from "../recording/nativeMacRecordingService";
import {
	clearNativeMacRecoveryJournal,
	restoreLatestNativeMacRecoverySession,
	updateNativeMacRecoveryJournalIfPresent,
} from "../recording/nativeMacRecoveryJournal";
import {
	NativeMacStandbyHelper,
	STANDBY_HELPER_REWARM_INTERVAL_MS,
} from "../recording/nativeMacStandbyHelper";
import {
	isSalvageableFragmentedCapture,
	NATIVE_WINDOWS_SALVAGEABLE_OUTPUT_BYTES,
	terminateNativeWindowsCapture,
	waitForNativeWindowsCaptureStop,
} from "../recording/nativeWindowsCaptureStop";
import { parseNativeWindowsCaptureTelemetry } from "../recording/nativeWindowsCaptureTelemetry";
import {
	type PickerSource,
	pickerThumbnailsAreFresh,
	reusePickerThumbnails,
} from "../recording/pickerSources";
import { withHiddenPortalHud } from "../recording/portalSelectionHud";
import {
	matchRecordingSource,
	ProjectRecordingSetupStore,
	recordingSource,
} from "../recording/projectRecordingSetupStore";
import { type RecordingPrefs, RecordingPrefsStore } from "../recording/recordingPrefsStore";
import { createRecordingStartupOverlayController } from "../recording/recordingStartupOverlay";
import { freeDiskBytes } from "../recording/recordingStorage";
import { RecordingWakeLock } from "../recording/recordingWakeLock";
import {
	appendDiagnosticRow,
	appendRecordStartTiming,
	RecordStartTimeline,
} from "../recording/recordStartTimeline";
import { RendererRecordingStop } from "../recording/rendererRecordingStop";
import { patchWebmDurationOnDisk } from "../recording/webm-duration";
import { reindexRecordingOnDisk } from "../recording/webm-seek-index";
import { recordingsDirectory } from "../recordingPaths";
import type { StudioSetup } from "../studio/types";
import { registerLocalFontIpc } from "./localFont";
import { registerNativeBridgeHandlers } from "./nativeBridge";
import { RecordingStreamRegistry, registerRecordingStreamHandlers } from "./recordingStream";
import type { RendererIpcMain } from "./trustedRendererIpc";

export const SHORTCUTS_FILE = path.join(app.getPath("userData"), "shortcuts.json");
const RECORDING_PREFS_FILE = path.join(app.getPath("userData"), "recording-preferences.json");
const recordingPrefsStore = new RecordingPrefsStore(RECORDING_PREFS_FILE);
const projectRecordingSetupStore = new ProjectRecordingSetupStore(
	path.join(app.getPath("userData"), "project-recording-setups"),
);
const RECORDING_FILE_PREFIX = "recording-";
const RECORDING_SESSION_SUFFIX = ".session.json";
const ALLOWED_IMPORT_VIDEO_EXTENSIONS = new Set([
	".webm",
	".mp4",
	".mov",
	".avi",
	".mkv",
	".m4v",
	".wmv",
	".flv",
	".ts",
]);
const PREVIEW_AUDIO_DIR = path.join(app.getPath("userData"), "preview-audio");
const RECORDINGS_DIR = recordingsDirectory(app.getPath("userData"));
const CLEAN_VOICE_MEDIA_DIR = path.join(app.getPath("userData"), "derived-media", "clean-voice-v1");
const AUDIO_OVERLAY_MEDIA_DIR = path.join(
	app.getPath("userData"),
	"derived-media",
	"audio-overlays-v1",
);
const RENDERER_EXPORT_TEMP_DIR = app.getPath("temp");
let nativeMacRecordingService: NativeMacRecordingService | null = null;
const rendererRecordingStop = new RendererRecordingStop();
let linuxRecordingHud: LinuxRecordingHud | null = null;

export function requestLinuxRecordingControls(): boolean {
	return linuxRecordingHud?.requestControls() ?? false;
}

/** Clip listing for the transcript window; empty before the recorder exists. */
export function isNativeMacCaptureRunning(): boolean {
	return (
		(nativeMacRecordingService?.isRunning() ?? false) ||
		rendererRecordingStop.pendingRecordingId() !== null
	);
}

export async function stopNativeMacCaptureForQuit(): Promise<void> {
	linuxRecordingHud?.cancelPending();
	await nativeMacRecordingService?.stopBeforeQuit();
}

/** The current take for the Studio; null before the recorder exists. */
/** The recording setup the Studio shows: main's saved choices and the selected source. */
export function studioSetup(): StudioSetup {
	const prefs = recordingPrefsStore.peek();
	const source = selectedSource;
	return {
		source:
			source && typeof source.id === "string"
				? {
						id: source.id,
						name: source.name,
						kind: source.id.startsWith("window:") ? "window" : "display",
					}
				: null,
		micEnabled: prefs.micEnabled,
		micDeviceId: prefs.micDeviceId,
		cameraEnabled: prefs.camEnabled,
		cameraDeviceId: prefs.camDeviceId,
		systemAudioEnabled: prefs.systemAudioEnabled,
		cursorCaptureMode: prefs.cursorCaptureMode,
		recordingQuality: prefs.recordingQuality,
	};
}

export function studioTake() {
	return nativeMacRecordingService?.studioTake() ?? null;
}

/**
 * The pill renderer that runs the take is gone, so nothing can pause or stop it.
 * Stop natively: the recorder stores the session as a normal Stop does. True when a
 * take was stopped and saved.
 */
export async function stopTakeWithoutPill(): Promise<boolean> {
	const service = nativeMacRecordingService;
	if (!service?.studioTake()?.running) return false;
	rendererRecordingStop.abandon();
	const result = await service.stop(false).catch((error: unknown) => {
		console.warn("[recording] stop after the pill crashed failed:", error);
		return null;
	});
	return Boolean(result && "success" in result && result.success);
}

export function listTranscriptClips() {
	return (
		nativeMacRecordingService?.transcriptClipListing() ?? {
			recordingId: null,
			clips: [],
			live: false,
		}
	);
}

// Paths the user approved via file picker or project load (i.e. outside the default dirs).
const approvedPaths = new Set<string>();
let mediaAccessRegistry: MediaAccessRegistry | undefined;
let mediaGrantReadWarningShown = false;
function mediaGrants(): MediaAccessRegistry {
	mediaAccessRegistry ??= new MediaAccessRegistry(
		path.join(app.getPath("userData"), "media-access-grants.json"),
	);
	return mediaAccessRegistry;
}
function hasMediaGrant(filePath: string): boolean {
	try {
		return mediaGrants().hasCanonicalPath(canonicalPath(filePath));
	} catch (error) {
		if (!mediaGrantReadWarningShown)
			console.warn("[media-access] Cannot read saved media grants:", error);
		mediaGrantReadWarningShown = true;
		return false;
	}
}
async function rememberTrustedMedia(
	filePath: string,
	trustedDirectories?: readonly string[],
): Promise<void> {
	if (
		[RECORDINGS_DIR, PREVIEW_AUDIO_DIR, CLEAN_VOICE_MEDIA_DIR, AUDIO_OVERLAY_MEDIA_DIR].some(
			(dir) => isPathWithinDir(filePath, dir),
		)
	)
		return;
	await mediaGrants().grantSelectedFile(filePath, trustedDirectories);
}

function canonicalPath(filePath: string): string {
	try {
		return realpathSync.native(filePath);
	} catch {
		return path.resolve(filePath);
	}
}

function approveFilePath(filePath: string): void {
	approvedPaths.add(canonicalPath(filePath));
}

function getAllowedReadDirs(): string[] {
	return [RECORDINGS_DIR];
}

function isPathWithinDir(filePath: string, dirPath: string): boolean {
	const resolved = canonicalPath(filePath);
	const resolvedDir = canonicalPath(dirPath);
	return resolved === resolvedDir || resolved.startsWith(resolvedDir + path.sep);
}

function isPathAllowed(filePath: string): boolean {
	const resolved = canonicalPath(filePath);
	if (approvedPaths.has(resolved) || hasMediaGrant(resolved)) return true;
	return getAllowedReadDirs().some((dir) => isPathWithinDir(resolved, dir));
}

export function resolveApprovedVideoPath(videoPath?: string | null): string | null {
	const normalizedPath = normalizeVideoSourcePath(videoPath);
	if (!normalizedPath) {
		return null;
	}

	if (!hasAllowedImportVideoExtension(normalizedPath) || !isPathAllowed(normalizedPath)) {
		return null;
	}

	return normalizedPath;
}

const ALLOWED_RENDERER_MEDIA_EXTENSIONS = new Set([
	...ALLOWED_IMPORT_VIDEO_EXTENSIONS,
	".aac",
	".flac",
	".m4a",
	".mp3",
	".ogg",
	".wav",
]);

/** Resolves only media the renderer already has authority to preview. */
export function resolveApprovedRendererMediaPath(mediaPath?: string | null): string | null {
	const normalizedPath = normalizeVideoSourcePath(mediaPath);
	if (
		!normalizedPath ||
		!ALLOWED_RENDERER_MEDIA_EXTENSIONS.has(path.extname(normalizedPath).toLowerCase())
	) {
		return null;
	}
	const appOwned = [
		RECORDINGS_DIR,
		PREVIEW_AUDIO_DIR,
		CLEAN_VOICE_MEDIA_DIR,
		AUDIO_OVERLAY_MEDIA_DIR,
	].some((directory) => isPathWithinDir(normalizedPath, directory));
	const appOwnedExport = isVoiceoverTempPath(
		canonicalPath(RENDERER_EXPORT_TEMP_DIR),
		canonicalPath(normalizedPath),
	);
	return appOwned ||
		appOwnedExport ||
		approvedPaths.has(canonicalPath(normalizedPath)) ||
		hasMediaGrant(normalizedPath)
		? normalizedPath
		: null;
}

/** Grants renderer preview access to one existing media file selected by a trusted main flow. */
export async function approveReadableRendererMediaPath(
	filePath?: string | null,
	trustedDirectories?: readonly string[],
): Promise<string | null> {
	const normalizedPath = normalizeVideoSourcePath(filePath);
	if (
		!normalizedPath ||
		!ALLOWED_RENDERER_MEDIA_EXTENSIONS.has(path.extname(normalizedPath).toLowerCase())
	) {
		return null;
	}
	try {
		if (!(await fs.stat(normalizedPath)).isFile()) return null;
	} catch {
		return null;
	}
	if (resolveApprovedRendererMediaPath(normalizedPath)) return normalizedPath;
	await rememberTrustedMedia(normalizedPath, trustedDirectories);
	approveFilePath(normalizedPath);
	return normalizedPath;
}

// Attach the parent window only when valid, to avoid passing a destroyed BrowserWindow to dialogs.
function buildDialogOptions<T extends Electron.OpenDialogOptions | Electron.SaveDialogOptions>(
	baseOptions: T,
	parentWindow: BrowserWindow | null,
): T & { parent?: BrowserWindow } {
	const mainWindow = parentWindow;
	if (mainWindow && !mainWindow.isDestroyed()) {
		return { ...baseOptions, parent: mainWindow };
	}
	return baseOptions;
}

function hasAllowedImportVideoExtension(filePath: string): boolean {
	return ALLOWED_IMPORT_VIDEO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function runProcess(
	command: string,
	args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, stdout, stderr }));
	});
}

function parseAfinfoAudioTrackBitrates(output: string): number[] {
	const bitrates: number[] = [];
	const trackSections = output.split(/\n----\n/g).slice(1);
	for (const section of trackSections) {
		const match = section.match(/\bbit rate:\s*([0-9]+)\s*bits per second/i);
		bitrates.push(match ? Number(match[1]) : 0);
	}
	return bitrates;
}

async function prepareSupplementalPreviewAudioTrack(videoPath: string) {
	const normalizedPath = resolveApprovedVideoPath(videoPath);
	if (!normalizedPath) {
		return {
			success: false,
			message: "File path is not approved or is not a supported video file",
		};
	}

	if (process.platform !== "darwin" || path.extname(normalizedPath).toLowerCase() !== ".mp4") {
		return { success: true, path: null };
	}

	const afinfo = await runProcess("/usr/bin/afinfo", [normalizedPath]);
	if (afinfo.code !== 0) {
		return { success: true, path: null };
	}

	const bitrates = parseAfinfoAudioTrackBitrates(`${afinfo.stdout}\n${afinfo.stderr}`);
	if (bitrates.length <= 1) {
		return { success: true, path: null };
	}

	let supplementalTrackIndex = 1;
	for (let index = 2; index < bitrates.length; index += 1) {
		if (bitrates[index] > bitrates[supplementalTrackIndex]) {
			supplementalTrackIndex = index;
		}
	}

	await fs.mkdir(PREVIEW_AUDIO_DIR, { recursive: true });
	const sourceStat = await fs.stat(normalizedPath);
	const parsedPath = path.parse(normalizedPath);
	const outputPath = path.join(
		PREVIEW_AUDIO_DIR,
		`${parsedPath.name}.track-${supplementalTrackIndex}.${Math.round(sourceStat.mtimeMs)}.m4a`,
	);

	try {
		const outputStat = await fs.stat(outputPath);
		if (outputStat.mtimeMs >= sourceStat.mtimeMs) {
			return { success: true, path: toKlipptMediaUrl(outputPath) };
		}
	} catch {
		// Generate below.
	}

	const conversion = await runProcess("/usr/bin/afconvert", [
		"--read-track",
		String(supplementalTrackIndex),
		"-f",
		"m4af",
		"-d",
		"aac",
		normalizedPath,
		outputPath,
	]);
	if (conversion.code !== 0) {
		return {
			success: false,
			message: conversion.stderr || conversion.stdout || "Failed to prepare preview audio",
		};
	}

	return { success: true, path: toKlipptMediaUrl(outputPath) };
}

export async function approveReadableVideoPath(
	filePath?: string | null,
	trustedDirs?: string[],
): Promise<string | null> {
	const normalizedPath = normalizeVideoSourcePath(filePath);
	if (!normalizedPath) {
		return null;
	}

	if (isPathAllowed(normalizedPath)) {
		return normalizedPath;
	}

	if (!hasAllowedImportVideoExtension(normalizedPath)) {
		return null;
	}

	// Only a main-process file picker can approve an arbitrary new path. Project
	// loading can approve media inside the project directory or recordings folder.
	// A renderer-supplied path without either authority must stay rejected.
	if (!trustedDirs) {
		return null;
	}
	const resolved = path.resolve(normalizedPath);
	const withinTrusted = trustedDirs.some((dir) => isPathWithinDir(resolved, dir));
	if (!withinTrusted) {
		return null;
	}

	try {
		const stats = await fs.stat(normalizedPath);
		if (!stats.isFile()) {
			return null;
		}
	} catch {
		return null;
	}

	await rememberTrustedMedia(normalizedPath, trustedDirs);
	approveFilePath(normalizedPath);
	return normalizedPath;
}

async function approveUserSelectedVideoPath(filePath?: string | null): Promise<string | null> {
	const normalizedPath = normalizeVideoSourcePath(filePath);
	if (!normalizedPath || !hasAllowedImportVideoExtension(normalizedPath)) return null;
	try {
		if (!(await fs.stat(normalizedPath)).isFile()) return null;
	} catch {
		return null;
	}
	await rememberTrustedMedia(normalizedPath);
	approveFilePath(normalizedPath);
	return normalizedPath;
}

function resolveRecordingOutputPath(fileName: string): string {
	const trimmed = fileName.trim();
	if (!trimmed) {
		throw new Error("Invalid recording file name");
	}

	const parsedPath = path.parse(trimmed);
	const hasTraversalSegments = trimmed.split(/[\\/]+/).some((segment) => segment === "..");
	const isNestedPath =
		parsedPath.dir !== "" ||
		path.isAbsolute(trimmed) ||
		trimmed.includes("/") ||
		trimmed.includes("\\");
	if (hasTraversalSegments || isNestedPath || parsedPath.base !== trimmed) {
		throw new Error("Recording file name must not contain path segments");
	}

	return path.join(RECORDINGS_DIR, parsedPath.base);
}

function isValidDurationMs(value: number | undefined): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * Finalize one recording file: flush/close the stream if it was streamed, else write
 * the buffered bytes (short recording or stream failed to open). Returns whether it was
 * streamed, so the caller knows if the WebM duration needs patching on disk.
 */
async function finalizeRecordingFile(
	registry: RecordingStreamRegistry,
	fileName: string,
	filePath: string,
	videoData?: ArrayBuffer,
): Promise<boolean> {
	const streamed = await registry.finalize(fileName);
	if (!streamed && videoData && videoData.byteLength > 0) {
		await fs.writeFile(filePath, Buffer.from(videoData));
	}
	return streamed;
}

/**
 * Give a finalized recording a usable container, by whichever route works.
 *
 * MediaRecorder omits the `Duration` header, so without repair the editor sees
 * `duration = Infinity` and cannot scale its timeline.
 *
 * Two routes, in order of quality:
 *   1. A full container remux through libavformat's matroska muxer (Linux, where
 *      capture goes through MediaRecorder). The muxer derives `Duration` from
 *      the real packet timestamps rather than from the renderer's wall-clock
 *      measurement, and writes `Cues`/`SeekHead` on the way past.
 *   2. The EBML header patch, which splices the caller's `durationMs` into the
 *      Info section. Used on Windows/macOS, and on Linux whenever the remux is
 *      unavailable (no addon, or a `.node` predating it) or fails.
 *
 * Both rewrite the file exactly once, so route 1 is not the more expensive one —
 * it is the same I/O for a strictly better result. Either way a failure leaves
 * the original file intact; a recording is never lost to a failed repair.
 */
async function repairRecordingContainer(filePath: string, durationMs: number): Promise<void> {
	if (path.extname(filePath) === ".mp4") return;
	const reindexed = await reindexRecordingOnDisk(filePath);
	if (reindexed.reindexed) {
		console.info(
			`[recording] re-muxed ${path.basename(filePath)}: ${reindexed.packets} packets, ` +
				`${reindexed.streams} streams, ${reindexed.wallS.toFixed(3)}s`,
		);
		return;
	}
	await patchWebmDurationOnDisk(filePath, durationMs);
}

async function getApprovedProjectSession(
	project: unknown,
	projectFilePath?: string,
): Promise<RecordingSession | null> {
	if (!project || typeof project !== "object") {
		return null;
	}
	if ("schemaVersion" in project) {
		const { approveCurrentProjectMedia } = await import("./currentProjectMedia");
		return approveCurrentProjectMedia(
			project,
			projectFilePath,
			RECORDINGS_DIR,
			approveReadableVideoPath,
			(file, trusted) =>
				isPathAllowed(file) || trusted.some((dir) => isPathWithinDir(file, dir))
					? approveReadableRendererMediaPath(file, trusted)
					: Promise.resolve(null),
		);
	}

	const rawProject = project as { media?: unknown; videoPath?: unknown };
	const media: ProjectMedia | null =
		normalizeProjectMedia(rawProject.media) ??
		(typeof rawProject.videoPath === "string"
			? {
					screenVideoPath: normalizeVideoSourcePath(rawProject.videoPath) ?? rawProject.videoPath,
				}
			: null);

	if (!media) {
		return null;
	}

	// Only auto-approve media within the project's dir or RECORDINGS_DIR, so a crafted
	// project file can't approve reads to arbitrary locations.
	const trustedDirs = [RECORDINGS_DIR];
	if (projectFilePath) {
		trustedDirs.push(path.dirname(path.resolve(projectFilePath)));
	}

	// Packed/portable projects: when the stored absolute path no longer exists
	// (project moved to another machine or directory), fall back to a file with
	// the same basename next to the project file (see `openscreen pack`).
	const resolveWithSiblingFallback = async (mediaPath: string): Promise<string> => {
		if (!projectFilePath) return mediaPath;
		const exists = await fs
			.stat(mediaPath)
			.then((stats) => stats.isFile())
			.catch(() => false);
		if (exists) return mediaPath;
		const sibling = path.join(
			path.dirname(path.resolve(projectFilePath)),
			path.basename(mediaPath),
		);
		const siblingExists = await fs
			.stat(sibling)
			.then((stats) => stats.isFile())
			.catch(() => false);
		return siblingExists ? sibling : mediaPath;
	};

	const screenVideoPath = await approveReadableVideoPath(
		await resolveWithSiblingFallback(media.screenVideoPath),
		trustedDirs,
	);
	if (!screenVideoPath) {
		throw new Error("Project references an invalid or unsupported screen video path");
	}

	const webcamVideoPath = media.webcamVideoPath
		? await approveReadableVideoPath(
				await resolveWithSiblingFallback(media.webcamVideoPath),
				trustedDirs,
			)
		: undefined;
	if (media.webcamVideoPath && !webcamVideoPath) {
		throw new Error("Project references an invalid or unsupported webcam video path");
	}

	return webcamVideoPath
		? { screenVideoPath, webcamVideoPath, createdAt: Date.now() }
		: { screenVideoPath, createdAt: Date.now() };
}

type SelectedSource = {
	name: string;
	id?: string;
	display_id?: string;
	[key: string]: unknown;
};

type AttachNativeMacWebcamRecordingInput = {
	screenVideoPath?: string;
	recordingId?: number;
	webcam?: RecordedVideoAssetInput;
	clips?: RecordingSessionClip[];
	cursorCaptureMode?: CursorCaptureMode;
	/**
	 * Webcam clip duration (ms), head start included. A streamed webcam file carries
	 * no Duration header and the renderer no longer holds the blob to patch, so the
	 * main process repairs the container on disk with this value.
	 */
	durationMs?: number;
	/** See {@link ProjectMedia.webcamOffsetMs}. */
	webcamOffsetMs?: number;
};

type AttachNativeMacClipWebcamsInput = {
	screenVideoPath?: string;
	recordingId?: number;
	clips?: RecordingSessionClip[];
	webcams?: NativeMacClipWebcamInput[];
};

let selectedSource: SelectedSource | null = null;
/** The last screens and windows read at picker thumbnail size. */
let lastPickerSources: PickerSource[] = [];
let lastPickerFullReadAt: number | null = null;
/** Every helper warning, so a gap or a slow switch can be explained after the take. */
const helperWarningsFile = () =>
	path.join(app.getPath("userData"), "diagnostics", "helper-warnings.jsonl");
/** Collects the start steps of the recording being started, if any. */
let activeStartTimeline: RecordStartTimeline | null = null;
const recordStartTimingFile = () =>
	path.join(app.getPath("userData"), "diagnostics", "record-start-timing.jsonl");
/** Collects the Stop steps until the review shows its first frame. */
let activeStopTimeline: RecordStartTimeline | null = null;
let activeStopTimelineTimer: NodeJS.Timeout | null = null;
const recordStopTimingFile = () =>
	path.join(app.getPath("userData"), "diagnostics", "record-stop-timing.jsonl");
function finishStopTimeline(success: boolean) {
	const timeline = activeStopTimeline;
	if (!timeline) return;
	activeStopTimeline = null;
	if (activeStopTimelineTimer) clearTimeout(activeStopTimelineTimer);
	activeStopTimelineTimer = null;
	void appendRecordStartTiming(recordStopTimingFile(), {
		recordedAt: new Date().toISOString(),
		success,
		steps: timeline.steps(),
	}).catch((error) => console.warn("[capture-mac] could not log stop timing:", error));
}
/** Collects the helper's steps while one Pause or Continue runs. */
let activeClipBoundaryTimeline: RecordStartTimeline | null = null;
const recordClipBoundaryTimingFile = () =>
	path.join(app.getPath("userData"), "diagnostics", "record-pause-continue-timing.jsonl");
async function timeClipBoundary<T>(
	action: "pause" | "continue" | "prepare" | "pick",
	run: () => Promise<T>,
) {
	const timeline = new RecordStartTimeline(Date.now);
	timeline.mark("ipc-received");
	activeClipBoundaryTimeline = timeline;
	let success = false;
	try {
		const result = await run();
		success =
			action === "pick"
				? result !== null
				: Boolean(
						result && typeof result === "object" && "success" in result && result.success === true,
					);
		return result;
	} finally {
		timeline.mark("returned");
		if (activeClipBoundaryTimeline === timeline) activeClipBoundaryTimeline = null;
		void appendRecordStartTiming(recordClipBoundaryTimingFile(), {
			recordedAt: new Date().toISOString(),
			action,
			success,
			steps: timeline.steps(),
		}).catch((error) => console.warn("[capture-mac] could not log clip timing:", error));
	}
}
let selectedDesktopSource: DesktopCapturerSource | null = null;
let lastEnumeratedSources = new Map<string, DesktopCapturerSource>();
let currentProjectPath: string | null = null;
let currentRecordingSession: RecordingSession | null = null;
let currentRecordingWorkspaceContext: RecordingWorkspaceContext | null = null;
let unavailableRecordingSource: ReturnType<typeof recordingSource> = null;
let recordingSetupQueue: Promise<unknown> = Promise.resolve();

function serializeRecordingSetup<T>(operation: () => Promise<T>): Promise<T> {
	const result = recordingSetupQueue.then(operation);
	recordingSetupQueue = result.catch(() => undefined);
	return result;
}

async function saveProjectRecordingSetup(projectId = currentRecordingWorkspaceContext?.projectId) {
	if (!projectId) return;
	await projectRecordingSetupStore.set(projectId, {
		prefs: await recordingPrefsStore.get(),
		source: recordingSource(selectedSource) ?? unavailableRecordingSource,
	});
}

// One source of truth for the mic/camera/system-audio/cursor choices shared by
// the editor Rec stage and the HUD. Unlike project content, these are app-level
// preferences: persist them so the next app launch starts with the user's usual
// recording setup.
export type { RecordingPrefs } from "../recording/recordingPrefsStore";

// Cached source from the user's pick. Used by setDisplayMediaRequestHandler in main.ts for cursor-free capture.
export function getSelectedDesktopSource(): DesktopCapturerSource | null {
	return selectedDesktopSource;
}
let currentVideoPath: string | null = null;

function normalizePath(filePath: string) {
	return path.resolve(filePath);
}

function normalizeVideoSourcePath(videoPath?: string | null): string | null {
	if (typeof videoPath !== "string") {
		return null;
	}

	const trimmed = videoPath.trim();
	if (!trimmed) {
		return null;
	}

	const protocolPath = fromKlipptMediaUrl(trimmed);
	if (protocolPath) {
		return protocolPath;
	}

	if (/^file:\/\//i.test(trimmed)) {
		try {
			return fileURLToPath(trimmed);
		} catch {
			// Fall through and keep best-effort string path below.
		}
	}

	return trimmed;
}

function isTrustedProjectPath(filePath?: string | null) {
	if (!filePath || !currentProjectPath) {
		return false;
	}
	return normalizePath(filePath) === normalizePath(currentProjectPath);
}

const CURSOR_SAMPLE_INTERVAL_MS = 33;
const MAX_CURSOR_SAMPLES = 60 * 60 * 30; // 1 hour @ 30Hz

let cursorRecordingSession: CursorRecordingSession | null = null;
let pendingCursorRecordingData: CursorRecordingData | null = null;
let isDirectionExcludedPoint: (point: { x: number; y: number }) => boolean = () => false;
let nativeWindowsCaptureProcess: ChildProcessWithoutNullStreams | null = null;
let nativeWindowsCaptureOutput = "";
let nativeWindowsCaptureTargetPath: string | null = null;
let nativeWindowsCaptureWebcamTargetPath: string | null = null;
let nativeWindowsCaptureRecordingId: number | null = null;
let nativeWindowsCursorOffsetMs = 0;
let nativeWindowsCursorCaptureMode: CursorCaptureMode = "editable-overlay";
let nativeWindowsCursorRecordingStartMs = 0;
let nativeWindowsPauseStartedAtMs: number | null = null;
let nativeWindowsPauseRanges: Array<{ startMs: number; endMs: number }> = [];
let nativeWindowsIsPaused = false;
/**
 * The MP4 flavour the helper reported for THIS run, or null if it never said.
 * Read at stop, not for reporting: it is what decides whether a capture that
 * failed to finalize still left a playable file behind.
 */
let nativeWindowsCaptureContainer: string | null = null;
/** Cuts a surviving helper's output loose so it cannot pollute the next recording. */
let nativeWindowsCaptureDrainCleanup: (() => void) | null = null;

function detachNativeWindowsCaptureOutputDrain() {
	nativeWindowsCaptureDrainCleanup?.();
	nativeWindowsCaptureDrainCleanup = null;
}

function resetNativeWindowsCaptureState() {
	nativeWindowsCaptureDrainCleanup = null;
	nativeWindowsCaptureProcess = null;
	nativeWindowsCaptureTargetPath = null;
	nativeWindowsCaptureWebcamTargetPath = null;
	nativeWindowsCaptureRecordingId = null;
	nativeWindowsCursorOffsetMs = 0;
	nativeWindowsCursorCaptureMode = "editable-overlay";
	nativeWindowsCursorRecordingStartMs = 0;
	nativeWindowsPauseStartedAtMs = null;
	nativeWindowsPauseRanges = [];
	nativeWindowsIsPaused = false;
	nativeWindowsCaptureContainer = null;
}

/** Reads the file, then defers the judgement to the tested predicate. */
async function salvageNativeWindowsFragmentedCapture(screenVideoPath: string | null) {
	if (!screenVideoPath) {
		return false;
	}
	const stats = await fs.stat(screenVideoPath).catch(() => null);
	return isSalvageableFragmentedCapture(nativeWindowsCaptureContainer, stats?.size ?? null);
}

/**
 * Best-effort removal of the files a failed or discarded native Windows capture
 * left behind. Each removal is isolated: a helper that outlived its kill still
 * holds the MP4 open on Windows, and an EBUSY there must not mask why we were
 * cleaning up in the first place.
 */
async function removeNativeWindowsCaptureOutputs(
	screenVideoPath: string | null,
	webcamVideoPath: string | null,
	options: { onlyIfUnusable?: boolean } = {},
) {
	const targets = [
		screenVideoPath,
		webcamVideoPath,
		screenVideoPath ? `${screenVideoPath}.cursor.json` : null,
	];

	for (const target of targets) {
		if (!target || !isPathWithinDir(target, RECORDINGS_DIR)) {
			continue;
		}
		try {
			if (options.onlyIfUnusable && target !== `${screenVideoPath}.cursor.json`) {
				const stats = await fs.stat(target).catch(() => null);
				if (stats && stats.size >= NATIVE_WINDOWS_SALVAGEABLE_OUTPUT_BYTES) {
					console.warn(
						"[native-wgc] keeping a capture output that may still be playable:",
						target,
						stats.size,
					);
					continue;
				}
			}
			await fs.rm(target, { force: true });
		} catch (error) {
			console.warn("[native-wgc] could not remove leftover capture output:", target, error);
		}
	}
}
function getNativeMacSessionManifestPath(recordingId: number) {
	return path.join(
		RECORDINGS_DIR,
		`${RECORDING_FILE_PREFIX}${recordingId}${RECORDING_SESSION_SUFFIX}`,
	);
}

let linuxClipMetadata: LinuxClipCaptureMetadata | null = null;

function linuxSourceLabel(kind?: "monitor" | "window" | "virtual"): string {
	return mainT(
		"common",
		kind === "window"
			? "recordingSource.window"
			: kind === "monitor"
				? "recordingSource.screen"
				: kind === "virtual"
					? "recordingSource.virtual"
					: "recordingSource.unknown",
	);
}

// Sidecar readers stay independent of Electron. The shared pure path policy
// resolves the same recordings directory after bootstrap has selected userData.
const cursorSidecarOptions = () => ({ recordingsDir: RECORDINGS_DIR });

const readCursorRecordingFile = (targetVideoPath: string) =>
	readCursorRecordingFileFrom(targetVideoPath, cursorSidecarOptions());

const readCursorTelemetryFile = (targetVideoPath: string) =>
	readCursorTelemetryFileFrom(targetVideoPath, cursorSidecarOptions());

function resolveAssetBasePath() {
	return `${KLIPPT_APP_ORIGIN}${KLIPPT_RESOURCE_PATH_PREFIX}assets/`;
}

function getSelectedSourceBounds() {
	// Single-window capture records only the window's region, not the whole display.
	// Normalizing the cursor against display bounds leaves a fixed offset in the export,
	// so prefer the helper-reported window frame when capturing a window.
	const isWindowSource = selectedSource?.id?.startsWith("window:") === true;
	const nativeMacCaptureBounds = nativeMacRecordingService?.captureBounds;
	if (isWindowSource && nativeMacCaptureBounds) {
		return nativeMacCaptureBounds;
	}

	const cursor = screen.getCursorScreenPoint();
	const sourceDisplayId = Number(selectedSource?.display_id);
	const sourceDisplay = Number.isFinite(sourceDisplayId)
		? (screen.getAllDisplays().find((display) => display.id === sourceDisplayId) ?? null)
		: null;
	return (sourceDisplay ?? screen.getDisplayNearestPoint(cursor)).bounds;
}

/**
 * The recorded source's shape, when known: a captured window's frame, or the
 * chosen display, or else the display the recorder sits on, which is what
 * "Entire screen" records.
 */
export function getSelectedSourceAspectRatio(
	fallbackDisplay: Electron.Display,
): number | undefined {
	const isWindowSource = selectedSource?.id?.startsWith("window:") === true;
	const bounds = isWindowSource
		? nativeMacRecordingService?.captureBounds
		: (getSelectedDisplay() ?? fallbackDisplay).bounds;
	return bounds && bounds.width > 0 && bounds.height > 0 ? bounds.width / bounds.height : undefined;
}

function getSelectedSourceId() {
	return typeof selectedSource?.id === "string" ? selectedSource.id : null;
}

function getSelectedDisplay() {
	const sourceDisplayId = Number(selectedSource?.display_id);
	if (!Number.isFinite(sourceDisplayId)) {
		return null;
	}

	return screen.getAllDisplays().find((display) => display.id === sourceDisplayId) ?? null;
}

function getNativeWindowsCaptureHelperCandidates() {
	return buildNativeWindowsCaptureHelperCandidates({
		appPath: app.getAppPath(),
		isPackaged: app.isPackaged,
		resourcesPath: process.resourcesPath,
		arch: process.arch,
		envOverride: process.env.OPENSCREEN_WGC_CAPTURE_EXE,
	});
}

async function findNativeWindowsCaptureHelperPath() {
	if (process.platform !== "win32") {
		return null;
	}

	for (const candidate of getNativeWindowsCaptureHelperCandidates()) {
		try {
			await fs.access(candidate, fsConstants.X_OK);
			return candidate;
		} catch {
			// Try the next configured helper location.
		}
	}

	return null;
}

function getNativeMacCaptureHelperCandidates() {
	return buildNativeMacCaptureHelperCandidates({
		appPath: app.getAppPath(),
		isPackaged: app.isPackaged,
		resourcesPath: process.resourcesPath,
		arch: process.arch,
		envOverride: process.env.OPENSCREEN_SCK_CAPTURE_EXE,
	});
}

async function findNativeMacCaptureHelperPath() {
	if (process.platform !== "darwin") {
		return null;
	}

	for (const candidate of getNativeMacCaptureHelperCandidates()) {
		try {
			await fs.access(candidate, fsConstants.X_OK);
			return candidate;
		} catch {
			// Try the next configured helper location.
		}
	}

	return null;
}

function isWindowsGraphicsCaptureOsSupported() {
	if (process.platform !== "win32") {
		return false;
	}

	const [, , build] = process.getSystemVersion().split(".").map(Number);
	return Number.isFinite(build) && build >= 19041;
}

function normalizeNativeDeviceName(value: string) {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

function scoreNativeDeviceName(candidateName: string, candidateId: string, requestedName?: string) {
	const candidate = normalizeNativeDeviceName(candidateName);
	const id = normalizeNativeDeviceName(candidateId);
	const requested = normalizeNativeDeviceName(requestedName ?? "");
	if (!requested) {
		return 0;
	}
	if (candidate === requested) {
		return 1000;
	}
	if (candidate.includes(requested) || requested.includes(candidate)) {
		return 900;
	}
	if (id.includes(requested) || requested.includes(id)) {
		return 800;
	}

	return requested
		.split(/\s+/)
		.filter((word) => word.length > 1 && !["camera", "webcam", "video", "input"].includes(word))
		.reduce((score, word) => {
			if (candidate.includes(word)) return score + 100;
			if (id.includes(word)) return score + 50;
			return score;
		}, 0);
}

function queryDirectShowVideoInputRegistry() {
	return new Promise<string>((resolve) => {
		const proc = spawn(
			"reg.exe",
			["query", "HKCR\\CLSID\\{860BB310-5D01-11D0-BD3B-00A0C911CE86}\\Instance", "/s"],
			{ windowsHide: true },
		);
		let stdout = "";
		proc.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf16le").includes("\u0000")
				? chunk.toString("utf16le")
				: chunk.toString();
		});
		proc.on("close", () => resolve(stdout));
		proc.on("error", () => resolve(""));
	});
}

async function resolveDirectShowWebcamClsid(deviceName?: string) {
	if (process.platform !== "win32" || !deviceName?.trim()) {
		return null;
	}

	const output = await queryDirectShowVideoInputRegistry();
	let current: { friendlyName?: string; clsid?: string } = {};
	const entries: Array<{ friendlyName?: string; clsid?: string }> = [];
	for (const rawLine of output.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;
		if (/^HKEY_/i.test(line)) {
			if (current.friendlyName || current.clsid) entries.push(current);
			current = {};
			continue;
		}
		const match = line.match(/^(\S+)\s+REG_SZ\s+(.+)$/);
		if (!match) continue;
		if (match[1] === "FriendlyName") current.friendlyName = match[2].trim();
		if (match[1] === "CLSID") current.clsid = match[2].trim();
	}
	if (current.friendlyName || current.clsid) entries.push(current);

	let best: { clsid: string; friendlyName?: string; score: number } | null = null;
	for (const entry of entries) {
		if (!entry.clsid) continue;
		const score = scoreNativeDeviceName(entry.friendlyName ?? "", entry.clsid, deviceName);
		if (!best || score > best.score) {
			best = { clsid: entry.clsid, friendlyName: entry.friendlyName, score };
		}
	}

	if (!best || best.score <= 0) {
		return null;
	}

	console.info("[native-wgc] resolved DirectShow webcam filter", {
		requestedName: deviceName,
		filterName: best.friendlyName,
		clsid: best.clsid,
		score: best.score,
	});
	return best.clsid;
}

async function startCursorRecording(recordingId?: number) {
	// On Linux the native capture helper already produces cursor samples, from
	// the SAME portal session that produces the pixels. Spawning the cursor-only
	// helper alongside it would open a SECOND portal session — and since
	// SelectSources may be called once per session, that means a second picker
	// in front of the user, for a stream nothing consumes. The double prompt is
	// precisely what the native path exists to remove.
	if (process.platform === "linux") {
		return false;
	}

	if (cursorRecordingSession) {
		pendingCursorRecordingData = await cursorRecordingSession.stop();
		cursorRecordingSession = null;
	}

	pendingCursorRecordingData = null;
	cursorRecordingSession = createCursorRecordingSession({
		getDisplayBounds: getSelectedSourceBounds,
		isDirectionExcludedPoint,
		maxSamples: MAX_CURSOR_SAMPLES,
		platform: process.platform,
		sampleIntervalMs: CURSOR_SAMPLE_INTERVAL_MS,
		sourceId: getSelectedSourceId(),
		startTimeMs:
			typeof recordingId === "number" && Number.isFinite(recordingId) ? recordingId : undefined,
	});

	try {
		await cursorRecordingSession.start();
		return true;
	} catch (error) {
		console.error("Failed to start cursor recording session:", error);
		cursorRecordingSession = null;
		return false;
	}
}

async function stopCursorRecording() {
	if (!cursorRecordingSession) {
		return;
	}

	try {
		pendingCursorRecordingData = await cursorRecordingSession.stop();
	} catch (error) {
		console.error("Failed to stop cursor recording session:", error);
		pendingCursorRecordingData = null;
	} finally {
		cursorRecordingSession = null;
	}
}

async function writePendingCursorTelemetry(videoPath: string) {
	const telemetryPath = `${videoPath}.cursor.json`;
	if (
		pendingCursorRecordingData &&
		(pendingCursorRecordingData.samples.length > 0 ||
			(pendingCursorRecordingData.keyboardActivity?.length ?? 0) > 0)
	) {
		await fs.writeFile(telemetryPath, JSON.stringify(pendingCursorRecordingData, null, 2), "utf-8");
	}
	pendingCursorRecordingData = null;
}

async function writePendingCursorTelemetryForClips(clips: RecordingSessionClip[]) {
	const recording = pendingCursorRecordingData;
	if (
		!recording ||
		(recording.samples.length === 0 && (recording.keyboardActivity?.length ?? 0) === 0) ||
		clips.length === 0
	) {
		if (pendingCursorRecordingData === recording) pendingCursorRecordingData = null;
		return;
	}

	for (const split of splitCursorRecordingForClips(recording, clips)) {
		if (
			split.clip.cursorCaptureMode === "editable-overlay" &&
			(split.recording.samples.length > 0 || (split.recording.keyboardActivity?.length ?? 0) > 0)
		) {
			await fs.writeFile(
				`${split.clip.screenVideoPath}.cursor.json`,
				JSON.stringify(split.recording, null, 2),
				"utf-8",
			);
		}
	}
	if (pendingCursorRecordingData === recording) pendingCursorRecordingData = null;
}

// P4 — proactively seeds the media-links registry for a fresh recording so
// its camera/cursor-telemetry links can still be found later even if the
// screen video is moved, renamed, or imported into a different project.
// Best-effort: a registry write hiccup must never fail the recording flow.
async function registerRecordingMediaLinks(
	screenVideoPath: string,
	options: {
		webcamVideoPath?: string;
		webcamOffsetMs?: number;
		cursorCaptureMode?: CursorCaptureMode;
	},
) {
	try {
		const cursorTelemetryPath = `${screenVideoPath}.cursor.json`;
		const hasCursorTelemetry = await fs
			.access(cursorTelemetryPath, fsConstants.F_OK)
			.then(() => true)
			.catch(() => false);
		await registerMediaLinks(RECORDINGS_DIR, screenVideoPath, {
			...(options.webcamVideoPath ? { webcamVideoPath: options.webcamVideoPath } : {}),
			...(options.webcamVideoPath && Number.isFinite(options.webcamOffsetMs)
				? { webcamOffsetMs: options.webcamOffsetMs }
				: {}),
			...(hasCursorTelemetry ? { cursorTelemetryPath } : {}),
			...(options.cursorCaptureMode ? { cursorCaptureMode: options.cursorCaptureMode } : {}),
		});
	} catch (error) {
		console.warn("[media-links] failed to register recording links:", error);
	}
}

function shiftPendingCursorTelemetry(offsetMs: number) {
	if (!pendingCursorRecordingData || !Number.isFinite(offsetMs) || offsetMs <= 0) {
		return;
	}

	pendingCursorRecordingData = shiftCursorRecordingToVideoStart(
		pendingCursorRecordingData,
		offsetMs,
	);
}

function compactPendingCursorTelemetryPauseRanges(
	ranges: Array<{ startMs: number; endMs: number }>,
) {
	if (!pendingCursorRecordingData || ranges.length === 0) {
		return;
	}

	pendingCursorRecordingData = compactCursorRecordingPauseRanges(
		pendingCursorRecordingData,
		ranges,
	);
}

function completeNativeWindowsCursorPauseRange(endMs = Date.now()) {
	if (nativeWindowsPauseStartedAtMs === null || nativeWindowsCursorRecordingStartMs <= 0) {
		return;
	}

	nativeWindowsPauseRanges.push({
		startMs: Math.max(0, nativeWindowsPauseStartedAtMs - nativeWindowsCursorRecordingStartMs),
		endMs: Math.max(0, endMs - nativeWindowsCursorRecordingStartMs),
	});
	nativeWindowsPauseStartedAtMs = null;
}

function waitForNativeWindowsCaptureStart(proc: ChildProcessWithoutNullStreams) {
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error("Timed out waiting for native Windows capture to start"));
		}, 12000);

		// Observes only. `attachNativeWindowsCaptureOutputDrain` is the single
		// writer of `nativeWindowsCaptureOutput` and is registered first, so the
		// chunk that triggers this call is already in the buffer.
		const onOutput = () => {
			if (nativeWindowsCaptureOutput.includes("Recording started")) {
				cleanup();
				resolve();
			}
		};
		const onError = (error: Error) => {
			cleanup();
			reject(error);
		};
		const onExit = (code: number | null) => {
			cleanup();
			reject(
				new Error(
					nativeWindowsCaptureOutput.trim() ||
						`Native Windows capture exited before recording started (code=${code ?? "unknown"})`,
				),
			);
		};
		const cleanup = () => {
			clearTimeout(timer);
			proc.stdout.off("data", onOutput);
			proc.stderr.off("data", onOutput);
			proc.off("error", onError);
			proc.off("exit", onExit);
		};

		proc.stdout.on("data", onOutput);
		proc.stderr.on("data", onOutput);
		proc.once("error", onError);
		proc.once("exit", onExit);
	});
}

/**
 * Keeps reading the helper for as long as it lives.
 *
 * `waitForNativeWindowsCaptureStart` drops every listener the moment it sees
 * "Recording started", so until this existed the whole recording ran unobserved:
 * helper warnings and `[stop-timing]` diagnostics were discarded, which is why
 * issue #252 had no helper-side evidence from a real app run and had to be
 * reproduced by driving the .exe by hand. macOS has had this since it shipped
 * (`attachNativeMacCaptureOutputDrain`); Windows never did.
 */
function attachNativeWindowsCaptureOutputDrain(proc: ChildProcessWithoutNullStreams) {
	const drain = (chunk: Buffer) => {
		nativeWindowsCaptureOutput += chunk.toString();
	};
	const cleanup = () => {
		proc.stdout.off("data", drain);
		proc.stderr.off("data", drain);
	};

	proc.stdout.on("data", drain);
	proc.stderr.on("data", drain);
	proc.once("close", cleanup);
	// An 'error' event with no listener throws, and in the main process that is
	// an uncaught exception rather than a rejected promise. Both streams need a
	// sink for the whole life of the helper: stdin raises EPIPE when the helper
	// died before we wrote to it, and `kill()` on a wedged process re-emits its
	// failure on the ChildProcess itself.
	// All four emitters, not just stdin: `cleanup` only drops 'data', so an
	// abandoned-but-still-alive helper leaves these pipes open with no consumer,
	// and an ECONNRESET when the OS finally reaps it would take down the main
	// process.
	proc.stdin.on("error", (error) => {
		console.warn("[native-wgc] helper stdin error:", error);
	});
	proc.stdout.on("error", (error) => {
		console.warn("[native-wgc] helper stdout error:", error);
	});
	proc.stderr.on("error", (error) => {
		console.warn("[native-wgc] helper stderr error:", error);
	});
	proc.on("error", (error) => {
		console.warn("[native-wgc] helper process error:", error);
	});

	// Returned so an abandoned helper can be cut loose. A process that survived
	// both kill attempts keeps writing, and `nativeWindowsCaptureOutput` is
	// shared with whatever recording starts next.
	return cleanup;
}

/**
 * Sends `stop` and closes the command channel behind it.
 *
 * The helper treats stdin EOF as a stop too, so ending the stream is a free
 * second signal if the write itself is lost.
 */
function sendNativeWindowsStopCommand(proc: ChildProcessWithoutNullStreams) {
	if (!proc.stdin.writable) {
		return false;
	}

	proc.stdin.write("stop\n");
	proc.stdin.end();
	return true;
}

function readNativeWindowsWebcamFormat(output: string) {
	const lines = output.split(/\r?\n/).filter((line) => line.includes('"event":"webcam-format"'));
	const lastLine = lines.at(-1);
	if (!lastLine) {
		return null;
	}

	try {
		return JSON.parse(lastLine) as {
			width?: number;
			height?: number;
			fps?: number;
			deviceName?: string;
		};
	} catch {
		return null;
	}
}

function readNativeWindowsEncoderSelection(output: string) {
	const lines = output
		.split(/\r?\n/)
		.filter((line) => line.includes('"event":"encoder-selection"'));
	const lastLine = lines.at(-1);
	if (!lastLine) {
		return null;
	}

	try {
		return JSON.parse(lastLine) as {
			video?: string;
			// Which MP4 flavour the helper actually wrote, `fragmented-mp4` or
			// `mp4`. It reports this because the fragmented sink degrades to the
			// plain one rather than failing a recording, so the flavour is a
			// per-run outcome and not a property of the version. This is the only
			// thing that can answer "was this file supposed to survive a kill?",
			// which is what `salvageNativeWindowsFragmentedCapture` asks.
			container?: string;
			preferSoftwareEncoder?: boolean;
		};
	} catch {
		return null;
	}
}

/** Told whenever the current take's session changes after Stop (camera clips attached, edits). */
let currentSessionListener: ((session: RecordingSession) => void) | null = null;

function setCurrentRecordingSessionState(session: RecordingSession | null) {
	currentRecordingSession = session;
	currentVideoPath = session?.screenVideoPath ?? null;
	if (session) currentSessionListener?.(session);
}

/**
 * Marks the current recording handoff as durably consumed. The journal is
 * removed before process-local state changes, so a failed unlink remains
 * retryable after restart.
 */
export async function consumeCurrentRecordingSession(): Promise<void> {
	const session = currentRecordingSession;
	if (session) {
		await clearNativeMacRecoveryJournal(RECORDINGS_DIR, session.createdAt);
	}
	setCurrentRecordingSessionState(null);
	currentProjectPath = null;
}

function getSessionManifestPathForVideo(videoPath: string) {
	const parsedPath = path.parse(videoPath);
	const baseName = parsedPath.name.endsWith("-webcam")
		? parsedPath.name.slice(0, -"-webcam".length)
		: parsedPath.name;
	const nativeMacRecordingId = getNativeMacRecordingIdFromClipPath(videoPath);
	if (nativeMacRecordingId !== null) {
		return path.join(
			parsedPath.dir,
			`${RECORDING_FILE_PREFIX}${nativeMacRecordingId}${RECORDING_SESSION_SUFFIX}`,
		);
	}
	return path.join(parsedPath.dir, `${baseName}${RECORDING_SESSION_SUFFIX}`);
}

function getLegacySessionManifestPathForVideo(videoPath: string) {
	const parsedPath = path.parse(videoPath);
	const baseName = parsedPath.name.endsWith("-webcam")
		? parsedPath.name.slice(0, -"-webcam".length)
		: parsedPath.name;
	return path.join(parsedPath.dir, `${baseName}${RECORDING_SESSION_SUFFIX}`);
}

async function loadRecordedSessionForVideoPath(
	videoPath: string,
): Promise<RecordingSession | null> {
	try {
		let manifestPath = getSessionManifestPathForVideo(videoPath);
		if (!isPathAllowed(manifestPath)) {
			const parsedVideoPath = path.parse(videoPath);
			if (!isPathWithinDir(path.resolve(manifestPath), parsedVideoPath.dir)) {
				return null;
			}
		}

		let content: string;
		try {
			content = await fs.readFile(manifestPath, "utf-8");
		} catch (error) {
			const legacyManifestPath = getLegacySessionManifestPathForVideo(videoPath);
			if (legacyManifestPath === manifestPath) throw error;
			manifestPath = legacyManifestPath;
			content = await fs.readFile(manifestPath, "utf-8");
		}
		const session = normalizeRecordingSession(JSON.parse(content));
		if (!session) {
			return null;
		}

		const normalizedVideoPath = normalizePath(videoPath);
		const matchesScreen = normalizePath(session.screenVideoPath) === normalizedVideoPath;
		const matchesWebcam =
			typeof session.webcamVideoPath === "string" &&
			normalizePath(session.webcamVideoPath) === normalizedVideoPath;
		const matchesClip =
			session.schemaVersion === 2 &&
			(session.clips?.some((clip) => normalizePath(clip.screenVideoPath) === normalizedVideoPath) ??
				false);
		if (!matchesScreen && !matchesWebcam && !matchesClip) {
			return null;
		}

		if (!isPathAllowed(session.screenVideoPath)) {
			const approvedScreen = await approveReadableVideoPath(session.screenVideoPath, [
				path.dirname(manifestPath),
				RECORDINGS_DIR,
			]);
			if (!approvedScreen) {
				return null;
			}
			session.screenVideoPath = approvedScreen;
		}

		if (session.webcamVideoPath && !isPathAllowed(session.webcamVideoPath)) {
			const approvedWebcam = await approveReadableVideoPath(session.webcamVideoPath, [
				path.dirname(manifestPath),
				RECORDINGS_DIR,
			]);
			if (!approvedWebcam) {
				session.webcamVideoPath = undefined;
			} else {
				session.webcamVideoPath = approvedWebcam;
			}
		}

		approveFilePath(session.screenVideoPath);
		if (session.webcamVideoPath) {
			approveFilePath(session.webcamVideoPath);
		}
		return session;
	} catch (error) {
		const nodeError = error as NodeJS.ErrnoException;
		if (nodeError.code !== "ENOENT") {
			console.error("Failed to restore recording session manifest:", error);
		}
		return null;
	}
}

// P4 — resolves the camera (and cursor-telemetry path, though callers that
// only care about the camera can ignore it) for a screen-recording video,
// trying the cheap path-adjacency sidecar first (handles "just recorded" and
// pre-existing recordings) and falling back to the fingerprint registry
// (handles the file having been moved/renamed/imported from elsewhere).
// `videoPath` must already be normalized + approved by the caller.
async function resolveMediaLinksForVideo(videoPath: string): Promise<{
	webcamVideoPath?: string;
	webcamOffsetMs?: number;
	cursorTelemetryPath?: string;
	resolvedVia: "sidecar" | "fingerprint" | "none";
}> {
	const session = await loadRecordedSessionForVideoPath(videoPath);
	const cursorTelemetryPath = `${videoPath}.cursor.json`;
	const hasCursorTelemetry = await fs
		.access(cursorTelemetryPath, fsConstants.F_OK)
		.then(() => true)
		.catch(() => false);
	const sidecarLinks = {
		...(session?.webcamVideoPath
			? {
					webcamVideoPath: session.webcamVideoPath,
					webcamOffsetMs: session.webcamOffsetMs ?? 0,
				}
			: {}),
		...(hasCursorTelemetry ? { cursorTelemetryPath } : {}),
	};

	if (session?.webcamVideoPath || hasCursorTelemetry) {
		// Opportunistic backfill so the link survives a later move even if this
		// recording predates the registry, or if its sidecar doesn't travel with it.
		await registerMediaLinks(RECORDINGS_DIR, videoPath, {
			...(session?.webcamVideoPath ? { webcamVideoPath: session.webcamVideoPath } : {}),
			...(session?.webcamVideoPath && Number.isFinite(session.webcamOffsetMs)
				? { webcamOffsetMs: session.webcamOffsetMs }
				: {}),
			...(hasCursorTelemetry ? { cursorTelemetryPath } : {}),
		}).catch((error) => console.warn("[media-links] backfill failed:", error));
	}

	try {
		const resolution = await resolveMediaLinkSources(sidecarLinks, () =>
			findMediaLinksByFingerprint(RECORDINGS_DIR, videoPath),
		);
		if (resolution.webcamVideoPath || resolution.cursorTelemetryPath) {
			let webcamVideoPath = resolution.webcamVideoPath;
			if (webcamVideoPath && !isPathAllowed(webcamVideoPath)) {
				webcamVideoPath =
					(await approveReadableVideoPath(webcamVideoPath, [RECORDINGS_DIR])) ?? undefined;
			}
			return {
				...(webcamVideoPath
					? { webcamVideoPath, webcamOffsetMs: resolution.webcamOffsetMs ?? 0 }
					: {}),
				...(resolution.cursorTelemetryPath
					? { cursorTelemetryPath: resolution.cursorTelemetryPath }
					: {}),
				resolvedVia: resolution.resolvedVia,
			};
		}
		return resolution;
	} catch (error) {
		console.warn("[media-links] fingerprint lookup failed:", error);
	}

	return hasCursorTelemetry
		? { cursorTelemetryPath, resolvedVia: "sidecar" }
		: { resolvedVia: "none" };
}

export type TakeEvent =
	| { kind: "paused" }
	| { kind: "resuming" }
	| { kind: "changed" }
	| { kind: "stored"; session: RecordingSession }
	/** The stored session was rewritten, e.g. its camera clips were attached. */
	| { kind: "session-updated"; session: RecordingSession };

export function registerIpcHandlers(
	createEditorWindow: (options?: { compactReview?: boolean }) => void,
	createSourceSelectorWindow: () => BrowserWindow,
	createCountdownOverlayWindow: () => BrowserWindow,
	createNotesWindowWrapper: () => BrowserWindow,
	getMainWindow: () => BrowserWindow | null,
	getSourceSelectorWindow: () => BrowserWindow | null,
	getNotesWindow: () => BrowserWindow | null,
	getCountdownOverlayWindow?: () => BrowserWindow | null,
	onRecordingStateChange?: (recording: boolean, sourceName: string) => void,
	_switchToHud?: () => void,
	isPrivateRecordingUiPoint?: (point: { x: number; y: number }) => boolean,
	options: {
		restoreInterruptedRecording?: boolean;
		studioOwnsControls?: () => boolean;
		enableCleanVoiceJobs?: boolean;
		setCameraPreviewCaptureHidden?: (
			hidden: boolean,
			pipeWireNodeId?: number,
		) => void | Promise<void>;
		ipcMain?: RendererIpcMain;
		/** The saved recording setup or the selected source changed. */
		onRecordingSetupChanged?: () => void;
		/** A take's clips changed: a clip finished on Pause, capture is resuming, or Stop stored it. */
		onTakeEvent?: (event: TakeEvent) => void;
		/** Runs before capture starts or resumes, so a window on the recorded screen can step aside first. */
		beforeCapture?: (capture: {
			pipeWireNodeId: number | undefined;
			/** A single window is recorded, so other windows never appear in it. */
			windowSource: boolean;
		}) => Promise<void>;
	} = {},
): Promise<boolean> {
	currentSessionListener = (session) => options.onTakeEvent?.({ kind: "session-updated", session });
	const ipcMain = options.ipcMain ?? electronIpcMain;
	// The Studio reads the setup synchronously; load it once so it never shows defaults.
	void recordingPrefsStore.get().then(
		() => options.onRecordingSetupChanged?.(),
		() => undefined,
	);
	isDirectionExcludedPoint = isPrivateRecordingUiPoint ?? (() => false);
	const { config: entitlementConfig, service: entitlementService } = createEntitlementService({
		userDataPath: app.getPath("userData"),
		isPackaged: app.isPackaged,
	});
	registerEntitlementIpc(entitlementService, entitlementConfig, ipcMain);
	const exportBufferService = new CompositorViewService({
		exportJournalPath: path.join(app.getPath("userData"), "buffer-export-transactions.json"),
	});
	const exportTempDirectory = app.getPath("temp");
	const exportRecovery = Promise.all([
		exportBufferService.initializeExportRecovery(),
		cleanupOrphanedExportTemps(exportTempDirectory),
	]).catch((error) => {
		console.warn("[export] startup recovery failed:", error);
	});

	const startupRecordingRecovery = (async () => {
		await exportRecovery;
		if (
			(process.platform !== "darwin" && process.platform !== "linux") ||
			options.restoreInterruptedRecording === false
		) {
			return false;
		}
		try {
			const recoveredSession = await restoreLatestNativeMacRecoverySession(RECORDINGS_DIR);
			if (!recoveredSession) return false;
			setCurrentRecordingSessionState(recoveredSession);
			currentProjectPath = null;
			console.info(
				`[capture-mac] restoring interrupted recording ${recoveredSession.createdAt} in the editor`,
			);
			return true;
		} catch (error) {
			console.warn("[capture-mac] could not inspect recovery journals:", error);
			return false;
		}
	})();

	let recordingActive = false;
	// Linux's helper cannot inhibit idle itself the way macOS's does; see the class doc.
	const recordingWakeLock = new RecordingWakeLock(
		process.platform,
		{
			start: (type) => powerSaveBlocker.start(type),
			stop: (id) => powerSaveBlocker.stop(id),
		},
		(error) => console.warn("[capture-linux] could not keep the display awake:", error),
	);
	let thermalState: CleanVoiceThermalState = "unknown";
	let cpuSpeedLimitPercent: number | undefined;
	const workloadTelemetry = new WorkloadTelemetryService({
		rootDirectory: path.join(app.getPath("userData"), "diagnostics", "workloads"),
		sampleResources: createElectronWorkloadResourceSampler({
			getThermalState: () => thermalState,
			getCpuSpeedLimitPercent: () => cpuSpeedLimitPercent,
		}),
	});
	void workloadTelemetry.initialize().catch((error) => {
		console.warn("[diagnostics] workload telemetry startup failed:", error);
	});
	let activeCaptureWorkloadId: string | null = null;
	let activeCaptureFailure: WorkloadFailureCode | undefined;
	const captureOperation = (): WorkloadOperation => {
		if (process.platform === "darwin") return "screen-capturekit";
		if (process.platform === "win32") return "windows-graphics-capture";
		if (process.platform === "linux") return "linux-pipewire";
		return "browser-media-recorder";
	};
	const finishCaptureWorkload = (
		outcome: "succeeded" | "failed" | "cancelled" | "discarded" | "recovered",
		failureCode?: WorkloadFailureCode,
	) => {
		if (!activeCaptureWorkloadId) return;
		workloadTelemetry.finish(activeCaptureWorkloadId, outcome, failureCode);
		activeCaptureWorkloadId = null;
		activeCaptureFailure = undefined;
	};
	const recordNativeMacCaptureTelemetry = (telemetry: NativeMacCaptureTelemetry) => {
		const workloadId = activeCaptureWorkloadId;
		if (!workloadId) return;
		workloadTelemetry.observe(workloadId, "capture.requested_fps", telemetry.requestedVideoFps);
		workloadTelemetry.observe(workloadId, "capture.delivered_fps", telemetry.deliveredVideoFps);
		workloadTelemetry.observe(workloadId, "capture.pending_frames", telemetry.pendingVideoFrames);
		workloadTelemetry.observe(workloadId, "capture.dropped_frames", telemetry.droppedVideoFrames);
		// Samples ScreenCaptureKit delivered without new pixels (idle, blank, suspended,
		// started, stopped, other). Reported apart from dropped frames so a static screen
		// or a game below the requested rate does not read as capture loss.
		workloadTelemetry.observe(
			workloadId,
			"capture.incomplete_frames",
			telemetry.idleScreenSamples +
				telemetry.blankScreenSamples +
				telemetry.suspendedScreenSamples +
				telemetry.startedScreenSamples +
				telemetry.stoppedScreenSamples +
				telemetry.otherScreenSamples,
		);
		if (telemetry.systemAudioDriftMs) {
			workloadTelemetry.setMetricSummary(
				workloadId,
				"system_audio.timestamp_drift_ms",
				telemetry.systemAudioDriftMs,
			);
		}
		if (telemetry.screenTimestampDriftMs) {
			workloadTelemetry.setMetricSummary(
				workloadId,
				"capture.timestamp_drift_ms",
				telemetry.screenTimestampDriftMs,
			);
		}
		if (telemetry.screenDeliveryAgeMs) {
			workloadTelemetry.setMetricSummary(
				workloadId,
				"capture.source_delivery_age_ms",
				telemetry.screenDeliveryAgeMs,
			);
		}
		if (telemetry.completeScreenIntervalMs) {
			workloadTelemetry.setMetricSummary(
				workloadId,
				"capture.source_frame_interval_ms",
				telemetry.completeScreenIntervalMs,
			);
		}
		if (telemetry.microphoneDriftMs) {
			workloadTelemetry.setMetricSummary(
				workloadId,
				"microphone.timestamp_drift_ms",
				telemetry.microphoneDriftMs,
			);
		}
		if (telemetry.fragmentFinalizeMs) {
			workloadTelemetry.setMetricSummary(
				workloadId,
				"writer.fragment_finalize_ms",
				telemetry.fragmentFinalizeMs,
			);
		}
		if (telemetry.audioMaxQueueBytes !== undefined) {
			workloadTelemetry.observe(workloadId, "audio.queue_bytes", telemetry.audioMaxQueueBytes);
		}
		if (telemetry.writerMaxQueueDepth !== undefined) {
			workloadTelemetry.observe(workloadId, "writer.queue_depth", telemetry.writerMaxQueueDepth);
		}
		if (telemetry.audioBlockMs) {
			workloadTelemetry.setMetricSummary(workloadId, "audio.block_ms", telemetry.audioBlockMs);
		}
		workloadTelemetry.recordResourceSnapshot(workloadId, {
			lowPowerMode: telemetry.lowPowerMode,
			thermalState: telemetry.thermalState,
		});
	};
	const recordNativeWindowsCaptureTelemetry = () => {
		const workloadId = activeCaptureWorkloadId;
		if (!workloadId) return;
		const telemetry = parseNativeWindowsCaptureTelemetry(nativeWindowsCaptureOutput);
		if (telemetry.deliveredFps !== undefined) {
			workloadTelemetry.observe(workloadId, "capture.delivered_fps", telemetry.deliveredFps);
		}
		if (telemetry.gpuBridgeContendedFrames !== undefined) {
			workloadTelemetry.observe(
				workloadId,
				"capture.dropped_frames",
				telemetry.gpuBridgeContendedFrames,
			);
		}
		if (telemetry.encoderFinalizeMs !== undefined) {
			workloadTelemetry.observe(
				workloadId,
				"writer.fragment_finalize_ms",
				telemetry.encoderFinalizeMs,
			);
		}
		if (telemetry.stopTotalMs !== undefined) {
			workloadTelemetry.observe(workloadId, "writer.stop_total_ms", telemetry.stopTotalMs);
		}
	};
	ipcMain.removeAllListeners("workload-capture-performance");
	ipcMain.on("workload-capture-performance", (_event, value: unknown) => {
		if (!activeCaptureWorkloadId || !value || typeof value !== "object") return;
		const sample = value as {
			cameraDeliveredFps?: unknown;
			cameraTimestampDriftMs?: unknown;
		};
		const cameraDeliveredFps = sample.cameraDeliveredFps;
		if (
			typeof cameraDeliveredFps !== "number" ||
			!Number.isFinite(cameraDeliveredFps) ||
			cameraDeliveredFps < 0 ||
			cameraDeliveredFps > 240
		) {
			return;
		}
		workloadTelemetry.observe(activeCaptureWorkloadId, "camera.delivered_fps", cameraDeliveredFps);
		if (
			typeof sample.cameraTimestampDriftMs === "number" &&
			Number.isFinite(sample.cameraTimestampDriftMs) &&
			Math.abs(sample.cameraTimestampDriftMs) <= 60_000
		) {
			workloadTelemetry.observe(
				activeCaptureWorkloadId,
				"camera.timestamp_drift_ms",
				sample.cameraTimestampDriftMs,
			);
		}
	});
	let cleanVoiceService: CleanVoiceService | null = null;
	let cleanVoiceShuttingDown = false;
	const cleanVoiceServiceReady =
		options.enableCleanVoiceJobs === false || process.platform !== "darwin"
			? Promise.resolve(null)
			: (async () => {
					const ffmpegPath = resolveFfmpeg();
					const helperPath = await resolveCleanVoiceHelper(
						cleanVoiceHelperCandidates(app.getAppPath(), process.resourcesPath),
					);
					if (!ffmpegPath || !helperPath || cleanVoiceShuttingDown) return null;
					const service = new CleanVoiceService({
						cacheRoot: path.join(app.getPath("userData"), "derived-media", "clean-voice-v1"),
						// GUI startup owns the single-instance lock. CLI disables this service.
						pruneCompletedEntriesOnStartup: true,
						processor: createLocalCleanVoiceProcessor({ ffmpegPath, helperPath }),
						onStatus: (status) => {
							const editor = getMainWindow();
							if (editor && !editor.isDestroyed()) {
								editor.webContents.send("clean-voice:status", status);
							}
						},
					});
					service.setRecordingActive(recordingActive);
					service.setThermalState(thermalState);
					cleanVoiceService = service;
					return service;
				})().catch((error) => {
					console.warn("[clean-voice] background service is unavailable:", error);
					return null;
				});
	const notifyRecordingStateChange = (recording: boolean, sourceName: string) => {
		recordingActive = recording;
		recordingWakeLock.set(recording);
		cleanVoiceService?.setRecordingActive(recording);
		if (recording && !activeCaptureWorkloadId) {
			activeCaptureWorkloadId = workloadTelemetry.begin({
				kind: "capture",
				operation: captureOperation(),
				platform: process.platform,
				diskDirectory: RECORDINGS_DIR,
			});
			workloadTelemetry.startPhase(activeCaptureWorkloadId, "capture-active");
			workloadTelemetry.event(activeCaptureWorkloadId, "capture-started");
		}
		onRecordingStateChange?.(recording, sourceName);
	};
	const handleThermalStateChange = (details: { state: CleanVoiceThermalState }) => {
		thermalState = details.state;
		cleanVoiceService?.setThermalState(details.state);
	};
	const handleCpuSpeedLimitChange = (details: { limit: number }) => {
		cpuSpeedLimitPercent = details.limit;
	};
	if (process.platform === "darwin" || process.platform === "win32") {
		powerMonitor.on("speed-limit-change", handleCpuSpeedLimitChange);
	}
	app.once("before-quit", () => {
		powerMonitor.off("speed-limit-change", handleCpuSpeedLimitChange);
		workloadTelemetry.dispose();
	});
	if (options.enableCleanVoiceJobs !== false && process.platform === "darwin") {
		thermalState = powerMonitor.getCurrentThermalState();
		powerMonitor.on("thermal-state-change", handleThermalStateChange);
		app.once("before-quit", () => {
			cleanVoiceShuttingDown = true;
			powerMonitor.off("thermal-state-change", handleThermalStateChange);
			cleanVoiceService?.dispose();
		});
	}
	ipcMain.handle(
		"clean-voice:get-runtime",
		async (_event, projectId: string, assetIds: string[]) => {
			if (
				typeof projectId !== "string" ||
				projectId.length === 0 ||
				projectId.length > 256 ||
				!Array.isArray(assetIds) ||
				assetIds.length > 1_000 ||
				assetIds.some(
					(assetId) => typeof assetId !== "string" || assetId.length === 0 || assetId.length > 256,
				)
			) {
				return { available: false, assets: [] };
			}
			const service = await cleanVoiceServiceReady;
			return {
				available: service !== null,
				assets: service?.getStatuses(projectId, assetIds) ?? [],
			} satisfies import("../../src/lib/cleanVoiceRuntime").CleanVoiceRuntimeSnapshot;
		},
	);
	const rejectWithoutEntitlement = async (
		capability: import("../../src/lib/entitlements/contracts").EntitlementCapability,
	) => {
		try {
			await entitlementService.assertCapability(capability);
			return null;
		} catch (error) {
			return {
				success: false as const,
				code: "ENTITLEMENT_REQUIRED" as const,
				error: error instanceof Error ? error.message : "Klippt Pro is required.",
			};
		}
	};
	const markSuccessfulRecording = () => {
		void entitlementService.noteSuccessfulRecording().catch((error) => {
			console.error("Could not start the Klippt trial after recording:", error);
		});
	};
	async function requestScreenAccess() {
		if (process.platform !== "darwin") {
			return { success: true, granted: true, status: "granted" };
		}

		try {
			const status = systemPreferences.getMediaAccessStatus("screen");
			if (status === "granted") {
				return { success: true, granted: true, status };
			}

			// Screen recording has no askForMediaAccess equivalent, so trigger the
			// TCC prompt without opening OpenScreen's source selector above it.
			if (status === "not-determined") {
				const mainWin = getMainWindow();
				if (mainWin && !mainWin.isDestroyed()) {
					if (!mainWin.isVisible()) {
						mainWin.show();
					}
					mainWin.focus();
				}
				app.focus({ steal: true });
				desktopCapturer
					.getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } })
					.catch(() => {
						// Permission probing failure is reported by the explicit status check below.
					});
				return { success: true, granted: false, status: "not-determined" };
			}

			return { success: true, granted: false, status };
		} catch (error) {
			console.error("Failed to request screen access:", error);
			return { success: false, granted: false, status: "unknown", error: String(error) };
		}
	}

	ipcMain.handle("clipboard:write-text", async (_event, text: unknown) => {
		if (typeof text !== "string") {
			throw new TypeError("Clipboard text must be a string.");
		}
		await clipboard.writeText(text);
	});

	const dataUrl = (image: Electron.NativeImage, jpeg: boolean) =>
		jpeg ? `data:image/jpeg;base64,${image.toJPEG(82).toString("base64")}` : image.toDataURL();

	const readSources = async (requested: Electron.SourcesOptions) => {
		// On Wayland even enumeration opens a separate portal picker. Only the native
		// helper may request a grant, when Record is explicitly pressed.
		if (process.platform === "linux") return [];
		// Only a picker-sized read is worth reopening with; permission probes ask for 1x1.
		const pickerSized = (requested?.thumbnailSize?.width ?? 0) >= 160;
		const cheap =
			pickerSized &&
			lastPickerSources.length > 0 &&
			pickerThumbnailsAreFresh(lastPickerFullReadAt, Date.now());
		const opts = cheap
			? { types: requested.types, thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false }
			: requested;
		const sources = await desktopCapturer.getSources(opts);
		lastEnumeratedSources = mergeEnumeratedSources(lastEnumeratedSources, sources, opts.types);
		const read = sources.map((source) => ({
			id: source.id,
			name: source.name,
			display_id: source.display_id,
			thumbnail: source.thumbnail.isEmpty() ? null : dataUrl(source.thumbnail, true),
			appIcon: source.appIcon && !source.appIcon.isEmpty() ? dataUrl(source.appIcon, false) : null,
		}));
		const processed = cheap ? reusePickerThumbnails(read, lastPickerSources) : read;
		if (pickerSized) {
			lastPickerSources = processed;
			if (!cheap) lastPickerFullReadAt = Date.now();
		}
		return processed;
	};

	ipcMain.handle("get-sources", (_, opts) => readSources(opts));

	// With access already granted, the first picker open finds a list waiting.
	setTimeout(() => {
		if (process.platform !== "darwin" || lastPickerSources) return;
		if (systemPreferences.getMediaAccessStatus("screen") !== "granted") return;
		void readSources({
			types: ["screen", "window"],
			thumbnailSize: { width: 320, height: 180 },
			fetchWindowIcons: true,
		}).catch(() => undefined);
	}, 1500);

	// The picker opens on the last list at once and refreshes it in the background.
	ipcMain.handle("get-cached-sources", () => lastPickerSources);

	const warmNativeMacCapture = async () => {
		if (process.platform !== "darwin" || nativeMacRecordingService?.isRunning()) return;
		const helperPath = await findNativeMacCaptureHelperPath();
		if (helperPath && !nativeMacRecordingService?.isRunning()) nativeMacStandby.warm(helperPath);
	};
	ipcMain.handle("prewarm-native-mac-capture", warmNativeMacCapture);
	// Only the window that shows the camera may keep it warm, and only while it lives.
	let warmCameraOwner: Electron.WebContents | null = null;
	ipcMain.on("set-native-mac-warm-camera", (event, camera: unknown) => {
		if (process.platform !== "darwin") return;
		const webcam = (camera as { webcam?: Record<string, unknown> } | null)?.webcam;
		const valid =
			webcam?.enabled === true &&
			[webcam.width, webcam.height, webcam.fps].every((value) => Number.isFinite(value));
		if (!valid) {
			if (warmCameraOwner === event.sender || warmCameraOwner === null) {
				warmCameraOwner = null;
				nativeMacStandby.setWarmCamera(null);
			}
			return;
		}
		if (warmCameraOwner !== event.sender) {
			const owner = event.sender;
			warmCameraOwner = owner;
			owner.once("destroyed", () => {
				if (warmCameraOwner !== owner) return;
				warmCameraOwner = null;
				nativeMacStandby.setWarmCamera(null);
			});
		}
		nativeMacStandby.setWarmCamera(camera);
	});

	ipcMain.handle("select-source", async (_, source: SelectedSource) =>
		timeClipBoundary("pick", () =>
			serializeRecordingSetup(async () => {
				activeClipBoundaryTimeline?.mark("setup-queue-free");
				selectedSource = source;
				unavailableRecordingSource = null;
				// Reuse the exact source object returned during enumeration to avoid
				// Windows window-source id mismatches across separate getSources() calls.
				selectedDesktopSource =
					typeof source.id === "string" ? (lastEnumeratedSources.get(source.id) ?? null) : null;

				if (
					process.platform !== "linux" &&
					!selectedDesktopSource &&
					typeof source.id === "string"
				) {
					try {
						const types: Array<"screen" | "window"> = ["screen", "window"];
						const sources = await desktopCapturer.getSources({
							types,
							thumbnailSize: { width: 0, height: 0 },
							fetchWindowIcons: true,
						});
						lastEnumeratedSources = mergeEnumeratedSources(lastEnumeratedSources, sources, types);
						selectedDesktopSource = lastEnumeratedSources.get(source.id) ?? null;
					} catch {
						selectedDesktopSource = null;
					}
					activeClipBoundaryTimeline?.mark("source-enumerated");
				} else {
					activeClipBoundaryTimeline?.mark("source-cached");
				}
				await saveProjectRecordingSetup();
				activeClipBoundaryTimeline?.mark("setup-saved");
				const mainWin = getMainWindow();
				if (mainWin && !mainWin.isDestroyed()) {
					mainWin.webContents.send("selected-source-changed", selectedSource);
				}
				options.onRecordingSetupChanged?.();
				const sourceSelectorWin = getSourceSelectorWindow();
				if (sourceSelectorWin) {
					sourceSelectorWin.close();
				}
				return selectedSource;
			}),
		),
	);

	ipcMain.handle("get-selected-source", () => {
		return selectedSource;
	});

	ipcMain.handle("get-recording-prefs", async () => {
		return await recordingPrefsStore.get();
	});

	ipcMain.handle("set-recording-prefs", async (_, prefs: Partial<RecordingPrefs>) =>
		serializeRecordingSetup(async () => {
			const projectId = currentRecordingWorkspaceContext?.projectId;
			const recordingPrefs = await recordingPrefsStore.update(prefs);
			if (projectId) {
				await projectRecordingSetupStore.set(projectId, {
					prefs: recordingPrefs,
					source: recordingSource(selectedSource) ?? unavailableRecordingSource,
				});
			}
			// The recording HUD owns the controls, while the separate camera window owns
			// the confidence monitor. Broadcast one normalized value so both renderers
			// change device/format/visibility from the same persisted state.
			for (const appWindow of BrowserWindow.getAllWindows()) {
				if (!appWindow.isDestroyed()) {
					appWindow.webContents.send("recording-prefs-changed", recordingPrefs);
				}
			}
			options.onRecordingSetupChanged?.();
			return recordingPrefs;
		}),
	);

	ipcMain.handle("open-camera-privacy-settings", async () => {
		if (process.platform !== "darwin") return false;
		await shell.openExternal(
			"x-apple.systempreferences:com.apple.preference.security?Privacy_Camera",
		);
		return true;
	});

	ipcMain.handle("request-camera-access", async () => {
		if (process.platform !== "darwin") {
			return { success: true, granted: true, status: "granted" };
		}

		try {
			const status = systemPreferences.getMediaAccessStatus("camera");
			if (status === "granted") {
				return { success: true, granted: true, status };
			}

			if (status === "not-determined") {
				const granted = await systemPreferences.askForMediaAccess("camera");
				return {
					success: true,
					granted,
					status: granted ? "granted" : systemPreferences.getMediaAccessStatus("camera"),
				};
			}

			return { success: true, granted: false, status };
		} catch (error) {
			console.error("Failed to request camera access:", error);
			return {
				success: false,
				granted: false,
				status: "unknown",
				error: String(error),
			};
		}
	});

	ipcMain.handle("request-screen-access", async () => {
		return requestScreenAccess();
	});

	// Read-only: the HUD explains what Klippt needs before any macOS prompt appears.
	ipcMain.handle("get-capture-permissions", () => readCapturePermissions());

	ipcMain.handle("request-microphone-access", async () => {
		if (process.platform !== "darwin") return { granted: true, status: "granted" };
		const granted = await systemPreferences.askForMediaAccess("microphone").catch(() => false);
		return { granted, status: systemPreferences.getMediaAccessStatus("microphone") };
	});

	ipcMain.handle("open-privacy-settings", async (_event, kind: unknown) => {
		const pane = privacySettingsPane(kind);
		if (process.platform !== "darwin" || !pane) return false;
		await shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${pane}`);
		return true;
	});

	// macOS applies a new Screen Recording grant only to a fresh process.
	ipcMain.handle("relaunch-app", () => {
		app.relaunch();
		app.quit();
	});

	ipcMain.handle("request-native-mac-cursor-access", async () => {
		if (process.platform === "darwin" && !systemPreferences.isTrustedAccessibilityClient(false)) {
			return { success: true, granted: false, status: "not-determined" };
		}
		const access = await requestMacCursorAccessibilityAccess();

		return access;
	});

	ipcMain.handle("open-source-selector", async () => {
		const rejection = await rejectWithoutEntitlement("record");
		if (rejection) return { opened: false, reason: rejection.code, ...rejection };
		// The portal owns Linux source selection. The selector's
		// own `desktopCapturer.getSources()` raises a portal dialog — a SECOND
		// one, for a session that is thrown away — and whatever it returns cannot
		// reach the helper, because `SelectSources` has no parameter naming a
		// source. Refusing keeps that dialog from appearing at all.
		//

		if (process.platform === "linux") {
			return { opened: false, reason: "portal-owns-selection" };
		}

		const access = await requestScreenAccess();
		if (!access.granted) {
			if (process.platform === "darwin" && access.status !== "not-determined") {
				const mainWin = getMainWindow();
				const messageOptions = {
					type: "warning",
					buttons: [mainT("common", "permissions.openSettings"), mainT("common", "actions.cancel")],
					defaultId: 0,
					cancelId: 1,
					message: mainT("common", "permissions.screenTitle", { app: APP_DISPLAY_NAME }),
					detail: mainT("common", "permissions.screenDetail", { app: APP_DISPLAY_NAME }),
				} satisfies Electron.MessageBoxOptions;
				const result =
					mainWin && !mainWin.isDestroyed()
						? await dialog.showMessageBox(mainWin, messageOptions)
						: await dialog.showMessageBox(messageOptions);
				if (result.response === 0) {
					await shell.openExternal(
						"x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
					);
				}
			}
			return {
				opened: false,
				reason: "screen-access-required",
				access,
			};
		}

		const sourceSelectorWin = getSourceSelectorWindow();
		if (sourceSelectorWin) {
			sourceSelectorWin.focus();
			return { opened: true };
		}
		createSourceSelectorWindow();
		return { opened: true };
	});

	ipcMain.handle("open-notes", async () => {
		const notesSelectorWin = getNotesWindow();
		if (notesSelectorWin) {
			notesSelectorWin.focus();
			return { opened: true };
		}

		createNotesWindowWrapper();
		return { opened: true };
	});

	ipcMain.handle("switch-to-editor", (_event, options?: { compactReview?: boolean }) =>
		serializeRecordingSetup(async () => {
			// The main-process wrapper owns the HUD/editor hand-off. Closing either
			// window here would race that lifecycle and can leave a ghost overlay.
			createEditorWindow({ compactReview: options?.compactReview === true });
		}),
	);

	// The small review player grows into the full review window on request.
	ipcMain.handle("expand-review-window", (event) => {
		const win = BrowserWindow.fromWebContents(event.sender);
		if (!win || win.isDestroyed()) return { success: false };
		win.setMinimumSize(800, 600);
		win.maximize();
		return { success: true };
	});

	ipcMain.handle("switch-to-hud", () => {
		_switchToHud?.();
		return { success: true };
	});

	ipcMain.handle("start-new-recording", async (_event, context?: RecordingWorkspaceContext) =>
		serializeRecordingSetup(async () => {
			const rejection = await rejectWithoutEntitlement("record");
			if (rejection) return rejection;
			const workspace = normalizeRecordingWorkspaceContext(context);
			const setup = workspace ? await projectRecordingSetupStore.get(workspace.projectId) : null;
			if (setup) {
				let source: DesktopCapturerSource | null = null;
				if (setup.source && process.platform !== "linux") {
					const sources = await desktopCapturer.getSources({
						types: ["screen", "window"],
						thumbnailSize: { width: 0, height: 0 },
					});
					source = matchRecordingSource(setup.source, sources);
				}
				await recordingPrefsStore.update(setup.prefs);
				selectedSource = source
					? { id: source.id, name: source.name, display_id: source.display_id }
					: null;
				selectedDesktopSource = source;
				unavailableRecordingSource = source ? null : setup.source;
			} else {
				unavailableRecordingSource = null;
			}
			currentRecordingWorkspaceContext = workspace;
			await saveProjectRecordingSetup();
			_switchToHud?.();
			return { success: true };
		}),
	);

	ipcMain.handle("get-recording-workspace-context", () => ({
		success: currentRecordingWorkspaceContext !== null,
		context: currentRecordingWorkspaceContext,
	}));

	ipcMain.handle("set-recording-workspace-context", (_event, context: unknown) =>
		serializeRecordingSetup(async () => {
			currentRecordingWorkspaceContext = normalizeRecordingWorkspaceContext(context);
			return { success: true, context: currentRecordingWorkspaceContext };
		}),
	);

	ipcMain.handle("return-to-editor-if-recording-workspace", () =>
		serializeRecordingSetup(async () => {
			if (!currentRecordingWorkspaceContext) return { returned: false };
			createEditorWindow();
			return { returned: true };
		}),
	);

	const recordingStartupOverlay = createRecordingStartupOverlayController({
		getWindow: () => getCountdownOverlayWindow?.() ?? null,
		createWindow: createCountdownOverlayWindow,
	});
	ipcMain.handle("countdown-overlay-show", (_, value: number, runId: number) =>
		recordingStartupOverlay.show(value, runId),
	);
	ipcMain.handle("countdown-overlay-set-value", (_, value: number, runId: number) =>
		recordingStartupOverlay.setValue(value, runId),
	);
	ipcMain.handle("countdown-overlay-hide", (_, runId: number) =>
		recordingStartupOverlay.hide(runId),
	);

	ipcMain.handle("is-native-windows-capture-available", async () => {
		if (!isWindowsGraphicsCaptureOsSupported()) {
			return { success: true, available: false, reason: "unsupported-os" };
		}

		const helperPath = await findNativeWindowsCaptureHelperPath();
		return helperPath
			? { success: true, available: true, helperPath }
			: { success: true, available: false, reason: "missing-helper" };
	});

	ipcMain.handle("is-native-mac-capture-available", async () => {
		if (process.platform !== "darwin") {
			return { success: true, available: false, reason: "unsupported-platform" };
		}

		const helperPath = await findNativeMacCaptureHelperPath();
		return helperPath
			? { success: true, available: true, helperPath }
			: { success: true, available: false, reason: "missing-helper" };
	});

	ipcMain.handle("is-native-linux-capture-available", async () => {
		if (process.platform !== "linux") {
			return { success: true, available: false, reason: "unsupported-platform" };
		}

		const helperPath = findPipeWireCursorHelperPath();
		return helperPath
			? { success: true, available: true, helperPath }
			: { success: true, available: false, reason: "missing-helper" };
	});

	ipcMain.handle("acknowledge-native-recording-app-stop", (event, acknowledgement: unknown) => ({
		success: rendererRecordingStop.acknowledge(event.sender, acknowledgement),
	}));

	const beforeNativeCapture = () =>
		options.beforeCapture?.({
			pipeWireNodeId: process.platform === "linux" ? linuxClipMetadata?.pipeWireNodeId : undefined,
			windowSource: process.platform === "linux" && linuxClipMetadata?.sourceKind === "window",
		});

	const prepareNativeLinuxRecording = (
		request: NativeMacRecordingRequest,
	): Promise<NativeMacRecordingStartResult> =>
		withHiddenPortalHud(
			getMainWindow,
			async () => {
				await startupRecordingRecovery;
				if (!nativeMacRecordingService)
					return { success: false, error: "Native Linux capture is unavailable." };
				return nativeMacRecordingService.prepare(request);
			},
			() => rememberNiriHudPlacement(process.pid),
		);

	// Linux keeps its public IPC names while sharing the clip-native service.
	ipcMain.handle(
		"prepare-native-linux-recording",
		async (_, request: NativeLinuxRecordingRequest | NativeMacRecordingRequest) => {
			const rejection = await rejectWithoutEntitlement("record");
			if (rejection) return rejection;
			if (process.platform !== "linux") return { success: false, reason: "unsupported-platform" };
			return prepareNativeLinuxRecording(linuxClipRecordingRequest(request));
		},
	);
	ipcMain.handle("cancel-native-linux-prepare", async () => {
		linuxRecordingHud?.cancelPending();
		if (process.platform === "linux") await nativeMacRecordingService?.cancelPrepare();
		return { success: true };
	});
	const invokeNativeLinux = async <T>(
		operation: (service: NativeMacRecordingService) => Promise<T>,
	) => {
		if (process.platform !== "linux" || !nativeMacRecordingService)
			return { success: false, error: "Native Linux capture is unavailable." };
		try {
			return await operation(nativeMacRecordingService);
		} catch (error) {
			return { success: false, error: error instanceof Error ? error.message : String(error) };
		}
	};
	ipcMain.handle(
		"start-native-linux-recording",
		async (event, request: NativeLinuxRecordingRequest | NativeMacRecordingRequest) => {
			const rejection = await rejectWithoutEntitlement("record");
			if (rejection) return rejection;
			await startupRecordingRecovery;
			const result = await invokeNativeLinux(async (service) => {
				const config = linuxClipRecordingRequest(request);
				const studioAside = beforeNativeCapture;
				if (!service.isRunning()) {
					const prepared = await prepareNativeLinuxRecording(config);
					if (!prepared.success) return prepared;
					await studioAside();
					return recordingHud.capture(() =>
						service.start({ ...config, recordingId: prepared.recordingId }),
					);
				}
				await studioAside();
				return recordingHud.capture(() => service.start(config));
			});
			if (result.success && "recordingId" in result && typeof result.recordingId === "number")
				return {
					...result,
					rendererStop: rendererRecordingStop.bind(event.sender, result.recordingId),
				};
			return result;
		},
	);
	ipcMain.handle("pause-native-linux-recording", async () => {
		const result = await invokeNativeLinux((service) => service.pause());
		recordingHud.pauseCompleted();
		if ("success" in result && result.success) options.onTakeEvent?.({ kind: "paused" });
		return result;
	});
	ipcMain.handle(
		"resume-native-linux-recording",
		async (_, request?: NativeLinuxRecordingRequest | NativeMacRecordingRequest) => {
			options.onTakeEvent?.({ kind: "resuming" });
			await beforeNativeCapture();
			const result = await invokeNativeLinux((service) =>
				recordingHud.capture(() =>
					service.resume(request ? linuxClipRecordingRequest(request) : undefined),
				),
			);
			options.onTakeEvent?.({ kind: "changed" });
			return result;
		},
	);
	ipcMain.handle("stop-native-linux-recording", (_, discard?: boolean) => {
		recordingHud.cancelPending();
		return invokeNativeLinux((service) => service.stop(discard));
	});

	ipcMain.handle(
		"start-native-windows-recording",
		async (_, request: NativeWindowsRecordingRequest) => {
			const rejection = await rejectWithoutEntitlement("record");
			if (rejection) return rejection;
			try {
				if (!isWindowsGraphicsCaptureOsSupported()) {
					return {
						success: false,
						error: "Windows Graphics Capture requires Windows 10 build 19041 or newer.",
					};
				}
				if (nativeWindowsCaptureProcess) {
					return { success: false, error: "Native Windows capture is already running." };
				}

				const helperPath = await findNativeWindowsCaptureHelperPath();
				if (!helperPath) {
					return { success: false, error: "Native Windows capture helper is not available." };
				}

				if (!request?.source?.sourceId) {
					return {
						success: false,
						error: "Native Windows capture request is missing a source.",
					};
				}

				const recordingId =
					typeof request.recordingId === "number" && Number.isFinite(request.recordingId)
						? request.recordingId
						: Date.now();
				const outputPath = path.join(RECORDINGS_DIR, `${RECORDING_FILE_PREFIX}${recordingId}.mp4`);
				const webcamOutputPath = path.join(
					RECORDINGS_DIR,
					`${RECORDING_FILE_PREFIX}${recordingId}-webcam.mp4`,
				);
				const sourceDisplay =
					request.source.type === "display" && typeof request.source.displayId === "number"
						? (screen.getAllDisplays().find((display) => display.id === request.source.displayId) ??
							null)
						: getSelectedDisplay();
				const bounds = sourceDisplay?.bounds ?? getSelectedSourceBounds();
				// `bounds` is DIPs; the helper matches it against physical monitor rects
				// (getopenscreen/openscreen#346). Converted here, at the wire, and not in
				// `getSelectedSourceBounds` — the cursor session shares that getter and
				// converts on its own side.
				const helperBounds = toHelperRect(bounds);
				const displayId =
					typeof request.source.displayId === "number" && Number.isFinite(request.source.displayId)
						? request.source.displayId
						: Number(selectedSource?.display_id);
				const webcamDirectShowClsid = request.webcam.enabled
					? await resolveDirectShowWebcamClsid(request.webcam.deviceName)
					: null;
				const cursorCaptureMode =
					normalizeCursorCaptureMode(request.cursor?.mode) ?? "editable-overlay";
				const envPreferSoftwareEncoder = (process.env.OPENSCREEN_WGC_PREFER_SOFTWARE_ENCODER ?? "")
					.trim()
					.toLowerCase();
				const preferSoftwareEncoder =
					request.preferSoftwareEncoder === true ||
					envPreferSoftwareEncoder === "true" ||
					envPreferSoftwareEncoder === "1";
				const config = {
					schemaVersion: 2,
					recordingId,
					preferSoftwareEncoder,
					outputPath,
					sourceType: request.source.type,
					sourceId: request.source.sourceId,
					displayId: Number.isFinite(displayId) ? displayId : 0,
					windowHandle: request.source.windowHandle ?? null,
					fps: request.video.fps,
					videoWidth: request.video.width,
					videoHeight: request.video.height,
					displayX: helperBounds.x,
					displayY: helperBounds.y,
					displayW: helperBounds.width,
					displayH: helperBounds.height,
					hasDisplayBounds: true,
					captureSystemAudio: request.audio.system.enabled,
					captureMic: request.audio.microphone.enabled,
					microphoneDeviceId: request.audio.microphone.deviceId ?? null,
					microphoneDeviceName: request.audio.microphone.deviceName ?? null,
					microphoneGain: request.audio.microphone.gain,
					webcamEnabled: request.webcam.enabled,
					webcamDeviceId: request.webcam.deviceId ?? null,
					webcamDeviceName: request.webcam.deviceName ?? null,
					webcamDirectShowClsid,
					webcamWidth: request.webcam.width,
					webcamHeight: request.webcam.height,
					webcamFps: request.webcam.fps,
					captureCursor: cursorCaptureMode === "system",
					cursorCaptureMode,
					outputs: {
						screenPath: outputPath,
						webcamPath: webcamOutputPath,
					},
					source: {
						type: request.source.type,
						sourceId: request.source.sourceId,
						displayId: Number.isFinite(displayId) ? displayId : null,
						windowHandle: request.source.windowHandle ?? null,
						bounds: helperBounds,
					},
					video: request.video,
					audio: request.audio,
					webcam: request.webcam,
					cursor: {
						mode: cursorCaptureMode,
					},
				};

				console.info("[native-wgc] starting Windows capture", {
					helperPath,
					source: request.source,
					audio: request.audio,
					webcam: request.webcam,
					encoder: { preferSoftwareEncoder },
					cursor: { mode: cursorCaptureMode },
					// Both spaces, deliberately: the helper's own errors quote the physical
					// rect, and a report that only carried the DIP one would be read against
					// numbers it never saw (getopenscreen/openscreen#346).
					bounds: { dip: bounds, helper: helperBounds },
					sourceId: selectedSource?.id ?? null,
					usedDisplayMatch: Boolean(sourceDisplay),
					outputPath,
				});

				await fs.mkdir(RECORDINGS_DIR, { recursive: true });
				nativeWindowsCaptureOutput = "";
				nativeWindowsCaptureTargetPath = outputPath;
				nativeWindowsCaptureWebcamTargetPath = request.webcam.enabled ? webcamOutputPath : null;
				nativeWindowsCaptureRecordingId = recordingId;
				nativeWindowsCursorOffsetMs = 0;
				nativeWindowsCursorCaptureMode = cursorCaptureMode;
				nativeWindowsCursorRecordingStartMs = 0;
				nativeWindowsPauseStartedAtMs = null;
				nativeWindowsPauseRanges = [];
				nativeWindowsIsPaused = false;

				const cursorStartTimeMs = Date.now();
				if (cursorCaptureMode === "editable-overlay") {
					nativeWindowsCursorRecordingStartMs = cursorStartTimeMs;
					await startCursorRecording(cursorStartTimeMs);
					console.info("[native-wgc] cursor sampler ready", {
						cursorStartTimeMs,
						warmupMs: Date.now() - cursorStartTimeMs,
					});
				} else {
					pendingCursorRecordingData = null;
				}

				const proc = spawn(helperPath, [JSON.stringify(config)], {
					cwd: RECORDINGS_DIR,
					stdio: ["pipe", "pipe", "pipe"],
					windowsHide: true,
				});
				nativeWindowsCaptureProcess = proc;
				nativeWindowsCaptureDrainCleanup = attachNativeWindowsCaptureOutputDrain(proc);
				console.info("[native-wgc] helper spawned", { pid: proc.pid });

				await waitForNativeWindowsCaptureStart(proc);
				const captureStartedAtMs = Date.now();
				nativeWindowsCursorOffsetMs =
					cursorCaptureMode === "editable-overlay"
						? Math.max(0, captureStartedAtMs - cursorStartTimeMs)
						: 0;
				const webcamFormat = readNativeWindowsWebcamFormat(nativeWindowsCaptureOutput);
				const encoderSelection = readNativeWindowsEncoderSelection(nativeWindowsCaptureOutput);
				// Captured now because stop may have no helper left to ask. A helper
				// killed mid-recording is exactly the case where this matters most.
				nativeWindowsCaptureContainer = encoderSelection?.container ?? null;
				console.info("[native-wgc] capture started", {
					captureStartedAtMs,
					cursorOffsetMs: nativeWindowsCursorOffsetMs,
					webcamFormat,
					encoderSelection,
				});

				const source = selectedSource || { name: "Screen" };
				notifyRecordingStateChange(true, source.name);
				if (activeCaptureWorkloadId) {
					workloadTelemetry.configure(activeCaptureWorkloadId, {
						requestedVideoFps: request.video.fps,
						requestedCameraFps: request.webcam.enabled ? request.webcam.fps : undefined,
					});
					workloadTelemetry.observe(
						activeCaptureWorkloadId,
						"capture.requested_fps",
						request.video.fps,
					);
					if (request.webcam.enabled) {
						workloadTelemetry.observe(
							activeCaptureWorkloadId,
							"camera.requested_fps",
							request.webcam.fps,
						);
					}
					const encoder = encoderSelection?.video ?? "";
					if (encoder) {
						workloadTelemetry.addMediaPath(
							activeCaptureWorkloadId,
							encoder.includes("software")
								? "media-foundation-software"
								: "media-foundation-hardware",
						);
					}
					if (encoder.includes("fallback")) {
						workloadTelemetry.addFallback(activeCaptureWorkloadId, "encoder-hardware-to-software");
					}
					if (encoderSelection?.container === "mp4") {
						workloadTelemetry.addFallback(activeCaptureWorkloadId, "container-fragmented-to-plain");
					}
				}

				return {
					success: true,
					recordingId,
					path: outputPath,
					helperPath,
					videoEncoderSelection: encoderSelection?.video ?? null,
				};
			} catch (error) {
				console.error("Failed to start native Windows recording:", error);
				nativeWindowsCaptureProcess?.kill();
				detachNativeWindowsCaptureOutputDrain();
				resetNativeWindowsCaptureState();
				await stopCursorRecording();
				return { success: false, error: String(error) };
			}
		},
	);

	const resolveNativeMacCaptureConfig = (
		request: NativeMacRecordingRequest,
		recordingId: number,
		outputPath: string,
	): { config: NativeMacRecordingRequest; cursorCaptureMode: CursorCaptureMode } => {
		if (process.platform === "linux") {
			const config = linuxClipRecordingRequest(request);
			const cursorCaptureMode = normalizeCursorCaptureMode(config.cursor?.mode) ?? "system";
			return {
				cursorCaptureMode,
				config: {
					...config,
					recordingId,
					cursor: { mode: cursorCaptureMode },
					video: { ...config.video, hideSystemCursor: cursorCaptureMode === "editable-overlay" },
					outputs: {
						screenPath: outputPath,
						manifestPath: getNativeMacSessionManifestPath(recordingId),
					},
				},
			};
		}
		const cursorCaptureMode =
			normalizeCursorCaptureMode(request.cursor?.mode) ?? "editable-overlay";
		const sourceDisplay =
			request.source.type === "display" && typeof request.source.displayId === "number"
				? (screen.getAllDisplays().find((display) => display.id === request.source.displayId) ??
					null)
				: getSelectedDisplay();
		const bounds = request.source.bounds ?? sourceDisplay?.bounds ?? getSelectedSourceBounds();
		const appWindowIds: number[] = [];
		if (request.source.type === "display") {
			// The helper, HUD, editor, notes, and source picker must stay out of a
			// display recording after a paused source change as well as at first start.
			for (const appWindow of BrowserWindow.getAllWindows()) {
				if (appWindow.isDestroyed()) continue;
				try {
					const mediaSourceId = appWindow.getMediaSourceId();
					const match = mediaSourceId.match(/^window:(\d+):/);
					if (match) appWindowIds.push(Number(match[1]));
				} catch (error) {
					console.warn("[native-sck] could not resolve an app window id:", error);
				}
			}
		}
		const privateSource = addNativeMacDisplayPrivacyExclusions(request.source, {
			windowIds: appWindowIds,
			processId: process.pid,
		});

		return {
			cursorCaptureMode,
			config: {
				...request,
				schemaVersion: 1,
				recordingId,
				source: {
					...privateSource,
					bounds,
				},
				video: {
					...request.video,
					hideSystemCursor: cursorCaptureMode === "editable-overlay",
				},
				// Native camera originals are MOV files owned by the helper per clip.
				webcam: request.webcam,
				cursor: { mode: cursorCaptureMode },
				outputs: {
					screenPath: outputPath,
					manifestPath: path.join(
						RECORDINGS_DIR,
						`${RECORDING_FILE_PREFIX}${recordingId}${RECORDING_SESSION_SUFFIX}`,
					),
				},
			},
		};
	};

	const nativeMacStandby = new NativeMacStandbyHelper({
		spawn: (helperPath) =>
			spawn(helperPath, ["--standby"], { cwd: RECORDINGS_DIR, stdio: ["pipe", "pipe", "pipe"] }),
		now: Date.now,
	});
	// Keep one warmed helper ready while nothing records, so even the first Record
	// after launch skips the cold framework load. warm() is a no-op while it is fresh.
	const keepCaptureWarm =
		process.platform === "darwin"
			? setInterval(
					() => void warmNativeMacCapture().catch(() => undefined),
					STANDBY_HELPER_REWARM_INTERVAL_MS,
				)
			: null;
	keepCaptureWarm?.unref();
	if (process.platform === "darwin")
		setTimeout(() => void warmNativeMacCapture().catch(() => undefined), 1_000).unref();
	app.once("will-quit", () => {
		if (keepCaptureWarm) clearInterval(keepCaptureWarm);
		nativeMacStandby.discard();
	});

	// The HUD pauses a live take when there is nothing left to record: the captured window
	// closed, the screen locked, or the Mac is going to sleep.
	const notifyNativeMacInterruption = (reason: NativeMacRecordingInterruption) => {
		if (reason !== "microphone-defaulted" && !nativeMacRecordingService?.isRunning()) return;
		const hudWindow = getMainWindow();
		if (hudWindow && !hudWindow.isDestroyed()) {
			hudWindow.webContents.send("native-mac-recording-interrupted", reason);
		}
	};
	if (process.platform === "darwin") {
		const onLockScreen = () => notifyNativeMacInterruption("screen-locked");
		powerMonitor.on("lock-screen", onLockScreen);
		app.once("will-quit", () => powerMonitor.off("lock-screen", onLockScreen));
	}
	if (process.platform === "darwin" || process.platform === "linux") {
		const onSuspend = () => notifyNativeMacInterruption("system-sleep");
		powerMonitor.on("suspend", onSuspend);
		// A quit can still be cancelled at before-quit, and the take carries on.
		app.once("will-quit", () => powerMonitor.off("suspend", onSuspend));
	}

	const hudCaptureGuard = new NiriCaptureWindowGuard("Klippt", () => recordingHud.conceal());
	const recordingHud = new LinuxRecordingHud(
		process.platform,
		getMainWindow,
		() => nativeMacRecordingService?.isCapturing() ?? false,
		() => linuxClipMetadata?.sourceKind !== "window",
		() => new Promise((resolve) => setTimeout(resolve, 150)),
		() => {
			void activateNiriHud(process.pid).catch((error: unknown) =>
				console.warn("[capture-linux] recorder activation failed:", error),
			);
		},
		(hidden) => options.setCameraPreviewCaptureHidden?.(hidden, linuxClipMetadata?.pipeWireNodeId),
		{
			begin: () => hudCaptureGuard.begin(linuxClipMetadata?.pipeWireNodeId),
			end: () => hudCaptureGuard.end(),
		},
		() => !options.studioOwnsControls?.(),
	);
	const invalidateHudCapture = () => hudCaptureGuard.invalidate();
	screen.on("display-removed", invalidateHudCapture);
	screen.on("display-metrics-changed", invalidateHudCapture);
	app.once("will-quit", () => {
		hudCaptureGuard.end();
		screen.off("display-removed", invalidateHudCapture);
		screen.off("display-metrics-changed", invalidateHudCapture);
	});
	linuxRecordingHud = recordingHud;
	nativeMacRecordingService = new NativeMacRecordingService({
		recordingsDir: RECORDINGS_DIR,
		now: Date.now,
		...(process.platform === "linux"
			? { freeDiskBytes: (directory: string) => freeDiskBytes(directory) }
			: {}),
		findHelperPath: async () =>
			process.platform === "linux"
				? findPipeWireCursorHelperPath()
				: findNativeMacCaptureHelperPath(),
		createHelper: (helperPath, config, onFatalError, onOriginalStarted) => {
			if (config.platform === "linux" && !linuxClipMetadata)
				linuxClipMetadata = new LinuxClipCaptureMetadata(MAX_CURSOR_SAMPLES, Date.now());
			const helperConfig =
				config.platform === "linux"
					? { ...config, portalStatePath: path.join(RECORDINGS_DIR, ".portal-source-grant.json") }
					: config;
			const child =
				(process.platform === "darwin" ? nativeMacStandby.take(helperPath, config) : null) ??
				spawn(helperPath, [JSON.stringify(helperConfig)], {
					cwd: RECORDINGS_DIR,
					stdio: ["pipe", "pipe", "pipe"],
				});
			return new NativeMacHelperClient(child, {
				...(config.platform === "linux" ? { platform: "linux" } : {}),
				onProtocolEvent: (event) => linuxClipMetadata?.observe(event),
				onFatalError,
				onOriginalStarted,
				onEvent: (name) => {
					if (name === "capture-timing") return;
					activeStartTimeline?.mark(`helper:${name}`);
					activeStopTimeline?.mark(`helper:${name}`);
					activeClipBoundaryTimeline?.mark(`helper:${name}`);
				},
				onWarning: (warning) => {
					if (
						warning.code === "source-inactive" ||
						warning.code === "source-active" ||
						warning.code === "microphone-defaulted"
					) {
						notifyNativeMacInterruption(warning.code);
					}
					void appendDiagnosticRow(helperWarningsFile(), {
						recordedAt: new Date().toISOString(),
						...warning,
					}).catch((error) => console.warn("[capture-mac] could not log helper warning:", error));
				},
			});
		},
		resolveCapture: resolveNativeMacCaptureConfig,
		prepareCapturePermissions: (request) =>
			process.platform === "linux"
				? Promise.resolve()
				: prepareNativeMacCapturePermissions(request, {
						getStatus: (mediaType) => systemPreferences.getMediaAccessStatus(mediaType),
						requestScreenAccess: () =>
							desktopCapturer.getSources({
								types: ["screen"],
								thumbnailSize: { width: 1, height: 1 },
							}),
						requestMicrophoneAccess: () => systemPreferences.askForMediaAccess("microphone"),
					}),
		onStartStage: (stage) => activeStartTimeline?.mark(stage),
		onStopStage: (stage) => activeStopTimeline?.mark(stage),
		startCursor: async (startTimeMs) => {
			if (process.platform !== "linux") return startCursorRecording(startTimeMs);
			linuxClipMetadata ??= new LinuxClipCaptureMetadata(MAX_CURSOR_SAMPLES, startTimeMs);
			return true;
		},
		stopCursor: async () => {
			if (process.platform !== "linux") return stopCursorRecording();
			pendingCursorRecordingData = linuxClipMetadata?.cursor.toRecordingData() ?? null;
			linuxClipMetadata = null;
		},
		clearCursor: () => {
			pendingCursorRecordingData = null;
			linuxClipMetadata = null;
		},
		finalizeCursor: async ({ clips, pauseRanges, offsetMs }) => {
			compactPendingCursorTelemetryPauseRanges(pauseRanges);
			shiftPendingCursorTelemetry(offsetMs);
			await writePendingCursorTelemetryForClips(clips);
		},
		registerMediaLinks: async (screenVideoPath, cursorCaptureMode) => {
			await registerRecordingMediaLinks(screenVideoPath, { cursorCaptureMode });
		},
		onSessionStored: (session) => {
			setCurrentRecordingSessionState(session);
			currentProjectPath = null;
			options.onTakeEvent?.({ kind: "stored", session });
		},
		onRecordingStateChange: (recording) => {
			const sourceName =
				process.platform === "linux"
					? linuxSourceLabel(linuxClipMetadata?.sourceKind)
					: (selectedSource?.name ?? "Screen");
			if (!recording) recordingHud.pauseCompleted();
			notifyRecordingStateChange(recording, sourceName);
		},
		onFatalError: (failure) => {
			activeCaptureFailure =
				failure.code === "writer-failed-during-capture"
					? "writer-failed"
					: "capture-runtime-failed";
			const hudWindow = getMainWindow();
			if (hudWindow && !hudWindow.isDestroyed()) {
				hudWindow.webContents.send("native-mac-recording-error", failure);
			}
		},
		onStorageLow: (status) => {
			const hudWindow = getMainWindow();
			if (hudWindow && !hudWindow.isDestroyed()) {
				hudWindow.webContents.send("native-mac-recording-storage-low", status);
			}
		},
		onStorageCritical: () => notifyNativeMacInterruption("disk-low"),
		onAppStopped: (recordingId, signal) => rendererRecordingStop.wait(recordingId, signal),
		pendingRendererRecordingId: () => rendererRecordingStop.pendingRecordingId(),
	});

	const getNativeMacRecordingService = () => {
		if (!nativeMacRecordingService) {
			throw new Error("Native recording service is not initialized.");
		}
		return nativeMacRecordingService;
	};

	const invokeNativeMac = async <T>(operation: () => Promise<T>) => {
		if (process.platform !== "darwin" && process.platform !== "linux") {
			return { success: false, error: "Native clip capture is unsupported on this platform." };
		}
		try {
			return await operation();
		} catch (error) {
			return { success: false, error: error instanceof Error ? error.message : String(error) };
		}
	};
	ipcMain.handle("register-native-recording-webcam", (event, payload: unknown) =>
		invokeNativeMac(async () => {
			const registration = parseNativeRecordingWebcamRegistration(payload);
			if (
				!registration ||
				!rendererRecordingStop.owns(event.sender, registration.recordingId, registration.token)
			)
				return { success: false, error: "The recording HUD no longer owns this camera source." };
			const registered = await getNativeMacRecordingService().registerRendererWebcam(
				registration.recordingId,
				{
					clipIndex: registration.clipIndex,
					key: "webcamVideoPath",
					path: resolveRecordingOutputPath(
						nativeMacWebcamFileName(
							registration.recordingId,
							registration.clipIndex,
							registration.container,
						),
					),
					offsetMs: registration.offsetMs,
				},
			);
			return { success: true, registered };
		}),
	);

	ipcMain.handle(
		"start-native-mac-recording",
		async (event, request: NativeMacRecordingRequest) => {
			const timeline = new RecordStartTimeline(Date.now, request?.startTiming);
			timeline.mark("ipc-received");
			activeStartTimeline = timeline;
			const rejection = await rejectWithoutEntitlement("record");
			if (rejection) return rejection;
			timeline.mark("entitled");
			await startupRecordingRecovery;
			await beforeNativeCapture();
			let result = await invokeNativeMac(() =>
				recordingHud.capture(() => getNativeMacRecordingService().start(request)),
			);
			if (result.success && "recordingId" in result && typeof result.recordingId === "number")
				result = {
					...result,
					rendererStop: rendererRecordingStop.bind(event.sender, result.recordingId),
				};
			timeline.mark("start-returned");
			if (activeStartTimeline === timeline) activeStartTimeline = null;
			void appendRecordStartTiming(recordStartTimingFile(), {
				recordedAt: new Date().toISOString(),
				success: "success" in result && result.success === true,
				steps: timeline.steps(),
				...("error" in result && typeof result.error === "string" ? { error: result.error } : {}),
			}).catch((error) => console.warn("[capture-mac] could not log start timing:", error));
			if ("success" in result && result.success && activeCaptureWorkloadId) {
				workloadTelemetry.configure(activeCaptureWorkloadId, {
					requestedVideoFps: request.video.fps,
					requestedCameraFps: request.webcam.enabled ? request.webcam.fps : undefined,
				});
				workloadTelemetry.observe(
					activeCaptureWorkloadId,
					"capture.requested_fps",
					request.video.fps,
				);
				if (request.webcam.enabled) {
					workloadTelemetry.recordResourceSnapshot(activeCaptureWorkloadId, {
						cameraPressure: "unknown",
					});
					workloadTelemetry.observe(
						activeCaptureWorkloadId,
						"camera.requested_fps",
						request.webcam.fps,
					);
				}
			}
			return result;
		},
	);
	ipcMain.handle("pause-native-mac-recording", async () => {
		const workloadId = activeCaptureWorkloadId;
		if (workloadId) workloadTelemetry.startPhase(workloadId, "clip-finalization");
		const startedAt = Date.now();
		const result = await timeClipBoundary("pause", () =>
			invokeNativeMac(() => getNativeMacRecordingService().pause()),
		);
		if (workloadId) {
			workloadTelemetry.endPhase(workloadId, "clip-finalization");
			workloadTelemetry.observe(workloadId, "writer.fragment_finalize_ms", Date.now() - startedAt);
			if ("success" in result && result.success) {
				workloadTelemetry.event(workloadId, "capture-paused");
				workloadTelemetry.event(workloadId, "clip-finalized");
			} else {
				activeCaptureFailure = "writer-failed";
			}
		}
		linuxRecordingHud?.pauseCompleted();
		if ("success" in result && result.success) options.onTakeEvent?.({ kind: "paused" });
		return result;
	});

	ipcMain.handle(
		"select-native-linux-source",
		async (event, owner: unknown, cursorMode: unknown) => {
			if (process.platform !== "linux")
				return { success: false, error: "Source selection requires Linux." };
			if (
				!owner ||
				typeof owner !== "object" ||
				!("recordingId" in owner && "token" in owner) ||
				typeof owner.recordingId !== "number" ||
				typeof owner.token !== "string" ||
				!rendererRecordingStop.owns(event.sender, owner.recordingId, owner.token)
			)
				return { success: false, error: "The recording HUD no longer owns this source selection." };
			const mode = normalizeCursorCaptureMode(cursorMode);
			if (cursorMode !== undefined && !mode)
				return { success: false, error: "Invalid cursor mode." };
			return withHiddenPortalHud(
				getMainWindow,
				() => invokeNativeMac(() => getNativeMacRecordingService().selectSource(mode)),
				() => rememberNiriHudPlacement(process.pid),
			);
		},
	);

	ipcMain.handle("resume-native-mac-recording", async (_, request?: NativeMacRecordingRequest) => {
		options.onTakeEvent?.({ kind: "resuming" });
		await beforeNativeCapture();
		const result = await timeClipBoundary("continue", () =>
			invokeNativeMac(() =>
				recordingHud.capture(() => getNativeMacRecordingService().resume(request)),
			),
		);
		options.onTakeEvent?.({ kind: "changed" });
		if (activeCaptureWorkloadId && "success" in result && result.success) {
			if (request) {
				workloadTelemetry.configure(activeCaptureWorkloadId, {
					requestedVideoFps: request.video.fps,
					requestedCameraFps: request.webcam.enabled ? request.webcam.fps : undefined,
				});
				workloadTelemetry.observe(
					activeCaptureWorkloadId,
					"capture.requested_fps",
					request.video.fps,
				);
				if (request.webcam.enabled) {
					workloadTelemetry.recordResourceSnapshot(activeCaptureWorkloadId, {
						cameraPressure: "unknown",
					});
					workloadTelemetry.observe(
						activeCaptureWorkloadId,
						"camera.requested_fps",
						request.webcam.fps,
					);
				}
			}
			workloadTelemetry.event(activeCaptureWorkloadId, "capture-resumed");
		}
		return result;
	});
	ipcMain.handle("prepare-native-mac-continue", (_, request: NativeMacRecordingRequest) =>
		timeClipBoundary("prepare", () =>
			invokeNativeMac(() => getNativeMacRecordingService().prepareResume(request)),
		),
	);
	ipcMain.handle("remove-previous-native-mac-clip", async () => {
		const result = await invokeNativeMac(() => getNativeMacRecordingService().removePreviousClip());
		options.onTakeEvent?.({ kind: "changed" });
		return result;
	});
	ipcMain.handle("restore-removed-native-mac-clip", async (_, clipIndex: number) => {
		const result = await invokeNativeMac(() =>
			getNativeMacRecordingService().restoreRemovedClip(clipIndex),
		);
		options.onTakeEvent?.({ kind: "changed" });
		return result;
	});

	ipcMain.handle("pause-native-windows-recording", async () => {
		const proc = nativeWindowsCaptureProcess;
		if (!proc) {
			return { success: false, error: "Native Windows capture is not running." };
		}
		if (nativeWindowsIsPaused) {
			return { success: true };
		}
		if (!proc.stdin.writable) {
			return { success: false, error: "Native Windows capture command channel is closed." };
		}

		try {
			proc.stdin.write("pause\n");
			nativeWindowsIsPaused = true;
			nativeWindowsPauseStartedAtMs = Date.now();
			return { success: true };
		} catch (error) {
			return { success: false, error: error instanceof Error ? error.message : String(error) };
		}
	});

	ipcMain.handle("resume-native-windows-recording", async () => {
		const proc = nativeWindowsCaptureProcess;
		if (!proc) {
			return { success: false, error: "Native Windows capture is not running." };
		}
		if (!nativeWindowsIsPaused) {
			return { success: true };
		}
		if (!proc.stdin.writable) {
			return { success: false, error: "Native Windows capture command channel is closed." };
		}

		try {
			proc.stdin.write("resume\n");
			completeNativeWindowsCursorPauseRange();
			nativeWindowsIsPaused = false;
			return { success: true };
		} catch (error) {
			return { success: false, error: error instanceof Error ? error.message : String(error) };
		}
	});

	ipcMain.handle("stop-native-windows-recording", async (_, discard?: boolean) => {
		const proc = nativeWindowsCaptureProcess;
		const preferredPath = nativeWindowsCaptureTargetPath;
		const preferredWebcamPath = nativeWindowsCaptureWebcamTargetPath;
		const recordingId = nativeWindowsCaptureRecordingId ?? Date.now();
		const cursorCaptureMode = nativeWindowsCursorCaptureMode;

		if (!proc) {
			return { success: false, error: "Native Windows capture is not running." };
		}

		// Discarding does not need a finalized file, so it must not wait for one.
		// Cancel and Restart both route here, and making them sit through the
		// full stop handshake meant a wedged helper could not be escaped from at
		// all -- the user waited out the timeout only to be told the recording
		// failed, then waited it out again to cancel. Linux has always done this;
		// Windows never did.
		if (discard) {
			try {
				completeNativeWindowsCursorPauseRange();
				await stopCursorRecording();
				pendingCursorRecordingData = null;
				const exited = await terminateNativeWindowsCapture(proc);
				if (!exited) {
					detachNativeWindowsCaptureOutputDrain();
				}
				await removeNativeWindowsCaptureOutputs(preferredPath, preferredWebcamPath);
				finishCaptureWorkload("discarded");
				return { success: true, discarded: true };
			} finally {
				// Unconditional. Killing a wedged helper can itself throw, and
				// leaving the handle set would make every later recording fail
				// with "already running" against a process nobody can stop.
				resetNativeWindowsCaptureState();
				notifyRecordingStateChange(false, (selectedSource || { name: "Screen" }).name);
			}
		}

		// Set when the helper failed its stop handshake but left a playable
		// fragmented file. Reported so a bug report can tell a clean stop from a
		// recovered one; the user-facing path is deliberately identical.
		let recovered = false;

		try {
			completeNativeWindowsCursorPauseRange();
			if (activeCaptureWorkloadId) {
				workloadTelemetry.startPhase(activeCaptureWorkloadId, "capture-stop");
			}
			const stopPromise = waitForNativeWindowsCaptureStop({
				proc,
				targetPath: preferredPath,
				readOutput: () => nativeWindowsCaptureOutput,
			});
			if (!sendNativeWindowsStopCommand(proc)) {
				console.warn("[native-wgc] stop command channel was already closed");
			}
			const stopResult = await stopPromise;
			recordNativeWindowsCaptureTelemetry();
			if (activeCaptureWorkloadId) {
				workloadTelemetry.endPhase(activeCaptureWorkloadId, "capture-stop");
			}
			if (!stopResult.ok) {
				console.error("[native-wgc] stop failed", {
					reason: stopResult.reason,
					exited: stopResult.exited,
					pid: proc.pid,
					output: stopResult.message,
				});
				if (!stopResult.exited) {
					detachNativeWindowsCaptureOutputDrain();
				}

				// A failed stop stopped meaning a lost recording when the helper started
				// writing fragmented MP4. The file on disk is already playable, so
				// the only thing standing between the user and their recording is
				// this function deciding to throw it away and say so. Fall through
				// into the normal save path instead: same manifest, same media
				// links, same editor. From the user's side it simply worked, minus
				// at most the last incomplete fragment.
				//
				// Only once the helper is actually dead. `exited: false` means it
				// survived even the forced kill -- stuck somewhere `TerminateProcess`
				// could not reach -- and on Windows such a process still holds the
				// MP4 open and may still be appending to it. Handing that file to
				// the editor trades an honest failure for a sharing violation on a
				// file that is still moving, so a wedged helper keeps the old answer.
				if (stopResult.exited && (await salvageNativeWindowsFragmentedCapture(preferredPath))) {
					console.warn("[native-wgc] stop failed but the fragmented output is playable", {
						reason: stopResult.reason,
						path: preferredPath,
					});
					recovered = true;
				} else {
					await stopCursorRecording();
					// Same as the discard path. `startCursorRecording` clears this on
					// the next recording anyway, so this is not what keeps the samples
					// from being written next to someone else's video -- it just stops
					// a lost recording's telemetry from sitting in memory until then.
					pendingCursorRecordingData = null;
					// Reaching here means the container was the plain one, whose only
					// index is written by the `Finalize()` this stop never reached, so
					// what is on disk really is an unindexed stub and leaving those
					// behind just accumulates unplayable recordings the user cannot
					// explain. Size-gate it anyway: throwing away a recording to tidy
					// up after a failed stop is the worse mistake of the two, and the
					// gate is the same one the salvage check above uses.
					await removeNativeWindowsCaptureOutputs(preferredPath, preferredWebcamPath, {
						onlyIfUnusable: true,
					});
					finishCaptureWorkload("failed", "capture-stop-failed");
					// The helper log goes to console/diagnostics above, not into this
					// string: it ends up in a toast, and pasting an entire capture log
					// into the HUD tells the user nothing they can act on.
					return {
						success: false,
						reason: stopResult.reason,
						error:
							stopResult.reason === "stop-timeout"
								? "Timed out waiting for native Windows capture to stop. The recording could not be saved."
								: stopResult.message.split(/\r?\n/).filter(Boolean).at(-1) ||
									"Native Windows capture failed.",
					};
				}
			}

			// Only a successful stop names the file; the salvage path above falls
			// through with `ok: false` and nothing but the path we asked for.
			const screenVideoPath = (stopResult.ok ? stopResult.screenVideoPath : null) || preferredPath;
			if (!screenVideoPath) {
				throw new Error("Native Windows capture did not return an output path.");
			}

			if (cursorCaptureMode === "editable-overlay") {
				await stopCursorRecording();
			} else {
				pendingCursorRecordingData = null;
			}

			if (cursorCaptureMode === "editable-overlay") {
				compactPendingCursorTelemetryPauseRanges(nativeWindowsPauseRanges);
				shiftPendingCursorTelemetry(nativeWindowsCursorOffsetMs);
				await writePendingCursorTelemetry(screenVideoPath);
			}
			let webcamVideoPath: string | undefined;
			if (preferredWebcamPath) {
				try {
					await fs.access(preferredWebcamPath, fsConstants.R_OK);
					webcamVideoPath = preferredWebcamPath;
				} catch {
					webcamVideoPath = undefined;
				}
			}
			const session: RecordingSession = webcamVideoPath
				? { screenVideoPath, webcamVideoPath, createdAt: recordingId, cursorCaptureMode }
				: { screenVideoPath, createdAt: recordingId, cursorCaptureMode };
			setCurrentRecordingSessionState(session);
			currentProjectPath = null;

			const sessionManifestPath = path.join(
				RECORDINGS_DIR,
				`${path.parse(screenVideoPath).name}${RECORDING_SESSION_SUFFIX}`,
			);
			await fs.writeFile(sessionManifestPath, JSON.stringify(session, null, 2), "utf-8");
			await registerRecordingMediaLinks(screenVideoPath, { webcamVideoPath, cursorCaptureMode });
			if (recovered && activeCaptureWorkloadId) {
				workloadTelemetry.addFallback(
					activeCaptureWorkloadId,
					"capture-recovered-fragmented-output",
				);
			}
			finishCaptureWorkload(recovered ? "recovered" : "succeeded");
			markSuccessfulRecording();

			return {
				success: true,
				path: screenVideoPath,
				session,
				recovered,
				message: recovered
					? "Native Windows recording recovered from a failed stop"
					: "Native Windows recording session stored successfully",
			};
		} catch (error) {
			console.error("Failed to stop native Windows recording:", error);
			await stopCursorRecording();
			finishCaptureWorkload("failed", "capture-stop-failed");
			return { success: false, error: String(error) };
		} finally {
			resetNativeWindowsCaptureState();
			const source = selectedSource || { name: "Screen" };
			notifyRecordingStateChange(false, source.name);
		}
	});

	ipcMain.on("mark-stop-stage", (_, stage: unknown) => {
		if (typeof stage !== "string") return;
		activeStopTimeline?.mark(stage.slice(0, 64));
		if (stage === "review-first-frame") finishStopTimeline(true);
	});

	ipcMain.handle(
		"stop-native-mac-recording",
		async (_, discard?: boolean, clickedAtMs?: unknown) => {
			recordingHud.cancelPending();
			finishStopTimeline(false);
			const timeline = new RecordStartTimeline(
				Date.now,
				typeof clickedAtMs === "number" ? [{ stage: "click", atMs: clickedAtMs }] : [],
			);
			timeline.mark("ipc-received");
			activeStopTimeline = timeline;
			activeStopTimelineTimer = setTimeout(() => finishStopTimeline(false), 15_000);
			const result = await invokeNativeMac(() => getNativeMacRecordingService().stop(discard));
			timeline.mark("stop-returned");
			if (discard || !("success" in result && result.success)) finishStopTimeline(false);
			if ("telemetry" in result && result.telemetry) {
				recordNativeMacCaptureTelemetry(result.telemetry);
			}
			if ("success" in result && result.success) {
				finishCaptureWorkload(discard ? "discarded" : "succeeded");
				if (!discard) markSuccessfulRecording();
			} else {
				finishCaptureWorkload("failed", activeCaptureFailure ?? "capture-stop-failed");
			}
			return result;
		},
	);

	// On-disk write streams for in-progress recordings, keyed by output file name.
	// Chunks append as they arrive so the renderer never buffers the full video (#616).
	// Declared here because both the webcam attach below and store-recorded-session
	// finalize through the same registry.
	const recordingStreams = new RecordingStreamRegistry();
	registerRecordingStreamHandlers(ipcMain, recordingStreams, resolveRecordingOutputPath, {
		onAppendLatencyMs: (latencyMs) => {
			if (activeCaptureWorkloadId) {
				workloadTelemetry.observe(activeCaptureWorkloadId, "disk.write_latency_ms", latencyMs);
			}
		},
		onWriteError: (error) => {
			if (!activeCaptureWorkloadId) return;
			if ((error as NodeJS.ErrnoException)?.code === "ENOSPC") {
				activeCaptureFailure = "disk-full";
				workloadTelemetry.event(activeCaptureWorkloadId, "disk-full");
			}
		},
	});

	/**
	 * Writes a browser-recorded webcam clip next to a natively-recorded screen
	 * video and rewrites the session manifest to include both.
	 *
	 * Shared by macOS and Linux, whose native helpers both leave the camera to
	 * the renderer's `MediaRecorder`: opening the device a second time from the
	 * helper would fight the preview for an exclusive claim, and buys nothing
	 * that the screen capture needs. (Windows is the exception — its helper takes
	 * the webcam through DirectShow so both streams share one start clock.)
	 *
	 * Nothing in here is platform-specific; the two `ipcMain.handle` calls below
	 * differ only in which platform they accept.
	 */
	const attachNativeWebcamRecording = async (
		platformLabel: string,
		payload: AttachNativeMacWebcamRecordingInput,
	) => {
		try {
			{
				const screenVideoPath = normalizeVideoSourcePath(payload.screenVideoPath);
				if (!screenVideoPath || !isPathWithinDir(screenVideoPath, RECORDINGS_DIR)) {
					return {
						success: false,
						error: `Native ${platformLabel} webcam attachment requires a recording output path.`,
					};
				}

				await fs.access(screenVideoPath, fsConstants.R_OK);

				if (!payload.webcam?.fileName) {
					return {
						success: false,
						error: `Native ${platformLabel} webcam attachment is missing video data.`,
					};
				}

				const webcamVideoPath = resolveRecordingOutputPath(payload.webcam.fileName);
				// A streamed webcam arrives with an empty buffer: its bytes are already on
				// disk, so close the stream and keep the file rather than writing it here.
				// Nothing multi-gigabyte crosses IPC or gets flattened into one Buffer (#253).
				const webcamStreamed = await finalizeRecordingFile(
					recordingStreams,
					payload.webcam.fileName,
					webcamVideoPath,
					payload.webcam.videoData,
				);
				// Mirrors finalizeRecordingFile's own condition, so this fires exactly when
				// it wrote nothing and the session would point at a file that isn't there.
				if (
					!webcamStreamed &&
					!(payload.webcam.videoData && payload.webcam.videoData.byteLength > 0)
				) {
					return {
						success: false,
						error: `Native ${platformLabel} webcam attachment is missing video data.`,
					};
				}
				// Streamed files lack the WebM Duration header, which the editor needs to
				// scale its timeline. Best-effort: a failed repair leaves the clip intact.
				if (webcamStreamed && isValidDurationMs(payload.durationMs)) {
					await repairRecordingContainer(webcamVideoPath, payload.durationMs);
				}

				const createdAt =
					typeof payload.recordingId === "number" && Number.isFinite(payload.recordingId)
						? payload.recordingId
						: Date.now();
				const cursorCaptureMode = normalizeCursorCaptureMode(payload.cursorCaptureMode);
				const webcamOffsetMs = Number.isFinite(payload.webcamOffsetMs)
					? payload.webcamOffsetMs
					: undefined;
				const clips = payload.clips
					?.map((clip) => parseNativeMacRecordingClip(clip))
					.filter((clip): clip is RecordingSessionClip => clip !== null)
					.sort((a, b) => a.index - b.index);
				const session: RecordingSession = {
					screenVideoPath,
					webcamVideoPath,
					createdAt,
					...(clips ? { schemaVersion: 2 as const, clips } : {}),
					...(webcamOffsetMs !== undefined ? { webcamOffsetMs } : {}),
					...(cursorCaptureMode ? { cursorCaptureMode } : {}),
				};
				setCurrentRecordingSessionState(session);
				currentProjectPath = null;

				const sessionManifestPath = clips
					? getNativeMacSessionManifestPath(createdAt)
					: path.join(
							RECORDINGS_DIR,
							`${path.parse(screenVideoPath).name}${RECORDING_SESSION_SUFFIX}`,
						);
				await fs.writeFile(sessionManifestPath, JSON.stringify(session, null, 2), "utf-8");
				if (clips) {
					let cameraStartMs = 0;
					for (const clip of clips) {
						if (!clip.removed) {
							await registerRecordingMediaLinks(clip.screenVideoPath, {
								webcamVideoPath,
								webcamOffsetMs:
									webcamOffsetMs === undefined ? -cameraStartMs : webcamOffsetMs - cameraStartMs,
								cursorCaptureMode,
							});
						}
						cameraStartMs += clip.durationMs;
					}
				} else {
					await registerRecordingMediaLinks(screenVideoPath, {
						webcamVideoPath,
						webcamOffsetMs,
						cursorCaptureMode,
					});
				}

				return {
					success: true,
					path: screenVideoPath,
					session,
					message: `Native ${platformLabel} webcam recording attached successfully`,
				};
			}
		} catch (error) {
			console.error(`Failed to attach native ${platformLabel} webcam recording:`, error);
			return {
				success: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	};

	ipcMain.handle(
		"attach-native-mac-webcam-recording",
		async (_, payload: AttachNativeMacWebcamRecordingInput) => {
			if (process.platform !== "darwin" && process.platform !== "linux") {
				return {
					success: false,
					error: "Native clip webcam attachment is unsupported on this platform.",
				};
			}
			return attachNativeWebcamRecording(process.platform === "linux" ? "Linux" : "macOS", payload);
		},
	);

	ipcMain.handle(
		"attach-native-mac-clip-webcams",
		async (_, payload: AttachNativeMacClipWebcamsInput) => {
			if (process.platform !== "darwin" && process.platform !== "linux") {
				return {
					success: false,
					error: "Native clip webcam attachment is unsupported on this platform.",
				};
			}
			try {
				const screenVideoPath = normalizeVideoSourcePath(payload.screenVideoPath);
				if (!screenVideoPath || !isPathWithinDir(screenVideoPath, RECORDINGS_DIR)) {
					return { success: false, error: "Clip webcam attachment requires a recording path." };
				}
				await fs.access(screenVideoPath, fsConstants.R_OK);
				const recordingId =
					typeof payload.recordingId === "number" && Number.isFinite(payload.recordingId)
						? payload.recordingId
						: Date.now();
				const manifestPath = getNativeMacSessionManifestPath(recordingId);
				const session = normalizeRecordingSession(
					JSON.parse(await fs.readFile(manifestPath, "utf-8")),
				);
				if (!session?.clips) {
					return { success: false, error: "The saved recording session is missing." };
				}
				const canonicalPaths = new Set([
					normalizeVideoSourcePath(session.screenVideoPath),
					...session.clips.map((clip) => normalizeVideoSourcePath(clip.screenVideoPath)),
				]);
				if (!canonicalPaths.has(screenVideoPath)) {
					return { success: false, error: "The screen clip does not match the saved session." };
				}
				const clips = session.clips;
				if (clips.length === 0) {
					return { success: false, error: "Clip webcam attachment requires saved clips." };
				}
				const keptByIndex = new Map(
					clips.filter((clip) => !clip.removed).map((clip) => [clip.index, clip]),
				);
				const cameraIndexes = new Set<number>();
				const finalizedCameras: Array<{
					clip: RecordingSessionClip;
					webcamVideoPath: string;
					webcamOffsetMs: number;
				}> = [];

				for (const camera of payload.webcams ?? []) {
					const clip = keptByIndex.get(camera.clipIndex);
					if (!clip || !camera.webcam?.fileName) {
						throw new Error(
							`Camera clip ${camera.clipIndex + 1} does not match a saved screen clip.`,
						);
					}
					if (cameraIndexes.has(camera.clipIndex)) {
						throw new Error(`Camera clip ${camera.clipIndex + 1} was attached more than once.`);
					}
					cameraIndexes.add(camera.clipIndex);
					const webcamVideoPath = resolveRecordingOutputPath(camera.webcam.fileName);
					const webcamStreamed = await finalizeRecordingFile(
						recordingStreams,
						camera.webcam.fileName,
						webcamVideoPath,
						camera.webcam.videoData,
					);
					if (
						!webcamStreamed &&
						!(camera.webcam.videoData && camera.webcam.videoData.byteLength > 0)
					) {
						throw new Error(`Camera clip ${camera.clipIndex + 1} produced no video data.`);
					}
					if (webcamStreamed && isValidDurationMs(camera.durationMs)) {
						await repairRecordingContainer(webcamVideoPath, camera.durationMs);
					}
					finalizedCameras.push({
						clip,
						webcamVideoPath,
						webcamOffsetMs: Number.isFinite(camera.webcamOffsetMs) ? camera.webcamOffsetMs : 0,
					});
				}

				await Promise.all(
					finalizedCameras.map((camera) =>
						registerRecordingMediaLinks(camera.clip.screenVideoPath, {
							webcamVideoPath: camera.webcamVideoPath,
							webcamOffsetMs: camera.webcamOffsetMs,
							cursorCaptureMode: camera.clip.cursorCaptureMode,
						}),
					),
				);
				const camerasByIndex = new Map(
					finalizedCameras.map((camera) => [camera.clip.index, camera]),
				);
				const updatedSession: RecordingSession = {
					...session,
					clips: clips.map((clip) => {
						const camera = camerasByIndex.get(clip.index);
						return camera
							? {
									...clip,
									webcamVideoPath: camera.webcamVideoPath,
									webcamOffsetMs: camera.webcamOffsetMs,
								}
							: clip;
					}),
				};
				await writeJsonDurably(manifestPath, updatedSession);
				await updateNativeMacRecoveryJournalIfPresent(RECORDINGS_DIR, updatedSession);
				setCurrentRecordingSessionState(updatedSession);
				currentProjectPath = null;
				return {
					success: true,
					path: screenVideoPath,
					session: updatedSession,
					message: "Native clip cameras attached successfully",
				};
			} catch (error) {
				console.error("Failed to attach native clip cameras:", error);
				return { success: false, error: error instanceof Error ? error.message : String(error) };
			}
		},
	);

	ipcMain.handle(
		"attach-native-linux-webcam-recording",
		async (_, payload: AttachNativeMacWebcamRecordingInput) => {
			if (process.platform !== "linux") {
				return { success: false, error: "Native Linux webcam attachment requires Linux." };
			}
			return attachNativeWebcamRecording("Linux", payload);
		},
	);

	ipcMain.handle("store-recorded-session", async (_, payload: StoreRecordedSessionInput) => {
		try {
			const result = await storeRecordedSessionFiles(payload);
			if (result.success) {
				finishCaptureWorkload("succeeded");
			} else {
				finishCaptureWorkload("failed", "capture-stop-failed");
			}
			return result;
		} catch (error) {
			console.error("Failed to store recording session:", error);
			finishCaptureWorkload("failed", "capture-stop-failed");
			return {
				success: false,
				message: "Failed to store recording session",
				error: String(error),
			};
		}
	});

	async function storeRecordedSessionFiles(payload: StoreRecordedSessionInput) {
		const createdAt =
			typeof payload.createdAt === "number" && Number.isFinite(payload.createdAt)
				? payload.createdAt
				: Date.now();
		const cursorCaptureMode = normalizeCursorCaptureMode(payload.cursorCaptureMode);
		const screenVideoPath = resolveRecordingOutputPath(payload.screen.fileName);
		const screenStreamed = await finalizeRecordingFile(
			recordingStreams,
			payload.screen.fileName,
			screenVideoPath,
			payload.screen.videoData,
		);

		let webcamVideoPath: string | undefined;
		let webcamStreamed = false;
		if (payload.webcam) {
			webcamVideoPath = resolveRecordingOutputPath(payload.webcam.fileName);
			webcamStreamed = await finalizeRecordingFile(
				recordingStreams,
				payload.webcam.fileName,
				webcamVideoPath,
				payload.webcam.videoData,
			);
		}

		// MediaRecorder occasionally produces a 0-byte file on Windows
		// when the display stream is captured but no frames are produced (the
		// streaming WriteStream was opened but never received any chunks). Detect
		// the bad file here so the recording fails loudly instead of opening the
		// editor on a file the <video> element can't decode. The WebM EBML header
		// alone is ~33 bytes; 1KB rules out a header-only file with no frames.
		const MIN_VALID_BYTES = 1024;
		try {
			const screenStat = await fs.stat(screenVideoPath);
			if (screenStat.size < MIN_VALID_BYTES) {
				await fs.unlink(screenVideoPath).catch(() => undefined);
				if (webcamVideoPath) {
					await fs.unlink(webcamVideoPath).catch(() => undefined);
				}
				return {
					success: false,
					message: `Screen recording is empty (${screenStat.size} bytes). The screen capture did not produce any frames — this can happen on Windows when the display source changes during recording. Try recording again.`,
				};
			}
		} catch (statError) {
			// file missing is fatal; any other stat error is non-fatal, the
			// editor will surface the load error on its own.
			if ((statError as NodeJS.ErrnoException).code === "ENOENT") {
				return {
					success: false,
					message: "Screen recording file is missing on disk.",
				};
			}
		}

		// Streamed files lack the WebM Duration header (renderer no longer holds the
		// blob), so repair the container on disk for the editor's seek bar and timeline.
		// Best-effort, independent per file, so they run together.
		if (isValidDurationMs(payload.durationMs)) {
			const patches: Promise<unknown>[] = [];
			if (screenStreamed) {
				patches.push(repairRecordingContainer(screenVideoPath, payload.durationMs));
			}
			if (webcamStreamed && webcamVideoPath) {
				patches.push(repairRecordingContainer(webcamVideoPath, payload.durationMs));
			}
			await Promise.all(patches);
		}

		const webcamOffsetMs =
			webcamVideoPath && Number.isFinite(payload.webcamOffsetMs)
				? payload.webcamOffsetMs
				: undefined;
		const session: RecordingSession = webcamVideoPath
			? {
					screenVideoPath,
					webcamVideoPath,
					createdAt,
					...(webcamOffsetMs !== undefined ? { webcamOffsetMs } : {}),
					...(cursorCaptureMode ? { cursorCaptureMode } : {}),
				}
			: { screenVideoPath, createdAt, ...(cursorCaptureMode ? { cursorCaptureMode } : {}) };
		setCurrentRecordingSessionState(session);
		currentProjectPath = null;

		await writePendingCursorTelemetry(screenVideoPath);

		const sessionManifestPath = path.join(
			RECORDINGS_DIR,
			`${path.parse(payload.screen.fileName).name}${RECORDING_SESSION_SUFFIX}`,
		);
		await fs.writeFile(sessionManifestPath, JSON.stringify(session, null, 2), "utf-8");
		await registerRecordingMediaLinks(screenVideoPath, {
			webcamVideoPath,
			webcamOffsetMs,
			cursorCaptureMode,
		});
		markSuccessfulRecording();

		return {
			success: true,
			path: screenVideoPath,
			session,
			message: "Recording session stored successfully",
		};
	}

	ipcMain.handle("store-recorded-video", async (_, videoData: ArrayBuffer, fileName: string) => {
		try {
			const result = await storeRecordedSessionFiles({
				screen: { videoData, fileName },
				createdAt: Date.now(),
			});
			if (result.success) {
				finishCaptureWorkload("succeeded");
			} else {
				finishCaptureWorkload("failed", "capture-stop-failed");
			}
			return result;
		} catch (error) {
			console.error("Failed to store recorded video:", error);
			finishCaptureWorkload("failed", "capture-stop-failed");
			return {
				success: false,
				message: "Failed to store recorded video",
				error: String(error),
			};
		}
	});

	ipcMain.handle("get-recorded-video-path", async () => {
		try {
			if (currentRecordingSession?.screenVideoPath) {
				return { success: true, path: currentRecordingSession.screenVideoPath };
			}

			const files = await fs.readdir(RECORDINGS_DIR);
			const videoFiles = files.filter(
				(file) => file.endsWith(".webm") && !file.endsWith("-webcam.webm"),
			);

			if (videoFiles.length === 0) {
				return { success: false, message: "No recorded video found" };
			}

			const latestVideo = videoFiles.sort().reverse()[0];
			const videoPath = path.join(RECORDINGS_DIR, latestVideo);

			return { success: true, path: videoPath };
		} catch (error) {
			console.error("Failed to get video path:", error);
			return { success: false, message: "Failed to get video path", error: String(error) };
		}
	});

	ipcMain.handle(
		"set-recording-state",
		async (_, recording: boolean, recordingId?: number, cursorCaptureMode?: CursorCaptureMode) => {
			const normalizedCursorCaptureMode =
				normalizeCursorCaptureMode(cursorCaptureMode) ?? "editable-overlay";
			if (recording && normalizedCursorCaptureMode === "editable-overlay") {
				await startCursorRecording(recordingId);
			} else {
				await stopCursorRecording();
			}

			const source = selectedSource || { name: "Screen" };
			notifyRecordingStateChange(recording, source.name);
		},
	);

	ipcMain.handle("get-cursor-telemetry", async (_, videoPath?: string) => {
		const targetVideoPath = resolveApprovedVideoPath(
			videoPath ?? currentRecordingSession?.screenVideoPath,
		);
		if (!targetVideoPath) {
			return { success: true, samples: [] };
		}

		return readCursorTelemetryFile(targetVideoPath);
	});

	// Protocol allowlist. `shell.openExternal` hands the string to the OS handler,
	// so `file:`, `ms-msdt:`, a UNC path, or any registered custom scheme is a
	// launch primitive. The renderer also renders model-generated content, so
	// "the renderer is trusted" is not a strong enough
	// premise to skip this. http/https/mailto is everything the app actually opens.
	const EXTERNAL_URL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

	ipcMain.handle("open-external-url", async (_, url: string) => {
		try {
			const parsed = new URL(url);
			if (!EXTERNAL_URL_PROTOCOLS.has(parsed.protocol)) {
				console.warn(`Refused to open external URL with protocol ${parsed.protocol}`);
				return { success: false, error: `Unsupported URL protocol: ${parsed.protocol}` };
			}
			await shell.openExternal(parsed.toString());
			return { success: true };
		} catch (error) {
			console.error("Failed to open URL:", error);
			return { success: false, error: String(error) };
		}
	});

	// Return the restricted resource root for native-bridge clients that still ask for it.
	ipcMain.handle("get-asset-base-path", () => {
		return resolveAssetBasePath();
	});

	ipcMain.handle("pick-export-save-path", async (_, fileName: string, exportFolder?: string) => {
		const rejection = await rejectWithoutEntitlement("export");
		if (rejection) return rejection;
		try {
			const isGif = fileName.toLowerCase().endsWith(".gif");
			const filters = isGif
				? [{ name: mainT("dialogs", "fileDialogs.gifImage"), extensions: ["gif"] }]
				: [{ name: mainT("dialogs", "fileDialogs.mp4Video"), extensions: ["mp4"] }];

			// Prefer the user's last export folder if it still exists, else ~/Downloads.
			// Validate here because the renderer can't stat the filesystem.
			let defaultDir = app.getPath("downloads");
			if (exportFolder) {
				try {
					const stats = await fs.stat(exportFolder);
					if (stats.isDirectory()) {
						defaultDir = exportFolder;
					}
				} catch (err) {
					console.warn(
						`Could not access remembered export folder "${exportFolder}", falling back to Downloads:`,
						err,
					);
				}
			}
			const dialogOptions = buildDialogOptions(
				{
					title: isGif
						? mainT("dialogs", "fileDialogs.saveGif")
						: mainT("dialogs", "fileDialogs.saveVideo"),
					defaultPath: path.join(defaultDir, fileName),
					filters,
					properties: ["createDirectory", "showOverwriteConfirmation"],
				},
				getMainWindow(),
			);
			const result = await dialog.showSaveDialog(dialogOptions);

			if (result.canceled || !result.filePath) {
				return { success: false, canceled: true, message: "Export canceled" };
			}

			return { success: true, path: path.normalize(result.filePath) };
		} catch (error) {
			console.error("Failed to show save dialog:", error);
			return {
				success: false,
				message: "Failed to show save dialog",
				error: String(error),
			};
		}
	});

	ipcMain.handle("create-temporary-export-path", () =>
		createVoiceoverTempPath(exportTempDirectory),
	);

	ipcMain.handle("remove-temporary-export-path", async (_, filePath: string) => {
		if (!isVoiceoverTempPath(exportTempDirectory, filePath)) {
			return { success: false, message: "Invalid temporary export path" };
		}
		await fs.rm(path.resolve(filePath), { force: true });
		return { success: true };
	});

	ipcMain.handle(
		"write-export-to-path",
		async (
			event,
			videoData: ArrayBuffer,
			filePath: string,
			spec: VideoBufferPublishSpec,
			exportId?: string,
			sourceMetadata?: ExportSourceMetadata,
		) => {
			try {
				// Sanity-check the path: the renderer is trusted (contextIsolation on), but a
				// stale-state bug shouldn't be able to clobber arbitrary files.
				if (typeof filePath !== "string" || !path.isAbsolute(filePath)) {
					return { success: false, message: "Invalid path" };
				}
				const lower = filePath.toLowerCase();
				if (!lower.endsWith(".mp4")) {
					return { success: false, message: "Invalid file type" };
				}
				if (
					!spec ||
					!Number.isFinite(spec.width) ||
					!Number.isFinite(spec.height) ||
					!Number.isFinite(spec.fps) ||
					!Number.isFinite(spec.durationS) ||
					!Number.isFinite(spec.expectedBytes) ||
					!(["h264", "h265"] as string[]).includes(spec.codec)
				) {
					return { success: false, message: "Invalid export verification contract" };
				}
				if (
					!sourceMetadata ||
					!Array.isArray(sourceMetadata.clips) ||
					sourceMetadata.clips.length === 0 ||
					sourceMetadata.clips.some(
						(clip) =>
							!clip ||
							typeof clip.screenPath !== "string" ||
							!path.isAbsolute(clip.screenPath) ||
							(clip.webcamPath !== undefined &&
								(typeof clip.webcamPath !== "string" ||
									(clip.webcamPath.length > 0 && !path.isAbsolute(clip.webcamPath)))) ||
							(clip.cleanMicrophonePath !== undefined &&
								(typeof clip.cleanMicrophonePath !== "string" ||
									(clip.cleanMicrophonePath.length > 0 &&
										!path.isAbsolute(clip.cleanMicrophonePath)))),
					) ||
					(sourceMetadata.sceneJson !== undefined &&
						typeof sourceMetadata.sceneJson !== "string") ||
					(sourceMetadata.additionalSourcePaths !== undefined &&
						(!Array.isArray(sourceMetadata.additionalSourcePaths) ||
							sourceMetadata.additionalSourcePaths.some(
								(source) => typeof source !== "string" || !path.isAbsolute(source),
							)))
				) {
					return { success: false, message: "Invalid export source contract" };
				}

				const normalizedPath = path.normalize(filePath);
				const exportWarning = await exportBufferService.publishVideoBuffer(
					videoData,
					normalizedPath,
					spec,
					{
						exportId,
						sourceMetadata,
						onPhase: (phase) => {
							if (!event.sender.isDestroyed()) event.sender.send("export:native-phase", phase);
						},
					},
				);

				return {
					success: true,
					path: normalizedPath,
					message: "Video exported successfully",
					exportWarning,
				};
			} catch (error) {
				console.error("Failed to write exported video:", error);
				const transactionError = error instanceof ExportTransactionError ? error : undefined;
				return {
					success: false,
					message: "Failed to save exported video",
					error: String(error),
					...(transactionError
						? {
								phase: transactionError.phase,
								code: transactionError.code,
								retryable: transactionError.retryable,
							}
						: {}),
				};
			}
		},
	);

	ipcMain.handle("cancel-write-export", (_event, exportId: string) => ({
		cancelled: typeof exportId === "string" && exportBufferService.cancelExport(exportId),
	}));

	registerLocalFontIpc(ipcMain, () => entitlementService.assertCapability("import"));

	ipcMain.handle("open-video-file-picker", async () => {
		const rejection = await rejectWithoutEntitlement("import");
		if (rejection) return rejection;
		try {
			const dialogOptions = buildDialogOptions(
				{
					title: mainT("dialogs", "fileDialogs.selectVideo"),
					defaultPath: RECORDINGS_DIR,
					filters: [
						{
							name: mainT("dialogs", "fileDialogs.videoFiles"),
							extensions: ["webm", "mp4", "mov", "avi", "mkv", "m4v", "wmv", "flv", "ts"],
						},
						{ name: mainT("dialogs", "fileDialogs.allFiles"), extensions: ["*"] },
					],
					properties: ["openFile"],
				},
				getMainWindow(),
			);
			const result = await dialog.showOpenDialog(dialogOptions);

			if (result.canceled || result.filePaths.length === 0) {
				return { success: false, canceled: true };
			}

			const normalizedPath = await approveUserSelectedVideoPath(result.filePaths[0]);
			if (!normalizedPath) {
				return {
					success: false,
					message: "Selected file is not a supported readable video file",
				};
			}

			currentProjectPath = null;
			return {
				success: true,
				path: normalizedPath,
			};
		} catch (error) {
			console.error("Failed to open file picker:", error);
			return {
				success: false,
				message: "Failed to open file picker",
				error: String(error),
			};
		}
	});

	ipcMain.handle("reveal-in-folder", async (_, filePath: string) => {
		try {
			// showItemInFolder returns nothing, it throws on error
			shell.showItemInFolder(filePath);
			return { success: true };
		} catch (error) {
			console.error(`Error revealing item in folder: ${filePath}`, error);
			// Fall back to opening the directory if revealing fails (file moved/deleted
			// after export, or a path showItemInFolder rejects).
			try {
				const openPathResult = await shell.openPath(path.dirname(filePath));
				if (openPathResult) {
					// openPath returned an error message
					return { success: false, error: openPathResult };
				}
				return { success: true, message: "Could not reveal item, but opened directory." };
			} catch (openError) {
				console.error(`Error opening directory: ${path.dirname(filePath)}`, openError);
				return { success: false, error: String(error) };
			}
		}
	});

	ipcMain.handle("read-binary-file", async (_, filePath: string) => {
		try {
			const normalizedPath = resolveApprovedVideoPath(filePath);
			if (!normalizedPath) {
				return {
					success: false,
					message: "File path is not approved or is not a supported video file",
				};
			}

			const data = await fs.readFile(normalizedPath);
			return {
				success: true,
				data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
				path: normalizedPath,
			};
		} catch (error) {
			console.error("Failed to read binary file:", error);
			return {
				success: false,
				message: "Failed to read binary file",
				error: String(error),
			};
		}
	});

	// Stat an approved video file. Used to decide whether a recording is small
	// enough to slurp via read-binary-file, or large enough that it must be
	// streamed in chunks (Node's fs.readFile caps a single read at 2 GiB, so any
	// recording above that can never be loaded whole — see read-file-chunk).
	ipcMain.handle("get-readable-file-info", async (_, filePath: string) => {
		try {
			const normalizedPath = resolveApprovedVideoPath(filePath);
			if (!normalizedPath) {
				return {
					success: false,
					message: "File path is not approved or is not a supported video file",
				};
			}

			const stat = await fs.stat(normalizedPath);
			return {
				success: true,
				size: stat.size,
				mtimeMs: stat.mtimeMs,
				path: normalizedPath,
			};
		} catch (error) {
			console.error("Failed to stat file:", error);
			return {
				success: false,
				message: "Failed to stat file",
				error: String(error),
			};
		}
	});

	// Cap renderer-requested chunk sizes so a buggy or compromised renderer
	// cannot make the main process allocate an arbitrarily large buffer.
	const MAX_IPC_CHUNK_BYTES = 64 * 1024 * 1024;

	// Read a byte range [offset, offset+length) from an approved video file.
	// Lets the renderer stream a >2 GiB recording into OPFS one chunk at a time
	// instead of materialising the whole file in memory, which fs.readFile cannot
	// do (2 GiB cap) and a 16 GB machine cannot hold for multi-GB recordings.
	ipcMain.handle("read-file-chunk", async (_, filePath: string, offset: number, length: number) => {
		try {
			const normalizedPath = resolveApprovedVideoPath(filePath);
			if (!normalizedPath) {
				return {
					success: false,
					message: "File path is not approved or is not a supported video file",
				};
			}
			if (!Number.isFinite(offset) || offset < 0 || !Number.isFinite(length) || length <= 0) {
				return { success: false, message: "Invalid chunk range" };
			}
			if (length > MAX_IPC_CHUNK_BYTES) {
				return { success: false, message: "Requested chunk size exceeds limit" };
			}

			const handle = await fs.open(normalizedPath, "r");
			try {
				const buffer = Buffer.allocUnsafe(length);
				const { bytesRead } = await handle.read(buffer, 0, length, offset);
				return {
					success: true,
					data: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + bytesRead),
					bytesRead,
				};
			} finally {
				await handle.close();
			}
		} catch (error) {
			console.error("Failed to read file chunk:", error);
			return {
				success: false,
				message: "Failed to read file chunk",
				error: String(error),
			};
		}
	});

	ipcMain.handle("prepare-preview-audio-track", async (_, filePath: string) => {
		try {
			return await prepareSupplementalPreviewAudioTrack(filePath);
		} catch (error) {
			console.error("Failed to prepare preview audio track:", error);
			return {
				success: false,
				message: "Failed to prepare preview audio track",
				error: String(error),
			};
		}
	});

	ipcMain.handle(
		"save-project-file",
		async (_, projectData: unknown, suggestedName?: string, existingProjectPath?: string) => {
			const rejection = await rejectWithoutEntitlement("edit");
			if (rejection) return rejection;
			return saveProjectFile(projectData, suggestedName, existingProjectPath);
		},
	);

	async function saveProjectFile(
		projectData: unknown,
		suggestedName?: string,
		existingProjectPath?: string,
	): Promise<ProjectFileResult> {
		try {
			const trustedExistingProjectPath = isTrustedProjectPath(existingProjectPath)
				? existingProjectPath
				: null;

			if (trustedExistingProjectPath) {
				// Saving a legacy project creates a `.klippt` sibling and keeps the old
				// file untouched as a rollback copy.
				const canonicalPath = withCanonicalProjectExtension(trustedExistingProjectPath);
				await (await import("../filesystem/unmanagedProjectSave")).writeUnmanagedProjectFile(
					canonicalPath,
					projectData,
					path.join(app.getPath("userData"), "projects"),
				);
				currentProjectPath = canonicalPath;
				return {
					success: true,
					path: canonicalPath,
					message: "Project saved successfully",
				};
			}

			const rawName = suggestedName || `project-${Date.now()}`;
			const nameWithoutProjectExtension = isSupportedProjectFile(rawName)
				? rawName.slice(0, rawName.lastIndexOf("."))
				: rawName;
			const safeName = nameWithoutProjectExtension.replace(/[^a-zA-Z0-9-_]/g, "_");
			const defaultName = withCanonicalProjectExtension(safeName);

			const dialogOptions = buildDialogOptions(
				{
					title: mainT("dialogs", "fileDialogs.saveProject"),
					defaultPath: path.join(RECORDINGS_DIR, defaultName),
					filters: [
						{
							name: mainT("dialogs", "fileDialogs.openscreenProject"),
							extensions: [PROJECT_FILE_EXTENSION],
						},
					],
					properties: ["createDirectory", "showOverwriteConfirmation"],
				},
				getMainWindow(),
			);
			const result = await dialog.showSaveDialog(dialogOptions);

			if (result.canceled || !result.filePath) {
				return {
					success: false,
					canceled: true,
					message: "Save project canceled",
				};
			}

			const canonicalPath = withCanonicalProjectExtension(result.filePath);
			await (await import("../filesystem/unmanagedProjectSave")).writeUnmanagedProjectFile(
				canonicalPath,
				projectData,
				path.join(app.getPath("userData"), "projects"),
			);
			currentProjectPath = canonicalPath;

			return {
				success: true,
				path: canonicalPath,
				message: "Project saved successfully",
			};
		} catch (error) {
			console.error("Failed to save project file:", error);
			return {
				success: false,
				message: "Failed to save project file",
				error: String(error),
			};
		}
	}

	ipcMain.handle("load-project-file", async (_, projectFolder?: string) => {
		return loadProjectFile(projectFolder);
	});

	async function loadProjectFile(projectFolder?: string): Promise<ProjectFileResult> {
		try {
			// Default to the projects directory, where the editor actually stores
			// openable project files (one `.klippt` per project). Prefer the user's
			// last opened-project folder if given and still valid; only fall back to
			// RECORDINGS_DIR if the projects dir doesn't exist yet (fresh install).
			// Validate here because the renderer can't stat the filesystem.
			const projectsDir = path.join(app.getPath("userData"), "projects");
			let defaultDir = RECORDINGS_DIR;
			try {
				const stats = await fs.stat(projectsDir);
				if (stats.isDirectory()) defaultDir = projectsDir;
			} catch {
				// projects dir not created yet — keep RECORDINGS_DIR fallback.
			}
			if (projectFolder) {
				try {
					const stats = await fs.stat(projectFolder);
					if (stats.isDirectory()) {
						defaultDir = projectFolder;
					}
				} catch (err) {
					// Stat can fail if the folder was moved/deleted (expected) or on a
					// permission error (worth surfacing). We fall back either way, but log it.
					console.warn(
						`Could not access remembered project folder "${projectFolder}", falling back to default:`,
						err,
					);
				}
			}
			const dialogOptions = buildDialogOptions(
				{
					title: mainT("dialogs", "fileDialogs.openProject"),
					defaultPath: defaultDir,
					filters: [
						{
							name: mainT("dialogs", "fileDialogs.openscreenProject"),
							extensions: [...SUPPORTED_PROJECT_FILE_EXTENSIONS],
						},
						{ name: mainT("dialogs", "fileDialogs.allFiles"), extensions: ["*"] },
					],
					properties: ["openFile"],
				},
				getMainWindow(),
			);
			const result = await dialog.showOpenDialog(dialogOptions);

			if (result.canceled || result.filePaths.length === 0) {
				return { success: false, canceled: true, message: "Open project canceled" };
			}

			const filePath = result.filePaths[0];
			const content = await fs.readFile(filePath, "utf-8");
			const project = await relinkProjectMedia(JSON.parse(content), RECORDINGS_DIR);
			currentProjectPath = filePath;
			let session: RecordingSession | null = null;
			try {
				session = await getApprovedProjectSession(project, filePath);
			} catch (sessionError) {
				console.warn(
					"[loadProjectFile] Could not approve session paths, proceeding without session:",
					sessionError,
				);
			}
			setCurrentRecordingSessionState(session);

			return {
				success: true,
				path: filePath,
				project,
			};
		} catch (error) {
			console.error("Failed to load project file:", error);
			return {
				success: false,
				message: "Failed to load project file",
				error: String(error),
			};
		}
	}

	ipcMain.handle("load-project-file-from-path", async (_event, filePath: string) => {
		return loadProjectFileFromPath(filePath);
	});

	async function loadProjectFileFromPath(filePath: string): Promise<ProjectFileResult> {
		try {
			if (!filePath || typeof filePath !== "string") {
				return { success: false, message: "Invalid file path" };
			}
			// Klippt is canonical; legacy OpenScreen/Axcut projects remain readable.
			if (!isSupportedProjectFile(filePath)) {
				return { success: false, message: "Not a Klippt project file" };
			}
			const stats = await fs.stat(filePath).catch(() => null);
			if (!stats?.isFile()) {
				return { success: false, message: "File not found" };
			}
			const content = await fs.readFile(filePath, "utf-8");
			const project = await relinkProjectMedia(JSON.parse(content), RECORDINGS_DIR);
			currentProjectPath = filePath;

			// Approve session paths but tolerate failures (e.g. video moved outside trusted
			// dirs) so the project still loads and the renderer can show "video not found".
			let session: import("../../src/lib/recordingSession").RecordingSession | null = null;
			try {
				session = await getApprovedProjectSession(project, filePath);
			} catch (sessionError) {
				console.warn(
					"[loadProjectFileFromPath] Could not approve session paths, proceeding without session:",
					sessionError,
				);
			}
			setCurrentRecordingSessionState(session);
			return { success: true, path: filePath, project };
		} catch (error) {
			console.error("Failed to load project file from path:", error);
			return {
				success: false,
				message: "Failed to load project file",
				error: String(error),
			};
		}
	}

	ipcMain.handle("load-current-project-file", async () => {
		return loadCurrentProjectFile();
	});

	async function loadCurrentProjectFile(): Promise<ProjectFileResult> {
		try {
			if (!currentProjectPath) {
				return { success: false, message: "No active project" };
			}

			const content = await fs.readFile(currentProjectPath, "utf-8");
			const project = JSON.parse(content);
			setCurrentRecordingSessionState(await getApprovedProjectSession(project, currentProjectPath));
			return {
				success: true,
				path: currentProjectPath,
				project,
			};
		} catch (error) {
			console.error("Failed to load current project file:", error);
			return {
				success: false,
				message: "Failed to load current project file",
				error: String(error),
			};
		}
	}

	ipcMain.handle("set-current-video-path", async (_, path: string) => {
		return setCurrentVideoPath(path);
	});

	ipcMain.handle("set-current-recording-session", async (_, session: RecordingSession | null) =>
		serializeRecordingSetup(async () => {
			const previousSession = currentRecordingSession;
			const normalizedSession = normalizeRecordingSession(session);
			try {
				if (normalizedSession?.importProjectId && !previousSession?.importProjectId) {
					await saveProjectRecordingSetup(normalizedSession.importProjectId);
				}
				if (!normalizedSession) {
					await consumeCurrentRecordingSession();
				} else if (normalizedSession) {
					await updateNativeMacRecoveryJournalIfPresent(RECORDINGS_DIR, normalizedSession);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				console.warn("[capture-mac] could not update the recovery handoff:", error);
				return { success: false, error: message, session: previousSession };
			}
			if (normalizedSession) {
				setCurrentRecordingSessionState(normalizedSession);
				currentProjectPath = null;
			}
			return { success: true, session: currentRecordingSession };
		}),
	);

	ipcMain.handle("get-current-recording-session", () => {
		return currentRecordingSession
			? { success: true, session: currentRecordingSession }
			: { success: false };
	});

	// returns the webcam path (if any) for a given screen video by
	// reading its sibling session.json — drives the cameraTrack auto-link on
	// `addAsset` in the new editor's project store.
	ipcMain.handle(
		"find-recording-camera",
		async (
			_event,
			videoPath: string,
		): Promise<{
			success: boolean;
			webcamVideoPath?: string;
			offsetMs?: number;
			error?: string;
		}> => {
			try {
				const normalized = normalizeVideoSourcePath(videoPath);
				if (!normalized || !isPathAllowed(normalized)) {
					return { success: false, error: "Video path has not been approved" };
				}
				const resolution = await resolveMediaLinksForVideo(normalized);
				if (!resolution.webcamVideoPath) {
					return { success: false, error: "No camera attached to this recording" };
				}
				return {
					success: true,
					webcamVideoPath: resolution.webcamVideoPath,
					offsetMs: resolution.webcamOffsetMs ?? 0,
				};
			} catch (err) {
				return {
					success: false,
					error: err instanceof Error ? err.message : String(err),
				};
			}
		},
	);

	async function setCurrentVideoPath(path: string): Promise<ProjectPathResult> {
		const normalizedPath = normalizeVideoSourcePath(path);
		if (!normalizedPath || !isPathAllowed(normalizedPath)) {
			return {
				success: false,
				message: "Video path has not been approved",
			};
		}

		const restoredSession = await loadRecordedSessionForVideoPath(normalizedPath);
		if (restoredSession) {
			setCurrentRecordingSessionState(restoredSession);
		} else {
			setCurrentRecordingSessionState({
				screenVideoPath: normalizedPath,
				createdAt: Date.now(),
			});
		}
		currentProjectPath = null;
		return { success: true, path: currentVideoPath ?? normalizedPath };
	}

	ipcMain.handle("get-current-video-path", () => {
		return getCurrentVideoPathResult();
	});

	function getCurrentVideoPathResult(): ProjectPathResult {
		return currentVideoPath ? { success: true, path: currentVideoPath } : { success: false };
	}

	ipcMain.handle("clear-current-video-path", () => {
		return clearCurrentVideoPath();
	});

	function clearCurrentVideoPath(): ProjectPathResult {
		currentVideoPath = null;
		currentProjectPath = null;
		setCurrentRecordingSessionState(null);
		return { success: true };
	}

	// Keep the native Windows/Linux window-control overlay in the app's theme
	// colours. The renderer sends the resolved CSS values so the palette stays in
	// one place. No-op on macOS (traffic lights aren't tintable) and on any window
	// that wasn't created with an overlay, which is what setTitleBarOverlay throws on.
	ipcMain.on("set-titlebar-overlay", (event, color: string, symbolColor: string) => {
		try {
			BrowserWindow.fromWebContents(event.sender)?.setTitleBarOverlay({ color, symbolColor });
		} catch {
			// Best-effort cosmetic.
		}
	});

	ipcMain.handle("get-shortcuts", async () => {
		try {
			const data = await fs.readFile(SHORTCUTS_FILE, "utf-8");
			return JSON.parse(data);
		} catch {
			return null;
		}
	});

	ipcMain.handle("save-shortcuts", async (_, shortcuts: unknown) => {
		try {
			await fs.writeFile(SHORTCUTS_FILE, JSON.stringify(shortcuts, null, 2), "utf-8");
			return { success: true };
		} catch (error) {
			console.error("Failed to save shortcuts:", error);
			return { success: false, error: String(error) };
		}
	});

	ipcMain.handle("save-diagnostic", async (_, payload: DiagnosticRequest) => {
		const { filePath, canceled } = await dialog.showSaveDialog({
			title: "Save Diagnostic File",
			defaultPath: `klippt-diagnostic-${Date.now()}.json`,
			filters: [{ name: "JSON", extensions: ["json"] }],
		});

		if (canceled || !filePath) return { success: false, canceled: true };

		const diagnostic = createDiagnosticReport({
			request: payload,
			environment: {
				appVersion: app.getVersion(),
				platform: process.platform,
				arch: process.arch,
				osRelease: os.release(),
				osVersion: os.version(),
				totalMemoryMB: Math.round(os.totalmem() / 1024 / 1024),
				nodeVersion: process.versions.node,
				electronVersion: process.versions.electron,
				chromeVersion: process.versions.chrome,
			},
			helperOutput: {
				windows: nativeWindowsCaptureOutput,
				mac: nativeMacRecordingService?.diagnosticOutput ?? "",
			},
			mainProcessLogs: mainLogBuffer.snapshot(),
			workloadReports: await workloadTelemetry.listRecent(20),
		});

		try {
			await fs.writeFile(filePath, JSON.stringify(diagnostic, null, 2), "utf-8");
			return { success: true, path: filePath };
		} catch (error) {
			console.error("Failed to write diagnostic file:", error);
			return { success: false, error: String(error) };
		}
	});

	// One instance each, not one per call. DocumentService serialises saves of a
	// project through a per-INSTANCE queue (see its writeProject comment — this
	// race destroyed two real project files), so a second instance means a second
	// queue racing for the same path: temp+rename still keeps the file valid, but
	// a save can land under a concurrent one and be silently lost.
	const aiEditionDocuments = new DocumentService(
		path.join(app.getPath("userData"), "projects"),
		RECORDINGS_DIR,
		{
			onDocumentReady: (document) =>
				cleanVoiceServiceReady.then((service) => service?.syncDocument(document)),
		},
	);
	const shutdownPreviews = registerNativeBridgeHandlers(
		{
			workloadTelemetry,
			assertEntitlement: (capability) => entitlementService.assertCapability(capability),
			getPlatform: () => process.platform,
			getCurrentProjectPath: () => currentProjectPath,
			getCurrentVideoPath: () => currentVideoPath,
			saveProjectFile,
			loadProjectFile,
			loadCurrentProjectFile,
			loadProjectFileFromPath,
			setCurrentVideoPath,
			getCurrentVideoPathResult,
			clearCurrentVideoPath,
			resolveAssetBasePath,
			resolveVideoPath: (videoPath?: string | null) =>
				normalizeVideoSourcePath(videoPath ?? currentVideoPath),
			loadCursorRecordingData: readCursorRecordingFile,
			loadCursorTelemetry: readCursorTelemetryFile,
			// compositor view's createView needs the renderer-owning
			// BrowserWindow's native handle (HWND on Windows, NSView* on macOS).
			// Same ownership rules as desktopCapturer: `BrowserWindow.fromWebContents`
			// gives us the window that hosts this sender; `getNativeWindowHandle`
			// is the platform-native parent handle the D3D11 addon parents its
			// child window to.
			getNativeWindowHandle: (sender) => {
				const window = BrowserWindow.fromWebContents(sender);
				if (!window || window.isDestroyed()) {
					return null;
				}
				try {
					return window.getNativeWindowHandle();
				} catch {
					return null;
				}
			},
			getAiEditionDocuments: () => aiEditionDocuments,
			resolveApprovedRendererMediaPath,
			approveReadableRendererMediaPath,
		},
		ipcMain,
	);

	const workloadQuitGuard = createWorkloadQuitGuard({
		finishPreviews: async () => {
			shutdownPreviews();
			await workloadTelemetry.finishPreviewsBeforeQuit();
		},
		quit: () => app.quit(),
		onError: (error) => console.warn("[diagnostics] workload quit flush failed:", error),
	});
	app.on("will-quit", workloadQuitGuard.willQuit);
	powerMonitor.on("shutdown", workloadQuitGuard.systemPoweringOff);

	return startupRecordingRecovery;
}
