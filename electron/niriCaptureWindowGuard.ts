import { execFile } from "node:child_process";
import { createConnection } from "node:net";
import {
	readCaptureWindowSnapshot,
	updateCaptureWindowSnapshot,
	windowOutsideCapture,
} from "./niriCaptureWindowPolicy";

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

export class NiriCaptureWindowGuard {
	private generation = 0;
	private admitted = false;
	private revoked = false;
	private snapshot: ReturnType<typeof readCaptureWindowSnapshot> = null;
	private monitor: Watch | null = null;

	constructor(
		private readonly windowTitle: "Klippt" | "Klippt Camera",
		private readonly onUnsafe: () => void,
		private readonly dependencies: Dependencies = { query, watch },
		private readonly pid = process.pid,
	) {}

	async begin(pipeWireNodeId: number | undefined): Promise<boolean> {
		this.end();
		if (!process.env.NIRI_SOCKET || pipeWireNodeId === undefined) return false;
		const generation = this.generation;
		this.snapshot = {
			pid: this.pid,
			pipeWireNodeId,
			windowTitle: this.windowTitle,
			casts: [],
			windows: [],
			workspaces: [],
			outputs: {},
		};
		const initial = new Set<string>();
		let complete: () => void = () => undefined;
		const initialized = new Promise<void>((resolve) => {
			complete = resolve;
		});
		const deadline = setTimeout(() => {
			this.invalidateGeneration(generation);
			complete();
		}, 1000);
		try {
			this.monitor = this.dependencies.watch(
				(event) => {
					if (generation !== this.generation || this.revoked) return;
					if (this.initialConfig(event, initial)) {
						initial.add("ConfigLoaded");
					} else {
						this.snapshot = updateCaptureWindowSnapshot(this.snapshot, event);
						if (!this.snapshot || (this.admitted && !windowOutsideCapture(this.snapshot))) {
							this.invalidate();
							complete();
							return;
						}
					}
					for (const key of [
						"WindowsChanged",
						"WorkspacesChanged",
						"CastsChanged",
						"OverviewOpenedOrClosed",
					]) {
						if (event && typeof event === "object" && key in event) initial.add(key);
					}
					if (initial.size === 5) complete();
				},
				() => {
					this.invalidateGeneration(generation);
					complete();
				},
			);
			const [, outputs] = await Promise.all([
				this.monitor.ready,
				this.dependencies.query("outputs"),
				initialized,
			]);
			if (generation !== this.generation || this.revoked) return false;
			this.snapshot = readCaptureWindowSnapshot({ ...this.snapshot, outputs });
			this.admitted = windowOutsideCapture(this.snapshot);
			return this.admitted;
		} catch (error) {
			if (generation === this.generation)
				console.warn("[capture-linux] window isolation unavailable:", error);
			return false;
		} finally {
			clearTimeout(deadline);
			if (generation === this.generation && !this.admitted) {
				this.monitor?.close();
				this.monitor = null;
			}
		}
	}

	private initialConfig(event: unknown, initial: Set<string>): boolean {
		if (this.admitted || initial.has("ConfigLoaded") || !event || typeof event !== "object")
			return false;
		if (!("ConfigLoaded" in event) || Object.keys(event).length !== 1) return false;
		const config = event.ConfigLoaded;
		return Boolean(
			config && typeof config === "object" && "failed" in config && config.failed === false,
		);
	}

	private invalidateGeneration(generation: number): void {
		if (generation === this.generation) this.invalidate();
	}

	invalidate(): void {
		this.revoked = true;
		if (!this.admitted) return;
		this.admitted = false;
		this.monitor?.close();
		this.monitor = null;
		this.onUnsafe();
	}

	end(): void {
		this.generation += 1;
		this.admitted = false;
		this.revoked = false;
		this.snapshot = null;
		this.monitor?.close();
		this.monitor = null;
	}
}
