// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeBridgeClient } from "./client";
import type { NativeBridgeRequest } from "./contracts";

describe("native bridge client", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		delete (window as unknown as { electronAPI?: unknown }).electronAPI;
	});

	it("requests the latest full view without a project id", async () => {
		const invoke = vi.fn(async (_request: NativeBridgeRequest) => ({
			ok: true as const,
			data: { success: true },
			meta: { version: 1 as const, requestId: "test", timestampMs: Date.now() },
		}));
		(window as unknown as { electronAPI: Window["electronAPI"] }).electronAPI = {
			invokeNativeBridge: invoke as Window["electronAPI"]["invokeNativeBridge"],
		} as Window["electronAPI"];

		await expect(nativeBridgeClient.aiEdition.getLatest()).resolves.toEqual({ success: true });
		const request = invoke.mock.calls[0]?.[0];
		expect(request).toMatchObject({ domain: "aiEdition", action: "document.getLatest" });
		expect(request).not.toHaveProperty("payload.projectId");
	});
});
