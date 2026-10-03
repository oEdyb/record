/** Best-effort token usage from an agent transcript; null when the CLI prints none. */
export function extractTokens(transcript) {
	const patterns = [
		/tokens?\s+used[:\s]+([\d,'’]+)/i,
		/total\s+tokens?[:\s]+([\d,'’]+)/i,
		/"total_tokens"\s*:\s*(\d+)/i,
	];
	for (const pattern of patterns) {
		const match = transcript.match(pattern);
		if (match) return Number.parseInt(match[1].replace(/[,'’]/g, ""), 10);
	}
	return null;
}
