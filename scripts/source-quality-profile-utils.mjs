import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const executeProfileCli = promisify(execFile);

export function chromeLaunchServicesArgs(profile) {
	if (!/^\/tmp\/klippt-source-profile-[A-Za-z0-9]+\/chrome-profile$/.test(profile))
		throw new Error("LaunchServices fixture requires a task-owned private Chrome profile");
	return [
		"-n",
		"-a",
		"/Applications/Google Chrome.app",
		"--args",
		`--user-data-dir=${profile}`,
		"--remote-debugging-port=0",
		"--enable-automation",
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-sync",
		"--disable-extensions",
		"--disable-background-networking",
		"--window-size=1282,846",
	];
}

export function ownedChromeProcessPids(psText, profile, driverPid, launchServices = false) {
	const executable = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
	const escaped = profile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const profileArg = new RegExp(`(?:^|\\s)--user-data-dir=${escaped}(?=\\s|$)`);
	return psText.split("\n").flatMap((line) => {
		const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
		if (
			!match ||
			(!launchServices && Number(match[2]) !== driverPid) ||
			!match[3].startsWith(`${executable} --`) ||
			!profileArg.test(match[3])
		)
			return [];
		return [Number(match[1])];
	});
}

export function ownedCaptureProcessPid(psText, helperPath, driverPid) {
	if (!helperPath || helperPath.startsWith("/Applications/"))
		throw new Error("Capture sampling requires an exact development helper path");
	const matches = psText.split("\n").flatMap((line) => {
		const row = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
		return row && Number(row[2]) === driverPid && row[3] === helperPath ? [Number(row[1])] : [];
	});
	if (matches.length > 1) throw new Error("Owned capture helper identity is ambiguous");
	return matches[0];
}

export function createQualityFixture(title) {
	return String.raw`<!doctype html><meta charset=utf-8><title>${title}</title>
<style>html,body{margin:0;background:#10151b;color:#e8efff;font:16px/1.4 ui-monospace,monospace;overflow:hidden}header{height:56px;padding:16px;background:#111b24;border-bottom:1px solid #65738a}canvas{position:absolute;inset:56px 0 0;width:100%;height:calc(100% - 56px)}#terminal{position:absolute;inset:80px 30px 28px;width:53%;background:#071019e8;padding:20px;overflow:hidden;white-space:pre;color:#d6fbe8;text-shadow:0 1px #000}#clock{float:right;color:#9adfff}button{position:absolute;right:20px;top:10px;background:#263b50;color:white;border:1px solid #9adfff;padding:8px}</style>
<header>Klippt deterministic 60 fps capture fixture <span id=clock></span></header><canvas id=motion width=640 height=360></canvas><div id=terminal></div><button id=start>Start fixture and sound</button>
<script>
const ctx=document.querySelector('#motion').getContext('2d',{alpha:false});
const image=ctx.createImageData(640,360);let epoch=null,frames=0,intervals=[],last=null,audio;
function paint(frame){let s=(0x12345678^Math.imul(frame+1,2654435761))>>>0;const d=image.data;for(let i=0;i<d.length;i+=4){s^=s<<13;s^=s>>>17;s^=s<<5;d[i]=s&255;d[i+1]=(s>>>8)&255;d[i+2]=(s>>>16)&255;d[i+3]=255}ctx.putImageData(image,0,0);const row=Math.floor(frame/4);document.querySelector('#terminal').textContent=Array.from({length:32},(_,i)=>{const n=row+i;return '$ capture '+String(n).padStart(6,'0')+' | '+(Math.imul(n+1,1664525)>>>0).toString(16).padStart(8,'0')+' | screen camera mic system\n  PASS frame writer packet source handoff';}).join('\n');document.querySelector('#clock').textContent='frame '+frame+' / '+(frame/60).toFixed(3)+' s';}
function animate(now){if(epoch!==null){const frame=Math.floor((now-epoch)*60/1000);paint(frame);frames++;if(last!==null)intervals.push(now-last);last=now;}requestAnimationFrame(animate)}paint(0);requestAnimationFrame(animate);
async function start(){if(audio)await audio.close();audio=new AudioContext();const gain=audio.createGain();gain.gain.value=.04;gain.connect(audio.destination);const tone=audio.createOscillator();tone.frequency.value=440;tone.connect(gain);tone.start();await audio.resume();epoch=performance.now();frames=0;intervals=[];last=null;}
document.querySelector('#start').onclick=start;window.qualityFixture={reset:start,stats:()=>({seed:'0x12345678',requestedFps:60,elapsedSec:epoch===null?0:(performance.now()-epoch)/1000,renderedFrames:frames,meanFrameIntervalMs:intervals.length?intervals.reduce((a,b)=>a+b,0)/intervals.length:null,audioState:audio?.state})};
</script>`;
}

export function createOwnedCutOperations(clip) {
	const start = Number(clip?.source?.start),
		end = Number(clip?.source?.end);
	if (!clip?.id || !clip?.asset_id || !Number.isFinite(start) || start < 0 || !(end - start >= 10))
		throw new Error("Owned cut proof requires an identified clip with ten known source seconds");
	return [
		[2, 4],
		[7, 9],
	].map(([from, to]) => ({
		type: "addTrim",
		args: {
			clipId: clip.id,
			assetId: clip.asset_id,
			startSec: start + from,
			endSec: start + to,
			reason: "Owned current-export source-range verification",
		},
	}));
}

export function assertCleanNativeStop(result) {
	const clips = result?.session?.clips?.filter((clip) => !clip.removed);
	if (
		result?.success !== true ||
		!clips?.length ||
		clips.some((clip) => !(clip.durationMs > 0) || !Number.isFinite(clip.durationMs)) ||
		result.warning ||
		/recover/i.test(result.message ?? "") ||
		clips.some((clip) => clip.provisionalDuration)
	)
		throw new Error(
			`Normal recording requires a clean native Stop: ${result?.warning ?? result?.error ?? result?.message ?? "missing success"}`,
		);
	return true;
}

export function nativeWarningEventsFromDiagnostic(diagnostic) {
	const warnings = [];
	for (const line of (diagnostic.helperOutput?.mac ?? "").split("\n")) {
		try {
			const event = JSON.parse(line);
			if (event.event === "warning") warnings.push(event);
		} catch {
			// Helper stderr text is preserved in the raw diagnostic, not a JSON event.
		}
	}
	return warnings;
}

export function summarizeDecodedAudioSignal(samples, sampleRate = 48000) {
	if (!samples?.length || !(sampleRate > 0) || !Number.isFinite(sampleRate))
		throw new Error("Audio signal proof requires decoded PCM and a finite sample rate");
	let sumSquares = 0,
		peak = 0;
	for (const sample of samples) {
		if (!Number.isFinite(sample)) throw new Error("Decoded PCM contains a non-finite sample");
		sumSquares += sample * sample;
		peak = Math.max(peak, Math.abs(sample));
	}
	const rms = Math.sqrt(sumSquares / samples.length);
	return {
		samples: samples.length,
		sampleRate,
		durationSec: samples.length / sampleRate,
		rms,
		peak,
		rmsDb: rms > 0 ? 20 * Math.log10(rms) : null,
		peakDb: peak > 0 ? 20 * Math.log10(peak) : null,
	};
}

export function assertKnownSystemSignal(pair) {
	const signal = pair?.systemSignal;
	if (
		!signal ||
		signal.original !== pair.original ||
		signal.sha256 !== pair.sha256 ||
		!(signal.durationSec >= 0.1) ||
		!Number.isFinite(signal.durationSec) ||
		!Number.isInteger(signal.samples) ||
		signal.sampleRate !== 48000 ||
		Math.abs(signal.durationSec - signal.samples / signal.sampleRate) > 1e-9 ||
		!Number.isFinite(signal.rms) ||
		!Number.isFinite(signal.peak) ||
		!(signal.rms > 0.001 && signal.peak > 0.002)
	)
		throw new Error(
			"Known-tone system proof requires byte-linked decoded PCM RMS and peak above silence",
		);
	return true;
}

export function matchSourceCopy(file, sha256, manifest, document, originals) {
	const paths = new Set();
	for (const source of manifest.sources ?? []) {
		const asset = document.assets?.find((value) => value.id === source.assetId);
		if (!asset) throw new Error("Export manifest refers to an unknown original asset");
		if (source.screen?.file === file) paths.add(asset.originalPath);
		if (source.camera?.file === file) paths.add(asset.cameraTrack?.sourcePath);
		for (const audio of source.screen?.audio ?? []) {
			if (audio.file !== file || audio.file === source.screen.file) continue;
			paths.add(
				audio.role === "microphone"
					? asset.microphoneAudioPath
					: audio.role === "system"
						? asset.systemAudioPath
						: undefined,
			);
		}
	}
	if (paths.size !== 1 || ![...paths][0])
		throw new Error("Exported media has no unique original role/asset mapping");
	const original = originals.find((value) => paths.has(value.path) && value.sha256 === sha256);
	if (!original)
		throw new Error(`Exported ${file} is not byte-identical to its corresponding original`);
	return original;
}

export function summarizeVideoProbe(probe) {
	const video = probe.streams?.find((stream) => stream.codec_type === "video");
	if (!video) throw new Error("Recorded source has no video stream");
	const duration = Number(video.duration ?? probe.format?.duration);
	const frames = Number(video.nb_read_packets ?? video.nb_frames);
	const bytes = Number(probe.format?.size);
	if (!(duration > 0) || !(frames > 0) || !(bytes > 0))
		throw new Error("Video proof requires measured duration, packets and file size");
	return {
		codec: video.codec_name,
		width: video.width,
		height: video.height,
		durationSec: duration,
		videoFrames: frames,
		actualFps: frames / duration,
		videoBitrateMbps: Number(video.bit_rate) / 1_000_000,
		containerBitrateMbps: (bytes * 8) / duration / 1_000_000,
		fileBytes: bytes,
		nominalRate: video.r_frame_rate,
		averageRate: video.avg_frame_rate,
	};
}

export function analyzePacketCadence(probe, fps = 60) {
	const stream = probe.streams?.find((value) => value.codec_type === "video");
	const [numerator, denominator] = String(stream?.time_base).split("/").map(Number);
	const quantum = numerator / denominator;
	const pts = probe.packets
		?.filter((packet) => packet.stream_index === stream?.index)
		.map((packet) => Number(packet.pts_time))
		.sort((a, b) => a - b);
	if (!pts || pts.length < 2 || !pts.every(Number.isFinite) || !(quantum > 0))
		throw new Error("Cadence proof requires packet PTS and a valid video time base");
	const step = 1 / fps,
		tolerance = quantum + 0.000002;
	const violations = [];
	let finalPartialIntervalSec = null;
	for (let index = 1; index < pts.length; index++) {
		const delta = pts[index] - pts[index - 1];
		if (Math.abs(delta - step) <= tolerance) continue;
		if (index === pts.length - 1 && delta > 0 && delta < step) finalPartialIntervalSec = delta;
		else violations.push({ frameIndex: index, deltaSec: delta });
	}
	return {
		fps,
		packetCount: pts.length,
		timeBase: stream.time_base,
		quantumSec: quantum,
		firstPtsSec: pts[0],
		lastPtsSec: pts.at(-1),
		violations,
		finalPartialIntervalSec,
		lockedFrameGrid: violations.length === 0,
	};
}

export function summarizeDecodedDuplicates(frameMd5) {
	const hashes = frameMd5
		.split("\n")
		.filter((line) => line.trim() && !line.startsWith("#"))
		.map((line) => line.split(",").at(-1).trim());
	if (!hashes.length || hashes.some((hash) => !/^[a-f0-9]{32}$/.test(hash)))
		throw new Error("Duplicate proof requires decoded frame MD5 rows");
	let repeated = 0,
		streak = 0,
		longest = 0;
	for (let index = 1; index < hashes.length; index++) {
		if (hashes[index] === hashes[index - 1]) {
			repeated++;
			streak++;
			longest = Math.max(longest, streak);
		} else streak = 0;
	}
	return {
		decodedFrames: hashes.length,
		exactConsecutiveDuplicates: repeated,
		duplicatePercent: (repeated / Math.max(1, hashes.length - 1)) * 100,
		longestDuplicateRun: longest,
		method: "Full decoded pixels, passthrough timestamps; adjacent exact MD5 equality",
	};
}

export function summarizeLiveProcessSamples(samples) {
	const rows = samples.map((sample) => {
		let electronCpu = 0,
			helperCpu = 0,
			rssKiB = 0;
		for (const line of sample.ps) {
			const [, , cpu, rss, ...command] = line.trim().split(/\s+/);
			if (!Number.isFinite(Number(cpu)) || !Number.isFinite(Number(rss)))
				throw new Error("Invalid owned process sample");
			if (command.join(" ").endsWith("openscreen-screencapturekit-helper"))
				helperCpu += Number(cpu);
			else electronCpu += Number(cpu);
			rssKiB += Number(rss);
		}
		return { electronCpu, helperCpu, rssKiB };
	});
	if (!rows.length) throw new Error("Live process proof requires samples");
	const mean = (key) => rows.reduce((total, row) => total + row[key], 0) / rows.length;
	return {
		sampleCount: rows.length,
		electronCpuPercentMean: mean("electronCpu"),
		nativeCaptureCpuPercentMean: mean("helperCpu"),
		totalCpuPercentMean: mean("electronCpu") + mean("helperCpu"),
		ownedProcessRssMiBMean: mean("rssKiB") / 1024,
		ownedProcessRssMiBMax: Math.max(...rows.map((row) => row.rssKiB)) / 1024,
		method:
			"ps %cpu and RSS samples of the owned Electron parent and direct children; 100% CPU is one core; Chrome fixture and Resolve excluded",
	};
}

export function installedCaptureProcesses(psText) {
	const executable =
		"/Applications/Klippt.app/Contents/Resources/electron/native/bin/darwin-arm64/openscreen-screencapturekit-helper";
	return psText
		.split("\n")
		.map((line) => line.trim().split(/\s+/))
		.filter(([, , , , ...command]) => command.join(" ") === executable)
		.map(([pid, parent, cpu, rss]) => {
			const values = [pid, parent, cpu, rss].map(Number);
			if (!values.every(Number.isFinite))
				throw new Error("Invalid installed capture process sample");
			return { pid: values[0], parentPid: values[1], cpuPercent: values[2], rssKiB: values[3] };
		});
}

export function installedCaptureConfiguration(command) {
	const start = command.indexOf("{");
	if (start < 0) return null;
	let request;
	try {
		request = JSON.parse(command.slice(start));
	} catch {
		return null;
	}
	return {
		sourceType: request.source?.type,
		video: {
			fps: request.video?.fps,
			width: request.video?.width,
			height: request.video?.height,
			bitrate: request.video?.bitrate,
			quality: request.video?.quality,
		},
		systemAudio: request.audio?.system?.enabled,
		microphoneAudio: request.audio?.microphone?.enabled,
		camera: request.webcam?.enabled,
	};
}

export function compareQualityReports(standard, high) {
	for (const [quality, report] of [
		["standard", standard],
		["high", high],
	]) {
		if (
			report.status !== "passed" ||
			report.options?.quality !== quality ||
			report.options?.audio !== "both" ||
			report.options?.camera !== "true"
		)
			throw new Error(
				"Quality comparison requires successful actual all-four captures for both profiles",
			);
		assertCleanNativeStop(
			report.nativeCaptureHistory?.findLast((event) => event.name === "stop-native-mac-recording")
				?.result,
		);
		if (
			!(report.qualityMetrics?.durationSec >= 119.5) ||
			!(report.sourceExport?.wallMs > 0 && report.sourceExport.wallMs < 5000)
		)
			throw new Error(
				"Quality comparison requires two-minute media and each source export under five seconds",
			);
		const start = report.nativeCaptureHistory?.find(
			(event) => event.name === "start-native-mac-recording" && event.result?.success,
		);
		if (
			start?.request?.video?.bitrate !== (quality === "high" ? 136_000_000 : 68_000_000) ||
			start.request.video.fps !== 60 ||
			start.request.video.quality !== quality
		)
			throw new Error("Quality proof requires the actual Standard68/High136Mbps native request");
		for (const kind of ["screen", "camera", "microphone", "system"]) {
			const pair = report.sourceExport.hashPairs?.find((value) =>
				new RegExp(`^\\d+-${kind}\\.`).test(value.exported.split("/").at(-1)),
			);
			if (!pair || !/^[a-f0-9]{64}$/.test(pair.sha256) || !pair.decodeProbePassed)
				throw new Error(`Quality proof is missing a byte-identical readable ${kind} original`);
			const type = kind === "screen" || kind === "camera" ? "video" : "audio";
			const stream = pair.probe?.streams?.find((value) => value.codec_type === type);
			if (!stream) throw new Error(`Quality proof requires a measured ${type} stream for ${kind}`);
			const duration = Number(stream?.duration ?? pair.probe?.format?.duration);
			if (!(duration >= 119.5) || !Number.isFinite(duration))
				throw new Error(`Quality proof requires two measured minutes of ${kind} original media`);
			if (kind === "system") assertKnownSystemSignal(pair);
		}
	}
	if (
		!standard.fixtureSha256 ||
		standard.fixtureSha256 !== high.fixtureSha256 ||
		!standard.actualCaptureHelper?.sha256 ||
		standard.actualCaptureHelper.sha256 !== high.actualCaptureHelper?.sha256
	)
		throw new Error("Quality comparison requires the same actual fixture and native helper build");
	if (
		standard.qualityMetrics.width !== high.qualityMetrics.width ||
		standard.qualityMetrics.height !== high.qualityMetrics.height
	)
		throw new Error("Quality comparison requires identical native screen dimensions");
	if (!high.packetCadence?.lockedFrameGrid || Math.abs(high.qualityMetrics.actualFps - 60) > 0.1)
		throw new Error("High did not preserve the measured 60 fps packet grid");
	if (!(high.qualityMetrics.videoBitrateMbps > standard.qualityMetrics.videoBitrateMbps))
		throw new Error("High's actual measured bitrate is not greater than Standard's");
	return {
		fixtureSha256: high.fixtureSha256,
		captureHelperSha256: high.actualCaptureHelper.sha256,
		standard: {
			...standard.qualityMetrics,
			requestedVideoBitrateMbps: 68,
			live: summarizeLiveProcessSamples(standard.recordings.at(-1).liveSamples),
			sourcesExportMs: standard.sourceExport.wallMs,
		},
		high: {
			...high.qualityMetrics,
			requestedVideoBitrateMbps: 136,
			live: summarizeLiveProcessSamples(high.recordings.at(-1).liveSamples),
			sourcesExportMs: high.sourceExport.wallMs,
		},
		highPacketCadence: high.packetCadence,
		allOriginalsByteIdenticalAndReadable: true,
		bothSourcesExportsUnderFiveSeconds: true,
	};
}

export function verifySelectedQuality(label, persistedValue, expected) {
	const expectedLabel = expected === "high" ? "High" : expected === "standard" ? "Standard" : null;
	if (!expectedLabel || label.trim() !== expectedLabel || persistedValue !== expected)
		throw new Error(
			"Displayed selection and persisted quality must both match the expected profile",
		);
	return true;
}

export function cssContrastRatio(foreground, background) {
	const parse = (color) => {
		const match = color.match(/^rgba?\(([^)]+)\)$/);
		if (!match) throw new Error(`Expected computed RGB color: ${color}`);
		const parts = match[1]
			.split(/[,\s/]+/)
			.filter(Boolean)
			.map(Number);
		if (parts.length < 3 || parts.some((value) => !Number.isFinite(value)))
			throw new Error("Invalid RGB color");
		return [...parts.slice(0, 3), parts[3] ?? 1];
	};
	const front = parse(foreground),
		back = parse(background);
	if (back[3] !== 1) throw new Error("Contrast proof requires an opaque effective background");
	const rgb = front
		.slice(0, 3)
		.map((value, index) => value * front[3] + back[index] * (1 - front[3]));
	const luminance = (values) =>
		values
			.map((value) => {
				const channel = value / 255;
				return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
			})
			.reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
	const a = luminance(rgb),
		b = luminance(back.slice(0, 3));
	return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export function otioExpectedTracks(otio) {
	const rate = Number(otio.global_start_time?.rate);
	if (!(rate > 0) || !Array.isArray(otio.tracks?.children))
		throw new Error("Expected a valid exported OTIO timeline");
	const indices = { video: 0, audio: 0 };
	return otio.tracks.children.map((track) => {
		const kind = track.kind.toLowerCase();
		if (!Object.hasOwn(indices, kind)) throw new Error("Unsupported OTIO track kind");
		const index = ++indices[kind];
		let position = 0;
		const clips = [];
		for (const child of track.children) {
			const range = child.source_range;
			const duration = Number(range?.duration?.value) / Number(range?.duration?.rate);
			if (!(duration >= 0) || !Number.isFinite(duration)) throw new Error("Invalid OTIO duration");
			if (child.OTIO_SCHEMA.startsWith("Clip.")) {
				const reference = child.media_references?.[child.active_media_reference_key];
				if (!reference?.target_url) throw new Error("Missing OTIO media reference");
				const sourceStartSec = Number(range.start_time.value) / Number(range.start_time.rate);
				if (!(sourceStartSec >= 0) || !Number.isFinite(sourceStartSec))
					throw new Error("Invalid OTIO source start");
				clips.push({
					name: child.name,
					start: position * rate,
					end: (position + duration) * rate,
					sourceStartSec,
					sourceEndSec: sourceStartSec + duration,
					mediaFile: reference.target_url,
				});
			} else if (!child.OTIO_SCHEMA.startsWith("Gap.")) {
				throw new Error(`Unsupported OTIO child ${child.OTIO_SCHEMA}`);
			}
			position += duration;
		}
		return { kind, index, name: track.name, rate, clips };
	});
}

export function verifyResolveTracks(expected, actual, directory, actualTimelineRate) {
	const rate = Number(actualTimelineRate);
	if (!(rate > 0) || !Number.isFinite(rate) || expected.some((track) => track.rate !== rate))
		throw new Error("Resolve's measured timeline frame rate differs from the exported OTIO");
	const required = [
		["Screen", "video", 1],
		["Camera", "video", 2],
		["Microphone", "audio", 1],
		["System audio", "audio", 2],
	];
	if (expected.length !== 4 || actual.length !== 4)
		throw new Error("Resolve proof requires exactly four separate tracks");
	for (const [name, kind, index] of required) {
		const wanted = expected.find((track) => track.name === name);
		const found = actual.find((track) => track.name === name);
		if (
			!wanted ||
			!found ||
			wanted.kind !== kind ||
			wanted.index !== index ||
			found.index !== index ||
			found.kind !== wanted.kind ||
			found.clips.length !== wanted.clips.length
		)
			throw new Error(`Resolve ${name} track differs from OTIO`);
		for (let index = 0; index < wanted.clips.length; index++) {
			const clip = wanted.clips[index];
			const imported = found.clips[index];
			const linked = `${directory.replace(/\/$/, "")}/${decodeURIComponent(clip.mediaFile)}`;
			const mediaRate = Number(imported.mediaProperties?.FPS);
			if (wanted.kind === "video" && (!(mediaRate > 0) || !Number.isFinite(mediaRate)))
				throw new Error(`Resolve ${name} clip ${index + 1} has no measured media frame rate`);
			// Audio has no video FPS; Resolve positions it on the timeline frame grid.
			const sourceQuantum = 1 / (wanted.kind === "video" ? mediaRate : wanted.rate);
			if (
				![
					imported.start,
					imported.end,
					imported.sourceStartSec,
					imported.sourceEndSec,
					clip.sourceStartSec,
					clip.sourceEndSec,
				].every(Number.isFinite) ||
				Math.abs(imported.start - clip.start) > 0.01 ||
				Math.abs(imported.end - clip.end) > 0.01 ||
				Math.abs(imported.sourceStartSec - clip.sourceStartSec) > 1 / wanted.rate + 0.001 ||
				Math.abs(imported.sourceEndSec - clip.sourceEndSec) > sourceQuantum + 0.001 ||
				imported.media !== linked
			)
				throw new Error(`Resolve ${name} clip ${index + 1} timing or media link differs`);
		}
	}
	return true;
}
