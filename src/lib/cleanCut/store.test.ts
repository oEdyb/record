import { beforeEach, describe, expect, it } from "vitest";
import { useCleanCutStore } from "./store";
import { EMPTY_CLEAN_CUT_SNAPSHOT } from "./types";
import { userCutRegion } from "./userCuts";

const ready = { ...EMPTY_CLEAN_CUT_SNAPSHOT, projectId: "p1", state: "ready" as const };

beforeEach(() => {
	useCleanCutStore.getState().setEnabled(false, null);
	useCleanCutStore.setState({ strength: "clean" });
});

describe("clean cut review state", () => {
	it("is off until the viewer turns it on", () => {
		expect(useCleanCutStore.getState().enabled).toBe(false);
		useCleanCutStore.getState().receive(ready);
		expect(useCleanCutStore.getState().snapshot.state).toBe("off");
	});

	it("takes snapshots only for the open project", () => {
		const store = useCleanCutStore.getState();
		store.setEnabled(true, "p1");
		store.receive({ ...ready, projectId: "p2" });
		expect(useCleanCutStore.getState().snapshot.state).toBe("off");
		store.receive(ready);
		expect(useCleanCutStore.getState().snapshot.state).toBe("ready");
	});

	it("restores, undoes and redoes, selecting the cut each time", () => {
		const store = useCleanCutStore.getState();
		store.setEnabled(true, "p1");
		store.toggleRestore("a");
		store.toggleRestore("b");
		expect([...useCleanCutStore.getState().restored]).toEqual(["a", "b"]);
		useCleanCutStore.getState().undo();
		expect([...useCleanCutStore.getState().restored]).toEqual(["a"]);
		expect(useCleanCutStore.getState().selectedId).toBe("b");
		useCleanCutStore.getState().redo();
		expect([...useCleanCutStore.getState().restored]).toEqual(["a", "b"]);
		useCleanCutStore.getState().toggleRestore("a");
		expect([...useCleanCutStore.getState().restored]).toEqual(["b"]);
		expect(useCleanCutStore.getState().redoSteps).toEqual([]);
	});

	it("cuts a sentence the viewer picked, keeps it across engine updates, and undoes it", () => {
		const words = [
			{ text: "Hi.", assetId: "a", startSec: 0, endSec: 0.4, regionId: null },
			{ text: "Bye.", assetId: "a", startSec: 1, endSec: 1.4, regionId: null },
		];
		const engine = { ...ready, keep: [{ assetId: "a", startSec: 0, endSec: 2 }], words };
		const store = useCleanCutStore.getState();
		store.setEnabled(true, "p1");
		store.receive(engine);
		const region = userCutRegion(words, engine.keep, 1, 1);
		useCleanCutStore.getState().cutSentence(region);
		expect(useCleanCutStore.getState().snapshot.keep).toEqual([
			{ assetId: "a", startSec: 0, endSec: 0.7 },
			{ assetId: "a", startSec: 1.45, endSec: 2 },
		]);
		expect(useCleanCutStore.getState().selectedId).toBe(region.id);
		useCleanCutStore.getState().receive({ ...engine, progress: 1 });
		expect(useCleanCutStore.getState().snapshot.regions).toEqual([region]);
		useCleanCutStore.getState().undo();
		expect(useCleanCutStore.getState().snapshot.keep).toEqual(engine.keep);
		expect(useCleanCutStore.getState().snapshot.regions).toEqual([]);
		useCleanCutStore.getState().redo();
		expect(useCleanCutStore.getState().userCuts).toEqual([region]);
	});

	it("undoes a strength change", () => {
		const store = useCleanCutStore.getState();
		store.setEnabled(true, "p1");
		store.setStrength("gentle");
		useCleanCutStore.getState().undo();
		expect(useCleanCutStore.getState().strength).toBe("clean");
	});

	it("forgets restores when turned off", () => {
		const store = useCleanCutStore.getState();
		store.setEnabled(true, "p1");
		store.toggleRestore("a");
		useCleanCutStore.getState().setEnabled(false, "p1");
		expect(useCleanCutStore.getState().restored.size).toBe(0);
		expect(useCleanCutStore.getState().undoSteps).toEqual([]);
	});
	it("starts each new analysis with no restores, selection or history", () => {
		const store = useCleanCutStore.getState();
		store.setEnabled(true, "p1");
		store.receive(ready);
		store.toggleRestore("a");
		useCleanCutStore.getState().receive({ ...ready, progress: 1 });
		expect([...useCleanCutStore.getState().restored]).toEqual(["a"]);
		useCleanCutStore.getState().receive({ ...ready, state: "working" });
		expect(useCleanCutStore.getState().restored.size).toBe(0);
		expect(useCleanCutStore.getState().selectedId).toBeNull();
		expect(useCleanCutStore.getState().undoSteps).toEqual([]);
	});

	it("restores many regions as one step, and undoes only what it changed", () => {
		const store = useCleanCutStore.getState();
		store.setEnabled(true, "p1");
		store.toggleRestore("p2");
		useCleanCutStore.getState().setRestoredMany(["p1", "p2", "p3"], true);
		expect([...useCleanCutStore.getState().restored].sort()).toEqual(["p1", "p2", "p3"]);
		useCleanCutStore.getState().undo();
		expect([...useCleanCutStore.getState().restored]).toEqual(["p2"]);
		useCleanCutStore.getState().redo();
		expect(useCleanCutStore.getState().restored.size).toBe(3);
		useCleanCutStore.getState().setRestoredMany(["p1", "p2", "p3"], false);
		expect(useCleanCutStore.getState().restored.size).toBe(0);
		const steps = useCleanCutStore.getState().undoSteps.length;
		useCleanCutStore.getState().setRestoredMany(["p1"], false);
		expect(useCleanCutStore.getState().undoSteps.length).toBe(steps);
	});
});
