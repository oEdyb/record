import {
	PipeWireCursorAccumulator,
	type PipeWireCursorAssetPayload,
} from "../native-bridge/cursor/recording/pipeWireCursorAccumulator";

function cursorAsset(value: unknown): PipeWireCursorAssetPayload | undefined {
	if (!value || typeof value !== "object") return undefined;
	if (
		!(
			"id" in value &&
			"imageDataUrl" in value &&
			"width" in value &&
			"height" in value &&
			"hotspotX" in value &&
			"hotspotY" in value
		)
	)
		return undefined;
	if (
		typeof value.id !== "string" ||
		typeof value.imageDataUrl !== "string" ||
		typeof value.width !== "number" ||
		typeof value.height !== "number" ||
		typeof value.hotspotX !== "number" ||
		typeof value.hotspotY !== "number"
	)
		return undefined;
	return {
		id: value.id,
		imageDataUrl: value.imageDataUrl,
		width: value.width,
		height: value.height,
		hotspotX: value.hotspotX,
		hotspotY: value.hotspotY,
	};
}

/** Linux telemetry shares the video helper's portal session and wall-clock timeline. */
export class LinuxClipCaptureMetadata {
	readonly cursor: PipeWireCursorAccumulator;
	sourceKind: "monitor" | "window" | "virtual" | undefined;
	videoEncoder: string | undefined;
	pipeWireNodeId: number | undefined;

	constructor(maxSamples: number, startTimeMs: number) {
		this.cursor = new PipeWireCursorAccumulator(maxSamples);
		this.cursor.reset(startTimeMs);
	}

	observe(event: Record<string, unknown>): void {
		if (event.event === "source-reselected") this.pipeWireNodeId = undefined;
		if (event.event === "source-selected" || event.event === "stream-started") {
			this.pipeWireNodeId =
				typeof event.nodeId === "number" &&
				Number.isInteger(event.nodeId) &&
				event.nodeId >= 0 &&
				event.nodeId <= 0xffff_ffff
					? event.nodeId
					: undefined;
		}
		if (
			event.sourceKind === "monitor" ||
			event.sourceKind === "window" ||
			event.sourceKind === "virtual"
		)
			this.sourceKind = event.sourceKind;
		if (event.event === "encoder-selection" && typeof event.video === "string") {
			this.videoEncoder = event.video;
			console.info("[capture-linux] encoder", JSON.stringify(event));
		}
		if (event.event === "audio-source")
			console.info("[capture-linux] audio source", JSON.stringify(event));
		if (
			event.event !== "cursor-sample" ||
			typeof event.timestampMs !== "number" ||
			typeof event.x !== "number" ||
			typeof event.y !== "number" ||
			typeof event.width !== "number" ||
			typeof event.height !== "number" ||
			typeof event.visible !== "boolean"
		)
			return;
		if (
			![event.timestampMs, event.x, event.y, event.width, event.height].every(Number.isFinite) ||
			event.width <= 0 ||
			event.height <= 0
		)
			return;
		this.cursor.addSample({
			event: "cursor-sample",
			timestampMs: event.timestampMs,
			x: event.x,
			y: event.y,
			width: event.width,
			height: event.height,
			visible: event.visible,
			...(typeof event.assetId === "string" ? { assetId: event.assetId } : {}),
			asset: cursorAsset(event.asset),
		});
	}
}
