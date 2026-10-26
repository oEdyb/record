type PortalHudWindow = {
	isDestroyed: () => boolean;
	isVisible: () => boolean;
	hide: () => void;
	showInactive: () => void;
};

/** Keep the always-on-top HUD out of the compositor's consent picker. */
export async function withHiddenPortalHud<T>(
	getWindow: () => PortalHudWindow | null,
	selectSource: () => Promise<T>,
): Promise<T> {
	const window = getWindow();
	const wasVisible = window && !window.isDestroyed() && window.isVisible();
	if (wasVisible) window.hide();
	try {
		return await selectSource();
	} finally {
		if (wasVisible && getWindow() === window && !window.isDestroyed()) window.showInactive();
	}
}
