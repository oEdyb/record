import { create } from "zustand";
import {
	type CleanCutRegion,
	type CleanCutSnapshot,
	type CleanCutStrength,
	EMPTY_CLEAN_CUT_SNAPSHOT,
} from "./types";
import { withUserCuts } from "./userCuts";

type CleanCutStep =
	| { type: "restore"; id: string; restored: boolean }
	| { type: "restoreMany"; ids: string[]; restored: boolean }
	| { type: "strength"; from: CleanCutStrength; to: CleanCutStrength }
	| { type: "userCut"; region: CleanCutRegion };

export type CleanCutView = "cuts" | "transcript";

interface CleanCutStore {
	/** The viewer's toggle beside Save. Off by default, for every project. */
	enabled: boolean;
	projectId: string | null;
	strength: CleanCutStrength;
	/** What review shows: the engine's result with the viewer's own cuts applied. */
	snapshot: CleanCutSnapshot;
	/** The engine's result as it arrived. */
	engine: CleanCutSnapshot;
	/** Sentences the viewer cut themself; never written to the document. */
	userCuts: readonly CleanCutRegion[];
	/** Regions the viewer brought back; never written to the document. */
	restored: ReadonlySet<string>;
	selectedId: string | null;
	view: CleanCutView;
	/** Bumped by Try again so the session starts a fresh analysis. */
	attempt: number;
	undoSteps: CleanCutStep[];
	redoSteps: CleanCutStep[];
	setEnabled: (enabled: boolean, projectId: string | null) => void;
	receive: (snapshot: CleanCutSnapshot) => void;
	setStrength: (strength: CleanCutStrength) => void;
	toggleRestore: (id: string) => void;
	/** Restores, or cuts again, many regions as one undo step, e.g. every pause. */
	setRestoredMany: (ids: readonly string[], restored: boolean) => void;
	/** Cuts a sentence the engine kept. */
	cutSentence: (region: CleanCutRegion) => void;
	select: (id: string | null) => void;
	setView: (view: CleanCutView) => void;
	retry: () => void;
	undo: () => void;
	redo: () => void;
}

const FRESH = {
	snapshot: EMPTY_CLEAN_CUT_SNAPSHOT,
	engine: EMPTY_CLEAN_CUT_SNAPSHOT,
	userCuts: [],
	restored: new Set<string>(),
	selectedId: null,
	undoSteps: [],
	redoSteps: [],
} satisfies Partial<CleanCutStore>;

function withRestore(restored: ReadonlySet<string>, id: string, on: boolean) {
	const next = new Set(restored);
	if (on) next.add(id);
	else next.delete(id);
	return next;
}

function withUserCut(state: CleanCutStore, region: CleanCutRegion, on: boolean) {
	const userCuts = on
		? [...state.userCuts, region]
		: state.userCuts.filter((cut) => cut.id !== region.id);
	return {
		userCuts,
		snapshot: withUserCuts(state.engine, userCuts),
		restored: withRestore(state.restored, region.id, false),
		selectedId: on ? region.id : null,
	};
}

function apply(state: CleanCutStore, step: CleanCutStep, reverse: boolean): Partial<CleanCutStore> {
	if (step.type === "userCut") return withUserCut(state, step.region, !reverse);
	if (step.type === "strength") return { strength: reverse ? step.from : step.to };
	if (step.type === "restoreMany") {
		let restored = state.restored;
		for (const id of step.ids) restored = withRestore(restored, id, reverse !== step.restored);
		return { restored };
	}
	const restored = reverse ? !step.restored : step.restored;
	return { restored: withRestore(state.restored, step.id, restored), selectedId: step.id };
}

export const useCleanCutStore = create<CleanCutStore>((set, get) => ({
	enabled: false,
	projectId: null,
	strength: "clean",
	view: "transcript",
	attempt: 0,
	...FRESH,
	setEnabled: (enabled, projectId) => {
		const state = get();
		if (state.enabled === enabled && state.projectId === projectId) return;
		set({ enabled, projectId, ...FRESH, view: "transcript" });
	},
	receive: (snapshot) => {
		const state = get();
		if (!state.enabled || snapshot.projectId !== state.projectId) return;
		// A new run, or the result of one, describes new regions: earlier restores,
		// selection and history refer to the previous analysis.
		const freshRun =
			snapshot.state !== state.snapshot.state &&
			(snapshot.state === "working" || snapshot.state === "ready");
		set(
			freshRun
				? {
						snapshot,
						engine: snapshot,
						userCuts: [],
						restored: new Set(),
						selectedId: null,
						undoSteps: [],
						redoSteps: [],
					}
				: { snapshot: withUserCuts(snapshot, state.userCuts), engine: snapshot },
		);
	},
	setStrength: (strength) => {
		const from = get().strength;
		if (from === strength) return;
		set((state) => ({
			strength,
			undoSteps: [...state.undoSteps, { type: "strength", from, to: strength }],
			redoSteps: [],
		}));
	},
	toggleRestore: (id) => {
		const restored = !get().restored.has(id);
		set((state) => ({
			restored: withRestore(state.restored, id, restored),
			selectedId: id,
			undoSteps: [...state.undoSteps, { type: "restore", id, restored }],
			redoSteps: [],
		}));
	},
	setRestoredMany: (ids, restored) => {
		const state = get();
		const changed = ids.filter((id) => state.restored.has(id) !== restored);
		if (changed.length === 0) return;
		let next = state.restored;
		for (const id of changed) next = withRestore(next, id, restored);
		set({
			restored: next,
			undoSteps: [...state.undoSteps, { type: "restoreMany", ids: changed, restored }],
			redoSteps: [],
		});
	},
	cutSentence: (region) => {
		const state = get();
		if (state.userCuts.some((cut) => cut.id === region.id)) return;
		set({
			...withUserCut(state, region, true),
			undoSteps: [...state.undoSteps, { type: "userCut", region }],
			redoSteps: [],
		});
	},
	select: (selectedId) => set({ selectedId }),
	setView: (view) => set({ view }),
	retry: () => set((state) => ({ attempt: state.attempt + 1, snapshot: EMPTY_CLEAN_CUT_SNAPSHOT })),
	undo: () => {
		const state = get();
		const step = state.undoSteps[state.undoSteps.length - 1];
		if (!step) return;
		set({
			...apply(state, step, true),
			undoSteps: state.undoSteps.slice(0, -1),
			redoSteps: [...state.redoSteps, step],
		});
	},
	redo: () => {
		const state = get();
		const step = state.redoSteps[state.redoSteps.length - 1];
		if (!step) return;
		set({
			...apply(state, step, false),
			undoSteps: [...state.undoSteps, step],
			redoSteps: state.redoSteps.slice(0, -1),
		});
	},
}));
