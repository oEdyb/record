import { useLayoutEffect } from "react";
import { HUD_EDGE_SLACK, HUD_POPOVER_GAP } from "./hudGeometry";
import styles from "./LaunchWindow.module.css";

const SURFACES =
	"[data-hud-interactive='true'], [data-sonner-toast], [data-klippt-select-content], [role='tooltip']";

/**
 * Keep the Linux HUD's content independent of its viewport. Main sizes the real
 * input window from these same local rectangles, rather than reserving an ignored
 * transparent canvas. Observe portals too: Setup's selects live outside the anchor.
 */
export function useLinuxHudGeometry() {
	useLayoutEffect(() => {
		if (window.electronAPI?.getPlatform?.() !== "linux") return;
		const anchor = document.querySelector<HTMLElement>(`.${styles.hudAnchor}`);
		const bar = anchor?.querySelector<HTMLElement>(`.${styles.hudBar}`);
		if (!anchor || !bar) return;
		const originalStyle = anchor.getAttribute("style");
		let frame = 0;
		let signature = "";
		const writeStyle = (name: string, value: string) => {
			if (anchor.style.getPropertyValue(name) !== value) anchor.style.setProperty(name, value);
		};
		const measure = () => {
			frame = 0;
			// A native drag region consumes pointer presses before React sees them.
			// Keep the tappable logo usable for folding; drag-only timer grips can
			// still use compositor dragging. Niri also offers modifier+drag.
			for (const grip of anchor.querySelectorAll<HTMLElement>("[data-hud-grip]")) {
				if (grip.style.getPropertyValue("-webkit-app-region") !== "no-drag") {
					grip.style.setProperty("-webkit-app-region", "no-drag");
				}
			}
			const stack = anchor.querySelector<HTMLElement>(`.${styles.hudAbove}`);
			const stackHeight = stack?.offsetHeight ?? 0;
			const stackWidth = stack?.offsetWidth ?? 0;
			const barWidth = bar.offsetWidth;
			const above = anchor.dataset.placement !== "below";
			// The pill has a 14px tuck bump. Keep the ordinary pill at a stable
			// local origin; only an actual floating surface needs more native room.
			writeStyle("left", `${HUD_EDGE_SLACK + Math.max(0, (stackWidth - barWidth) / 2)}px`);
			writeStyle(
				"top",
				`${HUD_EDGE_SLACK + Math.max(14, above && stackHeight > 0 ? stackHeight + HUD_POPOVER_GAP : 0)}px`,
			);
			writeStyle("transform", "none");
			const rectangles = Array.from(document.querySelectorAll<HTMLElement>(SURFACES))
				.filter((element) => getComputedStyle(element).visibility !== "hidden")
				.map((element) => element.getBoundingClientRect())
				.filter((rect) => rect.width > 0 && rect.height > 0)
				.map(({ x, y, width, height }) => ({ x, y, width, height }));
			const next = JSON.stringify(rectangles);
			if (next === signature) return;
			signature = next;
			window.electronAPI.setHudDirectionExclusionRectangles?.(rectangles);
		};
		const schedule = () => {
			if (!frame) frame = requestAnimationFrame(measure);
		};
		const resize = new ResizeObserver(schedule);
		const observeSurfaces = () => {
			resize.disconnect();
			resize.observe(bar);
			for (const element of document.querySelectorAll(SURFACES)) resize.observe(element);
			const stack = anchor.querySelector(`.${styles.hudAbove}`);
			if (stack) resize.observe(stack);
		};
		const mutations = new MutationObserver((records) => {
			// The live microphone meter updates inline styles continuously. Those
			// paints must not cause geometry reads or observer re-subscriptions.
			const relevant = records.filter(
				(record) =>
					record.attributeName !== "style" ||
					record.target === anchor ||
					(record.target instanceof Element &&
						record.target.matches(`${SURFACES}, [data-radix-popper-content-wrapper]`)),
			);
			if (relevant.length === 0) return;
			if (relevant.some((record) => record.type === "childList")) observeSurfaces();
			schedule();
		});
		mutations.observe(document.body, { childList: true, subtree: true, attributes: true });
		observeSurfaces();
		window.addEventListener("resize", schedule);
		// Include the final geometry when a surface's CSS transition ends.
		anchor.addEventListener("transitionend", schedule);
		measure();
		return () => {
			mutations.disconnect();
			resize.disconnect();
			cancelAnimationFrame(frame);
			window.removeEventListener("resize", schedule);
			anchor.removeEventListener("transitionend", schedule);
			if (originalStyle === null) anchor.removeAttribute("style");
			else anchor.setAttribute("style", originalStyle);
		};
	}, []);
}
