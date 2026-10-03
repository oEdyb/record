import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import path from "node:path";
import { ZodError, z } from "zod";
import { boundAgentReply } from "../ai-edition/agentVerification";
import { compactAgentReply } from "./agentCompact";
import {
	AGENT_API_VERSION,
	agentCommands,
	agentGuide,
	agentOperations,
	type CliAgentCommand,
	parseAgentCommand,
} from "./agentContracts";
import {
	agentErrorCode,
	exitCodeForError,
	exitCodeForReply,
	normalizeAgentError,
	unknownCommitRecoveryHint,
	verifyUnavailableHint,
} from "./agentOutputContract";
import { attachVerification } from "./agentProof";
import type { ProposalFlowReply } from "./agentWriteFlow";

/** Read-only commands deliberately do not start Electron windows or media analysis. */
export async function runAgentCommand(
	command: CliAgentCommand,
	out: (text: string) => void,
	options: {
		brokerSocketPath?: string;
		projectsDirectory?: string;
		previewLaunch?: import("./agentPreview").AgentPreviewLaunch;
		/** NDJSON progress/planned envelopes; defaults to dropped when absent. */
		err?: (text: string) => void;
	} = {},
): Promise<number> {
	const requestId = randomUUID();
	// `--stream` is a CLI-level output flag, not a command input: strip it before
	// schema parsing so unknown-flag strictness keeps rejecting everything else.
	const args = command.args.filter((arg) => arg !== "--stream" && arg !== "--compact");
	const stream = command.args.includes("--stream");
	const compact = command.args.includes("--compact");
	const writeErr = options.err ?? (() => undefined);
	const envelope = (result: Record<string, unknown>) => {
		let merged: Record<string, unknown> = {
			api_version: AGENT_API_VERSION,
			request_id: requestId,
			...result,
		};
		if (merged.status !== "completed" && merged.error !== undefined)
			merged.error = normalizeAgentError(merged.error);
		const entry = Object.entries(agentCommands).find(([name]) => name === args[0]);
		if (entry && merged.status !== "planned") merged = attachVerification(merged, entry[1].policy);
		if (compact) {
			try {
				merged = compactAgentReply(merged, path.resolve(command.cwd, "klippt-agent-artifacts"));
			} catch (error) {
				merged = {
					...merged,
					compact_output_error: error instanceof Error ? error.message : String(error),
					output_mode: "full_fallback",
				};
			}
		}
		return `${JSON.stringify(
			(["text", "broll", "zoom", "camera", "layout", "clip", "settings", "preset", "auto"].includes(
				args[0],
			)
				? boundAgentReply
				: (value: unknown) => value)(merged),
		)}\n`;
	};
	const emit = (result: Record<string, unknown>) => out(envelope(result));
	// Progress and planned envelopes leave stdout unless the caller opted into
	// a single NDJSON stream; stdout carries exactly one terminal envelope.
	const progress = (result: Record<string, unknown>) =>
		stream ? out(envelope(result)) : writeErr(envelope(result));
	// batch owns its own strict flag parsing and step validation; it never goes
	// through parseAgentCommand.
	if (args[0] === "batch") {
		const { runAgentBatch } = await import("./agentBatch");
		return runAgentBatch(
			{ ...command, args },
			compact ? (text) => emit(z.record(z.string(), z.unknown()).parse(JSON.parse(text))) : out,
			{ ...options, err: writeErr },
		);
	}
	let parsed: Exclude<ReturnType<typeof parseAgentCommand>, { command: "batch" }>;
	try {
		const parsedCommand = parseAgentCommand(args);
		// batch was intercepted above; the registry entry exists for guide/contracts
		// discovery only, so it can never be the parsed command here.
		if (parsedCommand.command === "batch") throw new Error("Unknown agent command.");
		parsed = parsedCommand;
	} catch (error) {
		emit({
			status: "failed",
			error: {
				code: "INVALID_INPUT",
				message: error instanceof Error ? error.message : String(error),
				field_errors: error instanceof ZodError ? error.issues : [],
				retryable: false,
			},
			next_actions: [{ command: "klippt agent guide --json" }],
		});
		return args[0] === "check" ? 0 : 2;
	}
	try {
		if (parsed.command === "doctor") {
			const { agentDoctor } = await import("./agentDoctor");
			emit({
				status: "completed",
				data: await agentDoctor(parsed.input, options.brokerSocketPath),
			});
			return 0;
		}
		if (parsed.command === "skill" || (parsed.command === "guide" && parsed.input.skill)) {
			const { agentSkill } = await import("./agentSkill");
			emit({ status: "completed", data: agentSkill() });
			return 0;
		}
		if (
			parsed.command === "staged" ||
			parsed.command === "accept" ||
			parsed.command === "reject" ||
			parsed.command === "history" ||
			parsed.command === "undo" ||
			parsed.command === "redo" ||
			parsed.command === "live" ||
			parsed.command === "plan" ||
			parsed.command === "import-plan" ||
			parsed.command === "apply" ||
			parsed.command === "receipt" ||
			parsed.command === "transcribe" ||
			parsed.command === "pauses" ||
			parsed.command === "verify" ||
			parsed.command === "open"
		) {
			if (!options.brokerSocketPath)
				throw new Error(
					"OWNER_UNAVAILABLE: Start Klippt with the experimental agent bridge enabled.",
				);
			const { requestAgentBroker } = await import("./agentBroker");
			let input: Record<string, unknown> = {};
			let operationRequestId: string = requestId;
			if (parsed.command === "plan" || parsed.command === "import-plan") {
				const handle = await open(path.resolve(command.cwd, parsed.input.input), "r");
				let operations: unknown;
				try {
					if (!(await handle.stat()).isFile())
						throw new Error("INVALID_INPUT: Plan input must be a regular JSON file");
					const buffer = Buffer.alloc(1024 * 1024 + 1);
					let total = 0;
					while (total < buffer.length) {
						const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
						if (!bytesRead) break;
						total += bytesRead;
					}
					if (total > 1024 * 1024) throw new Error("INVALID_INPUT: Plan input exceeds 1 MiB");
					try {
						operations = JSON.parse(buffer.subarray(0, total).toString("utf8"));
					} catch (error) {
						throw new Error(
							`INVALID_INPUT: Plan input is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
						);
					}
				} finally {
					await handle.close();
				}
				input =
					parsed.command === "import-plan"
						? { projectId: parsed.input.project_id, media: operations }
						: {
								projectId: parsed.input.project_id,
								operations,
								...(parsed.input.stage ? { stage: true } : {}),
							};
			} else if (parsed.command === "apply") {
				input = {
					projectId: parsed.input.project_id,
					planId: parsed.input.plan_id,
					...(parsed.input.force ? { force: true } : {}),
					...(parsed.input.deep ? { deep: true } : {}),
				};
				operationRequestId = parsed.input.request_id;
			} else if (parsed.command === "verify") {
				input = {
					projectId: parsed.input.project_id,
					range: { startSec: parsed.input.range[0], endSec: parsed.input.range[1] },
					...(parsed.input.out ? { out: path.resolve(command.cwd, parsed.input.out) } : {}),
				};
			} else if (
				parsed.command === "staged" ||
				parsed.command === "accept" ||
				parsed.command === "reject"
			) {
				if (parsed.command === "accept") operationRequestId = parsed.input.request_id ?? requestId;
				input = {
					projectId: parsed.input.project_id,
					...("ids" in parsed.input && parsed.input.ids ? { ids: parsed.input.ids } : {}),
					...("offset" in parsed.input && parsed.input.offset !== undefined
						? { offset: parsed.input.offset }
						: {}),
				};
			} else if (parsed.command === "history") {
				input = { projectId: parsed.input.project_id };
			} else if (parsed.command === "undo" || parsed.command === "redo") {
				const { project_id, request_id, ...rest } = parsed.input;
				input = { projectId: project_id, ...rest };
				operationRequestId = request_id ?? requestId;
			} else if (parsed.command === "receipt") {
				input = {
					projectId: parsed.input.project_id,
					operationRequestId: parsed.input.request_id,
				};
			} else if (parsed.command === "transcribe" || parsed.command === "open") {
				input = { projectId: parsed.input.project_id };
			} else if (parsed.command === "pauses") {
				const { buildPausePolicy } = await import("./agentPauses");
				input = {
					projectId: parsed.input.project_id,
					policy: buildPausePolicy(parsed.input),
					...(parsed.input.clips ? { clips: parsed.input.clips } : {}),
					offset: parsed.input.offset,
					limit: parsed.input.limit,
				};
			}
			const response = await requestAgentBroker(options.brokerSocketPath, {
				api_version: "1.0",
				request_id: operationRequestId,
				command: parsed.command === "live" ? "inspect" : parsed.command,
				input,
			});
			// Phase 4: a ready pauses page removes footage, so it stages into the
			// proposal lane by default; --accept "<reason>" applies the page.
			if (
				parsed.command === "pauses" &&
				response &&
				typeof response === "object" &&
				(response as { status?: unknown }).status === "completed"
			) {
				const data = (response as { data?: Record<string, unknown> }).data;
				if (
					data &&
					data.status === "ready" &&
					Array.isArray(data.operations) &&
					data.operations.length > 0
				) {
					const { runProposalFlow } = await import("./agentWriteFlow");
					const socket = options.brokerSocketPath as string;
					const flow = await runProposalFlow(
						(name, flowInput, id = randomUUID()) =>
							requestAgentBroker(socket, {
								api_version: "1.0",
								request_id: id,
								command: name,
								input: flowInput,
							}) as Promise<ProposalFlowReply>,
						{
							projectId: parsed.input.project_id,
							operations: data.operations as { type: string; args: Record<string, unknown> }[],
							accept: parsed.input.accept,
							requestId: parsed.input.request_id ?? requestId,
						},
					);
					if (flow.status !== "completed" || !flow.data) {
						emit(flow);
						return exitCodeForReply(flow);
					}
					emit({ status: "completed", data: { ...data, ...flow.data } });
					return 0;
				}
			}
			const envelope: Record<string, unknown> =
				response && typeof response === "object"
					? { ...(response as Record<string, unknown>) }
					: {
							status: "failed",
							error: {
								code: "BROKER_OUTCOME_UNKNOWN",
								message: "The editor returned an unreadable reply.",
							},
						};
			// Verify keeps check's semantics: exit 0 with findings in data. An
			// unavailable deep pass is NOT a pass, so the envelope says so —
			// the error-level content.unavailable findings carry the details.
			const verifyData = envelope.data;
			if (
				parsed.command === "verify" &&
				envelope.status === "completed" &&
				verifyData &&
				typeof verifyData === "object" &&
				(verifyData as { status?: unknown }).status === "unavailable"
			)
				envelope.hint = verifyUnavailableHint();
			emit(envelope);
			return exitCodeForReply(response);
		}
		if (parsed.command === "settings" || parsed.command === "preset" || parsed.command === "auto") {
			const socket = options.brokerSocketPath;
			if (!socket) throw new Error("OWNER_UNAVAILABLE: Enable the agent bridge.");
			const { requestAgentBroker } = await import("./agentBroker");
			const { applySettingsPlan, settingsOperations, automaticOperations } = await import(
				"./agentSettingsCommands"
			);
			let result;
			const request = (r: import("./agentBroker").AgentBrokerRequest) =>
				requestAgentBroker(socket, r);
			if (parsed.command === "settings" && parsed.input.action === "set") {
				result = await applySettingsPlan(
					parsed.input.project_id,
					{ operations: settingsOperations(parsed.input) },
					parsed.input,
					requestId,
					request,
				);
			} else if (parsed.command === "auto") {
				result = await applySettingsPlan(
					parsed.input.project_id,
					{ operations: automaticOperations(parsed.input) },
					parsed.input,
					requestId,
					request,
				);
			} else if (parsed.command === "preset" && parsed.input.action === "apply") {
				if (!parsed.input.project_id) throw new Error("PROJECT_ID_REQUIRED");
				result = await applySettingsPlan(
					parsed.input.project_id,
					{ preset: { name: parsed.input.name, source: parsed.input.source } },
					parsed.input,
					requestId,
					request,
				);
			} else {
				result = await request({
					api_version: "1.0",
					request_id: requestId,
					command: parsed.command,
					input:
						parsed.command === "settings" ? { projectId: parsed.input.project_id } : parsed.input,
				});
			}
			const response = z
				.looseObject({ status: z.string(), data: z.unknown().optional() })
				.parse(result);
			if (
				parsed.command === "settings" &&
				!parsed.input.action &&
				!command.json &&
				response.status === "completed"
			) {
				const { formatAgentSettings } = await import("../ai-edition/agentEditorSettings");
				out(`${formatAgentSettings(response.data)}\n`);
			} else emit(response);
			return response.status === "completed" ? 0 : exitCodeForReply(response);
		}
		if (parsed.command === "transport") {
			if (!options.brokerSocketPath)
				throw new Error(
					"OWNER_UNAVAILABLE: Start Klippt with the experimental agent bridge enabled.",
				);
			const { requestAgentBroker } = await import("./agentBroker");
			const { transportStepsSchema } = await import("./agentTransportCommand");
			const { readFile } = await import("node:fs/promises");
			const raw = await readFile(path.resolve(command.cwd, parsed.input.script), "utf8");
			if (raw.length > 64 * 1024) throw new Error("INVALID_INPUT: Transport script exceeds 64 KiB");
			const steps = transportStepsSchema.parse(JSON.parse(raw));
			const runId = randomUUID();
			const deadline = Date.now() + 120_000;
			while (Date.now() < deadline) {
				const response = (await requestAgentBroker(options.brokerSocketPath, {
					api_version: "1.0",
					request_id: randomUUID(),
					command: "transport",
					input: { projectId: parsed.input.project_id, runId, steps },
				})) as { status: string; data?: Record<string, unknown> };
				if (response.status !== "completed" || !response.data) {
					emit(response);
					return exitCodeForReply(response);
				}
				if (response.data.status === "ready") {
					emit({
						status: "completed",
						data: { run_id: runId, ...response.data },
					});
					return 0;
				}
				if (response.data.status === "error") {
					emit({
						status: "failed",
						error: { code: "TRANSPORT_FAILED", message: response.data.error },
					});
					return exitCodeForError("TRANSPORT_FAILED");
				}
				await new Promise((resolve) => setTimeout(resolve, 1000));
			}
			emit({
				status: "failed",
				error: {
					code: "EDITOR_TIMEOUT",
					message: "Transport run did not finish in time",
				},
			});
			return exitCodeForError("EDITOR_TIMEOUT");
		}
		if (
			parsed.command === "clip" ||
			parsed.command === "text" ||
			parsed.command === "broll" ||
			parsed.command === "zoom" ||
			parsed.command === "camera"
		) {
			const socket = options.brokerSocketPath;
			if (!socket) throw new Error("OWNER_UNAVAILABLE: Enable the agent bridge.");
			const { requestAgentBroker } = await import("./agentBroker");
			const { applyPlacementCommand, placementIntentSchema } = await import("./agentPlacement");
			const result = await applyPlacementCommand(
				parsed.command === "clip"
					? { ...parsed.input, kind: "clip" }
					: parsed.command === "broll" && parsed.input.action === "swap"
						? { ...parsed.input, kind: "broll-swap" }
						: placementIntentSchema.parse({
								...parsed.input,
								kind: parsed.command,
							}),
				requestId,
				(r) => requestAgentBroker(socket, r),
				(plan) => progress({ status: "planned", data: plan }),
			);
			emit(result);
			return result.status === "completed" ? 0 : exitCodeForReply(result);
		}
		if (parsed.command === "assets" || parsed.command === "frame" || parsed.command === "frames") {
			if (!options.projectsDirectory) throw new Error("PROJECT_DIRECTORY_UNAVAILABLE");
			if (!/^[A-Za-z0-9_-]+$/.test(parsed.input.project_id)) throw new Error("INVALID_PROJECT_ID");
			const projectPath = path.join(options.projectsDirectory, `${parsed.input.project_id}.klippt`);
			const cacheDirectory = path.join(
				path.dirname(options.projectsDirectory),
				"cache",
				"agent-media",
			);
			const { loadAgentDocument } = await import("./agentInspection");
			const loaded = await loadAgentDocument(projectPath);
			if (loaded.document.project.id !== parsed.input.project_id)
				throw new Error("PROJECT_MISMATCH");
			const { resolveFfmpeg } = await import("../media/audioPeaks");
			const ffmpeg = resolveFfmpeg();
			if (parsed.command === "assets") {
				if (!ffmpeg) throw new Error("FFMPEG_UNAVAILABLE");
				const { listAgentAssets } = await import("./agentAssets");
				emit({
					status: "completed",
					data: {
						source: "saved_project",
						assets: await listAgentAssets(loaded.document, cacheDirectory, ffmpeg),
					},
				});
			} else {
				if (!options.previewLaunch)
					throw new Error("PREVIEW_UNAVAILABLE: Trusted app launch configuration is required.");
				if (parsed.command === "frames" && !ffmpeg) throw new Error("FFMPEG_UNAVAILABLE");
				const { renderAgentFrames } = await import("./agentFrames");
				emit({
					status: "completed",
					data: await renderAgentFrames({
						projectPath,
						at: parsed.command === "frame" ? [parsed.input.at] : parsed.input.at,
						out: parsed.input.out,
						cacheDirectory,
						launch: options.previewLaunch,
						ffmpeg: ffmpeg ?? undefined,
						sheet: parsed.command === "frames",
					}),
				});
			}
			return 0;
		}
		if (parsed.command === "layout") {
			const socketPath = options.brokerSocketPath;
			if (!socketPath)
				throw new Error(
					"OWNER_UNAVAILABLE: Start Klippt with the experimental agent bridge enabled.",
				);
			const { requestAgentBroker } = await import("./agentBroker");
			const { applyLayoutCommand } = await import("./agentLayout");
			const response = await applyLayoutCommand(
				parsed.input,
				requestId,
				(request) => requestAgentBroker(socketPath, request),
				(plan) => progress({ status: "planned", data: plan }),
			);
			emit(response);
			return response.status === "completed" ? 0 : exitCodeForReply(response);
		}
		if (parsed.command === "state" || parsed.command === "check") {
			const { formatStateHuman, formatCheckHuman, explainCheck } = await import("./agentEditState");
			if (parsed.command === "check" && parsed.input.explain) {
				const explanation = explainCheck(parsed.input.explain);
				if (command.json || command.args.includes("--json"))
					emit({ status: "completed", data: explanation });
				else
					out(
						`${explanation.id} (${explanation.severity})\n${explanation.describe}\nFix: ${explanation.fix}\n`,
					);
				return 0;
			}
			if (!options.brokerSocketPath)
				throw new Error(
					"OWNER_UNAVAILABLE: Start Klippt with the experimental agent bridge enabled.",
				);
			const { requestAgentBroker } = await import("./agentBroker");
			const range = parsed.input.range
				? { startSec: parsed.input.range[0], endSec: parsed.input.range[1] }
				: undefined;
			const input = {
				projectId: parsed.input.project_id,
				...(range ? { range } : {}),
				...(parsed.command === "state"
					? { at: parsed.input.at }
					: {
							rule: parsed.input.rule,
							deep: parsed.input.deep,
							page: parsed.input.page,
							page_size:
								command.json || command.args.includes("--json")
									? parsed.input.page_size
									: Math.min(parsed.input.page_size, parsed.input.limit),
						}),
			};
			const response = (await requestAgentBroker(options.brokerSocketPath, {
				api_version: "1.0",
				request_id: randomUUID(),
				command: parsed.command,
				input,
			})) as { status: string; data?: Record<string, unknown> };
			if (response.status !== "completed" || !response.data) {
				emit(response);
				return parsed.command === "check" ? 0 : exitCodeForReply(response);
			}
			const data = response.data;
			if (command.json || command.args.includes("--json") || data.status === "error")
				emit({
					status: data.status === "error" ? "failed" : "completed",
					data,
				});
			else if (parsed.command === "state")
				out(
					`revision=${data.revision} hash=${data.documentHash}\n${formatStateHuman(data as unknown as import("../../src/lib/ai-edition/agent/effectiveState").StateResult)}\n`,
				);
			else {
				const human = data.result
					? formatCheckHuman(
							{
								...(data.result as import("../../src/lib/ai-edition/checks").CheckResult),
								notes: [
									`status=${data.status} audio=${JSON.stringify(data.audio)} revision=${data.revision} hash=${data.documentHash}`,
									...(data.result as import("../../src/lib/ai-edition/checks").CheckResult).notes,
								],
							},
							parsed.input.limit,
						)
					: "No findings yet.";
				out(`${human}\n`);
			}
			return 0;
		}
		if (parsed.command === "cutpoint") {
			if (!options.brokerSocketPath)
				throw new Error(
					"OWNER_UNAVAILABLE: Start Klippt with the experimental agent bridge enabled.",
				);
			const { requestAgentBroker } = await import("./agentBroker");
			const { buildCutPointPolicy } = await import("./agentCutPoint");
			const input = {
				projectId: parsed.input.project_id,
				clipId: parsed.input.clip,
				time: parsed.input.time,
				edge: parsed.input.edge,
				policy: buildCutPointPolicy(parsed.input),
			};
			const deadline = Date.now() + 120_000;
			while (Date.now() < deadline) {
				const response = (await requestAgentBroker(options.brokerSocketPath, {
					api_version: "1.0",
					request_id: randomUUID(),
					command: "cutpoint",
					input,
				})) as { status: string; data?: Record<string, unknown> };
				if (response.status !== "completed" || !response.data) {
					emit(response);
					return exitCodeForReply(response);
				}
				if (response.data.status === "ready") {
					// Phase 4: a chosen cut removes footage, so it stages into the
					// proposal lane by default; --accept "<reason>" applies directly.
					const data = response.data;
					const chosen = data.chosen as { cut_sec?: unknown } | null | undefined;
					const cutSec = chosen && typeof chosen.cut_sec === "number" ? chosen.cut_sec : null;
					let operations: { type: string; args: Record<string, unknown> }[] = [];
					let proposalNote: string | undefined;
					if (cutSec !== null) {
						const { cutPointRemovalOperation } = await import("./agentCutPoint");
						const inspection = (await requestAgentBroker(options.brokerSocketPath, {
							api_version: "1.0",
							request_id: randomUUID(),
							command: "inspect",
							input: {},
						})) as { status: string; data?: Record<string, unknown> };
						const clips =
							inspection.status === "completed" && Array.isArray(inspection.data?.clips)
								? (inspection.data.clips as {
										id?: unknown;
										source?: { start?: unknown; end?: unknown };
									}[])
								: [];
						const entry = clips.find((clip) => clip.id === data.clip_id);
						const start = entry?.source?.start;
						const end = entry?.source?.end;
						if (typeof start === "number" && typeof end === "number") {
							const operation = cutPointRemovalOperation(
								{
									clipId: parsed.input.clip,
									edge: parsed.input.edge,
									cutSec,
								},
								{ sourceStartSec: start, sourceEndSec: end },
							);
							if (operation) operations = [operation];
							else proposalNote = "The chosen cut leaves nothing to remove; nothing was staged.";
						} else {
							proposalNote =
								"Clip bounds are unavailable in live inspect (the clip is past the first inspect page); stage the cut manually with plan --stage.";
						}
					}
					if (operations.length === 0) {
						emit({
							status: "completed",
							data: {
								...data,
								staged: false,
								applied: false,
								...(proposalNote ? { proposal_note: proposalNote } : {}),
							},
						});
						return 0;
					}
					const { runProposalFlow } = await import("./agentWriteFlow");
					const socket = options.brokerSocketPath;
					const flow = await runProposalFlow(
						(name, flowInput, id = randomUUID()) =>
							requestAgentBroker(socket, {
								api_version: "1.0",
								request_id: id,
								command: name,
								input: flowInput,
							}) as Promise<ProposalFlowReply>,
						{
							projectId: parsed.input.project_id,
							operations,
							accept: parsed.input.accept,
							requestId: parsed.input.request_id ?? requestId,
						},
					);
					if (flow.status !== "completed" || !flow.data) {
						emit(flow);
						return exitCodeForReply(flow);
					}
					emit({ status: "completed", data: { ...data, ...flow.data } });
					return 0;
				}
				if (response.data.status === "error") {
					emit({
						status: "failed",
						error: { code: "ANALYSIS_FAILED", message: response.data.error },
					});
					return exitCodeForError("ANALYSIS_FAILED");
				}
				await new Promise((resolve) => setTimeout(resolve, 1000));
			}
			emit({
				status: "failed",
				error: {
					code: "EDITOR_TIMEOUT",
					message: "Cut point analysis did not finish in time",
				},
			});
			return exitCodeForError("EDITOR_TIMEOUT");
		}
		if (parsed.command === "edges") {
			if (!options.brokerSocketPath)
				throw new Error(
					"OWNER_UNAVAILABLE: Start Klippt with the experimental agent bridge enabled.",
				);
			const { requestAgentBroker } = await import("./agentBroker");
			const { buildEdgePolicy } = await import("./agentEdges");
			const projectId = parsed.input.project_id;
			const policy = buildEdgePolicy(parsed.input);
			const ask = (name: string, input: Record<string, unknown>, id: string = randomUUID()) =>
				requestAgentBroker(options.brokerSocketPath as string, {
					api_version: "1.0",
					request_id: id,
					command: name,
					input,
				}) as Promise<{
					status: string;
					data?: Record<string, unknown>;
					error?: unknown;
				}>;
			let report: Record<string, unknown> | undefined;
			const deadline = Date.now() + 120_000;
			while (Date.now() < deadline) {
				const response = await ask("edges", { projectId, policy });
				if (response.status !== "completed" || !response.data) {
					emit(response);
					return exitCodeForReply(response);
				}
				report = response.data;
				if (report.status === "ready") break;
				if (report.status === "error") {
					emit({
						status: "failed",
						error: { code: "ANALYSIS_FAILED", message: report.error },
					});
					return exitCodeForError("ANALYSIS_FAILED");
				}
				await new Promise((resolve) => setTimeout(resolve, 1000));
			}
			if (!report || report.status !== "ready") {
				emit({
					status: "failed",
					error: {
						code: "EDITOR_TIMEOUT",
						message: "Edge analysis did not finish in time",
					},
				});
				return exitCodeForError("EDITOR_TIMEOUT");
			}
			const remove = parsed.input.remove === "true";
			const operations = (remove ? report.remove_operations : report.operations) as unknown[];
			const base = {
				mode: remove ? "remove" : "apply",
				policy,
				analyzed_clip_count: report.analyzed_clip_count,
				missing_speech_activity: report.missing_speech_activity,
				missing_microphone: report.missing_microphone,
				totals: report.totals,
			};
			if (operations.length === 0) {
				emit({
					status: "completed",
					data: { ...base, trims: 0, changed: false, staged: false, applied: false },
				});
				return 0;
			}
			// Phase 4: footage removal stages into the proposal lane by default;
			// --accept "<reason>" applies directly. --remove true restores footage
			// (removeTrims), so it keeps the direct guarded apply.
			if (!remove) {
				const { runProposalFlow } = await import("./agentWriteFlow");
				const flow = await runProposalFlow(
					(name, flowInput, id = randomUUID()) =>
						requestAgentBroker(options.brokerSocketPath as string, {
							api_version: "1.0",
							request_id: id,
							command: name,
							input: flowInput,
						}) as Promise<ProposalFlowReply>,
					{
						projectId,
						operations: operations as { type: string; args: Record<string, unknown> }[],
						accept: parsed.input.accept,
						requestId: parsed.input.request_id ?? requestId,
					},
				);
				if (flow.status !== "completed" || !flow.data) {
					emit(flow);
					return exitCodeForReply(flow);
				}
				emit({
					status: "completed",
					data: { ...base, trims: operations.length, ...flow.data },
				});
				return 0;
			}
			const plan = await ask("plan", { projectId, operations });
			if (plan.status !== "completed" || !plan.data) {
				emit(plan);
				return exitCodeForReply(plan);
			}
			const applied = await ask(
				"apply",
				{ projectId, planId: plan.data.planId },
				parsed.input.request_id ?? requestId,
			);
			if (applied.status !== "completed") {
				emit(applied);
				return exitCodeForReply(applied);
			}
			emit({
				status: "completed",
				data: {
					...base,
					trims: operations.length,
					changed: true,
					receipt: applied.data?.receipt,
				},
			});
			return 0;
		}
		if (parsed.command === "shot") {
			if (!options.brokerSocketPath)
				throw new Error(
					"OWNER_UNAVAILABLE: Start Klippt with the experimental agent bridge enabled.",
				);
			if (!options.projectsDirectory) throw new Error("PROJECT_DIRECTORY_UNAVAILABLE");
			const { runAgentShot } = await import("./agentShot");
			const { requestAgentBroker } = await import("./agentBroker");
			const socket = options.brokerSocketPath;
			const result = await runAgentShot(parsed.input, {
				request: (name, requestInput, id) =>
					requestAgentBroker(socket, {
						api_version: "1.0",
						request_id: id ?? randomUUID(),
						command: name,
						input: requestInput,
					}) as Promise<ProposalFlowReply>,
				projectsDirectory: options.projectsDirectory,
				previewLaunch: options.previewLaunch,
			});
			emit(result);
			return exitCodeForReply(result);
		}
		if (parsed.command === "contracts") {
			emit({
				status: "completed",
				data: agentGuide(undefined, true),
			});
			return 0;
		}
		if (parsed.command === "guide") {
			emit({
				status: "completed",
				data: agentGuide(parsed.input.command),
			});
			return 0;
		}
		if (parsed.command === "operations") {
			emit({ status: "completed", data: agentOperations(parsed.input.type) });
			return 0;
		}
		if (parsed.command === "preview") {
			if (!options.previewLaunch)
				throw new Error("PREVIEW_UNAVAILABLE: Trusted app launch configuration is required.");
			const { renderAgentPreview } = await import("./agentPreview");
			emit({
				status: "completed",
				data: await renderAgentPreview({
					projectPath: path.resolve(command.cwd, parsed.input.project),
					snapshot: parsed.input.snapshot,
					outputDirectory: path.resolve(command.cwd, parsed.input.out),
					time: parsed.input.time,
					maxDimension: parsed.input.max_dimension,
					launch: options.previewLaunch,
				}),
			});
			return 0;
		}

		if (parsed.command === "clone") {
			if (!options.projectsDirectory)
				throw new Error("CLONE_UNAVAILABLE: The app projects folder is unknown.");
			const { cloneAgentProject } = await import("./agentClone");
			emit({
				status: "completed",
				data: await cloneAgentProject(
					path.resolve(command.cwd, parsed.input.project),
					options.projectsDirectory,
					parsed.input.title,
				),
			});
			return 0;
		}
		if (parsed.command === "media") {
			const { catalogAgentMedia } = await import("./agentMediaCatalog");
			emit({
				status: "completed",
				data: await catalogAgentMedia(
					path.resolve(command.cwd, parsed.input.directory),
					parsed.input,
				),
			});
			return 0;
		}
		const inspection = await import("./agentInspection");
		const loaded = await inspection.loadAgentDocument(
			parsed.command === "transcript" && parsed.input.project_id
				? (() => {
						if (!options.projectsDirectory) throw new Error("PROJECT_DIRECTORY_UNAVAILABLE");
						return path.join(options.projectsDirectory, `${parsed.input.project_id}.klippt`);
					})()
				: path.resolve(command.cwd, parsed.input.project ?? ""),
		);
		if (
			parsed.command === "transcript" &&
			parsed.input.project_id &&
			loaded.document.project.id !== parsed.input.project_id
		)
			throw new Error("PROJECT_MISMATCH");
		if (
			"snapshot" in parsed.input &&
			parsed.input.snapshot &&
			parsed.input.snapshot !== loaded.snapshot.sha256
		) {
			emit({
				status: "failed",
				snapshot: loaded.snapshot,
				error: {
					code: "SNAPSHOT_CHANGED",
					message: "The saved project changed. Inspect again before continuing.",
					retryable: false,
				},
			});
			return exitCodeForError("SNAPSHOT_CHANGED");
		}
		let data: unknown;
		switch (parsed.command) {
			case "geometry": {
				const { evaluateAgentProjectGeometry } = await import("./agentGeometry");
				const { resolveTimelineInstant, TIME_BASE_LABELS } = await import("./agentTimeBase");
				const timeInput = parsed.input.time;
				let clipIndex = parsed.input.clip;
				let sourceTimeSec: number;
				let requestedTime: ReturnType<typeof resolveTimelineInstant> | undefined;
				if (timeInput.base === "source") {
					// Compatibility: bare numbers stay source seconds on --clip.
					sourceTimeSec = timeInput.seconds;
				} else {
					requestedTime = resolveTimelineInstant(loaded.document, timeInput);
					if (requestedTime.source_sec === null || requestedTime.clip_index === null)
						throw new Error("TIME_OUTSIDE_PROJECT");
					sourceTimeSec = requestedTime.source_sec;
					clipIndex = requestedTime.clip_index;
				}
				data = {
					...evaluateAgentProjectGeometry(loaded.document, {
						clipIndex,
						sourceTimeSec,
					}),
					time_bases: {
						sourceTimeSec: TIME_BASE_LABELS.source,
						evaluatedSourceTimeSec: TIME_BASE_LABELS.source,
					},
					...(requestedTime ? { requested_time: requestedTime } : {}),
				};
				break;
			}
			case "inspect":
				data = inspection.inspectAgentProject(loaded.document);
				break;
			case "timeline":
				data = inspection.listAgentTimeline(loaded.document, {
					limit: parsed.input.limit,
					offset: parsed.input.offset,
				});
				break;
			case "item":
				data = inspection.getAgentItem(loaded.document, parsed.input.id);
				break;
			case "transcript": {
				const { readAgentTranscript, readAllAgentTranscripts } = await import("./agentTranscript");
				if (parsed.input.all) {
					data = readAllAgentTranscripts(loaded.document, parsed.input.page);
					break;
				}
				if (!parsed.input.clip) throw new Error("CLIP_REQUIRED");
				data = readAgentTranscript(loaded.document, {
					clipId: parsed.input.clip,
					offset: parsed.input.offset,
					limit: parsed.input.limit,
					minGapSec: parsed.input.min_gap,
				});
				break;
			}
		}
		emit({
			status: "completed",
			snapshot: loaded.snapshot,
			data,
			warnings: loaded.warnings,
		});
		return 0;
	} catch (error) {
		const errno = error instanceof Error ? (error as NodeJS.ErrnoException) : null;
		// A failed connect to the broker socket (missing or stale endpoint) is the
		// documented editor-unavailable class (4); project-file ENOENT stays 2.
		const brokerUnreachable =
			(errno?.code === "ENOENT" || errno?.code === "ECONNREFUSED") &&
			(errno?.syscall === "connect" ||
				(options.brokerSocketPath !== undefined &&
					(errno as { address?: unknown }).address === options.brokerSocketPath));
		const missing = !brokerUnreachable && errno?.code === "ENOENT";
		const operationRequestId =
			parsed.command === "apply" ||
			parsed.command === "undo" ||
			parsed.command === "redo" ||
			parsed.command === "accept"
				? (parsed.input.request_id ?? requestId)
				: undefined;
		// A refused connect proves the write never reached the editor.
		const uncertain = operationRequestId !== undefined && !missing && !brokerUnreachable;
		const code = brokerUnreachable
			? "EDITOR_UNAVAILABLE"
			: missing
				? "NOT_FOUND"
				: agentErrorCode(error);
		emit({
			status: uncertain ? "recovery_required" : "failed",
			...(operationRequestId !== undefined
				? {
						operation_request_id: operationRequestId,
						commit_status: uncertain ? "unknown" : "not_started",
					}
				: {}),
			error: {
				code,
				message: error instanceof Error ? error.message : String(error),
				// An unknown commit state must never advise a blind retry.
				...(uncertain ? { hint: unknownCommitRecoveryHint(operationRequestId) } : {}),
				retryable: false,
				field_errors: error instanceof ZodError ? error.issues : [],
			},
		});
		return parsed.command === "check" ? 0 : exitCodeForError(code);
	}
}
