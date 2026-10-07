export interface WebcamFormat {
	width: number;
	height: number;
	fps: number;
}

export const DEFAULT_WEBCAM_FORMAT: WebcamFormat = {
	width: 1920,
	height: 1080,
	fps: 30,
};

export const WEBCAM_FORMAT_CANDIDATES: readonly WebcamFormat[] = [
	{ width: 3840, height: 2160, fps: 30 },
	{ width: 2560, height: 1440, fps: 30 },
	{ width: 1920, height: 1080, fps: 60 },
	{ width: 1920, height: 1080, fps: 30 },
	{ width: 1280, height: 720, fps: 60 },
	{ width: 1280, height: 720, fps: 30 },
];

type WebcamTrack = Pick<
	MediaStreamTrack,
	"applyConstraints" | "getCapabilities" | "getConstraints" | "getSettings"
>;

function safeInteger(value: unknown, min: number, max: number): number | null {
	return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
		? value
		: null;
}

export function normalizeWebcamFormat(value: unknown): WebcamFormat {
	const candidate = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
	const width = safeInteger(candidate.width, 320, 7680);
	const height = safeInteger(candidate.height, 240, 4320);
	const fps = safeInteger(candidate.fps, 1, 240);
	return width && height && fps ? { width, height, fps } : { ...DEFAULT_WEBCAM_FORMAT };
}

export function webcamFormatKey(format: WebcamFormat): string {
	return `${format.width}x${format.height}@${format.fps}`;
}

export function sameWebcamFormat(left: WebcamFormat, right: WebcamFormat): boolean {
	return webcamFormatKey(left) === webcamFormatKey(right);
}

export function formatWebcamFormat(format: WebcamFormat): string {
	const resolution =
		format.width === 3840 && format.height === 2160
			? "4K"
			: format.width === 2560 && format.height === 1440
				? "2K"
				: format.height === 1080
					? "1080p"
					: format.height === 720
						? "720p"
						: `${format.width} × ${format.height}`;
	return `${resolution}, ${format.fps} FPS`;
}

function exactConstraints(format: WebcamFormat): MediaTrackConstraints {
	return {
		width: { exact: format.width },
		height: { exact: format.height },
		// Camera drivers commonly report 59.94 for their advertised 60 FPS mode.
		frameRate: { min: Math.max(1, format.fps - 1), ideal: format.fps, max: format.fps },
	};
}

export function preferredWebcamConstraints(format: WebcamFormat): MediaTrackConstraints {
	return {
		width: { ideal: format.width, max: format.width },
		height: { ideal: format.height, max: format.height },
		frameRate: { ideal: format.fps, max: format.fps },
	};
}

/** Request an actual camera mode, without imposing the saved 1080p preview ceiling. */
export function nativeWebcamConstraints(supportsResizeMode: boolean): MediaTrackConstraints {
	return {
		...(supportsResizeMode ? { resizeMode: { exact: "none" } } : {}),
		width: { ideal: 7680 },
		height: { ideal: 4320 },
		frameRate: { ideal: 60, max: 60 },
	};
}

export function applyWebcamFormat(
	track: Pick<MediaStreamTrack, "applyConstraints">,
	format: WebcamFormat,
	mode: "exact" | "preferred" = "exact",
): Promise<void> {
	return track.applyConstraints(
		mode === "exact" ? exactConstraints(format) : preferredWebcamConstraints(format),
	);
}

export function webcamFormatFromSettings(
	settings: MediaTrackSettings,
	fallback: WebcamFormat = DEFAULT_WEBCAM_FORMAT,
): WebcamFormat {
	return normalizeWebcamFormat({
		width: settings.width ?? fallback.width,
		height: settings.height ?? fallback.height,
		fps: Math.round(settings.frameRate ?? fallback.fps),
	});
}

function capabilityIncludes(
	range: { min?: number; max?: number } | undefined,
	value: number,
	tolerance = 0,
) {
	return (
		!range ||
		((range.min === undefined || value >= range.min - tolerance) &&
			(range.max === undefined || value <= range.max + tolerance))
	);
}

export function settingsMatchFormat(settings: MediaTrackSettings, format: WebcamFormat): boolean {
	return (
		settings.width === format.width &&
		settings.height === format.height &&
		Math.abs((settings.frameRate ?? format.fps) - format.fps) <= 1
	);
}

/**
 * MediaTrackCapabilities exposes independent ranges, not valid combinations. Probe each
 * resolution/FPS pair with required constraints so the UI never invents a 4K/60 mode from
 * an unrelated 4K maximum and 60 FPS maximum.
 */
export async function probeWebcamFormats(
	track: WebcamTrack,
	candidates: readonly WebcamFormat[] = WEBCAM_FORMAT_CANDIDATES,
): Promise<WebcamFormat[]> {
	const capabilities = track.getCapabilities();
	const originalConstraints = track.getConstraints();
	const supported: WebcamFormat[] = [];

	try {
		for (const format of candidates) {
			if (
				!capabilityIncludes(capabilities.width, format.width) ||
				!capabilityIncludes(capabilities.height, format.height) ||
				!capabilityIncludes(capabilities.frameRate, format.fps, 1)
			) {
				continue;
			}

			try {
				await applyWebcamFormat(track, format);
				if (settingsMatchFormat(track.getSettings(), format)) supported.push(format);
			} catch {
				// This exact width/height/FPS combination is not available.
			}
		}
	} finally {
		await track.applyConstraints(originalConstraints).catch(() => undefined);
	}

	return supported;
}

const probedFormatsByDevice = new Map<string, WebcamFormat[]>();

/** Camera identity for the probe cache: the stable Chromium device id, else the track label. */
function webcamProbeCacheKey(
	track: Pick<MediaStreamTrack, "getSettings" | "label">,
	deviceId?: string,
): string | null {
	const settingsDeviceId = track.getSettings().deviceId;
	const key = settingsDeviceId || deviceId || track.label;
	return key ? key : null;
}

/**
 * Probing switches the live camera through every candidate mode, which blanks the
 * preview for seconds on a 4K UVC camera. Keep the result per device for the app session
 * so reopening the panel or re-acquiring the same camera does not repeat that.
 */
/** Modes already probed for this camera in this app session; empty when never probed. */
export function cachedWebcamFormats(
	track: Pick<MediaStreamTrack, "getSettings" | "label">,
	deviceId?: string,
): WebcamFormat[] {
	const key = webcamProbeCacheKey(track, deviceId);
	const cached = key ? probedFormatsByDevice.get(key) : undefined;
	return cached ? cached.map((format) => ({ ...format })) : [];
}

export async function probeWebcamFormatsCached(
	track: WebcamTrack & Pick<MediaStreamTrack, "label">,
	deviceId?: string,
	candidates: readonly WebcamFormat[] = WEBCAM_FORMAT_CANDIDATES,
): Promise<WebcamFormat[]> {
	const key = webcamProbeCacheKey(track, deviceId);
	const cached = key ? probedFormatsByDevice.get(key) : undefined;
	if (cached) return cached.map((format) => ({ ...format }));
	const probed = await probeWebcamFormats(track, candidates);
	if (key && probed.length > 0) {
		probedFormatsByDevice.set(
			key,
			probed.map((format) => ({ ...format })),
		);
	}
	return probed;
}

export function clearWebcamFormatProbeCache(): void {
	probedFormatsByDevice.clear();
}

export function supportsNativeWebcamMode(constraints: MediaTrackSupportedConstraints): boolean {
	return "resizeMode" in constraints && constraints.resizeMode === true;
}
