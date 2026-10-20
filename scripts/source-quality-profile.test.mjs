import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import {
	analyzePacketCadence,
	assertCleanNativeStop,
	assertKnownSystemSignal,
	chromeLaunchServicesArgs,
	compareQualityReports,
	createOwnedCutOperations,
	createQualityFixture,
	cssContrastRatio,
	executeProfileCli,
	installedCaptureConfiguration,
	installedCaptureProcesses,
	matchSourceCopy,
	nativeWarningEventsFromDiagnostic,
	otioExpectedTracks,
	ownedCaptureProcessPid,
	ownedChromeProcessPids,
	summarizeDecodedAudioSignal,
	summarizeDecodedDuplicates,
	summarizeLiveProcessSamples,
	summarizeVideoProbe,
	verifyResolveTracks,
	verifySelectedQuality,
} from "./source-quality-profile-utils.mjs";

describe("real source-quality evidence", () => {
	it("keeps the controller event loop available while a CLI child waits on its broker", async () => {
		const server = createServer((socket) => socket.end("editor-ready"));
		await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			const port = server.address().port;
			const script = `const net = require('node:net'); const socket = net.connect(${port}, '127.0.0.1'); socket.on('data', data => process.stdout.write(data)); socket.on('error', error => { console.error(error); process.exitCode = 1; });`;
			const result = await executeProfileCli(process.execPath, ["-e", script], { timeout: 2000 });
			expect(result.stdout).toBe("editor-ready");
		} finally {
			await new Promise((resolve) => server.close(resolve));
		}
	});
	it("samples only the exact development capture child, never the installed or unrelated helper", () => {
		const helper =
			"/Users/olle/dev/screenrec/electron/native/screencapturekit/build/klippt-screencapturekit-helper";
		const rows = `11 99 ${helper}\n12 1 ${helper}\n13 99 /Applications/Klippt.app/Contents/Resources/klippt-screencapturekit-helper\n14 99 ${helper}-other`;
		expect(ownedCaptureProcessPid(rows, helper, 99)).toBe(11);
		expect(ownedCaptureProcessPid(rows, helper, 123)).toBeUndefined();
		expect(() => ownedCaptureProcessPid(rows, "/Applications/Klippt.app/helper", 99)).toThrow();
		expect(() => ownedCaptureProcessPid(`${rows}\n15 99 ${helper}`, helper, 99)).toThrow();
	});
	it("requires decoded known-tone RMS and peak linked to the actual system original", () => {
		const tone = Float32Array.from(
			{ length: 48000 },
			(_, i) => 0.04 * Math.sin((2 * Math.PI * 440 * i) / 48000),
		);
		const signal = summarizeDecodedAudioSignal(tone);
		expect(signal.rms).toBeCloseTo(0.04 / Math.sqrt(2), 6);
		expect(signal.peak).toBeCloseTo(0.04, 6);
		const pair = {
			original: "/tmp/original-system.mov",
			sha256: "a".repeat(64),
			systemSignal: { ...signal, original: "/tmp/original-system.mov", sha256: "a".repeat(64) },
		};
		expect(assertKnownSystemSignal(pair)).toBe(true);
		for (const invalid of [
			undefined,
			summarizeDecodedAudioSignal(new Float32Array(48000)),
			summarizeDecodedAudioSignal(new Float32Array(48000).fill(0.00002)),
			{ ...signal, original: "/tmp/other.mov" },
			{ ...signal, sha256: "b".repeat(64) },
			{ ...pair.systemSignal, rms: NaN },
			{ ...pair.systemSignal, peak: Infinity },
			{ ...pair.systemSignal, durationSec: 0.01 },
			{ ...pair.systemSignal, durationSec: Infinity },
		])
			expect(() =>
				assertKnownSystemSignal({
					...pair,
					systemSignal: invalid ? { ...pair.systemSignal, ...invalid } : undefined,
				}),
			).toThrow();
		expect(() => summarizeDecodedAudioSignal([])).toThrow();
		expect(() => summarizeDecodedAudioSignal([NaN])).toThrow();
	});
	it("cleans reparented LaunchServices Chrome only by exact executable and unique profile", () => {
		const profile = "/tmp/klippt-source-profile-AbC123/chrome-profile";
		const executable = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
		const ps = [
			`11 99 ${executable} --user-data-dir=${profile}`,
			`12 1 ${executable} --user-data-dir=${profile} --remote-debugging-port=0`,
			`13 1 ${executable} --user-data-dir=${profile}-other`,
			`14 1 ${executable} --user-data-dir=/Users/olle/real-profile`,
			`15 1 ${executable} Helper --user-data-dir=${profile}`,
		].join("\n");
		expect(ownedChromeProcessPids(ps, profile, 99)).toEqual([11]);
		expect(ownedChromeProcessPids(ps, profile, 99, true)).toEqual([11, 12]);
	});
	it("launches only an isolated Chrome profile through LaunchServices without a mute flag", () => {
		const args = chromeLaunchServicesArgs("/tmp/klippt-source-profile-AbC123/chrome-profile");
		expect(args.slice(0, 4)).toEqual(["-n", "-a", "/Applications/Google Chrome.app", "--args"]);
		expect(args).toContain("--user-data-dir=/tmp/klippt-source-profile-AbC123/chrome-profile");
		expect(args).toContain("--remote-debugging-port=0");
		expect(args).not.toContain("--mute-audio");
		for (const profile of [
			"/Users/olle/Library/Application Support/Google/Chrome",
			"/tmp/klippt-source-profile-AbC123/../chrome-profile",
		])
			expect(() => chromeLaunchServicesArgs(profile)).toThrow();
	});
	it("audits real helper warning events separately from Stop envelope and stderr text", () => {
		const warning = { event: "warning", code: "audio-mixer-tail-dropped", message: "Tail dropped" };
		expect(
			nativeWarningEventsFromDiagnostic({
				helperOutput: {
					mac: `stderr text\n${JSON.stringify({ event: "ready" })}\n${JSON.stringify(warning)}`,
				},
			}),
		).toEqual([warning]);
		expect(nativeWarningEventsFromDiagnostic({ helperOutput: { mac: "" } })).toEqual([]);
	});
	it("rejects normal Stop recovery, warnings, failures and provisional clips", () => {
		const clean = {
			success: true,
			message: "Native macOS recording session stored successfully",
			session: { clips: [{ durationMs: 120000 }] },
		};
		expect(assertCleanNativeStop(clean)).toBe(true);
		for (const result of [
			undefined,
			{ ...clean, success: false },
			{ ...clean, session: undefined },
			{ ...clean, session: { clips: [] } },
			{ ...clean, session: { clips: [{ durationMs: Number.NaN }] } },
			{ ...clean, warning: "Cannot append media data after ending session" },
			{ ...clean, message: "Native macOS recording recovered without the failed final clip" },
			{ ...clean, session: { clips: [{ durationMs: 60000, provisionalDuration: true }] } },
		])
			expect(() => assertCleanNativeStop(result)).toThrow();
	});
	it("observes installed capture load separately and keeps original paths and device identifiers out", () => {
		const executable =
			"/Applications/Klippt.app/Contents/Resources/electron/native/bin/darwin-arm64/klippt-screencapturekit-helper";
		expect(installedCaptureProcesses(`1 0 3.5 1024 Electron\n2 1 20.5 2048 ${executable}`)).toEqual(
			[{ pid: 2, parentPid: 1, cpuPercent: 20.5, rssKiB: 2048 }],
		);
		expect(installedCaptureProcesses("1 0 3.5 1024 /tmp/klippt-screencapturekit-helper")).toEqual(
			[],
		);
		const configuration = installedCaptureConfiguration(
			`${executable} ${JSON.stringify({
				source: { type: "window", windowId: 12345 },
				video: { fps: 60, width: 3840, height: 2160, bitrate: 68000000 },
				audio: { system: { enabled: true }, microphone: { enabled: true, deviceId: "private" } },
				webcam: { enabled: false },
				outputs: { screenPath: "/private/user/recording.mp4" },
			})}`,
		);
		expect(configuration).toMatchObject({
			sourceType: "window",
			video: { fps: 60, bitrate: 68000000 },
			systemAudio: true,
			microphoneAudio: true,
			camera: false,
		});
		expect(JSON.stringify(configuration)).not.toContain("private");
		expect(JSON.stringify(configuration)).not.toContain("windowId");
		expect(installedCaptureConfiguration(`${executable} invalid`)).toBeNull();
		expect(installedCaptureConfiguration(`${executable} {invalid`)).toBeNull();
	});
	it("matches copied bytes to the corresponding role and asset, rejecting swapped sources", () => {
		const document = {
			assets: [
				{ id: "asset", originalPath: "/tmp/screen", cameraTrack: { sourcePath: "/tmp/camera" } },
			],
		};
		const manifest = {
			sources: [
				{
					assetId: "asset",
					screen: { file: "001-screen.mp4", audio: [] },
					camera: { file: "001-camera.mov" },
				},
			],
		};
		const originals = [
			{ path: "/tmp/screen", sha256: "screenhash" },
			{ path: "/tmp/camera", sha256: "camerahash" },
		];
		expect(matchSourceCopy("001-camera.mov", "camerahash", manifest, document, originals)).toEqual(
			originals[1],
		);
		expect(() =>
			matchSourceCopy("001-screen.mp4", "camerahash", manifest, document, originals),
		).toThrow();
		expect(() =>
			matchSourceCopy("unknown.mov", "screenhash", manifest, document, originals),
		).toThrow();
		expect(() =>
			matchSourceCopy("001-screen.mp4", "screenhash", manifest, { assets: [] }, originals),
		).toThrow();
	});
	it("uses actual clip source time and refuses unidentified or too-short cut fixtures", () => {
		const clip = { id: "clip", asset_id: "asset", source: { start: 12, end: 132 } };
		expect(createOwnedCutOperations(clip).map((op) => [op.args.startSec, op.args.endSec])).toEqual([
			[14, 16],
			[19, 21],
		]);
		expect(clip.source).toEqual({ start: 12, end: 132 });
		for (const invalid of [
			undefined,
			{ ...clip, id: "" },
			{ ...clip, source: { start: 12, end: 15 } },
			{ ...clip, source: { start: NaN, end: 132 } },
		])
			expect(() => createOwnedCutOperations(invalid)).toThrow();
	});
	it("measures rendered color contrast and rejects the former unreadable combinations", () => {
		expect(cssContrastRatio("rgb(0, 0, 0)", "rgb(255, 255, 255)")).toBe(21);
		expect(cssContrastRatio("rgb(26, 30, 37)", "rgb(26, 30, 37)")).toBe(1);
		expect(cssContrastRatio("rgb(245, 247, 250)", "rgb(255, 255, 255)")).toBeLessThan(4.5);
		expect(cssContrastRatio("rgb(32, 34, 36)", "rgb(26, 30, 37)")).toBeLessThan(4.5);
		expect(() => cssContrastRatio("rgb(255, 255, 255)", "rgba(0, 0, 0, 0.5)")).toThrow();
	});
	it("checks the selected value rather than matching either option label", () => {
		expect(verifySelectedQuality("Standard", "standard", "standard")).toBe(true);
		for (const [label, value] of [
			["High Standard", "standard"],
			["Standard", "high"],
			["High", "standard"],
		])
			expect(() => verifySelectedQuality(label, value, "standard")).toThrow();
	});
	it("refuses incomplete, slow, mismatched, or lower-bit-rate quality evidence", () => {
		const profile = (quality) => ({
			status: "passed",
			options: { quality, audio: "both", camera: "true" },
			fixtureSha256: "fixture",
			actualCaptureHelper: { sha256: "helper" },
			nativeCaptureHistory: [
				{
					name: "start-native-mac-recording",
					result: { success: true },
					request: {
						video: { bitrate: quality === "high" ? 136_000_000 : 68_000_000, fps: 60, quality },
					},
				},
				{
					name: "stop-native-mac-recording",
					result: { success: true, session: { clips: [{ durationMs: 120000 }] } },
				},
			],
			qualityMetrics: {
				width: 2564,
				height: 1692,
				durationSec: 120,
				actualFps: quality === "high" ? 60 : 58,
				videoBitrateMbps: quality === "high" ? 136 : 68,
			},
			packetCadence: { lockedFrameGrid: quality === "high" },
			recordings: [{ liveSamples: [{ ps: ["1 0 5.0 1024 Electron"] }] }],
			sourceExport: {
				wallMs: 1000,
				hashPairs: ["screen", "camera", "microphone", "system"].map((kind) => ({
					exported: `/tmp/001-${kind}.mov`,
					original: `/tmp/original-${kind}.mov`,
					sha256: "a".repeat(64),
					systemSignal:
						kind === "system"
							? {
									original: "/tmp/original-system.mov",
									sha256: "a".repeat(64),
									durationSec: 8,
									samples: 384000,
									sampleRate: 48000,
									rms: 0.028,
									peak: 0.04,
								}
							: undefined,
					decodeProbePassed: true,
					probe: {
						format: { duration: "120" },
						streams: [{ codec_type: kind === "screen" || kind === "camera" ? "video" : "audio" }],
					},
				})),
			},
		});
		const standard = profile("standard"),
			high = profile("high");
		expect(compareQualityReports(standard, high).bothSourcesExportsUnderFiveSeconds).toBe(true);
		for (const broken of [
			{ ...high, nativeCaptureHistory: [] },
			{
				...high,
				nativeCaptureHistory: high.nativeCaptureHistory.map((event) =>
					event.name === "stop-native-mac-recording"
						? { ...event, result: { ...event.result, warning: "Recovered after ending session" } }
						: event,
				),
			},
			{ ...high, fixtureSha256: "other" },
			{ ...high, actualCaptureHelper: { sha256: "other" } },
			{ ...high, sourceExport: { ...high.sourceExport, wallMs: 5000 } },
			{
				...high,
				sourceExport: {
					...high.sourceExport,
					hashPairs: high.sourceExport.hashPairs.map((pair) => ({
						...pair,
						systemSignal: undefined,
					})),
				},
			},
			{
				...high,
				sourceExport: { ...high.sourceExport, hashPairs: high.sourceExport.hashPairs.slice(1) },
			},
			{ ...high, qualityMetrics: { ...high.qualityMetrics, videoBitrateMbps: 68 } },
			{ ...high, packetCadence: { lockedFrameGrid: false } },
		])
			expect(() => compareQualityReports(standard, broken)).toThrow();
		for (const kind of ["screen", "camera", "microphone", "system"])
			for (const probe of [
				undefined,
				{ format: { duration: "120" }, streams: [] },
				{
					format: { duration: "120" },
					streams: [{ codec_type: kind === "screen" || kind === "camera" ? "audio" : "video" }],
				},
				{
					format: { duration: "120" },
					streams: [
						{
							codec_type: kind === "screen" || kind === "camera" ? "video" : "audio",
							duration: "1",
						},
					],
				},
			]) {
				const truncated = {
					...high,
					sourceExport: {
						...high.sourceExport,
						hashPairs: high.sourceExport.hashPairs.map((pair) =>
							pair.exported.includes(`-${kind}.`) ? { ...pair, probe } : pair,
						),
					},
				};
				expect(() => compareQualityReports(standard, truncated)).toThrow();
			}
	});
	it("separates capture child CPU from owned Electron processes", () => {
		expect(
			summarizeLiveProcessSamples([
				{
					ps: [
						"1 0 10.0 1024 Electron",
						"2 1 20.0 2048 /tmp/klippt-screencapturekit-helper",
						"3 1 5.0 1024 Electron Helper",
					],
				},
			]),
		).toMatchObject({
			electronCpuPercentMean: 15,
			nativeCaptureCpuPercentMean: 20,
			totalCpuPercentMean: 35,
			ownedProcessRssMiBMean: 4,
		});
		expect(() => summarizeLiveProcessSamples([])).toThrow();
	});
	it("checks interior60fps packet steps and allows only the final partial closing interval", () => {
		const probe = (pts) => ({
			streams: [{ index: 0, codec_type: "video", time_base: "1/60000" }],
			packets: pts.map((pts_time) => ({ stream_index: 0, pts_time })),
		});
		const closing = analyzePacketCadence(probe([0, 1 / 60, 2 / 60, 2 / 60 + 0.001]));
		expect(closing.lockedFrameGrid).toBe(true);
		expect(closing.finalPartialIntervalSec).toBeCloseTo(0.001, 8);
		expect(analyzePacketCadence(probe([0, 1 / 60, 3 / 60, 4 / 60])).lockedFrameGrid).toBe(false);
		expect(analyzePacketCadence(probe([0, 0, 1 / 60])).lockedFrameGrid).toBe(false);
		expect(() => analyzePacketCadence(probe([0, Number.NaN]))).toThrow();
	});
	it("reports exact decoded repeats separately from encoded packet cadence", () => {
		const a = "a".repeat(32),
			b = "b".repeat(32);
		const rows = `# frame hashes\n0,0,0,1,8,${a}\n0,1,1,1,8,${a}\n0,2,2,1,8,${b}`;
		expect(summarizeDecodedDuplicates(rows)).toMatchObject({
			decodedFrames: 3,
			exactConsecutiveDuplicates: 1,
			duplicatePercent: 50,
		});
		expect(() => summarizeDecodedDuplicates("")).toThrow();
	});
	it("generates a seeded moving detail fixture with an explicit sound start", () => {
		const html = createQualityFixture("owned quality fixture");
		const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
		expect(() => new Function(script)).not.toThrow();
		expect(html).toContain("owned quality fixture");
		expect(script).toContain("requestedFps:60");
		expect(script).toContain("0x12345678");
		expect(script).toContain("AudioContext");
	});
	it("measures actual packet cadence separately from configured or nominal rate", () => {
		const summary = summarizeVideoProbe({
			format: { duration: "120", size: "270000000" },
			streams: [
				{
					codec_type: "video",
					duration: "120",
					nb_read_packets: "6900",
					bit_rate: "18000000",
					r_frame_rate: "60/1",
				},
			],
		});
		expect(summary.actualFps).toBe(57.5);
		expect(summary.videoBitrateMbps).toBe(18);
		expect(summary.containerBitrateMbps).toBe(18);
		expect(() => summarizeVideoProbe({ streams: [] })).toThrow();
	});
	function fixture() {
		const time = (value) => ({ value, rate: 60 });
		const clip = (file, start, duration) => ({
			OTIO_SCHEMA: "Clip.2",
			name: file,
			source_range: { start_time: time(start), duration: time(duration) },
			active_media_reference_key: "DEFAULT_MEDIA",
			media_references: { DEFAULT_MEDIA: { target_url: file } },
		});
		return {
			global_start_time: time(0),
			tracks: {
				children: [
					["Screen", "Video", "001-screen.mp4"],
					["Camera", "Video", "001-camera.mov"],
					["Microphone", "Audio", "001-microphone.m4a"],
					["System audio", "Audio", "001-system.m4a"],
				].map(([name, kind, file]) => ({
					name,
					kind,
					children: [
						{ OTIO_SCHEMA: "Gap.1", source_range: { duration: time(30) } },
						clip(file, 60, 120),
					],
				})),
			},
		};
	}
	it("checks every imported track against exported gaps, source starts and moved links", () => {
		const expected = otioExpectedTracks(fixture());
		const directory = "/tmp/Moved sources ü space";
		const actual = expected.map((track) => ({
			...track,
			clips: track.clips.map((clip) => ({
				...clip,
				sourceEndSec: 3,
				media: `${directory}/${clip.mediaFile}`,
				mediaProperties: { FPS: track.name === "Camera" ? "30" : "60" },
			})),
		}));
		expect(expected[0].clips[0]).toMatchObject({ start: 30, end: 150, sourceStartSec: 1 });
		expect(verifyResolveTracks(expected, actual, directory, 60)).toBe(true);
		for (const rate of [undefined, 24, NaN])
			expect(() => verifyResolveTracks(expected, actual, directory, rate)).toThrow();
		for (const broken of [
			actual.slice(1),
			actual.map((t, i) => (i < 2 ? { ...t, index: 2 - i } : t)),
			actual.map((t, i) => (i === 0 ? { ...t, clips: [{ ...t.clips[0], end: 149 }] } : t)),
			actual.map((t, i) => (i === 1 ? { ...t, clips: [{ ...t.clips[0], sourceStartSec: 0 }] } : t)),
			actual.map((t, i) => (i === 1 ? { ...t, clips: [{ ...t.clips[0], sourceEndSec: 2 }] } : t)),
			actual.map((t, i) =>
				i === 1 ? { ...t, clips: [{ ...t.clips[0], sourceEndSec: Number.NaN }] } : t,
			),
			actual.map((t, i) =>
				i === 2 ? { ...t, clips: [{ ...t.clips[0], media: "/tmp/old/001-microphone.m4a" }] } : t,
			),
			actual.map((t, i) => (i === 3 ? { ...t, clips: [{ ...t.clips[0], start: Number.NaN }] } : t)),
			actual.map((t, i) =>
				i === 1 ? { ...t, clips: [{ ...t.clips[0], mediaProperties: { FPS: "" } }] } : t,
			),
		])
			expect(() => verifyResolveTracks(expected, broken, directory, 60)).toThrow();
	});
	it("allows one native camera30 endpoint frame on a60timeline but rejects a retimed out-point", () => {
		const expected = otioExpectedTracks(fixture());
		const directory = "/tmp/Moved sources ü space";
		const actual = expected.map((track) => ({
			...track,
			clips: track.clips.map((clip) => ({
				...clip,
				sourceEndSec: track.name === "Camera" ? 3 - 1 / 30 : 3,
				media: `${directory}/${clip.mediaFile}`,
				mediaProperties: { FPS: track.name === "Camera" ? "30" : "60" },
			})),
		}));
		expect(expected[1].clips[0].sourceEndSec).toBe(3);
		expect(verifyResolveTracks(expected, actual, directory, 60)).toBe(true);
		actual[1].clips[0].sourceEndSec = 3 - 2 / 30;
		expect(() => verifyResolveTracks(expected, actual, directory, 60)).toThrow();
	});
});
