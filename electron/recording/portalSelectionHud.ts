type PortalHudWindow = {
	isDestroyed(): boolean;
	isVisible(): boolean;
	hide(): void;
	showInactive(): void;
};
type Selection = {
	cancelled: boolean;
	hidden: boolean;
	wasVisible: boolean;
};
const selections = new WeakMap<object, Selection>();
const placements = new WeakMap<object, Promise<void>>();

export function cancelPortalHudSelection(window: object | null): void {
	const selection = window && selections.get(window);
	if (selection) selection.cancelled = true;
}

export function supersedePortalHudSelection(window: object | null): Promise<void> | undefined {
	if (!window) return;
	const selection = selections.get(window);
	selections.delete(window);
	if (selection) selection.cancelled = true;
	return placements.get(window);
}

/** Keep the HUD out of the picker without letting an old picker reveal another take. */
export async function withHiddenPortalHud<T>(
	getWindow: () => PortalHudWindow | null,
	selectSource: () => Promise<T>,
	rememberPlacement?: () => Promise<((mayRestore: () => boolean) => Promise<void>) | undefined>,
): Promise<T> {
	const window = getWindow();
	if (!window || window.isDestroyed()) return selectSource();
	const previous = selections.get(window);
	const wasVisible = window.isVisible() || Boolean(previous?.hidden && previous.wasVisible);
	const previousRestoration = supersedePortalHudSelection(window);
	const selection: Selection = { cancelled: false, hidden: false, wasVisible };
	selections.set(window, selection);
	const mayRestore = () =>
		selections.get(window) === selection && getWindow() === window && !window.isDestroyed();
	const checkCancelled = () => {
		if (selection.cancelled) throw new Error("Source selection cancelled.");
	};
	let restorePlacement: ((mayRestore: () => boolean) => Promise<void>) | undefined;
	try {
		if (previousRestoration) await previousRestoration;
		checkCancelled();
		if (wasVisible) {
			try {
				if (rememberPlacement) restorePlacement = await rememberPlacement();
			} catch (error) {
				console.warn("Could not remember recorder placement:", error);
			}
			checkCancelled();
			if (mayRestore()) {
				window.hide();
				selection.hidden = true;
			}
		}
		const result = await selectSource();
		checkCancelled();
		return result;
	} finally {
		if (selection.hidden && mayRestore()) {
			window.showInactive();
			const restoring = (async () => {
				try {
					await restorePlacement?.(mayRestore);
				} catch (error) {
					console.warn("Could not restore recorder placement:", error);
				}
			})();
			placements.set(window, restoring);
			await restoring;
			if (placements.get(window) === restoring) placements.delete(window);
		}
		if (selections.get(window) === selection) selections.delete(window);
		checkCancelled();
	}
}
