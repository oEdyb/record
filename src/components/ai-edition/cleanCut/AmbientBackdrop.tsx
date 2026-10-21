import { useEffect, useRef } from "react";
import styles from "./AmbientBackdrop.module.css";

/**
 * A tiny, heavily blurred copy of the current frame behind the whole window, so it takes
 * the recording's light and the glass card has something to refract. It redraws only when
 * the frame changes.
 */
export function AmbientBackdrop({ video }: { video: HTMLVideoElement | null }) {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	useEffect(() => {
		const canvas = canvasRef.current;
		const context = canvas?.getContext("2d");
		if (!video || !canvas || !context) return;
		const draw = () => {
			if (video.readyState < 2) return;
			try {
				context.drawImage(video, 0, 0, canvas.width, canvas.height);
				canvas.dataset.lit = "";
			} catch {
				// A frame that cannot be drawn leaves the last one.
			}
		};
		draw();
		const events = ["loadeddata", "seeked", "timeupdate"] as const;
		for (const name of events) video.addEventListener(name, draw);
		return () => {
			for (const name of events) video.removeEventListener(name, draw);
		};
	}, [video]);
	return (
		<div className={styles.layer} aria-hidden="true">
			<canvas ref={canvasRef} className={styles.ambient} width={32} height={18} />
		</div>
	);
}
