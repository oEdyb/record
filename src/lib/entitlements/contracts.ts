const ENTITLEMENT_CAPABILITIES = [
	"record",
	"edit",
	"import",
	"export",
	"automatic-editing",
] as const;

export type EntitlementCapability = (typeof ENTITLEMENT_CAPABILITIES)[number];

type EntitlementStatus =
	| "development"
	| "trial-not-started"
	| "trial-active"
	| "licensed"
	| "offline-grace"
	| "expired";

export interface EntitlementSnapshot {
	version: 1;
	provider: "lemon-squeezy" | null;
	status: EntitlementStatus;
	access: "full" | "read-only";
	commerceConfigured: boolean;
	checkoutAvailable: boolean;
	managementAvailable: boolean;
	trialStartedAt?: string;
	trialEndsAt?: string;
	trialDaysRemaining?: number;
	lastValidatedAt?: string;
	offlineUntil?: string;
	customerEmail?: string;
	/** The saved license key could not be read on this Mac; the user enters it once more. */
	reactivationRequired?: boolean;
}

function hasPaidAccess(snapshot: EntitlementSnapshot): boolean {
	return snapshot.access === "full";
}

export function canUseCapability(
	snapshot: EntitlementSnapshot,
	_capability: EntitlementCapability,
): boolean {
	return hasPaidAccess(snapshot);
}
