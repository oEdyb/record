import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliRecordRequest } from "../../src/lib/cliContracts";
import { finalizeCliResult, writeProjectFileDurably } from "./cliCompletion";

let root = "";

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "record-cli-completion-"));
});

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

function recordCommand(projectOut: string | null): CliRecordRequest {
	return {
		kind: "record",
		displayIndex: 0,
		windowTitle: null,
		mic: false,
		micDevice: null,
		systemAudio: false,
		cursorMode: "editable-overlay",
		durationMs: 1_000,
		projectOut,
	};
}

describe("writeProjectFileDurably", () => {
	it("replaces a project with complete JSON and leaves no temporary file", async () => {
		const projectPath = path.join(root, "nested", "demo.klippt");
		await writeProjectFileDurably(projectPath, { schemaVersion: 7, title: "demo" });

		expect(JSON.parse(await fs.readFile(projectPath, "utf8"))).toEqual({
			schemaVersion: 7,
			title: "demo",
		});
		expect(await fs.readdir(path.dirname(projectPath))).toEqual(["demo.klippt"]);
	});

	it("does not truncate an existing project when serialization fails", async () => {
		const projectPath = path.join(root, "demo.klippt");
		await fs.writeFile(projectPath, "known-good", "utf8");

		await expect(writeProjectFileDurably(projectPath, { unsupported: 1n })).rejects.toThrow();
		await expect(fs.readFile(projectPath, "utf8")).resolves.toBe("known-good");
	});

	it("rejects an undefined project instead of writing invalid JSON", async () => {
		const projectPath = path.join(root, "demo.klippt");

		await expect(writeProjectFileDurably(projectPath, undefined)).rejects.toThrow(
			"cannot be serialized",
		);
		await expect(fs.access(projectPath)).rejects.toThrow();
	});

	it.skipIf(process.platform === "win32")("follows an existing output symlink", async () => {
		const targetPath = path.join(root, "real.klippt");
		const linkPath = path.join(root, "linked.klippt");
		await fs.writeFile(targetPath, "known-good", "utf8");
		await fs.symlink(path.basename(targetPath), linkPath);

		await writeProjectFileDurably(linkPath, { schemaVersion: 7, title: "updated" });

		expect((await fs.lstat(linkPath)).isSymbolicLink()).toBe(true);
		expect(JSON.parse(await fs.readFile(targetPath, "utf8"))).toMatchObject({ title: "updated" });
	});
});

describe("finalizeCliResult", () => {
	it("commits the project before consuming the recovery journal", async () => {
		const events: string[] = [];
		const projectOut = path.join(root, "demo.klippt");
		const result = await finalizeCliResult(
			recordCommand(projectOut),
			{ success: true, projectData: { schemaVersion: 7 } },
			{
				writeProjectFile: async () => {
					events.push("write");
				},
				consumeRecordingSession: async () => {
					events.push("consume");
				},
			},
		);

		expect(events).toEqual(["write", "consume"]);
		expect(result).toMatchObject({ success: true, projectPath: projectOut });
	});

	it("keeps recovery state when the project commit fails", async () => {
		const consume = vi.fn(async () => undefined);
		const result = await finalizeCliResult(
			recordCommand(path.join(root, "demo.klippt")),
			{ success: true, projectData: { schemaVersion: 7 } },
			{
				writeProjectFile: async () => {
					throw new Error("disk full");
				},
				consumeRecordingSession: consume,
			},
		);

		expect(consume).not.toHaveBeenCalled();
		expect(result).toMatchObject({ success: false });
		expect(result.error).toContain("disk full");
	});

	it("keeps recovery state when a requested project payload is missing", async () => {
		const consume = vi.fn(async () => undefined);
		const result = await finalizeCliResult(
			recordCommand(path.join(root, "demo.klippt")),
			{ success: true, screenVideoPath: "/recording.mp4" },
			{ consumeRecordingSession: consume },
		);

		expect(consume).not.toHaveBeenCalled();
		expect(result).toMatchObject({ success: false });
		expect(result.error).toContain("without the requested project data");
	});

	it("reports journal cleanup failure so the caller can retry", async () => {
		const result = await finalizeCliResult(
			recordCommand(null),
			{ success: true, screenVideoPath: "/recording.mp4" },
			{
				consumeRecordingSession: async () => {
					throw new Error("journal busy");
				},
			},
		);

		expect(result).toMatchObject({ success: false, screenVideoPath: "/recording.mp4" });
		expect(result.error).toContain("journal busy");
	});
});

it("completes review-lane commands from the installed command registry", async () => {
	const { completeAgentCommands } = await import("./cliCompletion");
	expect(await completeAgentCommands()).toEqual(
		expect.arrayContaining(["plan", "staged", "accept", "reject"]),
	);
	expect(await completeAgentCommands("stag")).toEqual(["staged"]);
});
