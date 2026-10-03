// @vitest-environment node

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requestAgentBroker, startAgentBroker } from "./agentBroker";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
	for (const clean of cleanup.reverse()) await clean();
	cleanup.length = 0;
});

async function directory() {
	const dir = await fs.mkdtemp("/tmp/ka-");
	await fs.chmod(dir, 0o700);
	cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
	return dir;
}

describe.skipIf(process.platform === "win32")("local agent broker", () => {
	it("roundtrips a bounded request through the owner", async () => {
		const handler = vi.fn(async (request) => ({
			request_id: request.request_id,
			status: "completed",
		}));
		const broker = await startAgentBroker(await directory(), handler);
		cleanup.push(broker.close);
		expect(
			await requestAgentBroker(broker.socketPath, {
				api_version: "1.0",
				request_id: "r",
				command: "inspect",
				input: {},
			}),
		).toEqual({ request_id: "r", status: "completed" });
		expect(handler).toHaveBeenCalledTimes(1);
	});
	it("refuses another owner without removing its endpoint", async () => {
		const dir = await directory();
		const broker = await startAgentBroker(dir, async () => ({ status: "completed" }));
		cleanup.push(broker.close);
		await expect(startAgentBroker(dir, async () => null)).rejects.toThrow();
		expect((await fs.lstat(broker.socketPath)).isSocket()).toBe(true);
	});
	it("rejects public directories and incompatible envelopes", async () => {
		const dir = await directory();
		await fs.chmod(dir, 0o755);
		await expect(startAgentBroker(dir, async () => null)).rejects.toThrow("private owned");
		await fs.chmod(dir, 0o700);
		const handler = vi.fn(async () => null);
		const broker = await startAgentBroker(dir, handler);
		cleanup.push(broker.close);
		await expect(
			requestAgentBroker(path.join(dir, "absent"), {
				api_version: "1.0",
				request_id: "r",
				command: "x",
				input: {},
			}),
		).rejects.toThrow();
		expect(handler).not.toHaveBeenCalled();
	});
	it("reclaims a crashed socket only with external exclusive ownership and refuses a live owner", async () => {
		const dir = await directory();
		const socketPath = path.join(dir, "agent.sock");
		await promisify(execFile)(process.execPath, [
			"-e",
			"require('node:net').createServer().listen(process.argv[1], () => process.exit(0))",
			socketPath,
		]);
		expect((await fs.lstat(socketPath)).isSocket()).toBe(true);
		await expect(startAgentBroker(dir, async () => null)).rejects.toThrow();
		const broker = await startAgentBroker(dir, async () => null, { exclusiveOwner: true });
		cleanup.push(broker.close);
		await expect(startAgentBroker(dir, async () => null, { exclusiveOwner: true })).rejects.toThrow(
			"already active",
		);
		expect((await fs.lstat(socketPath)).isSocket()).toBe(true);
	});
	it("closes open clients immediately during shutdown", async () => {
		const broker = await startAgentBroker(await directory(), async () => null);
		const socket = net.createConnection(broker.socketPath);
		await new Promise<void>((resolve) => socket.once("connect", resolve));
		const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
		await broker.close();
		await closed;
		expect(socket.destroyed).toBe(true);
	});
	it("expires a connection on an absolute deadline even when input keeps arriving", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const broker = await startAgentBroker(await directory(), async () => null);
			cleanup.push(broker.close);
			const socket = net.createConnection(broker.socketPath);
			await new Promise<void>((resolve) => socket.once("connect", resolve));
			const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
			await vi.advanceTimersByTimeAsync(10_000);
			socket.write(" ");
			await new Promise<void>((resolve) => setImmediate(resolve));
			await vi.advanceTimersByTimeAsync(5_000);
			await closed;
			expect(socket.destroyed).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});
	it("bounds idle connections before any request is dispatched", async () => {
		const handler = vi.fn(async () => null);
		const broker = await startAgentBroker(await directory(), handler);
		cleanup.push(broker.close);
		const clients = Array.from({ length: 17 }, () => net.createConnection(broker.socketPath));
		for (const client of clients) client.on("error", () => undefined);
		try {
			await vi.waitFor(() => expect(clients.filter((client) => client.destroyed)).toHaveLength(1));
			expect(handler).not.toHaveBeenCalled();
		} finally {
			for (const client of clients) client.destroy();
		}
	});

	it("limits handlers independently of connections and marks uncertain handler failures", async () => {
		let release: () => void = () => undefined;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const handler = vi.fn(async () => {
			await held;
			throw new Error("Commit outcome unknown");
		});
		const broker = await startAgentBroker(await directory(), handler);
		cleanup.push(broker.close);
		const request = (request_id: string) =>
			requestAgentBroker(broker.socketPath, {
				api_version: "1.0",
				request_id,
				command: "apply",
				input: {},
			});
		const running = Array.from({ length: 4 }, (_, index) => request(String(index)));
		await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(4));
		expect(await request("overflow")).toMatchObject({ status: "failed", request_id: "overflow" });
		expect(handler).toHaveBeenCalledTimes(4);
		release();
		for (const result of await Promise.all(running))
			expect(result).toMatchObject({ status: "unknown", error: { recovery_required: true } });
	});
});
