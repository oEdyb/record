import { z } from "zod";
import { zoomRegionSchema } from "../../src/lib/ai-edition/schema";
import { MOTION_SPEED_VALUES } from "../../src/lib/zoomMath/motionCurve";
import {
	AGENT_EDIT_OPERATION_TYPES,
	agentEditOperationSchema,
	agentLayoutSettingsSchema,
} from "../ai-edition/agentEditPlan";
import { clipCommandInput } from "./agentClip";
import { type CommandPolicy, commandPolicies } from "./agentCommandPolicy";
import { cutPointCommandInput } from "./agentCutPoint";
import { edgesCommandInput } from "./agentEdges";
import { checkCommandInput, stateCommandInput } from "./agentEditState";
import { layoutCommandInput } from "./agentLayout";
import { AGENT_OUTPUT_CONTRACT } from "./agentOutputContract";
import { pausesCommandInput } from "./agentPauses";
import {
	brollCommandInput,
	cameraCommandInput,
	placementTime,
	textCommandInput,
	zoomCommandInput,
} from "./agentPlacement";
import {
	autoCommandInput,
	presetCommandInput,
	settingsCommandInput,
} from "./agentSettingsCommands";
import { shotCommandInput } from "./agentShot";
import { timeInputSchema } from "./agentTimeBase";
import { transportCommandInput } from "./agentTransportCommand";
import { verifyCommandInput } from "./agentVerify";

const parseFrameTime = (value: string) => placementTime.parse(value);

/** Plain numeric strings keep the command's documented default base as numbers;
 * m:ss.s and e/r/s-suffixed values pass through as strings for the schema. */
const asTimeValue = (value: string) => (/^\d+(?:\.\d+)?$/.test(value) ? Number(value) : value);

export const AGENT_API_VERSION = "1.0";

const cutIds = z
	.string()
	.min(1)
	.transform((value) => value.split(",").map((id) => id.trim()))
	.pipe(z.array(z.string().min(1).max(512)).min(1).max(500));

const projectPath = z.string().min(1).max(4096);
const offset = z.number().int().min(0).max(1_000_000).default(0);
const limit = z.number().int().min(1).max(100).default(25);
const snapshot = z
	.string()
	.regex(/^[a-f0-9]{64}$/)
	.optional();

/** The installed command registry is also the source for machine-readable discovery. */
const restoreInput = z.strictObject({
	project_id: z.string().min(1).max(256),
	steps: z.number().int().min(1).max(50).optional(),
	force: z.boolean().default(false),
	request_id: z.string().min(1).max(128).optional(),
});
export const agentCommands = {
	doctor: {
		policy: commandPolicies.discovery,
		description:
			"Inspect command readiness without restarting, seeking, or switching projects. --live checks live frame requirements for shot. Unknown components never count as ready.",
		input: z.strictObject({
			command: z
				.string()
				.min(1)
				.refine((name): boolean => Object.keys(agentCommands).includes(name), "Unknown command"),
			live: z.boolean().default(false),
		}),
	},
	settings: {
		policy: commandPolicies.settings,
		description:
			"settings: every global setting with current/default values, ranges, units and meanings. settings set key=value ...: guarded, undoable writes; cursor.size and captions.fontSize accept dotted keys.",
		input: settingsCommandInput,
	},
	preset: {
		policy: commandPolicies.preset,
		description:
			"preset list; preset save NAME --project_id ID; preset apply NAME --project_id ID; preset delete NAME. Agent presets are stored per user; UI presets are readable. Apply is guarded and undoable. --source ui|agent selects a library.",
		input: presetCommandInput,
	},
	auto: {
		policy: commandPolicies.motion,
		description:
			"auto run|remove|regenerate --project_id ID [--settings JSON]. Settings are {policy: overrides, presetId?: string|null}. Uses recorded activity, preserves manual regions, and returns apply verification and region counts.",
		input: autoCommandInput,
	},
	clip: {
		policy: commandPolicies.general,
		description:
			"clip replace --clip ID --file /absolute/video: replace source, retain fitting trims and overlays, report losses, then verify.",
		input: clipCommandInput,
	},
	history: {
		policy: commandPolicies.live,
		description: "List the last 50 agent writes, newest first.",
		input: z.strictObject({ project_id: z.string().min(1).max(256) }),
	},
	undo: {
		policy: commandPolicies.general,
		description:
			"Restore before-documents via guarded apply; --steps N or --to APPLY_ID. --force bypasses intervening edit refusal.",
		input: restoreInput
			.extend({ to: z.string().uuid().optional() })
			.refine((v) => !(v.to && v.steps), "Use --steps or --to, not both"),
	},
	redo: {
		policy: commandPolicies.general,
		description: "Reapply undone after-documents; --steps N, optional --force.",
		input: restoreInput,
	},
	text: {
		policy: commandPolicies.visual,
		description:
			"text add: edited-time or word-anchored text with safe margins; plan checks then guarded apply.",
		input: textCommandInput,
	},
	broll: {
		policy: commandPolicies.motion,
		description:
			"broll add/swap. broll swap --overlay ID --file /absolute/video.mp4. Swap keeps placement, clip, motion and opacity. --fit auto (default) covers within 8% aspect difference, otherwise contains; cover/contain force it. --offset seconds defaults to 0; --time trim (default) shortens to available media, hold keeps the last frame. At most 0.5s available fails MEDIA_TOO_SHORT. Use remove + add to create a different slot.",
		input: brollCommandInput,
	},
	zoom: {
		policy: commandPolicies.motion,
		description:
			"zoom add: --at, --from/--to, or --words; speed quick/normal/slow, size S/M/L/XL; minimum 0.8 seconds.",
		input: zoomCommandInput,
	},
	camera: {
		policy: commandPolicies.motion,
		description:
			"camera set: full/emphasis over --at, --from/--to, or --words; minimum 0.8 seconds.",
		input: cameraCommandInput,
	},
	assets: {
		policy: commandPolicies.render,
		description: "List project assets with first/middle cached 320px JPEG thumbnails.",
		input: z.strictObject({ project_id: z.string().min(1).max(256) }),
	},
	frame: {
		policy: commandPolicies.render,
		description:
			"Render a composited PNG at edited --at time (seconds, m:ss.s, r/s suffixes). Returns measured milliseconds.",
		input: z.strictObject({
			project_id: z.string().min(1).max(256),
			at: placementTime,
			out: z.string().min(1).optional(),
		}),
	},
	frames: {
		policy: commandPolicies.render,
		description:
			"Render composited frames at comma-separated edited times (m:ss.s, r/s suffixes) plus a contact sheet.",
		input: z.strictObject({
			project_id: z.string().min(1).max(256),
			at: z
				.string()
				.min(1)
				.transform((v) => v.split(",").map(parseFrameTime)),
			out: z.string().min(1).optional(),
		}),
	},
	live: {
		policy: commandPolicies.live,
		description: "Inspect the open editor through the opt-in app-owned broker.",
		input: z.strictObject({}),
	},
	staged: {
		policy: commandPolicies.live,
		description: "List proposed cuts. Includes source and edited times.",
		input: z.strictObject({
			project_id: z.string().min(1).max(256),
			offset: z.number().int().min(0).max(1_000_000).optional(),
		}),
	},
	accept: {
		policy: commandPolicies.speech,
		description:
			"Accept proposed cuts. One undo step; optional --ids a,b; otherwise accepts selected and clears the lane.",
		input: z.strictObject({
			project_id: z.string().min(1).max(256),
			ids: cutIds.optional(),
			request_id: z.string().min(1).max(128).optional(),
		}),
	},
	reject: {
		policy: commandPolicies.reject,
		description: "Reject proposed cuts. Requires --ids a,b; remembered per project.",
		input: z.strictObject({ project_id: z.string().min(1).max(256), ids: cutIds }),
	},
	plan: {
		policy: commandPolicies.plan,
		description:
			"Prepare operations from JSON. --stage puts only addTrim/setTrim operations in the review lane without writing the document.",
		input: z.strictObject({
			project_id: z.string().min(1),
			input: projectPath,
			stage: z.boolean().optional(),
		}),
	},
	"import-plan": {
		policy: commandPolicies.plan,
		description:
			"Prepare image/audio/video JSON {kind,path,placement} for plan/apply. Absolute paths; images <=512 KiB, PNG/JPEG or decoder-supported WebP. Image/video use raw seconds and percent boxes; audio uses edited seconds. Video B-roll overlay is silent; inspect the candidate before apply.",
		input: z.strictObject({ project_id: z.string().min(1).max(256), input: projectPath }),
	},

	apply: {
		policy: commandPolicies.general,
		description:
			"Apply a prepared plan once. Requires the running opt-in editor; preserve request_id for recovery. --deep adds a decoded content pass over the touched span to the verify block.",
		input: z.strictObject({
			project_id: z.string().min(1),
			plan_id: z.string().min(1),
			force: z.boolean().optional(),
			deep: z.boolean().optional(),
			request_id: z.string().min(1).max(256),
		}),
	},
	verify: {
		policy: commandPolicies.verify,
		description:
			"verify --range a b: decode the real media at every cut and overlay edge in the edited-time range with ffmpeg. cut.clipped-word (error) when the level 0–120 ms after an out point stays within 15 dB of the word tail; frame.black/frame.identical (warning) from sampled frames. Frames plus a filmstrip with waveforms land in --out or the agent cache. Times accept m:ss.s and e/r/s suffixes. Read-only; at most 100 edges per run. Exits 0 with findings present: read data.findings/data.counts, not the exit code. A data.status of 'unavailable' means the range was NOT content-verified (see the error-level content.unavailable findings) — never a pass.",
		input: verifyCommandInput,
	},
	shot: {
		policy: commandPolicies.shot,
		description:
			'shot --project_id ID --at 3:50 | --words "…" [--live]: one instant on all three time bases (103e/1:43 edited, 125.3r raw, 10.4s source) — project id, revision, dirty flag, visible layers with sizes and anchors, transcript ±5 s, nearest cuts, staged proposals in range, and one image: the saved render by default, or --live seeks the editor and grabs the live canvas frame. The reply says which (image.source + evidence). A --live image carries image.frame_settled and image.freshness: "settled" when the frame is proven to postdate the seek; "possibly_stale" with image.freshness_note otherwise (frame_settled is false on older shells — never silent).',
		input: shotCommandInput,
	},
	batch: {
		policy: commandPolicies.general,
		description:
			"batch --input steps.json [--stop-on error|warning] [--verbosity summary|full]: run a JSON array of agent commands in order against the live editor. Every step is validated before any write runs; steps without --request_id join one undo group (undo --to <batch_id>). One summary envelope reports per-step status, exit codes, introduced findings, before/after hashes, rendered frames, and the first failure. Nested batch steps are rejected.",
		input: z.strictObject({
			input: projectPath,
			stop_on: z.enum(["error", "warning"]).default("error"),
			verbosity: z.enum(["summary", "full"]).default("summary"),
		}),
	},
	receipt: {
		policy: commandPolicies.live,
		description: "Recover a prior mutation result using the original request ID.",
		input: z.strictObject({
			project_id: z.string().min(1),
			request_id: z.string().min(1).max(256),
		}),
	},
	open: {
		policy: commandPolicies.open,
		description:
			"Open a project by ID in the running editor (opens the editor window when only the recorder is showing). Use clone first to work on a copy.",
		input: z.strictObject({ project_id: z.string().min(1).max(256) }),
	},
	clone: {
		policy: commandPolicies.clone,
		description:
			"Copy a saved project file into the app's projects folder under a new project ID without touching media or the original. Returns the new ID and path.",
		input: z.strictObject({ project: projectPath, title: z.string().min(1).max(256).optional() }),
	},
	transcribe: {
		policy: commandPolicies.general,
		description:
			"Ask the open editor to transcribe every timeline asset that has no stored transcript, then report per-asset status. Repeat the command to poll; it never restarts a running job.",
		input: z.strictObject({ project_id: z.string().min(1).max(256) }),
	},
	pauses: {
		policy: commandPolicies.proposal,
		description:
			'Ask the open editor to find shortenable pauses with the editor\'s own detector (preset natural|balanced|tight, optional overrides) and return paged suggestions plus ready addTrim operations. Repeat until status is ready. A ready page stages its operations into the proposal lane by default — nothing is written; review with staged, then accept or reject. --accept "<reason>" applies the page directly.',
		input: pausesCommandInput,
	},
	edges: {
		policy: commandPolicies.proposal,
		description:
			'Cut take edges from speech detection and internal microphone gaps >= --min_gap (0 disables gaps). Keep --pad_before/--pad_after; skip clips > --max_clip_sec. Suggested trims stage into the proposal lane by default — nothing is written; review with staged, then accept or reject. --accept "<reason>" applies directly. --remove true reverses these trims with a direct guarded apply.',
		input: edgesCommandInput,
	},
	state: {
		policy: commandPolicies.live,
		description:
			"Read scene state at edited --at seconds or m:ss.s; r/s suffixes name raw/source. Optional --range from to. The reply carries all three bases.",
		input: stateCommandInput,
	},
	layout: {
		policy: commandPolicies.motion,
		description:
			"layout set --scope project|clip:ID: guarded plan/apply, then state at the clip's first kept second. Keep --request_id for recovery.",
		input: layoutCommandInput,
	},
	check: {
		policy: commandPolicies.analysis,
		description:
			"Run paged checks with --all, --range from to, or --rule id. Poll by repeating. --deep adds speech analysis; --explain RULE describes a rule without a project. --rule reply.time-base audits replies for unlabeled *Sec fields. Always exits zero.",
		input: checkCommandInput,
	},
	cutpoint: {
		policy: commandPolicies.proposal,
		description:
			'Where a sentence really ends or starts near --time in --clip: bare numbers stay source seconds (compatibility); 103e/1:43 (edited) and 125.3r (raw) convert, and the reply carries all three bases. The transcript picks the nearest sentence boundary, the microphone level finds the last sound of it (--edge out) or the first sound of the next one (--edge in), and cut_sec adds --pad_after / --pad_before. A chosen cut stages the footage it removes into the proposal lane by default — nothing is written; review with staged, then accept or reject. --accept "<reason>" applies directly. Repeat until status is ready.',
		input: cutPointCommandInput,
	},
	transport: {
		policy: commandPolicies.transport,
		description:
			'Run editor transport steps from --script JSON: play, pause, seek(sec raw; "1:43"/e/s forms convert), wait(ms), sample(label), probe(ms). Reports playback/media state and frame timing. Seek replies carry all three bases. At most 50 steps and 60 s waiting. Repeat until ready. See agent-cli.md for click, wheel, and frame sampling.',
		input: transportCommandInput,
	},
	contracts: {
		policy: commandPolicies.discovery,
		description: "List all command input schemas.",
		input: z.strictObject({}),
	},
	skill: {
		policy: commandPolicies.discovery,
		description: "Read bundled CLI instructions.",
		input: z.strictObject({}),
	},
	guide: {
		policy: commandPolicies.discovery,
		description: "--command: schema; --skill: bundled instructions.",
		input: z
			.strictObject({
				skill: z.boolean().optional(),
				command: z
					.string()
					.min(1)
					.max(100)
					.refine((name): boolean => Object.keys(agentCommands).includes(name), "Unknown command")
					.optional(),
			})
			.refine((input) => !(input.skill && input.command), "Use --skill or --command, not both"),
	},
	operations: {
		policy: commandPolicies.discovery,
		description:
			"List supported edit operation types, or get one operation schema with --type. No broker required.",
		input: z.strictObject({ type: z.enum(AGENT_EDIT_OPERATION_TYPES).optional() }),
	},
	inspect: {
		policy: commandPolicies.saved,
		description: "Inspect a saved project snapshot without loading media or starting analysis.",
		input: z.strictObject({ project: projectPath }),
	},
	timeline: {
		policy: commandPolicies.saved,
		description:
			"Read clips plus separately paged effect/audio lanes from a saved snapshot. Use each lane next_offset as --offset; IDs are edit targets, offsets are read positions.",
		input: z.strictObject({ project: projectPath, offset, limit, snapshot }),
	},
	item: {
		policy: commandPolicies.saved,
		description: "Read one clip, asset, or effect by its exact stable ID.",
		input: z.strictObject({ project: projectPath, id: z.string().min(1).max(256), snapshot }),
	},
	transcript: {
		policy: commandPolicies.saved,
		description:
			"Read saved source-time words: --clip ID for one clip or --all for every clip and derived sentences. Use --project PATH or --project_id ID. --all pages stay below 48 KiB; follow next_page with --page and reuse --snapshot.",
		input: z
			.strictObject({
				project: projectPath.optional(),
				project_id: z
					.string()
					.regex(/^[A-Za-z0-9_-]+$/)
					.max(256)
					.optional(),
				all: z.boolean().default(false),
				page: z.number().int().min(1).max(1000000).default(1),
				clip: z.string().min(1).max(256).optional(),
				offset,
				limit: z.number().int().min(1).max(500).default(200),
				min_gap: z.number().finite().min(0.05).max(60).default(0.5),
				snapshot,
			})
			.refine((v) => Boolean(v.project) !== Boolean(v.project_id), "Use --project or --project_id.")
			.refine((v) => v.all !== Boolean(v.clip), "Use --all or --clip."),
	},
	media: {
		policy: commandPolicies.saved,
		description:
			"List candidate image, video and audio files in a supplied folder; never import or decode them.",
		input: z.strictObject({
			directory: projectPath,
			depth: z.number().int().min(0).max(5).default(0),
			limit,
		}),
	},
	preview: {
		policy: commandPolicies.render,
		description:
			"Render one composed PNG at export/output time from a hash-bound saved project. --time is speed-adjusted output seconds when bare; e/r/s suffixes convert through the timeline. Experimental: seeks one native still frame; at most 128 clips, 128 assets, and 1280 pixels per side. Requires a current native build.",
		input: z.strictObject({
			project: projectPath,
			snapshot: snapshot.unwrap(),
			time: timeInputSchema("output"),
			out: projectPath,
			max_dimension: z.number().int().min(256).max(1280).default(1280),
		}),
	},

	geometry: {
		policy: commandPolicies.saved,
		description:
			"Evaluate planned compositor placement at source time without decoding an image. --time is source seconds when bare; e/r suffixes convert and select the clip they land in. Unknown metadata or cursor evidence is reported unavailable.",
		input: z.strictObject({
			project: projectPath,
			clip: z.number().int().nonnegative().default(0),
			time: timeInputSchema("source"),
			snapshot,
		}),
	},
} as const satisfies Record<
	string,
	{ description: string; input: z.ZodType; policy: CommandPolicy }
>;

export type AgentCommandName = keyof typeof agentCommands;
export type AgentCommandInput = {
	[K in AgentCommandName]: { command: K; input: z.infer<(typeof agentCommands)[K]["input"]> };
}[AgentCommandName];

export interface CliAgentCommand {
	kind: "agent";
	args: string[];
	cwd: string;
	json: boolean;
}

export function agentGuide(commandName?: string, includeSchemas = false) {
	const selected = commandName ? agentCommands[commandName as AgentCommandName] : undefined;
	if (commandName && !selected) throw new Error("Unknown command");
	return {
		api_version: AGENT_API_VERSION,
		state: "experimental_editor_bridge",
		usage: "klippt agent <command> [--json]",
		output_contract: AGENT_OUTPUT_CONTRACT,
		capabilities: {
			saved_project_inspection: true,
			edit: "experimental_opt_in",
			planned_geometry: true,
			media_catalog: true,
			broll_swap: true,
			media_import: "image/audio/video import-plan; video becomes a B-roll overlay (schema 11)",
			rendered_visual_verification:
				"preview: one PNG at speed-adjusted output time, including long recordings; bounded native still render",
		},
		activation:
			"Start with OPENSCREEN_AGENT_CLI=1 and keep a clean project open. Discovery and saved reads do not start the GUI.",
		commands: (selected ? [[commandName!, selected] as const] : Object.entries(agentCommands)).map(
			([name, command]) => ({
				name,
				...(selected || includeSchemas ? command.policy : {}),
				description:
					selected || includeSchemas
						? command.description
						: command.description.split(/(?<=\.)\s/)[0],
				...(selected || includeSchemas
					? { input_schema: z.toJSONSchema(command.input, { io: "input" }) }
					: {}),
			}),
		),
		limits: {
			broll_swap_min_sec: 0.5,
			broll_swap_aspect_tolerance: 0.08,
			page_items: 100,
			default_page_items: 25,
			operations_per_plan: 500,
			plan_input_bytes: 1048576,
			import_image_bytes: 524288,
			experimental_candidate_bytes: 2097152,
			plan_lifetime_seconds: 1800,
		},
		workflow: [
			"guide --command plan; operations --type <name>",
			"live; inspect/timeline/item/transcript --project <saved-file>",
			"Write a JSON array of operations; plan --project_id <id> --input <operations.json>",
			"Review cuts: plan --stage; staged; accept; reject --ids a,b",
			"Inspect/render the returned candidatePath before apply",
			"apply --project_id <id> --plan_id <id> --request_id <unique-stable-id>",
			"If the result is unknown, timed out, or the plan expired: receipt --project_id <id> --request_id <original-id> before any new edit",
		],
		revisions:
			"Plans retain the exact prepared candidate and saved revision. Apply refuses a stale revision; preserve the request ID for replay/recovery. Saved snapshot hashes are read guards, not live mutation revisions.",
	};
}

export function agentOperations(type?: string) {
	const selected = type
		? agentEditOperationSchema.options.find((option) => option.shape.type.value === type)
		: undefined;
	if (type && !selected) throw new Error("Unknown operation type");
	return {
		api_version: AGENT_API_VERSION,
		operation_types: selected ? [type] : AGENT_EDIT_OPERATION_TYPES,
		...(selected
			? {
					input_schema: z.toJSONSchema(selected, {
						io: "input",
						unrepresentable: "any",
						override: ({ zodSchema, jsonSchema }) => {
							if (zodSchema === agentLayoutSettingsSchema.shape.aspectRatio.unwrap())
								Object.assign(jsonSchema, {
									type: "string",
									description:
										"Explicit positive finite W:H ratio; decimal values allowed, for example 9:16 or 683:384. Legacy native is rejected.",
								});
							else if (zodSchema === zoomRegionSchema.shape.motionSpeed.unwrap())
								Object.assign(jsonSchema, { type: "number", enum: [...MOTION_SPEED_VALUES] });
							else if (zodSchema._zod.def.type === "custom")
								throw new Error("Unsupported custom discovery schema");
						},
					}),
				}
			: {}),
		units: {
			zoom_annotation_camera_startSec_endSec:
				"seconds on the document raw timeline (timelineStartSec/timelineEndSec), before trim/speed playback mapping; not final edited playback time",
			trim_startSec_endSec: "seconds in the source asset; addTrim requires the exact clipId",
			setClipRange: "sourceStartSec/sourceEndSec are seconds in the source asset",
			geometry_time: "seconds in the source asset of the selected clip",
			preview_time: "seconds on final edited playback after trims and speed mapping",
			focus_webcam_crop:
				"normalized coordinates 0..1; focus/webcam cx,cy are centers; crop x,y are top-left",
			annotation_position_size:
				"percent 0..100 of the output canvas; position x,y is top-left; size width,height is extent",
			customScale: "zoom multiplier; takes precedence over depth",
			audio_clips:
				"startSec/endSec are final output playback seconds; sourceOffsetSec is source-audio seconds; gain is linear amplitude 0..4 (1 unchanged); fadeInSec/fadeOutSec are durations in seconds and must fit inside the clip. assetId must name an existing imported audioAsset. No implicit ripple after video edits.",
			outputResolution: "even pixel dimensions; aspectRatio is W:H",
			video_overlays:
				"startSec/endSec are raw timeline seconds like zooms; sourceOffsetSec is the overlay's own source time at startSec; placement is percent of the screen layer (null fills it); the overlay never carries audio",
			splitClip: "sourceTimeSec is seconds in the source asset; the left half keeps the clip ID",
			removeTrims:
				"one batch delete by exact id; unlike removeTrim it never widens to the touching trim on a neighbouring clip",
		},
		validation:
			"Unknown fields are rejected. End must exceed start; ranges must stay within available clips/source. Crop must fit 0..1. Schema refinements and project context are checked during plan. Operations run atomically on a private candidate; this list does not promise every GUI feature.",
		image_input:
			"Inline PNG/JPEG/WebP data URL only; no remote fetch. The 1 MiB plan transport budget includes all inline data. Image bytes are not returned in discovery.",
	};
}

export function parseAgentCommand(args: readonly string[]): AgentCommandInput {
	const name = args[0] ?? "guide";
	if (!Object.keys(agentCommands).includes(name)) {
		throw new Error(`Unknown agent command '${name}'. Use 'klippt agent guide --json'.`);
	}
	const values: Record<string, unknown> = {};
	const seen = new Set<string>();
	const actionCommand =
		["layout", "text", "broll", "zoom", "camera", "clip", "preset", "auto"].includes(name) ||
		(name === "settings" && args[1] === "set");
	if (actionCommand) values.action = args[1];
	for (let i = actionCommand ? 2 : 1; i < args.length; i++) {
		const flag = args[i];
		if (flag === "--json" || flag === "--compact" || flag === "--stream") continue;
		if (name === "camera" && (flag === "full" || flag === "emphasis")) {
			if (values.mode) throw new Error("Duplicate camera mode");
			values.mode = flag;
			continue;
		}
		if (name === "settings" && flag.includes("=") && !flag.startsWith("--")) {
			const assignments = z.array(z.string()).parse(values.assignments ?? []);
			values.assignments = [...assignments, flag];
			continue;
		}
		if (name === "preset" && !flag.startsWith("--")) {
			if (values.name !== undefined) throw new Error("Duplicate preset name");
			values.name = flag;
			continue;
		}
		if (!flag.startsWith("--")) throw new Error(`Expected an option, got '${flag}'.`);
		const key = actionCommand ? flag.slice(2).replace(/-/g, "_") : flag.slice(2);
		if (seen.has(key)) throw new Error(`Duplicate option '${flag}'.`);
		seen.add(key);
		if (
			(key === "skill" && name === "guide") ||
			(key === "stage" && name === "plan") ||
			((key === "all" || key === "deep") && (name === "check" || name === "apply")) ||
			(key === "all" && name === "transcript") ||
			(key === "live" && (name === "shot" || name === "doctor")) ||
			(key === "force" && (actionCommand || ["apply", "undo", "redo"].includes(name)))
		) {
			values[key] = true;
			continue;
		}
		if (key === "range" && (name === "state" || name === "check" || name === "verify")) {
			const from = args[++i];
			const to = args[++i];
			if (!from || !to || from.startsWith("--") || to.startsWith("--"))
				throw new Error("--range requires two times.");
			values[key] = [from, to];
			continue;
		}
		const value = args[++i];
		if (value === undefined || value.startsWith("--")) {
			throw new Error(`${flag} requires a value.`);
		}
		if (name === "auto" && key === "settings") {
			values[key] = JSON.parse(value);
			continue;
		}
		if (name === "layout" && key === "camera_anchor" && value.startsWith("{")) {
			values[key] = JSON.parse(value);
			continue;
		}
		if (name === "layout" && key === "camera_size") {
			values[key] = Number.isFinite(Number(value)) ? Number(value) : value;
			continue;
		}
		values[key] =
			[
				"offset",
				"steps",
				"page",
				"page_size",
				"limit",
				"depth",

				"max_dimension",
				"min_gap",
				"min_pause",
				"shortened",
				"keep_before",
				"keep_after",
				"pad_before",
				"pad_after",
				"max_clip_sec",
				"sentence_gap",
			].includes(key) ||
			(key === "clip" && name !== "transcript" && name !== "cutpoint" && name !== "clip")
				? Number(value)
				: key === "time" && name !== "broll"
					? asTimeValue(value)
					: value;
	}
	// Each branch keeps the discriminant correlated with its validated input.
	switch (name) {
		case "doctor":
			return { command: name, input: agentCommands.doctor.input.parse(values) };
		case "settings":
			return { command: name, input: agentCommands.settings.input.parse(values) };
		case "preset":
			return { command: name, input: agentCommands.preset.input.parse(values) };
		case "auto":
			return { command: name, input: agentCommands.auto.input.parse(values) };
		case "clip":
			return { command: name, input: agentCommands.clip.input.parse(values) };
		case "history":
			return { command: name, input: agentCommands.history.input.parse(values) };
		case "undo":
			return { command: name, input: agentCommands.undo.input.parse(values) };
		case "redo":
			return { command: name, input: agentCommands.redo.input.parse(values) };
		case "text":
			return { command: name, input: agentCommands.text.input.parse(values) };
		case "broll":
			return { command: name, input: agentCommands.broll.input.parse(values) };
		case "zoom":
			return { command: name, input: agentCommands.zoom.input.parse(values) };
		case "camera":
			return { command: name, input: agentCommands.camera.input.parse(values) };
		case "assets":
			return { command: name, input: agentCommands.assets.input.parse(values) };
		case "frame":
			return { command: name, input: agentCommands.frame.input.parse(values) };
		case "frames":
			return { command: name, input: agentCommands.frames.input.parse(values) };

		case "operations":
			return { command: name, input: agentCommands.operations.input.parse(values) };
		case "live":
			return { command: name, input: agentCommands.live.input.parse(values) };
		case "import-plan":
			return { command: name, input: agentCommands["import-plan"].input.parse(values) };
		case "staged":
			return { command: name, input: agentCommands.staged.input.parse(values) };
		case "accept":
			return { command: name, input: agentCommands.accept.input.parse(values) };
		case "reject":
			return { command: name, input: agentCommands.reject.input.parse(values) };
		case "plan":
			return { command: name, input: agentCommands.plan.input.parse(values) };
		case "apply":
			return { command: name, input: agentCommands.apply.input.parse(values) };
		case "verify":
			return { command: name, input: agentCommands.verify.input.parse(values) };
		case "shot":
			return { command: name, input: agentCommands.shot.input.parse(values) };
		case "receipt":
			return { command: name, input: agentCommands.receipt.input.parse(values) };
		case "transcribe":
			return { command: name, input: agentCommands.transcribe.input.parse(values) };
		case "open":
			return { command: name, input: agentCommands.open.input.parse(values) };
		case "clone":
			return { command: name, input: agentCommands.clone.input.parse(values) };
		case "pauses":
			return { command: name, input: agentCommands.pauses.input.parse(values) };
		case "edges":
			return { command: name, input: agentCommands.edges.input.parse(values) };
		case "state":
			return { command: name, input: agentCommands.state.input.parse(values) };
		case "layout":
			return { command: name, input: agentCommands.layout.input.parse(values) };
		case "check":
			return { command: name, input: agentCommands.check.input.parse(values) };
		case "cutpoint":
			return { command: name, input: agentCommands.cutpoint.input.parse(values) };
		case "transport":
			return { command: name, input: agentCommands.transport.input.parse(values) };
		case "contracts":
			return { command: name, input: agentCommands.contracts.input.parse(values) };
		case "skill":
			return { command: name, input: agentCommands.skill.input.parse(values) };
		case "guide":
			return { command: name, input: agentCommands.guide.input.parse(values) };
		case "inspect":
			return { command: name, input: agentCommands.inspect.input.parse(values) };
		case "timeline":
			return { command: name, input: agentCommands.timeline.input.parse(values) };
		case "item":
			return { command: name, input: agentCommands.item.input.parse(values) };
		case "transcript":
			return { command: name, input: agentCommands.transcript.input.parse(values) };
		case "media":
			return { command: name, input: agentCommands.media.input.parse(values) };
		case "preview":
			return { command: name, input: agentCommands.preview.input.parse(values) };
		case "geometry":
			return { command: name, input: agentCommands.geometry.input.parse(values) };
		default:
			throw new Error("Unknown agent command.");
	}
}
