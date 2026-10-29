import { mkdtemp, stat } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BrowserWindow } from "electron";
import { afterEach, describe, expect, it } from "vitest";
import { AgentServer } from "./agentServer";

function fakeWindow(server: () => AgentServer, answer: (method: string) => unknown) {
	return {
		isDestroyed: () => false,
		isVisible: () => true,
		isFocused: () => true,
		getTitle: () => "Klippt",
		getBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
		webContents: {
			getURL: () => "klippt://app/index.html?windowType=editor",
			// The renderer answers over ipc "agent-reply"; here it answers straight back.
			send: (_channel: string, request: { id: string; method: string }) =>
				queueMicrotask(() =>
					server().receiveReply({ id: request.id, result: answer(request.method) }),
				),
		},
	} as unknown as BrowserWindow;
}

function ask(socketPath: string, method: string, params: Record<string, unknown> = {}) {
	return new Promise<{ result?: unknown; error?: string }>((resolve, reject) => {
		const socket = net.createConnection(socketPath);
		let buffer = "";
		socket.setEncoding("utf8");
		socket.on("connect", () => socket.write(`${JSON.stringify({ id: 7, method, params })}\n`));
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			if (!buffer.includes("\n")) return;
			socket.end();
			resolve(JSON.parse(buffer.slice(0, buffer.indexOf("\n"))));
		});
		socket.on("error", reject);
	});
}

let running: AgentServer | null = null;
afterEach(() => {
	running?.stop();
	running = null;
});

async function start(review: boolean) {
	const dir = await mkdtemp(path.join(tmpdir(), "klippt-agent-test-"));
	const socketPath = path.join(dir, "agent.sock");
	const server: AgentServer = new AgentServer({
		socketPath,
		outDir: dir,
		windows: () => (review ? [window] : []),
		reviewWindow: () => (review ? window : null),
		ffmpegPath: () => null,
		transcriber: null,
		version: "1.2.3",
	});
	const window = fakeWindow(
		() => server,
		(method) => ({ answered: method }),
	);
	await server.start();
	running = server;
	return socketPath;
}

describe("AgentServer", () => {
	it("opens a socket only its owner can use", async () => {
		const socketPath = await start(true);
		expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
	});

	it("answers ping in the main process", async () => {
		const socketPath = await start(false);
		const reply = await ask(socketPath, "ping");
		expect(reply.result).toMatchObject({ app: "Klippt", version: "1.2.3" });
	});

	it("forwards review methods to the review window and relays its answer", async () => {
		const socketPath = await start(true);
		const reply = await ask(socketPath, "cuts", { unsure: true });
		expect(reply.result).toEqual({ answered: "cuts" });
	});

	it("says so when a review method has no review window", async () => {
		const socketPath = await start(false);
		const reply = await ask(socketPath, "cuts");
		expect(reply.error).toMatch(/needs the review window/);
	});

	it("starts again on the same path after a stop", async () => {
		const socketPath = await start(true);
		running?.stop();
		const second = new AgentServer({
			socketPath,
			outDir: path.dirname(socketPath),
			windows: () => [],
			reviewWindow: () => null,
			ffmpegPath: () => null,
			transcriber: null,
			version: "2",
		});
		await second.start();
		running = second;
		expect((await ask(socketPath, "ping")).result).toMatchObject({ version: "2" });
	});
});
