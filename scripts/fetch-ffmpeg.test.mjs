// The pin table in fetch-ffmpeg.mjs is a supply-chain artifact, and that file says
// so itself: "tag, asset name and digest are one unit. Re-pin all three or none."
// Nothing enforced it. A re-pin that moved some entries and not others merges clean
// — the edits do not even touch the same lines — and then fails only on the arch
// nobody builds in CI, where `npm run build:linux` dies on a 404 from the pinned
// release before it has done anything.
//
// That is not hypothetical: the linux-arm64 shared entry arrived naming
// n8.1.2-32-gcfa62de001 while every sibling had already moved to
// n8.1.2-34-g9b6c8969e0. This test is the guard that was missing.
//
import { describe, expect, it } from "vitest";
import { FFMPEG_ARCHIVES, FFMPEG_SHARED_ARCHIVES } from "./ffmpeg-pins.mjs";

const pins = [...Object.values(FFMPEG_ARCHIVES), ...Object.values(FFMPEG_SHARED_ARCHIVES)];
const assets = pins.map((pin) => pin.asset);
const digests = pins.map((pin) => pin.sha256);

/** `ffmpeg-n8.1.2-34-g9b6c8969e0-linuxarm64-lgpl-shared-8.1.tar.xz` -> `n8.1.2-34-g9b6c8969e0`. */
const buildId = (asset) => asset.match(/-(n\d+(?:\.\d+)+-\d+-g[0-9a-f]+)-/)?.[1];

describe("fetch-ffmpeg pins", () => {
	// Without this, a reformat that breaks the regexes above would leave every other
	// assertion iterating an empty array and passing vacuously.
	it("still finds the pin table", () => {
		expect(assets.length).toBeGreaterThanOrEqual(8);
		expect(digests).toHaveLength(assets.length);
	});

	it("names one single ffmpeg build across every pinned asset", () => {
		const byBuild = new Map();
		for (const asset of assets) {
			const id = buildId(asset);
			// Also the "never an `N-…` master snapshot" rule: those carry no n<version>.
			expect(id, `${asset} does not name an n<version>-<n>-g<sha> release build`).toBeDefined();
			byBuild.set(id, [...(byBuild.get(id) ?? []), asset]);
		}
		expect(
			[...byBuild.keys()],
			`The pin table straddles ${byBuild.size} different ffmpeg builds:\n${[...byBuild]
				.map(([id, list]) => `  ${id}\n${list.map((a) => `    ${a}`).join("\n")}`)
				.join("\n")}\nRe-pin every entry together — RELEASE_TAG, asset and digest are one unit.`,
		).toHaveLength(1);
	});

	// One GPL component relicenses the whole binary, which would contaminate this MIT
	// app. assertLgpl() checks the artifact after download; this checks the intent
	// before anyone runs the script.
	it("pins only -lgpl assets", () => {
		for (const asset of assets) {
			expect(asset, `${asset} is not an -lgpl asset`).toMatch(/-lgpl(-shared)?-/);
		}
	});

	it("pins a full sha-256 for every asset", () => {
		for (const digest of digests) {
			expect(digest).toMatch(/^[0-9a-f]{64}$/);
		}
	});
});
