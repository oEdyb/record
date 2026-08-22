// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

// The regression under test is geometric, so the environment has to have a size:
// jsdom reports 0 for every box, which would leave `pxPerSec` at 0 (the
// "unmeasured" case) and hide exactly the thing being checked.
const VIEWPORT_PX = 900;
const TOTAL_SEC = 1800; // a 30-minute recording, as in the report

vi.mock("@/contexts/I18nContext", () => ({
	useScopedT: () => (key: string) => key,
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }));

import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import type { useTimeline } from "@/lib/ai-edition/store/useTimeline";
import { V4Timeline } from "./V4Timeline";

beforeAll(() => {
	globalThis.ResizeObserver = class {
		// jsdom has none, and the width it would report is stubbed below anyway.
		observe() {
			/* noop */
		}
		unobserve() {
			/* noop */
		}
		disconnect() {
			/* noop */
		}
	} as unknown as typeof ResizeObserver;
	Object.defineProperty(HTMLElement.prototype, "clientWidth", {
		configurable: true,
		get: () => VIEWPORT_PX,
	});
	Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
		configurable: true,
		value: () => ({
			x: 0,
			y: 0,
			left: 0,
			top: 0,
			right: VIEWPORT_PX,
			bottom: 100,
			width: VIEWPORT_PX,
			height: 100,
			toJSON() {
				/* unused by the component */
			},
		}),
	});
});

function clip(startSec: number, endSec: number) {
	return {
		id: `c@${startSec}`,
		assetId: "a1",
		timelineStartSec: startSec,
		timelineEndSec: endSec,
		sourceStartSec: 0,
		sourceEndSec: endSec - startSec,
	};
}

/** By default one 30-minute clip carrying a single one-second annotation. */
function renderTimeline(
	clips = [clip(0, TOTAL_SEC)],
	annotation = { id: "ann1", startMs: 10_000, endMs: 11_000 },
	clipSelection: string | null = null,
	cameraFullscreenRegions: Array<{
		id: string;
		startMs: number;
		endMs: number;
		mode: "emphasis";
		cameraScale: number;
		source: "auto";
		directionGroupId?: string;
	}> = [],
	zoomRegions: Array<{
		id: string;
		startMs: number;
		endMs: number;
		depth: 3;
		focus: { cx: number; cy: number };
		customScale: number;
		motionSpeed?: 2;
		source?: "auto" | "manual";
		directionGroupId?: string;
	}> = [],
	selection: { kind: "zoom" | "cameraFullscreen"; id: string } | null = null,
) {
	const tl = {
		clips,
		assets: [{ id: "a1", label: "rec", durationSec: TOTAL_SEC }],
		annotationRegions: [annotation],
		speedRegions: [],
		cameraFullscreenRegions,
		zoomRegions,
		trimRanges: [],
		selection,
		multiSelection: [],
		clipSelection,
		clearSelection: vi.fn(),
		selectRegion: vi.fn(),
		selectClip: vi.fn(),
		updateAnnotationSpan: vi.fn(async () => {
			/* the drag only awaits it */
		}),
		updateCameraFullscreenSpan: vi.fn(async () => {
			/* the drag only awaits it */
		}),
		addZoom: vi.fn(async () => {
			/* the toolbar only awaits it */
		}),
		splitClipAtPlayhead: vi.fn(async () => true),
	};
	render(
		<V4Timeline
			// Only the members the lanes and the clip row read are mocked; the prop
			// stays typed as the real API rather than widened to `any` (AGENTS.md).
			tl={tl as unknown as ReturnType<typeof useTimeline>}
			setCurrentTime={vi.fn()}
			playing={false}
			onTogglePlay={vi.fn()}
			onPrevClip={vi.fn()}
			onNextClip={vi.fn()}
			onEditClip={vi.fn()}
		/>,
	);
	return {
		pill: screen.getByTitle("toolbar.newAnnotation"),
		clipEls: Array.from(document.querySelectorAll<HTMLElement>("[data-clip-id]")),
		tl,
	};
}

/** Drag a handle by `dxPx`. The move/up listeners live on `window`, so the drag
 *  is driven by pointer deltas alone — the handle may re-mount under it. */
function dragHandle(handle: Element, dxPx: number) {
	fireEvent.pointerDown(handle, { clientX: 0 });
	window.dispatchEvent(new MouseEvent("pointermove", { clientX: dxPx }));
	window.dispatchEvent(new MouseEvent("pointerup", { clientX: dxPx }));
}

/** Ctrl+wheel up = zoom in; the handler is a native listener, so dispatch real events. */
function zoomIn(notches: number) {
	const canvas = document.querySelector("[class*=tlTracks]") as HTMLElement;
	for (let i = 0; i < notches; i++) {
		fireEvent.wheel(canvas, { ctrlKey: true, deltaY: -100, clientX: 0 });
	}
}

describe("V4Timeline lane pills", () => {
	it("shows one clean icon pill for a short Zoom that is too narrow for its label", () => {
		renderTimeline(
			[clip(0, 35.55)],
			undefined,
			null,
			[],
			[
				{
					id: "first-auto-zoom",
					startMs: 2_098,
					endMs: 2_517,
					depth: 3,
					focus: { cx: 0.54, cy: 0.5 },
					customScale: 1.65,
					motionSpeed: 2,
				},
			],
		);

		const pill = screen.getByTitle("1.65×");
		expect(Number.parseFloat(pill.style.width)).toBeCloseTo((0.419 / 35.55) * 100, 10);
		expect(pill.querySelector("svg")).toBeInTheDocument();
		expect(pill.textContent).toBe("");
		expect(document.querySelector("[data-zoom-motion-envelope]")).toBeNull();
	});

	it("shows automatic camera emphasis as its editable real region", () => {
		const { tl } = renderTimeline([clip(0, 20)], undefined, null, [
			{
				id: "camera-emphasis-1",
				startMs: 2_000,
				endMs: 6_000,
				mode: "emphasis",
				cameraScale: 1.35,
				source: "auto",
				directionGroupId: "camera-passage",
			},
		]);

		const pill = screen.getByTitle("labels.cameraEmphasis");
		expect(pill.style.left).toBe("10%");
		expect(pill.style.width).toBe("20%");
		expect(pill.querySelectorAll("[class*=lanePillHandle]")).toHaveLength(2);

		fireEvent.pointerDown(pill, { clientX: 180 });
		window.dispatchEvent(new MouseEvent("pointerup", { clientX: 180 }));
		expect(tl.selectRegion).toHaveBeenCalledWith("cameraFullscreen", "camera-emphasis-1", {
			additive: false,
		});
	});

	it("shows each automatic Zoom target as a real editable pill", () => {
		const { tl } = renderTimeline(
			[clip(0, 20)],
			undefined,
			null,
			[],
			[
				{
					id: "zoom-a",
					startMs: 2_000,
					endMs: 5_000,
					depth: 3,
					focus: { cx: 0.25, cy: 0.5 },
					customScale: 1.65,
					source: "auto",
					directionGroupId: "screen-passage",
				},
				{
					id: "zoom-b",
					startMs: 5_500,
					endMs: 8_000,
					depth: 3,
					focus: { cx: 0.75, cy: 0.5 },
					customScale: 1.65,
					source: "auto",
					directionGroupId: "screen-passage",
				},
			],
		);

		expect(screen.queryByTitle("toolbar.automaticDirection")).toBeNull();
		expect(screen.getAllByTitle("1.65×")).toHaveLength(2);
		fireEvent.pointerDown(screen.getAllByTitle("1.65×")[0]);
		window.dispatchEvent(new MouseEvent("pointerup"));
		expect(tl.selectRegion).toHaveBeenCalledWith("zoom", "zoom-a", { additive: false });
	});

	it("keeps every automatic Zoom visible when one target is selected", () => {
		renderTimeline(
			[clip(0, 20)],
			undefined,
			null,
			[],
			[
				{
					id: "zoom-a",
					startMs: 2_000,
					endMs: 5_000,
					depth: 3,
					focus: { cx: 0.25, cy: 0.5 },
					customScale: 1.65,
					source: "auto",
					directionGroupId: "screen-passage",
				},
				{
					id: "zoom-b",
					startMs: 5_500,
					endMs: 8_000,
					depth: 3,
					focus: { cx: 0.75, cy: 0.5 },
					customScale: 1.65,
					source: "auto",
					directionGroupId: "screen-passage",
				},
			],
			{ kind: "zoom", id: "zoom-a" },
		);

		expect(screen.queryByTitle("toolbar.automaticDirection")).toBeNull();
		expect(screen.getAllByTitle("1.65×")).toHaveLength(2);
	});

	it("draws a pill exactly as wide as its region, at any zoom", () => {
		// 1 s of 1800 s. The old `Math.max(1.5, …)` floor drew this as 1.5% — 27
		// seconds of ruler for a one-second annotation — and did it at every zoom,
		// since the floor was a percentage of the timeline rather than of the screen.
		const { pill } = renderTimeline();
		const expected = (1 / TOTAL_SEC) * 100;
		expect(Number.parseFloat(pill.style.width)).toBeCloseTo(expected, 6);

		// The canvas is what scales with zoom, so the pill's share of it must not
		// move at all — only the chrome inside it may react (below).
		zoomIn(40);
		expect(Number.parseFloat(pill.style.width)).toBeCloseTo(expected, 6);
	});

	it("keeps both resize handles reachable when the pill is thinner than they are", () => {
		// 0.5 px wide at this zoom: the handles cannot sit inside the box without
		// swallowing it whole, so they mount outside it and the body stays a move
		// target. Resizing a hairline stays possible — it is the pointer precision
		// that is coarse there, not the affordance that is missing.
		const { pill } = renderTimeline();
		const [left, right] = Array.from(pill.querySelectorAll("span"));
		expect(left.style.left).toBe("-10px");
		expect(right.style.right).toBe("-10px");
		// Nothing legible fits, so no icon/label is rendered (the title attribute
		// still carries the value on hover).
		expect(pill.textContent).toBe("");

		// Zoomed to the 50× ceiling the same second is 25 px wide and hosts its own
		// chrome again.
		zoomIn(40);
		expect(left.style.left).toBe("0px");
		expect(right.style.right).toBe("0px");
	});

	it("grows and shrinks a hairline pill from its outside handles", () => {
		// Growing is unbounded by the pill's own size: 90 px right of a 900 px canvas
		// is a tenth of the 1800 s timeline, so the 10–11 s annotation ends at 191 s.
		// The chrome re-flows inside the box as it crosses PILL_HANDLES_MIN_PX
		// mid-drag, which the gesture never notices — the deltas come from the
		// pointer and the listeners live on `window`, not on the handle.
		const { pill, tl } = renderTimeline();
		const [left, right] = Array.from(pill.querySelectorAll("span"));
		dragHandle(right, 90);
		expect(tl.updateAnnotationSpan).toHaveBeenCalledWith("ann1", 10_000, 191_000);

		// Shrinking stops at the storage grid (1 ms), not at the old flat 200 ms
		// floor that refused the last fifth of a second however far you zoomed in.
		dragHandle(left, 90_000);
		expect(tl.updateAnnotationSpan).toHaveBeenLastCalledWith("ann1", 10_999, 11_000);

		// 18 s short of the timeline end: 9 px away on screen, so it stays where it
		// was dropped. The snap radius used to be 1.2% of the timeline — a 21-second
		// magnet here — which is what made a grown edge jump to a clip boundary it
		// was nowhere near, the more so the longer the recording.
		dragHandle(right, 885.5);
		expect(tl.updateAnnotationSpan).toHaveBeenLastCalledWith("ann1", 10_000, 1_782_000);
	});
});

describe("V4Timeline create-from-toolbar", () => {
	// The button asks for a DURATION worth a fixed number of pixels at the current
	// zoom, so the pill you get is always the same size on screen — which is what
	// the flat 2 s could not do: on this 30-minute fixture zoomed out it is one
	// pixel. (It used to look fine only because the removed 1.5% minimum width
	// inflated it in the rendering.)
	const durationOf = (tl: { addZoom: ReturnType<typeof vi.fn> }) =>
		tl.addZoom.mock.calls.at(-1)?.[0] as number;

	it("scales the new region's duration with the zoom", () => {
		const { tl } = renderTimeline();
		fireEvent.click(screen.getByTitle("buttons.addZoom"));
		// 900px viewport / 1800 s = 0.5 px per second, so a 96px pill is 192 s.
		expect(durationOf(tl)).toBeCloseTo(192, 3);

		// Zoomed to the 50x ceiling the same 96px is worth 3.84 s: same pill on
		// screen, a region 50x shorter.
		zoomIn(40);
		fireEvent.click(screen.getByTitle("buttons.addZoom"));
		expect(durationOf(tl)).toBeCloseTo(3.84, 3);
	});

	it("never asks for a slice too short to be worth creating", () => {
		// Past ~30x on a short timeline the pixels are worth hundredths of a
		// second; the region would be born unusable, so the duration floors.
		const { tl } = renderTimeline([clip(0, 3)]);
		zoomIn(40);
		fireEvent.click(screen.getByTitle("buttons.addZoom"));
		expect(durationOf(tl)).toBeCloseTo(0.25, 3);
	});

	it("exposes the normal Split action through the timeline toolbar", () => {
		const { tl } = renderTimeline([clip(0, 10)]);
		fireEvent.click(screen.getByTitle("buttons.splitClip"));
		expect(tl.splitClipAtPlayhead).toHaveBeenCalledTimes(1);
	});
});

describe("V4Timeline clip row", () => {
	// Three clips = two junctions. As a flex row with `gap: 6px`, each junction
	// added 6px while every clip shrank proportionally to pay for it, so a clip's
	// left edge missed its true start: measured in a browser on this very fixture,
	// clip 2 by +2px and clip 3 by +6px, while the pills and ruler above them sat
	// at the true position. Being a fixed px error in a proportional layout, it was
	// worth 5 s and 15 s of timeline zoomed out but a fraction of a second zoomed
	// in — which is what reads as "the pills move when I zoom".
	const CLIPS = [clip(0, 600), clip(600, 900), clip(900, TOTAL_SEC)];
	const startsAt = (sec: number) => `${(sec / TOTAL_SEC) * 100}%`;

	it("anchors every clip to its own start time, and keeps it there under zoom", () => {
		// The annotation starts exactly where the second clip does, so the pill and
		// the clip edge under it must resolve to the very same coordinate.
		const { clipEls, pill } = renderTimeline(CLIPS, {
			id: "ann1",
			startMs: 600_000,
			endMs: 601_000,
		});
		expect(clipEls.map((el) => el.style.left)).toEqual([startsAt(0), startsAt(600), startsAt(900)]);
		expect(pill.style.left).toBe(clipEls[1].style.left);

		// Zoom scales the canvas these coordinates live in, so the coordinates
		// themselves must not move: same values, same agreement with the pill.
		zoomIn(40);
		expect(clipEls.map((el) => el.style.left)).toEqual([startsAt(0), startsAt(600), startsAt(900)]);
		expect(pill.style.left).toBe(clipEls[1].style.left);
	});

	it("takes the card gutter out of each clip's own width", () => {
		// The 6px is what separates two cards. Taken off the clip's width it stays
		// local to that clip; inserted between them (a flex gap) it displaced every
		// clip that followed. The 1px floor keeps a clip shorter than the gutter
		// from collapsing to nothing on a long timeline.
		const { clipEls } = renderTimeline(CLIPS);
		const widths = clipEls.map((el) => el.style.width);
		// (jsdom re-serialises the percentage to 4 decimals, hence the numeric read)
		expect(widths.map((w) => w.endsWith("- 6px)"))).toEqual([true, true, true]);
		for (const [i, durSec] of [600, 300, 900].entries()) {
			expect(Number.parseFloat(widths[i].slice("calc(".length))).toBeCloseTo(
				(durSec / TOTAL_SEC) * 100,
				3,
			);
		}
	});

	it("shows the recording insertion boundary after the clip under the playhead", () => {
		act(() => useProjectStore.getState().setCurrentTime(650));
		renderTimeline(CLIPS);

		// Each card ends 6px before the next clip's true start. The marker belongs
		// in the middle of that visual gap, not on the next card's leading edge.
		expect(screen.getByTestId("timeline-insertion-boundary").style.left).toBe(
			`calc(${startsAt(900)} - 3px)`,
		);
	});

	it("keeps the first insertion boundary inside the clip row", () => {
		act(() => useProjectStore.getState().setCurrentTime(0));
		renderTimeline(CLIPS);

		const marker = screen.getByTestId("timeline-insertion-boundary");
		expect(marker.style.left).toBe("0%");
		expect(marker.style.transform).toBe("translate(0px, -50%)");
	});

	it("does not put a delete button inside a selected clip", () => {
		renderTimeline(CLIPS, undefined, "c@600");

		expect(screen.queryByRole("button", { name: "toolbar.deleteClip" })).not.toBeInTheDocument();
	});
});
