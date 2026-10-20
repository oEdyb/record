import { afterEach, describe, expect, it, vi } from "vitest";
import type { EntitlementSnapshot } from "./contracts";
import { requireEntitlement, useEntitlementStore } from "./store";

const base = {
	version: 1,
	provider: "lemon-squeezy",
	commerceConfigured: true,
	checkoutAvailable: true,
	managementAvailable: true,
} as const;
const READ_ONLY: EntitlementSnapshot = { ...base, status: "expired", access: "read-only" };
const LICENSED: EntitlementSnapshot = { ...base, status: "licensed", access: "full" };

function stubApi(getEntitlement: () => Promise<EntitlementSnapshot>) {
	vi.stubGlobal("window", { electronAPI: { getEntitlement: vi.fn(getEntitlement) } });
	return window.electronAPI.getEntitlement;
}

describe("requireEntitlement", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		useEntitlementStore.setState({
			snapshot: READ_ONLY,
			dialogOpen: false,
			blockedCapability: null,
		});
	});

	it("asks main to recheck a blocked action and unlocks a renewed subscription", async () => {
		useEntitlementStore.getState().setSnapshot(READ_ONLY);
		const getEntitlement = stubApi(async () => LICENSED);

		expect(requireEntitlement("record")).toBe(false);
		expect(useEntitlementStore.getState().dialogOpen).toBe(true);
		await vi.waitFor(() => expect(useEntitlementStore.getState().snapshot.access).toBe("full"));
		expect(getEntitlement).toHaveBeenCalledOnce();
		expect(useEntitlementStore.getState().dialogOpen).toBe(false);
		expect(requireEntitlement("record")).toBe(true);
	});

	it("keeps the dialog open when main still answers read-only", async () => {
		useEntitlementStore.getState().setSnapshot(READ_ONLY);
		const getEntitlement = stubApi(async () => READ_ONLY);

		requireEntitlement("export");
		requireEntitlement("export");
		await vi.waitFor(() => expect(getEntitlement).toHaveBeenCalledOnce());
		expect(useEntitlementStore.getState()).toMatchObject({
			dialogOpen: true,
			blockedCapability: "export",
		});
	});
});

describe("a license key this Mac can no longer read", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		useEntitlementStore.setState({
			snapshot: LICENSED,
			dialogOpen: false,
			blockedCapability: null,
		});
	});

	function stubStorage() {
		const values = new Map<string, string>();
		vi.stubGlobal("window", {
			localStorage: {
				getItem: (key: string) => values.get(key) ?? null,
				setItem: (key: string, value: string) => values.set(key, value),
				removeItem: (key: string) => values.delete(key),
			},
		});
	}

	it("opens the license dialog once, not on every update", () => {
		stubStorage();
		const unreadable: EntitlementSnapshot = {
			...base,
			status: "offline-grace",
			access: "full",
			reactivationRequired: true,
		};
		const store = useEntitlementStore.getState();

		store.setSnapshot(unreadable);
		expect(useEntitlementStore.getState().dialogOpen).toBe(true);
		store.closeDialog();
		store.setSnapshot(unreadable);
		expect(useEntitlementStore.getState().dialogOpen).toBe(false);

		store.setSnapshot(LICENSED);
		store.setSnapshot(unreadable);
		expect(useEntitlementStore.getState().dialogOpen).toBe(true);
	});
});
