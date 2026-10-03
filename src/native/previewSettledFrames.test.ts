import { afterEach, describe, expect, it, vi } from "vitest";
import {
	getPreviewFrameEvidence,
	isPreviewFrameSettled,
	notePreviewPaintedFrame,
	notePreviewTransportAnchor,
	resetPreviewSettledFrames,
	waitForPreviewSettledFrame,
} from "./previewSettledFrames";

const anchor = { viewId: 1, generation: 3, clipIndex: 2, sourceTimeSec: 154.5 };
const painted = {
	viewId: 1,
	transportGeneration: 3,
	clipIndex: 2,
	sourceTimeSec: 154.5,
};

afterEach(() => {
	resetPreviewSettledFrames();
	vi.useRealTimers();
});

describe("previewSettledFrames", () => {
	it("cannot prove freshness without an anchor", () => {
		expect(isPreviewFrameSettled()).toBe(false);
	});

	it("is unsettled after an anchor until a frame painted under it arrives", () => {
		notePreviewTransportAnchor(anchor);
		expect(isPreviewFrameSettled()).toBe(false);
		notePreviewPaintedFrame({ ...painted, transportGeneration: 2 });
		expect(isPreviewFrameSettled()).toBe(false);
		notePreviewPaintedFrame({ ...painted, clipIndex: 1 });
		expect(isPreviewFrameSettled()).toBe(false);
		notePreviewPaintedFrame(painted);
		expect(isPreviewFrameSettled()).toBe(true);
	});

	it("resolves an outstanding wait when the matching frame is painted", async () => {
		notePreviewTransportAnchor(anchor);
		let settled: boolean | null = null;
		const waiting = waitForPreviewSettledFrame(1000).then((value) => {
			settled = value;
		});
		notePreviewPaintedFrame({ ...painted, transportGeneration: 1 });
		await Promise.resolve();
		expect(settled).toBeNull();
		notePreviewPaintedFrame(painted);
		await waiting;
		expect(settled).toBe(true);
	});

	it("resolves immediately when the canvas already shows the anchored frame", async () => {
		notePreviewTransportAnchor(anchor);
		notePreviewPaintedFrame(painted);
		await expect(waitForPreviewSettledFrame(1000)).resolves.toBe(true);
	});

	it("resolves false when the budget expires without a matching frame", async () => {
		vi.useFakeTimers();
		notePreviewTransportAnchor(anchor);
		let settled: boolean | null = null;
		const waiting = waitForPreviewSettledFrame(500).then((value) => {
			settled = value;
		});
		await vi.advanceTimersByTimeAsync(499);
		expect(settled).toBeNull();
		await vi.advanceTimersByTimeAsync(1);
		await waiting;
		expect(settled).toBe(false);
	});

	it("a newer anchor re-arms an outstanding wait", async () => {
		vi.useFakeTimers();
		notePreviewTransportAnchor(anchor);
		let settled: boolean | null = null;
		const waiting = waitForPreviewSettledFrame(500).then((value) => {
			settled = value;
		});
		notePreviewTransportAnchor({ ...anchor, generation: 4 });
		notePreviewPaintedFrame(painted);
		await Promise.resolve();
		expect(settled).toBeNull();
		notePreviewPaintedFrame({ ...painted, transportGeneration: 4 });
		await waiting;
		expect(settled).toBe(true);
	});
});

it("does not accept the previous settled frame before React announces a seek", async () => {
	notePreviewTransportAnchor(anchor);
	notePreviewPaintedFrame(painted);
	const expected = { viewId: 1, clipIndex: 2, sourceTimeSec: 159 };
	let settled: boolean | null = null;
	const waiting = waitForPreviewSettledFrame(500, expected).then((value) => {
		settled = value;
	});
	await Promise.resolve();
	expect(settled).toBeNull();
	notePreviewTransportAnchor({ ...expected, generation: 4 });
	notePreviewPaintedFrame(painted);
	await Promise.resolve();
	expect(settled).toBeNull();
	notePreviewPaintedFrame({ ...expected, viewId: 2, transportGeneration: 4 });
	await Promise.resolve();
	expect(settled).toBeNull();
	notePreviewPaintedFrame({ ...expected, transportGeneration: 4 });
	await waiting;
	expect(settled).toBe(true);
	await expect(waitForPreviewSettledFrame(500, expected)).resolves.toBe(true);
});
it("cancels pending proof when the native view changes", async () => {
	notePreviewTransportAnchor(anchor);
	const waiting = waitForPreviewSettledFrame(500, anchor);
	resetPreviewSettledFrames();
	await expect(waiting).resolves.toBe(false);
});

it("rejects a one-frame seek before its new anchor, and changed scenes at the same time", () => {
	const scene = {};
	notePreviewTransportAnchor({ ...anchor, sceneIdentity: scene });
	notePreviewPaintedFrame(painted);
	expect(
		isPreviewFrameSettled({
			...anchor,
			sourceTimeSec: anchor.sourceTimeSec + 1 / 60,
			sceneIdentity: scene,
		}),
	).toBe(false);
	expect(isPreviewFrameSettled({ ...anchor, sceneIdentity: {} })).toBe(false);
	expect(isPreviewFrameSettled({ ...anchor, sceneIdentity: scene })).toBe(true);
});

it("reports the painted timestamp without exposing scene objects or inventing a frame", () => {
	expect(getPreviewFrameEvidence()).toBeNull();
	notePreviewTransportAnchor({ ...anchor, sceneIdentity: {} });
	expect(getPreviewFrameEvidence()).toBeNull();
	notePreviewPaintedFrame({ ...painted, sourceTimeSec: 154.499, sceneIdentity: {} });
	expect(getPreviewFrameEvidence()).toEqual({
		timeBase: "source",
		viewId: 1,
		clipIndex: 2,
		sourceTimeSec: 154.499,
		generation: 3,
	});
	resetPreviewSettledFrames();
	expect(getPreviewFrameEvidence()).toBeNull();
});
