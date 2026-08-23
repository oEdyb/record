import { describe, expect, it, vi } from "vitest";
import { checkLatestRelease, compareVersions } from "./update-checker";

function releaseResponse(payload: unknown, status = 200) {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: vi.fn().mockResolvedValue(payload),
	};
}

const downloads = {
	"darwin-arm64": "https://updates.dyberg.co/klippt/Klippt-macOS-Apple-Silicon-1.10.0.dmg",
	"darwin-x64": "https://updates.dyberg.co/klippt/Klippt-macOS-Intel-1.10.0.dmg",
	"win32-x64": "https://updates.dyberg.co/klippt/Klippt.Setup.1.10.0.exe",
	"linux-x64": "https://updates.dyberg.co/klippt/Klippt-Linux-1.10.0.AppImage",
};

const options = {
	platform: "darwin" as const,
	arch: "arm64",
};

describe("compareVersions", () => {
	it("implements semantic version ordering for stable and prerelease builds", () => {
		expect(compareVersions("v2.0.0", "1.9.9")).toBeGreaterThan(0);
		expect(compareVersions("1.9.0", "1.9.0-rc.2")).toBeGreaterThan(0);
		expect(compareVersions("1.9.0-rc.10", "1.9.0-rc.2")).toBeGreaterThan(0);
		expect(compareVersions("1.9.0+build.2", "v1.9.0+build.1")).toBe(0);
	});

	it("preserves precision for oversized core identifiers", () => {
		expect(compareVersions("9007199254740993.0.0", "9007199254740992.0.0")).toBeGreaterThan(0);
	});

	it.each([
		"01.0.0",
		"1.02.0",
		"1.0.03",
		"1.0.0-rc.01",
	])("rejects leading-zero numeric identifiers in %s", (version) => {
		expect(() => compareVersions(version, "1.0.0")).toThrow("invalid semantic version");
	});
});

describe("checkLatestRelease", () => {
	it("reports a newer release from Klippt's owned feed", async () => {
		const fetchLatest = vi.fn().mockResolvedValue(
			releaseResponse({
				version: "1.10.0",
				downloads,
			}),
		);

		await expect(
			checkLatestRelease({ currentVersion: "1.9.0", fetchLatest, ...options }),
		).resolves.toEqual({
			kind: "available",
			currentVersion: "1.9.0",
			latestVersion: "1.10.0",
			releaseUrl: downloads["darwin-arm64"],
		});
		expect(fetchLatest).toHaveBeenCalledWith(
			"https://updates.dyberg.co/klippt/latest.json",
			expect.objectContaining({
				headers: expect.objectContaining({ Accept: "application/json" }),
			}),
		);
	});

	it("selects the download for the current platform and architecture", async () => {
		const fetchLatest = vi
			.fn()
			.mockResolvedValue(releaseResponse({ version: "1.10.0", downloads }));
		await expect(
			checkLatestRelease({
				currentVersion: "1.9.0",
				platform: "win32",
				arch: "x64",
				fetchLatest,
			}),
		).resolves.toMatchObject({ releaseUrl: downloads["win32-x64"] });
	});

	it("reports current when the installed version is equal or newer", async () => {
		const fetchLatest = vi.fn().mockResolvedValue(releaseResponse({ version: "1.9.0", downloads }));

		await expect(
			checkLatestRelease({ currentVersion: "1.9.1", fetchLatest, ...options }),
		).resolves.toEqual({
			kind: "current",
			currentVersion: "1.9.1",
			latestVersion: "1.9.0",
		});
		await expect(
			checkLatestRelease({ currentVersion: "1.9.0", fetchLatest, ...options }),
		).resolves.toEqual({
			kind: "current",
			currentVersion: "1.9.0",
			latestVersion: "1.9.0",
		});
	});

	it("forwards the cancellation signal", async () => {
		const fetchLatest = vi.fn().mockResolvedValue(releaseResponse({ version: "1.9.0", downloads }));
		const controller = new AbortController();

		await checkLatestRelease({
			currentVersion: "1.9.0",
			fetchLatest,
			signal: controller.signal,
			...options,
		});

		expect(fetchLatest).toHaveBeenCalledWith(
			"https://updates.dyberg.co/klippt/latest.json",
			expect.objectContaining({ signal: controller.signal }),
		);
	});

	it("rejects a download URL outside the owned update host", async () => {
		const fetchLatest = vi.fn().mockResolvedValue(
			releaseResponse({
				version: "9.9.9",
				downloads: { ...downloads, "darwin-arm64": "https://example.com/Klippt.dmg" },
			}),
		);

		await expect(
			checkLatestRelease({ currentVersion: "1.9.0", fetchLatest, ...options }),
		).rejects.toThrow("untrusted release URL");
	});

	it.each([
		"http://updates.dyberg.co/klippt/Klippt.dmg",
		"https://updates.dyberg.co/other/Klippt.dmg",
		"https://updates.dyberg.co/klippt/Klippt.dmg?token=secret",
		"https://updates.dyberg.co/klippt/Klippt.dmg#download",
	])("rejects an invalid owned-feed URL: %s", async (downloadUrl) => {
		const fetchLatest = vi.fn().mockResolvedValue(
			releaseResponse({
				version: "9.9.9",
				downloads: { ...downloads, "darwin-arm64": downloadUrl },
			}),
		);

		await expect(
			checkLatestRelease({ currentVersion: "1.9.0", fetchLatest, ...options }),
		).rejects.toThrow("untrusted release URL");
	});

	it("rejects unavailable, malformed, and incomplete feeds", async () => {
		const unavailable = vi.fn().mockResolvedValue(releaseResponse({}, 503));
		await expect(
			checkLatestRelease({ currentVersion: "1.9.0", fetchLatest: unavailable, ...options }),
		).rejects.toThrow("Klippt release check failed (503)");

		const malformed = vi.fn().mockResolvedValue(releaseResponse({ version: "2.0.0" }));
		await expect(
			checkLatestRelease({ currentVersion: "1.9.0", fetchLatest: malformed, ...options }),
		).rejects.toThrow("invalid Klippt release response");

		const missingPlatform = vi
			.fn()
			.mockResolvedValue(releaseResponse({ version: "2.0.0", downloads }));
		await expect(
			checkLatestRelease({
				currentVersion: "1.9.0",
				platform: "freebsd",
				arch: "x64",
				fetchLatest: missingPlatform,
			}),
		).rejects.toThrow("no download for freebsd-x64");
	});
});
