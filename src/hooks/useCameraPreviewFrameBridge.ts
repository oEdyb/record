import { useEffect, useRef, useState } from "react";

// The window is 288 × 162 CSS points inside its padding. A 1× transfer is
// visibly enlarged on a Retina display, so relay a 2× frame and let CSS keep
// the same quiet physical size.
const PREVIEW_WIDTH = 576;
const PREVIEW_HEIGHT = 324;
// The expanded monitor asks for a larger relay. Cap it so a 4K camera on a large
// display never turns the private preview into a second full-resolution pipeline.
const MAX_RELAY_WIDTH = 2_560;
const MAX_RELAY_HEIGHT = 1_440;

interface RelaySize {
	width: number;
	height: number;
}

function clampRelaySize(value: unknown): RelaySize | null {
	const candidate = value as { width?: unknown; height?: unknown } | null;
	if (
		!candidate ||
		typeof candidate.width !== "number" ||
		typeof candidate.height !== "number" ||
		!Number.isFinite(candidate.width) ||
		!Number.isFinite(candidate.height)
	) {
		return null;
	}
	return {
		width: Math.round(Math.min(MAX_RELAY_WIDTH, Math.max(PREVIEW_WIDTH, candidate.width))),
		height: Math.round(Math.min(MAX_RELAY_HEIGHT, Math.max(PREVIEW_HEIGHT, candidate.height))),
	};
}
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

interface Consumer {
	port: MessagePort;
	inFlight: boolean;
	size: RelaySize;
	canvas: OffscreenCanvas | null;
	context: OffscreenCanvasRenderingContext2D | null;
	lastFrameAt: number;
}

function consumerContext(consumer: Consumer) {
	const { width, height } = consumer.size;
	if (!consumer.canvas || !consumer.context) {
		consumer.canvas = new OffscreenCanvas(width, height);
		consumer.context = consumer.canvas.getContext("2d", { alpha: false });
	} else if (consumer.canvas.width !== width || consumer.canvas.height !== height) {
		consumer.canvas.width = width;
		consumer.canvas.height = height;
	}
	// Creating or resizing resets the 2D context state, so smoothing is applied each time.
	if (consumer.context) {
		consumer.context.imageSmoothingEnabled = true;
		consumer.context.imageSmoothingQuality = "high";
	}
	return consumer.context;
}

/**
 * Sends small transferable frames to the private camera window and the Studio without
 * reopening the camera. Each viewer has its own port, size and one-frame-in-flight budget,
 * so a slow or hidden viewer never holds back the other.
 */
export function useCameraPreviewFrameBridge(stream: MediaStream | null) {
	const [ports, setPorts] = useState<Record<string, MessagePort>>({});
	const consumers = useRef(new Map<string, Consumer>());

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
			const name = event.data?.consumer === "studio" ? "studio" : "monitor";
			const nextPort = event.ports[0];
			nextPort.start();
			setPorts((previous) => {
				previous[name]?.close();
				return { ...previous, [name]: nextPort };
			});
		};
		window.addEventListener("message", receivePort);
		window.electronAPI?.requestCameraPreviewConnection?.();
		return () => window.removeEventListener("message", receivePort);
	}, []);

	useEffect(() => {
		const map = consumers.current;
		const cleanups = Object.entries(ports).map(([name, port]) => {
			const consumer: Consumer = {
				port,
				inFlight: false,
				size: map.get(name)?.size ?? { width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT },
				canvas: null,
				context: null,
				lastFrameAt: -Infinity,
			};
			map.set(name, consumer);
			const receive = (event: MessageEvent) => {
				if (event.data?.type === "consumed") consumer.inFlight = false;
				if (event.data?.type === "configure") {
					const next = clampRelaySize(event.data);
					if (next) consumer.size = next;
				}
			};
			port.addEventListener("message", receive);
			return () => {
				port.removeEventListener("message", receive);
				if (map.get(name) === consumer) map.delete(name);
			};
		});
		return () => {
			for (const cleanup of cleanups) cleanup();
		};
	}, [ports]);

	useEffect(() => {
		const targets = Object.values(ports);
		if (targets.length === 0) return;
		const clearAll = () => {
			for (const port of targets) port.postMessage({ type: "clear" });
		};
		const track = stream?.getVideoTracks()[0];
		if (!stream || !track) {
			clearAll();
			return;
		}

		const video = document.createElement("video");
		video.muted = true;
		video.playsInline = true;
		video.srcObject = stream;

		let stopped = false;
		let callbackId = 0;
		let timerId: ReturnType<typeof setTimeout> | undefined;
		const linux = window.electronAPI?.getPlatform?.() === "linux";
		let previousPresentedFrames: number | null = null;
		let deliveryStartedAt = 0;
		let deliveredFrames = 0;
		let clockOrigin: { mediaTime: number; presentedFrames: number } | null = null;
		let latestTimestampDriftMs: number | undefined;
		const sourceFrameRate = track.getSettings().frameRate;
		const frameIntervalMs = 1_000 / MAX_PREVIEW_FPS;
		const sendFrame = (
			now: number,
			metadata: Pick<VideoFrameCallbackMetadata, "mediaTime" | "presentedFrames">,
		) => {
			if (stopped) return;
			if (
				!linux &&
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
			deliveredFrames +=
				linux && previousPresentedFrames !== null
					? Math.max(0, metadata.presentedFrames - previousPresentedFrames)
					: 1;
			previousPresentedFrames = metadata.presentedFrames;
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
			for (const consumer of consumers.current.values()) {
				if (consumer.inFlight || now - consumer.lastFrameAt < frameIntervalMs) continue;
				const context = consumerContext(consumer);
				const canvas = consumer.canvas;
				if (!context || !canvas || !drawCover(context, video, canvas.width, canvas.height))
					continue;
				consumer.lastFrameAt = now;
				const bitmap = canvas.transferToImageBitmap();
				consumer.inFlight = true;
				consumer.port.postMessage({ type: "frame", bitmap }, [bitmap]);
			}
		};
		const onVideoFrame: VideoFrameRequestCallback = (now, metadata) => {
			sendFrame(now, metadata);
			if (!stopped) callbackId = video.requestVideoFrameCallback(onVideoFrame);
		};
		// Wayland stops compositor callbacks for a hidden pill, even with backgroundThrottling off.
		let previousMediaTime = -1;
		const pollFrame = () => {
			if (stopped) return;
			if (video.readyState >= 2 && video.currentTime !== previousMediaTime) {
				previousMediaTime = video.currentTime;
				sendFrame(performance.now(), {
					mediaTime: video.currentTime,
					presentedFrames: video.getVideoPlaybackQuality().totalVideoFrames,
				});
			}
			timerId = setTimeout(pollFrame, Math.ceil(frameIntervalMs));
		};

		void video
			.play()
			.then(() => {
				if (stopped) return;
				if (linux) pollFrame();
				else callbackId = video.requestVideoFrameCallback(onVideoFrame);
			})
			.catch(() => {
				if (!stopped) clearAll();
			});

		return () => {
			stopped = true;
			if (callbackId) video.cancelVideoFrameCallback(callbackId);
			if (timerId !== undefined) clearTimeout(timerId);
			video.pause();
			video.srcObject = null;
			for (const consumer of consumers.current.values()) consumer.inFlight = false;
			clearAll();
		};
	}, [ports, stream]);
}
