// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompositorFrameTiming, CompositorTransportCommand } from "./contracts";
import type { NativeTransportTarget } from "./nativeTransportSync";

const syncCompositorTransport = vi.fn((_command: CompositorTransportCommand) =>
	Promise.resolve({ ok: true as const }),
);

vi.mock("./compositorViewClient", () => ({
	syncCompositorTransport: (command: CompositorTransportCommand) =>
		syncCompositorTransport(command),
}));

import { useNativePlaybackSync } from "./useNativePlaybackSync";

const target = (overrides: Partial<NativeTransportTarget> = {}): NativeTransportTarget => ({
	viewId: 7,
	clipId: "clip-a",
	clipIndex: 0,
	screenPath: "/recording/screen.mp4",
	webcamPath: "/recording/camera.mp4",
	webcamOffsetSec: 0,
	sourceTimeSec: 1.1,
	playing: false,
	...overrides,
});

describe("useNativePlaybackSync", () => {
	beforeEach(() => {
		syncCompositorTransport.mockClear();
		vi.restoreAllMocks();
	});

	it("sends one atomic anchor for discontinuities but not normal playing ticks", async () => {
		const { rerender } = renderHook(
			({ transportTarget }: { transportTarget: NativeTransportTarget | null }) =>
				useNativePlaybackSync(transportTarget),
			{ initialProps: { transportTarget: target() } },
		);
		await waitFor(() => expect(syncCompositorTransport).toHaveBeenCalledTimes(1));
		expect(syncCompositorTransport.mock.calls[0]?.[0]).toMatchObject({
			id: 7,
			generation: 1,
			playing: false,
			sourceTimeSec: 1.1,
		});

		rerender({ transportTarget: target({ playing: true }) });
		await waitFor(() => expect(syncCompositorTransport).toHaveBeenCalledTimes(2));

		rerender({ transportTarget: target({ playing: true, sourceTimeSec: 1.116 }) });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(syncCompositorTransport).toHaveBeenCalledTimes(2);
	});

	it("reanchors after three current-generation frames prove sustained drift", async () => {
		const now = vi.spyOn(performance, "now").mockReturnValue(1_000);
		let latest = target({ playing: true, sourceTimeSec: 1.1 });
		const { result, rerender } = renderHook(
			({ transportTarget }: { transportTarget: NativeTransportTarget | null }) =>
				useNativePlaybackSync(transportTarget),
			{ initialProps: { transportTarget: latest } },
		);
		await waitFor(() => expect(syncCompositorTransport).toHaveBeenCalledTimes(1));

		latest = target({ playing: true, sourceTimeSec: 1.2 });
		rerender({ transportTarget: latest });
		now.mockReturnValue(2_000);
		const drifted: CompositorFrameTiming = {
			sourceTimeSec: 1.9,
			clipIndex: 0,
			transportGeneration: 1,
		};
		act(() => {
			result.current(drifted);
			result.current(drifted);
			result.current(drifted);
		});

		await waitFor(() => expect(syncCompositorTransport).toHaveBeenCalledTimes(2));
		expect(syncCompositorTransport.mock.calls[1]?.[0]).toMatchObject({
			generation: 2,
			sourceTimeSec: 1.2,
			playing: true,
		});
	});
});
