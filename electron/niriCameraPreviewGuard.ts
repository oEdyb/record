import { execFile } from "node:child_process";
import { createConnection } from "node:net";
import { ownedCameraPreviewId, previewOutsideCapture } from "./niriCameraPreviewPolicy";

type Snapshot = {
	casts: unknown;
	outputs: unknown;
	workspaces: unknown;
	windows: unknown;
};
type Watch = { ready: Promise<void>; close(): void };
type Dependencies = {
	query(command: keyof Snapshot): Promise<unknown>;
	watch(changed: (event: unknown) => void, failed: () => void): Watch;
};

function query(command: keyof Snapshot): Promise<unknown> {
	return new Promise((resolve, reject) => {
		execFile(
			"niri",
			["msg", "-j", command],
			{ timeout: 1000, maxBuffer: 1_048_576 },
			(error, stdout) => {
				if (error) return reject(error);
				try {
					resolve(JSON.parse(stdout));
				} catch (failure) {
					reject(failure);
				}
			},
		);
	});
}

function watch(changed: (event: unknown) => void, failed: () => void): Watch {
	const socket = createConnection(process.env.NIRI_SOCKET ?? "");
	let closed = false;
	let subscribed = false;
	let buffer = "";
	let rejectReady: (error: Error) => void = () => undefined;
	const ready = new Promise<void>((resolve, reject) => {
		rejectReady = reject;
		socket.once("connect", () => socket.write('"EventStream"\n'));
		socket.on("data", (data: Buffer) => {
			buffer += data.toString();
			if (buffer.length > 1_048_576) return socket.destroy(new Error("Niri event buffer exceeded"));
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				try {
					const event: unknown = JSON.parse(line);
					if (!subscribed) {
						if (!event || typeof event !== "object" || !("Ok" in event) || event.Ok !== "Handled")
							throw new Error("Niri event subscription was rejected");
						subscribed = true;
						resolve();
					} else changed(event);
				} catch {
					socket.destroy(new Error("Invalid Niri preview event"));
					return;
				}
			}
		});
	});
	const timer = setTimeout(() => socket.destroy(new Error("Niri subscription timed out")), 1000);
	const fail = () => {
		clearTimeout(timer);
		if (closed) return;
		closed = true;
		rejectReady(new Error("Niri preview monitoring ended"));
		failed();
	};
	socket.on("error", fail);
	socket.on("close", fail);
	void ready.then(
		() => clearTimeout(timer),
		() => clearTimeout(timer),
	);
	return {
		ready,
		close() {
			closed = true;
			clearTimeout(timer);
			rejectReady(new Error("Niri preview monitoring cancelled"));
			socket.destroy();
		},
	};
}

function concernsPreview(event: unknown, previewId: number, pid: number): boolean {
	if (!event || typeof event !== "object") return true;
	if ("WindowClosed" in event) {
		const value = event.WindowClosed;
		return !value || typeof value !== "object" || !("id" in value) || value.id === previewId;
	}
	if ("WindowOpenedOrChanged" in event) {
		const value = event.WindowOpenedOrChanged;
		if (!value || typeof value !== "object" || !("window" in value)) return true;
		const window = value.window;
		if (!window || typeof window !== "object" || !("id" in window)) return true;
		return (
			window.id === previewId ||
			("pid" in window &&
				window.pid === pid &&
				"title" in window &&
				window.title === "Klippt Camera")
		);
	}
	if ("WindowLayoutsChanged" in event) {
		const value = event.WindowLayoutsChanged;
		if (
			!value ||
			typeof value !== "object" ||
			!("changes" in value) ||
			!Array.isArray(value.changes)
		)
			return true;
		return value.changes.some((change) => !Array.isArray(change) || change[0] === previewId);
	}
	return Object.keys(event).some((key) =>
		[
			"WindowsChanged",
			"WindowOpenedOrChanged",
			"WindowClosed",
			"WorkspacesChanged",
			"WorkspaceActivated",
			"CastsChanged",
			"CastStartedOrChanged",
			"CastStopped",
			"ConfigLoaded",
			"OverviewOpenedOrClosed",
		].includes(key),
	);
}

export class NiriCameraPreviewGuard {
	private generation = 0;
	private revision = 0;
	private previewId: number | null = null;
	private admitted = false;
	private monitor: Watch | null = null;

	constructor(
		private readonly onUnsafe: () => void,
		private readonly dependencies: Dependencies = { query, watch },
		private readonly pid = process.pid,
	) {}

	async begin(pipeWireNodeId: number | undefined): Promise<boolean> {
		this.end();
		if (!process.env.NIRI_SOCKET || pipeWireNodeId === undefined) return false;
		const generation = this.generation;
		let failed = false;
		try {
			this.monitor = this.dependencies.watch(
				(event) => {
					if (generation !== this.generation) return;
					if (this.previewId === null || concernsPreview(event, this.previewId, this.pid)) {
						this.revision += 1;
						this.invalidate();
					}
				},
				() => {
					failed = true;
					if (generation === this.generation) this.invalidate();
				},
			);
			await this.monitor.ready;
			for (let attempt = 0; attempt < 3; attempt += 1) {
				const revision = this.revision;
				const [casts, outputs, workspaces, windows] = await Promise.all([
					this.dependencies.query("casts"),
					this.dependencies.query("outputs"),
					this.dependencies.query("workspaces"),
					this.dependencies.query("windows"),
				]);
				if (generation !== this.generation || failed) return false;
				if (revision !== this.revision) continue;
				this.previewId = ownedCameraPreviewId(windows, this.pid);
				this.admitted = previewOutsideCapture({
					pid: this.pid,
					pipeWireNodeId,
					casts,
					outputs,
					workspaces,
					windows,
				});
				return this.admitted;
			}
		} catch (error) {
			if (generation === this.generation)
				console.warn("[capture-linux] preview isolation unavailable:", error);
		}
		return false;
	}

	invalidate(): void {
		if (!this.admitted) return;
		this.admitted = false;
		this.monitor?.close();
		this.monitor = null;
		this.onUnsafe();
	}

	end(): void {
		this.generation += 1;
		this.admitted = false;
		this.previewId = null;
		this.monitor?.close();
		this.monitor = null;
	}
}
