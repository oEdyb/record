#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SAMPLE_RATE = 48_000;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const helper = path.join(root, "electron", "native", "clean-voice", "build", "klippt-clean-voice");
const labScript = path.join(root, "scripts", "clean-voice-lab.mjs");

function wavBytes(samples) {
	const dataBytes = samples.length * 4;
	const buffer = Buffer.alloc(44 + dataBytes);
	buffer.write("RIFF", 0);
	buffer.writeUInt32LE(36 + dataBytes, 4);
	buffer.write("WAVEfmt ", 8);
	buffer.writeUInt32LE(16, 16);
	buffer.writeUInt16LE(3, 20);
	buffer.writeUInt16LE(1, 22);
	buffer.writeUInt32LE(SAMPLE_RATE, 24);
	buffer.writeUInt32LE(SAMPLE_RATE * 4, 28);
	buffer.writeUInt16LE(4, 32);
	buffer.writeUInt16LE(32, 34);
	buffer.write("data", 36);
	buffer.writeUInt32LE(dataBytes, 40);
	for (let index = 0; index < samples.length; index += 1) {
		buffer.writeFloatLE(samples[index], 44 + index * 4);
	}
	return buffer;
}

function readFloatWav(filePath) {
	const buffer = fs.readFileSync(filePath);
	if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
		throw new Error(`${filePath} is not a RIFF/WAVE file`);
	}
	let offset = 12;
	let format;
	let channels;
	let sampleRate;
	let byteRate;
	let blockAlign;
	let bitsPerSample;
	let channelMask;
	let data;
	while (offset + 8 <= buffer.length) {
		const id = buffer.toString("ascii", offset, offset + 4);
		const size = buffer.readUInt32LE(offset + 4);
		const start = offset + 8;
		if (start + size > buffer.length) throw new Error(`${filePath} has a truncated ${id} chunk`);
		if (id === "fmt ") {
			format = buffer.readUInt16LE(start);
			channels = buffer.readUInt16LE(start + 2);
			sampleRate = buffer.readUInt32LE(start + 4);
			byteRate = buffer.readUInt32LE(start + 8);
			blockAlign = buffer.readUInt16LE(start + 12);
			bitsPerSample = buffer.readUInt16LE(start + 14);
			if (format === 0xfffe && size >= 40) {
				channelMask = buffer.readUInt32LE(start + 20);
				format = buffer.readUInt16LE(start + 24);
			}
		} else if (id === "data") {
			data = buffer.subarray(start, start + size);
		}
		offset = start + size + (size % 2);
	}
	if (
		format !== 3 ||
		channels !== 1 ||
		sampleRate !== SAMPLE_RATE ||
		byteRate !== SAMPLE_RATE * 4 ||
		blockAlign !== 4 ||
		bitsPerSample !== 32 ||
		channelMask !== 0x4 ||
		!data ||
		data.length % 4 !== 0
	) {
		throw new Error(`${filePath} is not centered mono 48 kHz Float32 WAV`);
	}
	const samples = new Float32Array(data.length / 4);
	for (let index = 0; index < samples.length; index += 1) {
		samples[index] = data.readFloatLE(index * 4);
	}
	return samples;
}

function hash(filePath) {
	return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function correlationAtLag(input, output, start, end, lag, stride) {
	let dot = 0;
	let aa = 0;
	let bb = 0;
	for (let index = start; index < end; index += stride) {
		const other = index + lag;
		if (other < 0 || other >= output.length) continue;
		const a = input[index];
		const b = output[other];
		dot += a * b;
		aa += a * a;
		bb += b * b;
	}
	return dot / Math.sqrt(Math.max(Number.EPSILON, aa * bb));
}

function energeticWindow(samples, windowLength = 2 * SAMPLE_RATE) {
	if (samples.length <= windowLength) return { start: 0, end: samples.length };
	const step = Math.floor(SAMPLE_RATE / 2);
	let selectedStart = 0;
	let selectedEnergy = -1;
	const starts = [];
	for (let start = 0; start + windowLength <= samples.length; start += step) starts.push(start);
	starts.push(samples.length - windowLength);
	for (const start of new Set(starts)) {
		let energy = 0;
		for (let index = start; index < start + windowLength; index += 16) {
			energy += samples[index] * samples[index];
		}
		if (energy > selectedEnergy) {
			selectedEnergy = energy;
			selectedStart = start;
		}
	}
	return { start: selectedStart, end: selectedStart + windowLength };
}

function bestLag(input, output, maxLag = 4_800) {
	const window = energeticWindow(input);
	let selectedLag = 0;
	let selectedScore = Number.NEGATIVE_INFINITY;
	for (let lag = -maxLag; lag <= maxLag; lag += 16) {
		const score = correlationAtLag(input, output, window.start, window.end, lag, 8);
		if (score > selectedScore) {
			selectedScore = score;
			selectedLag = lag;
		}
	}
	const coarseLag = selectedLag;
	for (let lag = coarseLag - 24; lag <= coarseLag + 24; lag += 1) {
		const score = correlationAtLag(input, output, window.start, window.end, lag, 1);
		if (score > selectedScore) {
			selectedScore = score;
			selectedLag = lag;
		}
	}
	return { lag: selectedLag, score: selectedScore };
}

function segmentRms(samples, startSeconds, endSeconds) {
	const start = Math.max(0, Math.floor(startSeconds * SAMPLE_RATE));
	const end = Math.min(samples.length, Math.floor(endSeconds * SAMPLE_RATE));
	let energy = 0;
	for (let index = start; index < end; index += 1) energy += samples[index] * samples[index];
	return Math.sqrt(energy / Math.max(1, end - start));
}

function segmentCorrelation(input, output, startSeconds, endSeconds) {
	const start = Math.max(0, Math.floor(startSeconds * SAMPLE_RATE));
	const end = Math.min(input.length, output.length, Math.floor(endSeconds * SAMPLE_RATE));
	return correlationAtLag(input, output, start, end, 0, 1);
}

function deterministicSignal(length, quietPrefix = 0) {
	let seed = 0x12345678;
	return Float32Array.from({ length }, (_, index) => {
		if (index < quietPrefix) return 0;
		seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
		const noise = (seed / 0xffffffff - 0.5) * 0.012;
		const t = index / SAMPLE_RATE;
		return 0.16 * Math.sin(2 * Math.PI * 173 * t) + 0.08 * Math.sin(2 * Math.PI * 421 * t) + noise;
	});
}

function runFixture(directory, name, samples, verifyAlignment = false) {
	const input = path.join(directory, `${name}-input.wav`);
	const outputA = path.join(directory, `${name}-clean-a.wav`);
	const outputB = path.join(directory, `${name}-clean-b.wav`);
	fs.writeFileSync(input, wavBytes(samples));
	const reports = [outputA, outputB].map((output) => {
		const result = spawnSync(helper, ["--input", input, "--output", output], {
			encoding: "utf8",
		});
		if (result.status !== 0) {
			throw new Error(`${name} failed: ${result.stderr || result.stdout}`);
		}
		return JSON.parse(result.stdout);
	});
	const clean = readFloatWav(outputA);
	if (
		clean.length !== samples.length ||
		reports.some((report) => report.outputSamples !== samples.length)
	) {
		throw new Error(`${name} changed the sample count (${samples.length} -> ${clean.length})`);
	}
	if (reports.some((report) => report.delaySamples !== 1_440)) {
		throw new Error(`${name} reported an unexpected DeepFilterNet3 file delay`);
	}
	if (reports.some((report) => report.attenuationLimitDb !== 6)) {
		throw new Error(`${name} did not use the 6 dB Natural default`);
	}
	if (clean.some((sample) => !Number.isFinite(sample))) {
		throw new Error(`${name} produced a non-finite sample`);
	}
	if (hash(outputA) !== hash(outputB)) {
		throw new Error(`${name} is not deterministic`);
	}
	if (verifyAlignment && samples.length > SAMPLE_RATE / 2) {
		const alignment = bestLag(samples, clean);
		if (alignment.score < 0.35) {
			throw new Error(`${name} has low alignment confidence (${alignment.score.toFixed(3)})`);
		}
		if (alignment.lag !== 0) {
			throw new Error(`${name} has ${alignment.lag} samples of residual delay`);
		}
		console.log(
			`${name}: ${samples.length} samples, lag ${alignment.lag}, RTF ${reports[0].realTimeFactor.toFixed(3)}`,
		);
	} else {
		console.log(`${name}: ${samples.length} samples, RTF ${reports[0].realTimeFactor.toFixed(3)}`);
	}
	return clean;
}

function verifyDigitalSilence(directory) {
	const clean = runFixture(directory, "digital-silence", new Float32Array(2 * SAMPLE_RATE));
	if (clean.some((sample) => sample !== 0)) {
		throw new Error("digital-silence produced non-zero output");
	}
	console.log("digital-silence: exact zero preserved");
}

function verifyFinalHopOffsets(directory) {
	for (const offset of [0, 1, 137, 479]) {
		const samples = deterministicSignal(2 * SAMPLE_RATE + offset);
		const clean = runFixture(directory, `eof-offset-${offset}`, samples, true);
		const endSeconds = samples.length / SAMPLE_RATE;
		const tailStartSeconds = Math.max(0, endSeconds - 0.025);
		const tailRms = segmentRms(clean, tailStartSeconds, endSeconds);
		const tailCorrelation = segmentCorrelation(samples, clean, tailStartSeconds, endSeconds);
		if (tailRms < 0.005) {
			throw new Error(`eof-offset-${offset} lost the final signal tail (${tailRms})`);
		}
		if (tailCorrelation < 0.35) {
			throw new Error(`eof-offset-${offset} corrupted the final signal tail (${tailCorrelation})`);
		}
	}
}

function verifySignalSilenceTransitions(directory) {
	const oneSecond = deterministicSignal(SAMPLE_RATE);
	const signalThenSilence = new Float32Array(2 * SAMPLE_RATE);
	signalThenSilence.set(oneSecond);
	const signalSilenceSignal = new Float32Array(3 * SAMPLE_RATE);
	signalSilenceSignal.set(oneSecond);
	signalSilenceSignal.set(oneSecond, 2 * SAMPLE_RATE);
	const signalThenAntiPhaseQuiet = new Float32Array(2 * SAMPLE_RATE);
	signalThenAntiPhaseQuiet.set(oneSecond);
	for (let index = SAMPLE_RATE; index < signalThenAntiPhaseQuiet.length; index += 1) {
		signalThenAntiPhaseQuiet[index] = index % 2 === 0 ? -0.0002 : 0.0002;
	}

	const cases = [
		["signal-then-silence", signalThenSilence],
		["signal-silence-signal", signalSilenceSignal],
		["signal-then-antiphase-quiet", signalThenAntiPhaseQuiet],
	];
	for (const [name, samples] of cases) {
		const clean = runFixture(directory, name, samples, true);
		const tailRms = segmentRms(clean, 0.98, 1.0);
		const inputQuietRms = segmentRms(samples, 1.3, 1.7);
		const quietRms = segmentRms(clean, 1.3, 1.7);
		const tailCorrelation = segmentCorrelation(samples, clean, 0.95, 1.0);
		if (tailRms < 0.005) throw new Error(`${name} cut the signal tail (${tailRms})`);
		if (tailCorrelation < 0.35) {
			throw new Error(`${name} corrupted the signal tail (${tailCorrelation})`);
		}
		if (quietRms > inputQuietRms + 0.00005) {
			throw new Error(`${name} added processing noise (${inputQuietRms} -> ${quietRms})`);
		}
		if (name === "signal-silence-signal") {
			const secondOnsetRms = segmentRms(clean, 2.0, 2.02);
			const secondOnsetCorrelation = segmentCorrelation(samples, clean, 2.0, 2.1);
			if (secondOnsetRms < 0.005) {
				throw new Error(`${name} lost the second signal onset (${secondOnsetRms})`);
			}
			if (secondOnsetCorrelation < 0.35) {
				throw new Error(`${name} corrupted the second signal onset (${secondOnsetCorrelation})`);
			}
		}
		console.log(`${name}: tail ${tailRms.toFixed(4)}, quiet ${quietRms.toFixed(6)}`);
	}
}

function verifyNaturalDefault(directory) {
	const input = path.join(directory, "natural-default-input.wav");
	const output = path.join(directory, "natural-default-clean.wav");
	fs.writeFileSync(input, wavBytes(deterministicSignal(4_096)));
	const result = spawnSync(helper, ["--input", input, "--output", output], { encoding: "utf8" });
	if (result.status !== 0) {
		throw new Error(`Natural default failed: ${result.stderr || result.stdout}`);
	}
	const report = JSON.parse(result.stdout);
	if (report.attenuationLimitDb !== 6) {
		throw new Error(`Natural default is ${report.attenuationLimitDb} dB instead of 6 dB`);
	}
	console.log("natural-default: 6 dB attenuation cap");
}

function verifyRawInputCannotBeOverwritten(directory) {
	const input = path.join(directory, "immutable-raw.wav");
	const original = wavBytes(deterministicSignal(4_096));
	fs.writeFileSync(input, original);
	const result = spawnSync(helper, ["--input", input, "--output", input], { encoding: "utf8" });
	if (result.status === 0 || !result.stderr.includes("raw microphone is immutable")) {
		throw new Error("Clean Voice did not reject an input/output path collision");
	}
	if (!fs.readFileSync(input).equals(original)) {
		throw new Error("Clean Voice changed the raw input after rejecting an output collision");
	}
	const alias = path.join(directory, "raw-alias.wav");
	fs.symlinkSync(input, alias);
	const aliasResult = spawnSync(helper, ["--input", input, "--output", alias], {
		encoding: "utf8",
	});
	if (aliasResult.status === 0 || !aliasResult.stderr.includes("raw microphone is immutable")) {
		throw new Error("Clean Voice did not reject an output symlink to the raw source");
	}
	if (!fs.readFileSync(input).equals(original)) {
		throw new Error("Clean Voice changed the raw input through an output symlink");
	}
	console.log("immutable-raw: overwrite rejected without changing the source");
}

function verifyFailureKeepsExistingOutput(directory) {
	const input = path.join(directory, "invalid-sample.wav");
	const output = path.join(directory, "existing-output.wav");
	const invalid = deterministicSignal(4_096);
	invalid[2_000] = Number.NaN;
	fs.writeFileSync(input, wavBytes(invalid));
	const sentinel = Buffer.from("existing output must survive");
	fs.writeFileSync(output, sentinel);
	const result = spawnSync(helper, ["--input", input, "--output", output], { encoding: "utf8" });
	if (result.status === 0 || !fs.readFileSync(output).equals(sentinel)) {
		throw new Error("Clean Voice replaced an existing output after processing failed");
	}
	console.log("failure-atomicity: existing output preserved after invalid input");
}

function verifyZeroAttenuationIsRejected(directory) {
	const input = path.join(directory, "zero-attenuation-input.wav");
	const output = path.join(directory, "zero-attenuation-output.wav");
	fs.writeFileSync(input, wavBytes(deterministicSignal(4_096)));
	const result = spawnSync(
		helper,
		["--input", input, "--output", output, "--attenuation-limit-db", "0"],
		{ encoding: "utf8" },
	);
	if (result.status === 0 || fs.existsSync(output)) {
		throw new Error("Clean Voice accepted the timing-unsafe 0 dB bypass");
	}
	console.log("zero-attenuation: rejected without publishing output");
}

function verifyLabTransaction(directory) {
	const input = path.join(directory, "lab-source.wav");
	const output = path.join(directory, "lab-natural");
	fs.writeFileSync(input, wavBytes(deterministicSignal(8_192)));
	const first = spawnSync(process.execPath, [labScript, input, "--output-dir", output], {
		cwd: root,
		encoding: "utf8",
	});
	if (first.status !== 0)
		throw new Error(`Clean Voice lab failed: ${first.stderr || first.stdout}`);
	const manifestPath = path.join(output, "clean-voice-manifest.json");
	const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
	if (
		manifest.preset.id !== "natural-v1" ||
		manifest.input.sampleCount !== 8_192 ||
		manifest.output.sampleCount !== 8_192 ||
		!manifest.quality.deterministic
	) {
		throw new Error("Clean Voice lab published an invalid Natural manifest");
	}
	const manifestHash = hash(manifestPath);
	const second = spawnSync(process.execPath, [labScript, input, "--output-dir", output], {
		cwd: root,
		encoding: "utf8",
	});
	if (second.status === 0 || hash(manifestPath) !== manifestHash) {
		throw new Error("Clean Voice lab changed a published transaction on rerun");
	}

	const failedOutput = path.join(directory, "lab-failed");
	const failed = spawnSync(
		process.execPath,
		[labScript, path.join(directory, "missing.wav"), "--output-dir", failedOutput],
		{ cwd: root, encoding: "utf8" },
	);
	const leakedStaging = fs
		.readdirSync(directory)
		.some((name) => name.startsWith(".lab-failed.") && name.endsWith(".tmp"));
	if (failed.status === 0 || fs.existsSync(failedOutput) || leakedStaging) {
		throw new Error("Clean Voice lab left partial output after a failed transaction");
	}
	console.log("lab-transaction: atomic publish and safe retry verified");
}

function verifyReleaseIsolation() {
	const legacyPackagedPath = path.join(
		root,
		"electron",
		"native",
		"bin",
		process.arch === "arm64" ? "darwin-arm64" : "darwin-x64",
		"klippt-clean-voice",
	);
	if (fs.existsSync(legacyPackagedPath)) {
		throw new Error(
			`Experimental helper leaked into a packaged native directory: ${legacyPackagedPath}`,
		);
	}
	const builder = fs.readFileSync(path.join(root, "electron-builder.json5"), "utf8");
	if (!builder.includes('"!darwin-*/klippt-clean-voice"')) {
		throw new Error("Electron Builder does not explicitly exclude the experimental helper");
	}
	console.log("release-isolation: experimental helper remains outside package input");
}

if (process.platform !== "darwin") {
	console.log("Clean Voice helper tests are macOS-only.");
	process.exit(0);
}
if (!fs.existsSync(helper)) {
	throw new Error(`Build the helper first: npm run build:native:clean-voice:mac`);
}
verifyReleaseIsolation();

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "klippt-clean-voice-test-"));
try {
	verifyNaturalDefault(directory);
	verifyRawInputCannotBeOverwritten(directory);
	verifyFailureKeepsExistingOutput(directory);
	verifyZeroAttenuationIsRejected(directory);
	verifyLabTransaction(directory);
	runFixture(directory, "empty", new Float32Array(0));
	runFixture(directory, "short", deterministicSignal(137));
	runFixture(directory, "partial-hop", deterministicSignal(12_347), true);
	verifyDigitalSilence(directory);
	verifyFinalHopOffsets(directory);
	runFixture(
		directory,
		"speech-after-silence",
		deterministicSignal(Math.round(4.4 * SAMPLE_RATE), 4 * SAMPLE_RATE),
		true,
	);
	verifySignalSilenceTransitions(directory);
	if (process.argv.includes("--long")) {
		runFixture(directory, "long", deterministicSignal(60 * SAMPLE_RATE), true);
	}
	console.log("Clean Voice helper checks passed.");
} finally {
	fs.rmSync(directory, { recursive: true, force: true });
}
