import { useEffect } from "react";

const ALERT_TOAST =
	'[data-sonner-toast][data-type="error"]:not([data-removed="true"]),[data-sonner-toast][data-type="warning"]:not([data-removed="true"])';

/** Tells main while a warning or error toast is up, so a pill under the Studio is lifted to show it. */
export function useStudioPillNotice() {
	useEffect(() => {
		let active = false;
		const check = () => {
			const next = document.querySelector(ALERT_TOAST) !== null;
			if (next === active) return;
			active = next;
			window.electronAPI?.studioPillNotice?.(next);
		};
		const observer = new MutationObserver(check);
		observer.observe(document.body, {
			subtree: true,
			childList: true,
			attributes: true,
			attributeFilter: ["data-type", "data-removed"],
		});
		check();
		return () => observer.disconnect();
	}, []);
}
