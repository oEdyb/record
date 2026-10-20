import fs from "node:fs/promises";
import path from "node:path";
import { resolvePlaybackSegments } from "../../src/lib/ai-edition/document/timeline";
import { documentSchema } from "../../src/lib/ai-edition/schema";
import { resolveClipSourceEndSec } from "../../src/lib/ai-edition/timeline/clipDuration";
import { availableBytes, formatGigabytes } from "./atomicExport";
import { copyOriginalFile } from "./copyOriginalFile";
import { inspectHandoffSourceMedia } from "./sourceHandoffMedia";
import { buildSourceTimeline, type HandoffMedia, SOURCE_TIMELINE_RATE } from "./sourceTimeline";
import { buildSourceFcpxml, type FcpxmlMediaInfo } from "./sourceTimelineFcpxml";

interface SourceFile extends HandoffMedia {
	label: string;
}

/** `statfs` type of an APFS volume on macOS, where `cp -c` clones instead of copying. */
const APFS_TYPE = 26;
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
	const written = new Map<string, SourceFile>();
	const inspected = new Map<string, Awaited<ReturnType<typeof inspectHandoffSourceMedia>>>();
	const warnings: string[] = [];
	try {
		const copySource = async (
			source: string,
			label: string,
			takeNumber: number,
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
			const file = `${prefix}-${label}${extension}`;
			await copyOriginalFile(canonical, path.join(directory, file));
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
			const screen = await copySource(asset.originalPath, "screen", index + 1);
			const audio: SourceFile["audio"] = [];
			for (const [role, source, offsetMs] of [
				["microphone", asset.microphoneAudioPath, asset.microphoneAudioOffsetMs],
				["system", asset.systemAudioPath, asset.systemAudioOffsetMs],
			] as const) {
				if (!source) continue;
				const original = await copySource(source, role, index + 1);
				audio.push({
					role,
					file: original.file,
					durationSec: original.durationSec,
					offsetSec: (offsetMs ?? 0) / 1000,
				});
			}
			const layout = inspected.get(paths.get(asset.originalPath)!);
			if (layout?.hasAudio && audio.length === 0) {
				audio.push({ role: "audio", file: screen.file, durationSec: screen.durationSec });
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
						...(await copySource(asset.cameraTrack.sourcePath, "camera", index + 1)),
						startMs: asset.cameraTrack.startMs,
						offsetMs: asset.cameraTrack.offsetMs,
						visibleInKlippt: asset.cameraTrack.visible,
					}
				: null;
			sources.push({ assetId: asset.id, screen: { ...screen, audio }, camera });
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
		const manifest = {
			version: 2,
			kind: "klippt-source-handoff",
			title: document.project.title,
			createdAt: new Date().toISOString(),
			videoEncoding: "unchanged",
			audioEncoding: "unchanged",
			mediaBytes: "unchanged",
			timeline: { file: "timeline.otio", frameRate: SOURCE_TIMELINE_RATE },
			finalCutTimeline: { file: "timeline.fcpxml", frameRate: SOURCE_TIMELINE_RATE },
			sources: sources.map(({ assetId, screen, camera }) => ({
				assetId,
				screen: {
					...screen,
					audio: screen.audio.map(({ role, file, durationSec }) => ({ role, file, durationSec })),
				},
				camera: camera
					? {
							file: camera.file,
							label: camera.label,
							durationSec: camera.durationSec,
							audio: camera.audio,
							visibleInKlippt: camera.visibleInKlippt,
						}
					: null,
			})),
			warnings,
		};
		await fs.writeFile(
			path.join(directory, "README.txt"),
			[
				"Klippt source files",
				"",
				"Import timeline.otio as a timeline in your video editor. In DaVinci Resolve, use File > Import > Timeline. Keep this folder together so the relative media links resolve. If prompted, select this folder as the source clips location.",
				"For Final Cut Pro, open timeline.fcpxml with File > Import > XML. It holds the same cuts and sync: Screen in the primary storyline, Camera connected above it, Microphone and System audio connected below it.",
				"The 60 fps timeline contains Screen V1, Camera V2, Microphone A1 and System audio A2. Missing source time remains a gap. Only original standalone audio files are placed on the microphone and system tracks. Legacy embedded-only audio has an Original audio (unidentified) track.",
				"Cuts, clip order and camera sync are stored only in timeline.otio and timeline.fcpxml. Boundaries are rounded to the nearest timeline frame. Complete source files retain all material outside the kept spans.",
				"Camera is a full, separate video layer above the screen; resize or disable it in your editor. This timeline does not recreate the Klippt visual layout. Camera-file audio, if present, is exported but not added to the timeline.",
				"Every media file is an unchanged byte copy of its complete original. Nothing is trimmed, remuxed, extracted, decoded, re-encoded, cleaned, or normalized during export.",
				"If separate audio is present, disable the screen file's embedded audio to avoid doubling it. Older untagged audio is labelled audio; it is not assumed to be an isolated microphone.",
				"Captions, zooms, speed changes, layouts, B-roll and other editor effects are not baked into these source files. Removed clips are omitted. The original project and media are unchanged.",
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
			fcpxmlPath,
			sourceCount: written.size,
			warnings,
		};
	} catch (error) {
		await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
		throw error;
	}
}
