import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, unlink, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import type { BrowserWindow } from "electron";
import { recordRequestTrace } from "../studio/recordRequestTrace";
import { type CutAudioRequest, renderCutAudio } from "./cutAudio";
import { clickScript, controlsScript, typeScript } from "./uiScripts";

/**
 * Lets a local agent drive the running app: one JSON request per line on a Unix socket that
 * only this user can open, one JSON reply per line. Window-level methods (screenshots, the
 * visible controls, clicks, keys) run here on any window and never touch the host pointer or
 * keyboard. Everything else is a review-window method, forwarded to the renderer
 * (src/lib/agent/useAgentControl.ts), which calls the same store actions as its buttons.
 */

export interface AgentRequest {
	id?: string | number;
	method: string;
	params?: Record<string, unknown>;
}

export interface AgentServerDeps {
	socketPath: string;
	/** Screenshots and cut audio go here. */
	outDir: string;
	windows: () => BrowserWindow[];
	/** The recording review window, when one is open. */
	reviewWindow: () => BrowserWindow | null;
	ffmpegPath: () => string | null;
	transcriber: CutAudioRequest["transcriber"];
	/** Opens the Studio, as the pill's Studio button does. */
	openStudio?: () => void;
	/** The Studio's snapshot, or null when there is no Studio. */
	studioState?: () => unknown;
	/** Runs a Studio command; false when the command is not one the Studio knows. */
	studioCommand?: (
		command: unknown,
	) => boolean | Promise<import("../studio/types").StudioRecordResult>;
	version: string;
}

const RENDERER_TIMEOUT_MS = 30_000;

export class AgentServer {
	private server: net.Server | null = null;
	private readonly pending = new Map<
		string,
		{ resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
	>();

	constructor(private readonly deps: AgentServerDeps) {}

	async start() {
		await mkdir(path.dirname(this.deps.socketPath), { recursive: true, mode: 0o700 });
		// A socket left by a crashed run would make listen() fail with EADDRINUSE. Only a
		// socket is removed; any other file at that path is left alone and listen() fails.
		const existing = await lstat(this.deps.socketPath).catch(() => null);
		if (existing?.isSocket()) await unlink(this.deps.socketPath);
		const server = net.createServer((socket) => this.serve(socket));
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(this.deps.socketPath, () => resolve());
		});
		await chmod(this.deps.socketPath, 0o600);
		this.server = server;
	}

	stop() {
		this.server?.close();
		this.server = null;
		for (const [id, request] of this.pending) {
			clearTimeout(request.timer);
			request.reject(new Error("Klippt is quitting."));
			this.pending.delete(id);
		}
	}

	/** The renderer's answer to a forwarded request (ipc "agent-reply"). */
	receiveReply(reply: { id?: unknown; result?: unknown; error?: unknown }) {
		if (typeof reply.id !== "string") return;
		const request = this.pending.get(reply.id);
		if (!request) return;
		this.pending.delete(reply.id);
		clearTimeout(request.timer);
		if (typeof reply.error === "string") request.reject(new Error(reply.error));
		else request.resolve(reply.result ?? null);
	}

	private serve(socket: net.Socket) {
		let buffer = "";
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			let newline = buffer.indexOf("\n");
			while (newline !== -1) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				if (line) void this.answer(socket, line);
				newline = buffer.indexOf("\n");
			}
		});
		socket.on("error", () => undefined);
	}

	private async answer(socket: net.Socket, line: string) {
		let request: AgentRequest;
		try {
			request = JSON.parse(line) as AgentRequest;
		} catch {
			socket.write(`${JSON.stringify({ error: "Request is not JSON." })}\n`);
			return;
		}
		try {
			const result = await this.handle(request.method, request.params ?? {});
			if (!socket.destroyed) socket.write(`${JSON.stringify({ id: request.id, result })}\n`);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!socket.destroyed)
				socket.write(`${JSON.stringify({ id: request.id, error: message })}\n`);
		}
	}

	async handle(method: string, params: Record<string, unknown>): Promise<unknown> {
		switch (method) {
			case "ping":
				return { app: "Klippt", version: this.deps.version, pid: process.pid };
			case "windows":
				return this.deps.windows().map((window, index) => ({
					index,
					title: window.getTitle(),
					kind: windowKind(window),
					visible: window.isVisible(),
					focused: window.isFocused(),
					bounds: window.getBounds(),
				}));
			case "studio.open":
				if (!this.deps.openStudio) throw new Error("This build has no Studio.");
				this.deps.openStudio();
				return { opened: true };
			case "studio.record-trace":
				return recordRequestTrace.read();
			case "studio.state":
				if (!this.deps.studioState) throw new Error("This build has no Studio.");
				return this.deps.studioState();
			case "studio.command": {
				if (!this.deps.studioCommand) throw new Error("This build has no Studio.");
				const outcome = await this.deps.studioCommand(params.command);
				if (!outcome)
					throw new Error(
						"Unknown Studio command. Try record, pause, resume, stop, remove-last, undo-remove, toggle-mic, toggle-camera, toggle-system-audio, finish.",
					);
				if (typeof outcome === "object") {
					if (!outcome.success) throw new Error(outcome.error);
					return outcome;
				}
				return { sent: params.command };
			}
			case "screenshot": {
				const window = this.pick(params.window);
				const image = await window.webContents.capturePage();
				await mkdir(this.deps.outDir, { recursive: true });
				const file = path.join(this.deps.outDir, `screenshot-${Date.now()}.png`);
				await writeFile(file, image.toPNG());
				const size = image.getSize();
				return { path: file, width: size.width, height: size.height };
			}
			case "ui.controls":
				return this.runInPage(params.window, controlsScript());
			case "ui.click":
				return this.runInPage(
					params.window,
					clickScript(String(params.label ?? ""), Number(params.nth ?? 0)),
				);
			case "ui.type":
				return this.runInPage(
					params.window,
					typeScript(String(params.label ?? ""), String(params.text ?? "")),
				);
			case "ui.drag":
				return this.drag(params);
			case "ui.key": {
				// Delivered to this window's page only; the host keyboard never sees it.
				const window = this.pick(params.window);
				const keyCode = String(params.key ?? "");
				if (!keyCode) throw new Error("ui.key needs a key, e.g. Space, Left, z.");
				const modifiers = Array.isArray(params.modifiers)
					? (params.modifiers.map(String) as Electron.KeyboardInputEvent["modifiers"])
					: [];
				for (const type of ["keyDown", "char", "keyUp"] as const) {
					if (type === "char" && keyCode.length !== 1) continue;
					window.webContents.sendInputEvent({ type, keyCode, modifiers });
				}
				return { sent: keyCode, modifiers };
			}
			case "cut.audio": {
				const source = (await this.forward("cut.source", params)) as CutAudioRequest["source"];
				const ffmpeg = this.deps.ffmpegPath();
				if (!ffmpeg) throw new Error("Bundled FFmpeg is unavailable.");
				return renderCutAudio({
					ffmpeg,
					source,
					padSec: Number(params.padSec ?? 2),
					outDir: path.join(this.deps.outDir, "cuts"),
					transcriber: params.transcribe === false ? null : this.deps.transcriber,
				});
			}
			default:
				return this.forward(method, params);
		}
	}

	private async runInPage(selector: unknown, script: string): Promise<unknown> {
		const result = (await this.pick(selector).webContents.executeJavaScript(script)) as unknown;
		if (result && typeof result === "object" && "error" in result)
			throw new Error(String((result as { error: unknown }).error));
		return result;
	}

	/** A held left-button drag through Chromium's input path; the real pointer never moves. */
	private async drag(params: Record<string, unknown>) {
		const [fromX, fromY, toX, toY] = [params.fromX, params.fromY, params.toX, params.toY].map(
			Number,
		);
		if (![fromX, fromY, toX, toY].every(Number.isFinite)) {
			throw new Error("ui.drag needs fromX, fromY, toX and toY in window coordinates.");
		}
		const contents = this.pick(params.window).webContents;
		const steps = Math.max(1, Math.min(120, Math.round(Number(params.steps ?? 20)) || 20));
		const at = (x: number, y: number) => ({ x: Math.round(x), y: Math.round(y) });
		contents.sendInputEvent({ type: "mouseMove", ...at(fromX, fromY) });
		contents.sendInputEvent({
			type: "mouseDown",
			button: "left",
			clickCount: 1,
			...at(fromX, fromY),
		});
		for (let step = 1; step <= steps; step += 1) {
			await new Promise((resolve) => setTimeout(resolve, 16));
			contents.sendInputEvent({
				type: "mouseMove",
				button: "left",
				modifiers: ["leftbuttondown"],
				...at(fromX + ((toX - fromX) * step) / steps, fromY + ((toY - fromY) * step) / steps),
			});
		}
		contents.sendInputEvent({
			type: "mouseUp",
			button: "left",
			clickCount: 1,
			...at(toX, toY),
		});
		return { dragged: { fromX, fromY, toX, toY }, steps };
	}

	private pick(selector: unknown): BrowserWindow {
		const windows = this.deps.windows();
		if (selector === undefined || selector === "review") {
			const review = this.deps.reviewWindow();
			if (review && !review.isDestroyed()) return review;
			if (selector === "review") throw new Error("No review window is open.");
			const visible =
				windows.find((window) => window.isFocused()) ?? windows.find((w) => w.isVisible());
			if (visible) return visible;
			throw new Error("No Klippt window is open.");
		}
		const byIndex = typeof selector === "number" ? windows[selector] : undefined;
		const found =
			byIndex ??
			windows.find(
				(window) => windowKind(window) === selector || window.getTitle() === String(selector),
			);
		if (!found || found.isDestroyed()) throw new Error(`No window matches ${String(selector)}.`);
		return found;
	}

	private forward(method: string, params: Record<string, unknown>): Promise<unknown> {
		const window = this.deps.reviewWindow();
		if (!window || window.isDestroyed())
			return Promise.reject(new Error(`"${method}" needs the review window, and none is open.`));
		const id = randomUUID();
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`The review window did not answer "${method}".`));
			}, RENDERER_TIMEOUT_MS);
			this.pending.set(id, { resolve, reject, timer });
			window.webContents.send("agent-request", { id, method, params });
		});
	}
}

/** The `windowType` query the app opens each window with, e.g. "editor", "hud-overlay". */
function windowKind(window: BrowserWindow): string | null {
	try {
		const url = new URL(window.webContents.getURL());
		return url.searchParams.get("windowType");
	} catch {
		return null;
	}
}
