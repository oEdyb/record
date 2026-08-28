import { describe, expect, it, vi } from "vitest";
import {
	assertReleaseOrder,
	checkPublicReleaseOrder,
	compareStableVersions,
} from "./check-update-release-order.mjs";

const sourceSha = "0123456789abcdef0123456789abcdef01234567";

function response(status, body = "") {
	return new Response(body, { status });
}

describe("release update ordering", () => {
	it("compares stable versions numerically", () => {
		expect(compareStableVersions("2.10.0", "2.9.9")).toBe(1);
		expect(compareStableVersions("2.0.0", "2.0.0")).toBe(0);
		expect(compareStableVersions("1.99.0", "2.0.0")).toBe(-1);
	});

	it("rejects an older release and an ambiguous same-version retry", () => {
		expect(() => assertReleaseOrder("2.9.9", sourceSha, { version: "2.10.0" })).toThrow(
			"older release",
		);
		expect(() => assertReleaseOrder("2.10.0", sourceSha, { version: "2.10.0" })).toThrow(
			"different or unknown source commit",
		);
	});

	it("allows a newer release and an exact same-source retry", () => {
		expect(assertReleaseOrder("2.10.0", sourceSha, { version: "2.9.9" })).toBe("newer");
		expect(
			assertReleaseOrder("2.10.0", sourceSha, {
				version: "2.10.0",
				source: { commit: sourceSha },
			}),
		).toBe("exact-retry");
	});

	it("allows the first release only for a real 404", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(response(404));
		await expect(checkPublicReleaseOrder({ version: "2.0.0", sourceSha, fetchImpl })).resolves.toBe(
			"first-release",
		);
		expect(fetchImpl).toHaveBeenCalledOnce();
		const [url, options] = fetchImpl.mock.calls[0];
		expect(url).toBeInstanceOf(URL);
		expect(url.searchParams.get("release-order")).toContain("2.0.0");
		expect(options.cache).toBe("no-store");
	});

	it("fails closed for network, HTTP, and malformed-manifest errors", async () => {
		await expect(
			checkPublicReleaseOrder({
				version: "2.0.0",
				sourceSha,
				fetchImpl: vi.fn().mockRejectedValue(new Error("offline")),
			}),
		).rejects.toThrow("offline");
		await expect(
			checkPublicReleaseOrder({
				version: "2.0.0",
				sourceSha,
				fetchImpl: vi.fn().mockResolvedValue(response(503)),
			}),
		).rejects.toThrow("HTTP 503");
		await expect(
			checkPublicReleaseOrder({
				version: "2.0.0",
				sourceSha,
				fetchImpl: vi.fn().mockResolvedValue(response(200, "not json")),
			}),
		).rejects.toThrow("not valid JSON");
	});
});
