import type { CleanVoiceRoute } from "@/lib/cleanVoiceRuntime";
import { webcamSizeToFraction } from "@/lib/compositeLayout";
import { resolveScreenFraming, screenFramingVariantKey } from "@/lib/screenFraming";
import { buildCompositorClipInputs } from "@/native/sceneDescription";
import { getCaptionSettings } from "../captions";
import type { ResolvedEdit, Span } from "../checks/context";
import { nearestAnchor, nearestSize, resolveClipEditorSettings } from "../layout/vocabulary";
import type { ClipLayoutOverride } from "../schema";
import { playbackTimeToRawTime, resolveNativePosition } from "../timeline/timelineMap";

export interface StateRequest {
	at?: number;
	clipId?: string;
	range?: Span;
}
export function projectValue<T>(value: T): { value: T; layer: "project" } {
	return { value, layer: "project" };
}

export function resolveEffectiveState(
	context: ResolvedEdit,
	at: number,
	routes: ReadonlyMap<string, CleanVoiceRoute> = new Map(),
) {
	if (!Number.isFinite(at) || at < 0 || at > context.durationSec)
		throw new Error("Time must be inside the edited timeline.");
	const raw = playbackTimeToRawTime(at, context.projection);
	const position = resolveNativePosition(raw, context.visible, context.document.timeline.clips);
	const fragment = position ? context.fragments[position.clipIndex] : null;
	const layout = context.scene.layout;
	const resolved = position ? layout.layoutByClip?.[position.clipIndex] : null;
	const clip = context.document.timeline.clips.find((item) => item.id === fragment?.clip);
	const overrides = clip ? context.document.clipLayouts?.[clip.id] : undefined;
	const settings = clip ? resolveClipEditorSettings(context.document, clip.id) : context.settings;
	const layoutValue = <T>(value: T, ...keys: (keyof ClipLayoutOverride)[]) => ({
		value,
		layer:
			clip && keys.some((key) => overrides?.[key] !== undefined)
				? (`clip:${clip.id}` as const)
				: ("project" as const),
	});
	const cameraPosition = resolved?.webcamRect
		? {
				cx: resolved.webcamRect.x + resolved.webcamRect.width / 2,
				cy: resolved.webcamRect.y + resolved.webcamRect.height / 2,
			}
		: null;
	const cameraGeometryKeys = [
		"cameraAnchor",
		"cameraSize",
		"cameraShape",
		"cameraLayoutPreset",
	] as const;
	const sizeName = nearestSize(settings.webcamSizePreset);
	const screenFraming = resolveScreenFraming(
		settings.screenFramingByVariant,
		screenFramingVariantKey(settings.aspectRatio, settings.outputResolution),
	);
	const asset = context.assets.find((item) => item.id === clip?.assetId);
	const active = (span: Span) => at >= span.startSec && at < span.endSec;
	const regions = context.regions
		.filter(
			(region) =>
				position &&
				region.clipIndex === position.clipIndex &&
				position.sourceTimeSec >= region.source.startSec &&
				position.sourceTimeSec < region.source.endSec,
		)
		.map((region) => ({
			...region,
			remainingSec: Math.max(0, region.edited.endSec - at),
		}));
	const previous = [...context.cuts].reverse().find((cut) => cut.at <= at);
	const next = context.cuts.find((cut) => cut.at > at);
	const audioClip = position
		? buildCompositorClipInputs(context.document, routes)[position.clipIndex]
		: null;
	return {
		editedTimeSec: at,
		rawTimeSec: raw,
		sourceTimeSec: position?.sourceTimeSec ?? null,
		clip: projectValue(
			clip
				? {
						id: clip.id,
						name: asset?.label ?? clip.id,
						assetId: clip.assetId,
						fragmentIndex: position?.clipIndex,
					}
				: null,
		),
		cuts: {
			previous: previous ? { at: previous.at, distanceSec: at - previous.at } : null,
			next: next ? { at: next.at, distanceSec: next.at - at } : null,
		},
		layout: {
			geometryScope: projectValue("scene base; active region transforms are listed in regions"),
			cameraMode: layoutValue(
				regions.find((region) => region.kind === "camera" && region.name === "Full camera")
					? "fullscreen"
					: regions.some((region) => region.kind === "camera")
						? "emphasis"
						: "preset",
				...(regions.some((region) => region.kind === "camera")
					? []
					: (["cameraLayoutPreset"] as const)),
			),
			cameraPreset: layoutValue(
				resolved?.webcamRect ? settings.webcamLayoutPreset : "no-webcam",
				"cameraLayoutPreset",
			),
			cameraAnchor: {
				...layoutValue(cameraPosition ? nearestAnchor(cameraPosition) : null, "cameraAnchor"),
				position: cameraPosition,
			},
			cameraPosition: layoutValue(cameraPosition, ...cameraGeometryKeys),
			cameraSizePreset: {
				...layoutValue(settings.webcamSizePreset, "cameraSize"),
				name: sizeName,
			},
			cameraSize: {
				...layoutValue(sizeName, "cameraSize"),
				percent: settings.webcamSizePreset,
				fraction: webcamSizeToFraction(settings.webcamSizePreset),
			},
			cameraShape: layoutValue(
				resolved?.webcamShape ?? layout.webcamShape,
				"cameraShape",
				"cameraLayoutPreset",
			),
			cameraBaseRect: layoutValue(resolved?.webcamRect ?? null, ...cameraGeometryKeys),
			screenFraming: layoutValue(
				{
					rect: resolved?.screenRect ?? layout.screenRect,
					cover: resolved?.screenCover ?? layout.screenCover,
					zoom: screenFraming.scale,
					focalPoint: screenFraming.focalPoint,
					crop: position ? (context.scene.cropByClip?.[position.clipIndex] ?? null) : null,
				},
				"screenFraming",
				"cameraLayoutPreset",
			),
			captions: layoutValue(
				overrides?.captions ?? getCaptionSettings(context.document).enabled,
				"captions",
			),
		},
		regions,
		audio: projectValue({
			sourcePath: audioClip?.screenPath ?? null,
			cleanMicrophonePath: audioClip?.cleanMicrophonePath ?? null,
			microphone: {
				volume: context.settings.microphoneVolume,
				muted: context.settings.microphoneMuted,
			},
			system: {
				volume: context.settings.systemAudioVolume,
				muted: context.settings.systemAudioMuted,
			},
			overlays: (context.scene.audioOverlays ?? []).filter(active),
			delivery: {
				preset: context.settings.audioDeliveryPreset,
				targetLufs: context.settings.audioTargetLufs,
				peakCeilingDbtp: context.settings.audioPeakCeilingDbtp,
			},
		}),
	};
}

export function resolveStateReport(
	context: ResolvedEdit,
	request: StateRequest,
	routes?: ReadonlyMap<string, CleanVoiceRoute>,
) {
	if ((request.at === undefined) === (request.clipId === undefined))
		throw new Error("Provide exactly one state time or clip ID.");
	const at =
		request.at ??
		context.fragments.find((fragment) => fragment.clip === request.clipId)?.edited.startSec;
	if (at === undefined) throw new Error(`Clip ${request.clipId} has no kept footage.`);
	const state = resolveEffectiveState(context, at, routes);
	const range = request.range;
	if (
		range &&
		(!Number.isFinite(range.startSec) ||
			!Number.isFinite(range.endSec) ||
			range.startSec < 0 ||
			range.endSec > context.durationSec ||
			range.endSec <= range.startSec)
	)
		throw new Error("Range must be inside the edited timeline.");
	const boundaries = range
		? [
				...new Set([
					range.startSec,
					range.endSec,
					...context.fragments.flatMap((fragment) => [
						fragment.edited.startSec,
						fragment.edited.endSec,
					]),
					...context.regions.flatMap((region) => [region.edited.startSec, region.edited.endSec]),
					...(context.scene.audioOverlays ?? []).flatMap((overlay) => [
						overlay.startSec,
						overlay.endSec,
					]),
				]),
			]
				.filter((time) => time >= range.startSec && time <= range.endSec)
				.sort((a, b) => a - b)
		: [];
	return {
		projectId: context.document.project.id,
		durationSec: context.durationSec,
		timeBase: "edited seconds, trim-compressed transport clock",
		state,
		spans: boundaries.slice(0, -1).map((startSec, index) => ({
			span: { startSec, endSec: boundaries[index + 1] },
			...resolveEffectiveState(context, startSec, routes),
		})),
	};
}
export type StateResult = ReturnType<typeof resolveStateReport>;
