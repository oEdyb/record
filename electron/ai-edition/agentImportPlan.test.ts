import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createEmptyDocument, documentSchema } from "../../src/lib/ai-edition/schema";

const decode = vi.hoisted(() => vi.fn());
vi.mock("electron", () => ({ nativeImage: { createFromBuffer: decode } }));

import { agentImportMediaSchema, imageHeader, prepareAgentImportPlan } from "./agentImportPlan";
import { canonicalTransactionPayload, ProjectTransactionStore } from "./projectTransactions";

let directory: string;
const png = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=",
	"base64",
);
const placement = {
	startSec: 1,
	endSec: 3,
	position: { x: 50, y: 50 },
	size: { width: 20, height: 30 },
};
function fixture() {
	const doc = createEmptyDocument({ projectId: "import_project", title: "Import" });
	doc.assets = [
		{
			id: "video",
			kind: "video",
			label: "Video",
			originalPath: "/tmp/video.mp4",
			cameraTrack: null,
			durationSec: 10,
		},
	];
	doc.timeline.clips = [
		{
			id: "clip",
			assetId: "video",
			sourceStartSec: 0,
			sourceEndSec: 10,
			timelineStartSec: 0,
			timelineEndSec: 10,
			origin: "user",
			reason: "test",
			wordRefs: [],
		},
	];
	return documentSchema.parse(doc);
}
beforeEach(async () => {
	directory = await fs.mkdtemp(path.join(os.tmpdir(), "klippt-import-plan-"));
	decode.mockReset();
	decode.mockReturnValue({ isEmpty: () => false, getSize: () => ({ width: 1, height: 1 }) });
});
afterEach(async () => {
	await fs.rm(directory, { recursive: true, force: true });
});
const dependencies = { prepareAudioAsset: vi.fn(), approveSelectedMedia: vi.fn() };
it("reads image bytes only into the candidate and leaves source and base unchanged", async () => {
	const file = path.join(directory, "overlay.png");
	await fs.writeFile(file, png);
	const base = fixture();
	const original = JSON.stringify(base);
	const prepared = await prepareAgentImportPlan(
		base,
		{ kind: "image", path: file, placement },
		dependencies,
	);
	expect(prepared.candidate.annotations).toHaveLength(1);
	expect(prepared.candidate.annotations[0]).toMatchObject({
		type: "image",
		position: placement.position,
		size: placement.size,
	});
	expect(prepared.candidate.annotations[0].imageContent).toMatch(/^data:image\/png;base64,/);
	expect(JSON.stringify(prepared.results)).not.toContain("base64");
	expect(JSON.stringify(base)).toBe(original);
	expect(await fs.readFile(file)).toEqual(png);
});
it("commits the in-memory image plan through renderer parsing with receipt and Undo recovery", async () => {
	const file = path.join(directory, "overlay.png");
	await fs.writeFile(file, png);
	const base = fixture();
	const prepared = await prepareAgentImportPlan(
		base,
		{ kind: "image", path: file, placement },
		dependencies,
	);
	// The broker sends this in-memory object. A JSON round trip here would hide
	// explicit undefined fields that Electron structured clone preserves.
	const rendererDocument = documentSchema.parse(structuredClone(prepared.candidate));
	const mainDocument = documentSchema.parse(structuredClone(rendererDocument));
	const managed = path.join(directory, "project.klippt");
	await fs.writeFile(managed, JSON.stringify(base));
	const store = new ProjectTransactionStore(managed);
	const request = {
		requestId: "image-import",
		expected: (await store.read()).version,
		payload: { projectId: base.project.id, document: mainDocument },
		recordUndo: true,
	};
	const receipt = await store.commit(request, () => mainDocument);
	expect(receipt.changed).toBe(true);
	expect(await store.receipt(request.requestId)).toEqual(receipt);
	const saved = await store.read();
	expect(saved.document.annotations[0]).toMatchObject({
		type: "image",
		imageContent: mainDocument.annotations[0].imageContent,
	});
	expect(saved.undoRecovery?.beforeDocument.annotations).toEqual([]);
	expect(canonicalTransactionPayload(saved.document)).toBe(
		canonicalTransactionPayload(mainDocument),
	);
	expect(() => canonicalTransactionPayload({ textContent: undefined })).toThrow();
	expect(() => canonicalTransactionPayload({ position: { x: Infinity } })).toThrow();
});
it("rejects unsupported content, decode failure, oversized files and pixel bombs", async () => {
	const file = path.join(directory, "overlay.png");
	await fs.writeFile(file, "<svg />");
	await expect(
		prepareAgentImportPlan(fixture(), { kind: "image", path: file, placement }, dependencies),
	).rejects.toThrow("INVALID_IMAGE");
	await fs.writeFile(file, Buffer.alloc(512 * 1024 + 1));
	await expect(
		prepareAgentImportPlan(fixture(), { kind: "image", path: file, placement }, dependencies),
	).rejects.toThrow("IMAGE_TOO_LARGE");
	const bomb = Buffer.from(png);
	bomb.writeUInt32BE(100000, 16);
	await fs.writeFile(file, bomb);
	await expect(
		prepareAgentImportPlan(fixture(), { kind: "image", path: file, placement }, dependencies),
	).rejects.toThrow("IMAGE_DIMENSIONS");
	expect(decode).not.toHaveBeenCalled();
	await fs.writeFile(file, png);
	decode.mockReturnValue({ isEmpty: () => true });
	await expect(
		prepareAgentImportPlan(fixture(), { kind: "image", path: file, placement }, dependencies),
	).rejects.toThrow("decoder rejected");
});
it("adds prepared audio asset and clip to one candidate with both IDs in the diff", async () => {
	dependencies.approveSelectedMedia.mockResolvedValue("/selected/music.wav");
	dependencies.prepareAudioAsset.mockResolvedValue({
		id: "audio_new",
		label: "Music",
		originalPath: "/selected/music.wav",
		durationSec: 12,
	});
	const base = fixture();
	const prepared = await prepareAgentImportPlan(
		base,
		{
			kind: "audio",
			path: "/selected/music.wav",
			placement: { startSec: 2, endSec: 8, sourceOffsetSec: 1 },
		},
		dependencies,
	);
	expect(prepared.candidate.audioAssets).toHaveLength(1);
	expect(prepared.candidate.timeline.audioClips?.[0]).toMatchObject({
		assetId: "audio_new",
		startSec: 2,
		endSec: 8,
		sourceOffsetSec: 1,
		gain: 1,
	});
	expect(prepared.changed_ids).toContain("audio_new");
	expect(prepared.changed_count).toBe(2);
	expect(base.audioAssets).toBeUndefined();
	await expect(
		prepareAgentImportPlan(
			base,
			{ kind: "audio", path: "/selected/music.wav", placement: { startSec: 0, endSec: 20 } },
			dependencies,
		),
	).rejects.toThrow();
});
it("requires explicit absolute paths and supported import kinds", () => {
	expect(
		agentImportMediaSchema.safeParse({ kind: "video", path: "/tmp/video.mp4", placement: {} })
			.success,
	).toBe(false);
	expect(
		agentImportMediaSchema.safeParse({ kind: "image", path: "relative.png", placement }).success,
	).toBe(false);
	expect(imageHeader(png)).toEqual({ mime: "png", width: 1, height: 1 });
});
it("imports a video as an asset plus an anchored overlay, and needs both position and size", async () => {
	dependencies.approveSelectedMedia.mockResolvedValue("/selected/broll.mp4");
	const prepareVideoAsset = vi.fn(async () => ({
		id: "asset_broll",
		kind: "video" as const,
		label: "broll.mp4",
		originalPath: "/selected/broll.mp4",
		durationSec: 20,
		cameraTrack: null,
	}));
	const base = fixture();
	const prepared = await prepareAgentImportPlan(
		base,
		{
			kind: "video",
			path: "/selected/broll.mp4",
			placement: { startSec: 2, endSec: 8, sourceOffsetSec: 1, fit: "contain" },
		},
		{ ...dependencies, prepareVideoAsset },
	);
	expect(prepared.candidate.assets.map((asset) => asset.id)).toEqual(["video", "asset_broll"]);
	expect(prepared.candidate.videoOverlays?.[0]).toMatchObject({
		assetId: "asset_broll",
		startMs: 2000,
		endMs: 8000,
		sourceOffsetSec: 1,
		fit: "contain",
		placement: null,
		clipId: "clip",
	});
	expect(prepared.changed_ids).toContain("asset_broll");
	expect(prepared.results[0]).toEqual({
		type: "import-video",
		result: { assetId: "asset_broll", durationSec: 20 },
	});
	expect(base.videoOverlays ?? []).toHaveLength(0);
	await expect(
		prepareAgentImportPlan(
			base,
			{
				kind: "video",
				path: "/selected/broll.mp4",
				placement: { startSec: 2, endSec: 8, position: { x: 10, y: 10 } },
			},
			{ ...dependencies, prepareVideoAsset },
		),
	).rejects.toThrow(/INVALID_INPUT/);
	await expect(
		prepareAgentImportPlan(
			base,
			{ kind: "video", path: "/selected/broll.mp4", placement: { startSec: 0, endSec: 25 } },
			{ ...dependencies, prepareVideoAsset },
		),
	).rejects.toThrow(/INVALID_RANGE/);
});
