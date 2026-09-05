import fs from "node:fs/promises";
import path from "node:path";

const FILES = ["manifest.json", "clean-microphone.wav", "preview-audio.m4a"] as const;
const HASH = /^[a-f0-9]{64}$/;
const DEFAULT_MAX_BYTES = 4 * 1024 ** 3;
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface CleanVoiceCacheInventory {
	completedEntries: number;
	completedBytes: number;
	removedEntries: number;
	removedBytes: number;
	skippedEntries: number;
}

/**
 * Run only at GUI cold start, under its single-instance lock and before the service
 * publishes any paths. CLI disables Clean Voice jobs. Runtime pruning needs reader
 * and export leases: a document change does not release previously published paths.
 *
 * Recognize only complete service-owned entries. Never follow a symlink or recursively
 * delete an unknown tree; source recordings and the processing staging directory are
 * outside this operation. Missing derived files remain a normal cache miss.
 */
export async function pruneCleanVoiceCacheAtStartup(
	cacheRoot: string,
	policy: { maxBytes?: number; maxAgeMs?: number; now?: number } = {},
): Promise<CleanVoiceCacheInventory> {
	const summary: CleanVoiceCacheInventory = {
		completedEntries: 0,
		completedBytes: 0,
		removedEntries: 0,
		removedBytes: 0,
		skippedEntries: 0,
	};
	const entriesDir = path.join(cacheRoot, "entries");
	const linksDir = path.join(cacheRoot, "links");
	const maxBytes = policy.maxBytes ?? DEFAULT_MAX_BYTES;
	const maxAgeMs = policy.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
	const now = policy.now ?? Date.now();
	if (![maxBytes, maxAgeMs, now].every((value) => Number.isFinite(value) && value >= 0)) {
		throw new Error("Invalid Clean Voice cache retention policy");
	}
	for (const directory of [cacheRoot, entriesDir, linksDir]) {
		const info = await fs.lstat(directory).catch(() => null);
		if (!info?.isDirectory() || info.isSymbolicLink()) return summary;
	}
	const entries: Array<{ key: string; directory: string; bytes: number; modified: number }> = [];
	for (const name of await fs.readdir(entriesDir)) {
		try {
			if (!HASH.test(name)) throw new Error("unknown entry name");
			const directory = path.join(entriesDir, name);
			const info = await fs.lstat(directory);
			if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("not a real directory");
			const names = await fs.readdir(directory);
			if (names.length !== FILES.length || FILES.some((file) => !names.includes(file))) {
				throw new Error("unknown entry content");
			}
			const stats = await Promise.all(FILES.map((file) => fs.lstat(path.join(directory, file))));
			if (stats.some((stat) => !stat.isFile() || stat.isSymbolicLink()))
				throw new Error("not real files");
			const manifest = JSON.parse(await fs.readFile(path.join(directory, FILES[0]), "utf8"));
			if (
				manifest.version !== 1 ||
				manifest.cacheKey !== name ||
				manifest.output?.file !== FILES[1] ||
				manifest.preview?.file !== FILES[2] ||
				!HASH.test(manifest.output?.sha256 ?? "") ||
				!HASH.test(manifest.preview?.sha256 ?? "") ||
				!Number.isFinite(Date.parse(manifest.createdAt))
			)
				throw new Error("unknown manifest");
			const bytes = stats.reduce((sum, stat) => sum + stat.size, 0);
			entries.push({
				key: name,
				directory,
				bytes,
				modified: Math.max(info.mtimeMs, ...stats.map((stat) => stat.mtimeMs)),
			});
			summary.completedEntries += 1;
			summary.completedBytes += bytes;
		} catch {
			summary.skippedEntries += 1;
		}
	}
	entries.sort((a, b) => a.modified - b.modified || a.key.localeCompare(b.key));
	const removed = new Set<string>();
	for (const entry of entries) {
		if (
			summary.completedBytes - summary.removedBytes <= maxBytes &&
			now - entry.modified <= maxAgeMs
		)
			continue;
		try {
			for (const file of FILES) await fs.unlink(path.join(entry.directory, file));
			await fs.rmdir(entry.directory);
			removed.add(entry.key);
			summary.removedEntries += 1;
			summary.removedBytes += entry.bytes;
		} catch {
			// A partial derived entry is rejected by normal cache validation on use.
			summary.skippedEntries += 1;
		}
	}
	if (removed.size > 0) {
		for (const name of await fs.readdir(linksDir)) {
			try {
				if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
				const linkPath = path.join(linksDir, name);
				const info = await fs.lstat(linkPath);
				if (!info.isFile() || info.isSymbolicLink()) continue;
				const link = JSON.parse(await fs.readFile(linkPath, "utf8"));
				if (
					link.version === 1 &&
					`${link.requestKey}.json` === name &&
					removed.has(link.cacheKey)
				) {
					await fs.unlink(linkPath);
				}
			} catch {
				/* A stale link is safely rejected on the next cache lookup. */
			}
		}
	}
	return summary;
}
