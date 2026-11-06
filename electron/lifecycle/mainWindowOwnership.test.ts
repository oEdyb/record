import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQuitCaptureGuard } from "../recording/quitCaptureGuard";
import { EditorCloseLifecycle } from "./editorCloseLifecycle";
import { RendererRecoveryLifecycle } from "./rendererRecoveryLifecycle";
import { ReviewHandoffLifecycle } from "./reviewHandoffLifecycle";
import { WorkspaceLifecycle } from "./workspaceLifecycle";

const mainPath = new URL("../main.ts", import.meta.url);
const currentSource = readFileSync(mainPath, "utf8");

class TestWindow extends EventEmitter {
	static sequence = 0;
	readonly id = ++TestWindow.sequence;
	destroyed = false;
	visible = true;
	maximized = false;
	fullscreen = false;
	bounds = { x: 0, y: 0, width: 800, height: 600 };
	readonly webContents = Object.assign(new EventEmitter(), {
		id: this.id,
		send: vi.fn(),
		setBackgroundThrottling: vi.fn(),
		getURL: () => `file:///index.html?windowType=${this.kind}`,
	});
	constructor(readonly kind: "editor" | "hud-overlay" = "editor") {
		super();
	}
	isDestroyed = () => this.destroyed;
	isVisible = () => this.visible;
	isFullScreen = () => this.fullscreen;
	isMaximized = () => this.maximized;
	isMinimized = () => false;
	getBounds = () => this.bounds;
	setBounds = vi.fn((bounds: TestWindow["bounds"]) => {
		this.bounds = bounds;
	});
	setMinimumSize = vi.fn();
	restore = vi.fn();
	unmaximize = () => {
		this.maximized = false;
	};
	maximize = () => {
		this.maximized = true;
		this.emit("maximize");
	};
	show = vi.fn(() => {
		this.visible = true;
	});
	hide = vi.fn(() => {
		this.visible = false;
	});
	focus = vi.fn();
	close = vi.fn(() => {
		const event = { preventDefault: vi.fn() };
		this.emit("close", event);
		if (!event.preventDefault.mock.calls.length) this.destroy();
		return event;
	});
	destroy() {
		if (this.destroyed) return;
		this.destroyed = true;
		this.visible = false;
		this.emit("closed");
	}
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

type HarnessApi = {
	adoptEditorWindow: (window: TestWindow, compact: boolean) => void;
	setMain: (window: TestWindow) => void;
	getMain: () => TestWindow | null;
	getEditor: () => TestWindow | null;
	createEditorWindowWrapper: (options?: {
		compactReview?: boolean;
		bounds?: TestWindow["bounds"];
	}) => void;
	switchToHudWrapper: () => void;
	scheduleReviewPrewarm: (recording: boolean) => void;
	setRecording: (recording: boolean) => void;
	openReview: (bounds: TestWindow["bounds"], ready: () => void) => void;
	cancelReview: () => void;
};

function harness(source = currentSource) {
	const windows: TestWindow[] = [];
	const ipc = new EventEmitter();
	const handles = new Map<string, (...args: unknown[]) => unknown>();
	const app = new EventEmitter();
	const stop = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
	const quit = vi.fn();
	const guard = createQuitCaptureGuard({
		isCaptureRunning: () => false,
		stopCapture: async () => undefined,
		quit,
	});
	const names = new Set([
		"workspace",
		"editorClose",
		"reviewTransfer",
		"rendererRecovery",
		"mainWindow",
		"editorWindow",
		"readyEditorWindows",
		"editorHasUnsavedChanges",
		"isForceClosing",
		"isCloseConfirmInFlight",
		"workspaceTransition",
		"compactReviewWindows",
		"reviewsInStudioFrame",
		"reviewHandoffSequence",
		"reviewHandoff",
		"reviewPrewarmTimer",
		"isRecording",
	]);
	const functions = new Set([
		"adoptMainWindow",
		"adoptEditorWindow",
		"forceCloseEditorWindow",
		"compactReviewBoundsNear",
		"revealStudioReview",
		"setReviewWindowCompact",
		"createEditorWindowWrapper",
		"prewarmReviewWindow",
		"scheduleReviewPrewarm",
	]);
	const channels = new Set([
		"set-has-unsaved-changes",
		"close-confirm-response",
		"save-before-close-done",
		"review-handoff-token",
		"review-ready",
		"fit-review-window",
		"is-review-window-compact",
	]);
	const parsed = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);
	const snippets: string[] = [];
	for (const statement of parsed.statements) {
		if (
			ts.isVariableStatement(statement) &&
			statement.declarationList.declarations.some(
				(declaration) => ts.isIdentifier(declaration.name) && names.has(declaration.name.text),
			)
		)
			snippets.push(statement.getText(parsed));
		if (ts.isFunctionDeclaration(statement) && statement.name && functions.has(statement.name.text))
			snippets.push(statement.getText(parsed));
		if (ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression)) {
			const call = statement.expression;
			if (
				ts.isPropertyAccessExpression(call.expression) &&
				call.expression.expression.getText(parsed) === "ipcMain" &&
				call.arguments[0] &&
				ts.isStringLiteral(call.arguments[0]) &&
				channels.has(call.arguments[0].text)
			)
				snippets.push(statement.getText(parsed));
		}
	}
	let reviewActions = "";
	function nested(node: ts.Node) {
		if (ts.isFunctionDeclaration(node) && node.name?.text === "switchToHudWrapper")
			snippets.push(node.getText(parsed));
		if (
			ts.isCallExpression(node) &&
			ts.isPropertyAccessExpression(node.expression) &&
			node.expression.getText(parsed) === "app.on" &&
			node.arguments[0] &&
			ts.isStringLiteral(node.arguments[0]) &&
			node.arguments[0].text === "render-process-gone"
		)
			snippets.push(`${node.getText(parsed)};`);
		if (ts.isNewExpression(node) && node.expression.getText(parsed) === "StudioController") {
			const options = node.arguments?.[0];
			if (options && ts.isObjectLiteralExpression(options)) {
				reviewActions = options.properties
					.filter(
						(property) =>
							property.name &&
							["openReview", "cancelReview"].includes(property.name.getText(parsed)),
					)
					.map((property) => property.getText(parsed))
					.join(",\n");
			}
		}
		ts.forEachChild(node, nested);
	}

	// Execute the original main.ts functions and handlers, with only Electron effects replaced.
	nested(parsed);
	expect(reviewActions).toContain("openReview");
	const explicit = source.includes("const workspace = new WorkspaceLifecycle");
	snippets.push(`const reviewActions = { ${reviewActions} }; globalThis.result = {
		adoptEditorWindow, createEditorWindowWrapper, switchToHudWrapper, scheduleReviewPrewarm,
		setRecording: (recording) => { isRecording = recording; scheduleReviewPrewarm(recording); },
		setMain: (window) => { ${explicit ? "adoptMainWindow(window)" : "mainWindow = window"}; },
		getMain: () => ${explicit ? "workspace.mainWindow" : "mainWindow"},
		getEditor: () => ${explicit ? "workspace.editorWindow" : "editorWindow"},
		...reviewActions
	};`);
	const create = (kind: TestWindow["kind"], hidden = false) => {
		const window = new TestWindow(kind);
		window.visible = !hidden;
		windows.push(window);
		return window;
	};
	const workArea = { x: 0, y: 0, width: 1920, height: 1080 };
	const context = vm.createContext({
		WorkspaceLifecycle,
		EditorCloseLifecycle,
		ReviewHandoffLifecycle,
		RendererRecoveryLifecycle,
		console,
		setTimeout,
		clearTimeout,
		setImmediate: (callback: () => void) => setImmediate(callback),
		Promise,
		Symbol,
		process: { platform: "linux" },
		app,
		ipcMain: Object.assign(ipc, {
			handle: (channel: string, listener: (...args: unknown[]) => unknown) =>
				handles.set(channel, listener),
		}),
		BrowserWindow: {
			fromWebContents: (contents: TestWindow["webContents"]) =>
				windows.find((window) => window.webContents === contents) ?? null,
		},
		createEditorWindow: (_query: unknown, options: { hidden?: boolean }) =>
			create("editor", options.hidden),
		createHudOverlayWindow: (options: { hidden?: boolean } = {}) =>
			create("hud-overlay", options.hidden),
		createCameraPreviewWindow: vi.fn(),
		closeWithoutAnimation: (window: TestWindow) => window.close(),
		getSelectedSourceAspectRatio: () => 16 / 9,
		fitCompactReviewBounds: () => ({ x: 500, y: 300, width: 600, height: 400 }),
		COMPACT_REVIEW_MIN_SIZE: { width: 300, height: 200 },
		screen: { getDisplayMatching: () => ({ workArea }), getPrimaryDisplay: () => ({ workArea }) },
		studio: null,
		isMac: false,
		quitCaptureGuard: guard,
		stopTakeWithoutPill: stop,
	});
	const compiled = ts.transpileModule(snippets.join("\n"), {
		compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
	}).outputText;
	vm.runInContext(compiled, context, { filename: "row12-main-extracted.js" });
	const api = context.result as HarnessApi;
	return {
		...api,
		windows,
		app,
		stop,
		ipc,
		create,
		emit: (channel: string, window: TestWindow, payload: unknown) =>
			ipc.emit(channel, { sender: window.webContents }, payload),
		invoke: (channel: string, window: TestWindow, payload?: unknown) =>
			handles.get(channel)?.({ sender: window.webContents }, payload),
	};
}

function editor(h: ReturnType<typeof harness>) {
	const window = h.create("editor");
	h.adoptEditorWindow(window, true);
	h.setMain(window);
	return window;
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
	vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("row12 independent main.ts close IPC interrogation", () => {
	it("continues blocking close while confirmation and saving are pending", async () => {
		const h = harness();
		const window = editor(h);
		h.emit("set-has-unsaved-changes", window, true);
		expect(window.close().preventDefault).toHaveBeenCalledOnce();
		expect(window.close().preventDefault).toHaveBeenCalledOnce();
		h.emit("close-confirm-response", window, "save");
		expect(window.close().preventDefault).toHaveBeenCalledOnce();
		expect(window.destroyed).toBe(false);
		h.emit("save-before-close-done", window, true);
		await vi.advanceTimersByTimeAsync(1);
		expect(window.destroyed).toBe(true);
	});

	it("wrong-window and malformed responses do not consume the valid response", async () => {
		const h = harness();
		const window = editor(h);
		const wrong = h.create("hud-overlay");
		h.emit("set-has-unsaved-changes", window, true);
		window.close();
		h.emit("close-confirm-response", wrong, "discard");
		h.emit("close-confirm-response", window, "bogus");
		h.emit("close-confirm-response", window, "save");
		expect(window.webContents.send).toHaveBeenCalledWith("request-save-before-close");
		h.emit("save-before-close-done", wrong, true);
		h.emit("save-before-close-done", window, "yes");
		expect(window.destroyed).toBe(false);
		h.emit("save-before-close-done", window, true);
		await vi.advanceTimersByTimeAsync(1);
		expect(window.destroyed).toBe(true);
		expect(wrong.destroyed).toBe(false);
		expect(h.ipc.listenerCount("close-confirm-response")).toBe(1);
		expect(h.ipc.listenerCount("save-before-close-done")).toBe(1);
	});

	it("unsolicited save completion cannot close a dirty or confirming window", async () => {
		const h = harness();
		const window = editor(h);
		h.emit("set-has-unsaved-changes", window, true);
		h.emit("save-before-close-done", window, true);
		window.close();
		h.emit("save-before-close-done", window, true);
		await vi.advanceTimersByTimeAsync(1);
		expect(window.destroyed).toBe(false);
		h.emit("close-confirm-response", window, "cancel");
		expect(window.close().preventDefault).toHaveBeenCalledOnce();
	});

	it("failed save and cancelled confirmation retain unsaved work for the next close", async () => {
		const h = harness();
		const window = editor(h);
		h.emit("set-has-unsaved-changes", window, true);
		window.close();
		h.emit("close-confirm-response", window, "save");
		h.emit("save-before-close-done", window, false);
		expect(window.close().preventDefault).toHaveBeenCalledOnce();
		h.emit("close-confirm-response", window, "cancel");
		expect(window.close().preventDefault).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(1);
		expect(window.destroyed).toBe(false);
	});

	it("independent confirmations and discard close only the responding window", async () => {
		const h = harness();
		const first = editor(h);
		h.emit("set-has-unsaved-changes", first, true);
		first.close();
		const second = editor(h);
		h.emit("set-has-unsaved-changes", second, true);
		second.close();
		h.emit("close-confirm-response", second, "discard");
		await vi.advanceTimersByTimeAsync(1);
		expect(second.destroyed).toBe(true);
		expect(first.destroyed).toBe(false);
		h.emit("close-confirm-response", first, "save");
		expect(first.webContents.send).toHaveBeenCalledWith("request-save-before-close");
		h.emit("save-before-close-done", first, true);
		await vi.advanceTimersByTimeAsync(1);
		expect(first.destroyed).toBe(true);
	});

	it("a non-editor dirty notification cannot clear the current editor's unsaved work", () => {
		const h = harness();
		const window = editor(h);
		const hud = h.create("hud-overlay");
		h.emit("set-has-unsaved-changes", window, true);
		h.emit("set-has-unsaved-changes", hud, false);
		expect(window.close().preventDefault).toHaveBeenCalledOnce();
		expect(window.destroyed).toBe(false);
	});
});

describe("row12 review handoff, layout and prewarm interrogation", () => {
	it("cancelling a handoff rejects its token and wrong window without consuming the replacement", async () => {
		const h = harness();
		const window = editor(h);
		const wrong = h.create("editor");
		const firstReady = vi.fn();
		const nextReady = vi.fn();
		h.openReview(window.bounds, firstReady);
		const first = h.invoke("review-handoff-token", window);
		h.cancelReview();
		h.openReview(window.bounds, nextReady);
		const next = h.invoke("review-handoff-token", window);
		expect(next).not.toBe(first);
		h.emit("review-ready", window, first);
		h.emit("review-ready", wrong, next);
		expect(nextReady).not.toHaveBeenCalled();
		h.emit("review-ready", window, next);
		await vi.advanceTimersByTimeAsync(2000);
		expect(nextReady).toHaveBeenCalledOnce();
		expect(firstReady).not.toHaveBeenCalled();
		expect(h.invoke("review-handoff-token", window)).toBeNull();
	});

	it("the handoff deadline reveals once when the renderer never acknowledges", async () => {
		const h = harness();
		const window = editor(h);
		const ready = vi.fn();
		h.openReview(window.bounds, ready);
		const token = h.invoke("review-handoff-token", window);
		await vi.advanceTimersByTimeAsync(1500);
		expect(ready).toHaveBeenCalledOnce();
		expect(window.show).toHaveBeenCalledOnce();
		h.emit("review-ready", window, token);
		expect(ready).toHaveBeenCalledOnce();
	});

	it("cancelled and replaced prewarm timers never create a stale editor", async () => {
		const h = harness();
		h.setMain(h.create("hud-overlay"));
		h.setRecording(true);
		await vi.advanceTimersByTimeAsync(1000);
		h.setRecording(false);
		await vi.advanceTimersByTimeAsync(2000);
		expect(h.getEditor()).toBeNull();
		h.setRecording(true);
		await vi.advanceTimersByTimeAsync(1000);
		h.scheduleReviewPrewarm(true);
		await vi.advanceTimersByTimeAsync(1000);
		expect(h.getEditor()).toBeNull();
		await vi.advanceTimersByTimeAsync(1000);
		expect(h.getEditor()?.visible).toBe(false);
		expect(h.windows.filter((window) => window.kind === "editor")).toHaveLength(1);
	});

	it("studio frame suppresses auto-fit and is released on a regular compact review", () => {
		const h = harness();
		const window = editor(h);
		h.openReview(window.bounds, vi.fn());
		expect(h.invoke("fit-review-window", window, { aspectRatio: 1 })).toBe(false);
		h.emit("review-ready", window, h.invoke("review-handoff-token", window));
		h.createEditorWindowWrapper({ compactReview: true });
		expect(h.invoke("fit-review-window", window, { aspectRatio: 1 })).toBe(true);
		window.maximize();
		expect(h.invoke("is-review-window-compact", window)).toBe(false);
	});

	it("closing a superseded editor cannot clear the current main/editor ownership", () => {
		const h = harness();
		const first = editor(h);
		const second = editor(h);
		first.destroy();
		expect(h.getMain()).toBe(second);
		expect(h.getEditor()).toBe(second);
	});

	it("repeated warm HUD/review round trips keep close listeners bounded", () => {
		const h = harness();
		const window = editor(h);
		const initial = window.listenerCount("closed");
		for (let index = 0; index < 12; index++) {
			h.switchToHudWrapper();
			const hud = h.getMain();
			hud?.emit("ready-to-show");
			h.createEditorWindowWrapper({ compactReview: true });
		}
		expect(h.getMain()).toBe(window);
		expect(window.listenerCount("closed")).toBe(initial);
	});
});

describe("row12 renderer recovery interrogation", () => {
	it("repeated crash notifications for the exact renderer coalesce before and after save", async () => {
		const h = harness();
		const hud = h.create("hud-overlay");
		h.setMain(hud);
		const saved = deferred<boolean>();
		h.stop.mockReturnValue(saved.promise);
		h.app.emit("render-process-gone", {}, hud.webContents, { reason: "crashed", exitCode: 1 });
		h.app.emit("render-process-gone", {}, hud.webContents, { reason: "crashed", exitCode: 1 });
		await vi.advanceTimersByTimeAsync(1);
		expect(h.stop).toHaveBeenCalledOnce();
		saved.resolve(false);
		await vi.advanceTimersByTimeAsync(1);
		h.app.emit("render-process-gone", {}, hud.webContents, { reason: "crashed", exitCode: 1 });
		await vi.advanceTimersByTimeAsync(1);
		expect(h.stop).toHaveBeenCalledOnce();
	});

	it("a different renderer crashing during an older renderer's save still gets recovery", async () => {
		const h = harness();
		const first = h.create("hud-overlay");
		h.setMain(first);
		const saved = deferred<boolean>();
		h.stop.mockReturnValue(saved.promise);
		h.app.emit("render-process-gone", {}, first.webContents, { reason: "crashed", exitCode: 1 });
		await vi.advanceTimersByTimeAsync(1);
		expect(h.stop).toHaveBeenCalledOnce();
		h.createEditorWindowWrapper();
		h.getMain()?.emit("ready-to-show");
		h.switchToHudWrapper();
		const second = h.getMain()!;
		second.emit("ready-to-show");
		expect(second).not.toBe(first);
		expect(second.kind).toBe("hud-overlay");
		h.app.emit("render-process-gone", {}, second.webContents, { reason: "crashed", exitCode: 1 });
		await vi.advanceTimersByTimeAsync(1);
		expect(h.stop).toHaveBeenCalledTimes(2);
		saved.resolve(false);
		await vi.advanceTimersByTimeAsync(1);
	});

	it("a different renderer crashing after an older recovery finishes gets recovery", async () => {
		const h = harness();
		const first = h.create("hud-overlay");
		h.setMain(first);
		h.stop.mockResolvedValue(false);
		h.app.emit("render-process-gone", {}, first.webContents, { reason: "crashed", exitCode: 1 });
		await vi.advanceTimersByTimeAsync(1);
		h.createEditorWindowWrapper();
		h.getMain()?.emit("ready-to-show");
		h.switchToHudWrapper();
		const second = h.getMain()!;
		second.emit("ready-to-show");
		h.app.emit("render-process-gone", {}, second.webContents, { reason: "crashed", exitCode: 1 });
		await vi.advanceTimersByTimeAsync(1);
		expect(h.stop).toHaveBeenCalledTimes(2);
	});

	it("clean exits and crashes in a non-owner never stop the take", async () => {
		const h = harness();
		const hud = h.create("hud-overlay");
		h.setMain(hud);
		h.app.emit("render-process-gone", {}, hud.webContents, { reason: "clean-exit", exitCode: 0 });
		h.app.emit("render-process-gone", {}, h.create("hud-overlay").webContents, {
			reason: "crashed",
			exitCode: 1,
		});
		await vi.advanceTimersByTimeAsync(1);
		expect(h.stop).not.toHaveBeenCalled();
	});
});

describe("row12 quit interruption interrogation", () => {
	it("a Stop-completing quit cannot bypass a pending dirty-editor confirmation", async () => {
		const h = harness();
		const window = editor(h);
		h.emit("set-has-unsaved-changes", window, true);
		window.close();
		const stopped = deferred<void>();
		let running = true;
		const stop = vi.fn(() => stopped.promise);
		const quit = vi.fn(() => {
			window.close();
		});
		const guard = createQuitCaptureGuard({
			isCaptureRunning: () => running,
			stopCapture: stop,
			quit,
		});
		guard.beforeQuit({ preventDefault: vi.fn() });
		running = false;
		stopped.resolve();
		await vi.advanceTimersByTimeAsync(1);
		expect(quit).toHaveBeenCalledOnce();
		expect(window.destroyed).toBe(false);
		guard.beforeQuit({ preventDefault: vi.fn() });
		window.close();
		expect(window.destroyed).toBe(false);
		expect(stop).toHaveBeenCalledOnce();
		h.emit("close-confirm-response", window, "save");
		window.close();
		expect(window.destroyed).toBe(false);
		h.emit("save-before-close-done", window, true);
		await vi.advanceTimersByTimeAsync(1);
		expect(window.destroyed).toBe(true);
	});

	it("a rejected Stop still attempts quit and resets after an editor cancels it", async () => {
		const stop = vi.fn<() => Promise<void>>().mockRejectedValue(new Error("writer stopped late"));
		const quit = vi.fn();
		const guard = createQuitCaptureGuard({ isCaptureRunning: () => true, stopCapture: stop, quit });
		const initial = { preventDefault: vi.fn() };
		guard.beforeQuit(initial);
		await vi.advanceTimersByTimeAsync(1);
		expect(initial.preventDefault).toHaveBeenCalledOnce();
		expect(quit).toHaveBeenCalledOnce();
		guard.beforeQuit({ preventDefault: vi.fn() });
		await vi.advanceTimersByTimeAsync(1);
		expect(stop).toHaveBeenCalledTimes(2);
	});

	it("shutdown during Stop allows closes immediately and never schedules another quit", async () => {
		const stopped = deferred<void>();
		const quit = vi.fn();
		const guard = createQuitCaptureGuard({
			isCaptureRunning: () => true,
			stopCapture: () => stopped.promise,
			quit,
		});
		guard.beforeQuit({ preventDefault: vi.fn() });
		guard.systemPoweringOff();
		const close = { preventDefault: vi.fn() };
		guard.beforeQuit(close);
		expect(close.preventDefault).not.toHaveBeenCalled();
		stopped.resolve();
		await vi.advanceTimersByTimeAsync(1);
		expect(quit).not.toHaveBeenCalled();
	});

	it("a thrown quit cannot leave future quits bypassing Stop", async () => {
		const stop = vi.fn(async () => undefined);
		const quit = vi.fn(() => {
			throw new Error("quit rejected");
		});
		const guard = createQuitCaptureGuard({ isCaptureRunning: () => true, stopCapture: stop, quit });
		guard.beforeQuit({ preventDefault: vi.fn() });
		await vi.advanceTimersByTimeAsync(1);
		const next = { preventDefault: vi.fn() };
		guard.beforeQuit(next);
		await vi.advanceTimersByTimeAsync(1);
		expect(next.preventDefault).toHaveBeenCalledOnce();
		expect(stop).toHaveBeenCalledTimes(2);
	});
});
