export type CapturePermissionKind = "screen" | "microphone" | "camera";
export type CapturePermissionStatus = "granted" | "not-determined" | "denied" | "restricted";
export type CapturePermissions = Record<CapturePermissionKind, CapturePermissionStatus>;

export const CAPTURE_PERMISSION_KINDS: readonly CapturePermissionKind[] = [
	"screen",
	"microphone",
	"camera",
];

export type PermissionNeeds = { microphone: boolean; camera: boolean };

/** What the HUD's permission panel offers next for a recording with these inputs. */
export type PermissionStep =
	| { kind: "ready" }
	| { kind: "ask"; permission: CapturePermissionKind }
	| { kind: "settings"; blocked: CapturePermissionKind[]; relaunch: boolean };

export function neededPermissions(needs: PermissionNeeds): CapturePermissionKind[] {
	return CAPTURE_PERMISSION_KINDS.filter((kind) => kind === "screen" || needs[kind]);
}

export function permissionStep(
	permissions: CapturePermissions,
	needs: PermissionNeeds,
): PermissionStep {
	const needed = neededPermissions(needs);
	// One system prompt at a time, screen first: it is the one recording cannot do without.
	const unasked = needed.find((kind) => permissions[kind] === "not-determined");
	if (unasked) return { kind: "ask", permission: unasked };
	const blocked = needed.filter((kind) => permissions[kind] !== "granted");
	if (blocked.length === 0) return { kind: "ready" };
	// macOS applies a new Screen Recording grant only after the app restarts.
	return { kind: "settings", blocked, relaunch: blocked.includes("screen") };
}
