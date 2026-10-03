// Phase-4 write flow for the Klippt agent CLI: a porcelain command whose plan
// removes footage (edges, pauses, cutpoint) STAGES the proposal into the
// review lane by default instead of writing the document. `--accept "<reason>"`
// applies directly through guarded plan/apply and records the reason on the
// trim operations. Pure module: no Electron imports, so tests load it without
// the app.

/** One footage-removing operation, as produced by the edges/pauses/cutpoint reports. */
export interface ProposalOperation {
	type: string;
	args: Record<string, unknown>;
}

export interface ProposalFlowReply {
	status: string;
	data?: Record<string, unknown>;
	error?: unknown;
	[extra: string]: unknown;
}

/** Broker call seam: command name, input, and an optional fixed request id. */
export type ProposalFlowRequest = (
	command: string,
	input: Record<string, unknown>,
	requestId?: string,
) => Promise<ProposalFlowReply>;

export const ACCEPT_REASON_MAX = 256;

/**
 * `--accept` carries the reason directly as its value, the same slot `--force`
 * occupies on apply/undo/redo but with a mandatory justification string.
 * Undefined means stage; a blank reason is invalid input, never a silent apply.
 */
export function resolveProposalMode(
	accept: string | undefined,
): { mode: "stage" } | { mode: "apply"; reason: string } {
	if (accept === undefined) return { mode: "stage" };
	const reason = accept.trim();
	if (!reason)
		throw new Error(
			'INVALID_INPUT: --accept requires a reason string, for example --accept "reviewed in staged; cuts match silence".',
		);
	return { mode: "apply", reason };
}

/**
 * Stamp the accept reason onto addTrim operations so the justification persists
 * in the document's trim ranges. setTrim has no reason field; the reply still
 * carries accept_reason for those.
 */
export function stampAcceptReason(
	operations: ProposalOperation[],
	reason: string,
): ProposalOperation[] {
	return operations.map((operation) => {
		if (operation.type !== "addTrim") return operation;
		const existing = typeof operation.args.reason === "string" ? operation.args.reason : "";
		const combined = existing ? `${existing} · accepted: ${reason}` : `accepted: ${reason}`;
		return {
			...operation,
			args: { ...operation.args, reason: combined.slice(0, ACCEPT_REASON_MAX) },
		};
	});
}

const stagedTimeBases = {
	"operations[].args.startSec/endSec": "source_seconds",
} as const;

function reviewNextActions(projectId: string) {
	return [
		{ command: `klippt agent staged --project_id ${projectId}` },
		{
			command: `klippt agent accept --project_id ${projectId} --ids <id,...> (accepts selected cuts; one undo step)`,
		},
		{ command: `klippt agent reject --project_id ${projectId} --ids <id,...>` },
	];
}

/**
 * Propose or apply a footage-removing operation set. Stage mode relays the
 * operations through `plan --stage` into the editor's proposal lane; the
 * document is not written. Apply mode stamps the reason and runs guarded
 * plan/apply with the caller's request id for receipt recovery. Broker
 * failures pass through unchanged so the caller's exit-code mapping stays exact.
 */
export async function runProposalFlow(
	request: ProposalFlowRequest,
	options: {
		projectId: string;
		operations: ProposalOperation[];
		accept?: string;
		requestId: string;
	},
): Promise<ProposalFlowReply> {
	const mode = resolveProposalMode(options.accept);
	if (mode.mode === "stage") {
		const staged = await request("plan", {
			projectId: options.projectId,
			operations: options.operations,
			stage: true,
		});
		if (staged.status !== "completed" || !staged.data) return staged;
		const proposalIds = Array.isArray(staged.data.staged) ? staged.data.staged : [];
		return {
			status: "completed",
			data: {
				staged: true,
				applied: false,
				changed: false,
				proposal_count: options.operations.length,
				proposal_ids: proposalIds,
				lane_count: staged.data.lane_count ?? null,
				rejected_earlier: staged.data.rejected_earlier ?? 0,
				review:
					"Nothing was cut yet: the proposal lane holds these cuts. Review with staged, then accept or reject.",
				time_bases: stagedTimeBases,
				next_actions: reviewNextActions(options.projectId),
			},
		};
	}
	const operations = stampAcceptReason(options.operations, mode.reason);
	const plan = await request("plan", { projectId: options.projectId, operations });
	if (plan.status !== "completed" || !plan.data) return plan;
	const applied = await request(
		"apply",
		{ projectId: options.projectId, planId: plan.data.planId },
		options.requestId,
	);
	if (applied.status !== "completed") return applied;
	return {
		status: "completed",
		data: {
			staged: false,
			applied: true,
			changed: true,
			accept_reason: mode.reason,
			time_bases: stagedTimeBases,
			...applied.data,
		},
	};
}
