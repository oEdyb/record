import { describe, expect, it } from "vitest";
import { audioAssetSchema, audioClipSchema } from "./audioOverlays";
import {
	createEmptyDocument,
	documentSchema,
	migrateRawDocumentToCurrent,
	upgradeV9DocumentToV10,
} from "./index";

const asset = {
	id: "music",
	label: "Original music",
	originalPath: "/audio/music.wav",
	durationSec: 12,
};
const clip = {
	id: "music-clip",
	assetId: "music",
	startSec: 5,
	endSec: 10,
	sourceOffsetSec: 2,
	gain: 0.2,
	fadeInSec: 1,
	fadeOutSec: 1,
};
function document(audioAssets = [asset], audioClips = [clip]) {
	const base = createEmptyDocument({ projectId: "audio-proof", title: "Audio proof" });
	return { ...base, audioAssets, timeline: { ...base.timeline, audioClips } };
}

describe("editable audio overlay schema", () => {
	it("stores explicit output-time placement and source offset without changing the source asset", () => {
		expect(documentSchema.parse(document()).timeline.audioClips).toEqual([clip]);
		expect(audioAssetSchema.parse(asset)).toEqual(asset);
	});
	it("rejects unknown properties, invalid ranges, gain and fades", () => {
		for (const invalid of [
			{ ...clip, endSec: 5 },
			{ ...clip, sourceOffsetSec: -1 },
			{ ...clip, gain: 4.01 },
			{ ...clip, gain: Number.NaN },
			{ ...clip, fadeInSec: 4, fadeOutSec: 2 },
			{ ...clip, path: "/arbitrary.wav" },
		])
			expect(() => audioClipSchema.parse(invalid)).toThrow();
		for (const invalid of [
			{ ...asset, durationSec: 0 },
			{ ...asset, durationSec: Infinity },
			{ ...asset, originalPath: "" },
			{ ...asset, hidden: true },
		])
			expect(() => audioAssetSchema.parse(invalid)).toThrow();
	});
	it("requires unique referenced assets and clips and sufficient source duration", () => {
		for (const invalid of [
			document([], [clip]),
			document([asset, asset]),
			document([asset], [clip, clip]),
			document([asset], [{ ...clip, sourceOffsetSec: 8 }]),
		])
			expect(() => documentSchema.parse(invalid)).toThrow();
		expect(() =>
			documentSchema.parse(document([asset], [{ ...clip, sourceOffsetSec: 7 }])),
		).not.toThrow();
	});
	it("upgrades v9 losslessly without inventing audio and is idempotent", () => {
		const { audioAssets: _audioAssets, ...current } = document();
		const { audioClips: _audioClips, ...timeline } = current.timeline;
		const old = { ...current, schemaVersion: 9, timeline };
		const bytes = JSON.stringify(old);
		const upgraded = upgradeV9DocumentToV10(old);
		expect(upgraded).toEqual({ ...old, schemaVersion: 10 });
		expect(JSON.stringify(old)).toBe(bytes);
		expect(upgradeV9DocumentToV10(upgraded)).toBe(upgraded);
		const parsed = documentSchema.parse(migrateRawDocumentToCurrent(old));
		expect(parsed.audioAssets ?? []).toEqual([]);
		expect(parsed.timeline.audioClips ?? []).toEqual([]);
		expect(() => documentSchema.parse(old)).toThrow();
	});
});
