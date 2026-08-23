export interface LicenseValidation {
	valid: boolean;
	status: "inactive" | "active" | "expired" | "disabled" | "unknown";
	instanceId?: string;
	expiresAt?: string | null;
	customerEmail?: string;
	error?: string;
}

export interface LicenseProvider {
	readonly id: "lemon-squeezy";
	activate(licenseKey: string, instanceName: string): Promise<LicenseValidation>;
	validate(licenseKey: string, instanceId: string): Promise<LicenseValidation>;
	deactivate(licenseKey: string, instanceId: string): Promise<void>;
}

export class LicenseProviderError extends Error {
	readonly kind: "network" | "invalid-response" | "rejected";

	constructor(
		message: string,
		kind: "network" | "invalid-response" | "rejected",
		options?: { cause?: unknown },
	) {
		super(message);
		this.name = "LicenseProviderError";
		this.kind = kind;
		if (options && "cause" in options) {
			(this as Error & { cause?: unknown }).cause = options.cause;
		}
	}
}
