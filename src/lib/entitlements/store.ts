import { create } from "zustand";
import {
	canUseCapability,
	type EntitlementCapability,
	type EntitlementSnapshot,
} from "./contracts";

const DEVELOPMENT_ENTITLEMENT: EntitlementSnapshot = {
	version: 1,
	provider: null,
	status: "development",
	access: "full",
	commerceConfigured: false,
	checkoutAvailable: false,
	managementAvailable: false,
};

let expirationTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleAccessBoundary(snapshot: EntitlementSnapshot): void {
	if (expirationTimer) clearTimeout(expirationTimer);
	expirationTimer = null;
	const boundary = snapshot.trialEndsAt ?? snapshot.offlineUntil;
	if (snapshot.access !== "full" || !boundary) return;
	const delay = Date.parse(boundary) - Date.now() + 250;
	if (!Number.isFinite(delay)) return;
	expirationTimer = setTimeout(
		() => {
			void window.electronAPI
				.getEntitlement()
				.then((next) => useEntitlementStore.getState().setSnapshot(next))
				.catch((error) => console.warn("Could not refresh Klippt access boundary:", error));
		},
		Math.max(0, Math.min(delay, 2_147_483_647)),
	);
}

interface EntitlementRendererState {
	snapshot: EntitlementSnapshot;
	loaded: boolean;
	dialogOpen: boolean;
	blockedCapability: EntitlementCapability | null;
	busy: boolean;
	error: string | null;
	setSnapshot: (snapshot: EntitlementSnapshot) => void;
	openDialog: (capability?: EntitlementCapability) => void;
	closeDialog: () => void;
	activate: (licenseKey: string) => Promise<boolean>;
	refresh: () => Promise<void>;
	openCheckout: () => Promise<void>;
	openManagement: () => Promise<void>;
}

export const useEntitlementStore = create<EntitlementRendererState>((set, get) => ({
	snapshot: DEVELOPMENT_ENTITLEMENT,
	loaded: false,
	dialogOpen: false,
	blockedCapability: null,
	busy: false,
	error: null,
	setSnapshot: (snapshot) => {
		scheduleAccessBoundary(snapshot);
		set({ snapshot, loaded: true, error: null });
	},
	openDialog: (blockedCapability = undefined) =>
		set({ dialogOpen: true, blockedCapability: blockedCapability ?? null, error: null }),
	closeDialog: () => set({ dialogOpen: false, blockedCapability: null, error: null }),
	async activate(licenseKey) {
		set({ busy: true, error: null });
		try {
			const snapshot = await window.electronAPI.activateEntitlement(licenseKey);
			set({ snapshot, loaded: true, busy: false, dialogOpen: snapshot.access !== "full" });
			return snapshot.access === "full";
		} catch (error) {
			set({ busy: false, error: error instanceof Error ? error.message : String(error) });
			return false;
		}
	},
	async refresh() {
		try {
			const snapshot = await window.electronAPI.refreshEntitlement();
			get().setSnapshot(snapshot);
		} catch (error) {
			set({ error: error instanceof Error ? error.message : String(error) });
		}
	},
	async openCheckout() {
		set({ busy: true, error: null });
		try {
			await window.electronAPI.openEntitlementCheckout();
		} catch (error) {
			set({ error: error instanceof Error ? error.message : String(error) });
		} finally {
			set({ busy: false });
		}
	},
	async openManagement() {
		set({ busy: true, error: null });
		try {
			await window.electronAPI.openEntitlementManagement();
		} catch (error) {
			set({ error: error instanceof Error ? error.message : String(error) });
		} finally {
			set({ busy: false });
		}
	},
}));

let removeEntitlementListener: (() => void) | null = null;

export async function initializeEntitlements(): Promise<() => void> {
	removeEntitlementListener?.();
	removeEntitlementListener = null;
	const api = window.electronAPI;
	if (!api?.getEntitlement || !api.onEntitlementChanged) {
		useEntitlementStore.getState().setSnapshot(DEVELOPMENT_ENTITLEMENT);
		return () => undefined;
	}
	const snapshot = await api.getEntitlement();
	useEntitlementStore.getState().setSnapshot(snapshot);
	removeEntitlementListener = api.onEntitlementChanged((next) => {
		useEntitlementStore.getState().setSnapshot(next);
	});
	if (snapshot.provider) void useEntitlementStore.getState().refresh();
	return () => {
		removeEntitlementListener?.();
		removeEntitlementListener = null;
		if (expirationTimer) clearTimeout(expirationTimer);
		expirationTimer = null;
	};
}

export function requireEntitlement(capability: EntitlementCapability): boolean {
	const state = useEntitlementStore.getState();
	if (canUseCapability(state.snapshot, capability)) return true;
	state.openDialog(capability);
	return false;
}

export function currentEntitlement(): EntitlementSnapshot {
	return useEntitlementStore.getState().snapshot;
}
