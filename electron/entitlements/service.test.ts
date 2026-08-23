import { describe, expect, it, vi } from "vitest";
import type { EntitlementConfig } from "./config";
import { type LicenseProvider, LicenseProviderError } from "./provider";
import type { SecretCodec } from "./secretCodec";
import { EntitlementService, type StoredEntitlementState } from "./service";
import type { EntitlementStateStore } from "./stateStore";

const DAY_MS = 24 * 60 * 60 * 1_000;

function config(overrides: Partial<EntitlementConfig> = {}): EntitlementConfig {
	return {
		commerceConfigured: true,
		checkoutUrl: "https://klippt.lemonsqueezy.com/checkout",
		trialDays: 14,
		offlineGraceDays: 7,
		storeId: 11,
		productId: 22,
		variantIds: new Set([33]),
		...overrides,
	};
}

function memoryStore(initial?: StoredEntitlementState) {
	let value = initial;
	const store: EntitlementStateStore<StoredEntitlementState> = {
		read: vi.fn(async () => value),
		write: vi.fn(async (next) => {
			value = structuredClone(next);
		}),
	};
	return { store, read: () => value };
}

const codec: SecretCodec = {
	encrypt: vi.fn(async (value) => Buffer.from(value).toString("base64")),
	decrypt: vi.fn(async (value) => Buffer.from(value, "base64").toString()),
};

function provider(): LicenseProvider {
	return {
		id: "lemon-squeezy",
		activate: vi.fn<LicenseProvider["activate"]>(async () => ({
			valid: true,
			status: "active" as const,
			instanceId: "instance-1",
			expiresAt: null,
			customerEmail: "creator@example.com",
		})),
		validate: vi.fn<LicenseProvider["validate"]>(async () => ({
			valid: true,
			status: "active" as const,
			expiresAt: null,
		})),
		deactivate: vi.fn(async () => undefined),
	};
}

describe("EntitlementService", () => {
	it("keeps development builds unlocked until commerce is configured", async () => {
		const { store } = memoryStore();
		const service = new EntitlementService({
			config: config({ commerceConfigured: false, checkoutUrl: undefined }),
			codec,
			store,
			instanceName: "Klippt on Mac",
		});

		await expect(service.getSnapshot()).resolves.toMatchObject({
			status: "development",
			access: "full",
			commerceConfigured: false,
		});
	});

	it("starts the trial only after the first successful recording", async () => {
		let now = Date.parse("2026-08-23T12:00:00.000Z");
		const { store, read } = memoryStore();
		const service = new EntitlementService({
			config: config(),
			codec,
			store,
			instanceName: "Klippt on Mac",
			now: () => now,
		});

		await expect(service.getSnapshot()).resolves.toMatchObject({
			status: "trial-not-started",
			access: "full",
		});
		await expect(service.noteSuccessfulRecording()).resolves.toMatchObject({
			status: "trial-active",
			trialDaysRemaining: 14,
		});
		expect(read()?.trialStartedAt).toBe("2026-08-23T12:00:00.000Z");

		now += 14 * DAY_MS;
		await expect(service.getSnapshot()).resolves.toMatchObject({
			status: "expired",
			access: "read-only",
		});
		await expect(service.assertCapability("edit")).rejects.toMatchObject({
			code: "ENTITLEMENT_REQUIRED",
		});
	});

	it("stores an encrypted key and grants access after activation", async () => {
		const { store, read } = memoryStore({
			version: 1,
			trialStartedAt: "2026-01-01T00:00:00.000Z",
		});
		const service = new EntitlementService({
			config: config(),
			provider: provider(),
			codec,
			store,
			instanceName: "Klippt on Mac",
			now: () => Date.parse("2026-08-23T12:00:00.000Z"),
		});

		await expect(service.activate("secret-key")).resolves.toMatchObject({
			status: "licensed",
			access: "full",
			customerEmail: "creator@example.com",
		});
		expect(read()?.license?.encryptedKey).toBe(Buffer.from("secret-key").toString("base64"));
		expect(JSON.stringify(read())).not.toContain("secret-key");
	});

	it("uses a bounded offline grace period after a network failure", async () => {
		let now = Date.parse("2026-08-23T12:00:00.000Z");
		const encryptedKey = Buffer.from("secret-key").toString("base64");
		const { store } = memoryStore({
			version: 1,
			license: {
				encryptedKey,
				instanceId: "instance-1",
				valid: true,
				lastValidatedAt: new Date(now).toISOString(),
			},
		});
		const offlineProvider = provider();
		vi.mocked(offlineProvider.validate).mockRejectedValue(
			new LicenseProviderError("offline", "network"),
		);
		const service = new EntitlementService({
			config: config(),
			provider: offlineProvider,
			codec,
			store,
			instanceName: "Klippt on Mac",
			now: () => now,
		});

		await expect(service.refresh()).resolves.toMatchObject({
			status: "offline-grace",
			access: "full",
		});
		now += 8 * DAY_MS;
		await expect(service.getSnapshot()).resolves.toMatchObject({
			status: "expired",
			access: "read-only",
		});
	});
});
