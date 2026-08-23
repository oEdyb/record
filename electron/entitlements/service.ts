import { EventEmitter } from "node:events";
import type {
	EntitlementCapability,
	EntitlementSnapshot,
} from "../../src/lib/entitlements/contracts";
import type { EntitlementConfig } from "./config";
import { type LicenseProvider, LicenseProviderError } from "./provider";
import type { SecretCodec } from "./secretCodec";
import type { EntitlementStateStore } from "./stateStore";

const DAY_MS = 24 * 60 * 60 * 1_000;

interface StoredLicense {
	encryptedKey: string;
	instanceId: string;
	valid: boolean;
	lastValidatedAt: string;
	expiresAt?: string | null;
	customerEmail?: string;
	validationFailedAt?: string;
}

export interface StoredEntitlementState {
	version: 1;
	trialStartedAt?: string;
	license?: StoredLicense;
}

interface EntitlementServiceOptions {
	config: EntitlementConfig;
	provider?: LicenseProvider;
	codec: SecretCodec;
	store: EntitlementStateStore<StoredEntitlementState>;
	instanceName: string;
	now?: () => number;
}

export class EntitlementRequiredError extends Error {
	readonly code = "ENTITLEMENT_REQUIRED";

	constructor(readonly capability: EntitlementCapability) {
		super(`Klippt Pro is required to ${capability.replace(/-/g, " ")}.`);
		this.name = "EntitlementRequiredError";
	}
}

function validIso(value: unknown): value is string {
	return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function normalizeStoredState(value: unknown): StoredEntitlementState {
	if (!value || typeof value !== "object") return { version: 1 };
	const candidate = value as Partial<StoredEntitlementState>;
	const normalized: StoredEntitlementState = {
		version: 1,
		...(validIso(candidate.trialStartedAt) ? { trialStartedAt: candidate.trialStartedAt } : {}),
	};
	const license = candidate.license;
	if (
		license &&
		typeof license === "object" &&
		typeof license.encryptedKey === "string" &&
		typeof license.instanceId === "string" &&
		typeof license.valid === "boolean" &&
		validIso(license.lastValidatedAt)
	) {
		normalized.license = {
			encryptedKey: license.encryptedKey,
			instanceId: license.instanceId,
			valid: license.valid,
			lastValidatedAt: license.lastValidatedAt,
			...(license.expiresAt === null || validIso(license.expiresAt)
				? { expiresAt: license.expiresAt }
				: {}),
			...(typeof license.customerEmail === "string"
				? { customerEmail: license.customerEmail }
				: {}),
			...(validIso(license.validationFailedAt)
				? { validationFailedAt: license.validationFailedAt }
				: {}),
		};
	}
	return normalized;
}

export class EntitlementService extends EventEmitter {
	private state: StoredEntitlementState = { version: 1 };
	private readonly ready: Promise<void>;
	private mutationQueue: Promise<unknown> = Promise.resolve();
	private readonly now: () => number;
	private lastRefreshAttemptAt = 0;

	constructor(private readonly options: EntitlementServiceOptions) {
		super();
		this.now = options.now ?? Date.now;
		this.ready = options.store.read().then((value) => {
			this.state = normalizeStoredState(value);
		});
	}

	async getSnapshot(): Promise<EntitlementSnapshot> {
		await this.ready;
		return this.buildSnapshot();
	}

	async assertCapability(capability: EntitlementCapability): Promise<void> {
		const snapshot = await this.getSnapshot();
		if (snapshot.access !== "full") throw new EntitlementRequiredError(capability);
	}

	async noteSuccessfulRecording(): Promise<EntitlementSnapshot> {
		return this.mutate(async () => {
			if (!this.options.config.commerceConfigured || this.state.trialStartedAt) {
				return this.buildSnapshot();
			}
			this.state = { ...this.state, trialStartedAt: new Date(this.now()).toISOString() };
			await this.persistAndEmit();
			return this.buildSnapshot();
		});
	}

	async activate(licenseKey: string): Promise<EntitlementSnapshot> {
		const normalizedKey = licenseKey.trim();
		if (!normalizedKey) throw new Error("Enter a license key.");
		return this.mutate(async () => {
			const provider = this.requireProvider();
			const encryptedKey = await this.options.codec.encrypt(normalizedKey);
			const validation = await provider.activate(normalizedKey, this.options.instanceName);
			if (!validation.valid || !validation.instanceId) {
				throw new Error(validation.error ?? "This license is not active.");
			}
			const validatedAt = new Date(this.now()).toISOString();
			this.state = {
				...this.state,
				trialStartedAt: this.state.trialStartedAt ?? validatedAt,
				license: {
					encryptedKey,
					instanceId: validation.instanceId,
					valid: true,
					lastValidatedAt: validatedAt,
					expiresAt: validation.expiresAt,
					customerEmail: validation.customerEmail,
				},
			};
			await this.persistAndEmit();
			return this.buildSnapshot();
		});
	}

	async refresh(): Promise<EntitlementSnapshot> {
		return this.mutate(async () => {
			if (this.now() - this.lastRefreshAttemptAt < 60_000) return this.buildSnapshot();
			this.lastRefreshAttemptAt = this.now();
			const license = this.state.license;
			if (!license || !this.options.provider) return this.buildSnapshot();
			let licenseKey: string;
			try {
				licenseKey = await this.options.codec.decrypt(license.encryptedKey);
			} catch (error) {
				console.warn("Could not decrypt the Klippt license:", error);
				return this.markValidationFailure();
			}

			try {
				const validation = await this.options.provider.validate(licenseKey, license.instanceId);
				this.state = {
					...this.state,
					license: {
						...license,
						valid: validation.valid,
						lastValidatedAt: new Date(this.now()).toISOString(),
						expiresAt: validation.expiresAt,
						customerEmail: validation.customerEmail ?? license.customerEmail,
						validationFailedAt: undefined,
					},
				};
				await this.persistAndEmit();
				return this.buildSnapshot();
			} catch (error) {
				if (error instanceof LicenseProviderError && error.kind === "rejected") {
					this.state = { ...this.state, license: { ...license, valid: false } };
					await this.persistAndEmit();
					return this.buildSnapshot();
				}
				console.warn("Could not refresh the Klippt license:", error);
				return this.markValidationFailure();
			}
		});
	}

	async deactivate(): Promise<EntitlementSnapshot> {
		return this.mutate(async () => {
			const license = this.state.license;
			if (!license) return this.buildSnapshot();
			const provider = this.requireProvider();
			const licenseKey = await this.options.codec.decrypt(license.encryptedKey);
			await provider.deactivate(licenseKey, license.instanceId);
			this.state = { ...this.state, license: undefined };
			await this.persistAndEmit();
			return this.buildSnapshot();
		});
	}

	private async markValidationFailure(): Promise<EntitlementSnapshot> {
		const license = this.state.license;
		if (!license) return this.buildSnapshot();
		this.state = {
			...this.state,
			license: {
				...license,
				validationFailedAt: license.validationFailedAt ?? new Date(this.now()).toISOString(),
			},
		};
		await this.persistAndEmit();
		return this.buildSnapshot();
	}

	private buildSnapshot(): EntitlementSnapshot {
		const { config } = this.options;
		const base = {
			version: 1 as const,
			provider: config.commerceConfigured ? ("lemon-squeezy" as const) : null,
			commerceConfigured: config.commerceConfigured,
			checkoutAvailable: Boolean(config.checkoutUrl),
			managementAvailable: Boolean(config.managementUrl),
		};
		if (!config.commerceConfigured) {
			return { ...base, status: "development", access: "full" };
		}

		const forced = config.forceStatus;
		if (forced) {
			if (forced === "expired") return { ...base, status: forced, access: "read-only" };
			if (forced === "trial-active") {
				const trialStartedAt = new Date(this.now() - 7 * DAY_MS).toISOString();
				return {
					...base,
					status: forced,
					access: "full",
					trialStartedAt,
					trialEndsAt: new Date(
						Date.parse(trialStartedAt) + config.trialDays * DAY_MS,
					).toISOString(),
					trialDaysRemaining: 7,
				};
			}
			return { ...base, status: forced, access: "full" };
		}

		const license = this.state.license;
		if (license?.valid) {
			const lastValidated = Date.parse(license.lastValidatedAt);
			const offlineUntil = lastValidated + config.offlineGraceDays * DAY_MS;
			const expiresAt = license.expiresAt
				? Date.parse(license.expiresAt)
				: Number.POSITIVE_INFINITY;
			if (this.now() <= offlineUntil && this.now() < expiresAt) {
				return {
					...base,
					status: license.validationFailedAt ? "offline-grace" : "licensed",
					access: "full",
					lastValidatedAt: license.lastValidatedAt,
					offlineUntil: new Date(Math.min(offlineUntil, expiresAt)).toISOString(),
					customerEmail: license.customerEmail,
				};
			}
		}

		const trialStartedAt = this.state.trialStartedAt;
		if (license && !trialStartedAt) {
			return { ...base, status: "expired", access: "read-only" };
		}
		if (!trialStartedAt) return { ...base, status: "trial-not-started", access: "full" };
		const trialEndsAtMs = Date.parse(trialStartedAt) + config.trialDays * DAY_MS;
		if (this.now() < trialEndsAtMs) {
			return {
				...base,
				status: "trial-active",
				access: "full",
				trialStartedAt,
				trialEndsAt: new Date(trialEndsAtMs).toISOString(),
				trialDaysRemaining: Math.max(1, Math.ceil((trialEndsAtMs - this.now()) / DAY_MS)),
			};
		}
		return {
			...base,
			status: "expired",
			access: "read-only",
			trialStartedAt,
			trialEndsAt: new Date(trialEndsAtMs).toISOString(),
			trialDaysRemaining: 0,
		};
	}

	private requireProvider(): LicenseProvider {
		if (!this.options.provider) throw new Error("Klippt billing is not configured yet.");
		return this.options.provider;
	}

	private async persistAndEmit(): Promise<void> {
		await this.options.store.write(this.state);
		this.emit("changed", this.buildSnapshot());
	}

	private async mutate<T>(operation: () => Promise<T>): Promise<T> {
		const run = this.mutationQueue.then(async () => {
			await this.ready;
			return operation();
		});
		this.mutationQueue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}
}
