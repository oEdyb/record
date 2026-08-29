import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecordingStreamRegistry, registerRecordingStreamHandlers } from "./recordingStream";

describe("RecordingStreamRegistry", () => {
	let dir: string;
	const pathFor = (name: string) => path.join(dir, name);

	beforeEach(async () => {
		dir = await mkdtemp(path.join(tmpdir(), "openscreen-stream-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("streams chunks to disk in order and reports streamed on finalize", async () => {
		const registry = new RecordingStreamRegistry();
		await registry.open("rec.webm", pathFor("rec.webm"));
		await registry.append("rec.webm", Buffer.from("hello "));
		await registry.append("rec.webm", Buffer.from("world"));

		const streamed = await registry.finalize("rec.webm");

		expect(streamed).toBe(true);
		expect(await readFile(pathFor("rec.webm"), "utf8")).toBe("hello world");
		// A second finalize has nothing to close.
		expect(await registry.finalize("rec.webm")).toBe(false);
	});

	it("reports not-streamed when no stream was opened", async () => {
		const registry = new RecordingStreamRegistry();
		expect(await registry.finalize("missing.webm")).toBe(false);
		expect(registry.has("missing.webm")).toBe(false);
	});

	it("rejects open when the target path is not writable (open is awaited, not assumed)", async () => {
		const registry = new RecordingStreamRegistry();
		// Parent directory does not exist, so createWriteStream emits 'error' on open.
		await expect(
			registry.open("rec.webm", path.join(dir, "does-not-exist", "rec.webm")),
		).rejects.toThrow();
		// A failed open must not register a stream the renderer would treat as live.
		expect(registry.has("rec.webm")).toBe(false);
	});

	it("rejects append when no stream is open", async () => {
		const registry = new RecordingStreamRegistry();
		await expect(registry.append("rec.webm", Buffer.from("x"))).rejects.toThrow(
			/No active recording stream/,
		);
	});

	it("discard closes the stream and removes the partial file", async () => {
		const registry = new RecordingStreamRegistry();
		await registry.open("rec.webm", pathFor("rec.webm"));
		await registry.append("rec.webm", Buffer.from("partial"));

		await registry.discard("rec.webm", pathFor("rec.webm"));

		expect(registry.has("rec.webm")).toBe(false);
		await expect(stat(pathFor("rec.webm"))).rejects.toThrow();
		// Nothing left to finalize after a discard.
		expect(await registry.finalize("rec.webm")).toBe(false);
	});

	it("discard tolerates a missing file", async () => {
		const registry = new RecordingStreamRegistry();
		await expect(registry.discard("never.webm", pathFor("never.webm"))).resolves.toBeUndefined();
	});

	it("opening the same file twice replaces the prior stream", async () => {
		const registry = new RecordingStreamRegistry();
		await registry.open("rec.webm", pathFor("rec.webm"));
		await registry.append("rec.webm", Buffer.from("first"));
		await registry.open("rec.webm", pathFor("rec.webm"));
		await registry.append("rec.webm", Buffer.from("second"));
		await registry.finalize("rec.webm");

		expect(await readFile(pathFor("rec.webm"), "utf8")).toBe("second");
	});

	it("reports append callback latency and write failures without changing the IPC result", async () => {
		type AppendHandler = (
			event: unknown,
			fileName: string,
			chunk: ArrayBuffer,
		) => Promise<{ success: boolean; error?: string }>;
		const handlers = new Map<string, AppendHandler>();
		const ipcMain = {
			handle: vi.fn((channel: string, handler: AppendHandler) => handlers.set(channel, handler)),
		};
		const registry = new RecordingStreamRegistry();
		const append = vi
			.spyOn(registry, "append")
			.mockResolvedValueOnce()
			.mockRejectedValueOnce(Object.assign(new Error("disk full"), { code: "ENOSPC" }));
		const onAppendLatencyMs = vi.fn();
		const onWriteError = vi.fn();
		const clock = [100, 112.5, 200];

		registerRecordingStreamHandlers(
			ipcMain as unknown as Parameters<typeof registerRecordingStreamHandlers>[0],
			registry,
			pathFor,
			{
				now: () => clock.shift() ?? 200,
				onAppendLatencyMs,
				onWriteError,
			},
		);
		const handler = handlers.get("append-recording-chunk");
		expect(handler).toBeDefined();
		const chunk = Uint8Array.from([1, 2, 3]).buffer;

		await expect(handler?.({}, "rec.webm", chunk)).resolves.toEqual({ success: true });
		expect(onAppendLatencyMs).toHaveBeenCalledWith(12.5);
		expect(onWriteError).not.toHaveBeenCalled();

		await expect(handler?.({}, "rec.webm", chunk)).resolves.toEqual({
			success: false,
			error: "Error: disk full",
		});
		expect(onWriteError).toHaveBeenCalledWith(expect.objectContaining({ code: "ENOSPC" }));
		expect(append).toHaveBeenCalledTimes(2);
	});
});
