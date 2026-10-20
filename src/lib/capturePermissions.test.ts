import { describe, expect, it } from "vitest";
import { type CapturePermissions, neededPermissions, permissionStep } from "./capturePermissions";

const granted: CapturePermissions = { screen: "granted", microphone: "granted", camera: "granted" };

describe("permissionStep", () => {
	it("is ready when every needed permission is granted", () => {
		expect(permissionStep(granted, { microphone: true, camera: true })).toEqual({ kind: "ready" });
	});

	it("ignores inputs the recording does not use", () => {
		const permissions = {
			...granted,
			microphone: "denied" as const,
			camera: "not-determined" as const,
		};
		expect(permissionStep(permissions, { microphone: false, camera: false })).toEqual({
			kind: "ready",
		});
	});

	it("asks for one permission at a time, screen first", () => {
		const permissions: CapturePermissions = {
			screen: "not-determined",
			microphone: "not-determined",
			camera: "granted",
		};
		expect(permissionStep(permissions, { microphone: true, camera: false })).toEqual({
			kind: "ask",
			permission: "screen",
		});
		expect(
			permissionStep({ ...permissions, screen: "granted" }, { microphone: true, camera: false }),
		).toEqual({ kind: "ask", permission: "microphone" });
	});

	it("asks before sending anyone to System Settings", () => {
		const permissions: CapturePermissions = {
			screen: "denied",
			microphone: "not-determined",
			camera: "granted",
		};
		expect(permissionStep(permissions, { microphone: true, camera: false })).toEqual({
			kind: "ask",
			permission: "microphone",
		});
	});

	it("needs a relaunch only when Screen Recording is blocked", () => {
		expect(
			permissionStep({ ...granted, screen: "denied" }, { microphone: false, camera: false }),
		).toEqual({ kind: "settings", blocked: ["screen"], relaunch: true });
		expect(
			permissionStep({ ...granted, camera: "restricted" }, { microphone: false, camera: true }),
		).toEqual({ kind: "settings", blocked: ["camera"], relaunch: false });
	});
});

describe("neededPermissions", () => {
	it("always needs the screen and adds enabled inputs", () => {
		expect(neededPermissions({ microphone: false, camera: false })).toEqual(["screen"]);
		expect(neededPermissions({ microphone: true, camera: true })).toEqual([
			"screen",
			"microphone",
			"camera",
		]);
	});
});
