import type { StudioLayout } from "@/lib/userPreferences";

export function dockFraction(fraction: number, width: number): number {
	if (width < 640) return 260 / 640;
	return Math.min((width - 380) / width, Math.max(260 / width, fraction));
}
export function splitLayout(layout: StudioLayout) {
	return { replay: layout.view !== "camera", camera: layout.view !== "replay" };
}
export function studioKeyAllowed(
	event: Pick<
		KeyboardEvent,
		"key" | "altKey" | "ctrlKey" | "metaKey" | "isComposing" | "defaultPrevented"
	>,
	target: EventTarget | null,
): boolean {
	if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey)
		return false;
	if (!(target instanceof HTMLElement) || !target.closest("[data-studio-document]")) return false;
	if (
		target.closest(
			'input,select,textarea,[contenteditable="true"],[role="separator"],[role="slider"]',
		)
	)
		return false;
	// A focused button keeps Space, Enter, arrows and Backspace; letter shortcuts like M still work.
	return !target.closest("button") || (event.key.length === 1 && event.key !== " ");
}
export function sentenceTarget(
	times: readonly number[],
	current: number,
	direction: number,
): number | null {
	if (!times.length) return null;
	if (direction > 0) return times.find((t) => t > current + 0.05) ?? times[times.length - 1];
	return [...times].reverse().find((t) => t < current - 0.05) ?? times[0];
}
