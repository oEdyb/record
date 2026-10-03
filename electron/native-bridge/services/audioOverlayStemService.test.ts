import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AudioOverlayStemService } from "./audioOverlayStemService";

function wave(frames: number) {
	const data = Buffer.alloc(56 + frames * 8);
	data.write("RIFF");
	data.writeUInt32LE(data.length - 8, 4);
	data.write("WAVEfmt ", 8);
	data.writeUInt32LE(16, 16);
	data.writeUInt16LE(3, 20);
	data.writeUInt16LE(2, 22);
	data.writeUInt32LE(48000, 24);
	data.writeUInt32LE(384000, 28);
	data.writeUInt16LE(8, 32);
	data.writeUInt16LE(32, 34);
	data.write("fact", 36);
	data.writeUInt32LE(4, 40);
	data.writeUInt32LE(frames, 44);
	data.write("data", 48);
	data.writeUInt32LE(frames * 8, 52);
	return data;
}

describe("AudioOverlayStemService", () => {
	let directory: string;
	let source: string;
	let cache: string;
	beforeEach(async () => {
		directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "klippt-audio-stem-")));
		source = path.join(directory, "source.wav");
		cache = path.join(directory, "cache");
		await fs.writeFile(source, wave(4800));
	});
	afterEach(async () => {
		await fs.rm(directory, { recursive: true, force: true });
	});
	const input = (sourcePath: string, gain = 1) => ({
		durationSec: 0.1,
		audioOverlays: [
			{
				id: "a",
				sourcePath,
				startSec: 0,
				endSec: 0.1,
				sourceOffsetSec: 0,
				gain,
				fadeInSec: 0,
				fadeOutSec: 0,
			},
		],
	});
	function setup(
		renderOverride?: (request: string, output: string) => Promise<string>,
		maximum?: number,
	) {
		const render = vi.fn(
			renderOverride ??
				(async (request: string, output: string) => {
					const frames = Math.round(JSON.parse(request).durationSec * 48000);
					await fs.writeFile(output, wave(frames));
					return JSON.stringify({ sampleRate: 48000, channels: 2, frames, format: "float32-wav" });
				}),
		);
		const approve = vi.fn(async (p: string) => p);
		const service = new AudioOverlayStemService({
			cacheDirectory: cache,
			resolveSourcePath: (p) => (p === source ? source : null),
			approveOutputPath: approve,
			renderStem: render,
			maxCacheBytes: maximum,
		});
		return { service, render, approve };
	}
	it("rejects unauthorized preview and export audio before decoding", async () => {
		const { service, render, approve } = setup();
		await expect(service.get(input(path.join(directory, "private.wav")))).rejects.toThrow(
			"approved",
		);
		expect(() =>
			service.validateSceneSources(
				JSON.stringify({ audioOverlays: input("/private.wav").audioOverlays }),
			),
		).toThrow("approved");
		expect(() => service.validateSceneSources("{}")).not.toThrow();
		expect(render).not.toHaveBeenCalled();
		expect(approve).not.toHaveBeenCalled();
	});
	it("deduplicates jobs and reuses validated cache files", async () => {
		const { service, render } = setup();
		const [a, b] = await Promise.all([service.get(input(source)), service.get(input(source))]);
		expect(a).toEqual(b);
		expect(render).toHaveBeenCalledTimes(1);
		expect(a.sourceUrl).toMatch(/^klippt:\/\/app\/__media__\//);
		expect(await service.get(input(source))).toEqual(a);
		expect(render).toHaveBeenCalledTimes(1);
	});
	it("invalidates changed sources and regenerates corrupted cache files", async () => {
		const { service, render } = setup();
		const first = await service.get(input(source));
		await fs.writeFile(first.sourcePath, "broken");
		await service.get(input(source));
		expect(render).toHaveBeenCalledTimes(2);
		await fs.appendFile(source, "changed");
		const second = await service.get(input(source));
		expect(second.cacheKey).not.toBe(first.cacheKey);
		expect(render).toHaveBeenCalledTimes(3);
	});
	it("does not publish a stem if the source changes while native generation runs", async () => {
		const { service, approve } = setup(async (_request, output) => {
			await fs.writeFile(output, wave(4800));
			await fs.appendFile(source, "changed");
			return JSON.stringify({
				sampleRate: 48000,
				channels: 2,
				frames: 4800,
				format: "float32-wav",
			});
		});
		await expect(service.get(input(source))).rejects.toThrow("changed during");
		expect(approve).not.toHaveBeenCalled();
		expect(await fs.readdir(cache)).toEqual([]);
	});
	it("evicts only owned cache files to keep disk use bounded", async () => {
		const { service } = setup(undefined, 56 + 4800 * 8);
		const first = await service.get(input(source));
		await fs.writeFile(path.join(cache, "keep.txt"), "user");
		const second = await service.get(input(source, 0.5));
		await expect(fs.stat(first.sourcePath)).rejects.toThrow();
		expect((await fs.stat(second.sourcePath)).size).toBe(56 + 4800 * 8);
		expect(await fs.readFile(path.join(cache, "keep.txt"), "utf8")).toBe("user");
	});
	it("cleans failed partial output and permits retry", async () => {
		let attempt = 0;
		const { service, render } = setup(async (_request, output) => {
			attempt++;
			await fs.writeFile(output, wave(4800));
			if (attempt === 1) throw new Error("native failed");
			return JSON.stringify({
				sampleRate: 48000,
				channels: 2,
				frames: 4800,
				format: "float32-wav",
			});
		});
		await expect(service.get(input(source))).rejects.toThrow("native failed");
		expect(await fs.readdir(cache)).toEqual([]);
		await service.get(input(source));
		expect(render).toHaveBeenCalledTimes(2);
	});
	it("runs distinct native jobs serially", async () => {
		let running = 0;
		let maximum = 0;
		const { service } = setup(async (_request, output) => {
			running++;
			maximum = Math.max(maximum, running);
			await fs.writeFile(output, wave(4800));
			await new Promise((resolve) => setTimeout(resolve, 10));
			running--;
			return JSON.stringify({
				sampleRate: 48000,
				channels: 2,
				frames: 4800,
				format: "float32-wav",
			});
		});
		await Promise.all([service.get(input(source, 1)), service.get(input(source, 0.5))]);
		expect(maximum).toBe(1);
	});
});
