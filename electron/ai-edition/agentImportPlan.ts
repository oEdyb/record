import fs from "node:fs/promises";
import path from "node:path";
import { nativeImage } from "electron";
import { z } from "zod";
import { type AxcutAsset, type AxcutDocument, assetSchema } from "../../src/lib/ai-edition/schema";
import { audioAssetSchema } from "../../src/lib/ai-edition/schema/audioOverlays";
import { overlayAnchorSchema } from "../../src/lib/ai-edition/schema/overlayAnchor";
import { prepareAgentEditPlan } from "./agentEditPlan";
import type { DocumentService } from "./document-service";

const seconds = z.number().finite().min(0).max(10800);
const percent = z.number().finite().min(0).max(100);
const localPath = z
	.string()
	.min(1)
	.max(4096)
	.refine(path.isAbsolute, "Supply an absolute local file path");
export const agentImportMediaSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("image"),
		path: localPath,
		placement: z.strictObject({
			startSec: seconds,
			endSec: seconds,
			position: z.strictObject({ x: percent, y: percent }),
			size: z.strictObject({ width: percent.positive(), height: percent.positive() }),
		}),
	}),
	z.strictObject({
		kind: z.literal("video"),
		path: localPath,
		placement: z.strictObject({
			anchor: overlayAnchorSchema.optional(),
			motion: z.enum(["fade", "cut"]).optional(),
			startSec: seconds,
			endSec: seconds,
			sourceOffsetSec: seconds.default(0),
			fit: z.enum(["cover", "contain"]).default("cover"),
			position: z.strictObject({ x: percent, y: percent }).optional(),
			size: z.strictObject({ width: percent.positive(), height: percent.positive() }).optional(),
			opacity: z.number().finite().min(0).max(1).default(1),
		}),
	}),
	z.strictObject({
		kind: z.literal("audio"),
		path: localPath,
		placement: z.strictObject({
			startSec: seconds,
			endSec: seconds,
			sourceOffsetSec: seconds.default(0),
			gain: z.number().finite().min(0).max(4).default(1),
			fadeInSec: seconds.default(0),
			fadeOutSec: seconds.default(0),
		}),
	}),
]);
export const agentImportRequestSchema = z.strictObject({
	projectId: z.string().min(1).max(256),
	media: agentImportMediaSchema,
});
const MAX_IMAGE_BYTES = 512 * 1024;

/** Header dimensions bound decoding cost; the native decoder then validates pixels.
 * https://www.electronjs.org/docs/latest/api/native-image#nativeimagecreatefrombufferbuffer-options
 * WebP is accepted only if the installed native decoder can decode it.
 */
export function imageHeader(bytes: Buffer): { mime: string; width: number; height: number } {
	if (
		bytes.length >= 24 &&
		bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
		bytes.toString("ascii", 12, 16) === "IHDR"
	)
		return { mime: "png", width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
	if (
		bytes.length >= 30 &&
		bytes.toString("ascii", 0, 4) === "RIFF" &&
		bytes.toString("ascii", 8, 12) === "WEBP"
	) {
		const type = bytes.toString("ascii", 12, 16);
		if (type === "VP8X")
			return {
				mime: "webp",
				width: 1 + bytes.readUIntLE(24, 3),
				height: 1 + bytes.readUIntLE(27, 3),
			};
		if (type === "VP8 " && bytes.subarray(23, 26).equals(Buffer.from([157, 1, 42])))
			return {
				mime: "webp",
				width: bytes.readUInt16LE(26) & 16383,
				height: bytes.readUInt16LE(28) & 16383,
			};
		if (type === "VP8L" && bytes[20] === 47) {
			const bits = bytes.readUInt32LE(21);
			return { mime: "webp", width: 1 + (bits & 16383), height: 1 + ((bits >>> 14) & 16383) };
		}
	}
	if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216) {
		let offset = 2;
		while (offset + 4 <= bytes.length) {
			if (bytes[offset] !== 255) break;
			while (bytes[offset] === 255) offset++;
			const marker = bytes[offset++];
			if (marker === 217 || marker === 218) break;
			if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
			if (offset + 2 > bytes.length) break;
			const length = bytes.readUInt16BE(offset);
			if (length < 2 || offset + length > bytes.length) break;
			if (
				[192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker) &&
				length >= 8
			)
				return {
					mime: "jpeg",
					width: bytes.readUInt16BE(offset + 5),
					height: bytes.readUInt16BE(offset + 3),
				};
			offset += length;
		}
	}
	throw new Error("INVALID_IMAGE: Supply PNG, JPEG or supported WebP; SVG is not allowed.");
}
async function readInlineImage(filePath: string) {
	const handle = await fs.open(filePath, "r");
	try {
		const stat = await handle.stat();
		if (!stat.isFile() || stat.size === 0 || stat.size > MAX_IMAGE_BYTES)
			throw new Error("IMAGE_TOO_LARGE: Image must be a nonempty file of at most 512 KiB.");
		// Read only the measured bound, even if another process grows the file.
		const bytes = Buffer.alloc(Number(stat.size));
		const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
		if (bytesRead !== bytes.length) throw new Error("SOURCE_CHANGED: Image changed while reading.");
		const header = imageHeader(bytes);
		if (
			header.width <= 0 ||
			header.height <= 0 ||
			header.width > 8192 ||
			header.height > 8192 ||
			header.width * header.height > 16_777_216
		)
			throw new Error("IMAGE_DIMENSIONS: Image exceeds the 16 megapixel / 8192 pixel bounds.");
		const decoded = nativeImage.createFromBuffer(bytes);
		if (decoded.isEmpty())
			throw new Error("INVALID_IMAGE: The installed image decoder rejected this file.");
		const dimensions = decoded.getSize();
		if (dimensions.width !== header.width || dimensions.height !== header.height)
			throw new Error("INVALID_IMAGE: Image dimensions do not match its header.");
		return { dataUrl: `data:image/${header.mime};base64,${bytes.toString("base64")}`, dimensions };
	} finally {
		await handle.close();
	}
}

/** Caller is the explicit local CLI import command, never editable project JSON. */
export async function prepareAgentImportPlan(
	base: AxcutDocument,
	rawMedia: unknown,
	dependencies: {
		prepareAudioAsset: DocumentService["prepareAudioAsset"];
		prepareVideoAsset?: (projectId: string, file: string) => Promise<AxcutAsset>;
		approveSelectedMedia: (file: string) => Promise<string | null>;
	},
) {
	const media = agentImportMediaSchema.parse(rawMedia);
	if (media.placement.endSec <= media.placement.startSec)
		throw new Error("INVALID_RANGE: End must exceed start.");
	if (media.kind === "image") {
		const image = await readInlineImage(media.path);
		const plan = prepareAgentEditPlan(base, [
			{
				type: "addAnnotation",
				args: { ...media.placement, text: "", imageDataUrl: image.dataUrl },
			},
		]);
		return {
			...plan,
			results: [{ type: "import-image", result: { path: media.path, ...image.dimensions } }],
		};
	}
	if (media.kind === "video") {
		if (!dependencies.prepareVideoAsset)
			throw new Error("IMPORT_UNAVAILABLE: Video preparation is unavailable");
		const approvedVideo = await dependencies.approveSelectedMedia(media.path);
		if (!approvedVideo) throw new Error("MEDIA_UNAVAILABLE: Video file could not be approved.");
		const asset = assetSchema.parse(
			await dependencies.prepareVideoAsset(base.project.id, approvedVideo),
		);
		if (asset.durationSec === undefined)
			throw new Error("MEDIA_UNAVAILABLE: Video duration could not be read");
		const { position, size, ...placement } = media.placement;
		if ((position === undefined) !== (size === undefined))
			throw new Error("INVALID_INPUT: Supply both position and size, or neither.");
		const plan = prepareAgentEditPlan({ ...base, assets: [...base.assets, asset] }, [
			{
				type: "addVideoOverlay",
				args: {
					assetId: asset.id,
					...placement,
					placement: position && size ? { ...position, ...size } : null,
				},
			},
		]);
		return {
			...plan,
			changed_ids: [asset.id, ...plan.changed_ids].slice(0, 200),
			changed_count: plan.changed_count + 1,
			changed_ids_truncated: plan.changed_count + 1 > 200,
			results: [
				{ type: "import-video", result: { assetId: asset.id, durationSec: asset.durationSec } },
				...plan.results,
			],
		};
	}
	const approved = await dependencies.approveSelectedMedia(media.path);
	if (!approved) throw new Error("MEDIA_UNAVAILABLE: Audio file could not be approved.");
	const asset = audioAssetSchema.parse(
		await dependencies.prepareAudioAsset(base.project.id, approved),
	);
	const plan = prepareAgentEditPlan(
		{ ...base, audioAssets: [...(base.audioAssets ?? []), asset] },
		[{ type: "addAudioClip", args: { assetId: asset.id, ...media.placement } }],
	);
	return {
		...plan,
		changed_ids: [asset.id, ...plan.changed_ids].slice(0, 200),
		changed_count: plan.changed_count + 1,
		changed_ids_truncated: plan.changed_count + 1 > 200,
		results: [
			{ type: "import-audio", result: { assetId: asset.id, durationSec: asset.durationSec } },
			...plan.results,
		],
	};
}
