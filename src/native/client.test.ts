// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { useEntitlementStore } from "@/lib/entitlements/store";
import { NativeBridgeClientError, nativeBridgeClient, requireNativeBridgeData } from "./client";
import type { NativeBridgeRequest } from "./contracts";

describe("native bridge client", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		delete (window as unknown as { electronAPI?: unknown }).electronAPI;
		useEntitlementStore.setState({ dialogOpen: false, blockedCapability: null });
	});

	it("opens the access surface when the main process rejects a stale renderer", async () => {
		(window as unknown as { electronAPI: Window["electronAPI"] }).electronAPI = {
			invokeNativeBridge: vi.fn(async () => ({
				ok: false as const,
				error: {
					code: "ENTITLEMENT_REQUIRED",
					message: "Klippt Pro is required.",
					retryable: false,
				},
				meta: { version: 1 as const, requestId: "test", timestampMs: Date.now() },
			})) as Window["electronAPI"]["invokeNativeBridge"],
		} as Window["electronAPI"];

		await expect(
			requireNativeBridgeData({ domain: "aiEdition", action: "document.create", payload: {} }),
		).rejects.toEqual(
			expect.objectContaining<Partial<NativeBridgeClientError>>({
				code: "ENTITLEMENT_REQUIRED",
			}),
		);
		await vi.waitFor(() => expect(useEntitlementStore.getState().dialogOpen).toBe(true));
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
