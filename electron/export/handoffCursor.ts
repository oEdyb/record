import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { copyOriginalFile } from "./copyOriginalFile";
import { fileIdentity } from "./handoffProvenance";

const assetSchema = z.object({
	id: z.string(),
	imageDataUrl: z.string(),
	width: z.number(),
	height: z.number(),
	hotspotX: z.number(),
	hotspotY: z.number(),
	scaleFactor: z.number().optional(),
});
const sidecarSchema = z.object({ version: z.number(), assets: z.array(assetSchema).default([]) });

async function cursorCaptureMode(screen: string) {
	const parsed = path.parse(screen);
	const name = parsed.name.replace(/-clip-\d+$/, "");
	const raw = await fs
		.readFile(path.join(parsed.dir, `${name}.session.json`), "utf8")
		.then((text): unknown => JSON.parse(text))
		.catch(() => null);
	if (!raw) return "unknown";
	const mode = z.enum(["editable-overlay", "system"]);
	const session = z
		.object({
			screenVideoPath: z.string().optional(),
			cursorCaptureMode: mode.optional(),
			clips: z
				.array(z.object({ screenVideoPath: z.string(), cursorCaptureMode: mode.optional() }))
				.optional(),
		})
		.safeParse(raw);
	if (!session.success) return "unknown";
	const clip = session.data.clips?.find((entry) => entry.screenVideoPath === screen);
	return (
		clip?.cursorCaptureMode ??
		(session.data.screenVideoPath === screen ? session.data.cursorCaptureMode : undefined) ??
		"unknown"
	);
}

export async function copyHandoffCursor(screen: string, prefix: string, directory: string) {
	const source = `${screen}.cursor.json`;
	const captureMode = await cursorCaptureMode(screen);
	const exists = await fs.stat(source).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return null;
		throw error;
	});
	if (!exists)
		return {
			available: false,
			offsetSec: 0,
			captureMode,
			reason: "No cursor sidecar next to the screen file.",
		};
	const canonical = await fs.realpath(source);
	if (canonical !== source)
		throw new Error("Cursor telemetry must be a regular file next to its screen recording.");
	const bytes = await fs.readFile(canonical);
	const data = sidecarSchema.parse(JSON.parse(bytes.toString("utf8")));
	const file = `${prefix}-cursor.json`;
	await copyOriginalFile(canonical, path.join(directory, file));
	const assetsFolder = `${prefix}-cursor-assets`;
	const assets = [];
	if (data.assets.length) await fs.mkdir(path.join(directory, assetsFolder));
	for (const [index, asset] of data.assets.entries()) {
		const match = /^data:image\/png;base64,([A-Za-z0-9+/=\r\n]+)$/.exec(asset.imageDataUrl);
		if (!match) throw new Error("Unsupported cursor asset image format.");
		const image = `${assetsFolder}/${String(index).padStart(3, "0")}.png`;
		await fs.writeFile(path.join(directory, image), Buffer.from(match[1], "base64"), {
			flag: "wx",
		});
		assets.push({
			id: asset.id,
			file: image,
			width: asset.width,
			height: asset.height,
			hotspotX: asset.hotspotX,
			hotspotY: asset.hotspotY,
			scaleFactor: asset.scaleFactor ?? 1,
			...(await fileIdentity(path.join(directory, image))),
		});
	}
	return {
		available: true,
		file,
		...(await fileIdentity(path.join(directory, file))),
		version: data.version,
		captureMode,
		captureModeEvidence:
			"Adjacent recording session manifest; unknown when no matching capture record exists. system means baked into screen pixels.",
		offsetSec: 0,
		units: "timeMs: milliseconds; cx/cy: normalized [0,1]",
		coordinateSpace: "captured source, top-left origin, x right, y down",
		hotspot:
			"hotspotX/Y and width/height are image pixels; divide by scaleFactor for display points",
		timebase:
			"screenTimeSec = timeMs / 1000. Native finalization removes pre-roll and paused intervals, then rebases each clip to zero. Do not subtract pauses or clip start again.",
		assets,
	};
}
