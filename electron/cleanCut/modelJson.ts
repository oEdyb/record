/** The first JSON object in a reply, whatever prose or code fence surrounds it. */
export function parseJsonObject(text: string): Record<string, unknown> {
	for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
		const end = objectEnd(text, start);
		if (end < 0) continue;
		try {
			const value: unknown = JSON.parse(text.slice(start, end + 1));
			if (value && typeof value === "object" && !Array.isArray(value)) {
				return value as Record<string, unknown>;
			}
		} catch {
			// not JSON at this brace, try the next one
		}
	}
	throw new Error(`No JSON in model reply: ${text.slice(0, 400)}`);
}

function objectEnd(text: string, start: number): number {
	let depth = 0;
	let inString = false;
	for (let i = start; i < text.length; i++) {
		const c = text[i];
		if (inString) {
			if (c === "\\") i += 1;
			else if (c === '"') inString = false;
		} else if (c === '"') inString = true;
		else if (c === "{") depth += 1;
		else if (c === "}") {
			depth -= 1;
			if (depth === 0) return i;
		}
	}
	return -1;
}
