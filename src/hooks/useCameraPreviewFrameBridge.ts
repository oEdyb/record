import { useEffect, useRef, useState } from "react";

// The window is 288 × 162 CSS points inside its padding. A 1× transfer is
// visibly enlarged on a Retina display, so relay a 2× frame and let CSS keep
// the same quiet physical size.
const PREVIEW_WIDTH = 576;
const PREVIEW_HEIGHT = 324;
// A confidence monitor does not need the recording stream's full frame rate.
// Twenty-four frames stays fluid while bounding the private preview's GPU work.
const MAX_PREVIEW_FPS = 24;
const PORT_MESSAGE_TYPE = "openscreen-camera-preview-port";

function drawCover(
	context: OffscreenCanvasRenderingContext2D,
	video: HTMLVideoElement,
	width: number,
	height: number,
) {
	const sourceWidth = video.videoWidth;
	const sourceHeight = video.videoHeight;
	if (sourceWidth <= 0 || sourceHeight <= 0) return false;
	const scale = Math.max(width / sourceWidth, height / sourceHeight);
	const sourceCropWidth = width / scale;
	const sourceCropHeight = height / scale;
	const sourceX = (sourceWidth - sourceCropWidth) / 2;
	const sourceY = (sourceHeight - sourceCropHeight) / 2;
	context.drawImage(
		video,
		sourceX,
		sourceY,
		sourceCropWidth,
		sourceCropHeight,
		0,
		0,
		width,
		height,
	);
	return true;
}

/** Sends small transferable frames to the private camera window without reopening the camera. */
export function useCameraPreviewFrameBridge(stream: MediaStream | null) {
	const [port, setPort] = useState<MessagePort | null>(null);
	const frameInFlight = useRef(false);

	useEffect(() => {
		const receivePort = (event: MessageEvent) => {
			if (
				event.source !== window ||
				event.data?.type !== PORT_MESSAGE_TYPE ||
				event.data?.role !== "producer" ||
				event.ports.length === 0
			) {
				return;
			}
			const nextPort = event.ports[0];
			nextPort.start();
			setPort((previousPort) => {
				previousPort?.close();
				return nextPort;
			});
		};
		window.addEventListener("message", receivePort);
		window.electronAPI?.requestCameraPreviewConnection?.();
		return () => window.removeEventListener("message", receivePort);
	}, []);

	useEffect(() => {
		if (!port) return;
		frameInFlight.current = false;
		const receiveAcknowledgement = (event: MessageEvent) => {
			if (event.data?.type === "consumed") frameInFlight.current = false;
		};
		port.addEventListener("message", receiveAcknowledgement);
		return () => {
			port.removeEventListener("message", receiveAcknowledgement);
			frameInFlight.current = false;
		};
	}, [port]);

	useEffect(() => {
		if (!port) return;
		const track = stream?.getVideoTracks()[0];
		if (!stream || !track) {
			port.postMessage({ type: "clear" });
			return;
		}

		const video = document.createElement("video");
		video.muted = true;
		video.playsInline = true;
		video.srcObject = stream;
		const canvas = new OffscreenCanvas(PREVIEW_WIDTH, PREVIEW_HEIGHT);
		const context = canvas.getContext("2d", { alpha: false });
		if (!context) {
			port.postMessage({ type: "clear" });
			return;
		}
		context.imageSmoothingEnabled = true;
		context.imageSmoothingQuality = "high";

		let stopped = false;
		let callbackId = 0;
		let lastFrameAt = -Infinity;
		let deliveryStartedAt = 0;
		let deliveredFrames = 0;
		let clockOrigin: { mediaTime: number; presentedFrames: number } | null = null;
		let latestTimestampDriftMs: number | undefined;
		const sourceFrameRate = track.getSettings().frameRate;
		const frameIntervalMs = 1_000 / MAX_PREVIEW_FPS;
		const sendFrame: VideoFrameRequestCallback = (now, metadata) => {
			if (stopped) return;
			if (
				typeof sourceFrameRate === "number" &&
				sourceFrameRate > 0 &&
				Number.isFinite(metadata.mediaTime) &&
				Number.isFinite(metadata.presentedFrames)
			) {
				if (!clockOrigin) {
					clockOrigin = {
						mediaTime: metadata.mediaTime,
						presentedFrames: metadata.presentedFrames,
					};
				} else {
					const mediaElapsed = metadata.mediaTime - clockOrigin.mediaTime;
					const expectedElapsed =
						(metadata.presentedFrames - clockOrigin.presentedFrames) / sourceFrameRate;
					latestTimestampDriftMs = (mediaElapsed - expectedElapsed) * 1_000;
				}
			}
			if (deliveryStartedAt === 0) deliveryStartedAt = now;
			deliveredFrames += 1;
			const deliveryWindowMs = now - deliveryStartedAt;
			if (deliveryWindowMs >= 5_000 && deliveredFrames > 1) {
				window.electronAPI?.reportCapturePerformance?.({
					cameraDeliveredFps: ((deliveredFrames - 1) * 1_000) / deliveryWindowMs,
					...(latestTimestampDriftMs !== undefined
						? { cameraTimestampDriftMs: latestTimestampDriftMs }
						: {}),
				});
				deliveryStartedAt = now;
				deliveredFrames = 1;
			}
			if (
				!frameInFlight.current &&
				now - lastFrameAt >= frameIntervalMs &&
				drawCover(context, video, PREVIEW_WIDTH, PREVIEW_HEIGHT)
			) {
				lastFrameAt = now;
				const bitmap = canvas.transferToImageBitmap();
				frameInFlight.current = true;
				port.postMessage({ type: "frame", bitmap }, [bitmap]);
			}
			callbackId = video.requestVideoFrameCallback(sendFrame);
		};

		void video
			.play()
			.then(() => {
				if (!stopped) callbackId = video.requestVideoFrameCallback(sendFrame);
			})
			.catch(() => {
				if (!stopped) port.postMessage({ type: "clear" });
			});

		return () => {
			stopped = true;
			if (callbackId) video.cancelVideoFrameCallback(callbackId);
			video.pause();
			video.srcObject = null;
			port.postMessage({ type: "clear" });
		};
	}, [port, stream]);
}
