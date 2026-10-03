import type { AxcutClip, AxcutDocument } from "../schema";
import type { OverlayAnchor } from "../schema/overlayAnchor";
import { buildTimelinePlaybackProjection } from "./timelineMap";

export function findPhrase(document: AxcutDocument, text: string, clipId?: string) {
	const normalize = (value: string) => value.trim().replace(/\s+/g, " ");
	const phrase = normalize(text);
	if (!phrase) return [];
	return document.timeline.clips
		.filter((clip) => !clipId || clip.id === clipId)
		.flatMap((clip) => {
			const transcript =
				document.transcripts.find((t) => t.assetId === clip.assetId) ??
				(document.transcript?.assetId === clip.assetId ? document.transcript : undefined);
			const words = (transcript?.words ?? [])
				.filter((w) => w.startSec >= clip.sourceStartSec)
				.sort((a, b) => a.startSec - b.startSec);
			const matches: Extract<OverlayAnchor, { kind: "words" }>[] = [];
			for (let i = 0; i < words.length; i++) {
				if (words[i].startSec >= (clip.sourceEndSec ?? Infinity)) break;
				let joined = "";
				for (let j = i; j < words.length; j++) {
					joined = normalize(`${joined} ${words[j].text}`);
					if (joined === phrase)
						matches.push({
							kind: "words",
							clipId: clip.id,
							assetId: clip.assetId,
							text,
							sourceStartSec: words[i].startSec,
							sourceEndSec: words[j].endSec,
						});
					if (joined.length >= phrase.length) break;
				}
			}
			return matches;
		});
}

export function resolveOverlaySpan(
	document: AxcutDocument,
	visible: AxcutClip[],
	anchor: OverlayAnchor,
) {
	if (anchor.kind === "edited") return { fromSec: anchor.fromSec, toSec: anchor.toSec };
	const owner = document.timeline.clips.find((clip) => clip.id === anchor.clipId);
	const assetId = owner?.assetId ?? anchor.assetId;
	if (!assetId) return null;
	const matches = findPhrase(document, anchor.text).filter((match) =>
		document.timeline.clips.some((clip) => clip.id === match.clipId && clip.assetId === assetId),
	);
	const exact = matches.filter(
		(match) =>
			Math.abs(match.sourceStartSec - anchor.sourceStartSec) < 0.001 &&
			Math.abs(match.sourceEndSec - anchor.sourceEndSec) < 0.001,
	);
	const ownedExact = exact.find((match) => match.clipId === anchor.clipId);
	const owned = matches.filter((match) => match.clipId === anchor.clipId);
	const match =
		ownedExact ??
		(exact.length === 1
			? exact[0]
			: exact.length > 1
				? undefined
				: owned.length === 1
					? owned[0]
					: matches.length === 1
						? matches[0]
						: undefined);
	if (!match) return null;
	const projection = buildTimelinePlaybackProjection(visible, document.timeline.clips);
	const first = projection.findIndex(
		(part) =>
			part.rawClipId === match.clipId &&
			part.segment.sourceStartSec <= match.sourceStartSec &&
			(part.segment.sourceEndSec ?? 0) > match.sourceStartSec,
	);
	if (first < 0) return null;
	const fromSec =
		projection[first].playbackStartSec +
		match.sourceStartSec -
		projection[first].segment.sourceStartSec;
	let source = match.sourceStartSec;
	for (let i = first; i < projection.length; i++) {
		const part = projection[i];
		if (
			part.segment.assetId !== assetId ||
			(i > first && Math.abs(part.segment.sourceStartSec - source) > 0.001)
		)
			return null;
		const end = part.segment.sourceEndSec ?? source;
		if (end >= match.sourceEndSec - 0.001) {
			const toSec = part.playbackStartSec + match.sourceEndSec - part.segment.sourceStartSec;
			return { fromSec, toSec: Math.max(toSec, fromSec + (anchor.minimumDurationSec ?? 0)) };
		}
		source = end;
	}
	return null;
}

export function resolveOverlayInputs<T extends { id: string; anchor?: OverlayAnchor }>(
	document: AxcutDocument,
	visible: AxcutClip[],
	regions: T[],
): T[] {
	return regions.flatMap((region) => {
		if (!region.anchor) return [region];
		const span = resolveOverlaySpan(document, visible, region.anchor);
		return span ? [{ ...region, anchor: { kind: "edited" as const, ...span } }] : [];
	});
}
