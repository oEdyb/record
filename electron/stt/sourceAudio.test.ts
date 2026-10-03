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

it("reads video dimensions and duration from the same input header", () => {
	expect(
		parseSourceAudioLayout(`
 Duration: 00:00:08.250, start: 0.000000, bitrate: 1024 kb/s
 Stream #0:0[0x1](und): Video: h264 (High), yuv420p(tv, bt709), 1080x1920 [SAR 1:1 DAR 9:16], 60 fps
 Stream #0:1(eng): Audio: aac, 48000 Hz, stereo
Stream mapping:
 Stream #0:0(und): Video: h264, yuv420p, 1920x1080, 30 fps
`),
	).toMatchObject({
		durationSec: 8.25,
		video: { codec: "h264", width: 1080, height: 1920, fps: 60 },
	});
	expect(parseSourceAudioLayout("Stream #0:0: Video: h264, unknown").video).toBeUndefined();
});
