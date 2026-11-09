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

type CaptureSnapshot = NonNullable<ReturnType<typeof readCaptureWindowSnapshot>>;
type GuardState =
	| { kind: "idle"; generation: number }
	| {
			kind: "starting" | "safe" | "restoring" | "covered" | "failed";
			generation: number;
			snapshot: CaptureSnapshot | null;
			lastWindow: CaptureSnapshot["windows"][number] | null;
			monitor: Watch | null;
	  };
type GuardEvent =
	| { type: "end" }
	| {
			type: "start";
			snapshot: CaptureSnapshot;
			fallback?: CaptureSnapshot["windows"][number] | null;
	  }
	| { type: "watch"; generation: number; monitor: Watch }
	| { type: "update" | "ready"; generation: number; snapshot: CaptureSnapshot | null }
	| { type: "fail"; generation: number };

export class NiriCaptureWindowGuard {
	private state: GuardState = { kind: "idle", generation: 0 };
	constructor(
		private readonly windowTitle: "Klippt" | "Klippt Camera" | "Klippt Studio",
		private readonly onUnsafe: () => void,
		private readonly dependencies: Dependencies = { query, watch },
		private readonly pid = process.pid,
		private readonly onSafe: () => void = () => undefined,
	) {}

	get recoveringVisibility(): boolean {
		return this.state.kind === "covered";
	}

	async retry(): Promise<boolean> {
		const state = this.state;
		if (state.kind !== "failed") return this.isSafe;
		return this.begin(state.snapshot?.pipeWireNodeId, state.lastWindow);
	}

	get isSafe(): boolean {
		return this.state.kind === "safe" || this.state.kind === "restoring";
	}

	private transition(event: GuardEvent): void {
		const state = this.state;
		if (event.type === "end") {
			this.state = { kind: "idle", generation: state.generation + 1 };
			if (state.kind !== "idle") state.monitor?.close();
			return;
		}
		if (event.type === "start") {
			this.state = {
				kind: "starting",
				generation: state.generation,
				snapshot: event.snapshot,
				lastWindow: event.fallback ?? null,
				monitor: null,
			};
			return;
		}
		if (state.kind === "idle" || state.generation !== event.generation || state.kind === "failed") {
			if (event.type === "watch") event.monitor.close();
			return;
		}
		if (event.type === "watch") {
			this.state = { ...state, monitor: event.monitor };
			return;
		}
		if (event.type === "fail" || !event.snapshot) {
			this.state = { ...state, kind: "failed", monitor: null };
			state.monitor?.close();
			if (state.kind === "safe" || state.kind === "restoring") this.onUnsafe();
			return;
		}
		const snapshot = event.snapshot;
		const ownWindow = snapshot.windows.find(
			(window) =>
				window.pid === this.pid &&
				window.title === this.windowTitle &&
				window.app_id === "co.dyberg.klippt" &&
				window.is_floating,
		);
		const lastWindow = ownWindow ?? state.lastWindow;
		if (state.kind === "starting" && event.type !== "ready") {
			this.state = { ...state, snapshot, lastWindow };
			return;
		}
		const footprint =
			!ownWindow && state.kind !== "safe" && lastWindow
				? { ...snapshot, windows: [...snapshot.windows, lastWindow] }
				: snapshot;
		const kind = windowOutsideCapture(footprint) ? (ownWindow ? "safe" : "restoring") : "covered";
		this.state = { ...state, kind, snapshot, lastWindow };
		if ((state.kind === "safe" || state.kind === "restoring") && kind === "covered")
			this.onUnsafe();
		if (state.kind === "covered" && kind !== "covered") this.onSafe();
	}

	async begin(
		pipeWireNodeId: number | undefined,
		fallback: CaptureSnapshot["windows"][number] | null = null,
	): Promise<boolean> {
		this.end();
		if (!process.env.NIRI_SOCKET || pipeWireNodeId === undefined) return false;
		this.transition({
			type: "start",
			fallback,
			snapshot: {
				pid: this.pid,
				pipeWireNodeId,
				windowTitle: this.windowTitle,
				casts: [],
				windows: [],
				workspaces: [],
				outputs: {},
			},
		});
		const generation = this.state.generation;
		const initial = new Set<string>();
		let complete: () => void = () => undefined;
		const initialized = new Promise<void>((resolve) => {
			complete = resolve;
		});
		const deadline = setTimeout(() => {
			this.transition({ type: "fail", generation });
			complete();
		}, 1000);
		try {
			const monitor = this.dependencies.watch(
				(event) => {
					const state = this.state;
					if (state.kind === "idle" || state.kind === "failed" || state.generation !== generation)
						return;
					if (this.initialConfig(event, initial)) initial.add("ConfigLoaded");
					else
						this.transition({
							type: "update",
							generation,
							snapshot: updateCaptureWindowSnapshot(state.snapshot, event),
						});
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
					this.transition({ type: "fail", generation });
					complete();
				},
			);
			this.transition({ type: "watch", generation, monitor });
			const [, outputs] = await Promise.all([
				monitor.ready,
				this.dependencies.query("outputs"),
				initialized,
			]);
			const state = this.state;
			if (state.kind === "idle" || state.kind === "failed" || state.generation !== generation)
				return false;
			this.transition({
				type: "ready",
				generation,
				snapshot: readCaptureWindowSnapshot({ ...state.snapshot, outputs }),
			});
			return this.isSafe;
		} catch (error) {
			this.transition({ type: "fail", generation });
			console.warn("[capture-linux] window isolation unavailable:", error);
			return false;
		} finally {
			clearTimeout(deadline);
		}
	}

	private initialConfig(event: unknown, initial: Set<string>): boolean {
		if (
			this.state.kind !== "starting" ||
			initial.has("ConfigLoaded") ||
			!event ||
			typeof event !== "object"
		)
			return false;
		if (!("ConfigLoaded" in event) || Object.keys(event).length !== 1) return false;
		const config = event.ConfigLoaded;
		return Boolean(
			config && typeof config === "object" && "failed" in config && config.failed === false,
		);
	}
	invalidate(): void {
		this.transition({ type: "fail", generation: this.state.generation });
	}
	end(): void {
		this.transition({ type: "end" });
	}
}
