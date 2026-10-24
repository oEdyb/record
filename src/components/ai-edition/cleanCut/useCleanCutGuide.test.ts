// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CleanCutReviewModel, ReviewCut } from "@/lib/cleanCut/reviewModel";
import { useCleanCutStore } from "@/lib/cleanCut/store";
import { useCleanCutGuide } from "./useCleanCutGuide";

const cut = (id: string, at: number, restored = false): ReviewCut => ({
	region: {
		id,
		kind: "retake",
		assetId: "a",
		removedStartSec: at,
		removedEndSec: at + 2,
		words: [id],
		reason: "",
		sources: ["rule"],
		risky: true,
	},
	rawStartSec: at,
	rawEndSec: at + 2,
	removedSec: 2,
	restored,
});

function model(): CleanCutReviewModel {
	const restored = useCleanCutStore.getState().restored;
	const cuts = [cut("a", 10, restored.has("a")), cut("b", 30, restored.has("b"))];
	return { keep: [], trimRanges: [], cuts, unsureCount: 2, strip: cuts, keptSec: 0 };
}

function setup(active = true) {
	const audition = vi.fn();
	const stop = vi.fn();
	const select = (c: ReviewCut) => useCleanCutStore.getState().select(c.region.id);
	const hook = renderHook(
		({ on }) =>
			useCleanCutGuide({ model: model(), resetKey: "r", active: on, select, audition, stop }),
		{ initialProps: { on: active } },
	);
	return { ...hook, audition, stop };
}

beforeEach(() => {
	useCleanCutStore.getState().setEnabled(false, null);
	useCleanCutStore.getState().setEnabled(true, "p");
});

describe("useCleanCutGuide", () => {
	it("plays the first card as soon as it is in sight, once", () => {
		const { result, audition, rerender } = setup(false);
		expect(result.current.current?.region.id).toBe("a");
		expect(audition).not.toHaveBeenCalled();
		rerender({ on: true });
		expect(audition).toHaveBeenCalledWith(
			expect.objectContaining({ rawStartSec: 10 }),
			"without",
			false,
		);
		rerender({ on: true });
		expect(audition).toHaveBeenCalledTimes(1);
	});

	it("restores in place, plays it back in, and undoes from the card", () => {
		const { result, audition, rerender } = setup();
		act(() => result.current.restore());
		rerender({ on: true });
		expect(result.current.current?.region.id).toBe("a");
		expect(result.current.flashId).toBe("a");
		expect(result.current.listen).toBe("with");
		expect(audition).toHaveBeenLastCalledWith(expect.anything(), "with", false);
		expect(useCleanCutStore.getState().restored.has("a")).toBe(true);
		act(() => result.current.undoRestore());
		rerender({ on: true });
		expect(useCleanCutStore.getState().restored.has("a")).toBe(false);
		expect(result.current.flashId).toBeNull();
		expect(result.current.uncheckedCount).toBe(2);
	});

	it("loops until toggled off or another cut comes up", () => {
		const { result, audition, stop, rerender } = setup();
		act(() => result.current.toggleLoop());
		expect(result.current.looping).toBe(true);
		expect(audition).toHaveBeenLastCalledWith(expect.anything(), "without", true);
		act(() => result.current.setListen("with"));
		expect(audition).toHaveBeenLastCalledWith(expect.anything(), "with", true);
		act(() => result.current.step(1));
		rerender({ on: true });
		expect(result.current.looping).toBe(false);
		expect(result.current.current?.region.id).toBe("b");
		act(() => result.current.toggleLoop());
		act(() => result.current.toggleLoop());
		expect(stop).toHaveBeenCalled();
		expect(result.current.looping).toBe(false);
	});

	it("jumps to a cut from its pip and finds the first one left to check", () => {
		const { result, rerender } = setup();
		act(() => result.current.jump(1));
		rerender({ on: true });
		expect(result.current.index).toBe(1);
		act(() => result.current.keep());
		rerender({ on: true });
		act(() => result.current.checkNext());
		rerender({ on: true });
		expect(result.current.current?.region.id).toBe("a");
	});
});
