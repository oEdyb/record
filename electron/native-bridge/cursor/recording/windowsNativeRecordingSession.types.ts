import type { Rectangle } from "electron";
import type { NativeCursorType } from "../../../../src/native/contracts";

interface WindowsCursorSampleEvent {
	type: "sample";
	timestampMs: number;
	x: number;
	y: number;
	visible: boolean;
	handle: string | null;
	cursorType?: NativeCursorType | null;
	leftButtonDown?: boolean;
	leftButtonPressed?: boolean;
	leftButtonReleased?: boolean;
	bounds?: {
		x: number;
		y: number;
		width: number;
		height: number;
	} | null;
	asset: WindowsCursorAssetPayload | null;
}

interface WindowsCursorReadyEvent {
	type: "ready";
	timestampMs: number;
}

interface WindowsCursorErrorEvent {
	type: "error";
	timestampMs: number;
	message: string;
}

interface WindowsCursorAssetPayload {
	id: string;
	imageDataUrl: string;
	width: number;
	height: number;
	hotspotX: number;
	hotspotY: number;
	cursorType?: NativeCursorType | null;
}

export type WindowsCursorEvent =
	| WindowsCursorSampleEvent
	| WindowsCursorReadyEvent
	| WindowsCursorErrorEvent;

export interface WindowsNativeRecordingSessionOptions {
	getDisplayBounds: () => Rectangle | null;
	maxSamples: number;
	sampleIntervalMs: number;
	sourceId?: string | null;
	startTimeMs?: number;
}
