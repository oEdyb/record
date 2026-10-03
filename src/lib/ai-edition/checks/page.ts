import type { CheckRequest, CheckResult } from "./index";
import type { Finding } from "./types";

export const CHECK_REPLY_MAX_BYTES = 48 * 1024;
const PAGE_BYTES = 30 * 1024;
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
function boundedFinding(item: Finding): Finding {
	if (bytes(item) <= 4096) return item;
	return {
		...item,
		clip: item.clip?.slice(0, 128) ?? null,
		message: `${item.message.slice(0, 256)} [Oversized detail omitted; no fix supplied.]`,
		fix: null,
	};
}

export function pageChecks(
	result: CheckResult,
	request: Pick<CheckRequest, "page" | "page_size"> = {},
) {
	const pageSize = Math.max(1, Math.min(50, request.page_size ?? 50));
	const pages: Finding[][] = [[]];
	let size = 2;
	for (const original of result.findings) {
		const item = boundedFinding(original);
		const cost = bytes(item) + 1;
		let page = pages[pages.length - 1];
		if (page.length >= pageSize || size + cost > PAGE_BYTES) {
			page = [];
			pages.push(page);
			size = 2;
		}
		page.push(item);
		size += cost;
	}
	const page = Math.max(1, request.page ?? 1);
	const findings = pages[page - 1] ?? [];
	const notes: string[] = [];
	for (const note of result.notes) {
		const bounded = note.slice(0, 512);
		if (bytes([...notes, bounded]) > 4096) break;
		notes.push(bounded);
	}
	return {
		counts: result.counts,
		total: result.total,
		page,
		pages: pages.length,
		page_size: pageSize,
		offset: pages.slice(0, page - 1).reduce((count, items) => count + items.length, 0),
		findings,
		notes,
		notesOmitted: result.notes.length - notes.length,
		rules: result.rules,
	};
}
export type CheckPage = ReturnType<typeof pageChecks>;
