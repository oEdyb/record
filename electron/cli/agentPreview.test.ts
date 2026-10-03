// @vitest-environment node
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyDocument, documentSchema } from "../../src/lib/ai-edition/schema";
import { prepareAgentEditPlan } from "../ai-edition/agentEditPlan";
import { loadAgentDocument } from "./agentInspection";
import {
	prepareAgentPreview,
	publishAgentPreviewFrame,
	renderAgentPreview,
	verifyAgentPreviewReference,
} from "./agentPreview";

const directories: string[] = [];
afterEach(async () => {
	for (const dir of directories.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});
function fixture(duration = 24) {
	return documentSchema.parse({
		...createEmptyDocument({ projectId: "p", title: "Preview" }),
		assets: [
			{
				id: "a",
				kind: "video",
				label: "Screen",
				originalPath: "/test/screen.mp4",
				durationSec: duration,
				video: { width: 1920, height: 1080, fps: 30 },
				cameraTrack: { sourcePath: "/test/camera.mp4", offsetMs: 500 },
			},
		],
		timeline: {
			clips: [
				{
					id: "c",
					assetId: "a",
					sourceStartSec: 0,
					sourceEndSec: duration,
					timelineStartSec: 0,
					timelineEndSec: duration,
					origin: "user",
				},
			],
		},
		legacyEditor: { aspectRatio: "16:9" },
	});
}
async function setup() {
	const dir = await fs.mkdtemp("/tmp/kap-");
	directories.push(dir);
	const project = path.join(dir, "project with spaces.klippt");
	await fs.writeFile(project, JSON.stringify(fixture()));
	const loaded = await loadAgentDocument(project);
	return { dir, project, hash: loaded.snapshot.sha256 };
}
const fakeRenderer = () =>
	vi.fn(async (_executable: string, args: string[], _timeoutMs: number) => {
		const header = Buffer.alloc(24);
		Buffer.from("89504e470d0a1a0a", "hex").copy(header);
		header.writeUInt32BE(1280, 16);
		header.writeUInt32BE(720, 20);
		await fs.writeFile(args[args.indexOf("--out") + 1], header);
	});

describe("bounded composed agent preview", () => {
	it("keeps camera offsets, clip source spans, zooms, and annotations while changing only preview resolution", () => {
		const doc = prepareAgentEditPlan(fixture(), [
			{ type: "addZoom", args: { startSec: 2, endSec: 4 } },
			{ type: "addAnnotation", args: { startSec: 3, endSec: 5, text: "Evidence" } },
		]).candidate;
		const before = JSON.stringify(doc);
		const prepared = prepareAgentPreview(doc, 3.141);
		expect(prepared.output).toEqual({ width: 1280, height: 720 });
		expect(prepared.frameTime).toBe(188 / 60);
		for (const key of ["assets", "timeline", "zoomRanges", "annotations"] as const)
			expect(prepared.document[key]).toEqual(doc[key]);
		expect(JSON.stringify(doc)).toBe(before);
	});
	it("accepts a late frame in a 14-minute project and rejects invalid inputs", () => {
		expect(prepareAgentPreview(fixture(840), 839).duration).toBe(840);
		expect(() => prepareAgentPreview(fixture(), 24)).toThrow("TIME_OUTSIDE");
		expect(() => prepareAgentPreview(fixture(), 1, 1920)).toThrow("INPUT_INVALID");
		const doc = fixture();
		doc.timeline.clips[0].sourceEndSec = undefined;
		expect(() => prepareAgentPreview(doc, 0)).toThrow("Explicit clip endpoints");
	});
	it("uses shared trim-aware edited duration", () => {
		const doc = prepareAgentEditPlan(fixture(), [
			{ type: "addTrim", args: { clipId: "c", startSec: 1, endSec: 3 } },
		]).candidate;
		expect(prepareAgentPreview(doc, 21).duration).toBe(22);
		expect(() => prepareAgentPreview(doc, 22)).toThrow("TIME_OUTSIDE");
	});
	it("runs only trusted executables with argument arrays and leaves PNG plus a compact manifest", async () => {
		const s = await setup();
		const run = fakeRenderer();
		const result = await renderAgentPreview(
			{
				projectPath: s.project,
				snapshot: s.hash,
				outputDirectory: s.dir,
				time: 3,
				launch: { executable: "/trusted/electron", args: ["/app with spaces"] },
			},
			{ run },
		);
		expect(run.mock.calls[0][0]).toBe("/trusted/electron");
		expect(run.mock.calls[0][1].slice(0, 2)).toEqual(["/app with spaces", "export"]);
		expect(run.mock.calls[0][2]).toBe(90000);
		expect(run).toHaveBeenCalledTimes(1);
		expect(run.mock.calls[0][1]).toContain("--agent-preview-time");
		expect(await fs.readdir(path.dirname(result.frame_path))).toEqual([
			"frame.png",
			"manifest.json",
		]);
		expect(result.snapshot).toBe(s.hash);
		expect(JSON.stringify(result).length).toBeLessThan(2500);
		expect((await loadAgentDocument(s.project)).snapshot.sha256).toBe(s.hash);
	});
	it("rejects a changed snapshot before spawning, and removes unpublished artifacts after a later change", async () => {
		const s = await setup();
		const run = fakeRenderer();
		const options = {
			projectPath: s.project,
			snapshot: "b".repeat(64),
			outputDirectory: s.dir,
			time: 1,
			launch: { executable: "/trusted/app", args: [] },
		};
		await expect(renderAgentPreview(options, { run })).rejects.toThrow("SNAPSHOT_CHANGED");
		expect(run).not.toHaveBeenCalled();
		const changedRun = async (executable: string, args: string[], timeout: number) => {
			await run(executable, args, timeout);
			await fs.writeFile(s.project, JSON.stringify(fixture(23)));
		};
		await expect(
			renderAgentPreview({ ...options, snapshot: s.hash }, { run: changedRun }),
		).rejects.toThrow("SNAPSHOT_CHANGED");
		expect(await fs.readdir(s.dir)).toEqual([path.basename(s.project)]);
	});
	it("binds a derived preview to original bytes and permits only the computed resolution change", async () => {
		const s = await setup();
		const original = await loadAgentDocument(s.project);
		const candidate = prepareAgentPreview(original.document, 0).document;
		const derived = path.join(s.dir, "derived.klippt");
		await fs.writeFile(derived, JSON.stringify(candidate));
		const reference = { projectPath: s.project, snapshot: s.hash, maxDimension: 1280 };
		expect(await verifyAgentPreviewReference(derived, reference)).toMatch(/^[a-f0-9]{64}$/);
		await expect(
			verifyAgentPreviewReference(derived, { ...reference, snapshot: "b".repeat(64) }),
		).rejects.toThrow("SNAPSHOT_CHANGED");
		candidate.assets[0].originalPath = "/unauthorized/other.mp4";
		await fs.writeFile(derived, JSON.stringify(candidate));
		await expect(verifyAgentPreviewReference(derived, reference)).rejects.toThrow(
			"REFERENCE_MISMATCH",
		);
	});
});

it("publishes only a verified PNG with expected dimensions, without overwriting files", async () => {
	const s = await setup();
	const loaded = await loadAgentDocument(s.project);
	const derived = path.join(s.dir, "derived.klippt");
	await fs.writeFile(derived, JSON.stringify(prepareAgentPreview(loaded.document, 3).document));
	const reference = {
		projectPath: s.project,
		snapshot: s.hash,
		maxDimension: 1280,
		time: 3,
		verifiedDocumentHash: "",
	};
	reference.verifiedDocumentHash = await verifyAgentPreviewReference(derived, reference);
	const output = path.join(s.dir, "frame.png");
	const png = Buffer.alloc(24);
	Buffer.from("89504e470d0a1a0a", "hex").copy(png);
	png.writeUInt32BE(1280, 16);
	png.writeUInt32BE(720, 20);
	const data = `data:image/png;base64,${png.toString("base64")}`;
	await expect(publishAgentPreviewFrame(derived, reference, output, "bad")).rejects.toThrow(
		"INVALID_FRAME",
	);
	await publishAgentPreviewFrame(derived, reference, output, data);
	await expect(publishAgentPreviewFrame(derived, reference, output, data)).rejects.toThrow(
		"EEXIST",
	);
	await fs.writeFile(s.project, JSON.stringify(fixture(23)));
	await expect(publishAgentPreviewFrame(derived, reference, output, data)).rejects.toThrow(
		"SNAPSHOT_CHANGED",
	);
});
