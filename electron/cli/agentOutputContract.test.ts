// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
	AGENT_OUTPUT_CONTRACT,
	exitCodeForError,
	exitCodeForReply,
	hintForError,
	normalizeAgentError,
	unknownCommitRecoveryHint,
	verifyUnavailableHint,
} from "./agentOutputContract";

describe("unknown-commit recovery guidance", () => {
	it("never advises a blind retry when the commit state is unknown", () => {
		// Review finding 1: retrying a write whose commit state is unknown can
		// duplicate a committed write; the receipt journal comes first.
		for (const code of ["APPLY_OUTCOME_UNKNOWN", "BROKER_OUTCOME_UNKNOWN", "EDITOR_TIMEOUT"]) {
			const hint = hintForError(code);
			expect(hint, code).toContain("receipt");
			expect(hint, code).not.toContain("retry the same command");
		}
	});

	it("names the operation request id and requires reusing it for idempotency", () => {
		const hint = unknownCommitRecoveryHint("op-9");
		expect(hint).toContain("receipt --project_id");
		expect(hint).toContain("--request_id op-9");
		expect(hint).toContain("history");
		expect(hint).toMatch(/BEFORE any retry/);
		expect(hint).toMatch(/reuse/);
	});

	it("normalizes an APPLY_OUTCOME_UNKNOWN error into receipt-first guidance", () => {
		const normalized = normalizeAgentError({
			code: "APPLY_OUTCOME_UNKNOWN",
			message: "Broker timeout",
		});
		expect(normalized.hint).toEqual(expect.stringContaining("receipt"));
		expect(normalized.hint).not.toContain("retry the same command");
		// An explicit hint from the throw site wins over the fallback.
		const explicit = normalizeAgentError({
			code: "APPLY_OUTCOME_UNKNOWN",
			message: "Broker timeout",
			hint: unknownCommitRecoveryHint("op-1"),
		});
		expect(explicit.hint).toContain("op-1");
	});
});

describe("editor-unavailable class", () => {
	it("maps broker connection failures to exit 4, project not-found to exit 2", () => {
		expect(exitCodeForError("EDITOR_UNAVAILABLE")).toBe(4);
		expect(hintForError("EDITOR_UNAVAILABLE")).toContain("Start Klippt");
		expect(exitCodeForError("NOT_FOUND")).toBe(2);
		expect(hintForError("NOT_FOUND")).toContain("inspect --project");
	});
});

describe("verify unavailable semantics", () => {
	it("a completed verify reply with an unavailable summary exits 0 — findings ride in data, same as check", () => {
		// R3: deep content verification that could not run returns
		// summary.status "unavailable" with error-level content.unavailable
		// findings. Consistent with check, that is still a completed command:
		// the exit code stays 0 and the findings carry the failure.
		const reply = {
			status: "completed",
			data: {
				status: "unavailable",
				findings: [
					{ rule: "content.unavailable", severity: "error", at: 1, message: "not verified" },
				],
				counts: { error: 1, warning: 0 },
			},
		};
		expect(exitCodeForReply(reply)).toBe(0);
	});

	it("the advertised contract makes clear that unavailable means NOT verified", () => {
		expect(AGENT_OUTPUT_CONTRACT.exit_codes["0"]).toMatch(/unavailable.*NOT verified/);
		expect(AGENT_OUTPUT_CONTRACT.findings).toMatch(/could NOT run/);
		expect(AGENT_OUTPUT_CONTRACT.findings).toMatch(/must not read as a pass/);
	});

	it("the envelope hint says unavailable is not a pass and exit 0 only means the command ran", () => {
		const hint = verifyUnavailableHint();
		expect(hint).toContain("NOT content-verified");
		expect(hint).toContain("content.unavailable");
		expect(hint).toContain("Do not treat this reply as a pass");
		expect(hint).toContain("exit code 0");
	});
});
