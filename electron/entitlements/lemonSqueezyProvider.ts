import { type LicenseProvider, LicenseProviderError, type LicenseValidation } from "./provider";

interface LemonSqueezyProviderOptions {
	storeId: number;
	productId: number;
	variantIds: ReadonlySet<number>;
	fetch?: typeof globalThis.fetch;
	timeoutMs?: number;
}

type LemonResponse = Record<string, unknown>;

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function numberField(value: unknown): number | undefined {
	const parsed = typeof value === "number" ? value : Number(value);
	return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function stringField(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

export class LemonSqueezyLicenseProvider implements LicenseProvider {
	readonly id = "lemon-squeezy" as const;
	private readonly fetcher: typeof globalThis.fetch;
	private readonly timeoutMs: number;

	constructor(private readonly options: LemonSqueezyProviderOptions) {
		this.fetcher = options.fetch ?? globalThis.fetch;
		this.timeoutMs = options.timeoutMs ?? 10_000;
	}

	async activate(licenseKey: string, instanceName: string): Promise<LicenseValidation> {
		const payload = await this.post("activate", {
			license_key: licenseKey,
			instance_name: instanceName,
		});
		const validation = this.parse(payload);
		if (payload.activated !== true || !validation.valid || !validation.instanceId) {
			throw new LicenseProviderError(
				stringField(payload.error) ?? "Lemon Squeezy did not activate this license.",
				"rejected",
			);
		}
		return validation;
	}

	async validate(licenseKey: string, instanceId: string): Promise<LicenseValidation> {
		const payload = await this.post("validate", {
			license_key: licenseKey,
			instance_id: instanceId,
		});
		return this.parse(payload);
	}

	async deactivate(licenseKey: string, instanceId: string): Promise<void> {
		const payload = await this.post("deactivate", {
			license_key: licenseKey,
			instance_id: instanceId,
		});
		if (payload.deactivated !== true) {
			throw new LicenseProviderError(
				stringField(payload.error) ?? "Lemon Squeezy did not deactivate this license.",
				"rejected",
			);
		}
	}

	private async post(
		action: "activate" | "validate" | "deactivate",
		parameters: Record<string, string>,
	): Promise<LemonResponse> {
		const signal = AbortSignal.timeout(this.timeoutMs);
		let response: Response;
		try {
			response = await this.fetcher(`https://api.lemonsqueezy.com/v1/licenses/${action}`, {
				method: "POST",
				headers: {
					Accept: "application/json",
					"Content-Type": "application/x-www-form-urlencoded",
				},
				body: new URLSearchParams(parameters),
				signal,
			});
		} catch (error) {
			throw new LicenseProviderError("Could not reach Lemon Squeezy.", "network", {
				cause: error,
			});
		}

		let payload: unknown;
		try {
			payload = await response.json();
		} catch (error) {
			throw new LicenseProviderError(
				"Lemon Squeezy returned an invalid response.",
				"invalid-response",
				{
					cause: error,
				},
			);
		}
		const parsed = record(payload);
		if (!parsed) {
			throw new LicenseProviderError(
				"Lemon Squeezy returned an invalid response.",
				"invalid-response",
			);
		}
		if (!response.ok) {
			const retryable =
				response.status === 408 || response.status === 429 || response.status >= 500;
			throw new LicenseProviderError(
				stringField(parsed.error) ?? `Lemon Squeezy returned HTTP ${response.status}.`,
				retryable ? "network" : "rejected",
			);
		}
		return parsed;
	}

	private parse(payload: LemonResponse): LicenseValidation {
		const licenseKey = record(payload.license_key);
		const instance = record(payload.instance);
		const meta = record(payload.meta);
		if (!licenseKey || !meta) {
			throw new LicenseProviderError(
				"Lemon Squeezy returned incomplete license data.",
				"invalid-response",
			);
		}

		const storeId = numberField(meta.store_id);
		const productId = numberField(meta.product_id);
		const variantId = numberField(meta.variant_id);
		if (
			storeId !== this.options.storeId ||
			productId !== this.options.productId ||
			variantId === undefined ||
			!this.options.variantIds.has(variantId)
		) {
			throw new LicenseProviderError("This license is not for Klippt Pro.", "rejected");
		}

		const statusValue = stringField(licenseKey.status);
		const status =
			statusValue === "inactive" ||
			statusValue === "active" ||
			statusValue === "expired" ||
			statusValue === "disabled"
				? statusValue
				: "unknown";
		const responseValid =
			payload.valid === undefined ? payload.activated === true : payload.valid === true;

		return {
			valid: responseValid && status === "active",
			status,
			instanceId: stringField(instance?.id),
			expiresAt: licenseKey.expires_at === null ? null : stringField(licenseKey.expires_at),
			customerEmail: stringField(meta.customer_email),
			error: stringField(payload.error),
		};
	}
}
