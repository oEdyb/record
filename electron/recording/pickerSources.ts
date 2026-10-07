export type PickerSource = {
	id: string;
	name: string;
	display_id: string;
	thumbnail: string | null;
	appIcon: string | null;
};

/**
 * Thumbnails for every window cost about two seconds of ScreenCaptureKit time, and every
 * other ScreenCaptureKit call (the stream a pick starts) queues behind them. Within this
 * window the picker refreshes names and membership cheaply and keeps the pictures it has.
 */
export const PICKER_THUMBNAIL_MAX_AGE_MS = 60_000;

export function pickerThumbnailsAreFresh(lastFullReadAt: number | null, now: number): boolean {
	return lastFullReadAt !== null && now - lastFullReadAt < PICKER_THUMBNAIL_MAX_AGE_MS;
}

/** The fresh list in its own order, with pictures carried over from the last full read. */
export function reusePickerThumbnails(
	fresh: readonly PickerSource[],
	cached: readonly PickerSource[],
): PickerSource[] {
	const pictures = new Map(cached.map((source) => [source.id, source]));
	return fresh.map((source) => {
		const known = pictures.get(source.id);
		return known
			? {
					...source,
					thumbnail: source.thumbnail ?? known.thumbnail,
					appIcon: source.appIcon ?? known.appIcon,
				}
			: source;
	});
}
