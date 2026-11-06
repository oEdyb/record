type Editor<W> = { kind: "absent" } | { kind: "loading" | "ready"; window: W };
type Switch<W> = { kind: "settled" } | { kind: "editor" | "hud"; window: W };
type Prewarm =
	| { kind: "idle" }
	| { kind: "scheduled"; token: symbol; timer: ReturnType<typeof setTimeout> };
type Layout = "full" | "compact" | "studio-full" | "studio-compact";
type Event<W> =
	| { type: "main"; window: W }
	| { type: "compact"; window: W; compact: boolean }
	| { type: "studio-frame"; window: W; studio: boolean }
	| { type: "editor"; window: W }
	| { type: "ready"; window: W }
	| { type: "closed"; window: W }
	| { type: "switch"; target: "editor" | "hud"; window: W }
	| { type: "settled"; window: W }
	| { type: "prewarm"; token: symbol; schedule: () => ReturnType<typeof setTimeout> }
	| { type: "prewarm-fired"; token: symbol }
	| { type: "cancel-prewarm" };
export class WorkspaceLifecycle<W extends object> {
	private value: {
		main: W | null;
		editor: Editor<W>;
		switch: Switch<W>;
		prewarm: Prewarm;
		layouts: Map<W, Layout>;
		mainOwners: WeakSet<W>;
		editorOwners: WeakSet<W>;
	} = {
		main: null,
		editor: { kind: "absent" },
		switch: { kind: "settled" },
		prewarm: { kind: "idle" },
		layouts: new Map(),
		mainOwners: new WeakSet(),
		editorOwners: new WeakSet(),
	};
	wasMain(window: W) {
		return this.value.mainOwners.has(window);
	}
	ownsEditor(window: W) {
		return this.value.editorOwners.has(window);
	}
	get mainWindow() {
		return this.value.main;
	}
	get editorWindow() {
		return this.value.editor.kind === "absent" ? null : this.value.editor.window;
	}
	get pendingSwitch() {
		const state = this.value.switch;
		return state.kind === "settled" ? null : { target: state.kind, window: state.window };
	}
	isCompact(window: W) {
		return ["compact", "studio-compact"].includes(this.value.layouts.get(window) ?? "full");
	}
	isStudioFrame(window: W) {
		return ["studio-full", "studio-compact"].includes(this.value.layouts.get(window) ?? "full");
	}
	isReady(window: W) {
		return this.value.editor.kind === "ready" && this.value.editor.window === window;
	}
	transition(event: Event<W>): boolean {
		const state = this.value;
		switch (event.type) {
			case "compact": {
				const layouts = new Map(state.layouts);
				layouts.set(
					event.window,
					this.isStudioFrame(event.window)
						? event.compact
							? "studio-compact"
							: "studio-full"
						: event.compact
							? "compact"
							: "full",
				);
				this.value = { ...state, layouts };
				return true;
			}
			case "studio-frame": {
				const layouts = new Map(state.layouts);
				layouts.set(
					event.window,
					this.isCompact(event.window)
						? event.studio
							? "studio-compact"
							: "compact"
						: event.studio
							? "studio-full"
							: "full",
				);
				this.value = { ...state, layouts };
				return true;
			}
			case "main":
				state.mainOwners.add(event.window);
				this.value = { ...state, main: event.window };
				return true;
			case "editor":
				state.editorOwners.add(event.window);
				this.value = { ...state, editor: { kind: "loading", window: event.window } };
				return true;
			case "ready":
				if (state.editor.kind !== "loading" || state.editor.window !== event.window) break;
				this.value = { ...state, editor: { kind: "ready", window: event.window } };
				return true;
			case "closed": {
				state.editorOwners.delete(event.window);
				const layouts = new Map(state.layouts);
				layouts.delete(event.window);
				this.value = {
					...state,
					layouts,
					main: state.main === event.window ? null : state.main,
					editor: this.editorWindow === event.window ? { kind: "absent" } : state.editor,
					switch:
						state.switch.kind !== "settled" && state.switch.window === event.window
							? { kind: "settled" }
							: state.switch,
				};
				return true;
			}
			case "switch":
				this.value = { ...state, switch: { kind: event.target, window: event.window } };
				return true;
			case "settled":
				if (state.switch.kind === "settled" || state.switch.window !== event.window) break;
				this.value = { ...state, switch: { kind: "settled" } };
				return true;
			case "prewarm":
				if (state.prewarm.kind === "scheduled") clearTimeout(state.prewarm.timer);
				this.value = {
					...state,
					prewarm: { kind: "scheduled", token: event.token, timer: event.schedule() },
				};
				return true;
			case "prewarm-fired":
				if (state.prewarm.kind !== "scheduled" || state.prewarm.token !== event.token) break;
				this.value = { ...state, prewarm: { kind: "idle" } };
				return true;
			case "cancel-prewarm":
				if (state.prewarm.kind === "scheduled") clearTimeout(state.prewarm.timer);
				this.value = { ...state, prewarm: { kind: "idle" } };
				return true;
		}
		console.warn("[workspace] Illegal transition", { event: event.type });
		return false;
	}
}
