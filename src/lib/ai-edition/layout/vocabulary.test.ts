import { describe, expect, it } from "vitest";
import { createEmptyDocument, documentSchema, migrateRawDocumentToCurrent } from "../schema";
import {
	anchorPosition,
	CAMERA_ANCHORS,
	CAMERA_SIZES,
	nearestAnchor,
	nearestSize,
	resolveClipEditorSettings,
	sizePercent,
} from "./vocabulary";

const document = () => createEmptyDocument({ title: "Layout", projectId: "p" });

describe("layout vocabulary", () => {
	it.each(CAMERA_ANCHORS)("round trips %s with a safe margin", (name) => {
		const position = anchorPosition(
			name,
			{ width: 1920, height: 1080 },
			{ width: 280, height: 210 },
		);
		expect(nearestAnchor(position)).toBe(name);
		if (name === "bottom-right") {
			expect(1920 * position.cx + 140).toBeCloseTo(1920 - 43.2);
			expect(1080 * position.cy + 105).toBeCloseTo(1080 - 43.2);
		}
	});
	it.each(Object.entries(CAMERA_SIZES))("round trips size %s", (name, percent) => {
		expect(nearestSize(percent)).toBe(name);
		expect(sizePercent(percent)).toBe(percent);
	});
	it("resolves named sizes and a portrait safe margin against the real camera box", () => {
		const doc = document();
		doc.legacyEditor = {
			aspectRatio: "9:16",
			outputResolution: { width: 1080, height: 1920 },
			safeMarginPercent: 8,
		};
		doc.clipLayouts = { c: { cameraAnchor: "top-left", cameraSize: "L", cameraShape: "circle" } };
		const settings = resolveClipEditorSettings(doc, "c");
		expect(settings.webcamSizePreset).toBe(34);
		expect(settings.webcamMaskShape).toBe("circle");
		expect(settings.webcamPosition?.cx).toBeGreaterThan(0.08);
		expect(settings.webcamPosition?.cy).toBeLessThan(settings.webcamPosition?.cx ?? 0);
	});
	it("keeps numeric positions and percentages exact", () => {
		const doc = document();
		doc.clipLayouts = { c: { cameraAnchor: { cx: 0.12, cy: 0.67 }, cameraSize: 31 } };
		expect(resolveClipEditorSettings(doc, "c")).toMatchObject({
			webcamPosition: { cx: 0.12, cy: 0.67 },
			webcamSizePreset: 31,
		});
	});
	it("normalizes old documents without introducing overrides or changing legacy settings", () => {
		const old = document();
		old.legacyEditor = { webcamSizePreset: 23, webcamPosition: { cx: 0.71, cy: 0.82 } };
		expect(documentSchema.parse(migrateRawDocumentToCurrent(old))).toEqual(old);
		expect(documentSchema.parse(old).clipLayouts).toBeUndefined();
	});
	it("preserves overrides through normalization and rejects invalid fields", () => {
		const doc = { ...document(), clipLayouts: { c: { cameraSize: "XL", captions: false } } };
		expect(documentSchema.parse(migrateRawDocumentToCurrent(doc)).clipLayouts).toEqual(
			doc.clipLayouts,
		);
		for (const layout of [
			{ cameraSize: 81 },
			{ cameraAnchor: "middle" },
			{ captions: "off" },
			{ unknown: 2 },
		]) {
			expect(documentSchema.safeParse({ ...doc, clipLayouts: { c: layout } }).success).toBe(false);
		}
	});
});
