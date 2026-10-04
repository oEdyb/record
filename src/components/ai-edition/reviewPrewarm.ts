/**
 * Electron loads the review hidden while the first take records. That window
 * opens no project until Stop hands it the finished take.
 */
export function isPrewarmedReview(search: string) {
	return new URLSearchParams(search).get("prewarm") === "1";
}
