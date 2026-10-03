import { Check, X } from "lucide-react";
import { memo, useEffect, useRef } from "react";
import { AppSelect } from "@/components/ui/app-select";
import { useAudioLevelMeter } from "../../hooks/useAudioLevelMeter";
import type { CameraDevice } from "../../hooks/useCameraDevices";
import { useCameraPreviewStream } from "../../hooks/useCameraPreviewStream";
import type { MicrophoneDevice } from "../../hooks/useMicrophoneDevices";
import {
	formatWebcamFormat,
	sameWebcamFormat,
	type WebcamFormat,
	webcamFormatKey,
} from "../../lib/webcamFormats";
import styles from "./LaunchWindow.module.css";

const LEVEL_SEGMENTS = 12;
const LEVEL_SEGMENT_KEYS = Array.from({ length: LEVEL_SEGMENTS }, (_, i) => `segment-${i}`);

export interface HudDeviceSettingsLabels {
	title: string;
	done: string;
	microphone: string;
	camera: string;
	micLevel: string;
	micHint: string;
	noMicrophones: string;
	searching: string;
	noCameras: string;
	cameraUnavailable: string;
	cameraQuality: string;
	preview: string;
	previewUnavailable: string;
}

/** Segmented input-level bar, driven by the live analyser. */
const LevelMeter = memo(function LevelMeter({ level }: { level: number }) {
	const lit = Math.round((Math.min(100, Math.max(0, level)) / 100) * LEVEL_SEGMENTS);
	return (
		<div className={styles.levelMeter} role="meter" aria-valuenow={Math.round(level)}>
			{LEVEL_SEGMENT_KEYS.map((key, index) => (
				<span
					key={key}
					className={`${styles.levelSegment} ${index < lit ? styles.levelSegmentOn : ""}`}
				/>
			))}
		</div>
	);
});

function CameraPreview({
	stream,
	error,
	unavailableLabel,
}: {
	stream: MediaStream | null;
	error: string | null;
	unavailableLabel: string;
}) {
	const videoRef = useRef<HTMLVideoElement | null>(null);

	useEffect(() => {
		const video = videoRef.current;
		if (!video) return;
		video.srcObject = stream;
		return () => {
			video.srcObject = null;
		};
	}, [stream]);

	if (error || !stream) {
		return (
			<div className={styles.cameraPreview}>
				<span className={styles.cameraPreviewFallback}>{error ? unavailableLabel : ""}</span>
			</div>
		);
	}

	// No <track>: this is a live self-view with no audio and nothing to caption.
	return <video ref={videoRef} className={styles.cameraPreview} autoPlay muted playsInline />;
}

/**
 * Device selection *and* verification in one place.
 *
 * Picking a device here never turns anything on: the HUD's mic and camera
 * buttons are plain on/off toggles that use whatever is selected here, which is
 * what separates "choose my hardware" from "start capturing it". While this
 * panel is open it reuses the recorder's camera feed when available. If camera
 * capture is off, it owns one temporary verification stream and tears that down
 * before the recorder can acquire the device.
 */
export const HudDeviceSettings = memo(function HudDeviceSettings({
	micDevices,
	cameraDevices,
	activeMicId,
	activeCameraId,
	cameraEnabled,
	cameraStream,
	webcamFormat,
	cameraLoading,
	cameraError,
	labels,
	onSelectMic,
	onSelectCamera,
	onSelectWebcamFormat,
	onClose,
	panelRef,
}: {
	micDevices: MicrophoneDevice[];
	cameraDevices: CameraDevice[];
	activeMicId: string | undefined;
	activeCameraId: string | undefined;
	cameraEnabled: boolean;
	cameraStream: MediaStream | null;
	webcamFormat: WebcamFormat;
	cameraLoading: boolean;
	cameraError: string | null;
	labels: HudDeviceSettingsLabels;
	onSelectMic: (device: MicrophoneDevice) => void;
	onSelectCamera: (device: CameraDevice) => void;
	onSelectWebcamFormat: (format: WebcamFormat) => void;
	onClose: () => void;
	panelRef: (el: HTMLDivElement | null) => void;
}) {
	// Only reach for hardware that is actually there — otherwise opening the panel
	// on a machine with no webcam fires a getUserMedia that can only fail.
	const hasCamera = cameraDevices.length > 0 && !cameraError && !cameraLoading;
	const { level } = useAudioLevelMeter({
		enabled: micDevices.length > 0,
		deviceId: activeMicId,
	});
	const {
		stream,
		error: previewError,
		supportedFormats,
		activeFormat,
	} = useCameraPreviewStream({
		// When the recorder owns the camera, reuse that feed. If camera capture is
		// off, this panel can own one temporary verification stream.
		enabled: hasCamera && (!cameraEnabled || cameraStream !== null),
		deviceId: activeCameraId,
		format: webcamFormat,
		externalStream: cameraStream,
	});
	const formatOptions = supportedFormats.length > 0 ? supportedFormats : [webcamFormat];

	// Adopt the camera's resolved format only when the saved choice is one this camera
	// cannot deliver. While a supported choice is still being applied, activeFormat lags
	// behind; syncing it back then would silently undo the user's selection.
	useEffect(() => {
		if (
			supportedFormats.length > 0 &&
			!supportedFormats.some((format) => sameWebcamFormat(format, webcamFormat)) &&
			!sameWebcamFormat(activeFormat, webcamFormat) &&
			supportedFormats.some((format) => sameWebcamFormat(format, activeFormat))
		) {
			onSelectWebcamFormat(activeFormat);
		}
	}, [activeFormat, onSelectWebcamFormat, supportedFormats, webcamFormat]);

	return (
		<div
			ref={panelRef}
			data-hud-interactive="true"
			data-testid="hud-device-settings"
			role="dialog"
			aria-label={labels.title}
			className={`${styles.hudModal} ${styles.hudScrollbar} animate-mic-panel-in ${styles.electronNoDrag}`}
		>
			<div className={styles.hudModalHeader}>
				<span className={styles.hudModalTitle}>{labels.title}</span>
				<button
					type="button"
					aria-label={labels.done}
					title={labels.done}
					onClick={onClose}
					className={styles.hudModalClose}
				>
					<X size={14} />
				</button>
			</div>

			<div className={styles.hudMenuSectionLabel}>{labels.microphone}</div>
			{micDevices.length === 0 ? (
				<div className={styles.hudModalEmpty}>{labels.noMicrophones}</div>
			) : (
				micDevices.map((device) => {
					const isActive = device.deviceId === activeMicId;
					return (
						<button
							key={device.deviceId}
							type="button"
							role="menuitemradio"
							aria-checked={isActive}
							onClick={() => onSelectMic(device)}
							className={`${styles.languageMenuItem} ${isActive ? styles.languageMenuItemActive : ""}`}
						>
							<span className="truncate">{device.label}</span>
							{isActive ? <Check size={11} className="text-white/85" /> : null}
						</button>
					);
				})
			)}
			<div className={styles.hudModalMeterRow}>
				<span className={styles.hudModalMeterLabel}>{labels.micLevel}</span>
				<LevelMeter level={level} />
			</div>
			<div className={styles.hudModalHint}>{labels.micHint}</div>

			<div className={styles.hudMenuSectionLabel}>{labels.camera}</div>
			{cameraLoading ? (
				<div className={styles.hudModalEmpty}>{labels.searching}</div>
			) : cameraError ? (
				<div className={styles.hudModalEmpty}>{labels.cameraUnavailable}</div>
			) : cameraDevices.length === 0 ? (
				<div className={styles.hudModalEmpty}>{labels.noCameras}</div>
			) : (
				cameraDevices.map((device) => {
					const isActive = device.deviceId === activeCameraId;
					return (
						<button
							key={device.deviceId}
							type="button"
							role="menuitemradio"
							aria-checked={isActive}
							onClick={() => onSelectCamera(device)}
							className={`${styles.languageMenuItem} ${isActive ? styles.languageMenuItemActive : ""}`}
						>
							<span className="truncate">{device.label}</span>
							{isActive ? <Check size={11} className="text-white/85" /> : null}
						</button>
					);
				})
			)}
			{hasCamera ? (
				<div className={styles.hudModalMeterRow}>
					<label className={styles.hudModalMeterLabel} htmlFor="hud-webcam-format">
						{labels.cameraQuality}
					</label>
					<AppSelect
						id="hud-webcam-format"
						data-testid="hud-webcam-format"
						className={styles.hudModalSelect}
						value={webcamFormatKey(webcamFormat)}
						disabled={supportedFormats.length === 0}
						onChange={(event) => {
							const selected = formatOptions.find(
								(format) => webcamFormatKey(format) === event.target.value,
							);
							if (selected) onSelectWebcamFormat(selected);
						}}
					>
						{formatOptions.map((format) => (
							<option key={webcamFormatKey(format)} value={webcamFormatKey(format)}>
								{formatWebcamFormat(format)}
							</option>
						))}
					</AppSelect>
				</div>
			) : null}
			{hasCamera ? (
				<>
					<div className={styles.hudModalMeterRow}>
						<span className={styles.hudModalMeterLabel}>{labels.preview}</span>
					</div>
					<CameraPreview
						stream={stream}
						error={previewError}
						unavailableLabel={labels.previewUnavailable}
					/>
				</>
			) : null}
		</div>
	);
});
