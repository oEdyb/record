type CleanVoiceRuntimePhase =
	| "queued"
	| "checking-cache"
	| "processing"
	| "ready"
	| "failed"
	| "cancelled";

export interface CleanVoiceRuntimeAsset {
	projectId: string;
	assetId: string;
	phase: CleanVoiceRuntimePhase;
	message?: string;
	cleanMicrophonePath?: string;
	previewAudioPath?: string;
	cacheKey?: string;
}

export interface CleanVoiceRuntimeSnapshot {
	available: boolean;
	assets: CleanVoiceRuntimeAsset[];
}

export interface CleanVoiceRoute {
	cleanMicrophonePath: string;
	previewAudioPath: string;
	cacheKey: string;
}

export function cleanVoiceRoutes(
	snapshot: CleanVoiceRuntimeSnapshot,
): ReadonlyMap<string, CleanVoiceRoute> {
	const routes = new Map<string, CleanVoiceRoute>();
	for (const asset of snapshot.assets) {
		if (
			asset.phase === "ready" &&
			asset.cleanMicrophonePath &&
			asset.previewAudioPath &&
			asset.cacheKey
		) {
			routes.set(asset.assetId, {
				cleanMicrophonePath: asset.cleanMicrophonePath,
				previewAudioPath: asset.previewAudioPath,
				cacheKey: asset.cacheKey,
			});
		}
	}
	return routes;
}
