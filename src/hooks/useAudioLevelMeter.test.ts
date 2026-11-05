// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { useAudioLevelMeter } from "./useAudioLevelMeter";

const stop = vi.fn();
const getUserMedia = vi.fn();
Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
beforeEach(() => {
	vi.clearAllMocks();
	getUserMedia.mockResolvedValue({ getTracks: () => [{ stop }] });
	vi.stubGlobal(
		"requestAnimationFrame",
		vi.fn(() => 1),
	);
	vi.stubGlobal("cancelAnimationFrame", vi.fn());
	vi.stubGlobal(
		"AudioContext",
		class {
			state = "running";
			close = vi.fn();
			createMediaStreamSource = () => ({ connect: vi.fn() });
			createAnalyser = () => ({
				fftSize: 256,
				frequencyBinCount: 128,
				smoothingTimeConstant: 0,
				getByteFrequencyData: vi.fn(),
			});
		},
	);
});
it.each([
	undefined,
	"selected-mic",
])("meters the unprocessed recording input for %s", async (deviceId) => {
	const hook = renderHook(() => useAudioLevelMeter({ enabled: true, deviceId }));
	await waitFor(() =>
		expect(getUserMedia).toHaveBeenCalledWith({
			audio: {
				...(deviceId ? { deviceId: { exact: deviceId } } : {}),
				autoGainControl: false,
				echoCancellation: false,
				noiseSuppression: false,
			},
			video: false,
		}),
	);
	hook.unmount();
	expect(stop).toHaveBeenCalled();
});
