// @vitest-environment node
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { IpcMain } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
	AGENT_SESSION_REPLY,
	type AgentSessionMessage,
} from "../../src/lib/ai-edition/agent/sessionProtocol";
import { runChecks } from "../../src/lib/ai-edition/checks";
import { buildResolvedEdit } from "../../src/lib/ai-edition/checks/context";
import { editFixture } from "../../src/lib/ai-edition/checks/fixtures";
import { documentSchema } from "../../src/lib/ai-edition/schema";
import { DocumentService } from "../ai-edition/document-service";
import type { AgentBrokerRequest } from "./agentBroker";
import { parseAgentCommand } from "./agentContracts";
import { resolveProposalMode, runProposalFlow, stampAcceptReason } from "./agentWriteFlow";

const mock = vi.hoisted(() => ({ windows: vi.fn(), start: vi.fn() }));
vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: mock.windows } }));
vi.mock("./agentBroker", () => ({ startAgentBroker: mock.start }));

import { startEditorAgentBroker } from "./editorAgentBroker";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
	vi.restoreAllMocks();
});
async function setup() {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-flow-"));
	cleanup.push(() => fs.rm(directory, { recursive: true, force: true }));
	const documents = new DocumentService(directory, directory);
	const fixture = editFixture({ duration: 100, trims: [[40, 42]] });
	fixture.assets[0].originalPath = path.join(directory, "source.mp4");
	if (fixture.assets[0].cameraTrack)
		fixture.assets[0].cameraTrack.sourcePath = path.join(directory, "camera.mp4");
	await fs.writeFile(fixture.assets[0].originalPath, "fixture");
	await fs.writeFile(path.join(directory, "camera.mp4"), "fixture");
	await documents.saveProject(fixture);
	const ipc = new EventEmitter();
	const mainFrame = {};
	const sender = { id: 7, mainFrame };
	const calls: AgentSessionMessage[] = [];
	const send = (_channel: string, message: AgentSessionMessage) => {
		calls.push(message);
		void (async () => {
			const snapshot = await documents.getTransactionSnapshot("project");
			if (message.action === "activate") return snapshot.version;
			if (message.action === "check")
				return {
					status: "ready",
					revision: snapshot.version.revision,
					result: runChecks(buildResolvedEdit(snapshot.document), message.editCheck),
					audio: { ready: 1, pending: 0 },
					timings: { elapsedMs: 1, peaksMs: 0, speechMs: 0 },
					error: null,
				};
			if (message.action === "apply" && message.guard)
				return documents.commitTransaction(
					"project",
					{
						...message.guard,
						recordUndo: true,
						payload: { projectId: "project", document: message.document },
					},
					() => documentSchema.parse(message.document),
				);
			throw new Error("Unexpected relay action");
		})().then(
			(data) =>
				ipc.emit(
					AGENT_SESSION_REPLY,
					{ sender, senderFrame: mainFrame },
					{ id: message.id, status: "completed", data },
				),
			(error) =>
				ipc.emit(
					AGENT_SESSION_REPLY,
					{ sender, senderFrame: mainFrame },
					{ id: message.id, status: "failed", error: { message: String(error) } },
				),
		);
	};
	mock.windows.mockReturnValue([
		{
			isDestroyed: () => false,
			webContents: { ...sender, getURL: () => "klippt://app/index.html?windowType=editor", send },
		},
	]);
	let handler: (request: AgentBrokerRequest) => Promise<unknown> = async () => undefined;
	mock.start.mockImplementation(async (_dir, callback) => {
		handler = callback;
		return { close: async () => undefined };
	});
	const broker = await startEditorAgentBroker({
		directory,
		documents,
		ipcMain: ipc as unknown as IpcMain,
		approveSelectedMedia: async (file) => file,
		probeVideoDuration: async () => 10,
		probeVideoMetadata: async () => ({
			durationSec: 10,
			video: { codec: "h264", width: 1080, height: 1920, fps: 30 },
		}),
	});
	cleanup.push(broker.close);
	let sequence = 0;
	const request = async (
		command: string,
		input: Record<string, unknown>,
		requestId = `request-${++sequence}`,
	) =>
		z
			.looseObject({
				status: z.string(),
				data: z.record(z.string(), z.unknown()).optional(),
				error: z.unknown().optional(),
			})
			.parse(await handler({ api_version: "1.0", request_id: requestId, command, input }));
	return { request, documents, calls, directory };
}
describe("agent write flow with real documents and simulated renderer IPC", () => {
	it("refuses request IDs reused between apply, undo and redo, but replays the same undo", async () => {
		const s = await setup();
		const plan = await s.request("plan", {
			projectId: "project",
			operations: [{ type: "setTrim", args: { trimRangeId: "trim_0", startSec: 41, endSec: 44 } }],
		});
		await s.request("apply", { projectId: "project", planId: plan.data?.planId }, "apply-id");
		expect(await s.request("undo", { projectId: "project" }, "apply-id")).toMatchObject({
			status: "failed",
			error: { code: "KEY_REUSED" },
		});
		await s.request("undo", { projectId: "project" }, "undo-id");
		expect(await s.request("undo", { projectId: "project" }, "undo-id")).toMatchObject({
			status: "completed",
			data: { replayed: true },
		});
		expect(await s.request("redo", { projectId: "project" }, "undo-id")).toMatchObject({
			status: "failed",
			error: { code: "KEY_REUSED" },
		});
	});
	it("blocks missing candidate assets at plan and after a later file deletion", async () => {
		const s = await setup();
		const input = {
			projectId: "project",
			operations: [{ type: "setTrim", args: { trimRangeId: "trim_0", startSec: 41, endSec: 44 } }],
		};
		const plan = await s.request("plan", input);
		await fs.unlink(path.join(s.directory, "source.mp4"));
		expect(
			await s.request("apply", { projectId: "project", planId: plan.data?.planId }),
		).toMatchObject({
			status: "failed",
			error: {
				code: "CHECK_ERRORS",
				findings: expect.arrayContaining([expect.objectContaining({ rule: "asset.missing" })]),
			},
		});
		expect(await s.request("plan", input)).toMatchObject({
			data: { checks: { counts: { error: 2 } } },
		});
	});
	it("retains a committed receipt if verification cannot read the saved document", async () => {
		const s = await setup();
		const plan = await s.request("plan", {
			projectId: "project",
			operations: [{ type: "setTrim", args: { trimRangeId: "trim_0", startSec: 41, endSec: 44 } }],
		});
		const commit = s.documents.commitTransaction.bind(s.documents);
		vi.spyOn(s.documents, "commitTransaction").mockImplementation(async (...args) => {
			const receipt = await commit(...args);
			vi.spyOn(s.documents, "getTransactionSnapshot").mockRejectedValue(
				new Error("read unavailable"),
			);
			return receipt;
		});
		expect(
			await s.request("apply", { projectId: "project", planId: plan.data?.planId }),
		).toMatchObject({
			status: "completed",
			data: {
				commit_status: "committed",
				receipt: { changed: true },
				verify: { state: null, checks: { status: "error" } },
			},
		});
	});
	it("returns trim verify, persists history and updates the apply route during undo/redo", async () => {
		const s = await setup();
		const planned = await s.request("plan", {
			projectId: "project",
			operations: [{ type: "setTrim", args: { trimRangeId: "trim_0", startSec: 41, endSec: 44 } }],
		});
		expect(planned).toMatchObject({
			status: "completed",
			data: { span: { startSec: 37, endSec: 44 }, checks: { counts: { error: 0 } } },
		});
		const applied = await s.request("apply", {
			projectId: "project",
			planId: planned.data?.planId,
		});
		expect(applied).toMatchObject({
			status: "completed",
			data: { verify: { state: { durationSec: 97 }, checks: { status: "ready" } } },
		});
		expect(await s.request("history", { projectId: "project" })).toMatchObject({
			data: { entries: [{ planSummary: "1 operations: setTrim" }] },
		});
		expect(await s.request("undo", { projectId: "project" })).toMatchObject({
			status: "completed",
			data: { verify: { state: { durationSec: 98 } } },
		});
		expect(
			(await s.documents.getTransactionSnapshot("project")).document.timeline.trimRanges[0],
		).toMatchObject({ startSec: 40, endSec: 42 });
		expect(await s.request("redo", { projectId: "project" })).toMatchObject({
			status: "completed",
			data: { verify: { state: { durationSec: 97 } } },
		});
		expect(s.calls.filter((call) => call.action === "apply")).toHaveLength(3);
	});
	it("stores generic plan findings, lists fixes on refusal, allows force and returns text verify", async () => {
		const s = await setup();
		const plan = await s.request("plan", {
			projectId: "project",
			operations: [
				{
					type: "addAnnotation",
					args: {
						startSec: 2,
						endSec: 5,
						text: "Label",
						anchor: { kind: "edited", fromSec: 2, toSec: 5 },
						position: { x: 0, y: 0 },
						size: { width: 100, height: 100 },
					},
				},
			],
		});
		const input = { projectId: "project", planId: plan.data?.planId };
		expect(await s.request("apply", input)).toMatchObject({
			status: "failed",
			error: { code: "CHECK_ERRORS", findings: [{ rule: "text.over-camera", fix: null }] },
		});
		expect(s.calls.filter((call) => call.action === "apply")).toHaveLength(0);
		const forced = await s.request("apply", { ...input, force: true });
		expect(forced, JSON.stringify(forced)).toMatchObject({
			status: "completed",
			data: { verify: { checks: { new: [{ rule: "text.over-camera" }] } } },
		});
	});
	it("imports clip replacement through a single planned operation", async () => {
		const s = await setup();
		const file = path.join(s.directory, "new.mp4");
		await fs.writeFile(file, "fixture");
		const plan = await s.request("plan", {
			projectId: "project",
			replacement: { action: "replace", project_id: "project", clip: "clip", file },
		});
		expect(plan.status).toBe("completed");
		expect(plan.data?.summary).toMatchObject({
			results: [{ type: "replaceClipSource", result: { droppedTrims: [{ id: "trim_0" }] } }],
		});
		expect(
			await s.request("apply", { projectId: "project", planId: plan.data?.planId }),
		).toMatchObject({ status: "completed", data: { verify: { state: { durationSec: 10 } } } });
		await s.request("undo", { projectId: "project" });
		expect(
			(await s.documents.getTransactionSnapshot("project")).document.timeline.clips[0].assetId,
		).toBe("asset");
	});
	it("exposes strict CLI contracts for history, restore and clip replacement", () => {
		expect(
			parseAgentCommand(["undo", "--project_id", "p", "--steps", "2", "--force"]),
		).toMatchObject({ input: { steps: 2, force: true } });
		expect(
			parseAgentCommand([
				"clip",
				"replace",
				"--project_id",
				"p",
				"--clip",
				"clip-id",
				"--file",
				"/new.mp4",
			]),
		).toMatchObject({ input: { clip: "clip-id" } });
		expect(parseAgentCommand(["history", "--project_id", "p"]).command).toBe("history");
		for (const args of [
			["redo", "--steps", "0"],
			["undo", "--steps", "2", "--to", "a"],
			["redo", "--to", "a"],
		])
			expect(() => parseAgentCommand([...args, "--project_id", "p"])).toThrow();
	});
});

it("plans and applies B-roll swaps with real import, asset reuse and receipts", async () => {
	const s = await setup();
	const snapshot = await s.documents.getTransactionSnapshot("project");
	await s.documents.saveProject({
		...snapshot.document,
		videoOverlays: [
			{
				id: "overlay",
				assetId: "asset",
				startMs: 2000,
				endMs: 22000,
				sourceStartSec: 2,
				sourceEndSec: 22,
				clipId: "clip",
				sourceOffsetSec: 0,
				fit: "cover",
				placement: null,
				opacity: 0.6,
				motion: "fade",
			},
		],
	});
	const file = path.join(s.directory, "new.mp4");
	await fs.writeFile(file, "fixture");
	const swap = { action: "swap", project_id: "project", overlay: "overlay", file };
	const prepare = vi.spyOn(s.documents, "prepareAsset");
	const plan = await s.request("plan", { projectId: "project", swap });
	expect(plan).toMatchObject({
		status: "completed",
		data: {
			swap: {
				overlayId: "overlay",
				previousAssetId: "asset",
				fit: { chosen: "contain" },
				time: { spanSec: 20, availableSec: 10, shortenedBySec: 10 },
			},
		},
	});
	expect(prepare).toHaveBeenCalledOnce();
	expect(
		(await s.documents.getTransactionSnapshot("project")).document.videoOverlays?.[0].assetId,
	).toBe("asset");
	const applied = await s.request(
		"apply",
		{ projectId: "project", planId: plan.data?.planId },
		"swap-receipt",
	);
	expect(applied).toMatchObject({
		status: "completed",
		data: { receipt: expect.any(Object), verify: expect.any(Object) },
	});
	const saved = (await s.documents.getTransactionSnapshot("project")).document;
	expect(saved.assets).toHaveLength(2);
	expect(saved.videoOverlays?.[0]).toMatchObject({
		id: "overlay",
		clipId: "clip",
		startMs: 2000,
		endMs: 12000,
		sourceEndSec: 12,
		motion: "fade",
		opacity: 0.6,
	});
	const reused = await s.request("plan", {
		projectId: "project",
		swap: { ...swap, file: path.join(s.directory, ".", "new.mp4"), time: "hold" },
	});
	expect(reused).toMatchObject({
		status: "completed",
		data: { swap: { assetId: saved.assets[1].id, previousAssetId: saved.assets[1].id } },
	});
	expect(prepare).toHaveBeenCalledOnce();
	expect(
		await s.request("plan", { projectId: "project", swap: { ...swap, offset: 9.5 } }),
	).toMatchObject({ status: "failed", error: { code: "MEDIA_TOO_SHORT" } });
	expect(
		await s.request("plan", { projectId: "project", swap: { ...swap, overlay: "missing" } }),
	).toMatchObject({ status: "failed", error: { code: "UNKNOWN_VIDEO_OVERLAY" } });
});

describe("phase 4 proposal flow (pure orchestration over a request seam)", () => {
	const operations = [
		{ type: "addTrim", args: { clipId: "clip", startSec: 1, endSec: 2, reason: "gap" } },
		{ type: "setTrim", args: { trimRangeId: "trim_0", startSec: 41, endSec: 44 } },
	];
	const reply = (
		command: string,
		input: Record<string, unknown>,
	): { status: string; data: Record<string, unknown> } =>
		command === "plan" && input.stage
			? {
					status: "completed",
					data: { staged: ["cut-1", "cut-2"], lane_count: 2, rejected_earlier: 0 },
				}
			: command === "plan"
				? { status: "completed", data: { planId: "plan-1" } }
				: { status: "completed", data: { receipt: { changed: true }, verify: { state: {} } } };

	it("stages by default: plan with stage:true, no apply, unmistakable reply", async () => {
		const calls: { command: string; input: Record<string, unknown> }[] = [];
		const result = await runProposalFlow(
			async (command, input) => {
				calls.push({ command, input });
				return reply(command, input);
			},
			{ projectId: "p", operations, requestId: "req-1" },
		);
		expect(calls.map((call) => call.command)).toEqual(["plan"]);
		expect(calls[0].input).toMatchObject({ projectId: "p", stage: true });
		expect(calls[0].input.operations).toEqual(operations);
		expect(result).toMatchObject({
			status: "completed",
			data: {
				staged: true,
				applied: false,
				changed: false,
				proposal_count: 2,
				proposal_ids: ["cut-1", "cut-2"],
				lane_count: 2,
			},
		});
		expect(JSON.stringify(result.data?.next_actions)).toContain("staged");
		expect(JSON.stringify(result.data?.next_actions)).toContain("accept");
	});

	it("applies with --accept and stamps the reason onto addTrim operations", async () => {
		const calls: { command: string; input: Record<string, unknown>; id?: string }[] = [];
		const result = await runProposalFlow(
			async (command, input, id) => {
				calls.push({ command, input, id });
				return reply(command, input);
			},
			{ projectId: "p", operations, accept: "reviewed in staged", requestId: "req-9" },
		);
		expect(calls.map((call) => call.command)).toEqual(["plan", "apply"]);
		expect(calls[0].input.stage).toBeUndefined();
		const stamped = (calls[0].input.operations as typeof operations)[0];
		expect(stamped.args.reason).toBe("gap · accepted: reviewed in staged");
		// setTrim has no reason field; it passes through untouched.
		expect((calls[0].input.operations as typeof operations)[1].args).toEqual(operations[1].args);
		expect(calls[1]).toMatchObject({ command: "apply", id: "req-9" });
		expect(result).toMatchObject({
			status: "completed",
			data: {
				staged: false,
				applied: true,
				changed: true,
				accept_reason: "reviewed in staged",
				receipt: { changed: true },
			},
		});
	});

	it("refuses a blank --accept reason as invalid input", () => {
		expect(() => resolveProposalMode("")).toThrow(/INVALID_INPUT/);
		expect(() => resolveProposalMode("   ")).toThrow(/INVALID_INPUT/);
		expect(resolveProposalMode(undefined)).toEqual({ mode: "stage" });
		expect(resolveProposalMode(" x ")).toEqual({ mode: "apply", reason: "x" });
	});

	it("passes a failed stage or apply reply through unchanged", async () => {
		const blocked = { status: "failed", error: { code: "INVALID_INPUT", message: "nope" } };
		const staged = await runProposalFlow(async () => blocked, {
			projectId: "p",
			operations,
			requestId: "r",
		});
		expect(staged).toBe(blocked);
		const applied = await runProposalFlow(
			async (command) => (command === "plan" ? reply("plan", {}) : blocked),
			{ projectId: "p", operations, accept: "why", requestId: "r" },
		);
		expect(applied).toBe(blocked);
	});

	it("caps the stamped reason at the lane limit", () => {
		const [stamped] = stampAcceptReason(operations, "x".repeat(500));
		expect(String(stamped.args.reason)).toHaveLength(256);
	});
});
