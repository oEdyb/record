import { CameraOff, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { loadUserPreferences, saveUserPreferences } from "../../lib/userPreferences";
import styles from "./CameraPreviewWindow.module.css";

interface CameraPreviewPreferences {
	camEnabled: boolean;
}

const PORT_MESSAGE_TYPE = "openscreen-camera-preview-port";

/** Private live confidence monitor. Its geometry never becomes editor camera layout. */
export function CameraPreviewWindow() {
	const [preferences, setPreferences] = useState<CameraPreviewPreferences | null>(null);
	const [hasFrame, setHasFrame] = useState(false);
	const canvasRef = useRef<HTMLCanvasElement | null>(null);

	useEffect(() => {
		let cancelled = false;
		void window.electronAPI
			.getRecordingPrefs()
			.then((nextPreferences) => {
				if (!cancelled) setPreferences(nextPreferences);
			})
			.catch((error) => {
				console.warn("[camera-preview] failed to load recording preferences:", error);
			});

		const stopPreferences = window.electronAPI.onRecordingPrefsChanged((nextPreferences) => {
			setPreferences(nextPreferences);
		});
		const stopPosition = window.electronAPI.onCameraPreviewPositionChanged((position) => {
			saveUserPreferences({ cameraPreviewPosition: position });
		});
		const savedPosition = loadUserPreferences().cameraPreviewPosition;
		if (savedPosition) window.electronAPI.setCameraPreviewPosition(savedPosition);

		return () => {
			cancelled = true;
			stopPreferences();
			stopPosition();
		};
	}, []);

	const enabled = preferences?.camEnabled ?? false;

	useEffect(() => {
		let activePort: MessagePort | null = null;
		const receivePort = (event: MessageEvent) => {
			if (
				event.source !== window ||
				event.data?.type !== PORT_MESSAGE_TYPE ||
				event.data?.role !== "consumer" ||
				event.ports.length === 0
			) {
				return;
			}

			activePort?.close();
			const nextPort = event.ports[0];
			activePort = nextPort;
			nextPort.onmessage = (frameEvent) => {
				const bitmap = frameEvent.data?.bitmap as ImageBitmap | undefined;
				if (frameEvent.data?.type === "frame" && bitmap) {
					const canvas = canvasRef.current;
					if (!canvas) {
						bitmap.close();
						nextPort.postMessage({ type: "consumed" });
						return;
					}
					const bitmapRenderer = canvas.getContext("bitmaprenderer");
					if (bitmapRenderer) {
						bitmapRenderer.transferFromImageBitmap(bitmap);
					} else {
						canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
						bitmap.close();
					}
					setHasFrame(true);
					nextPort.postMessage({ type: "consumed" });
					return;
				}

				const canvas = canvasRef.current;
				if (!canvas) return;
				if (frameEvent.data?.type === "clear") {
					canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
					setHasFrame(false);
					return;
				}
			};
			nextPort.start();
		};
		window.addEventListener("message", receivePort);
		window.electronAPI.requestCameraPreviewConnection?.();
		return () => {
			window.removeEventListener("message", receivePort);
			activePort?.close();
		};
	}, []);

	useEffect(() => {
		const animationFrame = window.requestAnimationFrame(() => {
			window.electronAPI.setCameraPreviewVisible(enabled);
		});
		return () => window.cancelAnimationFrame(animationFrame);
	}, [enabled]);

	useEffect(
		() => () => {
			window.electronAPI.setCameraPreviewVisible(false);
		},
		[],
	);

	return (
		<div className={styles.root}>
			<div
				className={styles.surface}
				role="img"
				aria-label="Live webcam preview"
				data-testid="camera-preview-surface"
			>
				<canvas
					ref={canvasRef}
					width={576}
					height={324}
					className={styles.video}
					data-testid="camera-preview-canvas"
				/>
				{!hasFrame ? (
					<div
						className={styles.status}
						data-testid={enabled ? "camera-preview-loading" : "camera-preview-disabled"}
					>
						{enabled ? (
							<LoaderCircle size={24} className={styles.spinner} aria-hidden="true" />
						) : (
							<CameraOff size={24} aria-hidden="true" />
						)}
					</div>
				) : null}
			</div>
		</div>
	);
}
