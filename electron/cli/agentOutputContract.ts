// The phase-2 output contract for `klippt agent`: one terminal envelope on
// stdout, progress/planned envelopes as NDJSON on stderr (stdout only with
// --stream), a stable exit-code taxonomy, and a fixed error-object shape.
// Pure module: no Electron imports, so parser and broker tests can load it.

import { ZodError } from "zod";

export const AGENT_EXIT_CODES = {
	"0": "completed — the terminal envelope carries status: completed. Observe commands (check, verify, shot) exit 0 with findings present: read data.findings/data.counts, not the exit code. A verify data.status of 'unavailable' means NOT verified, never a pass.",
	"2": "invalid input — fix the flagged field_errors; guide --command <name> --json shows the installed schema",
	"3": "blocked by checks or confirmation required — the reply carries the exact confirm_command to proceed",
	"4": "editor or owner unavailable — start Klippt with OPENSCREEN_AGENT_CLI=1 and open the project, then retry",
	"5": "revision or history conflict — re-read state/history and rebuild the plan against the current revision",
	"6": "timeout — commit state is unknown; query receipt with the original request_id before any new write",
	"7": "failed — the terminal envelope's error object carries code, message and hint",
} as const;

/** Machine-readable contract advertised in `guide` and `contracts` replies. */
export const AGENT_OUTPUT_CONTRACT = {
	compact:
		"--compact retains recovery metadata and writes the complete reply to full_reply_path; full output remains the default.",
	verification:
		"Commit status is separate from pending/passed/failed/unavailable proof. A saved image cannot satisfy live proof. Never repeat a committed mutation to obtain evidence.",
	receipt_hash_scopes: {
		sha256_before: "saved_file_bytes_including_transaction_metadata",
		sha256_after: "JSON.stringify(document_without_klipptTransactions)",
		imported_media: "media_file_bytes",
	},
	stdout: "Exactly one terminal JSON envelope per invocation.",
	stderr: "Progress and planned envelopes as NDJSON on stderr, plus diagnostics.",
	stream:
		"--stream moves progress/planned envelopes onto stdout (NDJSON) for single-stream callers.",
	exit_codes: AGENT_EXIT_CODES,
	error_fields: ["code", "message", "hint", "retryable", "field_errors"],
	confirmation:
		"A reply blocked by checks exits 3 and carries confirm_command: the exact command that proceeds.",
	findings:
		"check and verify report findings in data and still exit 0. verify data.status 'unavailable' means deep content verification could NOT run for the range (error-level content.unavailable findings say why): the range is not verified and the reply must not read as a pass.",
	versioning:
		"api_version 1.x is additive-only: new commands and flags only. Removing or repurposing a flag requires a new major api_version.",
} as const;

const CODE_PREFIX = /^([A-Z][A-Z0-9_]{2,})(?=: )/;
const CODE_ONLY = /^[A-Z][A-Z0-9_]{2,}$/;

/** Stable machine code for any thrown error: explicit code, MESSAGE prefix, or timeout class. */
export function agentErrorCode(error: unknown): string {
	if (error instanceof ZodError) return "INVALID_INPUT";
	if (error && typeof error === "object" && "code" in error) {
		const code = (error as { code?: unknown }).code;
		if (typeof code === "string" && CODE_ONLY.test(code)) return code;
	}
	const message = error instanceof Error ? error.message : String(error);
	const prefixed = CODE_PREFIX.exec(message)?.[1];
	if (prefixed) return prefixed;
	if (CODE_ONLY.test(message)) return message;
	if (message.startsWith("Broker timeout") || message.startsWith("Broker connection closed"))
		return "EDITOR_TIMEOUT";
	return "COMMAND_FAILED";
}

/**
 * Recovery guidance when a write's commit state is unknown. The write may
 * have committed, so the receipt journal decides before any retry, and a
 * retry reuses the same request id for idempotency.
 */
export function unknownCommitRecoveryHint(operationRequestId?: string): string {
	const id = operationRequestId ?? "<operation_request_id>";
	return (
		`Commit state is unknown — the write may have committed. Query klippt agent receipt ` +
		`--project_id <id> --request_id ${id} (or klippt agent history --project_id <id>) to ` +
		`establish whether it committed BEFORE any retry. A retry must reuse --request_id ${id} ` +
		`for idempotency; a fresh request id can duplicate a committed write.`
	);
}

/**
 * Envelope hint when `verify` completes with summary status "unavailable":
 * exit stays 0 (consistent with check — findings ride in data), but the
 * reply must say unmistakably that unavailable means NOT verified.
 */
export function verifyUnavailableHint(): string {
	return (
		"data.status is 'unavailable': this range was NOT content-verified (nothing decoded). " +
		"Read the error-level content.unavailable findings for the cause, fix it (for example install ffmpeg or pick a range with decodable media), and re-run verify. " +
		"Do not treat this reply as a pass; exit code 0 only means the command ran."
	);
}

/** One sentence: what to run next. */
export function hintForError(code: string): string {
	// Unknown commit states never advise a blind retry, whatever the exit class.
	if (code === "APPLY_OUTCOME_UNKNOWN" || code === "BROKER_OUTCOME_UNKNOWN")
		return unknownCommitRecoveryHint();
	switch (exitCodeForError(code)) {
		case 2:
			return code === "NOT_FOUND"
				? "Verify the project path or ID with klippt agent inspect --project <file> --json, then retry."
				: "Run klippt agent guide --command <name> --json for the installed schema, fix the flagged field_errors, and retry.";
		case 3:
			return "Fix the reported findings and re-plan, or run the reply's confirm_command to proceed past the block.";
		case 4:
			return "Start Klippt with OPENSCREEN_AGENT_CLI=1, open the project in the editor, and retry the same command.";
		case 5:
			return "Re-read state and history, rebuild the plan against the current revision, and retry with a fresh request_id.";
		case 6:
			return "Run klippt agent receipt --project_id <id> --request_id <original-id> before any retry; the write may have committed.";
		default:
			return "Read error.message, correct the cause, and retry the same command.";
	}
}

const INVALID_INPUT_CODES = new Set([
	"INVALID_INPUT",
	"INVALID_ARGUMENT",
	"INVALID_PROJECT_ID",
	"PROJECT_ID_REQUIRED",
	"PROJECT_MISMATCH",
	"CLIP_REQUIRED",
	"NOT_FOUND",
	"INVALID_PLAN",
	"PLAN_TOO_LARGE",
	"UNKNOWN_COMMAND",
]);
const BLOCKED_CODES = new Set(["CHECK_ERRORS", "CONFIRMATION_REQUIRED"]);
const CONFLICT_CODES = new Set(["CONFLICT", "STALE_DOCUMENT", "SNAPSHOT_CHANGED", "KEY_REUSED"]);

/** Process exit code for a terminal error code. */
export function exitCodeForError(code: string | undefined): number {
	if (!code) return 7;
	if (INVALID_INPUT_CODES.has(code)) return 2;
	if (BLOCKED_CODES.has(code)) return 3;
	if (code === "BROKER_CLOSED" || code.endsWith("_UNAVAILABLE")) return 4;
	if (CONFLICT_CODES.has(code)) return 5;
	if (code.endsWith("_TIMEOUT")) return 6;
	return 7;
}

/** Process exit code for a whole reply envelope (0 when completed). */
export function exitCodeForReply(reply: unknown): number {
	const record = reply && typeof reply === "object" ? (reply as Record<string, unknown>) : {};
	if (record.status === "completed") return 0;
	const error = record.error;
	const code =
		error && typeof error === "object" ? (error as Record<string, unknown>).code : undefined;
	return exitCodeForError(typeof code === "string" && code ? code : undefined);
}

/**
 * Every error object in a terminal envelope carries the same five fields.
 * Existing extra fields (findings, counts) are preserved.
 */
export function normalizeAgentError(error: unknown): Record<string, unknown> {
	const record = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
	const message =
		typeof record.message === "string" && record.message
			? record.message
			: String(error ?? "Unknown error");
	const code =
		typeof record.code === "string" && record.code ? record.code : agentErrorCode(message);
	return {
		...record,
		code,
		message,
		hint: typeof record.hint === "string" && record.hint ? record.hint : hintForError(code),
		retryable: record.retryable === true,
		field_errors: Array.isArray(record.field_errors) ? record.field_errors : [],
	};
}
