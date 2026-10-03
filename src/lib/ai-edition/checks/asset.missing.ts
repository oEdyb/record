import { type CheckRule, finding } from "./types";

export const assetMissing: CheckRule = {
	id: "asset.missing",
	severity: "error",
	describe: "An asset or overlay file is missing from disk.",
	run(context) {
		const assets = [...context.assets, ...(context.document.audioAssets ?? [])];
		const notes: string[] = [];
		const findings = context.assetFiles.flatMap((file) => {
			const exists = context.files[file.path];
			if (exists !== false) {
				if (exists !== true)
					notes.push(
						`asset.missing skipped: file status unavailable for ${file.name} (${file.id}, ${file.role}).`,
					);
				return [];
			}
			const fragments = context.fragments.filter((fragment) => fragment.assetId === file.id);
			const overlays =
				context.document.videoOverlays?.filter((overlay) => overlay.assetId === file.id) ?? [];
			const spans = [
				...fragments.map((fragment) => ({ span: fragment.edited, clip: fragment.clip })),
				...overlays.flatMap((overlay) =>
					context.authored
						.filter((region) => region.id === overlay.id)
						.map((region) => ({
							span: {
								startSec: region.at,
								endSec: region.pieces.at(-1)?.edited.endSec ?? region.at,
							},
							clip: region.clip,
						})),
				),
			];
			for (const audio of context.document.timeline.audioClips ?? []) {
				if (audio.assetId === file.id)
					spans.push({ span: { startSec: audio.startSec, endSec: audio.endSec }, clip: null });
			}
			for (const region of context.authored.filter((region) => region.id === file.id))
				spans.push({
					span: { startSec: region.at, endSec: region.pieces.at(-1)?.edited.endSec ?? region.at },
					clip: region.clip,
				});
			if (!spans.length) spans.push({ span: { startSec: 0, endSec: 0 }, clip: null });
			return spans.map((item) =>
				finding(
					assetMissing,
					item.span,
					item.clip,
					`${file.name} (${file.id}, ${file.role}) is missing: ${file.path}`,
				),
			);
		});
		for (const overlay of context.document.videoOverlays ?? []) {
			if (assets.some((asset) => asset.id === overlay.assetId)) continue;
			const region = context.authored.find((item) => item.id === overlay.id);
			const at = region?.at ?? 0;
			findings.push(
				finding(
					assetMissing,
					{ startSec: at, endSec: at },
					region?.clip ?? null,
					`Video overlay (${overlay.id}) references missing asset ${overlay.assetId}.`,
				),
			);
		}
		return { findings, notes };
	},
};
