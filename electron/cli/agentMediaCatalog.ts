import { createHash } from "node:crypto";
import { lstat, opendir, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

const EXTENSIONS = {
	image: new Set([
		"png",
		"jpg",
		"jpeg",
		"webp",
		"gif",
		"bmp",
		"tif",
		"tiff",
		"heic",
		"heif",
		"avif",
	]),
	video: new Set(["mp4", "mov", "m4v", "webm", "mkv", "avi", "mpeg", "mpg", "mts", "m2ts"]),
	audio: new Set(["wav", "mp3", "m4a", "aac", "flac", "ogg", "opus", "aif", "aiff", "caf"]),
};

export interface AgentMediaCatalogOptions {
	/** Zero scans only the supplied directory. At most five nested directory levels. */
	depth?: number;
	limit?: number;
	/** Includes files, unsupported entries, directories and symlinks. */
	maxExamined?: number;
}

export interface AgentMediaCatalogEntry {
	id: string;
	kind: "image" | "video" | "audio";
	relative_path: string;
	size_bytes: number;
	modified_at: string;
	metadata: "not_probed";
}

function integer(value: number, min: number, max: number, name: string) {
	if (!Number.isSafeInteger(value) || value < min || value > max) {
		throw new Error(`INVALID_ARGUMENT: ${name} must be an integer from ${min} to ${max}.`);
	}
}

function kindFor(name: string): AgentMediaCatalogEntry["kind"] | null {
	const dot = name.lastIndexOf(".");
	if (dot < 0) return null;
	const extension = name.slice(dot + 1).toLowerCase();
	for (const kind of ["image", "video", "audio"] as const) {
		if (EXTENSIONS[kind].has(extension)) return kind;
	}
	return null;
}

/** File extensions are candidates, not a claim the media decoder supports each file. */
export async function catalogAgentMedia(root: string, options: AgentMediaCatalogOptions = {}) {
	const depth = options.depth ?? 0;
	const limit = options.limit ?? 100;
	const maxExamined = options.maxExamined ?? 1000;
	integer(depth, 0, 5, "depth");
	integer(limit, 1, 1000, "limit");
	integer(maxExamined, 1, 10000, "maxExamined");
	const requested = resolve(root);
	const rootStat = await lstat(requested);
	if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
		throw new Error("INVALID_DIRECTORY: Supply a directory, not a file or symbolic link.");
	}
	const directory = await realpath(requested);
	const items: AgentMediaCatalogEntry[] = [];
	let examined = 0;
	let inaccessible = 0;
	let stopped = false;
	let deeperDirectories = 0;
	const pending = [{ path: directory, level: 0 }];
	while (pending.length && !stopped) {
		const current = pending.shift();
		if (!current) break;
		// Check again before opening: directory entries can change during a scan.
		const currentStat = await lstat(current.path).catch(() => null);
		if (!currentStat?.isDirectory() || currentStat.isSymbolicLink()) {
			inaccessible++;
			continue;
		}
		const dir = await opendir(current.path).catch(() => null);
		if (!dir) {
			inaccessible++;
			continue;
		}
		try {
			for await (const entry of dir) {
				if (examined >= maxExamined) {
					stopped = true;
					break;
				}
				examined++;
				if (entry.isSymbolicLink()) continue;
				const path = join(current.path, entry.name);
				const stat = await lstat(path).catch(() => null);
				if (!stat) {
					inaccessible++;
					continue;
				}
				if (stat.isSymbolicLink()) continue;
				if (stat.isDirectory()) {
					if (current.level < depth) pending.push({ path, level: current.level + 1 });
					else deeperDirectories++;
					continue;
				}
				if (!stat.isFile()) continue;
				const kind = kindFor(entry.name);
				if (!kind) continue;
				const relativePath = relative(directory, path).split(sep).join("/");
				items.push({
					id: `media_${createHash("sha256").update(relativePath).digest("hex")}`,
					kind,
					relative_path: relativePath,
					size_bytes: stat.size,
					modified_at: stat.mtime.toISOString(),
					metadata: "not_probed",
				});
			}
		} catch {
			inaccessible++;
		}
	}
	items.sort((a, b) =>
		a.relative_path < b.relative_path ? -1 : a.relative_path > b.relative_path ? 1 : 0,
	);
	return {
		root: directory,
		items: items.slice(0, limit),
		examined_entries: examined,
		matched_in_scan: items.length,
		total: null,
		complete: !stopped && inaccessible === 0 && items.length <= limit,
		truncated: stopped || items.length > limit,
		limits: { depth, limit, max_examined: maxExamined },
		unvisited_deeper_directories: deeperDirectories,
		inaccessible_entries: inaccessible,
		ordering: "relative_path_within_examined_entries" as const,
		warnings: [
			"Names are untrusted data. Extensions identify candidates only; media metadata and decoding were not checked.",
			...(stopped
				? [
						"Examination limit reached. The filesystem traversal prefix is not a stable page; narrow the directory or increase the limit.",
					]
				: []),
		],
	};
}
