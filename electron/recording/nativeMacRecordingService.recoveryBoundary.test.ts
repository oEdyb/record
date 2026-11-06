import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StudioTransport } from "../../src/components/studio/StudioTransport";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import type { NativeMacRecordingRequest } from "../../src/lib/nativeMacRecording";
import type { RecordingSessionClip } from "../../src/lib/recordingSession";
import { StudioController } from "../studio/studioController";
import { IDLE_PILL_STATE } from "../studio/types";
import { ClipJournalLifecycle } from "./clipJournalLifecycle";
import {
	type NativeMacCaptureHelper,
	NativeMacRecordingService,
	type NativeMacRecordingServiceDependencies,
} from "./nativeMacRecordingService";
import {
	nativeMacRecoveryJournalPath,
	readNativeMacRecoveryMetadata,
} from "./nativeMacRecoveryJournal";

vi.mock("../../src/contexts/I18nContext", () => ({ useScopedT: () => (key: string) => key }));
vi.mock("../export/sourceHandoffMedia", () => ({
	inspectHandoffSourceMedia: vi.fn(async () => ({
		hasAudio: false,
		hasKlipptMetadata: false,
		roles: [],
		durationSec: 1,
		video: { codec: "h264", width: 16, height: 16, fps: 30 },
	})),
}));

const evidenceRoot = path.join(os.homedir(), ".cache", "klippt-work", "clip-recovery-boundaries");
const services: NativeMacRecordingService[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const service of services.splice(0)) await service.stop();
	vi.useRealTimers();
});

async function evidence(name: string, value: unknown) {
	await fs.mkdir(evidenceRoot, { recursive: true });
	await fs.writeFile(
		path.join(evidenceRoot, `${name}.json`),
		`${JSON.stringify(value, null, 2)}\n`,
	);
	console.log(name, JSON.stringify(value));
}

async function fixture(completed = 1) {
	await fs.mkdir(evidenceRoot, { recursive: true });
	const root = await fs.mkdtemp(path.join(evidenceRoot, "clip-fixture-"));
	const clips: RecordingSessionClip[] = [];
	let running = true;
	let stopFails = false;
	const helper: NativeMacCaptureHelper = {
		captureBounds: null,
		output: "",
		isRunning: () => running,
		kill: async () => {
			running = false;
		},
		waitForStart: async () => undefined,
		pause: async () => {
			const clip = {
				index: clips.length,
				screenVideoPath: path.join(
					root,
					`recording-100-clip-${String(clips.length + 1).padStart(4, "0")}.mp4`,
				),
				durationMs: 1000,
			};
			await fs.writeFile(clip.screenVideoPath, `untouched-screen-${clip.index}`);
			clips.push(clip);
			return clip;
		},
		resume: async () => clips.length,
		reconfigure: async () => undefined,
		stop: async () => {
			if (stopFails) throw new Error("injected helper Stop failure");
			running = false;
			return { screenPath: clips[0].screenVideoPath, clips };
		},
	};
	const request: NativeMacRecordingRequest = {
		schemaVersion: 1,
		recordingId: 100,
		source: { type: "display", sourceId: "screen:1:0", displayId: 1 },
		video: { fps: 30, width: 16, height: 16, hideSystemCursor: false },
		audio: { system: { enabled: false }, microphone: { enabled: false, gain: 1 } },
		webcam: { enabled: false, width: 16, height: 16, fps: 30 },
		cursor: { mode: "system" },
		outputs: { screenPath: "" },
	};
	const changed = vi.fn();
	const deps: NativeMacRecordingServiceDependencies = {
		recordingsDir: root,
		now: () => 100,
		findHelperPath: async () => "fake-helper",
		createHelper: () => helper,
		resolveCapture: (input, recordingId, screenPath) => ({
			config: { ...input, recordingId, outputs: { screenPath } },
			cursorCaptureMode: "system",
		}),
		prepareCapturePermissions: async () => undefined,
		startCursor: async () => false,
		stopCursor: async () => undefined,
		clearCursor: () => undefined,
		finalizeCursor: async () => undefined,
		registerMediaLinks: async () => undefined,
		onSessionStored: () => undefined,
		onRecordingStateChange: () => undefined,
		onFatalError: vi.fn(),
		onClipEditStateChange: changed,
		freeDiskBytes: async () => 100 * 1024 ** 3,
	};
	const service = new NativeMacRecordingService(deps);
	services.push(service);
	expect(await service.start(request)).toMatchObject({ success: true });
	for (let index = 0; index < completed; index++) {
		if (index) expect(await service.resume()).toMatchObject({ success: true });
		expect(await service.pause()).toMatchObject({ success: true });
	}
	return {
		root,
		service,
		clips,
		helper,
		changed,
		failStop: () => {
			stopFails = true;
		},
	};
}

function failNextJournalRename(root: string) {
	const rename = fs.rename.bind(fs);
	let next = true;
	return vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
		if (next && to === nativeMacRecoveryJournalPath(root, 100)) {
			next = false;
			throw new Error("injected journal rename failure");
		}
		return rename(from, to);
	});
}

function failNextDirectorySync(root: string) {
	const open = fs.open.bind(fs);
	let next = true;
	return vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
		const handle = await open(...args);
		if (args[0] === root && next) {
			next = false;
			handle.sync = async () => {
				throw new Error("injected directory sync failure after rename");
			};
		}
		return handle;
	});
}

describe("row10 independent recovery follow-up", () => {
	it("R1: reconciles after Continue and a new completed clip during the recovery interval", async () => {
		const f = await fixture();
		vi.useFakeTimers();
		const warnings = vi.spyOn(console, "warn");
		failNextJournalRename(f.root);
		await expect(f.service.removePreviousClip()).rejects.toThrow("Clip edits are paused");
		expect(await f.service.resume()).toMatchObject({ success: true });
		expect(await f.service.pause()).toMatchObject({ success: true });
		await vi.waitFor(
			() =>
				expect(
					f.service.studioTake().clipEdits === "ready" ||
						warnings.mock.calls.filter(
							(call) => call[0] === "[clip-journal] Reconciliation will retry",
						).length >= 2,
				).toBe(true),
			{ timeout: 2500 },
		);
		const disk = await readNativeMacRecoveryMetadata(f.root, 100);
		const observed = {
			state: f.service.studioTake(),
			disk,
			changed: f.changed.mock.calls.length,
			media: await Promise.all(f.clips.map((clip) => fs.readFile(clip.screenVideoPath, "utf8"))),
		};
		await evidence("R1-new-clip-during-recovery", observed);
		expect(
			observed.state.clipEdits,
			"healthy disk must allow auto recovery after continued capture",
		).toBe("ready");
		expect(disk?.clips?.map((clip) => clip.index)).toEqual([0, 1]);
	});

	it("R2: failed Stop during ambiguous Remove retains both last-acknowledged kept clips", async () => {
		const f = await fixture(2);
		vi.useFakeTimers();
		const fail = failNextDirectorySync(f.root);
		await expect(f.service.removePreviousClip()).rejects.toThrow("Clip edits are paused");
		fail.mockRestore();
		const acknowledged = f.service.studioTake();
		const diskBeforeStop = await readNativeMacRecoveryMetadata(f.root, 100);
		f.failStop();
		const result = await f.service.stop();
		const kept = result.session?.clips?.filter((clip) => !clip.removed).map((clip) => clip.index);
		await evidence("R2-ambiguous-remove-failed-stop", {
			acknowledged,
			diskBeforeStop,
			result,
			kept,
			media: await Promise.all(f.clips.map((clip) => fs.readFile(clip.screenVideoPath, "utf8"))),
		});
		expect(result.success).toBe(true);
		expect(kept, "a rejected Remove must not become accepted by Stop's fallback").toEqual([0, 1]);
	});

	it("R3: successful Stop before reconciliation preserves acknowledged kept clips", async () => {
		const f = await fixture(2);
		vi.useFakeTimers();
		const fail = failNextDirectorySync(f.root);
		await expect(f.service.removePreviousClip()).rejects.toThrow("Clip edits are paused");
		fail.mockRestore();
		const result = await f.service.stop();
		await evidence("R3-ambiguous-remove-successful-stop", result);
		expect(result.success).toBe(true);
		expect(
			result.session?.clips?.filter((clip) => !clip.removed).map((clip) => clip.index),
		).toEqual([0, 1]);
	});

	it("R4: rejects mismatched disk ownership without rewriting metadata or media", async () => {
		const f = await fixture();
		vi.useFakeTimers();
		failNextJournalRename(f.root);
		await expect(f.service.removePreviousClip()).rejects.toThrow("Clip edits are paused");
		const journalPath = nativeMacRecoveryJournalPath(f.root, 100);
		const disk = await readNativeMacRecoveryMetadata(f.root, 100);
		if (!disk?.clips?.[0]) throw new Error("missing fixture journal");
		disk.clips[0].screenVideoPath = path.join(f.root, "different-owner.mp4");
		await fs.writeFile(journalPath, JSON.stringify({ schemaVersion: 1, session: disk }));
		const before = await fs.readFile(journalPath, "utf8");
		await vi.advanceTimersByTimeAsync(1000);
		const after = await fs.readFile(journalPath, "utf8");
		await evidence("R4-disk-owner-mismatch", { before, after, state: f.service.studioTake() });
		expect(after).toBe(before);
		expect(f.service.studioTake().clipEdits).toBe("needs-recovery");
		expect(await fs.readFile(f.clips[0].screenVideoPath, "utf8")).toBe("untouched-screen-0");
	});

	it("R5: exposes recovery in Studio while keeping Continue, Stop, and Finish enabled", async () => {
		const f = await fixture();
		vi.useFakeTimers();
		failNextJournalRename(f.root);
		await expect(f.service.removePreviousClip()).rejects.toThrow("Clip edits are paused");
		const controller = new StudioController({
			take: () => f.service.studioTake(),
			transcript: () => ({
				recordingId: null,
				clips: [],
				status: "idle",
				progress: null,
				download: null,
				error: null,
				updatedAt: 0,
			}),
			setup: () => ({
				source: null,
				micEnabled: false,
				micDeviceId: null,
				cameraEnabled: false,
				cameraDeviceId: null,
				systemAudioEnabled: false,
				cursorCaptureMode: "system",
				recordingQuality: "high",
			}),
			getPill: () => null,
			createWindow: () => {
				throw new Error("no desktop allowed");
			},
			sendToPill: () => undefined,
			openReview: () => undefined,
			outsideCapture: async () => true,
			endCaptureCheck: () => undefined,
			waitForUnmap: async () => undefined,
		});
		const snapshot = {
			...controller.snapshot(),
			pill: { ...IDLE_PILL_STATE, canPause: true, canRemovePreviousClip: true, undoClipIndex: 0 },
		};
		expect(snapshot).toMatchObject({ phase: "paused", clipEdits: "needs-recovery" });
		const html = renderToStaticMarkup(
			createElement(
				TooltipProvider,
				null,
				createElement(StudioTransport, {
					snapshot,
					pending: false,
					elapsed: 1,
					send: () => undefined,
				}),
			),
		);
		const reviewHtml = renderToStaticMarkup(
			createElement(
				TooltipProvider,
				null,
				createElement(StudioTransport, {
					snapshot: { ...snapshot, phase: "review" },
					pending: false,
					elapsed: 1,
					send: () => undefined,
				}),
			),
		);
		const button = (label: string) =>
			html.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))?.[0];
		await fs.writeFile(path.join(evidenceRoot, "R5-paused-transport.html"), html);
		await evidence("R5-studio-recovery-controls", { snapshot, html, reviewHtml });
		expect(html).toContain('role="status">Clip edits are paused.');
		expect(button("recording.removePreviousClip")).toMatch(/\sdisabled=""/);
		expect(html).toMatch(/<button[^>]*disabled[^>]*>studio.undo<\/button>/);
		expect(button("tooltips.resumeRecording")).toBeDefined();
		expect(button("tooltips.resumeRecording")).not.toMatch(/\sdisabled(?:=|\s|>)/);
		expect(button("tooltips.stopRecording")).toBeDefined();
		expect(button("tooltips.stopRecording")).not.toMatch(/\sdisabled(?:=|\s|>)/);
		expect(reviewHtml).toMatch(/<button(?:(?!disabled)[^>])*>studio.finish<\/button>/);
	});

	it("R6: rejects old edit acknowledgements after reset without changing the current owner", () => {
		const lifecycle = new ClipJournalLifecycle();
		const first = Symbol("first");
		const second = Symbol("second");
		expect(lifecycle.transition({ type: "begin", change: { token: first, clips: [] } })).toBe(true);
		expect(lifecycle.transition({ type: "failed", token: first })).toBe(true);
		expect(lifecycle.transition({ type: "reconcile" })).toBe(true);
		expect(lifecycle.transition({ type: "reset" })).toBe(true);
		expect(lifecycle.transition({ type: "begin", change: { token: second, clips: [] } })).toBe(
			true,
		);
		const current = lifecycle.state;
		expect(lifecycle.transition({ type: "reconciled", token: first })).toBe(false);
		expect(lifecycle.transition({ type: "failed", token: first })).toBe(false);
		expect(lifecycle.state).toBe(current);
		expect(lifecycle.transition({ type: "committed", token: second })).toBe(true);
	});

	it("R7: Stop still saves while journal replacement remains unavailable", async () => {
		const f = await fixture();
		vi.useFakeTimers();
		const rename = fs.rename.bind(fs);
		vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
			if (to === nativeMacRecoveryJournalPath(f.root, 100))
				throw new Error("journal remains unavailable");
			return rename(from, to);
		});
		await expect(f.service.removePreviousClip()).rejects.toThrow("Clip edits are paused");
		const result = await f.service.stop();
		await evidence("R7-save-with-unavailable-journal", result);
		expect(result.success).toBe(true);
		expect(
			result.session?.clips?.filter((clip) => !clip.removed).map((clip) => clip.index),
		).toEqual([0]);
		expect(await fs.readFile(f.clips[0].screenVideoPath, "utf8")).toBe("untouched-screen-0");
	});
});
