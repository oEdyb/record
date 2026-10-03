// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { editFixture, word } from "../../src/lib/ai-edition/checks/fixtures";
import { buildSceneDescription } from "../../src/native/sceneDescription";
import { brollSwapFields, inspectBrollSwap } from "../ai-edition/agentBrollSwap";
import { prepareAgentEditPlan } from "../ai-edition/agentEditPlan";
import { agentGuide, parseAgentCommand } from "./agentContracts";
import { applyPlacementCommand, buildPlacement, placementIntentSchema } from "./agentPlacement";

const intent = (values: Record<string, unknown> = {}) =>
	placementIntentSchema.parse({
		kind: "text",
		action: "add",
		project_id: "project",
		from: 6,
		to: 8,
		text: "Hello",
		...values,
	});
describe("speech placement commands", () => {
	it.each([
		["XS", 0.03, 0.02, 0.045],
		["S", 0.045, 0.03, 0.06],
		["M", 0.06, 0.045, 0.08],
		["L", 0.08, 0.06, 0.11],
		["XL", 0.11, 0.08, 0.15],
	] as const)("serializes real %s text sizes and matching boxes", (size, card, label, lowerThird) => {
		for (const [style, fraction] of [
			["card", card],
			["label", label],
			["lower-third", lowerThird],
		] as const) {
			const doc = editFixture();
			doc.legacyEditor = { ...doc.legacyEditor, padding: 80 };
			const candidate = prepareAgentEditPlan(
				doc,
				buildPlacement(doc, intent({ size, style })).operations,
			).candidate;
			const scene = buildSceneDescription(candidate);
			const annotation = scene.annotations[0];
			const screenHeight = scene.layout.layoutByClip?.[0]?.screenRect?.height ?? 1;
			expect((annotation.text?.fontSizeRel ?? 0) * screenHeight).toBeCloseTo(fraction);
			expect(annotation.h * screenHeight).toBeCloseTo(fraction * 2.2);
		}
	});
	it("explains when a frame-sized card cannot fit a short portrait screen", () => {
		const doc = editFixture();
		doc.assets[0].cameraTrack = null;
		doc.assets[0].video = { codec: "h264", width: 1920, height: 1080, fps: 60 };
		doc.legacyEditor = {
			...doc.legacyEditor,
			aspectRatio: "9:16",
			padding: 0,
			webcamLayoutPreset: "no-webcam",
		};
		expect(() => buildPlacement(doc, intent({ size: "XL", style: "lower-third" }))).toThrow(
			"TEXT_LAYOUT_UNAVAILABLE",
		);
	});
	it("discovers every command and accepts edited timecodes", () => {
		const parsed = parseAgentCommand([
			"text",
			"add",
			"--project_id",
			"project",
			"--from",
			"1:43",
			"--to",
			"1:48",
			"--text",
			"Kimi K2 swarm",
			"--anchor",
			"top",
			"--size",
			"M",
			"--style",
			"card",
		]);
		expect(parsed).toMatchObject({
			command: "text",
			input: { from: { seconds: 103, base: "edited" }, to: { seconds: 108, base: "edited" } },
		});
		expect(
			parseAgentCommand(["zoom", "add", "--project_id", "project", "--at", "125.324r"]),
		).toMatchObject({ input: { at: { seconds: 125.324, base: "raw" } } });
		for (const name of ["text", "broll", "zoom", "camera", "assets", "frame", "frames"])
			expect(agentGuide(name).commands[0].input_schema).toBeDefined();
		expect(
			parseAgentCommand(["camera", "set", "--project_id", "project", "--at", "3", "emphasis"]),
		).toMatchObject({ input: { mode: "emphasis", at: { seconds: 3, base: "edited" } } });
	});
	it("maps edited placement through a trim and persists one independent annotation", () => {
		const document = editFixture({ trims: [[2, 5]] });
		const built = buildPlacement(document, intent());
		expect(built.operations?.[0]).toMatchObject({
			args: { startSec: 9, endSec: 11, anchor: { kind: "edited", fromSec: 6, toSec: 8 } },
		});
		const result = prepareAgentEditPlan(document, built.operations).candidate;
		expect(result.annotations).toHaveLength(1);
		expect(result.annotations[0]).toMatchObject({
			startMs: 9000,
			endMs: 11000,
			style: { preset: "card", textAnimation: "fade" },
		});
		expect(result.annotations[0].clipId).toBeUndefined();
	});
	it("uses exact words, rejects ambiguous/missing phrases, and extends text minimum", () => {
		const document = editFixture({ words: [word("Hello", 6, 6.2), word("world", 6.2, 6.5)] });
		const built = buildPlacement(
			document,
			intent({ from: undefined, to: undefined, words: "Hello world" }),
		);
		expect(built.span).toEqual({ startSec: 6, endSec: 7.5 });
		expect(built.operations?.[0]).toMatchObject({
			args: { anchor: { kind: "words", clipId: "clip", sourceStartSec: 6, sourceEndSec: 6.5 } },
		});
		expect(built.notes).toHaveLength(1);
		expect(() => buildPlacement(document, intent({ words: "hello world" }))).toThrow(
			"WORDS_NOT_FOUND",
		);
		document.transcripts[0].words.push(word("Hello", 9, 9.2), word("world", 9.2, 9.5));
		expect(() =>
			buildPlacement(document, intent({ from: undefined, to: undefined, words: "Hello world" })),
		).toThrow("WORDS_AMBIGUOUS");
	});
	it("extends explicit ends and creates named zoom and camera operations", () => {
		const document = editFixture();
		const zoom = buildPlacement(
			document,
			placementIntentSchema.parse({
				kind: "zoom",
				action: "add",
				project_id: "project",
				from: 2,
				to: 2.1,
				size: "L",
				speed: "quick",
			}),
		);
		expect(zoom.span.endSec).toBe(2.8);
		expect(zoom.operations?.[0]).toMatchObject({
			type: "addZoom",
			args: { customScale: 2, motionStyle: "snappy", motionSpeed: 1.5 },
		});
		const camera = buildPlacement(
			document,
			placementIntentSchema.parse({
				kind: "camera",
				action: "set",
				project_id: "project",
				at: 4,
				mode: "emphasis",
				size: "XL",
			}),
		);
		expect(camera.operations?.[0]).toMatchObject({
			type: "addCameraFullscreen",
			args: { endSec: 4.8, cameraScale: 2 },
		});
	});
	it("reuses imported B-roll and prepares missing files through import-plan", () => {
		const document = editFixture();
		const make = (file: string) =>
			placementIntentSchema.parse({
				kind: "broll",
				action: "add",
				project_id: "project",
				from: 1,
				to: 3,
				file,
				fit: "cover",
			});
		expect(buildPlacement(document, make("/take.mp4")).operations?.[0]).toMatchObject({
			type: "addVideoOverlay",
			args: { assetId: "asset", placement: null },
		});
		expect(buildPlacement(document, make("/other.mp4")).media).toMatchObject({
			kind: "video",
			path: "/other.mp4",
			placement: { startSec: 1, endSec: 3 },
		});
	});
	it("prints the checked plan before apply and preserves uncertain receipt identity", async () => {
		const events: string[] = [];
		const request = vi.fn(async (r: { command: string }) => {
			events.push(r.command);
			if (r.command === "plan")
				return {
					status: "completed",
					data: { planId: "p", span: { startSec: 6 }, checks: { counts: { error: 0 } } },
				};
			throw new Error("connection lost");
		});
		const result = await applyPlacementCommand(intent(), "receipt-1", request, () =>
			events.push("printed"),
		);
		expect(events).toEqual(["plan", "printed", "apply"]);
		expect(result).toMatchObject({
			status: "recovery_required",
			operation_request_id: "receipt-1",
			commit_status: "unknown",
		});
	});
	it("rejects incompatible timing and out-of-edit minimum", () => {
		expect(() => intent({ at: 2 })).toThrow();
		expect(() => buildPlacement(editFixture(), intent({ from: 19.5, to: 19.6 }))).toThrow(
			"minimum duration",
		);
	});
});

it("snaps zooms near a cut and prevents subminimum camera pieces", async () => {
	const { splitClipAt } = await import("../../src/lib/ai-edition/document/timeline");
	const { buildSceneDescription } = await import("../../src/native/sceneDescription");
	const document = splitClipAt(editFixture(), "clip", 5);
	const intent = placementIntentSchema.parse({
		kind: "zoom",
		action: "add",
		project_id: "project",
		at: 4.6,
	});
	const built = buildPlacement(document, intent);
	expect(built.span.startSec).toBe(5);
	const scene = buildSceneDescription(prepareAgentEditPlan(document, built.operations).candidate);
	for (const piece of scene.zoomRegions)
		expect(piece.endSec - piece.startSec).toBeGreaterThanOrEqual(0.8 - 0.001);
	expect(built.notes.join(" ")).toContain("Snapped");
});

it("updates anchored text and moves anchored B-roll with the existing operations", async () => {
	const { buildSceneDescription } = await import("../../src/native/sceneDescription");
	const document = editFixture();
	const text = prepareAgentEditPlan(
		document,
		buildPlacement(document, intent()).operations,
	).candidate;
	const id = text.annotations[0].id;
	const changed = prepareAgentEditPlan(text, [
		{ type: "setAnnotation", args: { annotationId: id, text: "After" } },
	]).candidate;
	expect(changed.annotations[0].content).toBe("After");
	const moved = prepareAgentEditPlan(changed, [
		{ type: "setAnnotation", args: { annotationId: id, startSec: 10, endSec: 12 } },
	]).candidate;
	expect(buildSceneDescription(moved).annotations[0]).toMatchObject({ startSec: 10, endSec: 12 });
	const broll = prepareAgentEditPlan(
		document,
		buildPlacement(
			document,
			placementIntentSchema.parse({
				kind: "broll",
				action: "add",
				project_id: "project",
				from: 2,
				to: 4,
				file: "/take.mp4",
			}),
		).operations,
	).candidate;
	const video = prepareAgentEditPlan(broll, [
		{
			type: "setVideoOverlay",
			args: { videoOverlayId: broll.videoOverlays![0].id, startSec: 8, endSec: 10 },
		},
	]).candidate;
	expect(buildSceneDescription(video).videoOverlays?.[0]).toMatchObject({
		startSec: 8,
		endSec: 10,
	});
});

function swapFixture() {
	const doc = editFixture({ duration: 60 });
	doc.legacyEditor = { ...doc.legacyEditor, aspectRatio: "16:9" };
	doc.assets.push({
		id: "replacement",
		kind: "video",
		label: "Replacement",
		originalPath: "/new.mp4",
		durationSec: 8,
		cameraTrack: null,
		video: { codec: "h264", width: 1920, height: 1080, fps: 30 },
	});
	doc.videoOverlays = [
		{
			id: "overlay",
			assetId: "asset",
			startMs: 2000,
			endMs: 42000,
			clipId: "clip",
			sourceStartSec: 2,
			sourceEndSec: 42,
			sourceOffsetSec: 3,
			fit: "cover",
			placement: null,
			opacity: 0.7,
			motion: "fade",
		},
	];
	return doc;
}
const swapArgs = (values: Record<string, unknown> = {}) =>
	brollSwapFields.parse({ videoOverlayId: "overlay", assetId: "replacement", ...values });
describe("B-roll swap fit decisions", () => {
	it.each([
		[1920, 1080, "auto", "cover"],
		[1080, 1920, "auto", "contain"],
		[3840, 720, "auto", "contain"],
		[1080, 1920, "cover", "cover"],
		[1920, 1080, "contain", "contain"],
	])("fits %s x %s with %s as %s", (width, height, fit, chosen) => {
		const doc = swapFixture();
		doc.assets[1].video = { codec: "h264", width: Number(width), height: Number(height), fps: 30 };
		expect(inspectBrollSwap(doc, swapArgs({ fit })).report.fit).toMatchObject({
			chosen,
			slotAspect: 16 / 9,
			mediaAspect: Number(width) / Number(height),
		});
	});
	it("computes slot aspect from output pixels and the preserved placement", () => {
		const doc = swapFixture();
		doc.videoOverlays![0].placement = { x: 5, y: 10, width: 25, height: 80 };
		const fit = inspectBrollSwap(doc, swapArgs()).report.fit;
		expect(fit.slotAspect).toBeCloseTo((1920 * 0.25) / (1080 * 0.8));
		expect(fit.chosen).toBe("contain");
	});
	it("trims short media after the requested offset", () => {
		expect(inspectBrollSwap(swapFixture(), swapArgs({ sourceOffsetSec: 2 })).report.time).toEqual({
			spanSec: 40,
			availableSec: 6,
			shortenedBySec: 34,
		});
	});
	it("reports the unused tail without extending the span", () => {
		const doc = swapFixture();
		doc.assets[1].durationSec = 50;
		expect(inspectBrollSwap(doc, swapArgs({ sourceOffsetSec: 2 })).report.time).toEqual({
			spanSec: 40,
			availableSec: 48,
			unusedTailSec: 8,
		});
	});
	it.each([7.5, 8, 9])("rejects at most half a second after offset %s", (sourceOffsetSec) => {
		expect(() => inspectBrollSwap(swapFixture(), swapArgs({ sourceOffsetSec }))).toThrow(
			"MEDIA_TOO_SHORT",
		);
	});
	it("accepts hold because the compositor retains its EOF frame", () => {
		const { report } = inspectBrollSwap(swapFixture(), swapArgs({ time: "hold" }));
		expect(report.time).toEqual({ spanSec: 40, availableSec: 8 });
		expect(report.notes).toEqual(["Holds the last frame for 32s; media speed is unchanged."]);
	});
	it("rejects an unknown overlay and unreadable dimensions", () => {
		expect(() => inspectBrollSwap(swapFixture(), swapArgs({ videoOverlayId: "missing" }))).toThrow(
			"UNKNOWN_VIDEO_OVERLAY",
		);
		const doc = swapFixture();
		delete doc.assets[1].video;
		expect(() => inspectBrollSwap(doc, swapArgs())).toThrow("MEDIA_UNAVAILABLE");
	});
});

it("swaps through plan and apply and returns decisions beside receipt and verify", async () => {
	const swap = { overlayId: "overlay", assetId: "new", fit: { chosen: "cover" } };
	const request = vi.fn(async (r: { command: string }) =>
		r.command === "plan"
			? { status: "completed", data: { planId: "plan", span: { startSec: 2 }, swap } }
			: r.command === "apply"
				? { status: "completed", data: { receipt: { id: "receipt" }, verify: { ok: true } } }
				: { status: "completed", data: { state: "ready" } },
	);
	const result = await applyPlacementCommand(
		{
			kind: "broll-swap",
			action: "swap",
			project_id: "project",
			overlay: "overlay",
			file: "/new.mp4",
			offset: 0,
			fit: "auto",
			time: "trim",
			force: false,
		},
		"swap-request",
		request,
		() => undefined,
	);
	expect(request.mock.calls.map(([r]) => r.command)).toEqual(["plan", "apply", "state"]);
	expect(result).toMatchObject({
		commit_status: "committed",
		operation_request_id: "swap-request",
		data: { swap, receipt: { id: "receipt" }, verify: { ok: true } },
	});
});

it("preserves one overlay and unrelated fields when shortening legacy clip timing", () => {
	const doc = swapFixture();
	const plan = prepareAgentEditPlan(doc, [{ type: "swapVideoOverlay", args: swapArgs() }]);
	const before = doc.videoOverlays![0];
	expect(plan.candidate.videoOverlays).toEqual([
		{ ...before, assetId: "replacement", sourceOffsetSec: 0, endMs: 10000, sourceEndSec: 10 },
	]);
	expect(buildSceneDescription(plan.candidate).videoOverlays?.at(-1)).toMatchObject({
		endSec: 10,
		path: "/new.mp4",
	});
	expect(plan.changed_ids).toContain("overlay");
});

it("holds a short source and reuses its existing asset without extending media duration", () => {
	const doc = swapFixture();
	const plan = prepareAgentEditPlan(doc, [
		{ type: "swapVideoOverlay", args: swapArgs({ time: "hold" }) },
	]);
	expect(plan.candidate.assets).toEqual(doc.assets);
	expect(plan.candidate.videoOverlays).toEqual([
		{ ...doc.videoOverlays![0], assetId: "replacement", sourceOffsetSec: 0 },
	]);
	expect(buildSceneDescription(plan.candidate).videoOverlays?.at(-1)?.endSec).toBe(42);
});

it("preserves edited and word anchors when the source fits or hold is selected", () => {
	const anchors = [
		{ kind: "edited", fromSec: 2, toSec: 42 },
		{ kind: "words", clipId: "clip", text: "Hello", sourceStartSec: 2, sourceEndSec: 42 },
	] as const;
	for (const anchor of anchors) {
		const doc = swapFixture();
		doc.videoOverlays![0].anchor = anchor;
		for (const time of ["trim", "hold"] as const) {
			doc.assets[1].durationSec = time === "trim" ? 50 : 8;
			const candidate = prepareAgentEditPlan(doc, [
				{ type: "swapVideoOverlay", args: swapArgs({ time }) },
			]).candidate;
			expect(candidate.videoOverlays).toEqual([
				{ ...doc.videoOverlays![0], assetId: "replacement", sourceOffsetSec: 0 },
			]);
		}
	}
});
