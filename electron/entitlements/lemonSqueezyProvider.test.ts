import { describe, expect, it, vi } from "vitest";
import { LemonSqueezyLicenseProvider } from "./lemonSqueezyProvider";

function response(overrides: Record<string, unknown> = {}) {
	return new Response(
		JSON.stringify({
			activated: true,
			valid: true,
			license_key: { status: "active", expires_at: null },
			instance: { id: "instance-1" },
			meta: {
				store_id: 11,
				product_id: 22,
				variant_id: 33,
				customer_email: "creator@example.com",
			},
			...overrides,
		}),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	);
}

describe("LemonSqueezyLicenseProvider", () => {
	it("activates a matching Klippt variant", async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response());
		const provider = new LemonSqueezyLicenseProvider({
			storeId: 11,
			productId: 22,
			variantIds: new Set([33, 34]),
			fetch: fetcher,
		});

		await expect(provider.activate("license-key", "Klippt on Mac")).resolves.toEqual({
			valid: true,
			status: "active",
			instanceId: "instance-1",
			expiresAt: null,
			customerEmail: "creator@example.com",
			error: undefined,
		});
		const request = fetcher.mock.calls[0]?.[1];
		expect(request?.headers).toEqual({
			Accept: "application/json",
			"Content-Type": "application/x-www-form-urlencoded",
		});
		expect(String(request?.body)).toContain("license_key=license-key");
	});

	it("rejects a valid license for another product", async () => {
		const provider = new LemonSqueezyLicenseProvider({
			storeId: 11,
			productId: 22,
			variantIds: new Set([33]),
			fetch: vi.fn<typeof fetch>().mockResolvedValue(
				response({
					meta: { store_id: 11, product_id: 999, variant_id: 33 },
				}),
			),
		});

		await expect(provider.activate("other-license", "Klippt on Mac")).rejects.toThrow(
			"not for Klippt Pro",
		);
	});

	it("returns an inactive validation without granting access", async () => {
		const provider = new LemonSqueezyLicenseProvider({
			storeId: 11,
			productId: 22,
			variantIds: new Set([33]),
			fetch: vi.fn<typeof fetch>().mockResolvedValue(
				response({
					activated: undefined,
					valid: false,
					license_key: { status: "expired", expires_at: "2026-01-01T00:00:00.000Z" },
				}),
			),
		});

		await expect(provider.validate("license", "instance-1")).resolves.toMatchObject({
			valid: false,
			status: "expired",
		});
	});

	it.each([429, 503])("treats HTTP %s as a retryable provider failure", async (status) => {
		const provider = new LemonSqueezyLicenseProvider({
			storeId: 11,
			productId: 22,
			variantIds: new Set([33]),
			fetch: vi.fn<typeof fetch>().mockResolvedValue(
				new Response(JSON.stringify({ error: "Try again later." }), {
					status,
					headers: { "Content-Type": "application/json" },
				}),
			),
		});

		await expect(provider.validate("license", "instance-1")).rejects.toMatchObject({
			kind: "network",
		});
	});

	it("treats a rejected license request as definitive", async () => {
		const provider = new LemonSqueezyLicenseProvider({
			storeId: 11,
			productId: 22,
			variantIds: new Set([33]),
			fetch: vi.fn<typeof fetch>().mockResolvedValue(
				new Response(JSON.stringify({ error: "License key not found." }), {
					status: 404,
					headers: { "Content-Type": "application/json" },
				}),
			),
		});

		await expect(provider.validate("license", "instance-1")).rejects.toMatchObject({
			kind: "rejected",
		});
	});
});
