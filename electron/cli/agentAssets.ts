import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { AxcutDocument } from "../../src/lib/ai-edition/schema";

const execute = promisify(execFile);
export function thumbnailCacheKey(file: string, mtimeMs: number, size: number) {
	return createHash("sha256")
		.update(JSON.stringify(["jpeg-320-v1", path.resolve(file), mtimeMs, size]))
		.digest("hex");
}
export async function runMediaProcess(executable: string, args: string[]) {
	return execute(executable, args, { timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true });
}
export async function assetThumbnails(
	file: string,
	cacheDirectory: string,
	ffmpeg: string,
	knownDuration?: number,
	run = runMediaProcess,
) {
	if (!path.isAbsolute(file)) throw new Error("ASSET_PATH_INVALID: Expected an absolute path.");
	const stat = await fs.stat(file);
	if (!stat.isFile()) throw new Error("ASSET_PATH_INVALID: Expected a file.");
	const key = thumbnailCacheKey(file, stat.mtimeMs, stat.size);
	const directory = path.join(cacheDirectory, key);
	const manifest = path.join(directory, "metadata.json");
	try {
		const cached: unknown = JSON.parse(await fs.readFile(manifest, "utf8"));
		const { z } = await import("zod");
		const result = z
			.object({
				durationSec: z.number().nullable(),
				width: z.number().nullable(),
				height: z.number().nullable(),
				first: z.string(),
				middle: z.string(),
			})
			.parse(cached);
		if (
			result.first !== path.join(directory, "first.jpg") ||
			result.middle !== path.join(directory, "middle.jpg")
		)
			throw new Error("CACHE_INVALID");
		await fs.access(result.first);
		await fs.access(result.middle);
		return { ...result, cached: true };
	} catch {
		/* Missing or incomplete cache is regenerated. */
	}
	await fs.mkdir(cacheDirectory, { recursive: true });
	const temp = await fs.mkdtemp(path.join(cacheDirectory, `.${key}-`));
	try {
		let header = "";
		try {
			header = (await run(ffmpeg, ["-hide_banner", "-i", file])).stderr;
		} catch (error) {
			if (
				error &&
				typeof error === "object" &&
				"stderr" in error &&
				typeof error.stderr === "string"
			)
				header = error.stderr;
			else throw error;
		}
		const duration = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(header);
		const durationSec =
			knownDuration ??
			(duration
				? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3])
				: null);
		const dimensions = /Video:[^\r\n]*?\b(\d{2,5})x(\d{2,5})\b/.exec(header);
		const width = dimensions ? Number(dimensions[1]) : null;
		const height = dimensions ? Number(dimensions[2]) : null;
		const audioOnly = !dimensions && /Audio:/.test(header);
		for (const [name, time] of [
			["first", 0],
			["middle", (durationSec ?? 0) / 2],
		] as const) {
			await run(ffmpeg, [
				"-hide_banner",
				"-loglevel",
				"error",
				"-nostdin",
				"-ss",
				String(time),
				...(audioOnly ? ["-t", "0.25"] : []),
				"-i",
				file,
				"-frames:v",
				"1",
				...(audioOnly
					? ["-filter_complex", "showwavespic=s=320x180:colors=white"]
					: ["-vf", "scale=320:-2"]),
				"-q:v",
				"3",
				"-y",
				path.join(temp, `${name}.jpg`),
			]);
		}
		const after = await fs.stat(file);
		if (after.mtimeMs !== stat.mtimeMs || after.size !== stat.size)
			throw new Error("ASSET_CHANGED: Retry thumbnails.");
		const result = {
			durationSec,
			width,
			height,
			first: path.join(directory, "first.jpg"),
			middle: path.join(directory, "middle.jpg"),
		};
		await fs.writeFile(path.join(temp, "metadata.json"), JSON.stringify(result), { flag: "wx" });
		await fs.rename(temp, directory).catch(async (error) => {
			if (error.code !== "EEXIST" && error.code !== "ENOTEMPTY") throw error;
			for (const name of ["first.jpg", "middle.jpg", "metadata.json"])
				await fs.rename(path.join(temp, name), path.join(directory, name));
			await fs.rm(temp, { recursive: true, force: true });
		});
		return { ...result, cached: false };
	} catch (error) {
		await fs.rm(temp, { recursive: true, force: true });
		throw error;
	}
}
export async function listAgentAssets(
	document: AxcutDocument,
	cacheDirectory: string,
	ffmpeg: string,
) {
	const assets = [...document.assets, ...(document.audioAssets ?? [])];
	const results = [];
	for (const asset of assets) {
		const file = asset.originalPath;
		try {
			results.push({
				id: asset.id,
				label: asset.label,
				path: file,
				...(await assetThumbnails(file, cacheDirectory, ffmpeg, asset.durationSec)),
			});
		} catch (error) {
			results.push({
				id: asset.id,
				label: asset.label,
				path: file,
				durationSec: asset.durationSec ?? null,
				first: null,
				middle: null,
				error: String(error),
			});
		}
	}
	return results;
}
export async function contactSheet(files: string[], directory: string, ffmpeg: string) {
	const staging = await fs.mkdtemp(path.join(directory, ".sheet-"));
	const output = path.join(directory, `contact-${randomUUID()}.jpg`);
	try {
		for (const [i, file] of files.entries())
			await fs.copyFile(file, path.join(staging, `${i}.png`));
		const columns = Math.min(4, files.length);
		await runMediaProcess(ffmpeg, [
			"-hide_banner",
			"-loglevel",
			"error",
			"-nostdin",
			"-framerate",
			"1",
			"-i",
			path.join(staging, "%d.png"),
			"-vf",
			`scale=320:-2,tile=${columns}x${Math.ceil(files.length / columns)}:nb_frames=${files.length}:padding=8:margin=8`,
			"-frames:v",
			"1",
			"-q:v",
			"3",
			"-n",
			output,
		]);
		return output;
	} finally {
		await fs.rm(staging, { recursive: true, force: true });
	}
}

export async function prepareStillVideo(
	file: string,
	durationSec: number,
	mediaDirectory: string,
	ffmpeg: string,
) {
	if (path.extname(file).toLowerCase() !== ".png") return file;
	if (!Number.isFinite(durationSec) || durationSec <= 0 || durationSec > 10800)
		throw new Error("INVALID_IMAGE_DURATION");
	const stat = await fs.stat(file);
	const key = thumbnailCacheKey(file, stat.mtimeMs, stat.size);
	const output = path.join(mediaDirectory, `${key}-${Math.ceil(durationSec)}.mp4`);
	if (
		await fs.access(output).then(
			() => true,
			() => false,
		)
	)
		return output;
	await fs.mkdir(mediaDirectory, { recursive: true });
	const temp = path.join(mediaDirectory, `${randomUUID()}.mp4`);
	try {
		await runMediaProcess(ffmpeg, [
			"-hide_banner",
			"-loglevel",
			"error",
			"-nostdin",
			"-loop",
			"1",
			"-framerate",
			"1",
			"-i",
			file,
			"-t",
			String(Math.ceil(durationSec)),
			"-vf",
			"scale=trunc(iw/2)*2:trunc(ih/2)*2",
			"-c:v",
			"h264_videotoolbox",
			"-allow_sw",
			"1",
			"-pix_fmt",
			"yuv420p",
			"-an",
			"-n",
			temp,
		]);
		const after = await fs.stat(file);
		if (after.mtimeMs !== stat.mtimeMs || after.size !== stat.size)
			throw new Error("ASSET_CHANGED");
		await fs.rename(temp, output);
		return output;
	} catch (error) {
		await fs.rm(temp, { force: true });
		throw error;
	}
}
