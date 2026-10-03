/** Synthetic editable fixture, never a production project writer. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { prepareAgentEditPlan } from "../electron/ai-edition/agentEditPlan";
import {
	createEmptyDocument,
	documentSchema,
	migrateRawDocumentToCurrent,
} from "../src/lib/ai-edition/schema";

const root = path.resolve(process.cwd(), "artifacts/agent-proof-2026-09-07");
const force = process.argv.slice(2).includes("--force");
const proofOnly = process.argv.slice(2).includes("--proof-only");
if (process.argv.slice(2).some((arg) => arg !== "--force" && arg !== "--proof-only"))
	throw new Error("Usage: bundled create-agent-proof-project [--force] [--proof-only]");
const targets = [
	...(proofOnly ? [] : ["baseline.klippt"]),
	"proof.klippt",
	"project-manifest.json",
];
if (!force && targets.some((name) => existsSync(path.join(root, name))))
	throw new Error("Proof project exists. Use --force for these synthetic fixture files only.");
const hash = (name: string) =>
	createHash("sha256")
		.update(readFileSync(path.join(root, name)))
		.digest("hex");
function metadata(name: string) {
	const source = path.join(root, name);
	const probe = spawnSync(
		"/opt/homebrew/bin/ffprobe",
		["-v", "error", "-show_streams", "-show_format", "-of", "json", source],
		{ encoding: "utf8" },
	);
	if (probe.status !== 0) throw new Error(probe.stderr || "ffprobe failed");
	const data = JSON.parse(probe.stdout) as {
		streams: {
			codec_type: string;
			codec_name: string;
			width: number;
			height: number;
			avg_frame_rate: string;
		}[];
		format: { duration: string };
	};
	const video = data.streams.find((stream) => stream.codec_type === "video");
	if (!video) throw new Error(`No video stream in ${name}`);
	const [num, den] = video.avg_frame_rate.split("/").map(Number);
	return {
		originalPath: source,
		durationSec: Number(data.format.duration),
		sizeBytes: statSync(source).size,
		video: { width: video.width, height: video.height, fps: num / den, codec: video.codec_name },
	};
}
const sourceHashes = Object.fromEntries(
	["screen.mp4", "test-camera.mp4", "diagram.png", "music-bed.wav", "cue.wav"].map((name) => [
		name,
		hash(name),
	]),
);
const baselineBefore = proofOnly ? readFileSync(path.join(root, "baseline.klippt"), "utf8") : null;
const baseline = documentSchema.parse(
	baselineBefore
		? migrateRawDocumentToCurrent(JSON.parse(baselineBefore))
		: {
				...createEmptyDocument({
					projectId: "proof_project_20260907",
					title: "Agent editing proof — synthetic source",
					createdAt: "2026-09-07T00:00:00.000Z",
				}),
				project: {
					id: "proof_project_20260907",
					title: "Agent editing proof — synthetic source",
					primaryAssetId: "proof_screen",
					createdAt: "2026-09-07T00:00:00.000Z",
					updatedAt: "2026-09-07T00:00:00.000Z",
				},
				assets: [
					{
						id: "proof_screen",
						kind: "video",
						label: "Synthetic concept cards",
						...metadata("screen.mp4"),
						cameraTrack: {
							sourcePath: path.join(root, "test-camera.mp4"),
							startMs: 0,
							offsetMs: 0,
							visible: true,
						},
					},
					{
						id: "proof_camera",
						kind: "video",
						label: "TEST CAMERA — geometric source",
						...metadata("test-camera.mp4"),
					},
				],
				timeline: {
					clips: [
						{
							id: "proof_clip",
							assetId: "proof_screen",
							sourceStartSec: 0,
							sourceEndSec: 24,
							timelineStartSec: 0,
							timelineEndSec: 24,
							origin: "user",
							reason: "Original synthetic source; effects remain editable",
						},
					],
				},
			},
);
const operations = [
	{
		type: "set-layout",
		settings: {
			aspectRatio: "16:9",
			outputResolution: { width: 1920, height: 1080 },
			webcamLayoutPreset: "picture-in-picture",
			webcamPosition: { cx: 0.86, cy: 0.17 },
			webcamSizePreset: 40,
			webcamReactiveZoom: false,
			webcamMaskShape: "rounded",
			padding: 8,
		},
	},
	{
		type: "addAnnotation",
		args: {
			startSec: 0,
			endSec: 2,
			text: "ONE PROJECT. REAL EDITS.",
			position: { x: 17.5, y: 82 },
			size: { width: 65, height: 7 },
			style: { textAnimation: "rise", fontSize: 42, color: "#82dfca" },
		},
	},
	{
		type: "addZoom",
		args: {
			startSec: 2.5,
			endSec: 5.5,
			depth: 2,
			focus: { cx: 0.2, cy: 0.55 },
			customScale: 1.5,
			motionStyle: "smooth",
		},
	},
	{
		type: "addZoom",
		args: {
			startSec: 7,
			endSec: 10,
			depth: 2,
			focus: { cx: 0.5, cy: 0.55 },
			customScale: 1.5,
			motionStyle: "snappy",
		},
	},
	{
		type: "addZoom",
		args: {
			startSec: 11.5,
			endSec: 14.5,
			depth: 2,
			focus: { cx: 0.8, cy: 0.55 },
			customScale: 1.5,
			motionStyle: "linear",
		},
	},
	{ type: "addCameraFullscreen", args: { startSec: 16, endSec: 19 } },
	{
		type: "addCameraFullscreen",
		args: { startSec: 5.8, endSec: 6.9, mode: "emphasis", cameraScale: 1.5, motionStyle: "smooth" },
	},
	{
		type: "addAnnotation",
		args: {
			startSec: 20,
			endSec: 24,
			imageDataUrl: `data:image/png;base64,${readFileSync(path.join(root, "diagram.png")).toString("base64")}`,
			position: { x: 15, y: 81 },
			size: { width: 70, height: 14 },
			style: { textAnimation: "pop" },
		},
	},
	{
		type: "addAnnotation",
		args: {
			startSec: 20,
			endSec: 24,
			text: "Inspect → Edit → Verify",
			position: { x: 17.5, y: 24.5 },
			size: { width: 65, height: 5 },
			style: { textAnimation: "typewriter", fontSize: 42 },
		},
	},
];
const audioAssets = [
	{
		id: "proof_music",
		label: "Original synthetic music",
		originalPath: path.join(root, "music-bed.wav"),
		durationSec: 24,
	},
	{
		id: "proof_cue",
		label: "Original synthetic cue",
		originalPath: path.join(root, "cue.wav"),
		durationSec: 0.65,
	},
];
const audioOperations = [
	{
		type: "addAudioClip",
		args: {
			assetId: "proof_music",
			startSec: 0,
			endSec: 24,
			sourceOffsetSec: 0,
			gain: 0.35,
			fadeInSec: 1,
			fadeOutSec: 2,
		},
	},
	...[2.5, 7, 11.5, 20].map((startSec) => ({
		type: "addAudioClip",
		args: {
			assetId: "proof_cue",
			startSec,
			endSec: startSec + 0.65,
			sourceOffsetSec: 0,
			gain: 0.5,
			fadeInSec: 0.01,
			fadeOutSec: 0.2,
		},
	})),
];
const prepared = prepareAgentEditPlan({ ...baseline, audioAssets }, [
	...operations,
	...audioOperations,
]);
const exportCandidate = prepared.candidate;
if (
	prepared.candidate.zoomRanges.length !== 3 ||
	prepared.candidate.annotations.length !== 3 ||
	prepared.candidate.timeline.clips[0].id !== "proof_clip"
)
	throw new Error("Prepared recipe failed structural verification");
for (const [name, digest] of Object.entries(sourceHashes))
	if (hash(name) !== digest) throw new Error(`Source changed: ${name}`);
const manifest = {
	purpose:
		"Synthetic editable proof fixture; not a claim of a broker commit or GUI Undo verification",
	baseline: path.join(root, "baseline.klippt"),
	proof: path.join(root, "proof.klippt"),
	operations: [...operations, ...audioOperations].map((op) =>
		op.type === "addAnnotation" && op.args && "imageDataUrl" in op.args
			? { ...op, args: { ...op.args, imageDataUrl: "[diagram.png data URL; see source hash]" } }
			: op,
	),
	changed_ids: prepared.changed_ids,
	changed_count: prepared.changed_count,
	export_settings: {
		cliQuality: "source",
		note: "Pass --quality source to the export command; visual regions are authored through the edit plan.",
	},
	source_hashes: sourceHashes,
	pending: [
		"Music and cues are editable audio clips; real playback/export verification is tracked in the implementation log.",
		"Per-interval layout changes are not authored by this recipe.",
		"Image entrance preview/export needs real rendered verification; this recipe only stores the shared animation field.",
		"Normal GUI Undo and CLI commit receipts are not established by offline fixture construction.",
	],
};
for (const [name, value] of [
	["baseline.klippt", baseline],
	["proof.klippt", exportCandidate],
	["project-manifest.json", manifest],
] as const) {
	if (proofOnly && name === "baseline.klippt") continue;
	writeFileSync(path.join(root, name), `${JSON.stringify(value, null, 2)}\n`, {
		flag: force ? "w" : "wx",
	});
}
if (
	baselineBefore !== null &&
	readFileSync(path.join(root, "baseline.klippt"), "utf8") !== baselineBefore
)
	throw new Error("Baseline changed during proof-only regeneration");
console.log(
	JSON.stringify(
		{ ...manifest, operations: `[${operations.length} operations; see project-manifest.json]` },
		null,
		2,
	),
);
