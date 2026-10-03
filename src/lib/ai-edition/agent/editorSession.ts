import { analyzeCutPoint } from "@/components/ai-edition/pauses/analyzeCutPoint";
import { analyzeProjectChecks } from "@/components/ai-edition/pauses/analyzeProjectChecks";
import { analyzeProjectEdges } from "@/components/ai-edition/pauses/analyzeProjectEdges";
import { analyzeProjectPauses } from "@/components/ai-edition/pauses/analyzeProjectPauses";
import { usePauseAnalysisStore } from "@/components/ai-edition/pauses/pauseAnalysisStore";
import {
	collectUiProbeReport,
	startUiProbe,
	stopUiProbe,
} from "@/lib/ai-edition/perf/uiFrameProbe";
import { cleanVoiceRoutes } from "@/lib/cleanVoiceRuntime";
import { isPreviewFrameSettled } from "@/native/previewSettledFrames";
import { buildResolvedEdit } from "../checks/context";
import { pageChecks } from "../checks/page";
import { resolvePlaybackSegments } from "../document/timeline";
import { documentSchema } from "../schema";
import {
	activateProjectTransactions,
	applyExternalProjectTransaction,
	useProjectStore,
} from "../store/projectStore";
import { useTranscriptionStore } from "../store/transcriptionStore";
import { BUILTIN_VISUAL_PRESETS, loadVisualPresets } from "../store/visualPresets";
import { buildTimelinePlaybackProjection, rawTimeToPlaybackTime } from "../timeline/timelineMap";
import { findAssetTranscript, transcriptRelevantAssetIds } from "../transcription/status";
import { requestAgentChecks } from "./agentCheckAnalysis";
import { requestAgentCutPoint } from "./agentCutPointAnalysis";
import { requestAgentEdgeAnalysis } from "./agentEdgeAnalysis";
import { requestAgentPauseAnalysis } from "./agentPauseAnalysis";
import {
	type AgentTransportHandlers,
	type AgentTransportResult,
	getAgentTransport,
	runAgentTransport,
} from "./agentTransport";
import { agentBuildId } from "./buildIdentity";
import { requestDirectionObservations } from "./directionObservations";
import { resolveStateReport } from "./effectiveState";
import type { AgentSessionMessage, AgentSessionReply } from "./sessionProtocol";
import { cutsFromOperations } from "./stagedCuts";

function transcriptionReport(
	document: NonNullable<ReturnType<typeof useProjectStore.getState>["document"]>,
) {
	const jobs = useTranscriptionStore.getState().jobs;
	return transcriptRelevantAssetIds(document).map((assetId) => {
		const asset = document.assets.find((candidate) => candidate.id === assetId);
		const job = jobs[assetId];
		const status = findAssetTranscript(document, assetId)
			? "stored"
			: job?.status === "failed"
				? "failed"
				: job
					? job.status
					: asset?.transcriptionFailure
						? "unavailable"
						: "missing";
		return {
			assetId,
			label: asset?.label ?? null,
			status,
			phase: job?.phase ?? null,
			failure: job?.failure?.kind ?? asset?.transcriptionFailure?.kind ?? null,
		};
	});
}

interface TransportRun {
	status: "running" | "ready" | "error";
	result: AgentTransportResult | null;
	error: string | null;
}

const transportRuns = new Map<string, TransportRun>();

function startTransportRun(
	runId: string,
	steps: Parameters<typeof runAgentTransport>[0],
): TransportRun {
	const existing = transportRuns.get(runId);
	if (existing) return existing;
	const run: TransportRun = { status: "running", result: null, error: null };
	transportRuns.set(runId, run);
	if (!getAgentTransport()) {
		run.status = "error";
		run.error = "TRANSPORT_UNAVAILABLE: The editor has not registered its transport.";
		return run;
	}
	// Resolved on every step: a seek across clips re-registers the shell's handlers
	// with the video element that is now on screen.
	const live = (): AgentTransportHandlers => {
		const transport = getAgentTransport();
		if (!transport)
			throw new Error("TRANSPORT_UNAVAILABLE: The editor unregistered its transport.");
		return transport;
	};
	const transport: AgentTransportHandlers = {
		seek: (sec) => live().seek(sec),
		click: (testId, fraction) => live().click(testId, fraction),
		wheel: (testId, fraction, deltaX, deltaY, ctrl) =>
			live().wheel(testId, fraction, deltaX, deltaY, ctrl),
		frame: () => live().frame(),
		frameEvidence: () => live().frameEvidence?.() ?? null,
		awaitFrameSettled: (budgetMs) =>
			// A shell without the handshake (older renderer) cannot prove freshness:
			// report the frame as unverified rather than silently settled.
			live().awaitFrameSettled?.(budgetMs) ?? Promise.resolve(false),
		play: () => live().play(),
		pause: () => live().pause(),
		snapshot: () => live().snapshot(),
	};
	runAgentTransport(steps, transport, {
		start: () => startUiProbe(3600),
		stop: () => stopUiProbe(),
		report: collectUiProbeReport,
	}).then(
		(result) => {
			run.status = "ready";
			run.result = result;
		},
		(error: unknown) => {
			run.status = "error";
			run.error = error instanceof Error ? error.message : String(error);
		},
	);
	return run;
}

/** Installed only by the editor window. The CLI never edits a second document model. */
export function installAgentEditorSession() {
	const api = window.electronAPI;
	if (!api?.onAgentSessionRequest || !api.replyAgentSession) return;
	const sendReply = api.replyAgentSession;
	return api.onAgentSessionRequest((message: AgentSessionMessage) => {
		void (async () => {
			let reply: AgentSessionReply;
			try {
				if (message.action === "open") {
					if (!message.projectId) throw new Error("Missing project ID");
					await useProjectStore.getState().loadProject(message.projectId);
					const opened = useProjectStore.getState();
					if (opened.status !== "ready" || !opened.document)
						throw new Error(opened.error ?? "The project did not load");
					sendReply({
						id: message.id,
						status: "completed",
						data: {
							projectId: opened.projectId,
							title: opened.document.project.title,
							clips: opened.document.timeline.clips.length,
							revision: opened.transactionVersion,
						},
					});
					return;
				}
				if (message.action === "presets") {
					sendReply({
						id: message.id,
						status: "completed",
						data: [...BUILTIN_VISUAL_PRESETS, ...loadVisualPresets()],
					});
					return;
				}
				const state = useProjectStore.getState();
				if (!state.document || !state.projectId)
					throw new Error("No project is open in the editor");
				if (message.projectId && state.projectId !== message.projectId)
					throw new Error("The active project changed");
				let data: unknown;
				switch (message.action) {
					case "stage":
					case "staged":
					case "accept":
					case "reject": {
						usePauseAnalysisStore.getState().syncDocument(state.projectId, state.revision);
						const lane = usePauseAnalysisStore.getState();
						if (lane.accepting && message.action !== "staged")
							throw Object.assign(new Error("The proposed cuts are being accepted."), {
								code: "BUSY",
							});
						if (message.cutIds?.some((id) => !lane.suggestions.some((cut) => cut.id === id)))
							throw Object.assign(new Error("Unknown staged cut ID."), { code: "INVALID_INPUT" });
						let staged: string[] | undefined;
						let result: string | undefined;
						if (message.action === "stage") {
							if (!message.stagedCuts) throw new Error("Missing staged operations");
							staged = lane.stageCuts(
								cutsFromOperations(
									state.document,
									message.stagedCuts.operations,
									message.stagedCuts.planId,
								),
							);
						} else if (message.action === "accept") {
							result = await lane.acceptAll(message.cutIds, message.mutationRequestId);
							if (result === "conflict" || result === "project-changed")
								throw Object.assign(new Error("Could not accept cuts; the lane is retained."), {
									code: "CONFLICT",
								});
						} else if (message.action === "reject") {
							if (!message.cutIds?.length)
								throw Object.assign(new Error("Supply cut IDs."), { code: "INVALID_INPUT" });
							for (const id of message.cutIds) lane.rejectCut(id);
						}
						const current = useProjectStore.getState().document ?? state.document;
						const projection = buildTimelinePlaybackProjection(
							resolvePlaybackSegments(current.timeline.clips, current.timeline.trimRanges),
							current.timeline.clips,
						);
						const updated = usePauseAnalysisStore.getState();
						const offset = message.cutOffset ?? 0;
						data = {
							...(staged ? { staged } : {}),
							...(result
								? {
										result,
										receipt:
											result === "applied"
												? useProjectStore.getState().lastTransactionReceipt
												: null,
									}
								: {}),
							lane_count: updated.suggestions.length,
							rejected_earlier: updated.rejectedEarlier,
							...(message.action === "staged"
								? {
										offset,
										next_offset: offset + 25 < updated.suggestions.length ? offset + 25 : null,
										cuts: updated.suggestions.slice(offset, offset + 25).map((cut) => ({
											id: cut.id,
											clipId: cut.clipId,
											assetId: cut.assetId,
											kind: cut.kind,
											origin: cut.origin,
											selected: cut.selected,
											sourceStartSec: cut.sourceStartSec,
											sourceEndSec: cut.sourceEndSec,
											editedStartSec: rawTimeToPlaybackTime(cut.timelineStartSec, projection),
											editedEndSec: rawTimeToPlaybackTime(cut.timelineEndSec, projection),
										})),
									}
								: {}),
						};
						break;
					}
					case "direction-observations":
						if (JSON.stringify(state.document) !== message.documentKey)
							throw new Error("STALE_DOCUMENT: Retry automatic direction.");
						data = requestDirectionObservations(state.document, message.directionSettings);
						break;
					case "capabilities":
						data = {
							contract: 1,
							session_id: agentCapabilitySession,
							build_id: agentBuildId,
							capabilities: {
								editor: true,
								fresh_frames:
									Boolean(getAgentTransport()?.awaitFrameSettled) && isPreviewFrameSettled(),
							},
						};
						break;
					case "inspect":
						data = {
							document: state.document,
							projectId: state.projectId,
							dirty: state.dirty,
							currentTimeSec: state.currentTimeSec,
							revision: state.transactionVersion,
							busy: state.transactionBusy,
							syncPending: state.transactionSyncPending,
						};
						break;
					case "activate":
						data = await activateProjectTransactions(state.projectId);
						break;
					case "apply": {
						if (!message.guard) throw new Error("Missing transaction guard");
						data = await applyExternalProjectTransaction(
							state.projectId,
							documentSchema.parse(message.document),
							message.guard,
						);
						break;
					}
					case "transcribe": {
						void useTranscriptionStore.getState().requestTimelineTranscripts();
						data = { assets: transcriptionReport(state.document) };
						break;
					}
					case "pauses": {
						if (!message.pausePolicy) throw new Error("Missing pause policy");
						data = requestAgentPauseAnalysis(
							state.document,
							state.transactionVersion?.revision ?? "unsaved",
							message.pausePolicy,
							(document, policy) => analyzeProjectPauses(document, policy),
						);
						break;
					}
					case "transport": {
						if (!message.transport) throw new Error("Missing transport script");
						data = startTransportRun(message.transport.runId, message.transport.steps);
						break;
					}
					case "state": {
						if (!message.editState) throw new Error("Missing state request");
						const runtime = await api
							.getCleanVoiceRuntime?.(
								state.projectId,
								state.document.assets.map((asset) => asset.id),
							)
							.catch(() => null);
						data = {
							...resolveStateReport(
								buildResolvedEdit(state.document),
								message.editState,
								runtime ? cleanVoiceRoutes(runtime) : undefined,
							),
							revision: state.transactionVersion?.revision ?? "unsaved",
							documentKey: JSON.stringify(state.document),
						};
						break;
					}
					case "check": {
						if (!message.editCheck) throw new Error("Missing check request");
						const { files, documentKey, ...request } = message.editCheck;
						if (JSON.stringify(state.document) !== documentKey)
							throw new Error("STALE_DOCUMENT: The edit changed during file checks; retry.");
						const document = state.document;
						const run = requestAgentChecks(
							document,
							state.transactionVersion?.revision ?? "unsaved",
							request,
							files,
							(progress, signal) =>
								analyzeProjectChecks(document, request, files, progress, signal),
						);
						data = { ...run, result: run.result ? pageChecks(run.result, request) : null };
						break;
					}
					case "cutpoint": {
						if (!message.cutPoint) throw new Error("Missing cut point request");
						data = requestAgentCutPoint(
							state.document,
							state.transactionVersion?.revision ?? "unsaved",
							message.cutPoint,
							(document, request) =>
								analyzeCutPoint(
									document,
									{ clipId: request.clipId, timeSec: request.timeSec, edge: request.edge },
									request.policy,
								),
						);
						break;
					}
					case "edges": {
						if (!message.edgePolicy) throw new Error("Missing edge policy");
						data = requestAgentEdgeAnalysis(
							state.document,
							state.transactionVersion?.revision ?? "unsaved",
							message.edgePolicy,
							(document, policy) => analyzeProjectEdges(document, policy),
						);
						break;
					}
					default:
						throw new Error("Unsupported session action");
				}
				reply = { id: message.id, status: "completed", data };
			} catch (error) {
				reply = {
					id: message.id,
					status: "failed",
					error: {
						code:
							error instanceof Error && "code" in error ? String(error.code) : "EDITOR_UNAVAILABLE",
						message: error instanceof Error ? error.message : String(error),
					},
				};
			}
			sendReply(reply);
		})();
	});
}

const agentCapabilitySession = crypto.randomUUID();
