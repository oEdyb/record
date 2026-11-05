// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMicrophoneDevices } from "./useMicrophoneDevices";

const stop = vi.fn();
const getUserMedia = vi.fn();
const enumerateDevices = vi.fn();

Object.defineProperty(global.navigator, "mediaDevices", {
	value: {
		enumerateDevices,
		getUserMedia,
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
	},
	configurable: true,
});

const named = [{ kind: "audioinput", deviceId: "mic1", label: "Mic 1", groupId: "g" }];
const unnamed = [{ kind: "audioinput", deviceId: "mic1", label: "", groupId: "g" }];

describe("useMicrophoneDevices", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		getUserMedia.mockResolvedValue({ getTracks: () => [{ stop }] });
	});

	it("lists named microphones without opening the microphone", async () => {
		enumerateDevices.mockResolvedValue(named);
		const { result } = renderHook(() => useMicrophoneDevices(true));
		await waitFor(() => expect(result.current.devices).toHaveLength(1));
		expect(result.current.devices[0].label).toBe("Mic 1");
		expect(getUserMedia).not.toHaveBeenCalled();
	});

	it("opens the microphone once for names when permission was never granted", async () => {
		enumerateDevices.mockResolvedValueOnce(unnamed).mockResolvedValue(named);
		const { result } = renderHook(() => useMicrophoneDevices(true));
		await waitFor(() => expect(result.current.devices[0]?.label).toBe("Mic 1"));
		expect(getUserMedia).toHaveBeenCalledTimes(1);
		expect(getUserMedia).toHaveBeenCalledWith({
			audio: { autoGainControl: false, echoCancellation: false, noiseSuppression: false },
		});
		expect(stop).toHaveBeenCalled();
	});
});
