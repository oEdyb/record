import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { app, BrowserWindow, type IpcMain, type IpcMainEvent } from "electron";
import { ZodError, z } from "zod";
import type { CheckRun } from "../../src/lib/ai-edition/agent/agentCheckAnalysis";
import { resolveAgentAutomaticSettings } from "../../src/lib/ai-edition/agent/automaticSettings";
import { agentBuildId } from "../../src/lib/ai-edition/agent/buildIdentity";
import type { StateResult } from "../../src/lib/ai-edition/agent/effectiveState";
import {
	AGENT_SESSION_REPLY,
	AGENT_SESSION_REQUEST,
	type AgentSessionMessage,
	type AgentSessionReply,
} from "../../src/lib/ai-edition/agent/sessionProtocol";
import { stagedOperationsSchema } from "../../src/lib/ai-edition/agent/stagedCuts";
import { type CheckResult } from "../../src/lib/ai-edition/checks";
import { assetFiles } from "../../src/lib/ai-edition/checks/assetFiles";
import {
	type AudioObservation,
	buildResolvedEdit,
	type Span,
} from "../../src/lib/ai-edition/checks/context";
import { type AxcutAsset, documentSchema } from "../../src/lib/ai-edition/schema";
import { visualPresetSchema } from "../../src/lib/ai-edition/store/visualPresets";
import type { RecordedDirectionObservation } from "../../src/lib/ai-edition/timeline/automatic-direction";
import { DEFAULT_CUT_POINT_POLICY } from "../../src/lib/ai-edition/timeline/cut-point";
import { quietSpans } from "../../src/lib/ai-edition/timeline/pause-analysis";
import { inspectBrollSwap } from "../ai-edition/agentBrollSwap";
import { describeAgentSettings } from "../ai-edition/agentEditorSettings";
import { agentEditBatchSchema, prepareAgentEditPlan } from "../ai-edition/agentEditPlan";
import type { AgentHistoryIntent } from "../ai-edition/agentHistory";
import { agentImportRequestSchema, prepareAgentImportPlan } from "../ai-edition/agentImportPlan";
import {
	assertIntroducedChecks,
	boundAgentReply,
	buildVerify,
	introducedFindings,
	PlanCheckError,
	planChecks,
	rangeForDocument,
	touchedSpan,
} from "../ai-edition/agentVerification";
import type { DocumentService } from "../ai-edition/document-service";
import { canonicalTransactionPayload } from "../ai-edition/projectTransactions";
import { getAudioPeaks, resolveFfmpeg } from "../media/audioPeaks";
import { assetThumbnails, prepareStillVideo } from "./agentAssets";
import { startAgentBroker } from "./agentBroker";
import { clipCommandInput } from "./agentClip";
import { cutPointBrokerInput, formatCutPointReport } from "./agentCutPoint";
import { edgesBrokerInput, formatEdgeReport } from "./agentEdges";
import { checkBrokerInput, stateBrokerInput } from "./agentEditState";
import { inspectAgentProject } from "./agentInspection";
import { agentErrorCode, hintForError } from "./agentOutputContract";
import { formatPauseReport, pausesBrokerInput } from "./agentPauses";
import { brollSwapCommandInput, buildPlacement, placementIntentSchema } from "./agentPlacement";
import { captureAgentPreset, createAgentPresetStore, presetOperations } from "./agentPresets";
import { presetCommandInput } from "./agentSettingsCommands";
import {
	findUnbasedSecFields,
	REPLY_TIME_BASE_RULE,
	type ResolvedInstant,
	resolveTimelineInstant,
	TIME_BASE_LABELS,
	type TimeInput,
} from "./agentTimeBase";
import { transportBrokerInput } from "./agentTransportCommand";
import {
	deepContentFindings,
	mergeContentFindings,
	runContentVerification,
	verifyBrokerInput,
} from "./agentVerify";

const id = z.string().min(1).max(256);

/** Experimental app-owned bridge. Opt-in until all writer/recovery gates are verified. */
export async function startEditorAgentBroker(options: {
	directory: string;
	documents: Pick<DocumentService, "getTransactionSnapshot" | "getTransactionReceipt"> &
		Partial<
			Pick<
				DocumentService,
				"prepareAudioAsset" | "prepareAsset" | "getAgentHistory" | "prepareAgentRestore"
			>
		>;
	probeVideoDuration?: (path: string) => Promise<number | null>;
	probeVideoMetadata?: (
		path: string,
	) => Promise<{ durationSec: number | null; video?: AxcutAsset["video"] }>;
	openEditorWindow?: () => void;
	approveSelectedMedia?: (path: string) => Promise<string | null>;
	ipcMain: IpcMain;
}) {
	const prepareVideoAsset = async (projectId: string, file: string, existing?: AxcutAsset) => {
		if (!existing && !options.documents.prepareAsset)
			throw new Error("IMPORT_UNAVAILABLE: Video preparation is unavailable");
		const metadata = options.probeVideoMetadata
			? await options.probeVideoMetadata(file)
			: { durationSec: await options.probeVideoDuration?.(file) };
		if (metadata.durationSec == null || !Number.isFinite(metadata.durationSec))
			throw new Error("MEDIA_UNAVAILABLE: Video duration could not be read");
		const asset = existing ?? (await options.documents.prepareAsset!(projectId, { path: file }));
		return { ...asset, ...metadata, durationSec: metadata.durationSec };
	};
	let closing = false;
	const pending = new Map<
		string,
		{
			senderId: number;
			finish: (reply: AgentSessionReply) => void;
			reject: (error: Error) => void;
			timer: ReturnType<typeof setTimeout>;
		}
	>();
	const onReply = (event: IpcMainEvent, reply: AgentSessionReply) => {
		if (!reply || typeof reply.id !== "string") return;
		const request = pending.get(reply.id);
		if (
			!request ||
			request.senderId !== event.sender.id ||
			event.senderFrame !== event.sender.mainFrame
		)
			return;
		clearTimeout(request.timer);
		pending.delete(reply.id);
		request.finish(reply);
	};
	options.ipcMain.on(AGENT_SESSION_REPLY, onReply);
	const findEditor = () =>
		BrowserWindow.getAllWindows().find((window) => {
			if (window.isDestroyed()) return false;
			try {
				const url = new URL(window.webContents.getURL());
				return (
					url.searchParams.get("windowType") === "editor" &&
					(url.protocol === "klippt:" || (url.protocol === "http:" && url.hostname === "localhost"))
				);
			} catch {
				return false;
			}
		});
	const ensureEditor = async () => {
		if (findEditor()) return;
		if (!options.openEditorWindow)
			throw new Error("EDITOR_UNAVAILABLE: Open the editor in Klippt first.");
		options.openEditorWindow();
		const deadline = Date.now() + 20_000;
		while (Date.now() < deadline) {
			const editor = findEditor();
			if (editor && !editor.webContents.isLoading()) {
				await new Promise((resolve) => setTimeout(resolve, 1500));
				return;
			}
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
		throw new Error("EDITOR_TIMEOUT: The editor window did not finish loading.");
	};
	const relay = (message: Omit<AgentSessionMessage, "id">, timeoutMs = 12_000) => {
		if (closing)
			throw new Error("BROKER_CLOSED: Recover the operation receipt before retrying a write.");
		const editor = findEditor();
		if (!editor) throw new Error("EDITOR_UNAVAILABLE: Open a project in Klippt first.");
		const requestId = randomUUID();
		return new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				pending.delete(requestId);
				reject(new Error("EDITOR_TIMEOUT: Recover the operation receipt before retrying a write."));
			}, timeoutMs);
			pending.set(requestId, {
				senderId: editor.webContents.id,
				timer,
				reject,
				finish: (reply) => {
					if (reply.status === "completed") resolve(reply.data);
					else
						reject(
							new Error(
								`${reply.error?.code ?? "EDITOR_ERROR"}: ${reply.error?.message ?? "Editor request failed"}`,
							),
						);
				},
			});
			try {
				editor.webContents.send(AGENT_SESSION_REQUEST, {
					...message,
					id: requestId,
				});
			} catch (error) {
				clearTimeout(timer);
				pending.delete(requestId);
				reject(error);
			}
		});
	};
	type Plan = {
		projectId: string;
		version: Awaited<ReturnType<DocumentService["getTransactionSnapshot"]>>["version"];
		prepared: ReturnType<typeof prepareAgentEditPlan>;
		checks: CheckResult;
		baseline: CheckResult;
		before: Parameters<typeof prepareAgentEditPlan>[0];
		span: Span;
		expires: number;
	};
	const fileEvidence = async (document: Parameters<typeof prepareAgentEditPlan>[0]) => {
		const files: Record<string, boolean | null> = {};
		await Promise.all(
			[...new Set(assetFiles(document).map((f) => f.path))].map(async (file) => {
				try {
					files[file] = (await fs.stat(file)).isFile();
				} catch (error) {
					files[file] =
						error instanceof Error &&
						"code" in error &&
						(error.code === "ENOENT" || error.code === "ENOTDIR")
							? false
							: null;
				}
			}),
		);
		return files;
	};
	const audioEvidence = async (
		documents: Parameters<typeof prepareAgentEditPlan>[0][],
		span: Span,
	) => {
		const audio = new Map<string, AudioObservation>();
		const assets = new Map<string, { path: string; durationSec: number }>();
		for (const document of documents) {
			const range = rangeForDocument(document, span);
			for (const fragment of buildResolvedEdit(document).fragments) {
				if (
					range &&
					(fragment.edited.endSec < range.startSec - 3 ||
						fragment.edited.startSec > range.endSec + 3)
				)
					continue;
				const asset = document.assets.find((item) => item.id === fragment.assetId);
				if (asset?.durationSec)
					assets.set(asset.id, {
						path: asset.originalPath,
						durationSec: asset.durationSec,
					});
			}
		}
		await Promise.all(
			[...assets].map(async ([id, asset]) => {
				const peaks = await getAudioPeaks(
					asset.path,
					asset.durationSec,
					"microphone",
					"analysis",
				).catch(() => null);
				audio.set(id, {
					microphonePeaks: peaks,
					quietSpans: quietSpans(peaks, asset.durationSec, DEFAULT_CUT_POINT_POLICY.sensitivity),
				});
			}),
		);
		return audio;
	};
	const readChecks = async (
		projectId: string,
		document: Parameters<typeof prepareAgentEditPlan>[0],
		span: Span,
	): Promise<CheckRun> => {
		try {
			const files = await fileEvidence(document);
			const report = (await relay(
				{
					action: "check",
					projectId,
					editCheck: {
						range: rangeForDocument(document, span),
						files,
						documentKey: JSON.stringify(document),
						page_size: 50,
					},
				},
				1000,
			)) as CheckRun;
			if (!report || !["analyzing", "ready", "error"].includes(report.status))
				throw new Error("Check response unavailable");
			return report;
		} catch (error) {
			return {
				status: "error",
				revision: "unknown",
				result: planChecks(document, span),
				audio: { ready: 0, pending: 0 },
				timings: { elapsedMs: 0, peaksMs: 0, speechMs: 0 },
				error: String(error),
			};
		}
	};
	const contentVerification = (
		document: Parameters<typeof runContentVerification>[0],
		span: Span,
		requestId: string,
	) => {
		try {
			return runContentVerification(document, span, {
				outDirectory: path.join(app.getPath("userData"), "cache", "agent-verify", requestId),
			});
		} catch (error) {
			return {
				status: "error" as const,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	};
	const verifyWrite = async (
		projectId: string,
		before: Parameters<typeof prepareAgentEditPlan>[0],
		span: Span,
		beforeRun: CheckRun,
		receipt: unknown,
		deep = false,
		requestId?: string,
	) => {
		try {
			const after = await options.documents.getTransactionSnapshot(projectId);
			const revision = z.object({ revision: z.string().optional() }).parse(receipt).revision;
			if (revision && after.version.revision !== revision)
				throw new Error(
					"STALE_DOCUMENT: Another edit followed this commit; read state/check again.",
				);
			const afterRun = await readChecks(projectId, after.document, span);
			const verify = buildVerify(before, after.document, span, beforeRun, afterRun);
			// --deep: content-level proof over the touched span on the committed
			// document. Findings inform; the write is already committed, so they
			// join checks.new without any additional gating. An unavailable pass
			// adds an error-level content.unavailable finding — the verify block
			// must not read as a success when nothing was verified.
			const content = deep
				? contentVerification(after.document, span, requestId ?? "apply")
				: undefined;
			const contentFindings = content ? deepContentFindings(content, span) : [];
			return {
				...verify,
				...(contentFindings.length
					? {
							checks: {
								...verify.checks,
								new: [...verify.checks.new, ...contentFindings],
							},
						}
					: {}),
				...(content ? { content_verification: content } : {}),
				revision: after.version.revision,
				stateSource: "committed-document",
			};
		} catch (error) {
			return {
				state: null,
				checks: {
					status: "error",
					before: beforeRun.result?.counts ?? null,
					after: null,
					new: [],
					resolved: [],
					error: String(error),
				},
				next_actions: [
					"Read state and check for the project; the write committed, do not retry it.",
				],
			};
		}
	};

	let presets: ReturnType<typeof createAgentPresetStore> | undefined;
	const presetStore = () => (presets ??= createAgentPresetStore(app.getPath("userData")));
	const uiPresets = async () =>
		z.array(visualPresetSchema).parse(await relay({ action: "presets" }));
	const liveDocument = async (projectId: string) =>
		documentSchema.parse(
			z.object({ document: z.unknown() }).parse(await relay({ action: "inspect", projectId }))
				.document,
		);
	/** The `live` reply surface; the reply.time-base rule audits exactly this. */
	const liveInspectData = (live: {
		document: Parameters<typeof inspectAgentProject>[0];
		dirty: boolean;
		currentTimeSec: number;
		busy: boolean;
		syncPending: boolean;
	}) => ({
		...inspectAgentProject(live.document),
		live_editor_state: "available",
		analysis: {
			source_media: "not_checked",
			background_jobs: "unknown",
			cursor: "not_loaded",
			waveform: "not_loaded",
		},
		dirty: live.dirty,
		currentTimeSec: live.currentTimeSec,
		busy: live.busy,
		syncPending: live.syncPending,
		state: "live_editor",
		time_bases: {
			currentTimeSec: TIME_BASE_LABELS.raw,
		},
	});
	const plans = new Map<string, Plan>();
	try {
		const broker = await startAgentBroker(
			options.directory,
			async (request) => {
				let applyDispatched = false;
				let recoveryRequired = false;
				try {
					let data: unknown;
					switch (request.command) {
						case "capabilities": {
							z.strictObject({}).parse(request.input);
							let renderer: unknown;
							try {
								renderer = await relay({ action: "capabilities" });
							} catch {
								renderer = undefined;
							}
							data = {
								editor: {
									contract: 1,
									session_id: brokerCapabilitySession,
									build_id: agentBuildId,
									capabilities: { editor: true },
								},
								...(renderer ? { renderer } : {}),
							};
							break;
						}
						case "settings": {
							const input = z.strictObject({ projectId: id }).parse(request.input);
							data = {
								source: "live_editor",
								groups: describeAgentSettings(await liveDocument(input.projectId)),
							};
							break;
						}
						case "preset": {
							const input = presetCommandInput.parse(request.input);
							if (input.action === "list") {
								let ui: z.infer<typeof visualPresetSchema>[] = [];
								let uiStatus = "available";
								try {
									ui = await uiPresets();
								} catch {
									uiStatus = "unavailable: open an editor to include its local preset library";
								}
								data = {
									presets: [
										...(await presetStore().read()).map((p) => ({
											name: p.name,
											id: p.id,
											source: "agent",
										})),
										...ui.map((p) => ({
											name: p.name,
											id: p.id,
											source: "ui",
										})),
									],
									ui_library: uiStatus,
								};
							} else if (input.action === "save" && input.project_id && input.name) {
								const preset = captureAgentPreset(await liveDocument(input.project_id), input.name);
								await presetStore().save(preset);
								data = { name: preset.name, source: "agent", saved: true };
							} else if (input.action === "delete" && input.name) {
								await presetStore().delete(input.name);
								data = { name: input.name, source: "agent", deleted: true };
							} else throw new Error("INVALID_INPUT: Preset apply requires plan/apply.");
							break;
						}
						case "inspect": {
							z.strictObject({}).parse(request.input);
							const live = (await relay({ action: "inspect" })) as Parameters<
								typeof liveInspectData
							>[0];
							data = liveInspectData(live);
							break;
						}
						case "plan":
						case "import-plan": {
							const input =
								request.command === "import-plan"
									? agentImportRequestSchema.parse(request.input)
									: z
											.strictObject({
												projectId: id,
												stage: z.boolean().optional(),
												operations: z.array(z.unknown()).min(1).max(500).optional(),
												placement: placementIntentSchema.optional(),
												swap: brollSwapCommandInput.optional(),
												replacement: clipCommandInput.optional(),
												preset: z
													.strictObject({
														name: z.string().min(1).max(48),
														source: z.enum(["ui", "agent"]).optional(),
													})
													.optional(),
											})
											.refine(
												(v) =>
													[v.operations, v.placement, v.swap, v.replacement, v.preset].filter(
														(x) => x !== undefined,
													).length === 1,
												"Supply operations or placement",
											)
											.parse(request.input);
							if (
								"placement" in input &&
								input.placement &&
								input.placement.project_id !== input.projectId
							)
								throw new Error("PROJECT_MISMATCH");
							if ("stage" in input && input.stage) {
								const parsed = stagedOperationsSchema.safeParse(input.operations);
								if (!parsed.success)
									throw Object.assign(
										new Error(
											"INVALID_INPUT: Only addTrim and setTrim operations can be staged; supply a trims-only plan.",
										),
										{ code: "INVALID_INPUT" },
									);
								data = await relay({
									action: "stage",
									projectId: input.projectId,
									stagedCuts: { operations: parsed.data, planId: randomUUID() },
								});
								break;
							}
							const version = await relay({
								action: "activate",
								projectId: input.projectId,
							});
							const snapshot = await options.documents.getTransactionSnapshot(input.projectId);
							if (JSON.stringify(version) !== JSON.stringify(snapshot.version))
								throw new Error("CONFLICT: Project changed during planning.");
							let placementInput = "placement" in input ? input.placement : undefined;
							let thumbnails: Awaited<ReturnType<typeof assetThumbnails>> | undefined;
							if (placementInput?.kind === "broll") {
								const ffmpeg = resolveFfmpeg();
								if (!ffmpeg) throw new Error("FFMPEG_UNAVAILABLE");
								const file = await options.approveSelectedMedia?.(placementInput.file);
								if (!file) throw new Error("MEDIA_UNAVAILABLE");
								const proposed = buildPlacement(snapshot.document, placementInput);
								thumbnails = await assetThumbnails(
									file,
									path.join(app.getPath("userData"), "cache", "agent-media"),
									ffmpeg,
								);
								const mediaFile = await prepareStillVideo(
									file,
									proposed.span.endSec - proposed.span.startSec + placementInput.offset,
									path.join(app.getPath("userData"), "agent-media"),
									ffmpeg,
								);
								placementInput = { ...placementInput, file: mediaFile };
							}
							const placement = placementInput
								? buildPlacement(snapshot.document, placementInput)
								: undefined;
							let material = placement ?? input;
							if ("preset" in input && input.preset) {
								const name = input.preset.name.toLowerCase();
								const agent =
									input.preset.source === "ui"
										? undefined
										: (await presetStore().read()).find((p) => p.name.toLowerCase() === name);
								const preset =
									agent ??
									(input.preset.source === "agent"
										? undefined
										: (await uiPresets()).find((p) => p.name.toLowerCase() === name));
								if (!preset) throw new Error("PRESET_NOT_FOUND");
								material = {
									projectId: input.projectId,
									operations: presetOperations(preset),
								};
							}
							const observations = new Map<number, RecordedDirectionObservation[]>();
							if ("operations" in material && material.operations) {
								const operations = agentEditBatchSchema.parse(material.operations);
								let pendingAnalysis = false;
								for (const [index, op] of operations.entries()) {
									if (op.type !== "autoDirectionRun" && op.type !== "autoDirectionRegenerate")
										continue;
									const current = index
										? prepareAgentEditPlan(
												snapshot.document,
												operations.slice(0, index),
												observations,
											).candidate
										: snapshot.document;
									const report = (await relay({
										action: "direction-observations",
										projectId: input.projectId,
										documentKey: JSON.stringify(snapshot.document),
										directionSettings: resolveAgentAutomaticSettings(current, op.settings),
									})) as {
										status: string;
										recordings?: RecordedDirectionObservation[];
										error?: string;
									};
									if (report.status === "analyzing") {
										pendingAnalysis = true;
										break;
									}
									if (report.status !== "ready" || !report.recordings)
										throw new Error(report.error ?? "DIRECTION_ANALYSIS_FAILED");
									observations.set(index, report.recordings);
								}
								if (pendingAnalysis) {
									data = {
										status: "analyzing",
										next_actions: [{ command: "Repeat this plan request." }],
									};
									break;
								}
							}
							let prepared =
								("replacement" in input && input.replacement) || ("swap" in input && input.swap)
									? undefined
									: "media" in material && material.media
										? await prepareAgentImportPlan(snapshot.document, material.media, {
												prepareAudioAsset: async (...args) => {
													if (!options.documents.prepareAudioAsset)
														throw new Error("IMPORT_UNAVAILABLE: Audio preparation is unavailable");
													return options.documents.prepareAudioAsset(...args);
												},
												prepareVideoAsset,
												approveSelectedMedia: async (file) =>
													options.approveSelectedMedia?.(file) ?? null,
											})
										: prepareAgentEditPlan(
												snapshot.document,
												"operations" in material ? material.operations : [],
												observations,
											);
							if ("replacement" in input && input.replacement) {
								const replace = input.replacement;
								if (replace.project_id !== input.projectId) throw new Error("PROJECT_MISMATCH");
								if (!snapshot.document.timeline.clips.some((c) => c.id === replace.clip))
									throw new Error("UNKNOWN_CLIP");
								const file = await options.approveSelectedMedia?.(replace.file);
								if (!file || !options.documents.prepareAsset || !options.probeVideoDuration)
									throw new Error("MEDIA_UNAVAILABLE");
								const durationSec = await options.probeVideoDuration(file);
								if (!durationSec)
									throw new Error("MEDIA_UNAVAILABLE: Replacement duration could not be read.");
								const existing = snapshot.document.assets.find(
									(a) => path.resolve(a.originalPath) === path.resolve(file),
								);
								const asset = {
									...(existing ??
										(await options.documents.prepareAsset(input.projectId, {
											path: file,
										}))),
									durationSec,
								};
								const base = {
									...snapshot.document,
									assets: [...snapshot.document.assets.filter((a) => a.id !== asset.id), asset],
								};
								prepared = prepareAgentEditPlan(base, [
									{
										type: "replaceClipSource",
										args: { clipId: replace.clip, assetId: asset.id },
									},
								]);
							}
							if ("swap" in input && input.swap) {
								const swap = input.swap;
								if (swap.project_id !== input.projectId) throw new Error("PROJECT_MISMATCH");
								if (!snapshot.document.videoOverlays?.some((o) => o.id === swap.overlay))
									throw new Error("UNKNOWN_VIDEO_OVERLAY");
								const file = await options.approveSelectedMedia?.(swap.file);
								if (!file) throw new Error("MEDIA_UNAVAILABLE");
								const existing = snapshot.document.assets.find(
									(a) => path.resolve(a.originalPath) === path.resolve(file),
								);
								const asset = await prepareVideoAsset(input.projectId, file, existing);
								const base = {
									...snapshot.document,
									assets: existing
										? snapshot.document.assets.map((a) => (a.id === asset.id ? asset : a))
										: [...snapshot.document.assets, asset],
								};
								inspectBrollSwap(base, {
									videoOverlayId: swap.overlay,
									assetId: asset.id,
									sourceOffsetSec: swap.offset,
									fit: swap.fit,
									time: swap.time,
								});
								prepared = prepareAgentEditPlan(base, [
									{
										type: "swapVideoOverlay",
										args: {
											videoOverlayId: swap.overlay,
											assetId: asset.id,
											sourceOffsetSec: swap.offset,
											fit: swap.fit,
											time: swap.time,
										},
									},
								]);
							}
							if (!prepared) throw new Error("INVALID_PLAN");

							const span = touchedSpan(snapshot.document, prepared.candidate);
							const files = await fileEvidence(prepared.candidate);
							const audio = await audioEvidence([snapshot.document, prepared.candidate], span);
							const baseline = planChecks(snapshot.document, span, files, audio);
							const checks = planChecks(prepared.candidate, span, files, audio);
							const introduced = introducedFindings(baseline, checks);
							for (const [key, plan] of plans)
								if (plan.expires < Date.now()) {
									plans.delete(key);
									await fs
										.unlink(path.join(options.directory, `${key}.klippt`))
										.catch(() => undefined);
								}
							if (plans.size >= 20)
								throw new Error("PLAN_CAPACITY: Finish or expire outstanding plans.");
							const planId = randomUUID();
							const candidatePath = path.join(options.directory, `${planId}.klippt`);
							const candidateJson = JSON.stringify(prepared.candidate);
							if (Buffer.byteLength(candidateJson) > 2 * 1024 * 1024)
								throw new Error("PLAN_TOO_LARGE: Candidate exceeds experimental plan limit.");
							await fs.writeFile(candidatePath, candidateJson, {
								flag: "wx",
								mode: 0o600,
							});
							if (closing) {
								await fs.unlink(candidatePath).catch(() => undefined);
								throw new Error("BROKER_CLOSED");
							}
							plans.set(planId, {
								projectId: input.projectId,
								version: snapshot.version,
								prepared,
								checks,
								baseline,
								before: snapshot.document,
								span,
								expires: Date.now() + 30 * 60_000,
							});
							const { candidate: _candidate, operations: _operations, ...summary } = prepared;
							data = {
								planId,
								projectId: input.projectId,
								version: snapshot.version,
								summary,
								span,
								checks,
								introduced: {
									counts: {
										error: introduced.filter((f) => f.severity === "error").length,
										warning: introduced.filter((f) => f.severity === "warning").length,
										info: introduced.filter((f) => f.severity === "info").length,
									},
									findings: introduced,
								},
								...(placement
									? {
											span: placement.span,
											notes: placement.notes,
											checks,
											...(thumbnails ? { thumbnails } : {}),
										}
									: {}),
								...("swap" in input && input.swap ? { swap: prepared.results[0]?.result } : {}),
								candidatePath,
								expiresAfterSeconds: 1800,
								applied: false,
							};
							break;
						}
						case "apply": {
							const input = z
								.strictObject({
									planId: id,
									projectId: id,
									force: z.boolean().default(false),
									deep: z.boolean().default(false),
								})
								.parse(request.input);
							const plan = plans.get(input.planId);
							if (!plan || plan.expires < Date.now()) {
								recoveryRequired = true;
								throw new Error(
									"PLAN_UNAVAILABLE: Recover the receipt for this request ID before preparing another edit.",
								);
							}
							if (plan.projectId !== input.projectId) throw new Error("PROJECT_MISMATCH");
							assertIntroducedChecks(plan.baseline, plan.checks, input.force);
							const agentHistory: AgentHistoryIntent = {
								kind: "apply",
								targetIds: [],
								force: false,
								planSummary: `${plan.prepared.operations.length} operations: ${[...new Set(plan.prepared.operations.map((op) => op.type))].join(", ")}`,
							};
							const existing = await options.documents.getTransactionReceipt(
								input.projectId,
								request.request_id,
							);
							if (existing) {
								const payloadHash = createHash("sha256")
									.update(
										canonicalTransactionPayload({
											payload: {
												projectId: plan.projectId,
												document: plan.prepared.candidate,
											},
											recordUndo: true,
											agentHistory,
										}),
									)
									.digest("hex");
								if (payloadHash !== existing.payloadHash)
									throw new Error("KEY_REUSED: Request ID belongs to a different edit.");
								data = {
									receipt: existing,
									replayed: true,
									editorSync: "not_checked",
								};
								break;
							}
							{
								const files = await fileEvidence(plan.prepared.candidate);
								const audio = await audioEvidence([plan.prepared.candidate], plan.span);
								assertIntroducedChecks(
									plan.baseline,
									planChecks(plan.prepared.candidate, plan.span, files, audio),
									input.force,
								);
							}
							const beforeRun = await readChecks(plan.projectId, plan.before, plan.span);
							applyDispatched = true;
							const receipt = await relay({
								action: "apply",
								projectId: plan.projectId,
								document: plan.prepared.candidate,
								guard: {
									requestId: request.request_id,
									expected: plan.version,
									agentHistory,
								},
							});
							const verify = await verifyWrite(
								plan.projectId,
								plan.before,
								plan.span,
								beforeRun,
								receipt,
								input.deep,
								request.request_id,
							);
							data = {
								receipt,
								editorSync: "applied",
								commit_status: "committed",
								verify,
							};
							plans.delete(input.planId);
							await fs
								.unlink(path.join(options.directory, `${input.planId}.klippt`))
								.catch(() => undefined);
							break;
						}
						case "staged":
						case "accept":
						case "reject": {
							const input = z
								.strictObject({
									projectId: id,
									offset: z.number().int().min(0).max(1_000_000).optional(),
									ids: z.array(z.string().min(1).max(512)).min(1).max(500).optional(),
								})
								.parse(request.input);
							if (request.command === "reject" && !input.ids)
								throw Object.assign(new Error("reject requires --ids"), {
									code: "INVALID_INPUT",
								});
							if (request.command === "accept") applyDispatched = true;
							data = await relay(
								{
									action: request.command,
									projectId: input.projectId,
									cutIds: input.ids,
									cutOffset: input.offset,
									mutationRequestId: request.command === "accept" ? request.request_id : undefined,
								},
								request.command === "accept" ? 60_000 : 12_000,
							);
							break;
						}
						case "history": {
							const input = z.strictObject({ projectId: id }).parse(request.input);
							if (!options.documents.getAgentHistory) throw new Error("HISTORY_UNAVAILABLE");
							data = {
								entries: (await options.documents.getAgentHistory(input.projectId)).map(
									({
										applyId,
										requestId,
										at,
										planSummary,
										beforeRevision,
										afterRevision,
										kind,
										targetIds,
									}) => ({
										applyId,
										requestId,
										at,
										planSummary,
										beforeRevision,
										afterRevision,
										kind,
										targetIds,
									}),
								),
							};
							break;
						}
						case "undo":
						case "redo": {
							const input = z
								.strictObject({
									projectId: id,
									steps: z.number().int().min(1).max(50).optional(),
									to: z.string().uuid().optional(),
									force: z.boolean().default(false),
								})
								.refine((v) => !(v.steps && v.to))
								.parse(request.input);
							if (request.command === "redo" && input.to)
								throw new Error("INVALID_INPUT: redo takes --steps only.");
							if (!options.documents.prepareAgentRestore) throw new Error("HISTORY_UNAVAILABLE");
							const existing = await options.documents.getTransactionReceipt(
								input.projectId,
								request.request_id,
							);
							const requestKey = canonicalTransactionPayload({
								command: request.command,
								projectId: input.projectId,
								steps: input.to ? null : (input.steps ?? 1),
								to: input.to ?? null,
								force: input.force,
							});
							if (existing) {
								const entry = (await options.documents.getAgentHistory?.(input.projectId))?.find(
									(e) => e.requestId === request.request_id,
								);
								if (entry?.requestKey !== requestKey)
									throw new Error(
										"KEY_REUSED: Request ID belongs to a different or expired restore. Query receipt.",
									);
								data = {
									receipt: existing,
									replayed: true,
									editorSync: "not_checked",
								};
								break;
							}
							const version = await relay({
								action: "activate",
								projectId: input.projectId,
							});
							const restore = await options.documents.prepareAgentRestore(
								input.projectId,
								request.command,
								input,
							);
							if (JSON.stringify(version) !== JSON.stringify(restore.version))
								throw new Error("CONFLICT: Project changed during restore.");
							const span = touchedSpan(restore.before, restore.document);
							const beforeRun = await readChecks(input.projectId, restore.before, span);
							applyDispatched = true;
							const receipt = await relay({
								action: "apply",
								projectId: input.projectId,
								document: restore.document,
								guard: {
									requestId: request.request_id,
									expected: restore.version,
									agentHistory: { ...restore.intent, requestKey },
								},
							});
							data = {
								receipt,
								editorSync: "applied",
								commit_status: "committed",
								targetIds: restore.targetIds,
								verify: await verifyWrite(
									input.projectId,
									restore.before,
									span,
									beforeRun,
									receipt,
								),
							};
							break;
						}

						case "open": {
							const input = z.strictObject({ projectId: id }).parse(request.input);
							await ensureEditor();
							data = await relay({
								action: "open",
								projectId: input.projectId,
							});
							break;
						}
						case "transcribe": {
							const input = z.strictObject({ projectId: id }).parse(request.input);
							data = await relay({
								action: "transcribe",
								projectId: input.projectId,
							});
							break;
						}
						case "pauses": {
							const input = pausesBrokerInput.parse(request.input);
							const report = (await relay({
								action: "pauses",
								projectId: input.projectId,
								pausePolicy: input.policy,
							})) as Parameters<typeof formatPauseReport>[0];
							data = formatPauseReport(report, input.offset, input.limit, input.clips);
							break;
						}
						case "transport": {
							const input = transportBrokerInput.parse(request.input);
							const resolutions: ResolvedInstant[] = [];
							// Seek targets resolve against the live document; the editor
							// always receives raw timeline seconds.
							const document = input.steps.some((step) => step.op === "seek")
								? await liveDocument(input.projectId)
								: undefined;
							const steps: import("../../src/lib/ai-edition/agent/agentTransport").AgentTransportStep[] =
								input.steps.map((step) => {
									if (step.op !== "seek") return step;
									const resolved = resolveTimelineInstant(document!, step.sec);
									resolutions.push(resolved);
									return { op: "seek", sec: resolved.raw_sec };
								});
							const result = (await relay({
								action: "transport",
								projectId: input.projectId,
								transport: { runId: input.runId, steps },
							})) as Record<string, unknown>;
							data = {
								...result,
								...(resolutions.length ? { resolved_seeks: resolutions } : {}),
								time_bases: {
									currentTimeSec: TIME_BASE_LABELS.raw,
									videoTimeSec: "source_seconds of the active clip",
									resolved_seeks: "each seek resolved on all three timeline clocks",
								},
							};
							break;
						}
						case "state": {
							const { projectId, ...editState } = stateBrokerInput.parse(request.input);
							const times = [
								editState.at,
								editState.range?.startSec,
								editState.range?.endSec,
							].filter((value) => value !== undefined);
							const needsConversion = times.some(
								(value) => typeof value === "object" && value.base !== "edited",
							);
							const document = needsConversion ? await liveDocument(projectId) : undefined;
							const toEdited = (value: number | TimeInput): number =>
								typeof value === "number"
									? value
									: value.base === "edited"
										? value.seconds
										: resolveTimelineInstant(document!, value).edited_sec;
							const { documentKey, ...report } = (await relay({
								action: "state",
								projectId,
								editState: {
									...(editState.at !== undefined
										? { at: toEdited(editState.at) }
										: { clipId: editState.clipId }),
									...(editState.range
										? {
												range: {
													startSec: toEdited(editState.range.startSec),
													endSec: toEdited(editState.range.endSec),
												},
											}
										: {}),
								},
							})) as StateResult & { revision: string; documentKey: string };
							data = {
								...report,
								documentHash: createHash("sha256").update(documentKey).digest("hex"),
								time_bases: {
									editedTimeSec: TIME_BASE_LABELS.edited,
									rawTimeSec: TIME_BASE_LABELS.raw,
									sourceTimeSec: TIME_BASE_LABELS.source,
									durationSec: "duration_seconds",
									remainingSec: "duration_seconds",
									distanceSec: "duration_seconds",
								},
							};
							break;
						}
						case "check": {
							const {
								projectId,
								range: checkRange,
								...editCheck
							} = checkBrokerInput.parse(request.input);
							const live = (await relay({ action: "inspect", projectId })) as Parameters<
								typeof liveInspectData
							>[0];
							const documentKey = JSON.stringify(live.document);
							const documentHash = createHash("sha256").update(documentKey).digest("hex");
							if (editCheck.rule === REPLY_TIME_BASE_RULE.id) {
								// CLI contract audit, not a document rule: scan the live
								// inspect reply for *Sec fields without a time_base label.
								const paths = findUnbasedSecFields(liveInspectData(live));
								data = {
									status: "ready",
									revision: "reply-contract",
									result: {
										findings: paths.map((path) => ({
											rule: REPLY_TIME_BASE_RULE.id,
											severity: "warning" as const,
											at: 0,
											span: { startSec: 0, endSec: 0 },
											clip: null,
											message: `${path} is seconds without a time_base label in the live inspect reply`,
											fix: null,
										})),
										counts: {
											error: 0,
											warning: paths.length,
											info: 0,
											byRule: { [REPLY_TIME_BASE_RULE.id]: paths.length },
										},
										total: paths.length,
										notes: [
											"Scanned the live inspect reply; findUnbasedSecFields in electron/cli/agentTimeBase.ts scans any command reply.",
										],
										rules: [
											{
												id: REPLY_TIME_BASE_RULE.id,
												severity: REPLY_TIME_BASE_RULE.severity,
												describe: REPLY_TIME_BASE_RULE.describe,
											},
										],
									},
									audio: { ready: 0, pending: 0 },
									timings: { elapsedMs: 0, peaksMs: 0, speechMs: 0 },
									error: null,
									documentHash,
								};
								break;
							}
							const paths = [...new Set(assetFiles(live.document).map((file) => file.path))];
							const files: Record<string, boolean | null> = {};
							if (!editCheck.rule || editCheck.rule === "asset.missing")
								await Promise.all(
									paths.map(async (path) => {
										try {
											files[path] = (await fs.stat(path)).isFile();
										} catch (error) {
											files[path] =
												error instanceof Error &&
												"code" in error &&
												(error.code === "ENOENT" || error.code === "ENOTDIR")
													? false
													: null;
										}
									}),
								);
							let convertedRange: { startSec: number; endSec: number } | undefined;
							if (checkRange) {
								const toEdited = (value: number | TimeInput): number =>
									typeof value === "number"
										? value
										: value.base === "edited"
											? value.seconds
											: resolveTimelineInstant(documentSchema.parse(live.document), value)
													.edited_sec;
								convertedRange = {
									startSec: toEdited(checkRange.startSec),
									endSec: toEdited(checkRange.endSec),
								};
							}
							const report = (await relay({
								action: "check",
								projectId,
								editCheck: {
									...editCheck,
									...(convertedRange ? { range: convertedRange } : {}),
									files,
									documentKey,
								},
							})) as CheckRun;
							// --deep: decode the real media at every cut/overlay edge in
							// range and merge the content findings into this check page.
							// Only the full rule set merges; a single-rule page stays pure.
							let content: ReturnType<typeof contentVerification> | undefined;
							if (editCheck.deep && !editCheck.rule) {
								const document = documentSchema.parse(live.document);
								const span =
									convertedRange ??
									(() => {
										const duration = buildResolvedEdit(document).durationSec;
										return { startSec: 0, endSec: duration };
									})();
								if (span.endSec > span.startSec) {
									content = contentVerification(document, span, request.request_id);
									// deepContentFindings also covers an unavailable pass
									// (error-level content.unavailable) so a failed decode can
									// never look like a clean page.
									const deepFindings = deepContentFindings(content, span);
									if (report.result && deepFindings.length)
										report.result = mergeContentFindings(report.result, deepFindings);
								}
							}
							data = {
								...report,
								documentHash,
								...(content ? { content_verification: content } : {}),
							};
							break;
						}
						case "verify": {
							const input = verifyBrokerInput.parse(request.input);
							const document = await liveDocument(input.projectId);
							const toEdited = (value: number | TimeInput): number =>
								typeof value === "number"
									? value
									: value.base === "edited"
										? value.seconds
										: resolveTimelineInstant(document, value).edited_sec;
							const range = {
								startSec: toEdited(input.range.startSec),
								endSec: toEdited(input.range.endSec),
							};
							const duration = buildResolvedEdit(document).durationSec;
							if (range.endSec > duration + 1e-6)
								throw new Error(
									`TIME_OUTSIDE_PROJECT: Range end ${range.endSec}s is past the edited duration ${duration}s.`,
								);
							if (input.out && !path.isAbsolute(input.out))
								throw new Error("INVALID_INPUT: --out must be an absolute path.");
							const summary = runContentVerification(document, range, {
								outDirectory:
									input.out ??
									path.join(app.getPath("userData"), "cache", "agent-verify", request.request_id),
							});
							if (summary.status === "ffmpeg-missing") throw new Error("FFMPEG_UNAVAILABLE");
							data = summary;
							break;
						}
						case "cutpoint": {
							const input = cutPointBrokerInput.parse(request.input);
							let timeSec = input.timeSec;
							let resolution: ResolvedInstant | undefined;
							if (input.time) {
								// Suffixed input converts against the live document; the reply
								// carries all three bases for the resolved instant.
								const document = await liveDocument(input.projectId);
								resolution = resolveTimelineInstant(document, input.time, {
									clipId: input.clipId,
								});
								if (input.time.base === "source") {
									// Source input may name media that is trimmed away; keep the
									// exact requested value rather than the snapped kept position.
									resolution = {
										...resolution,
										source_sec: Number(input.time.seconds.toFixed(3)),
										clip_id: input.clipId,
									};
								} else if (resolution.clip_id !== input.clipId) {
									throw new Error(
										`TIME_OUTSIDE_PROJECT: The instant is not inside clip ${input.clipId}.`,
									);
								}
								timeSec =
									input.time.base === "source"
										? input.time.seconds
										: (resolution.source_sec ?? undefined);
							}
							if (timeSec === undefined) throw new Error("INVALID_INPUT: time is required");
							const report = (await relay({
								action: "cutpoint",
								projectId: input.projectId,
								cutPoint: {
									clipId: input.clipId,
									timeSec,
									edge: input.edge,
									policy: input.policy,
								},
							})) as Parameters<typeof formatCutPointReport>[0];
							data = formatCutPointReport(report, resolution);
							break;
						}
						case "edges": {
							const input = edgesBrokerInput.parse(request.input);
							const report = (await relay({
								action: "edges",
								projectId: input.projectId,
								edgePolicy: input.policy,
							})) as Parameters<typeof formatEdgeReport>[0];
							data = formatEdgeReport(report);
							break;
						}
						case "receipt": {
							const input = z
								.strictObject({ projectId: id, operationRequestId: id })
								.parse(request.input);
							data = {
								receipt: await options.documents.getTransactionReceipt(
									input.projectId,
									input.operationRequestId,
								),
							};
							break;
						}
						default:
							throw new Error("UNKNOWN_COMMAND");
					}
					const reply = {
						api_version: "1.0",
						request_id: request.request_id,
						status: "completed",
						data,
					};
					return request.command === "transport" ? reply : boundAgentReply(reply);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					const code = agentErrorCode(error);
					const planInput = request.input as {
						projectId?: unknown;
						planId?: unknown;
					};
					return boundAgentReply({
						api_version: "1.0",
						request_id: request.request_id,
						status: applyDispatched || recoveryRequired ? "recovery_required" : "failed",
						commit_status: applyDispatched || recoveryRequired ? "unknown" : "not_started",
						next_actions:
							applyDispatched || recoveryRequired
								? [
										{
											command: "receipt",
											projectId: request.input.projectId,
											operationRequestId: request.request_id,
										},
									]
								: [],
						// A check-blocked apply names the exact confirming retry (exit code 3).
						...(error instanceof PlanCheckError &&
						request.command === "apply" &&
						typeof planInput.projectId === "string" &&
						typeof planInput.planId === "string"
							? {
									confirm_command: `klippt agent apply --project_id ${planInput.projectId} --plan_id ${planInput.planId} --request_id ${request.request_id} --force`,
								}
							: {}),
						error: {
							code,
							message,
							hint: hintForError(code),
							retryable: false,
							field_errors: error instanceof ZodError ? error.issues : [],
							...(error instanceof PlanCheckError
								? {
										findings: error.findings.slice(0, 20),
										findings_total: error.findings.length,
										findings_omitted: Math.max(0, error.findings.length - 20),
									}
								: {}),
						},
					});
				}
			},
			{ exclusiveOwner: true },
		);
		// GUI startup holds the single-instance lock. GC must never leave a bound
		// broker unreachable if a candidate disappears or cannot be removed.
		try {
			const entries = await fs.opendir(options.directory);
			let examined = 0;
			for await (const entry of entries) {
				if (++examined > 2000) break;
				if (
					!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.klippt$/.test(entry.name)
				)
					continue;
				const file = path.join(options.directory, entry.name);
				try {
					const stat = await fs.lstat(file);
					if (stat.isFile() && stat.mtimeMs < Date.now() - 30 * 60_000) await fs.unlink(file);
				} catch {
					/* Best-effort cleanup of owned generated candidates. */
				}
			}
		} catch {
			/* An unavailable GC pass must not invalidate the active endpoint. */
		}

		return {
			...broker,
			close: async () => {
				closing = true;
				for (const request of pending.values()) {
					clearTimeout(request.timer);
					request.reject(
						new Error("BROKER_CLOSED: Recover the operation receipt before retrying a write."),
					);
				}
				pending.clear();
				options.ipcMain.removeListener(AGENT_SESSION_REPLY, onReply);
				await broker.close();
				for (const key of plans.keys())
					await fs.unlink(path.join(options.directory, `${key}.klippt`)).catch(() => undefined);
			},
		};
	} catch (error) {
		options.ipcMain.removeListener(AGENT_SESSION_REPLY, onReply);
		throw error;
	}
}

const brokerCapabilitySession = randomUUID();
