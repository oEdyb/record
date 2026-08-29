import { type RefObject, useEffect, useRef } from "react";

const FOCUSABLE = [
	"button:not([disabled])",
	"[href]",
	"input:not([disabled]):not([type='hidden'])",
	"select:not([disabled])",
	"textarea:not([disabled])",
	"[tabindex]:not([tabindex='-1'])",
].join(",");

function focusableElements(root: HTMLElement): HTMLElement[] {
	return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
		(element) => !element.hidden && element.getAttribute("aria-hidden") !== "true",
	);
}

/**
 * Gives custom dialogs the keyboard behavior that native desktop dialogs provide:
 * initial focus, Escape, a contained Tab loop, and focus restoration on close.
 */
export function useDialogFocus<T extends HTMLElement>(
	open: boolean,
	onClose: () => void,
): RefObject<T> {
	const dialogRef = useRef<T>(null);
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;

	useEffect(() => {
		if (!open) return;
		const dialog = dialogRef.current;
		if (!dialog) return;

		const previousFocus =
			document.activeElement instanceof HTMLElement ? document.activeElement : null;
		const initial =
			dialog.querySelector<HTMLElement>("[data-dialog-initial-focus]") ??
			focusableElements(dialog)[0] ??
			dialog;
		initial.focus({ preventScroll: true });

		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault();
				onCloseRef.current();
				return;
			}
			if (event.key !== "Tab") return;

			const focusable = focusableElements(dialog);
			if (focusable.length === 0) {
				event.preventDefault();
				dialog.focus({ preventScroll: true });
				return;
			}
			const first = focusable[0];
			const last = focusable.at(-1) ?? first;
			if (event.shiftKey && document.activeElement === first) {
				event.preventDefault();
				last.focus({ preventScroll: true });
			} else if (!event.shiftKey && document.activeElement === last) {
				event.preventDefault();
				first.focus({ preventScroll: true });
			}
		};

		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("keydown", onKeyDown);
			if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
		};
	}, [open]);

	return dialogRef;
}
