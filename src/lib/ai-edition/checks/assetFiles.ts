import type { AxcutDocument } from "../schema";

export function assetFiles(document: AxcutDocument) {
	return [
		...document.assets.flatMap((asset) => [
			{ id: asset.id, name: asset.label, path: asset.originalPath, role: "source" },
			...(asset.cameraTrack?.sourcePath
				? [{ id: asset.id, name: asset.label, path: asset.cameraTrack.sourcePath, role: "camera" }]
				: []),
		]),
		...(document.audioAssets ?? []).map((asset) => ({
			id: asset.id,
			name: asset.label,
			path: asset.originalPath,
			role: "audio",
		})),
		...(document.annotations ?? []).flatMap((annotation) => {
			const path = annotation.content || annotation.imageContent;
			return annotation.type === "image" && path && !path.startsWith("data:")
				? [{ id: annotation.id, name: "Image annotation", path, role: "image" }]
				: [];
		}),
	];
}
