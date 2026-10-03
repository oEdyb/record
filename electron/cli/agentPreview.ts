import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pickOutputDims } from "../../src/lib/ai-edition/document/outputFormat";
import type { AxcutDocument } from "../../src/lib/ai-edition/schema";
import {
	getEditorSettings,
	patchEditorSettings,
} from "../../src/lib/ai-edition/store/editorSettings";
import { calculateEffectiveExportDuration } from "../../src/lib/exporter/mp4ExportSettings";
import {
	buildCompositorClipInputs,
	buildSceneDescription,
} from "../../src/native/sceneDescription";
import { loadAgentDocument } from "./agentInspection";
import {
	parseTimeInput,
	type ResolvedInstant,
	resolveEditedSeconds,
	resolveExportSeconds,
	resolveTimelineInstant,
	TIME_BASE_LABELS,
	type TimeInput,
} from "./agentTimeBase";

export interface AgentPreviewLaunch {
	executable: string;
	args: string[];
}
type RunProcess = (executable: string, args: string[], timeoutMs: number) => Promise<void>;

/** Same scene/clip mapping and export duration calculation as CliExportRunner.
 * Keep the whole timeline: cropping it would change effect/camera timebases. */
export function prepareAgentPreview(document: AxcutDocument, time: number, maxDimension = 1280) {
	if (
		!Number.isFinite(time) ||
		time < 0 ||
		!Number.isInteger(maxDimension) ||
		maxDimension < 256 ||
		maxDimension > 1280
	)
		throw new Error("PREVIEW_INPUT_INVALID");
	if (document.timeline.clips.length > 128 || document.assets.length > 128)
		throw new Error("PREVIEW_UNAVAILABLE: This slice supports at most 128 clips and 128 assets.");
	for (const clip of document.timeline.clips) {
		const asset = document.assets.find((entry) => entry.id === clip.assetId);
		if (!asset?.video?.width || !asset.video.height || !Number.isFinite(clip.sourceEndSec))
			throw new Error(
				"PREVIEW_UNAVAILABLE: Explicit clip endpoints and video dimensions are required.",
			);
		if (
			!path.isAbsolute(asset.originalPath) ||
			(asset.cameraTrack?.sourcePath && !path.isAbsolute(asset.cameraTrack.sourcePath))
		)
			throw new Error("PREVIEW_UNAVAILABLE: This slice requires absolute media paths.");
	}
	const clips = buildCompositorClipInputs(document);
	const scene = buildSceneDescription(document);
	const duration = calculateEffectiveExportDuration(clips, scene.speedRegions);
	if (!Number.isFinite(duration) || duration <= 0)
		throw new Error("PREVIEW_UNAVAILABLE: Project must have a finite positive edited duration.");
	if (time >= duration) throw new Error("PREVIEW_TIME_OUTSIDE_PROJECT");
	const settings = getEditorSettings(document);
	const dims = pickOutputDims(document, settings.aspectRatio, {}, settings.outputResolution);
	const scale = Math.min(1, maxDimension / Math.max(dims.width, dims.height));
	const output = {
		width: Math.floor((dims.width * scale) / 2) * 2,
		height: Math.floor((dims.height * scale) / 2) * 2,
	};
	if (Math.min(output.width, output.height) < 256)
		throw new Error(
			"PREVIEW_UNAVAILABLE: Aspect ratio is too extreme for the preview resolution bound.",
		);
	return {
		document: patchEditorSettings(document, { outputResolution: output }),
		output,
		duration,
		frameTime: Math.floor(time * 60) / 60,
	};
}

/** The derived file may change only the allowed preview resolution. No media
 * permissions come from its contents: normal loading of the hash-bound original
 * establishes those permissions through the existing approval flow. */
export async function verifyAgentPreviewReference(
	derivedPath: string,
	reference: { projectPath: string; snapshot: string; maxDimension: number; time?: number },
) {
	const original = await loadAgentDocument(reference.projectPath);
	if (original.snapshot.sha256 !== reference.snapshot)
		throw new Error("SNAPSHOT_CHANGED: Preview reference changed.");
	const expected = prepareAgentPreview(
		original.document,
		reference.time ?? 0,
		reference.maxDimension,
	).document;
	const derived = await loadAgentDocument(derivedPath);
	const expectedJson = JSON.stringify(expected);
	if (JSON.stringify(derived.document) !== expectedJson)
		throw new Error(
			"PREVIEW_REFERENCE_MISMATCH: Derived project contains changes beyond preview resolution.",
		);
	return createHash("sha256").update(expectedJson).digest("hex");
}

const runProcess: RunProcess = (executable, args, timeoutMs) =>
	new Promise((resolve, reject) => {
		const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"], shell: false });
		let tail = "";
		let expired = false;
		let force: ReturnType<typeof setTimeout> | undefined;
		const timer = setTimeout(() => {
			expired = true;
			child.kill("SIGTERM");
			force = setTimeout(() => child.kill("SIGKILL"), 1000);
		}, timeoutMs);
		child.stdout.on("data", (chunk: Buffer) => {
			tail = (tail + chunk.toString()).slice(-2048);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			tail = (tail + chunk.toString()).slice(-2048);
		});
		child.once("error", (error) => {
			clearTimeout(timer);
			if (force) clearTimeout(force);
			reject(error);
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			if (force) clearTimeout(force);
			if (expired || code !== 0)
				reject(
					new Error(expired ? "PREVIEW_TIMEOUT" : `PREVIEW_RENDER_FAILED: ${tail.slice(-512)}`),
				);
			else resolve();
		});
	});

export async function renderAgentPreview(
	options: {
		projectPath: string;
		snapshot: string;
		outputDirectory: string;
		/** Export/output seconds (bare number, documented) or a suffixed e/r/s time. */
		time: number | TimeInput;
		maxDimension?: number;
		launch: AgentPreviewLaunch;
	},
	dependencies: { run?: RunProcess } = {},
) {
	const loaded = await loadAgentDocument(options.projectPath);
	if (loaded.snapshot.sha256 !== options.snapshot)
		throw new Error("SNAPSHOT_CHANGED: Inspect the saved project again.");
	const input = parseTimeInput(options.time, "output");
	const time = resolveExportSeconds(loaded.document, input);
	const resolution: ResolvedInstant | undefined =
		input.base === "output"
			? undefined
			: resolveTimelineInstant(loaded.document, {
					seconds: resolveEditedSeconds(loaded.document, input),
					base: "edited",
				});
	const prepared = prepareAgentPreview(loaded.document, time, options.maxDimension);
	const run = dependencies.run ?? runProcess;
	await fs.mkdir(options.outputDirectory, { recursive: true });
	const directory = await fs.mkdtemp(path.join(options.outputDirectory, "klippt-preview-"));
	const project = path.join(directory, "snapshot.klippt");
	const frame = path.join(directory, "frame.png");
	const manifestPath = path.join(directory, "manifest.json");
	try {
		await fs.writeFile(project, JSON.stringify(prepared.document), { flag: "wx", mode: 0o600 });
		await run(
			options.launch.executable,
			[
				...options.launch.args,
				"export",
				project,
				"--out",
				frame,
				"--agent-preview-time",
				String(time),
				"--quality",
				"source",
				"--agent-preview-reference",
				options.projectPath,
				"--agent-preview-snapshot",
				options.snapshot,
				"--agent-preview-max-dimension",
				String(options.maxDimension ?? 1280),
				"--json",
			],
			90_000,
		);
		const stat = await fs.stat(frame);
		if (stat.size < 24 || stat.size > 8 * 1024 * 1024) throw new Error("PREVIEW_INVALID_FRAME");
		const png = await fs.readFile(frame);
		if (
			png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
			png.readUInt32BE(16) !== prepared.output.width ||
			png.readUInt32BE(20) !== prepared.output.height
		)
			throw new Error("PREVIEW_FRAME_DIMENSIONS_MISMATCH");
		if ((await loadAgentDocument(options.projectPath)).snapshot.sha256 !== options.snapshot)
			throw new Error("SNAPSHOT_CHANGED: Project changed while rendering.");
		const manifest = {
			kind: "composed_frame",
			snapshot: options.snapshot,
			source_project: options.projectPath,
			frame_path: frame,
			manifest_path: manifestPath,
			requested_edited_time_sec: time,
			frame_time_sec: prepared.frameTime,
			fps: 60,
			output: prepared.output,
			project_edited_duration_sec: prepared.duration,
			// The export clock is NOT the editor clock: speed regions shift it.
			// requested_edited_time_sec is a legacy field name for export/output
			// seconds; frame(s) --at converts the editor clock instead.
			time_bases: {
				requested_edited_time_sec: TIME_BASE_LABELS.output,
				frame_time_sec: TIME_BASE_LABELS.output,
				project_edited_duration_sec: TIME_BASE_LABELS.output,
			},
			...(resolution ? { requested_time: resolution } : {}),
			sha256: createHash("sha256").update(png).digest("hex"),
			renderer: "native_offscreen_compositor_still",
			limitations: [
				"Preview resolution is bounded; inspect a finished export for final-resolution pixel quality.",
				"A frame verifies one instant, not animation continuity or audio.",
				"Project content hash binds the document; external media files are not content-hashed.",
			],
		};
		await fs.writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, { flag: "wx", mode: 0o600 });
		return manifest;
	} catch (error) {
		await fs.rm(directory, { recursive: true, force: true });
		throw error;
	} finally {
		await fs.unlink(project).catch(() => undefined);
	}
}

/** Main alone chooses the path and checks the hash-bound output dimensions. */
export async function publishAgentPreviewFrame(
	projectPath: string,
	reference: {
		projectPath: string;
		snapshot: string;
		maxDimension: number;
		time?: number;
		verifiedDocumentHash?: string;
	},
	outPath: string | null,
	dataUrl: string | undefined,
) {
	if (
		!reference.verifiedDocumentHash ||
		reference.time === undefined ||
		!outPath ||
		path.extname(outPath).toLowerCase() !== ".png"
	)
		throw new Error("PREVIEW_REFERENCE_MISMATCH");
	if (
		(await verifyAgentPreviewReference(projectPath, reference)) !== reference.verifiedDocumentHash
	)
		throw new Error("PREVIEW_REFERENCE_MISMATCH");
	if (
		typeof dataUrl !== "string" ||
		dataUrl.length > 12 * 1024 * 1024 ||
		!/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(dataUrl)
	)
		throw new Error("PREVIEW_INVALID_FRAME");
	const png = Buffer.from(dataUrl.slice("data:image/png;base64,".length), "base64");
	const original = await loadAgentDocument(reference.projectPath);
	if (original.snapshot.sha256 !== reference.snapshot) throw new Error("SNAPSHOT_CHANGED");
	const { output } = prepareAgentPreview(original.document, reference.time, reference.maxDimension);
	if (
		png.length < 24 ||
		png.length > 8 * 1024 * 1024 ||
		png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
		png.readUInt32BE(16) !== output.width ||
		png.readUInt32BE(20) !== output.height
	)
		throw new Error("PREVIEW_FRAME_DIMENSIONS_MISMATCH");
	await fs.writeFile(outPath, png, { flag: "wx", mode: 0o600 });
	return output;
}
