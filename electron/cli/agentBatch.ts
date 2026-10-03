// Phase 5 batch runner: `klippt agent batch --input steps.json [--stop-on error|warning]
// [--verbosity summary|full]`. Runs a JSON array of porcelain invocations in one
// process against the live editor, in order, each step as its own guarded apply
// with a request id derived from the batch id and step index. One terminal
// summary envelope lands on stdout; step progress/planned envelopes pass through
// to stderr as NDJSON, matching the phase-2 output contract.
//
// Steps are executed by calling runAgentCommand (the existing porcelain entry
// point) with captured output, so parsing, guarded plan/apply, verify blocks and
// exit codes are the installed command layer's own, not a copy.
//
// Group undo: batch-derived step request ids look like `<batchId>:<index>`.
// AgentHistoryStore.select resolves `--to <batchId>` to the group's oldest
// retained entry, so `klippt agent undo --project_id <id> --to <batchId>`
// reverts the whole batch in one step. No broker or schema change is needed for
// grouping; steps that supply their own --request_id stay outside the group.
//
// REGISTRATION (integrator, electron/cli/agentMain.ts): inside runAgentCommand,
// after `writeErr` is defined and before `parseAgentCommand(args)`, add:
//
//   if (args[0] === "batch") {
//     const { runAgentBatch } = await import("./agentBatch");
//     return runAgentBatch({ ...command, args }, out, { ...options, err: writeErr });
//   }

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ZodError, z } from "zod";
import { boundAgentReply } from "../ai-edition/agentVerification";
import { agentCommands, type CliAgentCommand, parseAgentCommand } from "./agentContracts";
import {
	agentErrorCode,
	exitCodeForError,
	exitCodeForReply,
	normalizeAgentError,
} from "./agentOutputContract";

export interface AgentBatchOptions {
	brokerSocketPath?: string;
	projectsDirectory?: string;
	previewLaunch?: import("./agentPreview").AgentPreviewLaunch;
	/** NDJSON progress/planned envelopes from individual steps are forwarded here. */
	err?: (text: string) => void;
}

const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_STEPS = 100;
const MAX_FRAME_INSTANTS = 24; // renderAgentFrames limit

const batchFlagsSchema = z.strictObject({
	input: z.string().min(1).max(4096),
	stop_on: z.enum(["error", "warning"]).default("error"),
	verbosity: z.enum(["summary", "full"]).default("summary"),
});

const batchStepSchema = z.union([
	z.array(z.string().min(1).max(4096)).min(1).max(64),
	z.strictObject({
		label: z.string().min(1).max(200).optional(),
		args: z.array(z.string().min(1).max(4096)).min(1).max(64),
	}),
]);
const batchStepsSchema = z.array(batchStepSchema).min(1).max(MAX_STEPS);

function invalid(message: string, fieldErrors: unknown[] = []): Error {
	return Object.assign(new Error(`INVALID_INPUT: ${message}`), {
		code: "INVALID_INPUT",
		field_errors: fieldErrors,
	});
}

function parseBatchFlags(args: readonly string[]) {
	const values: Record<string, unknown> = {};
	const seen = new Set<string>();
	for (let i = 1; i < args.length; i += 1) {
		const flag = args[i];
		if (flag === "--json") continue;
		if (!flag.startsWith("--")) throw invalid(`Expected an option, got '${flag}'.`);
		const key = flag.slice(2).replace(/-/g, "_");
		if (seen.has(key)) throw invalid(`Duplicate option '${flag}'.`);
		seen.add(key);
		const value = args[++i];
		if (value === undefined || value.startsWith("--")) throw invalid(`${flag} requires a value.`);
		values[key] = value;
	}
	try {
		return batchFlagsSchema.parse(values);
	} catch (error) {
		if (error instanceof ZodError) throw invalid("Invalid batch flags.", error.issues);
		throw error;
	}
}

interface BatchStep {
	label?: string;
	args: string[];
}

async function readBatchSteps(cwd: string, input: string): Promise<BatchStep[]> {
	const file = path.resolve(cwd, input);
	let stat;
	try {
		stat = await fs.stat(file);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			throw Object.assign(new Error(`Batch input not found: ${file}`), { code: "NOT_FOUND" });
		throw error;
	}
	if (!stat.isFile()) throw invalid("Batch input must be a regular JSON file");
	if (stat.size > MAX_INPUT_BYTES) throw invalid("Batch input exceeds 1 MiB");
	let raw: unknown;
	try {
		raw = JSON.parse(await fs.readFile(file, "utf8"));
	} catch (error) {
		throw invalid(
			`Batch input is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
		);
	}
	const parsed = batchStepsSchema.safeParse(raw);
	if (!parsed.success) throw invalid("Batch input failed validation.", parsed.error.issues);
	return parsed.data.map((step) => (Array.isArray(step) ? { args: step } : step));
}

interface FindingLike {
	severity?: unknown;
}

function findingCounts(findings: FindingLike[]) {
	return {
		error: findings.filter((f) => f.severity === "error").length,
		warning: findings.filter((f) => f.severity === "warning").length,
		info: findings.filter((f) => f.severity === "info").length,
	};
}

/** Introduced findings reported by a step: verify delta on committed writes,
 * blocking findings on check-refused writes. */
function introducedFindingsOf(reply: Record<string, unknown>): FindingLike[] {
	const data = reply.data as Record<string, unknown> | undefined;
	const verify = data?.verify as Record<string, unknown> | undefined;
	const checks = verify?.checks as Record<string, unknown> | undefined;
	const fromVerify = Array.isArray(checks?.new) ? (checks.new as FindingLike[]) : [];
	if (fromVerify.length) return fromVerify;
	const error = reply.error as Record<string, unknown> | undefined;
	return Array.isArray(error?.findings) ? (error.findings as FindingLike[]) : [];
}

/** Touched edited-time instants, from the write's verify block. */
function touchedInstantsOf(reply: Record<string, unknown>): number[] {
	const data = reply.data as Record<string, unknown> | undefined;
	const verify = data?.verify as Record<string, unknown> | undefined;
	const range = verify?.range as { startSec?: unknown; endSec?: unknown } | undefined;
	const instants = [range?.startSec, range?.endSec].filter(
		(value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0,
	);
	return [...new Set(instants)];
}

export async function runAgentBatch(
	command: CliAgentCommand,
	out: (text: string) => void,
	options: AgentBatchOptions = {},
): Promise<number> {
	const batchId = randomUUID();
	const emit = (result: Record<string, unknown>) => {
		const envelope: Record<string, unknown> = {
			api_version: "1.0",
			request_id: batchId,
			...result,
		};
		if (envelope.status !== "completed" && envelope.error !== undefined)
			envelope.error = normalizeAgentError(envelope.error);
		out(`${JSON.stringify(boundAgentReply(envelope))}\n`);
	};
	const fail = (error: unknown): number => {
		const code = agentErrorCode(error);
		emit({
			status: "failed",
			error: {
				...(error && typeof error === "object" ? (error as Record<string, unknown>) : {}),
				code,
				message: error instanceof Error ? error.message : String(error),
				field_errors:
					error &&
					typeof error === "object" &&
					Array.isArray((error as { field_errors?: unknown }).field_errors)
						? (error as { field_errors: unknown[] }).field_errors
						: error instanceof ZodError
							? error.issues
							: [],
			},
		});
		return exitCodeForError(code);
	};

	let flags: z.infer<typeof batchFlagsSchema>;
	let steps: BatchStep[];
	try {
		flags = parseBatchFlags(command.args);
		steps = await readBatchSteps(command.cwd, flags.input);
	} catch (error) {
		return fail(error);
	}

	// Validate and normalize every step before any write: batch composition errors
	// must fail the whole input, not strand a half-executed batch.
	const derivedArgs: string[][] = [];
	const projectIds = new Set<string>();
	try {
		for (const [index, step] of steps.entries()) {
			// Batch owns streaming; a step's --stream would put progress on stdout.
			const args = step.args.filter((arg) => arg !== "--stream");
			if (!args.length) throw invalid(`Step ${index}: the step has no command.`);
			if (args[0] === "batch")
				throw invalid(`Step ${index}: nested batch steps are not supported.`);
			try {
				const entry = Object.entries(agentCommands).find(([name]) => name === args[0])?.[1];
				const groupsCommit = entry?.policy.effects.some((effect) => effect.startsWith("commit_"));
				const acceptsId =
					entry &&
					(entry.input instanceof z.ZodObject
						? "request_id" in entry.input.shape
						: entry.input.options.every((option) => "request_id" in option.shape));
				const hasRequestId = args.includes("--request_id") || args.includes("--request-id");
				const normalized =
					groupsCommit && acceptsId && !hasRequestId
						? [...args, "--request_id", `${batchId}:${index}`]
						: args;
				const parsed = parseAgentCommand(normalized);
				if ("project_id" in parsed.input && typeof parsed.input.project_id === "string")
					projectIds.add(parsed.input.project_id);
				derivedArgs.push(normalized);
			} catch (error) {
				throw invalid(
					`Step ${index}: ${error instanceof Error ? error.message : String(error)}`,
					error instanceof ZodError ? error.issues : [],
				);
			}
		}
	} catch (error) {
		return fail(error);
	}
	const projectId = projectIds.size === 1 ? [...projectIds][0] : undefined;

	const { runAgentCommand } = await import("./agentMain");
	const readDocumentHash = async (): Promise<string | null> => {
		if (!options.brokerSocketPath || !projectId) return null;
		const captured: string[] = [];
		const code = await runAgentCommand(
			{
				kind: "agent",
				args: ["state", "--project_id", projectId, "--at", "0", "--json"],
				cwd: command.cwd,
				json: true,
			},
			(text) => captured.push(text),
			{ ...options },
		);
		if (code !== 0) return null;
		try {
			const reply = JSON.parse(captured.at(-1) ?? "") as {
				data?: { documentHash?: unknown };
			};
			return typeof reply.data?.documentHash === "string" ? reply.data.documentHash : null;
		} catch {
			return null;
		}
	};

	const hashBefore = await readDocumentHash();

	interface StepRecord {
		index: number;
		label?: string;
		command: string;
		request_id: string | null;
		status: string;
		exit_code: number;
		introduced: { error: number; warning: number; info: number };
		findings?: unknown[];
		touched?: number[];
		frames?: string[];
	}
	const records: StepRecord[] = [];
	const touched: { step: number; at: number }[] = [];
	let firstFailure: { index: number; reply: Record<string, unknown> } | null = null;
	let stopped = false;

	for (const [index, step] of steps.entries()) {
		const stdout: string[] = [];
		const code = await runAgentCommand(
			{ kind: "agent", args: derivedArgs[index], cwd: command.cwd, json: true },
			(text) => stdout.push(text),
			{
				...options,
				err: (text) => {
					// Step progress/planned envelopes stay visible as NDJSON on stderr.
					options.err?.(text);
				},
			},
		);
		let reply: Record<string, unknown> | null = null;
		for (const line of stdout) {
			try {
				const parsedLine = JSON.parse(line) as Record<string, unknown>;
				if (typeof parsedLine.status === "string") reply = parsedLine;
			} catch {
				/* Non-JSON step output cannot be the terminal envelope. */
			}
		}
		if (!reply) {
			reply = {
				status: "failed",
				error: {
					code: "STEP_OUTPUT_INVALID",
					message: `Step ${index} produced no terminal JSON envelope on stdout.`,
				},
			};
		}
		const findings = introducedFindingsOf(reply);
		const data = reply.data;
		const receipt = data && typeof data === "object" && "receipt" in data ? data.receipt : null;
		const receiptRequestId =
			receipt && typeof receipt === "object" && "requestId" in receipt
				? receipt.requestId
				: undefined;
		// Porcelain write replies carry the guarded apply's request id at the top
		// level (operation_request_id); the envelope id is the step's own.
		const operationRequestId =
			reply.operation_request_id ??
			(reply.data as Record<string, unknown> | undefined)?.operation_request_id ??
			receiptRequestId;
		const record: StepRecord = {
			index,
			...(step.label ? { label: step.label } : {}),
			command: derivedArgs[index][0],
			request_id:
				typeof operationRequestId === "string"
					? operationRequestId
					: typeof reply.request_id === "string"
						? reply.request_id
						: null,
			status: String(reply.status ?? "failed"),
			exit_code: code,
			introduced: findingCounts(findings),
			...(flags.verbosity === "full" && findings.length ? { findings } : {}),
		};
		if (reply.status === "completed") {
			const instants = touchedInstantsOf(reply);
			if (instants.length) record.touched = instants;
			for (const at of instants) touched.push({ step: index, at });
		} else if (!firstFailure) {
			firstFailure = { index, reply };
		}
		records.push(record);
		if (reply.status !== "completed") {
			stopped = true;
			break;
		}
		if (
			flags.stop_on === "warning" &&
			(record.introduced.error > 0 || record.introduced.warning > 0)
		) {
			stopped = true;
			break;
		}
	}

	// Frames for every touched instant, rendered from the final saved document
	// into one review folder. Rendering is evidence, not a gate: an unavailable
	// renderer never fails committed edits.
	let frames: Record<string, unknown> = { status: "no_touched_instants" };
	const uniqueTouched = touched.filter(
		(entry, position) =>
			touched.findIndex((other) => Math.abs(other.at - entry.at) < 0.001) === position,
	);
	if (uniqueTouched.length) {
		if (!options.projectsDirectory || !projectId || !options.previewLaunch) {
			frames = {
				status: "unavailable",
				reason:
					"Frame rendering needs the app projects directory, a single batch project, and a trusted preview launch.",
			};
		} else {
			const truncated = uniqueTouched.length > MAX_FRAME_INSTANTS;
			const instants = uniqueTouched.slice(0, MAX_FRAME_INSTANTS);
			const directory = path.resolve(command.cwd, `klippt-batch-${batchId}-frames`);
			try {
				const { resolveFfmpeg } = await import("../media/audioPeaks");
				const ffmpeg = resolveFfmpeg();
				if (!ffmpeg) throw new Error("FFMPEG_UNAVAILABLE");
				const { renderAgentFrames } = await import("./agentFrames");
				const rendered = await renderAgentFrames({
					projectPath: path.join(options.projectsDirectory, `${projectId}.klippt`),
					at: instants.map((entry) => entry.at),
					out: directory,
					cacheDirectory: path.join(
						path.dirname(options.projectsDirectory),
						"cache",
						"agent-media",
					),
					launch: options.previewLaunch,
					ffmpeg,
					sheet: true,
				});
				const frameList = rendered.frames.map((frame, frameIndex) => ({
					step: instants[frameIndex]?.step ?? null,
					at: frame.at,
					path: frame.path,
				}));
				for (const frame of frameList) {
					const record = records.find((entry) => entry.index === frame.step);
					if (record) record.frames = [...(record.frames ?? []), frame.path];
				}
				frames = {
					status: "rendered",
					state: "final_document",
					directory,
					contact_sheet: rendered.contactSheet ?? null,
					...(truncated
						? {
								truncated: true,
								note: `Only the first ${MAX_FRAME_INSTANTS} instants were rendered.`,
							}
						: {}),
					frames: frameList,
				};
			} catch (error) {
				frames = {
					status: "unavailable",
					reason: error instanceof Error ? error.message : String(error),
				};
			}
		}
	}

	const hashAfter = await readDocumentHash();
	const completed = records.filter((record) => record.status === "completed").length;
	const data: Record<string, unknown> = {
		batch_id: batchId,
		input: path.resolve(command.cwd, flags.input),
		stop_on: flags.stop_on,
		verbosity: flags.verbosity,
		project_id: projectId ?? null,
		...(projectIds.size > 1
			? {
					note: "Steps name multiple projects; batch hashes and group undo cover per-step projects only.",
				}
			: {}),
		hash_before: hashBefore,
		hash_after: hashAfter,
		steps_total: steps.length,
		steps_executed: records.length,
		steps_completed: completed,
		stopped_early: stopped,
		group: projectId
			? {
					id: batchId,
					request_id_prefix: `${batchId}:`,
					undo_command: `klippt agent undo --project_id ${projectId} --to ${batchId}`,
				}
			: null,
		frames,
		steps: records,
		first_failure: firstFailure
			? {
					index: firstFailure.index,
					reply: firstFailure.reply,
				}
			: null,
	};
	if (!firstFailure) {
		emit({ status: "completed", data });
		return 0;
	}
	emit({
		status: "failed",
		data,
		error: firstFailure.reply.error ?? {
			code: "COMMAND_FAILED",
			message: `Step ${firstFailure.index} did not complete.`,
		},
	});
	return exitCodeForReply(firstFailure.reply);
}
