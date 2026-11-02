import { type PointerEvent, type Ref, useRef, useState } from "react";
import {
	type EditorDefaultPreferences,
	saveEditorDefaultPreferences,
} from "@/lib/ai-edition/store/editingPreferences";
import {
	DEFAULT_EDITOR_SETTINGS,
	type EditorSettingsSnapshot,
} from "@/lib/ai-edition/store/editorSettings";
import {
	type CameraPlacementFrame,
	cameraResizeCorner,
	moveCameraTile,
	resizeCameraTile,
} from "@/lib/cameraPlacement";
import type { RenderRect } from "@/lib/compositeLayout";
import { peekCameraStyle } from "../launch/HudClipPeek";
import peek from "../launch/LaunchWindow.module.css";
import styles from "./StudioWindow.module.css";

type Gesture = {
	kind: "move" | "resize";
	frame: CameraPlacementFrame;
	start: RenderRect;
	stage: DOMRect;
	pointer: { x: number; y: number };
	corner: { left: boolean; top: boolean };
};

/**
 * The recorded camera over the replay, where the finished video puts it. Dragging moves it,
 * the corner handle resizes it; the result is saved as the default the review starts from.
 */
export function StudioReplayCamera({
	attach,
	src,
	placement,
	onPlacement,
	label,
}: {
	attach: Ref<HTMLVideoElement>;
	src: string;
	placement: EditorDefaultPreferences;
	onPlacement: (next: EditorDefaultPreferences) => void;
	label: string;
}) {
	const [size, setSize] = useState({ width: 16, height: 9 });
	const gesture = useRef<Gesture | null>(null);
	const latest = useRef(placement);
	latest.current = placement;
	const { scale, ...box } = peekCameraStyle(placement, size.height > size.width);

	const begin = (kind: Gesture["kind"]) => (event: PointerEvent<HTMLElement>) => {
		const tile = event.currentTarget.closest<HTMLElement>("[data-replay-camera]");
		const stage = tile?.parentElement?.getBoundingClientRect();
		const rect = tile?.getBoundingClientRect();
		if (!tile || !stage || !rect || event.button !== 0) return;
		event.preventDefault();
		event.stopPropagation();
		const start = {
			x: rect.left - stage.left,
			y: rect.top - stage.top,
			width: rect.width,
			height: rect.height,
		};
		const frame = {
			canvas: { width: stage.width, height: stage.height },
			bounds: { x: 0, y: 0, width: stage.width, height: stage.height },
			camera: size,
		};
		gesture.current = {
			kind,
			frame,
			start,
			stage,
			pointer: { x: event.clientX, y: event.clientY },
			corner: cameraResizeCorner(frame, start),
		};
		event.currentTarget.setPointerCapture(event.pointerId);
	};
	const move = (event: PointerEvent<HTMLElement>) => {
		const g = gesture.current;
		if (!g) return;
		const next =
			g.kind === "move"
				? moveCameraTile(
						g.frame,
						latest.current.webcamSizePreset,
						g.start.x + event.clientX - g.pointer.x,
						g.start.y + event.clientY - g.pointer.y,
					)
				: resizeCameraTile(g.frame, g.start, g.corner, {
						x: event.clientX - g.stage.left,
						y: event.clientY - g.stage.top,
					});
		onPlacement({
			...latest.current,
			webcamPosition: next.webcamPosition,
			webcamSizePreset: next.webcamSizePreset,
		});
	};
	const end = () => {
		if (!gesture.current) return;
		gesture.current = null;
		const settings: EditorSettingsSnapshot = {
			...latest.current,
			cropRegion: DEFAULT_EDITOR_SETTINGS.cropRegion,
		};
		saveEditorDefaultPreferences(settings);
	};
	const handlers = { onPointerMove: move, onPointerUp: end, onPointerCancel: end };
	const corner = cameraHandleCorner(placement);
	return (
		<div
			data-replay-camera
			role="group"
			className={styles.replayCamera}
			style={{ ...box, aspectRatio: `${size.width} / ${size.height}` }}
			aria-label={label}
			onPointerDown={begin("move")}
			{...handlers}
		>
			<video
				ref={attach}
				className={peek.clipPeekVideo}
				style={{ scale }}
				src={src}
				muted
				playsInline
				preload="auto"
				onLoadedMetadata={(event) => {
					const { videoWidth, videoHeight } = event.currentTarget;
					if (videoWidth > 0 && videoHeight > 0)
						setSize({ width: videoWidth, height: videoHeight });
				}}
			/>
			<span
				className={styles.replayCameraHandle}
				data-left={corner.left}
				data-top={corner.top}
				onPointerDown={begin("resize")}
				{...handlers}
			/>
		</div>
	);
}

/** The handle sits on the corner facing the middle of the screen, like the review's. */
function cameraHandleCorner(placement: EditorDefaultPreferences) {
	const position = placement.webcamPosition;
	return position ? { left: position.cx > 0.5, top: position.cy > 0.5 } : { left: true, top: true };
}
