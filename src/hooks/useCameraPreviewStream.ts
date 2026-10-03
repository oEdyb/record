import { useEffect, useRef, useState } from "react";
import {
	applyWebcamFormat,
	DEFAULT_WEBCAM_FORMAT,
	preferredWebcamConstraints,
	probeWebcamFormatsCached,
	sameWebcamFormat,
	settingsMatchFormat,
	type WebcamFormat,
	webcamFormatFromSettings,
} from "../lib/webcamFormats";

export interface CameraPreviewStreamOptions {
	enabled: boolean;
	deviceId?: string;
	format?: WebcamFormat;
	/** Recorder-owned feed to display and probe without opening or stopping the camera again. */
	externalStream?: MediaStream | null;
}

/**
 * Uses a recorder-owned feed when supplied. Otherwise it opens one temporary
 * preview stream and owns that stream's cleanup.
 */
export function useCameraPreviewStream({
	enabled,
	deviceId,
	format = DEFAULT_WEBCAM_FORMAT,
	externalStream = null,
}: CameraPreviewStreamOptions) {
	const [stream, setStream] = useState<MediaStream | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [supportedFormats, setSupportedFormats] = useState<WebcamFormat[]>([]);
	const [activeFormat, setActiveFormat] = useState<WebcamFormat>(format);
	const streamRef = useRef<MediaStream | null>(null);
	const ownsStreamRef = useRef(false);
	const formatRef = useRef(format);
	formatRef.current = format;

	useEffect(() => {
		if (!enabled) {
			if (ownsStreamRef.current) {
				streamRef.current?.getTracks().forEach((track) => track.stop());
			}
			streamRef.current = null;
			ownsStreamRef.current = false;
			setStream(null);
			setError(null);
			setSupportedFormats([]);
			return;
		}

		let cancelled = false;
		let effectStream: MediaStream | null = null;
		let ownsEffectStream = false;
		const configurePreviewStream = async (nextStream: MediaStream, owned: boolean) => {
			if (cancelled) {
				if (owned) nextStream.getTracks().forEach((track) => track.stop());
				return;
			}
			effectStream = nextStream;
			ownsEffectStream = owned;
			streamRef.current = nextStream;
			ownsStreamRef.current = owned;
			setStream(nextStream);
			setError(null);

			const track = nextStream.getVideoTracks()[0];
			if (!track) return;
			const available = await probeWebcamFormatsCached(track, deviceId);
			if (cancelled) return;

			const requested = formatRef.current;
			const resolved =
				available.find((candidate) => sameWebcamFormat(candidate, requested)) ??
				available.find((candidate) => sameWebcamFormat(candidate, DEFAULT_WEBCAM_FORMAT)) ??
				available[0];
			if (resolved && !settingsMatchFormat(track.getSettings(), resolved)) {
				await applyWebcamFormat(track, resolved).catch(() => undefined);
			}
			if (cancelled) return;
			// Publish both together: a render with new supported formats and a stale
			// active format would look like the camera rejected the user's choice.
			setSupportedFormats(available);
			setActiveFormat(webcamFormatFromSettings(track.getSettings(), resolved ?? requested));
		};

		const acquisition = externalStream
			? Promise.resolve(externalStream).then((nextStream) =>
					configurePreviewStream(nextStream, false),
				)
			: navigator.mediaDevices
					.getUserMedia({
						video: {
							...(deviceId ? { deviceId: { exact: deviceId } } : {}),
							...preferredWebcamConstraints(formatRef.current),
						},
						audio: false,
					})
					.then((nextStream) => configurePreviewStream(nextStream, true));

		void acquisition.catch((err) => {
			if (cancelled) return;
			if (ownsEffectStream) effectStream?.getTracks().forEach((track) => track.stop());
			if (streamRef.current === effectStream) {
				streamRef.current = null;
				ownsStreamRef.current = false;
			}
			setStream(null);
			setError(err instanceof Error ? err.message : String(err));
		});

		return () => {
			cancelled = true;
			if (ownsEffectStream) effectStream?.getTracks().forEach((track) => track.stop());
			if (streamRef.current === effectStream) {
				streamRef.current = null;
				ownsStreamRef.current = false;
			}
		};
	}, [enabled, deviceId, externalStream]);

	useEffect(() => {
		const track = streamRef.current?.getVideoTracks()[0];
		if (!track || !supportedFormats.some((candidate) => sameWebcamFormat(candidate, format))) {
			return;
		}

		if (settingsMatchFormat(track.getSettings(), format)) {
			setActiveFormat(webcamFormatFromSettings(track.getSettings(), format));
			return;
		}

		let cancelled = false;
		void applyWebcamFormat(track, format)
			.then(() => {
				if (!cancelled) setActiveFormat(webcamFormatFromSettings(track.getSettings(), format));
			})
			.catch((formatError) => {
				if (!cancelled) {
					console.warn("Failed to apply webcam preview format:", formatError);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [format, supportedFormats]);

	return { stream, error, supportedFormats, activeFormat };
}
