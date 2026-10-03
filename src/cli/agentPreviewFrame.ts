import type { AxcutDocument } from "@/lib/ai-edition/schema";
import { getEditorSettings } from "@/lib/ai-edition/store/editorSettings";
import { buildExportTimeMap } from "@/lib/exporter/mp4ExportSettings";
import {
	createCompositorView,
	destroyCompositorView,
	readCompositorFrame,
	setCompositorParam,
	setCompositorScene,
	syncCompositorTransport,
} from "@/native/compositorViewClient";
import { pushAllNativeParams } from "@/native/nativeCompositorStore";
import { buildCompositorClipInputs, buildSceneDescription } from "@/native/sceneDescription";

/** Keep full scene indices and effect source times. Only seek the native decoder. */
export function locateAgentPreviewFrame(document: AxcutDocument, time: number) {
	const clips = buildCompositorClipInputs(document);
	const scene = buildSceneDescription(document);
	const spans = buildExportTimeMap(clips, scene.speedRegions);
	const duration = spans.at(-1)?.outputEndSec ?? 0;
	if (!Number.isFinite(time) || time < 0 || time >= duration)
		throw new Error("PREVIEW_TIME_OUTSIDE_PROJECT");
	const frameTime = Math.floor(time * 60) / 60;
	let remainingFrame = Math.floor(time * 60);
	let span = spans[0];
	let sourceTimeSec = 0;
	let found = false;
	for (const entry of spans) {
		const sourceDuration = entry.sourceEndSec - entry.sourceStartSec;
		const speed = sourceDuration / (entry.outputEndSec - entry.outputStartSec);
		// Exact regions.rs::push_speed_segment export frame quantization.
		const frameCount =
			sourceDuration <= 0.0001
				? 0
				: Math.max(0, Math.ceil(((sourceDuration - 0.001) / speed) * 60));
		if (remainingFrame < frameCount) {
			span = entry;
			sourceTimeSec = entry.sourceStartSec + (remainingFrame * speed) / 60;
			found = true;
			break;
		}
		remainingFrame -= frameCount;
	}
	if (!found) throw new Error("PREVIEW_TIME_OUTSIDE_PROJECT");
	return {
		clip: clips[span.clipIndex],
		clipIndex: span.clipIndex,
		sourceTimeSec,
		scene,
		frameTime,
	};
}

export async function captureAgentPreviewFrame(
	document: AxcutDocument,
	time: number,
	signal?: AbortSignal,
): Promise<string> {
	const target = locateAgentPreviewFrame(document, time);
	const output = getEditorSettings(document).outputResolution;
	if (
		!output ||
		Math.max(output.width, output.height) > 1280 ||
		Math.min(output.width, output.height) < 256
	)
		throw new Error("PREVIEW_INPUT_INVALID");
	const { id } = await createCompositorView(
		{ x: 0, y: 0, ...output },
		{
			screenPath: target.clip.screenPath,
			webcamPath: target.clip.webcamPath,
		},
	);
	try {
		const params: Promise<unknown>[] = [];
		pushAllNativeParams(getEditorSettings(document), (key, value) => {
			params.push(setCompositorParam(id, key, value));
		});
		await Promise.all(params);
		await setCompositorParam(id, "previewSourceTimeSec", target.sourceTimeSec);
		await setCompositorScene(id, JSON.stringify(target.scene));
		await syncCompositorTransport({
			id,
			generation: 1,
			playing: false,
			clipIndex: target.clipIndex,
			screenPath: target.clip.screenPath,
			webcamPath: target.clip.webcamPath,
			webcamOffsetSec: target.clip.webcamOffsetSec,
			sourceTimeSec: target.sourceTimeSec,
		});
		const deadline = performance.now() + 30_000;
		while (performance.now() < deadline) {
			if (signal?.aborted) throw new DOMException("Preview cancelled", "AbortError");
			const frame = await readCompositorFrame(id, 0);
			if (
				frame &&
				frame.transportGeneration === 1 &&
				frame.clipIndex === target.clipIndex &&
				Math.abs(frame.sourceTimeSec - target.sourceTimeSec) < 0.001 &&
				frame.width === output.width &&
				frame.height === output.height &&
				frame.data.byteLength === output.width * output.height * 4
			) {
				const canvas = globalThis.document.createElement("canvas");
				canvas.width = frame.width;
				canvas.height = frame.height;
				const context = canvas.getContext("2d");
				if (!context) throw new Error("PREVIEW_CANVAS_UNAVAILABLE");
				context.putImageData(
					new ImageData(new Uint8ClampedArray(frame.data), frame.width, frame.height),
					0,
					0,
				);
				return canvas.toDataURL("image/png");
			}
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		throw new Error("PREVIEW_TIMEOUT: Native compositor did not return the requested frame.");
	} finally {
		await destroyCompositorView(id);
	}
}
