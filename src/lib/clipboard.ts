/** Write plain text through Klippt's narrow desktop bridge.
 * Browser mode keeps the standard web API as its only fallback. */
export function writeClipboardText(text: string): Promise<void> {
	const desktopWriter = window.electronAPI?.writeClipboardText;
	if (desktopWriter) return desktopWriter(text);
	if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
	return Promise.reject(new Error("Clipboard access is unavailable."));
}
