// @vitest-environment node
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import type { IpcMain } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AGENT_SESSION_REPLY,
	type AgentSessionMessage,
} from "../../src/lib/ai-edition/agent/sessionProtocol";
import { editFixture } from "../../src/lib/ai-edition/checks/fixtures";
import { createEmptyDocument } from "../../src/lib/ai-edition/schema";
import {
	canonicalTransactionPayload,
	type ProjectTransactionReceipt,
} from "../ai-edition/projectTransactions";
import type { AgentBrokerRequest } from "./agentBroker";
import { exitCodeForReply } from "./agentOutputContract";

const mock = vi.hoisted(() => ({
	windows: vi.fn(),
	start: vi.fn(),
	userData: "",
	contentVerify: vi.fn(),
}));
vi.mock("electron", () => ({
	BrowserWindow: { getAllWindows: mock.windows },
	app: { getPath: () => mock.userData },
}));
vi.mock("./agentBroker", () => ({ startAgentBroker: mock.start }));
vi.mock("./agentContentVerify", () => ({ verifyContentAtEdges: mock.contentVerify }));

import { startEditorAgentBroker } from "./editorAgentBroker";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
	for (const close of cleanup.reverse()) await close();
	cleanup.length = 0;
	vi.useRealTimers();
	vi.restoreAllMocks();
});
async function setup() {
	const directory = await fs.mkdtemp("/tmp/kea-");
	mock.userData = directory;
	cleanup.push(() => fs.rm(directory, { recursive: true, force: true }));
	await fs.writeFile(path.join(directory, "music.wav"), "fixture");
	const ipc = new EventEmitter();
	const mainFrame = {};
	const sender = { id: 7, mainFrame };
	const send = vi.fn();
	mock.windows.mockReturnValue([
		{
			isDestroyed: () => false,
			webContents: {
				...sender,
				getURL: () => "klippt://app/index.html?windowType=editor",
				send,
			},
		},
	]);
	let handler: (request: AgentBrokerRequest) => Promise<unknown> = async () => undefined;
	const closeTransport = vi.fn(async () => undefined);
	mock.start.mockImplementation(async (_dir, callback) => {
		handler = callback;
		return {
			socketPath: path.join(directory, "agent.sock"),
			close: closeTransport,
		};
	});
	const document = createEmptyDocument({
		projectId: "project",
		title: "Test",
		createdAt: "2026-09-07T00:00:00.000Z",
	});
	const version = {
		mutationIdentity: "m",
		revision: "r",
		fileHash: "a".repeat(64),
	};
	const documents = {
		getTransactionSnapshot: vi.fn(async () => ({ document, version })),
		prepareAudioAsset: vi.fn(async () => ({
			id: "audio_import",
			label: "Music",
			originalPath: path.join(directory, "music.wav"),
			durationSec: 10,
		})),
		getTransactionReceipt: vi.fn(async (): Promise<ProjectTransactionReceipt | null> => null),
	};
	const reply = (
		message: AgentSessionMessage,
		data: unknown,
		event = { sender, senderFrame: mainFrame },
	) =>
		ipc.emit(AGENT_SESSION_REPLY, event, {
			id: message.id,
			status: "completed",
			data,
		});
	const broker = await startEditorAgentBroker({
		directory,
		documents,
		approveSelectedMedia: async (file) => file,
		ipcMain: ipc as unknown as IpcMain,
	});
	cleanup.push(broker.close);
	const request = (command: string, input: Record<string, unknown> = {}, request_id = "req") =>
		handler({ api_version: "1.0", request_id, command, input });
	const plan = async () => {
		send.mockImplementation((_channel, message: AgentSessionMessage) => reply(message, version));
		const result = await request("plan", {
			projectId: "project",
			operations: [{ type: "set-layout", settings: { padding: 10 } }],
		});
		return result as { data: { planId: string; candidatePath: string } };
	};
	return {
		directory,
		ipc,
		sender,
		mainFrame,
		send,
		reply,
		documents,
		document,
		version,
		request,
		plan,
		closeTransport,
		broker,
	};
}

describe("editor broker ownership and recovery", () => {
	it("checks a placement candidate and blocks errors before dispatching apply", async () => {
		const s = await setup();
		Object.assign(s.document, editFixture());
		s.send.mockImplementation((_channel, message: AgentSessionMessage) =>
			s.reply(message, s.version),
		);
		const plan = (await s.request("plan", {
			projectId: "project",
			placement: {
				kind: "text",
				action: "add",
				project_id: "project",
				from: 1,
				to: 4,
				text: "Collision",
				anchor: "bottom-right",
				size: "XL",
			},
		})) as {
			status: string;
			data: { planId: string; checks: { counts: { error: number } } };
		};
		expect(plan.status).toBe("completed");
		expect(plan.data.checks.counts.error).toBeGreaterThan(0);
		const sent = s.send.mock.calls.length;
		const result = (await s.request(
			"apply",
			{ projectId: "project", planId: plan.data.planId },
			"guarded",
		)) as {
			status: string;
			confirm_command?: string;
			error: {
				code: string;
				message: string;
				hint: string;
				retryable: boolean;
				field_errors: unknown[];
				findings_total: number;
			};
		};
		expect(result.status).toBe("failed");
		// Blocked by checks: the fixed error shape plus the exact confirming retry.
		expect(result.error).toMatchObject({
			code: "CHECK_ERRORS",
			retryable: false,
			field_errors: [],
		});
		expect(typeof result.error.hint).toBe("string");
		expect(result.error.findings_total).toBeGreaterThan(0);
		expect(result.confirm_command).toBe(
			`klippt agent apply --project_id project --plan_id ${plan.data.planId} --request_id guarded --force`,
		);
		expect(exitCodeForReply(result)).toBe(3);
		expect(s.send.mock.calls).toHaveLength(sent);
		s.send.mockImplementation((_channel, message: AgentSessionMessage) =>
			s.reply(message, { requestId: "forced" }),
		);
		expect(
			await s.request(
				"apply",
				{ projectId: "project", planId: plan.data.planId, force: true },
				"forced",
			),
		).toMatchObject({ status: "completed" });
	});
	it("prepares an audio import without writing the live document, then applies that exact candidate", async () => {
		const s = await setup();
		s.send.mockImplementation((_channel, message: AgentSessionMessage) =>
			s.reply(message, s.version),
		);
		const planned = (await s.request("import-plan", {
			projectId: "project",
			media: {
				kind: "audio",
				path: "/selected/music.wav",
				placement: { startSec: 0, endSec: 4 },
			},
		})) as {
			status: string;
			data: { planId: string; candidatePath: string; applied: boolean };
		};
		expect(planned.status).toBe("completed");
		expect(planned.data.applied).toBe(false);
		expect(s.document.audioAssets).toBeUndefined();
		const candidate = JSON.parse(await fs.readFile(planned.data.candidatePath, "utf8"));
		expect(candidate.audioAssets[0].id).toBe("audio_import");
		s.send.mockImplementation((_channel, message: AgentSessionMessage) =>
			s.reply(message, { changed: true }),
		);
		await s.request("apply", { projectId: "project", planId: planned.data.planId }, "import-apply");
		const apply = [...s.send.mock.calls]
			.reverse()
			.find((call) => call[1].action === "apply")?.[1] as AgentSessionMessage;
		expect(apply.document).toEqual(candidate);
		expect(apply.guard?.expected).toEqual(s.version);
		expect(s.documents.prepareAudioAsset).toHaveBeenCalledTimes(1);
	});

	it("uses exclusive GUI ownership and ignores replies from another sender or a child frame", async () => {
		const s = await setup();
		expect(mock.start.mock.calls.at(-1)?.[2]).toEqual({ exclusiveOwner: true });
		const pending = s.request("inspect");
		const message = s.send.mock.calls[0][1] as AgentSessionMessage;
		s.reply(message, null, {
			sender: { id: 9, mainFrame: s.mainFrame },
			senderFrame: s.mainFrame,
		});
		s.reply(message, null, { sender: s.sender, senderFrame: {} });
		s.reply(message, {
			document: s.document,
			dirty: false,
			currentTimeSec: 0,
			busy: false,
			syncPending: false,
		});
		expect(await pending).toMatchObject({
			status: "completed",
			data: {
				state: "live_editor",
				live_editor_state: "available",
				analysis: { background_jobs: "unknown" },
			},
		});
	});
	it("returns recovery instructions when a dispatched apply times out and preserves receipt access", async () => {
		const s = await setup();
		const plan = await s.plan();
		s.send.mockImplementation(() => undefined);
		vi.useFakeTimers();
		const result = s.request(
			"apply",
			{ projectId: "project", planId: plan.data.planId },
			"write-1",
		);
		await vi.advanceTimersByTimeAsync(25_001);
		const timedOut = await result;
		expect(timedOut).toMatchObject({
			status: "recovery_required",
			commit_status: "unknown",
			error: { code: "EDITOR_TIMEOUT", retryable: false, field_errors: [] },
			next_actions: [{ command: "receipt", operationRequestId: "write-1" }],
		});
		expect(exitCodeForReply(timedOut)).toBe(6);
		s.documents.getTransactionReceipt.mockResolvedValue({
			requestId: "write-1",
			payloadHash: "a".repeat(64),
		} as ProjectTransactionReceipt);
		expect(
			await s.request("receipt", {
				projectId: "project",
				operationRequestId: "write-1",
			}),
		).toMatchObject({ data: { receipt: { requestId: "write-1" } } });
		expect(s.documents.getTransactionReceipt).toHaveBeenLastCalledWith("project", "write-1");
	});
	it("checks the exact persisted payload hash before replay and never redispatches a receipt", async () => {
		const s = await setup();
		const plan = await s.plan();
		const candidate: unknown = JSON.parse(await fs.readFile(plan.data.candidatePath, "utf8"));
		const payloadHash = createHash("sha256")
			.update(
				canonicalTransactionPayload({
					payload: { projectId: "project", document: candidate },
					recordUndo: true,
					agentHistory: {
						kind: "apply",
						targetIds: [],
						force: false,
						planSummary: "1 operations: set-layout",
					},
				}),
			)
			.digest("hex");
		const receipt = {
			requestId: "write-1",
			payloadHash,
		} as ProjectTransactionReceipt;
		s.documents.getTransactionReceipt.mockResolvedValue(receipt);
		s.send.mockClear();
		expect(
			await s.request("apply", { projectId: "project", planId: plan.data.planId }, "write-1"),
		).toMatchObject({
			status: "completed",
			data: { replayed: true, editorSync: "not_checked" },
		});
		s.documents.getTransactionReceipt.mockResolvedValue({
			...receipt,
			payloadHash: "b".repeat(64),
		});
		const reused = await s.request(
			"apply",
			{ projectId: "project", planId: plan.data.planId },
			"write-1",
		);
		expect(reused).toMatchObject({
			status: "failed",
			error: { code: "KEY_REUSED" },
		});
		expect(exitCodeForReply(reused)).toBe(5);
		expect(s.send).not.toHaveBeenCalled();
	});
	it("directs stale plan requests to receipt recovery", async () => {
		const s = await setup();
		expect(
			await s.request("apply", { projectId: "project", planId: "old" }, "old-write"),
		).toMatchObject({
			status: "recovery_required",
			next_actions: [{ command: "receipt", operationRequestId: "old-write" }],
		});
		expect(s.send).not.toHaveBeenCalled();
	});
	it("refuses an expired prepared plan before dispatching another write", async () => {
		const s = await setup();
		const plan = await s.plan();
		s.send.mockClear();
		const future = Date.now() + 31 * 60_000;
		vi.spyOn(Date, "now").mockReturnValue(future);
		const expired = await s.request(
			"apply",
			{ projectId: "project", planId: plan.data.planId },
			"old-write",
		);
		expect(expired).toMatchObject({
			status: "recovery_required",
			error: { code: "PLAN_UNAVAILABLE" },
		});
		expect(exitCodeForReply(expired)).toBe(4);
		expect(s.send).not.toHaveBeenCalled();
	});

	it("settles pending relays and removes reply listeners on shutdown", async () => {
		const s = await setup();
		const pending = s.request("inspect");
		await s.broker.close();
		const closed = await pending;
		expect(closed).toMatchObject({ error: { code: "BROKER_CLOSED" } });
		expect(exitCodeForReply(closed)).toBe(4);
		expect(s.ipc.listenerCount(AGENT_SESSION_REPLY)).toBe(0);
	});
	it("keeps the bound broker usable if startup garbage collection fails", async () => {
		vi.spyOn(fs, "opendir").mockRejectedValue(new Error("GC unavailable"));
		const s = await setup();
		expect(s.closeTransport).not.toHaveBeenCalled();
		expect(
			await s.request("receipt", {
				projectId: "project",
				operationRequestId: "old",
			}),
		).toMatchObject({ status: "completed" });
	});
});

describe("editor analysis relays", () => {
	it("relays transcribe and pauses to the editor and formats the pause page", async () => {
		const { request, send, reply } = await setup();
		send.mockImplementation((_channel, message: AgentSessionMessage) =>
			reply(message, { assets: [{ assetId: "a", status: "queued" }] }),
		);
		const transcribe = (await request("transcribe", {
			projectId: "project",
		})) as {
			status: string;
			data: { assets: unknown[] };
		};
		expect(transcribe.status).toBe("completed");
		expect(transcribe.data.assets).toHaveLength(1);
		expect(send).toHaveBeenLastCalledWith(
			expect.any(String),
			expect.objectContaining({ action: "transcribe", projectId: "project" }),
		);
		const policy = {
			mode: "speech",
			minimumPauseSec: 0.8,
			shortenedPauseSec: 0.3,
			keepBeforeSec: 0.12,
			keepAfterSec: 0.18,
			minimumKeptFragmentSec: 0.35,
			sensitivity: 0.5,
			manualThresholdDb: null,
			includeNonSpeechEvents: false,
			protectSystemAudio: true,
			protectScreenActivity: true,
			transitionMs: 10,
		};
		send.mockImplementation((_channel, message: AgentSessionMessage) =>
			reply(message, {
				status: "ready",
				revision: "r",
				policy: message.pausePolicy,
				analyzedClipCount: 1,
				missingTranscript: false,
				missingMicrophone: false,
				missingSpeechActivity: false,
				usedMixedAudio: false,
				suggestions: [
					{
						id: "s",
						clipId: "c",
						assetId: "a",
						silenceStartSec: 1,
						silenceEndSec: 2,
						sourceStartSec: 1.1,
						sourceEndSec: 1.8,
						timelineStartSec: 1.1,
						timelineEndSec: 1.8,
						savedSec: 0.7,
					},
				],
				error: null,
			}),
		);
		const pauses = (await request("pauses", {
			projectId: "project",
			policy,
			offset: 0,
			limit: 50,
		})) as {
			status: string;
			data: { operations: unknown[]; totals: { suggestions: number } };
		};
		expect(pauses.status).toBe("completed");
		expect(pauses.data.totals.suggestions).toBe(1);
		expect(pauses.data.operations).toEqual([
			{
				type: "addTrim",
				args: { clipId: "c", startSec: 1.1, endSec: 1.8, reason: "Shortened pause" },
			},
		]);
		const invalid = (await request("pauses", {
			projectId: "project",
			policy: { mode: "x" },
		})) as {
			status: string;
			error: {
				code: string;
				hint: string;
				retryable: boolean;
				field_errors: unknown[];
			};
		};
		expect(invalid.status).toBe("failed");
		expect(invalid.error).toMatchObject({
			code: "INVALID_INPUT",
			retryable: false,
		});
		expect(invalid.error.field_errors.length).toBeGreaterThan(0);
		expect(typeof invalid.error.hint).toBe("string");
		expect(exitCodeForReply(invalid)).toBe(2);
	});
});

describe("open relay", () => {
	it("opens the editor window when none exists, then asks it to load the project", async () => {
		const { request, send, reply, ipc, documents } = await setup();
		const editor = (mock.windows() as Array<{ webContents: { send: typeof send } }>)[0];
		mock.windows.mockReturnValue([]);
		let opened = false;
		const broker = await startEditorAgentBroker({
			directory: await fs.mkdtemp("/tmp/kea-open-"),
			documents,
			ipcMain: ipc as unknown as IpcMain,
			openEditorWindow: () => {
				opened = true;
				mock.windows.mockReturnValue([
					{
						...editor,
						webContents: { ...editor.webContents, isLoading: () => false },
					},
				]);
			},
		});
		cleanup.push(broker.close);
		send.mockImplementation((_channel, message: AgentSessionMessage) =>
			reply(message, { projectId: "project", title: "T", clips: 3 }),
		);
		const result = (await request("open", { projectId: "project" })) as {
			status: string;
			data: { clips: number };
		};
		expect(opened).toBe(true);
		expect(result.status).toBe("completed");
		expect(result.data.clips).toBe(3);
		expect(send).toHaveBeenLastCalledWith(
			expect.any(String),
			expect.objectContaining({ action: "open", projectId: "project" }),
		);
	});
});

describe("plan capacity", () => {
	it("releases a plan once it is applied so twenty applied edits do not exhaust capacity", async () => {
		const s = await setup();
		for (let i = 0; i < 22; i++) {
			const { data } = await s.plan();
			s.send.mockImplementation((_channel, message: AgentSessionMessage) =>
				reply(message, { requestId: `apply-${i}` }),
			);
			const applied = (await s.request(
				"apply",
				{ projectId: "project", planId: data.planId },
				`apply-${i}`,
			)) as {
				status: string;
			};
			expect(applied.status).toBe("completed");
			await expect(fs.stat(data.candidatePath)).rejects.toThrow();
		}
		function reply(message: AgentSessionMessage, payload: unknown) {
			return s.reply(message, payload);
		}
	});
});

describe("Task E broker plans", () => {
	it("reads current settings through the editor and guards setting writes", async () => {
		const s = await setup();
		s.send.mockImplementation((_channel, message: AgentSessionMessage) =>
			s.reply(message, message.action === "inspect" ? { document: s.document } : s.version),
		);
		expect(await s.request("settings", { projectId: "project" })).toMatchObject({
			status: "completed",
			data: {
				groups: {
					frame: expect.arrayContaining([
						expect.objectContaining({
							key: "motionBlurAmount",
							current: 0.2,
						}),
					]),
				},
			},
		});
		const result = await s.request("plan", {
			projectId: "project",
			operations: [{ type: "set-layout", settings: { motionBlurAmount: 0.3 } }],
		});
		expect(result).toMatchObject({
			status: "completed",
			data: { summary: { settings_changed: true } },
		});
		expect(s.document.legacyEditor?.motionBlurAmount).toBeUndefined();
	});
	it("returns pending analysis without publishing a plan or changing the document", async () => {
		const s = await setup();
		s.send.mockImplementation((_channel, message: AgentSessionMessage) =>
			s.reply(
				message,
				message.action === "direction-observations" ? { status: "analyzing" } : s.version,
			),
		);
		const before = JSON.stringify(s.document);
		const result = await s.request("plan", {
			projectId: "project",
			operations: [{ type: "autoDirectionRegenerate" }],
		});
		expect(result).toMatchObject({
			status: "completed",
			data: { status: "analyzing" },
		});
		expect(JSON.stringify(s.document)).toBe(before);
		expect((await fs.readdir(s.directory)).filter((p) => p.endsWith(".klippt"))).toEqual([]);
	});
	it("propagates analysis failure before a regeneration plan exists", async () => {
		const s = await setup();
		s.send.mockImplementation((_channel, message: AgentSessionMessage) =>
			s.reply(
				message,
				message.action === "direction-observations"
					? { status: "failed", error: "missing observations" }
					: s.version,
			),
		);
		expect(
			await s.request("plan", {
				projectId: "project",
				operations: [{ type: "autoDirectionRegenerate" }],
			}),
		).toMatchObject({ status: "failed" });
		expect((await fs.readdir(s.directory)).filter((p) => p.endsWith(".klippt"))).toEqual([]);
	});
});

it("saves and lists agent/UI presets, plans apply, and deletes only agent storage", async () => {
	const s = await setup();
	const { BUILTIN_VISUAL_PRESETS } = await import("../../src/lib/ai-edition/store/visualPresets");
	s.send.mockImplementation((_channel, message: AgentSessionMessage) =>
		s.reply(
			message,
			message.action === "inspect"
				? { document: s.document }
				: message.action === "presets"
					? BUILTIN_VISUAL_PRESETS
					: s.version,
		),
	);
	expect(
		await s.request("preset", {
			action: "save",
			project_id: "project",
			name: "night",
		}),
	).toMatchObject({ status: "completed", data: { saved: true } });
	expect(await s.request("preset", { action: "list" })).toMatchObject({
		data: {
			presets: expect.arrayContaining([
				expect.objectContaining({ name: "night", source: "agent" }),
				expect.objectContaining({ name: "Clean", source: "ui" }),
			]),
		},
	});
	for (const [name, source] of [
		["night", "agent"],
		["Clean", "ui"],
	])
		expect(
			await s.request("plan", {
				projectId: "project",
				preset: { name, source },
			}),
		).toMatchObject({
			status: "completed",
			data: { planId: expect.any(String) },
		});
	expect(await s.request("preset", { action: "delete", name: "night" })).toMatchObject({
		status: "completed",
		data: { deleted: true },
	});
	expect(
		JSON.parse(await fs.readFile(path.join(s.directory, "agent-presets.json"), "utf8")).presets,
	).toEqual([]);
});

it("stages only trim plans without activating or reading a transaction snapshot", async () => {
	const s = await setup();
	s.send.mockImplementation((_channel, message: AgentSessionMessage) =>
		s.reply(message, { staged: ["a"], lane_count: 1 }),
	);
	const operations = [{ type: "addTrim", args: { clipId: "clip", startSec: 2, endSec: 4 } }];
	expect(await s.request("plan", { projectId: "project", operations, stage: true })).toMatchObject({
		status: "completed",
		data: { staged: ["a"], lane_count: 1 },
	});
	expect(s.send).toHaveBeenCalledOnce();
	expect(s.send.mock.calls[0][1]).toMatchObject({
		action: "stage",
		stagedCuts: {
			operations: [{ ...operations[0], args: { ...operations[0].args, reason: "" } }],
		},
	});
	expect(s.documents.getTransactionSnapshot).not.toHaveBeenCalled();
	s.send.mockClear();
	expect(
		await s.request("plan", {
			projectId: "project",
			operations: [...operations, { type: "set-layout", settings: { padding: 10 } }],
			stage: true,
		}),
	).toMatchObject({ status: "failed", error: { code: "INVALID_INPUT" } });
	expect(s.send).not.toHaveBeenCalled();
});
it.each(["staged", "accept", "reject"])("relays %s to the open editor lane", async (command) => {
	const s = await setup();
	s.send.mockImplementation((_channel, message: AgentSessionMessage) =>
		s.reply(message, { lane_count: 1 }),
	);
	expect(
		await s.request(command, {
			projectId: "project",
			...(command === "staged" ? {} : { ids: ["a"] }),
		}),
	).toMatchObject({ status: "completed" });
	expect(s.send.mock.calls[0][1]).toMatchObject({
		action: command,
		projectId: "project",
	});
});

it("preserves acceptance request IDs and reports uncertain replies as recoverable writes", async () => {
	vi.useFakeTimers();
	const s = await setup();
	s.send.mockImplementation(() => undefined);
	const accepting = s.request("accept", { projectId: "project", ids: ["cut"] }, "accept-stable");
	await vi.advanceTimersByTimeAsync(60_001);
	expect(s.send.mock.calls[0][1]).toMatchObject({
		action: "accept",
		mutationRequestId: "accept-stable",
	});
	expect(await accepting).toMatchObject({
		status: "recovery_required",
		commit_status: "unknown",
		next_actions: [{ command: "receipt", operationRequestId: "accept-stable" }],
	});
});

describe("phase 3: one time base", () => {
	const timePolicy = {
		padBeforeSec: 0.1,
		padAfterSec: 0.15,
		sensitivity: 0.5,
		sentenceGapSec: 0.8,
	};
	// Single clip, 22.324 s trimmed out at 50 s: 103 edited = 125.324 raw/source.
	const timeFixture = () => editFixture({ duration: 200, trims: [[50, 72.324]] });
	const liveReply = (document: unknown) => ({
		document,
		dirty: false,
		currentTimeSec: 0,
		busy: false,
		syncPending: false,
	});

	it("converts suffixed state times against the live document and labels the reply", async () => {
		const { request, send, reply } = await setup();
		send.mockImplementation((_channel, message: AgentSessionMessage) =>
			message.action === "inspect"
				? reply(message, liveReply(timeFixture()))
				: reply(message, {
						state: { editedTimeSec: 103 },
						revision: "r",
						documentKey: "k",
					}),
		);
		const result = (await request("state", {
			projectId: "project",
			at: { seconds: 125.324, base: "raw" },
		})) as { status: string; data: Record<string, unknown> };
		expect(result.status).toBe("completed");
		expect(send).toHaveBeenLastCalledWith(
			expect.any(String),
			expect.objectContaining({ action: "state", editState: { at: 103 } }),
		);
		expect(result.data.time_bases).toMatchObject({
			editedTimeSec: expect.stringContaining("edited"),
			rawTimeSec: expect.stringContaining("raw"),
			sourceTimeSec: expect.stringContaining("source"),
		});
		// Bare numbers keep the documented edited meaning and skip the lookup.
		send.mockClear();
		await request("state", { projectId: "project", at: 5 });
		expect(send).toHaveBeenCalledTimes(1);
		expect(send).toHaveBeenLastCalledWith(
			expect.any(String),
			expect.objectContaining({ action: "state", editState: { at: 5 } }),
		);
	});

	it("converts transport seeks to raw seconds and reports all three bases", async () => {
		const { request, send, reply } = await setup();
		send.mockImplementation((_channel, message: AgentSessionMessage) =>
			message.action === "inspect"
				? reply(message, liveReply(timeFixture()))
				: reply(message, { status: "ready", samples: [], probe: null }),
		);
		const result = (await request("transport", {
			projectId: "project",
			runId: "run",
			steps: [
				{ op: "seek", sec: { seconds: 103, base: "edited" } },
				{ op: "seek", sec: "125.324r" },
				{ op: "seek", sec: 125.324 },
				{ op: "play" },
			],
		})) as {
			status: string;
			data: { resolved_seeks: Record<string, unknown>[]; time_bases: unknown };
		};
		expect(result.status).toBe("completed");
		const transportMessage = send.mock.calls
			.map((call) => call[1] as AgentSessionMessage)
			.find((message) => message.action === "transport");
		expect(transportMessage?.transport?.steps).toEqual([
			{ op: "seek", sec: 125.324 },
			{ op: "seek", sec: 125.324 },
			{ op: "seek", sec: 125.324 },
			{ op: "play" },
		]);
		expect(result.data.resolved_seeks).toHaveLength(3);
		expect(result.data.resolved_seeks[0]).toMatchObject({
			edited_sec: 103,
			raw_sec: 125.324,
			source_sec: 125.324,
			clip_id: "clip",
			input_base: "edited",
		});
		expect(result.data.time_bases).toMatchObject({
			currentTimeSec: expect.stringContaining("raw"),
		});
	});

	it("converts cutpoint edited input to source seconds and keeps legacy timeSec", async () => {
		const { request, send, reply } = await setup();
		send.mockImplementation((_channel, message: AgentSessionMessage) =>
			message.action === "inspect"
				? reply(message, liveReply(timeFixture()))
				: reply(message, {
						status: "ready",
						revision: "r",
						request: message.cutPoint,
						result: null,
						error: null,
					}),
		);
		const result = (await request("cutpoint", {
			projectId: "project",
			clipId: "clip",
			time: { seconds: 103, base: "edited" },
			edge: "out",
			policy: timePolicy,
		})) as { status: string; data: { requested_time?: Record<string, unknown> } };
		expect(result.status).toBe("completed");
		expect(send).toHaveBeenLastCalledWith(
			expect.any(String),
			expect.objectContaining({
				action: "cutpoint",
				cutPoint: expect.objectContaining({ clipId: "clip", timeSec: 125.324 }),
			}),
		);
		expect(result.data.requested_time).toMatchObject({
			edited_sec: 103,
			raw_sec: 125.324,
			source_sec: 125.324,
			clip_id: "clip",
			input_base: "edited",
		});
		const legacy = (await request("cutpoint", {
			projectId: "project",
			clipId: "clip",
			timeSec: 5,
			edge: "in",
			policy: timePolicy,
		})) as { status: string; data: Record<string, unknown> };
		expect(legacy.status).toBe("completed");
		expect(send).toHaveBeenLastCalledWith(
			expect.any(String),
			expect.objectContaining({
				cutPoint: expect.objectContaining({ timeSec: 5 }),
			}),
		);
		expect(legacy.data.requested_time).toBeUndefined();
	});

	it("audits the live reply surface with check --rule reply.time-base", async () => {
		const { request, send, reply } = await setup();
		send.mockImplementation((_channel, message: AgentSessionMessage) =>
			reply(message, liveReply(timeFixture())),
		);
		const result = (await request("check", {
			projectId: "project",
			page: 1,
			page_size: 50,
			deep: false,
			rule: "reply.time-base",
		})) as {
			status: string;
			data: {
				status: string;
				result: {
					counts: { warning: number };
					findings: unknown[];
					rules: { id: string }[];
				};
			};
		};
		expect(result.status).toBe("completed");
		expect(result.data.status).toBe("ready");
		expect(result.data.result.rules[0].id).toBe("reply.time-base");
		// The composed live reply labels its times, so the audit is clean.
		expect(result.data.result.findings).toEqual([]);
		expect(result.data.result.counts.warning).toBe(0);
	});
});

describe("phase 6b: content verification wiring", () => {
	// Single clip, 22.324 s trimmed out at 50 s: cut at edited 50, media out 50 / in 72.324.
	const trimmedFixture = () => editFixture({ duration: 200, trims: [[50, 72.324]] });
	const liveReply = (document: unknown) => ({
		document,
		dirty: false,
		currentTimeSec: 0,
		busy: false,
		syncPending: false,
	});
	const clippedVerify = {
		status: "ok",
		findings: [
			{
				rule: "cut.clipped-word",
				severity: "error",
				at: 50,
				label: "out:clip",
				message: "Out point 50.000s is mid-word.",
				evidence: { tailDbFs: -27, postDbFs: -28, deltaDb: -1, windowStartSec: 49.4 },
			},
		],
		analyses: [
			{
				edge: { timeSec: 50, label: "out:clip", kind: "cut" },
				status: "ok",
				windowStartSec: 49.4,
				bucketsDbFs: [],
				tailDbFs: -27,
				postDbFs: -28,
				deltaDb: -1,
				clipped: true,
			},
		],
		frames: [],
		filmstrip: null,
	};
	const checkRun = {
		status: "ready",
		revision: "r",
		result: {
			findings: [] as unknown[],
			counts: { error: 0, warning: 0, info: 0, byRule: {} },
			total: 0,
			notes: [] as string[],
			rules: [] as { id: string; severity: string; describe: string }[],
		},
		audio: { ready: 0, pending: 0 },
		timings: { elapsedMs: 1, peaksMs: 0, speechMs: 0 },
		error: null,
	};
	afterEach(() => {
		mock.contentVerify.mockReset();
	});

	it("verify decodes every cut edge in range and reports findings on the edited clock", async () => {
		const s = await setup();
		mock.contentVerify.mockReturnValue(clippedVerify);
		s.send.mockImplementation((_channel, message: AgentSessionMessage) =>
			s.reply(message, liveReply(trimmedFixture())),
		);
		const result = (await s.request("verify", {
			projectId: "project",
			range: {
				startSec: { seconds: 40, base: "edited" },
				endSec: { seconds: 60, base: "edited" },
			},
		})) as {
			status: string;
			data: {
				status: string;
				edges_analyzed: number;
				counts: { error: number; warning: number };
				range: { startSec: number; endSec: number };
				findings: { rule: string; severity: string; at: number; clip: string | null }[];
				time_base: { findings_at: string };
			};
		};
		expect(result.status).toBe("completed");
		expect(result.data).toMatchObject({
			status: "ok",
			edges_analyzed: 2,
			counts: { error: 1, warning: 0 },
			range: { startSec: 40, endSec: 60 },
		});
		expect(result.data.findings[0]).toMatchObject({
			rule: "cut.clipped-word",
			severity: "error",
			at: 50,
			clip: "clip",
		});
		expect(result.data.time_base.findings_at).toContain("edited");
		expect(mock.contentVerify).toHaveBeenCalledTimes(1);
		const [mediaPath, edges] = mock.contentVerify.mock.calls[0] as [
			string,
			{ timeSec: number; kind: string }[],
		];
		expect(mediaPath).toBe("/take.mp4");
		expect(edges.map((edge) => [edge.timeSec, edge.kind])).toEqual([
			[50, "cut"],
			[72.324, "cut"],
		]);
	});

	it("verify rejects a range past the edited duration without invoking the detector", async () => {
		const s = await setup();
		s.send.mockImplementation((_channel, message: AgentSessionMessage) =>
			s.reply(message, liveReply(trimmedFixture())),
		);
		const result = (await s.request("verify", {
			projectId: "project",
			range: { startSec: 0, endSec: 500 },
		})) as { status: string; error: { code: string } };
		expect(result).toMatchObject({ status: "failed", error: { code: "TIME_OUTSIDE_PROJECT" } });
		expect(mock.contentVerify).not.toHaveBeenCalled();
	});

	it("verify fails with FFMPEG_UNAVAILABLE when the detector has no ffmpeg", async () => {
		const s = await setup();
		mock.contentVerify.mockReturnValue({
			status: "ffmpeg-missing",
			findings: [],
			analyses: [],
			frames: [],
			filmstrip: null,
		});
		s.send.mockImplementation((_channel, message: AgentSessionMessage) =>
			s.reply(message, liveReply(trimmedFixture())),
		);
		const result = (await s.request("verify", {
			projectId: "project",
			range: { startSec: 40, endSec: 60 },
		})) as { status: string; error: { code: string } };
		expect(result).toMatchObject({ status: "failed", error: { code: "FFMPEG_UNAVAILABLE" } });
		expect(exitCodeForReply(result)).toBe(4);
	});

	it("check --deep merges content findings into the page; shallow check never decodes", async () => {
		const s = await setup();
		mock.contentVerify.mockReturnValue({
			...clippedVerify,
			findings: [
				{
					rule: "frame.black",
					severity: "warning",
					at: 50,
					label: "out:clip",
					message: "Frame at 50.000s is black.",
					evidence: { meanLuma: 0.01, maxLuma: 0.02 },
				},
			],
			analyses: [],
		});
		s.send.mockImplementation((_channel, message: AgentSessionMessage) =>
			s.reply(message, message.action === "inspect" ? liveReply(trimmedFixture()) : checkRun),
		);
		const deep = (await s.request("check", {
			projectId: "project",
			page: 1,
			page_size: 50,
			deep: true,
		})) as {
			status: string;
			data: {
				result: {
					findings: { rule: string; severity: string; at: number; clip: string | null }[];
					counts: { warning: number; byRule: Record<string, number> };
					total: number;
					rules: { id: string }[];
				};
				content_verification?: { status: string; edges_analyzed: number };
			};
		};
		expect(deep.status).toBe("completed");
		expect(deep.data.result.findings).toHaveLength(1);
		expect(deep.data.result.findings[0]).toMatchObject({
			rule: "frame.black",
			severity: "warning",
			at: 50,
			clip: "clip",
		});
		expect(deep.data.result.counts).toMatchObject({
			warning: 1,
			byRule: { "frame.black": 1 },
		});
		expect(deep.data.result.total).toBe(1);
		expect(deep.data.result.rules.map((rule: { id: string }) => rule.id)).toContain("frame.black");
		expect(deep.data.content_verification).toMatchObject({ status: "ok", edges_analyzed: 2 });
		// The editor still receives the deep flag for its own speech analysis.
		const relayed = s.send.mock.calls
			.map((call) => call[1] as AgentSessionMessage)
			.find((message) => message.action === "check");
		expect(relayed?.editCheck).toMatchObject({ deep: true });
		mock.contentVerify.mockClear();
		const shallow = (await s.request("check", {
			projectId: "project",
			page: 1,
			page_size: 50,
			deep: false,
		})) as { data: { content_verification?: unknown } };
		expect(shallow.data.content_verification).toBeUndefined();
		expect(mock.contentVerify).not.toHaveBeenCalled();
	});

	it("apply --deep adds content findings to the committed verify block", async () => {
		const s = await setup();
		s.documents.getTransactionSnapshot.mockResolvedValue({
			document: trimmedFixture(),
			version: s.version,
		});
		mock.contentVerify.mockReturnValue(clippedVerify);
		s.send.mockImplementation((_channel, message: AgentSessionMessage) =>
			s.reply(message, message.action === "apply" ? { requestId: "deep-apply" } : s.version),
		);
		const plan = (await s.request("plan", {
			projectId: "project",
			operations: [{ type: "set-layout", settings: { padding: 10 } }],
		})) as { status: string; data: { planId: string } };
		expect(plan.status).toBe("completed");
		const applied = (await s.request(
			"apply",
			{ projectId: "project", planId: plan.data.planId, deep: true },
			"deep-apply",
		)) as {
			status: string;
			data: {
				commit_status: string;
				verify: {
					content_verification?: { status: string; counts: { error: number } };
					checks: { new: { rule: string }[] };
				};
			};
		};
		expect(applied).toMatchObject({ status: "completed", data: { commit_status: "committed" } });
		expect(applied.data.verify.content_verification).toMatchObject({
			status: "ok",
			counts: { error: 1 },
		});
		expect(applied.data.verify.checks.new.map((finding) => finding.rule)).toContain(
			"cut.clipped-word",
		);
		// Without --deep the verify block carries no content pass at all.
		mock.contentVerify.mockClear();
		const plain = (await s.request("plan", {
			projectId: "project",
			operations: [{ type: "set-layout", settings: { padding: 20 } }],
		})) as { data: { planId: string } };
		const plainApplied = (await s.request(
			"apply",
			{ projectId: "project", planId: plain.data.planId },
			"plain-apply",
		)) as {
			status: string;
			data: { verify: { content_verification?: unknown } };
		};
		expect(plainApplied.status).toBe("completed");
		expect(plainApplied.data.verify.content_verification).toBeUndefined();
		expect(mock.contentVerify).not.toHaveBeenCalled();
	});

	it("check --deep reports content.unavailable as an error when an edge cannot be decoded", async () => {
		const s = await setup();
		mock.contentVerify.mockReturnValue({
			status: "ok",
			findings: [],
			analyses: [
				{
					edge: { timeSec: 50, label: "out:clip", kind: "cut" },
					status: "unavailable",
					error: "decode failed: ffmpeg exited 1",
					windowStartSec: 49.4,
					bucketsDbFs: [],
					tailDbFs: null,
					postDbFs: null,
					deltaDb: null,
					clipped: false,
				},
			],
			frames: [],
			filmstrip: null,
		});
		s.send.mockImplementation((_channel, message: AgentSessionMessage) =>
			s.reply(message, message.action === "inspect" ? liveReply(trimmedFixture()) : checkRun),
		);
		const deep = (await s.request("check", {
			projectId: "project",
			page: 1,
			page_size: 50,
			deep: true,
		})) as {
			status: string;
			data: {
				result: {
					findings: { rule: string; severity: string; at: number; clip: string | null }[];
					counts: { error: number; byRule: Record<string, number> };
					rules: { id: string }[];
				};
				content_verification?: { status: string };
			};
		};
		expect(deep.status).toBe("completed");
		expect(deep.data.content_verification?.status).toBe("unavailable");
		expect(deep.data.result.findings).toContainEqual(
			expect.objectContaining({
				rule: "content.unavailable",
				severity: "error",
				at: 50,
				clip: "clip",
			}),
		);
		expect(deep.data.result.counts).toMatchObject({
			error: 1,
			byRule: { "content.unavailable": 1 },
		});
		expect(deep.data.result.rules.map((rule: { id: string }) => rule.id)).toContain(
			"content.unavailable",
		);
	});

	it("apply --deep never reports a clean verify block when content verification is unavailable", async () => {
		const s = await setup();
		s.documents.getTransactionSnapshot.mockResolvedValue({
			document: trimmedFixture(),
			version: s.version,
		});
		// ffmpeg-missing: no edge was decoded at all.
		mock.contentVerify.mockReturnValue({
			status: "ffmpeg-missing",
			findings: [],
			analyses: [],
			frames: [],
			filmstrip: null,
		});
		s.send.mockImplementation((_channel, message: AgentSessionMessage) =>
			s.reply(message, message.action === "apply" ? { requestId: "deep-unavailable" } : s.version),
		);
		const plan = (await s.request("plan", {
			projectId: "project",
			operations: [{ type: "set-layout", settings: { padding: 10 } }],
		})) as { status: string; data: { planId: string } };
		const applied = (await s.request(
			"apply",
			{ projectId: "project", planId: plan.data.planId, deep: true },
			"deep-unavailable",
		)) as {
			status: string;
			data: {
				verify: {
					content_verification?: { status: string };
					checks: { new: { rule: string; severity: string }[] };
				};
			};
		};
		expect(applied.status).toBe("completed");
		expect(applied.data.verify.content_verification?.status).toBe("ffmpeg-missing");
		expect(applied.data.verify.checks.new).toContainEqual(
			expect.objectContaining({ rule: "content.unavailable", severity: "error" }),
		);
	});
});
