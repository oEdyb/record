import { type RefObject, useEffect, useRef, useState } from "react";

const PORT_MESSAGE_TYPE = "openscreen-camera-preview-port";

/**
 * Paints the pill's live camera into a canvas through the Studio's own relay port. The
 * camera is never opened here. While `active` is false (Studio hidden, camera pane closed)
 * frames are not acknowledged, so the pill stops sending after the one in flight.
 */
export function useStudioLiveCamera(
	canvasRef: RefObject<HTMLCanvasElement | null>,
	active: boolean,
) {
	const [hasFrame, setHasFrame] = useState(false);
	const portRef = useRef<MessagePort | null>(null);
	const activeRef = useRef(active);
	activeRef.current = active;
	const owedAck = useRef(false);

	useEffect(() => {
		let current: MessagePort | null = null;
		const receivePort = (event: MessageEvent) => {
			if (
				event.source !== window ||
				event.data?.type !== PORT_MESSAGE_TYPE ||
				event.data?.role !== "consumer" ||
				event.data?.consumer !== "studio" ||
				event.ports.length === 0
			)
				return;
			current?.close();
			const port = event.ports[0];
			current = port;
			portRef.current = port;
			port.onmessage = (message) => {
				const bitmap = message.data?.bitmap as ImageBitmap | undefined;
				if (message.data?.type === "clear") {
					const canvas = canvasRef.current;
					canvas?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
					setHasFrame(false);
					return;
				}
				if (message.data?.type !== "frame" || !bitmap) return;
				const canvas = canvasRef.current;
				if (canvas && bitmap.width > 0 && bitmap.height > 0) {
					if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
						canvas.width = bitmap.width;
						canvas.height = bitmap.height;
					}
					const renderer = canvas.getContext("bitmaprenderer");
					if (renderer) renderer.transferFromImageBitmap(bitmap);
					else {
						canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
						bitmap.close();
					}
					setHasFrame(true);
				} else bitmap.close();
				if (activeRef.current) port.postMessage({ type: "consumed" });
				else owedAck.current = true;
			};
			port.start();
		};
		window.addEventListener("message", receivePort);
		window.electronAPI?.requestCameraPreviewConnection?.();
		return () => {
			window.removeEventListener("message", receivePort);
			current?.close();
			if (portRef.current === current) portRef.current = null;
		};
	}, [canvasRef]);

	// Becoming visible again restarts the flow the hidden Studio paused.
	useEffect(() => {
		if (!active || !owedAck.current) return;
		owedAck.current = false;
		portRef.current?.postMessage({ type: "consumed" });
	}, [active]);

	// Ask for the whole camera frame at the size it is shown, in device pixels. The relay
	// crops to the requested shape, so a tall pane asks for 16:9 and letterboxes it.
	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas || typeof ResizeObserver === "undefined") return;
		let last = "";
		const observer = new ResizeObserver(([entry]) => {
			const { width, height } = studioCameraFrameSize(
				entry.contentRect.width,
				entry.contentRect.height,
				window.devicePixelRatio || 1,
			);
			const key = `${width}x${height}`;
			if (width <= 0 || height <= 0 || key === last) return;
			last = key;
			portRef.current?.postMessage({ type: "configure", width, height });
		});
		observer.observe(canvas);
		return () => observer.disconnect();
	}, [canvasRef]);

	return hasFrame;
}

const CAMERA_ASPECT = 16 / 9;

/** The largest 16:9 frame that fits the pane, in device pixels. */
export function studioCameraFrameSize(paneWidth: number, paneHeight: number, scale: number) {
	const width = Math.min(paneWidth, paneHeight * CAMERA_ASPECT);
	return {
		width: Math.round(width * scale),
		height: Math.round((width / CAMERA_ASPECT) * scale),
	};
}
