import { useRef } from "react";
import { useScopedT } from "@/contexts/I18nContext";
import styles from "./StudioWindow.module.css";

export function StudioSeparator({
	vertical,
	value,
	onChange,
	controls,
	reverse = false,
}: {
	vertical?: boolean;
	value: number;
	onChange: (value: number) => void;
	controls: string;
	reverse?: boolean;
}) {
	const t = useScopedT("launch");
	const dragging = useRef(false);
	return (
		<div
			role="separator"
			tabIndex={0}
			aria-label={t("studio.resize")}
			aria-orientation={vertical ? "vertical" : "horizontal"}
			aria-controls={controls}
			aria-valuemin={0}
			aria-valuemax={100}
			aria-valuenow={Math.round(value * 100)}
			aria-valuetext={`${Math.round(value * 100)}%`}
			className={vertical ? styles.verticalSeparator : styles.separator}
			onKeyDown={(e) => {
				e.stopPropagation();
				const delta = { ArrowLeft: -0.025, ArrowUp: -0.025, ArrowRight: 0.025, ArrowDown: 0.025 }[
					e.key
				];
				if (delta !== undefined) {
					e.preventDefault();
					onChange(value + delta * (reverse ? -1 : 1));
				} else if (e.key === "Enter") {
					e.preventDefault();
					onChange(vertical ? 0.32 : 0.6);
				} else if (e.key === "Home" || e.key === "End") {
					e.preventDefault();
					onChange(e.key === "End" ? 1 : 0);
				} else if ([" ", "Backspace"].includes(e.key)) e.preventDefault();
			}}
			onPointerDown={(e) => {
				dragging.current = true;
				e.currentTarget.setPointerCapture(e.pointerId);
			}}
			onPointerUp={(e) => {
				dragging.current = false;
				e.currentTarget.releasePointerCapture(e.pointerId);
			}}
			onPointerCancel={() => {
				dragging.current = false;
			}}
			onLostPointerCapture={() => {
				dragging.current = false;
			}}
			onPointerMove={(e) => {
				// A release the separator never saw (capture lost) must not leave it following the pointer.
				if (dragging.current && (e.buttons & 1) === 0) dragging.current = false;
				if (!dragging.current) return;
				const bounds = e.currentTarget.parentElement?.getBoundingClientRect();
				if (!bounds) return;
				let next = vertical
					? (e.clientX - bounds.left) / bounds.width
					: (e.clientY - bounds.top) / bounds.height;
				if (reverse) next = 1 - next;
				onChange(next);
			}}
		/>
	);
}
