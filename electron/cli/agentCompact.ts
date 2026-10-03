import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const bulky = new Set([
	"assets",
	"clips",
	"words",
	"sentences",
	"operations",
	"findings",
	"annotations",
	"regions",
	"candidate",
	"document",
	"content",
]);
function summarize(value: unknown): unknown {
	if (typeof value === "string" && value.startsWith("data:"))
		return { omitted: "inline_media", in_full_reply: true };
	if (Array.isArray(value)) return value.map(summarize);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value).map(([key, item]) => [
			key,
			bulky.has(key) &&
			(Array.isArray(item) || typeof item === "string" || (item && typeof item === "object"))
				? {
						count: Array.isArray(item) ? item.length : undefined,
						...(key === "findings" && Array.isArray(item)
							? {
									counts: {
										error: item.filter((row) => row?.severity === "error").length,
										warning: item.filter((row) => row?.severity === "warning").length,
										info: item.filter((row) => row?.severity === "info").length,
									},
								}
							: {}),
						in_full_reply: true,
					}
				: summarize(item),
		]),
	);
}

export function compactAgentReply(reply: Record<string, unknown>, directory: string) {
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const artifact = path.join(
		directory,
		`${String(reply.request_id).replace(/[^A-Za-z0-9_-]/g, "_")}.json`,
	);
	writeFileSync(artifact, JSON.stringify(reply), { mode: 0o600 });
	return {
		...reply,
		data: summarize(reply.data),
		full_reply_path: artifact,
		output_mode: "compact",
	};
}
