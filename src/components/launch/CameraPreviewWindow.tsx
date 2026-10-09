import { CameraOff, EyeOff, LoaderCircle, Maximize2, Minimize2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { loadUserPreferences, saveUserPreferences } from "../../lib/userPreferences";
import styles from "./CameraPreviewWindow.module.css";

interface CameraPreviewPreferences {
	camEnabled: boolean;
}

const PORT_MESSAGE_TYPE = "openscreen-camera-preview-port";
const COMPACT_RELAY = { width: 576, height: 324 } as const;
const MAX_RELAY = { width: 2_560, height: 1_440 } as const;
const SURFACE_GUTTER = 12;
const DEFAULT_WINDOW_SIZE = { width: 312, height: 186 } as const;

/**
 * Relay size for the current window: the painted surface at device pixels, bounded so a
 * compact monitor keeps its 2x frame and an expanded one never exceeds 1440p.
 */
function relaySizeForWindow(): { width: number; height: number } {
	const ratio = window.devicePixelRatio || 1;
	const width = Math.round((window.innerWidth - 2 * SURFACE_GUTTER) * ratio);
	const height = Math.round((window.innerHeight - 2 * SURFACE_GUTTER) * ratio);
	return {
		width: Math.min(MAX_RELAY.width, Math.max(COMPACT_RELAY.width, width)),
		height: Math.min(MAX_RELAY.height, Math.max(COMPACT_RELAY.height, height)),
	};
}

/** Private live confidence monitor. Its geometry never becomes editor camera layout. */
export function CameraPreviewWindow() {
	const [preferences, setPreferences] = useState<CameraPreviewPreferences | null>(null);
	const [hasFrame, setHasFrame] = useState(false);
	const [expanded, setExpanded] = useState(false);
	const [monitorHidden, setMonitorHidden] = useState(
		() => loadUserPreferences().cameraMonitorHidden,
	);
	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	const portRef = useRef<MessagePort | null>(null);
	const resizeOriginRef = useRef<{ x: number; y: number } | null>(null);

	const toggleExpanded = useCallback(() => {
		setExpanded((current) => {
			const next = !current;
			window.electronAPI.setCameraPreviewExpanded?.(next);
			return next;
		});
	}, []);

	// The HUD's setup panel owns the same preference; it writes to the shared
	// localStorage, which reaches this window as a storage event.
	useEffect(() => {
		const readHidden = () => setMonitorHidden(loadUserPreferences().cameraMonitorHidden);
		window.addEventListener("storage", readHidden);
		return () => window.removeEventListener("storage", readHidden);
	}, []);

	const hideMonitor = useCallback(() => {
		saveUserPreferences({ cameraMonitorHidden: true });
		setMonitorHidden(true);
	}, []);

	// Grip drag reports total pointer travel since press, like the HUD drag: every
	// move is an absolute origin + delta, so a dropped message self-corrects.
	const handleResizePointerDown = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
		if (event.button !== 0) return;
		event.preventDefault();
		event.stopPropagation();
		event.currentTarget.setPointerCapture(event.pointerId);
		resizeOriginRef.current = { x: event.screenX, y: event.screenY };
		window.electronAPI.beginCameraPreviewResize?.();
	}, []);

	const endResize = useCallback(() => {
		if (!resizeOriginRef.current) return;
		resizeOriginRef.current = null;
		window.electronAPI.endCameraPreviewResize?.();
	}, []);

	const handleResizePointerMove = useCallback(
		(event: React.PointerEvent<HTMLButtonElement>) => {
			const origin = resizeOriginRef.current;
			if (!origin) return;
			if ((event.buttons & 1) === 0) {
				endResize();
				return;
			}
			window.electronAPI.resizeCameraPreviewTo?.(
				event.screenX - origin.x,
				event.screenY - origin.y,
			);
		},
		[endResize],
	);

	const handleResizePointerEnd = useCallback(
		(event: React.PointerEvent<HTMLButtonElement>) => {
			if (event.currentTarget.hasPointerCapture(event.pointerId)) {
				event.currentTarget.releasePointerCapture(event.pointerId);
			}
			endResize();
		},
		[endResize],
	);

	const resetSize = useCallback(() => {
		window.electronAPI.setCameraPreviewSize?.({ ...DEFAULT_WINDOW_SIZE });
	}, []);

	// The main process resizes the window; the surface then asks the producer for a
	// relay that matches its new device-pixel size so an expanded view is not a
	// stretched 576 x 324 frame.
	useEffect(() => {
		const sendRelaySize = () => {
			portRef.current?.postMessage({ type: "configure", ...relaySizeForWindow() });
		};
		window.addEventListener("resize", sendRelaySize);
		return () => window.removeEventListener("resize", sendRelaySize);
	}, []);

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
		const stopSize = window.electronAPI.onCameraPreviewSizeChanged?.((size) => {
			saveUserPreferences({ cameraPreviewSize: size });
		});
		const saved = loadUserPreferences();
		if (saved.cameraPreviewSize) window.electronAPI.setCameraPreviewSize?.(saved.cameraPreviewSize);
		if (saved.cameraPreviewPosition) {
			window.electronAPI.setCameraPreviewPosition(saved.cameraPreviewPosition);
		}

		return () => {
			cancelled = true;
			stopPreferences();
			stopPosition();
			stopSize?.();
		};
	}, []);

	const enabled = preferences?.camEnabled ?? false;
	const visible = enabled && !monitorHidden;

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
			portRef.current = nextPort;
			nextPort.onmessage = (frameEvent) => {
				const bitmap = frameEvent.data?.bitmap as ImageBitmap | undefined;
				if (frameEvent.data?.type === "frame" && bitmap) {
					const canvas = canvasRef.current;
					if (!canvas) {
						bitmap.close();
						nextPort.postMessage({ type: "consumed" });
						return;
					}
					if (
						typeof bitmap.width === "number" &&
						typeof bitmap.height === "number" &&
						bitmap.width > 0 &&
						bitmap.height > 0 &&
						(canvas.width !== bitmap.width || canvas.height !== bitmap.height)
					) {
						canvas.width = bitmap.width;
						canvas.height = bitmap.height;
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
			const relay = relaySizeForWindow();
			if (relay.width !== COMPACT_RELAY.width || relay.height !== COMPACT_RELAY.height) {
				nextPort.postMessage({ type: "configure", ...relay });
			}
		};
		window.addEventListener("message", receivePort);
		window.electronAPI.requestCameraPreviewConnection?.();
		return () => {
			window.removeEventListener("message", receivePort);
			activePort?.close();
			if (portRef.current === activePort) portRef.current = null;
		};
	}, []);

	useEffect(() => {
		const animationFrame = window.requestAnimationFrame(() => {
			window.electronAPI.setCameraPreviewVisible(visible);
		});
		return () => window.cancelAnimationFrame(animationFrame);
	}, [visible]);

	useEffect(
		() => () => {
			window.electronAPI.setCameraPreviewVisible(false);
		},
		[],
	);

	return (
		<div className={styles.root}>
			<div
				className={expanded ? `${styles.surface} ${styles.surfaceExpanded}` : styles.surface}
				role="img"
				aria-label="Live webcam preview"
				data-testid="camera-preview-surface"
				data-expanded={expanded ? "true" : "false"}
			>
				<canvas
					ref={canvasRef}
					width={576}
					height={324}
					className={styles.video}
					data-testid="camera-preview-canvas"
				/>
				<div className={styles.controls}>
					<button
						type="button"
						className={styles.controlButton}
						onClick={hideMonitor}
						aria-label="Hide camera preview"
						title="Hide camera preview. Turn it back on in the Setup panel."
						data-testid="camera-preview-hide"
					>
						<EyeOff size={14} aria-hidden="true" />
					</button>
					<button
						type="button"
						className={styles.controlButton}
						onClick={toggleExpanded}
						aria-label={expanded ? "Collapse camera preview" : "Expand camera preview"}
						aria-pressed={expanded}
						data-testid="camera-preview-expand"
					>
						{expanded ? (
							<Minimize2 size={14} aria-hidden="true" />
						) : (
							<Maximize2 size={14} aria-hidden="true" />
						)}
					</button>
				</div>
				{!expanded ? (
					<button
						type="button"
						className={styles.resizeGrip}
						aria-label="Resize camera preview"
						title="Drag to resize. Double-click to reset."
						data-testid="camera-preview-resize"
						onPointerDown={handleResizePointerDown}
						onPointerMove={handleResizePointerMove}
						onPointerUp={handleResizePointerEnd}
						onPointerCancel={handleResizePointerEnd}
						onDoubleClick={resetSize}
					>
						<span className={styles.resizeGripMark} aria-hidden="true" />
					</button>
				) : null}
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
