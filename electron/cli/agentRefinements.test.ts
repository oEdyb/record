import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { commandPolicies } from "./agentCommandPolicy";
import { compactAgentReply } from "./agentCompact";
import { agentCommands, agentGuide, parseAgentCommand } from "./agentContracts";
import { agentDoctor } from "./agentDoctor";
import { runAgentCommand } from "./agentMain";
import { assessProof, attachVerification, type ProofEvidence } from "./agentProof";

const directories: string[] = [];
afterEach(() => {
	for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const directory = () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "klippt-proof-test-"));
	directories.push(dir);
	return dir;
};
const component = {
	contract: 1,
	session_id: "session",
	build_id: "different-build",
	capabilities: { editor: true, fresh_frames: true },
};

describe("command-scoped readiness", () => {
	it("does not probe an editor for a saved read", async () => {
		const request = vi.fn();
		expect(
			await agentDoctor({ command: "inspect", live: false }, undefined, request),
		).toMatchObject({ status: "available", checks: [] });
		expect(request).not.toHaveBeenCalled();
	});
	it("reports unreachable editor and unknown native components honestly", async () => {
		const request = vi.fn().mockRejectedValue(new Error("offline"));
		expect(await agentDoctor({ command: "shot", live: true }, "socket", request)).toMatchObject({
			status: "unavailable",
			checks: [
				{ capability: "editor", status: "unavailable" },
				{ capability: "fresh_frames", status: "unknown" },
			],
		});
		expect(await agentDoctor({ command: "preview", live: false }, "socket", request)).toMatchObject(
			{ status: "unknown" },
		);
		expect(request).toHaveBeenCalledTimes(1);
	});
	it("requires explicit renderer freshness and tolerates different build identities", async () => {
		const request = vi
			.fn()
			.mockResolvedValue({ status: "completed", data: { editor: component, renderer: component } });
		expect(await agentDoctor({ command: "shot", live: true }, "socket", request)).toMatchObject({
			status: "available",
		});
		request.mockResolvedValue({
			status: "completed",
			data: {
				editor: component,
				renderer: { ...component, capabilities: { fresh_frames: false } },
			},
		});
		expect(await agentDoctor({ command: "shot", live: true }, "socket", request)).toMatchObject({
			status: "unavailable",
		});
		request.mockResolvedValue({ status: "completed", data: { package_version: "1.9.5" } });
		expect(await agentDoctor({ command: "shot", live: true }, "socket", request)).toMatchObject({
			status: "unknown",
		});
	});
	it("is discoverable and executable without project mutation", async () => {
		expect(parseAgentCommand(["doctor", "--command", "shot", "--live"])).toMatchObject({
			input: { command: "shot", live: true },
		});
		const output: string[] = [];
		expect(
			await runAgentCommand(
				{ kind: "agent", args: ["doctor", "--command", "inspect"], json: true, cwd: directory() },
				(text) => output.push(text),
			),
		).toBe(0);
		expect(output).toHaveLength(1);
		expect(JSON.parse(output[0]).data.status).toBe("available");
	});
});

const evidence: ProofEvidence = {
	requirement: "live_seek",
	status: "passed",
	source: "live",
	revision: "revision",
	sha256: "hash",
	time_base: "edited_seconds",
	requested_time: 59.904,
	observed_time: 59.904,
	freshness: "settled",
	artifacts: ["frame.png"],
};
it("saved, stale, wrong-time and wrong-revision frames cannot satisfy live proof", () => {
	const identity = { revision: "revision", sha256: "hash" };
	expect(assessProof(["live_seek"], [evidence], identity).status).toBe("passed");
	for (const change of [
		{ source: "saved" as const },
		{ freshness: "possibly_stale" as const },
		{ observed_time: 55 },
		{ revision: "old" },
		{ artifacts: [] },
	])
		expect(assessProof(["live_seek"], [{ ...evidence, ...change }], identity).status).toBe(
			"pending",
		);
	expect(
		assessProof(
			["listening"],
			[{ ...evidence, requirement: "listening", source: "source_audio" }],
			identity,
		).status,
	).toBe("pending");
});
it("retains a committed recovery receipt when camera proof is missing", () => {
	const receipt = {
		requestId: "original",
		revision: "revision",
		contentHashes: { sha256_after: "hash" },
	};
	const reply = attachVerification(
		{
			status: "completed",
			data: { receipt, commit_status: "committed", image: { source: "saved", path: "frame.png" } },
		},
		commandPolicies.motion,
	);
	expect(reply).toMatchObject({
		commit_status: "committed",
		verification: { status: "pending" },
		data: { receipt },
	});
});
it.each([
	"completed",
	"failed",
	"stale",
	"unknown",
])("compact preserves recovery for %s", (status) => {
	const receipt = {
		requestId: "original",
		revision: "revision",
		contentHashes: { sha256_after: "hash" },
	};
	const reply = {
		request_id: "original",
		status,
		commit_status: status === "unknown" ? "unknown" : "committed",
		error:
			status === "completed"
				? null
				: { code: "EDITOR_TIMEOUT", hint: "Query receipt original before retry." },
		next_actions: [{ command: "receipt original" }],
		verification: { status: "pending" },
		data: {
			receipt,
			counts: { error: 2 },
			evidence: { source: "live", freshness: "possibly_stale", path: "frame.png" },
			words: Array(100).fill({ text: "long" }),
			frame: "data:image/png;base64,AAAA",
		},
	};
	const compact = compactAgentReply(reply, directory());
	expect(compact).toMatchObject({
		request_id: reply.request_id,
		status: reply.status,
		commit_status: reply.commit_status,
		error: reply.error,
		next_actions: reply.next_actions,
		verification: reply.verification,
		data: { receipt, counts: reply.data.counts, evidence: reply.data.evidence },
	});
	expect(JSON.stringify(compact)).not.toContain("data:image");
	expect(JSON.parse(fs.readFileSync(compact.full_reply_path, "utf8"))).toEqual(reply);
});
it("requires metadata for all discovery commands and preserves input defaults", () => {
	for (const [name, command] of Object.entries(agentCommands)) {
		expect(command.policy.effects.length).toBeGreaterThan(0);
		expect(agentGuide(name).commands[0]).toMatchObject(command.policy);
	}
	expect(agentGuide("doctor").commands[0].input_schema?.properties?.live).toMatchObject({
		default: false,
	});
});
it.each([
	[{ checks: { status: "error" } }, "failed"],
	[{ content_verification: { status: "unavailable" } }, "unavailable"],
	[{ content_verification: { status: "complete", counts: { error: 1 } } }, "failed"],
])("reports actual broker proof failures without losing receipt", (verify, status) => {
	expect(
		attachVerification(
			{ status: "completed", data: { receipt: { requestId: "original", revision: "r" }, verify } },
			commandPolicies.general,
		),
	).toMatchObject({
		commit_status: "committed",
		verification: { status },
		data: { receipt: { requestId: "original" } },
	});
});
it("falls back to the full reply if compact artifacts cannot be saved", async () => {
	const cwd = directory();
	fs.writeFileSync(path.join(cwd, "klippt-agent-artifacts"), "blocked");
	const output: string[] = [];
	expect(
		await runAgentCommand(
			{ kind: "agent", args: ["doctor", "--command", "inspect", "--compact"], cwd, json: true },
			(text) => output.push(text),
		),
	).toBe(0);
	expect(output).toHaveLength(1);
	expect(JSON.parse(output[0])).toMatchObject({
		status: "completed",
		output_mode: "full_fallback",
		data: { status: "available" },
	});
});
it("cannot call a broker-only session an available editor", async () => {
	const request = vi.fn().mockResolvedValue({ status: "completed", data: { editor: component } });
	expect(await agentDoctor({ command: "state", live: false }, "socket", request)).toMatchObject({
		status: "unknown",
	});
});
