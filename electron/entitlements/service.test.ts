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
		testMode: false,
		revalidateEveryHours: 12,
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

	describe("revalidation before read-only", () => {
		const validatedAt = Date.parse("2026-09-01T12:00:00.000Z");
		const storedLicense = (valid = true): StoredEntitlementState => ({
			version: 1,
			trialStartedAt: "2026-08-01T12:00:00.000Z",
			license: {
				encryptedKey: Buffer.from("secret-key").toString("base64"),
				instanceId: "instance-1",
				valid,
				lastValidatedAt: new Date(validatedAt).toISOString(),
			},
		});

		it("keeps a paying user licensed when the grace window ends while the app stays open", async () => {
			const now = validatedAt + 7 * DAY_MS + 1;
			const licensed = provider();
			const { store, read } = memoryStore(storedLicense());
			const service = new EntitlementService({
				config: config(),
				provider: licensed,
				codec,
				store,
				instanceName: "Klippt on Mac",
				now: () => now,
			});

			await expect(service.getSnapshot()).resolves.toMatchObject({
				status: "licensed",
				access: "full",
			});
			await expect(service.assertCapability("record")).resolves.toBeUndefined();
			expect(licensed.validate).toHaveBeenCalledWith("secret-key", "instance-1");
			expect(read()?.license?.lastValidatedAt).toBe(new Date(now).toISOString());
		});

		it("goes read-only after one failed check and does not retry within a minute", async () => {
			let now = validatedAt + 8 * DAY_MS;
			const offline = provider();
			vi.mocked(offline.validate).mockRejectedValue(new LicenseProviderError("offline", "network"));
			const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
			const { store } = memoryStore(storedLicense());
			const service = new EntitlementService({
				config: config(),
				provider: offline,
				codec,
				store,
				instanceName: "Klippt on Mac",
				now: () => now,
			});

			await expect(service.getSnapshot()).resolves.toMatchObject({ access: "read-only" });
			now += 30_000;
			await expect(service.assertCapability("record")).rejects.toMatchObject({
				code: "ENTITLEMENT_REQUIRED",
			});
			expect(offline.validate).toHaveBeenCalledTimes(1);
			warn.mockRestore();
		});

		it("unlocks a renewed subscription as soon as the user tries to record", async () => {
			const renewed = provider();
			const { store } = memoryStore(storedLicense(false));
			const service = new EntitlementService({
				config: config(),
				provider: renewed,
				codec,
				store,
				instanceName: "Klippt on Mac",
				now: () => validatedAt + DAY_MS,
			});

			await expect(service.assertCapability("record")).resolves.toBeUndefined();
			expect(renewed.validate).toHaveBeenCalledTimes(1);
		});

		it("never calls the provider for an expired trial without a license", async () => {
			const lemon = provider();
			const { store } = memoryStore({ version: 1, trialStartedAt: "2026-08-01T12:00:00.000Z" });
			const service = new EntitlementService({
				config: config(),
				provider: lemon,
				codec,
				store,
				instanceName: "Klippt on Mac",
				now: () => validatedAt,
			});

			await expect(service.getSnapshot()).resolves.toMatchObject({ status: "expired" });
			expect(lemon.validate).not.toHaveBeenCalled();
		});

		it("grants access from a successful check even when saving it fails", async () => {
			const { store } = memoryStore(storedLicense());
			vi.mocked(store.write).mockRejectedValue(new Error("disk full"));
			const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
			const service = new EntitlementService({
				config: config(),
				provider: provider(),
				codec,
				store,
				instanceName: "Klippt on Mac",
				now: () => validatedAt + 8 * DAY_MS,
			});

			await expect(service.getSnapshot()).resolves.toMatchObject({ access: "full" });
			warn.mockRestore();
		});

		it("answers read-only after three seconds on a stalled network and broadcasts the late result", async () => {
			vi.useFakeTimers();
			try {
				let finish: (() => void) | undefined;
				const slow = provider();
				vi.mocked(slow.validate).mockImplementation(
					() =>
						new Promise((resolve) => {
							finish = () => resolve({ valid: true, status: "active", expiresAt: null });
						}),
				);
				const { store } = memoryStore(storedLicense());
				const service = new EntitlementService({
					config: config(),
					provider: slow,
					codec,
					store,
					instanceName: "Klippt on Mac",
					now: () => validatedAt + 8 * DAY_MS,
				});
				const changed = vi.fn();
				service.on("changed", changed);

				const pending = service.getSnapshot();
				await vi.advanceTimersByTimeAsync(3_000);
				await expect(pending).resolves.toMatchObject({ access: "read-only" });
				finish?.();
				await vi.advanceTimersByTimeAsync(0);
				expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ access: "full" }));
			} finally {
				vi.useRealTimers();
			}
		});

		it("throttles provider calls on a clock the user cannot set back", async () => {
			let wall = validatedAt + 8 * DAY_MS;
			let monotonic = 1_000;
			const offline = provider();
			vi.mocked(offline.validate).mockRejectedValue(new LicenseProviderError("offline", "network"));
			const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
			const { store } = memoryStore(storedLicense());
			const service = new EntitlementService({
				config: config(),
				provider: offline,
				codec,
				store,
				instanceName: "Klippt on Mac",
				now: () => wall,
				monotonicNow: () => monotonic,
			});

			await service.refresh();
			wall -= 365 * DAY_MS;
			monotonic += 61_000;
			await service.refresh();
			expect(offline.validate).toHaveBeenCalledTimes(2);
			warn.mockRestore();
		});
	});
});

describe("a saved license key that can no longer be decrypted", () => {
	const savedAt = "2026-10-01T00:00:00.000Z";
	const stored = (): StoredEntitlementState => ({
		version: 1,
		trialStartedAt: "2026-09-01T00:00:00.000Z",
		license: {
			encryptedKey: "c2VjcmV0LWtleQ==",
			instanceId: "instance-1",
			valid: true,
			lastValidatedAt: savedAt,
			expiresAt: null,
		},
	});
	const lockedKeychain = (): SecretCodec => ({
		encrypt: vi.fn(async (value) => Buffer.from(value).toString("base64")),
		decrypt: vi.fn(async () => {
			throw new Error(
				"Error while decrypting the ciphertext provided to safeStorage.decryptString.",
			);
		}),
	});

	it("keeps the trial date and offline grace and asks for the key once more", async () => {
		const { store, read } = memoryStore(stored());
		const licenseProvider = provider();
		const service = new EntitlementService({
			config: config(),
			provider: licenseProvider,
			codec: lockedKeychain(),
			store,
			instanceName: "Klippt on Mac",
			now: () => Date.parse("2026-10-02T00:00:00.000Z"),
		});

		await expect(service.refresh()).resolves.toMatchObject({
			status: "offline-grace",
			access: "full",
			reactivationRequired: true,
		});
		expect(licenseProvider.validate).not.toHaveBeenCalled();
		expect(read()?.trialStartedAt).toBe("2026-09-01T00:00:00.000Z");
		expect(read()?.license?.keyUnreadable).toBe(true);
	});

	it("falls back to read-only after the grace without throwing, and keeps the request", async () => {
		const { store } = memoryStore(stored());
		const service = new EntitlementService({
			config: config(),
			provider: provider(),
			codec: lockedKeychain(),
			store,
			instanceName: "Klippt on Mac",
			now: () => Date.parse("2026-10-20T00:00:00.000Z"),
		});

		await expect(service.getSnapshot()).resolves.toMatchObject({
			status: "expired",
			access: "read-only",
			trialStartedAt: "2026-09-01T00:00:00.000Z",
			reactivationRequired: true,
		});
	});

	it("clears the request after the user activates the key again", async () => {
		const { store, read } = memoryStore(stored());
		const service = new EntitlementService({
			config: config(),
			provider: provider(),
			codec: lockedKeychain(),
			store,
			instanceName: "Klippt on Mac",
			now: () => Date.parse("2026-10-20T00:00:00.000Z"),
		});
		await service.refresh();

		const snapshot = await service.activate("secret-key");
		expect(snapshot).toMatchObject({ status: "licensed", access: "full" });
		expect(snapshot.reactivationRequired).toBeUndefined();
		expect(read()?.trialStartedAt).toBe("2026-09-01T00:00:00.000Z");
		expect(read()?.license?.keyUnreadable).toBeUndefined();
	});

	it("recovers on a later refresh once the key decrypts again", async () => {
		const { store, read } = memoryStore(stored());
		const decrypt = vi
			.fn<SecretCodec["decrypt"]>()
			.mockRejectedValueOnce(new Error("User denied Keychain access"))
			.mockResolvedValue("secret-key");
		let clock = 0;
		const service = new EntitlementService({
			config: config(),
			provider: provider(),
			codec: { encrypt: codec.encrypt, decrypt },
			store,
			instanceName: "Klippt on Mac",
			now: () => Date.parse("2026-10-02T00:00:00.000Z"),
			monotonicNow: () => clock,
		});

		await expect(service.refresh()).resolves.toMatchObject({ reactivationRequired: true });
		clock += 61_000;
		const snapshot = await service.refresh();
		expect(snapshot).toMatchObject({ status: "licensed", access: "full" });
		expect(snapshot.reactivationRequired).toBeUndefined();
		expect(read()?.license?.keyUnreadable).toBeUndefined();
	});

	it("still reads an unreadable flag saved by an earlier run", async () => {
		const { store } = memoryStore({
			...stored(),
			license: { ...stored().license!, keyUnreadable: true, validationFailedAt: savedAt },
		});
		const service = new EntitlementService({
			config: config(),
			codec,
			store,
			instanceName: "Klippt on Mac",
			now: () => Date.parse("2026-10-02T00:00:00.000Z"),
		});

		await expect(service.getSnapshot()).resolves.toMatchObject({
			status: "offline-grace",
			reactivationRequired: true,
		});
	});

	it("keeps the existing activation when the same key is entered again", async () => {
		const { store, read } = memoryStore(stored());
		const licenseProvider = provider();
		const service = new EntitlementService({
			config: config(),
			provider: licenseProvider,
			codec: lockedKeychain(),
			store,
			instanceName: "Klippt on Mac",
			now: () => Date.parse("2026-10-02T00:00:00.000Z"),
		});
		await service.refresh();

		await expect(service.activate("secret-key")).resolves.toMatchObject({ access: "full" });
		expect(licenseProvider.validate).toHaveBeenCalledWith("secret-key", "instance-1");
		expect(licenseProvider.activate).not.toHaveBeenCalled();
		expect(read()?.license?.instanceId).toBe("instance-1");
	});

	it("activates a new instance when the old one does not accept the key", async () => {
		const { store, read } = memoryStore(stored());
		const licenseProvider = provider();
		vi.mocked(licenseProvider.validate).mockRejectedValueOnce(
			new LicenseProviderError("license_key not found", "rejected"),
		);
		const service = new EntitlementService({
			config: config(),
			provider: licenseProvider,
			codec: lockedKeychain(),
			store,
			instanceName: "Klippt on Mac",
			now: () => Date.parse("2026-10-02T00:00:00.000Z"),
		});
		await service.refresh();

		await service.activate("new-key");
		expect(licenseProvider.activate).toHaveBeenCalledOnce();
		expect(read()?.license?.instanceId).toBe("instance-1");
		expect(vi.mocked(licenseProvider.activate).mock.calls[0][0]).toBe("new-key");
	});

	it("unlocks for this session when the Keychain refuses to store the key, and never writes it", async () => {
		const { store, read } = memoryStore({ version: 1, trialStartedAt: "2026-09-01T00:00:00.000Z" });
		const licenseProvider = provider();
		const refusing: SecretCodec = {
			encrypt: vi.fn(async () => {
				throw new Error("Secure license storage is not available on this device.");
			}),
			decrypt: vi.fn(async () => {
				throw new Error("unreachable");
			}),
		};
		let clock = 0;
		const service = new EntitlementService({
			config: config(),
			provider: licenseProvider,
			codec: refusing,
			store,
			instanceName: "Klippt on Mac",
			now: () => Date.parse("2026-10-02T00:00:00.000Z"),
			monotonicNow: () => clock,
		});

		const snapshot = await service.activate("secret-key");
		expect(snapshot).toMatchObject({ status: "licensed", access: "full" });
		expect(snapshot.reactivationRequired).toBeUndefined();
		expect(JSON.stringify(read())).not.toContain("secret-key");
		expect(read()?.license?.keyUnreadable).toBe(true);

		clock += 61_000;
		await service.refresh();
		expect(licenseProvider.validate).toHaveBeenLastCalledWith("secret-key", "instance-1");
		expect(refusing.decrypt).not.toHaveBeenCalled();
	});

	it("does not rewrite the state on every refresh while the key stays unreadable", async () => {
		const { store } = memoryStore(stored());
		let clock = 0;
		const service = new EntitlementService({
			config: config(),
			provider: provider(),
			codec: lockedKeychain(),
			store,
			instanceName: "Klippt on Mac",
			now: () => Date.parse("2026-10-02T00:00:00.000Z"),
			monotonicNow: () => clock,
		});
		await service.refresh();
		const writes = vi.mocked(store.write).mock.calls.length;
		clock += 61_000;
		await service.refresh();
		expect(vi.mocked(store.write).mock.calls.length).toBe(writes);
	});
});
