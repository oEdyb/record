// Phase-6 receipt hashes: previous file bytes / resulting document content plus
// sha256 of media a transaction imported, so a later agent can prove what an
// edit touched (Kinocut-style receipts). Receipts are written by
// ProjectTransactionStore.commit in electron/ai-edition/projectTransactions.ts;
// this module is the hashing helper that call site uses. Pure module: no
// Electron imports.

import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import type { AxcutDocument } from "../../src/lib/ai-edition/schema";

const READ_CHUNK_BYTES = 1024 * 1024;
/** Bound on assets hashed per receipt; imports arrive one or two at a time. */
const MAX_HASHED_MEDIA = 64;

/** Streaming sha256 of one regular file; reads at most one chunk at a time. */
export async function sha256File(filePath: string): Promise<string> {
	const handle = await open(filePath, "r");
	try {
		if (!(await handle.stat()).isFile()) throw new Error("Expected a regular file");
		const hash = createHash("sha256");
		const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
		let position = 0;
		for (;;) {
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
			if (!bytesRead) break;
			hash.update(buffer.subarray(0, bytesRead));
			position += bytesRead;
		}
		return hash.digest("hex");
	} finally {
		await handle.close();
	}
}

export interface ImportedMediaHash {
	asset_id: string;
	kind: string;
	path: string;
	sha256: string | null;
	status: "hashed" | "unreadable";
}

/**
 * sha256 of every asset the transaction added (present in `after`, absent in
 * `before` by id), video and audio. An unreadable file is reported, not thrown:
 * the commit must not fail because one media path cannot be hashed.
 */
export async function hashImportedMedia(
	before: AxcutDocument,
	after: AxcutDocument,
): Promise<ImportedMediaHash[]> {
	const beforeIds = new Set([
		...before.assets.map((asset) => asset.id),
		...(before.audioAssets ?? []).map((asset) => asset.id),
	]);
	const added = [
		...after.assets.map((asset) => ({
			id: asset.id,
			kind: asset.kind,
			path: asset.originalPath,
		})),
		...(after.audioAssets ?? []).map((asset) => ({
			id: asset.id,
			kind: "audio",
			path: asset.originalPath,
		})),
	].filter((asset) => !beforeIds.has(asset.id));
	const hashes: ImportedMediaHash[] = [];
	for (const asset of added.slice(0, MAX_HASHED_MEDIA)) {
		try {
			hashes.push({
				asset_id: asset.id,
				kind: asset.kind,
				path: asset.path,
				sha256: await sha256File(asset.path),
				status: "hashed",
			});
		} catch {
			hashes.push({
				asset_id: asset.id,
				kind: asset.kind,
				path: asset.path,
				sha256: null,
				status: "unreadable",
			});
		}
	}
	return hashes;
}

export interface ReceiptContentHashes {
	/** sha256 of the project file bytes before the commit. */
	sha256_before: string;
	/** sha256 of JSON.stringify(resulting document), excluding _klipptTransactions. */
	sha256_after: string;
	imported_media: ImportedMediaHash[];
}

/**
 * The caller supplies the before-file hash and after-document hash. The latter
 * excludes the embedded transaction metadata to avoid hashing the receipt into
 * itself. These are different scopes; this function adds imported-media hashes.
 */
export async function buildReceiptHashes(
	before: AxcutDocument,
	after: AxcutDocument,
	projectFile: { sha256Before: string; sha256After: string },
): Promise<ReceiptContentHashes> {
	return {
		sha256_before: projectFile.sha256Before,
		sha256_after: projectFile.sha256After,
		imported_media: await hashImportedMedia(before, after),
	};
}
