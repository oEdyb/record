import { describe, expect, it } from "vitest";

import { parseSourceAudioLayout, sourceTrackMapArgs } from "./sourceAudio";

describe("sourceTrackMapArgs", () => {
	it("maps native roles to their required isolated tracks", () => {
		expect(sourceTrackMapArgs("you")).toEqual(["-map", "0:m:language:qac"]);
		expect(sourceTrackMapArgs("system")).toEqual(["-map", "0:m:language:qab"]);
	});

	it("uses only the first audio stream for an explicitly mixed import", () => {
		expect(sourceTrackMapArgs("unknown-mixed")).toEqual(["-map", "0:a:0"]);
	});

	it("never selects the native qaa preview mix", () => {
		for (const role of ["you", "system", "unknown-mixed"] as const) {
			expect(sourceTrackMapArgs(role).join(" ")).not.toContain("qaa");
		}
	});
});

describe("parseSourceAudioLayout", () => {
	it("finds isolated Klippt roles without counting output streams", () => {
		const layout = parseSourceAudioLayout(`
  Duration: 00:01:20.500, start: 0.000000, bitrate: 1024 kb/s
  Stream #0:1[0x2](qaa): Audio: aac, 48000 Hz, stereo
  Stream #0:2[0x3](qab): Audio: aac, 48000 Hz, stereo
  Stream #0:3[0x4](qac): Audio: aac, 48000 Hz, stereo
Stream mapping:
  Stream #0:3 -> #0:0
  Stream #0:0(qac): Audio: pcm_f32le
`);
		expect(layout).toEqual({
			hasAudio: true,
			hasKlipptMetadata: true,
			roles: ["you", "system"],
			durationSec: 80.5,
		});
	});

	it("keeps ordinary imported audio explicitly mixed", () => {
		expect(parseSourceAudioLayout("  Stream #0:1(eng): Audio: aac, 48000 Hz, stereo")).toEqual({
			hasAudio: true,
			hasKlipptMetadata: false,
			roles: [],
			durationSec: null,
		});
	});

	it("rejects duplicate private role tags", () => {
		expect(() =>
			parseSourceAudioLayout(`
  Stream #0:1(qac): Audio: aac
  Stream #0:2(qac): Audio: aac
`),
		).toThrow("duplicate qac");
	});

	it("rejects a private title that conflicts with its language tag", () => {
		expect(() =>
			parseSourceAudioLayout(`
  Stream #0:1(qac): Audio: aac
    Metadata:
      title           : screenrec.system.v1
`),
		).toThrow("Conflicting Klippt audio metadata");
	});
});
