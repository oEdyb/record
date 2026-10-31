import { systemPreferences } from "electron";
import {
	CAPTURE_PERMISSION_KINDS,
	type CapturePermissionKind,
	type CapturePermissionStatus,
	type CapturePermissions,
} from "../src/lib/capturePermissions";

const PRIVACY_PANES: Record<CapturePermissionKind, string> = {
	screen: "Privacy_ScreenCapture",
	microphone: "Privacy_Microphone",
	camera: "Privacy_Camera",
};

function normalizeStatus(status: string): CapturePermissionStatus {
	if (status === "granted" || status === "not-determined" || status === "restricted") return status;
	// "denied" and "unknown" both need the user to switch Klippt on in System Settings.
	return "denied";
}

/** Reads every capture permission without prompting. Only macOS gates capture this way. */
export function readCapturePermissions(
	platform: NodeJS.Platform = process.platform,
	getStatus: (kind: CapturePermissionKind) => string = (kind) =>
		systemPreferences.getMediaAccessStatus(kind),
): CapturePermissions {
	const read = (kind: CapturePermissionKind): CapturePermissionStatus =>
		platform === "darwin" ? normalizeStatus(getStatus(kind)) : "granted";
	return { screen: read("screen"), microphone: read("microphone"), camera: read("camera") };
}

export function privacySettingsPane(kind: unknown): string | null {
	// The editable cursor's optional grant; not a capture permission Record waits for.
	if (kind === "accessibility") return "Privacy_Accessibility";
	const match = CAPTURE_PERMISSION_KINDS.find((candidate) => candidate === kind);
	return match ? PRIVACY_PANES[match] : null;
}
