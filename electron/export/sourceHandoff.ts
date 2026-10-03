import { spawn } from "node:child_process";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { resolvePlaybackSegments } from "../../src/lib/ai-edition/document/timeline";
import { documentSchema } from "../../src/lib/ai-edition/schema";
import { resolveClipSourceEndSec } from "../../src/lib/ai-edition/timeline/clipDuration";
import { audioTrackMapArgs, resolveFfmpeg } from "../media/audioPeaks";
import { inspectSourceAudioLayout } from "../stt/sourceAudio";
import { buildSourceTimeline, type HandoffMedia, SOURCE_TIMELINE_RATE } from "./sourceTimeline";

interface SourceFile extends HandoffMedia {
	label: string;
}

async function runFfmpeg(args: string[]): Promise<void> {
	const ffmpeg = resolveFfmpeg();
	if (!ffmpeg)
		throw new Error("Bundled FFmpeg is unavailable. Reinstall Klippt to export sources.");
	await new Promise<void>((resolve, reject) => {
		const child = spawn(ffmpeg, ["-hide_banner", "-nostdin", "-v", "error", "-n", ...args], {
			stdio: ["ignore", "ignore", "pipe"],
		});
		let stderr = "";
		const timeout = setTimeout(() => child.kill("SIGKILL"), 30 * 60_000);
		child.stderr.on("data", (chunk: Buffer) => {
			stderr = (stderr + chunk.toString()).slice(-4000);
		});
		child.once("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		child.once("close", (code) => {
			clearTimeout(timeout);
			if (code === 0) resolve();
			else reject(new Error(`Could not prepare a source file: ${stderr || "FFmpeg stopped."}`));
		});
	});
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
	if (!retained.length) throw new Error("This project has no kept takes to export.");
	const ids = [...new Set(retained.map((clip) => clip.assetId))];
	const assets = ids.map((id) => {
		const asset = assetById.get(id);
		if (!asset) throw new Error(`Missing recording for take ${id}. Relink it before exporting.`);
		return asset;
	});
	const paths = new Map<string, string>();
	for (const asset of assets) {
		for (const source of [asset.originalPath, asset.cameraTrack?.sourcePath]) {
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
	const directory = await fs
		.realpath(destination)
		.then((parent) => fs.mkdtemp(path.join(parent, `${safeTitle}-sources-`)))
		.catch(() => {
			throw new Error(
				"Could not create the source folder. Choose a writable folder and try again.",
			);
		});
	const written = new Map<string, SourceFile>();
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
			if (existing) return existing;
			const layout = await inspectSourceAudioLayout(canonical);
			const prefix = String(takeNumber).padStart(3, "0");
			const extension = path.extname(canonical).toLowerCase();
			const rewrap =
				[".webm", ".mkv"].includes(extension) &&
				["h264", "hevc"].includes(layout.video?.codec ?? "");
			const file = `${prefix}-${label}${rewrap ? ".mov" : extension}`;
			if (rewrap) {
				await runFfmpeg([
					"-i",
					canonical,
					"-map",
					"0:v:0",
					"-c:v",
					"copy",
					"-an",
					"-movflags",
					"+faststart",
					path.join(directory, file),
				]);
			} else {
				await fs.copyFile(
					canonical,
					path.join(directory, file),
					constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE,
				);
				if ([".webm", ".mkv"].includes(extension))
					warnings.push(
						`${file}: original container retained; your video editor may require conversion.`,
					);
			}
			const audio: SourceFile["audio"] = [];
			const roles = layout.roles.length
				? layout.roles
				: layout.hasAudio
					? ["original" as const]
					: [];
			for (const role of roles) {
				const name = role === "you" ? "microphone" : role === "system" ? "system" : "audio";
				const audioFile = `${prefix}-${label === "screen" ? "" : `${label}-`}${name}.wav`;
				const map =
					role === "you"
						? audioTrackMapArgs("microphone")
						: role === "system"
							? audioTrackMapArgs("system")
							: ["-map", "0:a:0"];
				await runFfmpeg([
					"-copyts",
					"-start_at_zero",
					"-i",
					canonical,
					...map,
					"-vn",
					"-af",
					"aresample=async=1:first_pts=0",
					"-c:a",
					"pcm_s24le",
					"-rf64",
					"auto",
					path.join(directory, audioFile),
				]);
				audio.push({
					role: name,
					file: audioFile,
					durationSec: (await inspectSourceAudioLayout(path.join(directory, audioFile)))
						.durationSec,
				});
			}
			const durationSec = rewrap
				? (await inspectSourceAudioLayout(path.join(directory, file))).durationSec
				: layout.durationSec;
			const result = { file, label: path.basename(source), durationSec, audio };
			written.set(canonical, result);
			return result;
		};
		const sources = [];
		for (const [index, asset] of assets.entries()) {
			const screen = await copySource(asset.originalPath, "screen", index + 1);
			const camera = asset.cameraTrack
				? {
						...(await copySource(asset.cameraTrack.sourcePath, "camera", index + 1)),
						startMs: asset.cameraTrack.startMs,
						offsetMs: asset.cameraTrack.offsetMs,
						visibleInKlippt: asset.cameraTrack.visible,
					}
				: null;
			sources.push({ assetId: asset.id, screen, camera });
		}
		const durations = new Map(sources.map((source) => [source.assetId, source.screen.durationSec]));
		const keptClips = clips.filter(
			(clip) => resolvePlaybackSegments([clip], document.timeline.trimRanges).length > 0,
		);
		const boundedClips = keptClips.map((clip) => {
			const duration = durations.get(clip.assetId);
			if (duration === null || duration === undefined || !Number.isFinite(duration))
				throw new Error("Could not read a kept take's duration. Relink it before exporting.");
			if (duration <= clip.sourceStartSec)
				throw new Error("A kept take starts beyond its media. Repair its timing before exporting.");
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
		const manifest = {
			version: 1,
			kind: "klippt-source-handoff",
			title: document.project.title,
			createdAt: new Date().toISOString(),
			videoEncoding: "unchanged",
			timeline: { file: "timeline.otio", frameRate: SOURCE_TIMELINE_RATE },
			sources,
			cameraTimeFormula: "cameraSourceSec = screenSourceSec - (startMs + offsetMs) / 1000",
			clips: handoffClips.map(
				({ id, assetId, sourceStartSec, sourceEndSec, timelineStartSec, timelineEndSec }) => ({
					id,
					assetId,
					sourceStartSec,
					sourceEndSec,
					timelineStartSec,
					timelineEndSec,
				}),
			),
			warnings,
		};
		await fs.writeFile(
			path.join(directory, "README.txt"),
			[
				"Klippt source files",
				"",
				"Import timeline.otio as a timeline in your video editor. In DaVinci Resolve, use File > Import > Timeline. Keep this folder together so the relative media links resolve. If prompted, select this folder as the source clips location.",
				"The 60 fps timeline contains Screen V1, Camera V2, Microphone A1 and System audio A2. Missing source time remains a gap. Only separate WAVs are placed on audio tracks; embedded video audio is not added. Untagged audio has its own Original audio (unidentified) track.",
				"Cuts, take order and camera sync are included. Boundaries are rounded to the nearest timeline frame. Whole source files retain material outside the kept spans. handoff.json retains exact source timing for agents.",
				"Camera is a full, separate video layer above the screen; resize or disable it in your editor. This timeline does not recreate the Klippt visual layout. Camera-file audio, if present, is exported but not added to the timeline.",
				"Video is copied or remuxed without re-encoding. Audio WAVs contain original tracks decoded to 24-bit PCM, without cleanup, gain changes, or normalization.",
				"If separate audio is present, disable the screen file's embedded audio to avoid doubling it. Older untagged audio is labelled audio; it is not assumed to be an isolated microphone.",
				"Camera sync: cameraSourceSec = screenSourceSec - (startMs + offsetMs) / 1000. Preserve gaps when this value is negative.",
				"Captions, zooms, speed changes, layouts, B-roll and other editor effects are not baked into these source files. Removed takes are omitted. The original project and media are unchanged.",
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
			sourceCount: written.size,
			warnings,
		};
	} catch (error) {
		await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
		throw error;
	}
}
