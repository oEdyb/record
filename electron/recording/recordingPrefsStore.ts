import fs from "node:fs/promises";
import path from "node:path";
import {
	DEFAULT_RECORDING_QUALITY,
	normalizeRecordingQuality,
	type RecordingQuality,
} from "../../src/lib/recording/recordingQuality";
import type { CursorCaptureMode } from "../../src/lib/recordingSession";
import {
	DEFAULT_WEBCAM_FORMAT,
	normalizeWebcamFormat,
	type WebcamFormat,
} from "../../src/lib/webcamFormats";

export interface RecordingPrefs {
	recordingQuality: RecordingQuality;
	micEnabled: boolean;
	micDeviceId: string | null;
	camEnabled: boolean;
	camDeviceId: string | null;
	camFormat: WebcamFormat;
	systemAudioEnabled: boolean;
	cursorCaptureMode: CursorCaptureMode;
}

export const DEFAULT_RECORDING_PREFS: RecordingPrefs = {
	recordingQuality: DEFAULT_RECORDING_QUALITY,
	micEnabled: false,
	micDeviceId: null,
	camEnabled: false,
	camDeviceId: null,
	camFormat: DEFAULT_WEBCAM_FORMAT,
	systemAudioEnabled: false,
	cursorCaptureMode: "system",
};

function copyRecordingPrefs(preferences: RecordingPrefs): RecordingPrefs {
	return { ...preferences, camFormat: { ...preferences.camFormat } };
}

function nullableDeviceId(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

export function normalizeRecordingPrefs(raw: unknown): RecordingPrefs {
	const candidate = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	return {
		recordingQuality: normalizeRecordingQuality(candidate.recordingQuality),
		micEnabled:
			typeof candidate.micEnabled === "boolean"
				? candidate.micEnabled
				: DEFAULT_RECORDING_PREFS.micEnabled,
		micDeviceId: nullableDeviceId(candidate.micDeviceId),
		camEnabled:
			typeof candidate.camEnabled === "boolean"
				? candidate.camEnabled
				: DEFAULT_RECORDING_PREFS.camEnabled,
		camDeviceId: nullableDeviceId(candidate.camDeviceId),
		camFormat: normalizeWebcamFormat(candidate.camFormat),
		systemAudioEnabled:
			typeof candidate.systemAudioEnabled === "boolean"
				? candidate.systemAudioEnabled
				: DEFAULT_RECORDING_PREFS.systemAudioEnabled,
		cursorCaptureMode:
			candidate.cursorCaptureMode === "system" || candidate.cursorCaptureMode === "editable-overlay"
				? candidate.cursorCaptureMode
				: DEFAULT_RECORDING_PREFS.cursorCaptureMode,
	};
}

/** Small on-disk store for recording setup choices that must survive app relaunches. */
export class RecordingPrefsStore {
	private cached: RecordingPrefs | null = null;
	private loadPromise: Promise<RecordingPrefs> | null = null;
	private writeQueue: Promise<void> = Promise.resolve();

	constructor(private readonly filePath: string) {}

	async get(): Promise<RecordingPrefs> {
		if (this.cached) return copyRecordingPrefs(this.cached);
		if (!this.loadPromise) {
			this.loadPromise = this.loadFromDisk();
		}
		const loaded = await this.loadPromise;
		this.cached = loaded;
		return copyRecordingPrefs(loaded);
	}

	update(patch: Partial<RecordingPrefs>): Promise<RecordingPrefs> {
		let resolveResult: (value: RecordingPrefs) => void;
		let rejectResult: (reason?: unknown) => void;
		const result = new Promise<RecordingPrefs>((resolve, reject) => {
			resolveResult = resolve;
			rejectResult = reject;
		});

		this.writeQueue = this.writeQueue
			.catch(() => undefined)
			.then(async () => {
				try {
					const current = await this.get();
					const next = normalizeRecordingPrefs({ ...current, ...patch });
					this.cached = next;
					await this.writeToDisk(next);
					resolveResult(copyRecordingPrefs(next));
				} catch (error) {
					rejectResult(error);
				}
			});

		return result;
	}

	private async loadFromDisk(): Promise<RecordingPrefs> {
		try {
			const raw = await fs.readFile(this.filePath, "utf8");
			return normalizeRecordingPrefs(JSON.parse(raw));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) {
				console.warn("[recording-prefs] failed to read saved preferences:", error);
			}
			return copyRecordingPrefs(DEFAULT_RECORDING_PREFS);
		}
	}

	private async writeToDisk(preferences: RecordingPrefs): Promise<void> {
		await fs.mkdir(path.dirname(this.filePath), { recursive: true });
		const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
		try {
			await fs.writeFile(temporaryPath, JSON.stringify(preferences, null, 2), "utf8");
			await fs.rename(temporaryPath, this.filePath);
		} catch (error) {
			await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
			throw error;
		}
	}
}
