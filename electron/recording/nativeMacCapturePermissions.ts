import type { NativeMacRecordingRequest } from "../../src/lib/nativeMacRecording";

type CapturePermissionDependencies = {
	getStatus: (mediaType: "screen" | "microphone") => string;
	requestScreenAccess: () => Promise<unknown>;
	requestMicrophoneAccess: () => Promise<unknown>;
};

export async function prepareNativeMacCapturePermissions(
	request: NativeMacRecordingRequest,
	deps: CapturePermissionDependencies,
): Promise<void> {
	let screenGranted = false;
	try {
		screenGranted = deps.getStatus("screen") === "granted";
	} catch {
		// A missing status still uses Electron's permission request path.
	}
	if (!screenGranted) {
		await deps.requestScreenAccess().catch(() => undefined);
	}
	if (request.audio.microphone.enabled && deps.getStatus("microphone") !== "granted") {
		await deps.requestMicrophoneAccess();
	}
}
