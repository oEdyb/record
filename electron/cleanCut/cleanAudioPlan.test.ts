import { expect, it } from "vitest";
import { type PlannedItem, planSourceTimeline } from "../export/sourceTimeline";
import { planCleanAudio } from "./cleanAudioPlan";

export function item(start: number, duration: number, file = "mic.wav"): PlannedItem {
	return {
		type: "clip",
		file,
		start,
		duration,
		available: 600,
		offsetSec: 0,
		span: {
			id: "c",
			assetId: "a",
			sourceStartSec: start / 60,
			timelineStartSec: 0,
			timelineEndSec: duration / 60,
		},
	};
}

it("uses exactly 800 samples per planned frame including gaps", () => {
	const plan = planCleanAudio(
		[item(0, 17), { type: "gap", duration: 3 }, item(50, 2)],
		[item(0, 100)],
	);
	expect(plan.totalSamples).toBe(22 * 800);
	expect(plan.pieces.map((p) => p.outSample)).toEqual([0, 13600, 16000]);
});

it("omits seams between source-contiguous pieces", () => {
	expect(planCleanAudio([item(0, 10), item(10, 10)], [item(0, 100)]).seams).toEqual([]);
});

it("centers a 20 ms blend on the frame cut by default", () => {
	const plan = planCleanAudio([item(10, 10), item(40, 10)], [item(0, 100)]);
	expect(plan.seams[0]).toMatchObject({ mode: "blend", outSample: 8000, fadeSamples: 960 });
});

it("clamps fades to a third of short pieces so blends never overlap", () => {
	const plan = planCleanAudio([item(10, 1), item(40, 1), item(60, 1)], [item(0, 100)]);
	for (const seam of plan.seams) expect(seam.fadeSamples).toBeLessThanOrEqual(Math.floor(800 / 3));
	const [a, b] = plan.seams;
	expect(a.outSample + Math.ceil(a.fadeSamples / 2)).toBeLessThanOrEqual(
		b.outSample - Math.floor(b.fadeSamples / 2),
	);
});

it("does not borrow past project trims or removed clips", () => {
	const items = [item(0, 10), item(40, 10)];
	expect(planCleanAudio(items, items).seams[0]).toMatchObject({
		mode: "hard-edge",
		fadeSamples: 144,
	});
});

it("consumes the timeline offset with its original subtract sign, once", () => {
	for (const offsetSec of [-0.1, 0.1]) {
		const timeline = planSourceTimeline(
			[
				{
					assetId: "a",
					screen: {
						file: "screen.mp4",
						durationSec: 5,
						audio: [{ role: "microphone", file: "mic.wav", durationSec: 5, offsetSec }],
					},
					camera: null,
				},
			],
			[{ id: "c", assetId: "a", sourceStartSec: 1, timelineStartSec: 0, timelineEndSec: 1 }],
		);
		const items = timeline.tracks.find((t) => t.role === "microphone")!.items;
		expect(planCleanAudio(items, items).pieces[0]).toMatchObject({
			sourceSample: Math.round((1 - offsetSec) * 60) * 800,
		});
	}
});

it("uses half the shorter known neighbor gap, bounded to 3–30 ms", () => {
	const items = [item(10, 30), item(60, 30)];
	for (const [gap, expected] of [
		[0, 144],
		[960, 480],
		[9600, 1440],
	]) {
		expect(planCleanAudio(items, [item(0, 120)], () => [gap, gap * 2]).seams[0].fadeSamples).toBe(
			expected,
		);
	}
});

it("uses the exact 89.8 ms microphone offset without changing frame lengths", () => {
	const tracks = planSourceTimeline(
		[
			{
				assetId: "a",
				screen: {
					file: "screen.mov",
					durationSec: 10,
					audio: [{ role: "microphone", file: "mic.wav", durationSec: 10, offsetSec: 0.0898 }],
				},
				camera: null,
			},
		],
		[
			{
				id: "c",
				assetId: "a",
				sourceStartSec: 1,
				sourceEndSec: 2,
				timelineStartSec: 0,
				timelineEndSec: 1,
			},
		],
	).tracks;
	const items = tracks.find((track) => track.role === "microphone")!.items;
	const plan = planCleanAudio(items, items);
	expect(plan.totalSamples).toBe(48000);
	expect(plan.pieces[0]).toMatchObject({ sourceSample: 43690, samples: 48000 });
	expect(plan.pieces[0]).not.toMatchObject({ sourceSample: 55 * 800 });
});

it("uses the quantized screen read before subtracting a sub-frame mic offset", () => {
	const tracks = planSourceTimeline(
		[
			{
				assetId: "a",
				screen: {
					file: "screen.mov",
					durationSec: 10,
					audio: [{ role: "microphone", file: "mic.wav", durationSec: 10, offsetSec: 0.089800458 }],
				},
				camera: null,
			},
		],
		[
			{
				id: "c",
				assetId: "a",
				sourceStartSec: 1.1064671246666666,
				sourceEndSec: 3.806467124666667,
				timelineStartSec: 0,
				timelineEndSec: 2.7,
			},
		],
	).tracks;
	const mic = tracks.find((track) => track.role === "microphone")!.items;
	const plan = planCleanAudio(mic, mic);
	expect(plan.pieces[0]).toMatchObject({
		sourceSample: Math.round((66 / 60 - 0.089800458) * 48000),
		samples: 162 * 800,
	});
	expect(plan.pieces[0]).not.toMatchObject({ sourceSample: 61 * 800 });
});
