import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolvePlaybackSegments } from "../../src/lib/ai-edition/document/timeline";
import { documentSchema } from "../../src/lib/ai-edition/schema";
import { resolveClipSourceEndSec } from "../../src/lib/ai-edition/timeline/clipDuration";
import { renderCleanAudio } from "../cleanCut/renderCleanAudio";
import { availableBytes, formatGigabytes } from "./atomicExport";
import { type CleanCut, cleanCutTimeline } from "./cleanCutSpans";
import { copyOriginalFile } from "./copyOriginalFile";
import { copyHandoffCursor } from "./handoffCursor";
import {
	editMap,
	fileIdentity,
	inspectFileFactsOrNull,
	removedRanges,
	shortSourceId,
} from "./handoffProvenance";
import { inspectHandoffSourceMedia } from "./sourceHandoffMedia";
import { buildSourceTimeline, type HandoffMedia, SOURCE_TIMELINE_RATE } from "./sourceTimeline";
import { buildSourceFcpxml, type FcpxmlMediaInfo } from "./sourceTimelineFcpxml";

interface SourceFile extends HandoffMedia {
	label: string;
}

/** `statfs` type of an APFS volume on macOS, where `cp -c` clones instead of copying. */
const APFS_TYPE = 26;
const CLEAN_CUT_TIMELINE = "timeline-clean-cut.otio";
const HANDOFF_SAFETY_BYTES = 64n * 1024n * 1024n;

/** A clone on the same APFS volume takes no space; every other copy needs the
 * whole file. Fail before creating the folder rather than partway through. */
async function assertHandoffSpace(sources: string[], destination: string): Promise<void> {
	const [target, volume] = await Promise.all([fs.stat(destination), fs.statfs(destination)]);
	const clones = process.platform === "darwin" && volume.type === APFS_TYPE;
	let needed = 0n;
	for (const source of sources) {
		const stats = await fs.stat(source);
		if (!(clones && stats.dev === target.dev)) needed += BigInt(stats.size);
	}
	if (needed === 0n) return;
	const safety = needed / 100n > HANDOFF_SAFETY_BYTES ? needed / 100n : HANDOFF_SAFETY_BYTES;
	const free = availableBytes(volume);
	if (free < needed + safety)
		throw new Error(
			`Not enough free space for the source files. They need about ${formatGigabytes(needed + safety)} free, and this disk has ${formatGigabytes(free)}.`,
		);
}

export async function exportSourceHandoff(
	input: unknown,
	destination: string,
	resolveApprovedPath: (file: string) => string | null,
	cleanCut?: CleanCut,
	signal?: AbortSignal,
) {
	const document = documentSchema.parse(input);
	const assetById = new Map(document.assets.map((asset) => [asset.id, asset]));
	const clips = document.timeline.clips.map((clip) => ({
		...clip,
		sourceEndSec: resolveClipSourceEndSec(clip, assetById.get(clip.assetId)),
	}));
	const retained = resolvePlaybackSegments(clips, document.timeline.trimRanges);
	if (!retained.length) throw new Error("This project has no kept clips to export.");
	const ids = [...new Set(retained.map((clip) => clip.assetId))];
	const assets = ids.map((id) => {
		const asset = assetById.get(id);
		if (!asset) throw new Error(`Missing recording for clip ${id}. Relink it before exporting.`);
		return asset;
	});
	const paths = new Map<string, string>();
	for (const asset of assets) {
		for (const source of [
			asset.originalPath,
			asset.cameraTrack?.sourcePath,
			asset.microphoneAudioPath,
			asset.systemAudioPath,
		]) {
			if (!source || paths.has(source)) continue;
			const canonical = await fs.realpath(source).catch(() => {
				throw new Error(
					`Source file unavailable: ${path.basename(source)}. Relink it before exporting.`,
				);
			});
			if (!resolveApprovedPath(canonical))
				throw new Error(`Open this media with the file picker first: ${path.basename(source)}`);
			if (!(await fs.stat(canonical)).isFile())
				throw new Error(`Not a media file: ${path.basename(source)}`);
			paths.set(source, canonical);
		}
	}
	const safeTitle =
		document.project.title.replace(/[^a-z0-9_-]+/gi, "_").slice(0, 60) || "Recording";
	const parent = await fs.realpath(destination).catch(() => {
		throw new Error("Could not create the source folder. Choose a writable folder and try again.");
	});
	await assertHandoffSpace([...new Set(paths.values())], parent);
	const directory = await fs.mkdtemp(path.join(parent, `${safeTitle}-sources-`)).catch(() => {
		throw new Error("Could not create the source folder. Choose a writable folder and try again.");
	});
	const exportId = randomUUID();
	const files = [];
	const written = new Map<string, SourceFile>();
	const inspected = new Map<string, Awaited<ReturnType<typeof inspectHandoffSourceMedia>>>();
	const warnings: string[] = [];
	try {
		const copySource = async (
			source: string,
			label: string,
			takeNumber: number,
			assetId: string,
		): Promise<SourceFile> => {
			const canonical = paths.get(source);
			if (!canonical) throw new Error("Source was not approved.");
			const existing = written.get(canonical);
			const layout = inspected.get(canonical) ?? (await inspectHandoffSourceMedia(canonical));
			inspected.set(canonical, layout);
			if ((label === "microphone" || label === "system") && (!layout.hasAudio || layout.video))
				throw new Error(
					`The original ${label} file is not standalone audio. Relink it before exporting.`,
				);
			if (existing) return existing;
			const prefix = String(takeNumber).padStart(3, "0");
			const extension = path.extname(canonical).toLowerCase();
			const file = `${prefix}-${shortSourceId(assetId)}-${label}${extension}`;
			await copyOriginalFile(canonical, path.join(directory, file));
			files.push({
				file,
				...(await fileIdentity(path.join(directory, file))),
				streams: await inspectFileFactsOrNull(path.join(directory, file)),
			});
			if ([".webm", ".mkv"].includes(extension))
				warnings.push(
					`${file}: original container retained; your video editor may require conversion.`,
				);
			const result: SourceFile = {
				file,
				label: path.basename(source),
				durationSec: layout.durationSec,
				audio: [],
			};
			written.set(canonical, result);
			return result;
		};
		const sources = [];
		for (const [index, asset] of assets.entries()) {
			const screen = await copySource(asset.originalPath, "screen", index + 1, asset.id);
			const audio: SourceFile["audio"] = [];
			for (const [role, source, offsetMs] of [
				["microphone", asset.microphoneAudioPath, asset.microphoneAudioOffsetMs],
				["system", asset.systemAudioPath, asset.systemAudioOffsetMs],
			] as const) {
				if (!source) continue;
				const original = await copySource(source, role, index + 1, asset.id);
				audio.push({
					role,
					file: original.file,
					durationSec: original.durationSec,
					offsetSec: (offsetMs ?? 0) / 1000,
				});
			}
			const layout = inspected.get(paths.get(asset.originalPath)!);
			if (layout?.hasAudio && audio.length === 0) {
				audio.push({
					role: "audio",
					file: screen.file,
					durationSec: screen.durationSec,
					offsetSec: 0,
				});
				warnings.push(
					`${screen.file}: standalone microphone and system originals are unavailable. Embedded audio is retained unchanged on an Original audio track; it was not extracted.`,
				);
			} else {
				for (const role of layout?.roles ?? []) {
					const name = role === "you" ? "microphone" : "system";
					if (!audio.some((source) => source.role === name))
						warnings.push(
							`${screen.file}: the original ${name} remains embedded; no standalone ${name} file is available.`,
						);
				}
			}
			const camera = asset.cameraTrack
				? {
						...(await copySource(asset.cameraTrack.sourcePath, "camera", index + 1, asset.id)),
						startMs: asset.cameraTrack.startMs,
						offsetMs: asset.cameraTrack.offsetMs,
						offsetSec: (asset.cameraTrack.startMs + asset.cameraTrack.offsetMs) / 1000,
						visibleInKlippt: asset.cameraTrack.visible,
					}
				: null;
			const cursor = await copyHandoffCursor(
				paths.get(asset.originalPath)!,
				`${String(index + 1).padStart(3, "0")}-${shortSourceId(asset.id)}`,
				directory,
				resolveApprovedPath,
			);
			sources.push({
				assetId: asset.id,
				take: index + 1,
				screen: { ...screen, offsetSec: 0, audio },
				camera,
				cursor,
			});
		}
		const durations = new Map(sources.map((source) => [source.assetId, source.screen.durationSec]));
		const keptClips = clips.filter(
			(clip) => resolvePlaybackSegments([clip], document.timeline.trimRanges).length > 0,
		);
		const boundedClips = keptClips.map((clip) => {
			const duration = durations.get(clip.assetId);
			if (duration === null || duration === undefined || !Number.isFinite(duration))
				throw new Error("Could not read a kept clip's duration. Relink it before exporting.");
			if (duration <= clip.sourceStartSec)
				throw new Error("A kept clip starts beyond its media. Repair its timing before exporting.");
			return {
				...clip,
				sourceEndSec: Math.min(
					resolveClipSourceEndSec(clip, assetById.get(clip.assetId)),
					duration,
				),
			};
		});
		const handoffClips = resolvePlaybackSegments(boundedClips, document.timeline.trimRanges);
		if (!handoffClips.length) throw new Error("This project has no kept media to export.");
		const interchange = buildSourceTimeline(document.project.title, sources, handoffClips);
		warnings.push(...interchange.warnings);
		const timelinePath = path.join(directory, "timeline.otio");
		await fs.writeFile(timelinePath, `${JSON.stringify(interchange.timeline, null, 2)}\n`, {
			flag: "wx",
		});
		let cleanEdit: ReturnType<typeof editMap> | null = null;
		let cleanCutPath: string | null = null;
		let cleanDialogue: Awaited<ReturnType<typeof renderCleanAudio>> | undefined;
		if (cleanCut) {
			const layout = cleanCutTimeline(handoffClips, cleanCut);
			if (!layout.spans.length) throw new Error("The clean cut keeps nothing from this recording.");
			let cleanInterchange = buildSourceTimeline(
				`${document.project.title} (clean cut)`,
				sources,
				layout.spans,
				layout.markers,
			);
			const microphone = cleanInterchange.plan.tracks.find((track) => track.role === "microphone");
			const originalMicrophone = interchange.plan.tracks.find(
				(track) => track.role === "microphone",
			);
			if (microphone?.items.some((item) => item.type === "clip") && originalMicrophone) {
				cleanDialogue = await renderCleanAudio({
					items: microphone.items,
					retained: originalMicrophone.items,
					directory,
					output: path.join(directory, `000-${shortSourceId(exportId)}-clean-dialogue.wav`),
					signal,
				});
				cleanInterchange = buildSourceTimeline(
					`${document.project.title} (clean cut)`,
					sources,
					layout.spans,
					layout.markers,
					cleanDialogue,
				);
				if (microphone.items.some((item) => item.type === "gap"))
					warnings.push(
						"Clean dialogue has silence where isolated microphone audio is unavailable.",
					);
			} else warnings.push("Clean dialogue skipped: no isolated microphone source is available.");
			cleanEdit = editMap(cleanInterchange.plan.tracks);
			warnings.push(...cleanInterchange.warnings.filter((warning) => !warnings.includes(warning)));
			cleanCutPath = path.join(directory, CLEAN_CUT_TIMELINE);
			await fs.writeFile(cleanCutPath, `${JSON.stringify(cleanInterchange.timeline, null, 2)}\n`, {
				flag: "wx",
			});
		}
		const media = new Map<string, FcpxmlMediaInfo>();
		for (const [canonical, file] of written) {
			const layout = inspected.get(canonical);
			media.set(file.file, {
				hasVideo: Boolean(layout?.video),
				hasAudio: Boolean(layout?.hasAudio),
			});
		}
		const frame = inspected.get(paths.get(assets[0].originalPath)!)?.video;
		const fcpxmlPath = path.join(directory, "timeline.fcpxml");
		await fs.writeFile(
			fcpxmlPath,
			buildSourceFcpxml(document.project.title, interchange.plan.tracks, {
				width: frame?.width ?? 1920,
				height: frame?.height ?? 1080,
				media,
			}),
			{ flag: "wx" },
		);
		if (cleanDialogue)
			files.push({
				file: cleanDialogue.file,
				...(await fileIdentity(path.join(directory, cleanDialogue.file))),
				streams: await inspectFileFactsOrNull(path.join(directory, cleanDialogue.file)),
			});
		const transcripts = [
			...document.transcripts,
			...(document.transcript ? [document.transcript] : []),
		].filter((entry) => entry.words.length > 0);
		const fullEdit = editMap(interchange.plan.tracks);
		const manifest = {
			exportId,
			clock: {
				reference: "Each take’s screen file",
				takes: sources.map((source) => ({
					assetId: source.assetId,
					take: source.take,
					reference: source.screen.file,
				})),
				frameRate: SOURCE_TIMELINE_RATE,
				sourceRanges: "half-open [start,end)",
				rule: "streamTimeSec = screenTimeSec - offsetSec",
				cleanDialogue: cleanDialogue
					? { file: cleanDialogue.file, offsetSec: 0, reference: "clean timeline" }
					: null,
			},
			files,
			edit: {
				full: {
					pieces: fullEdit.find((track) => track.role === "screen")?.pieces,
					tracks: fullEdit,
				},
				clean: cleanEdit
					? {
							pieces: cleanEdit.find((track) => track.role === "screen")?.pieces,
							tracks: cleanEdit,
							removed: removedRanges(fullEdit, cleanEdit, cleanCut?.markers ?? []),
						}
					: null,
			},
			transcript: transcripts.length
				? { available: true, transcripts }
				: { available: false, reason: "Project document contains no timed transcript words." },
			activeDialogue: cleanDialogue
				? {
						file: cleanDialogue.file,
						track: "Clean dialogue",
						offsetSec: 0,
						replaces: cleanEdit?.find((track) => track.role === "microphone")?.pieces,
					}
				: null,
			version: 4,
			kind: "klippt-source-handoff",
			title: document.project.title,
			createdAt: new Date().toISOString(),
			videoEncoding: "unchanged",
			audioEncoding: "unchanged",
			mediaBytes: "unchanged",
			timeline: { file: "timeline.otio", frameRate: SOURCE_TIMELINE_RATE },
			...(cleanDialogue
				? {
						cleanDialogue: {
							kind: "derived-dialogue",
							offsetSec: 0,
							encoding: "pcm_s24le",
							file: cleanDialogue.file,
							sampleRate: cleanDialogue.sampleRate,
							samples: cleanDialogue.samples,
							channels: cleanDialogue.channels,
							peak: cleanDialogue.peak,
							attenuatedSeams: cleanDialogue.attenuatedSeams,
							plan: cleanDialogue.plan,
						},
					}
				: {}),
			...(cleanCutPath ? { cleanCutTimeline: { file: CLEAN_CUT_TIMELINE } } : {}),
			finalCutTimeline: { file: "timeline.fcpxml", frameRate: SOURCE_TIMELINE_RATE },
			sources,
			warnings,
		};
		await fs.writeFile(
			path.join(directory, "README.txt"),
			[
				"Klippt source files",
				"Names: <take>-<stable recording id>-<role>.<ext>; derived dialogue uses an export id. Keep this folder together.",
				"Provenance: clip names and OTIO metadata. handoff.json v4 holds hashes, stream facts, exact offsets and per-track edit maps. Ranges are half-open; frame fields are authoritative for timeline placement.",
				"Sync: streamTimeSec = screenTimeSec - offsetSec. All offsets, including zero, are explicit. Clean dialogue uses exact microphone offsets at 48 kHz; timelines use 60 fps.",
				"Cursor: per-take cursor JSON is unchanged; decoded PNG assets and coordinate/timebase details are in handoff.json. Missing cursor data is explicit. Editors do not automatically recreate overlays.",

				"Import timeline.otio in your editor. For Final Cut Pro, open timeline.fcpxml. Relink to this folder if prompted.",
				"Tracks: Screen, Camera, Microphone, System audio; missing source time is a gap. Embedded-only audio stays unidentified; disable embedded audio when separate originals exist.",
				"Original media bytes are unchanged. Complete files include material outside the cuts. Camera is a separate full layer; visual effects and layouts are not transferred.",
				...(cleanCutPath
					? [
							`${CLEAN_CUT_TIMELINE} contains the clean cut; timeline.otio and timeline.fcpxml contain the full edit.`,
						]
					: []),
				...(cleanDialogue
					? [
							`${cleanDialogue.file}: derived 48 kHz, 24-bit dialogue. The clean OTIO disables replaced microphone clips; system audio stays enabled. Check disabled clips after import.`,
						]
					: []),
				...warnings,
			].join("\n"),
			{ flag: "wx" },
		);
		const manifestPath = path.join(directory, "handoff.json");
		await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
		return {
			canceled: false,
			directory,
			manifestPath,
			timelinePath,
			cleanCutPath,
			fcpxmlPath,
			sourceCount: written.size,
			warnings,
		};
	} catch (error) {
		await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
		throw error;
	}
}
