// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { useEntitlementStore } from "@/lib/entitlements/store";
import { NativeBridgeClientError, requireNativeBridgeData } from "./client";

describe("requireNativeBridgeData", () => {
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
});
