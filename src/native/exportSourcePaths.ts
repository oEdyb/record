export interface ExportSourceClip {
	screenPath?: string;
	webcamPath?: string;
	cleanMicrophonePath?: string;
	microphoneAudioPath?: string;
	systemAudioPath?: string;
}

export interface ExportSourceMetadata<Clip extends ExportSourceClip = ExportSourceClip> {
	clips: readonly Clip[];
	sceneJson?: string;
	additionalSourcePaths?: readonly string[];
}

interface SceneSourceShape {
	background?: { kind?: unknown; path?: unknown };
	annotations?: Array<{ imagePath?: unknown }>;
	videoOverlays?: Array<{ path?: unknown }>;
	audioOverlays?: Array<{ sourcePath?: unknown }>;
	cursor?: { cursorSprites?: Record<string, { path?: unknown }> };
}

function addSource(sources: Set<string>, value: unknown): void {
	if (typeof value !== "string" || value.length === 0) return;
	if (/^(?:data|blob):/i.test(value)) return;
	sources.add(value);
}

export function collectExportSourcePaths(
	clips: readonly ExportSourceClip[],
	sceneJson?: string,
	additionalSourcePaths: readonly string[] = [],
): string[] {
	const sources = new Set<string>();
	for (const source of additionalSourcePaths) addSource(sources, source);
	for (const clip of clips) {
		addSource(sources, clip.screenPath);
		if (clip.screenPath) addSource(sources, `${clip.screenPath}.cursor.json`);
		addSource(sources, clip.webcamPath);
		addSource(sources, clip.cleanMicrophonePath);
		addSource(sources, clip.microphoneAudioPath);
		addSource(sources, clip.systemAudioPath);
	}
	if (!sceneJson) return [...sources];
	let scene: SceneSourceShape;
	try {
		const parsed: unknown = JSON.parse(sceneJson);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error("Expected a scene object");
		}
		scene = parsed as SceneSourceShape;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(
			`Scene metadata is invalid. Export stopped to protect original sources. ${detail}`,
		);
	}
	if (
		[scene.annotations, scene.videoOverlays, scene.audioOverlays].some(
			(value) => value !== undefined && value !== null && !Array.isArray(value),
		)
	) {
		throw new Error("Scene metadata is invalid. Export stopped to protect original sources.");
	}
	if (scene.background?.kind === "image") addSource(sources, scene.background.path);
	for (const annotation of scene.annotations ?? []) addSource(sources, annotation.imagePath);
	for (const overlay of scene.videoOverlays ?? []) addSource(sources, overlay.path);
	for (const overlay of scene.audioOverlays ?? []) addSource(sources, overlay.sourcePath);
	for (const sprite of Object.values(scene.cursor?.cursorSprites ?? {})) {
		addSource(sources, sprite.path);
	}
	return [...sources];
}
