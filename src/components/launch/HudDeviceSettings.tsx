import { Check, ChevronDown, Languages, Minus, MousePointer2, X } from "lucide-react";
import { memo, type ReactNode, useEffect, useRef, useState } from "react";
import { AppSelect } from "@/components/ui/app-select";
import { InspectorSwitch } from "@/components/ui/inspector";
import { useAudioLevelMeter } from "../../hooks/useAudioLevelMeter";
import type { CameraDevice } from "../../hooks/useCameraDevices";
import { useCameraPreviewStream } from "../../hooks/useCameraPreviewStream";
import type { MicrophoneDevice } from "../../hooks/useMicrophoneDevices";
import type { RecordingQuality } from "../../lib/recording/recordingQuality";
import {
	formatWebcamFormat,
	sameWebcamFormat,
	type WebcamFormat,
	webcamFormatKey,
} from "../../lib/webcamFormats";
import { CameraIcon, MicIcon, SourceIcon, VolumeIcon } from "./HudIcons";
import styles from "./LaunchWindow.module.css";

const LEVEL_SEGMENTS = 12;
const LEVEL_SEGMENT_KEYS = Array.from({ length: LEVEL_SEGMENTS }, (_, i) => `segment-${i}`);

export interface HudDeviceSettingsLabels {
	title: string;
	recordingQuality?: string;
	qualityHigh?: string;
	qualityStandard?: string;
	nativeCamera?: string;
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
	systemAudioName?: string;
	microphoneName?: string;
	cameraName?: string;
	on?: string;
	off?: string;
	source?: string;
	editableCursor?: string;
	language?: string;
	hide?: string;
	close?: string;
}

type DeviceSection = "microphone" | "camera" | "language";

export interface HudSetupExtras {
	sourceLabel?: string;
	sourceDisabled?: boolean;
	onOpenSource?: () => void;
	editableCursor?: boolean;
	onToggleCursor?: () => void;
	locales?: readonly string[];
	activeLocale?: string;
	getLocaleName?: (locale: string) => string;
	onSelectLocale?: (locale: string) => void;
	onHide?: () => void;
	windowControlsDisabled?: boolean;
	footer?: ReactNode;
}

function DeviceRow({
	icon,
	name,
	detail,
	enabled,
	disabled,
	expandable,
	expanded,
	onToggleExpanded,
	onToggleEnabled,
	controlsId,
}: {
	icon: ReactNode;
	name: string;
	detail: string;
	enabled: boolean;
	disabled: boolean;
	expandable: boolean;
	expanded: boolean;
	onToggleExpanded?: () => void;
	onToggleEnabled?: () => void;
	controlsId?: string;
}) {
	const body = (
		<>
			<span className={styles.deviceRowIcon} aria-hidden>
				{icon}
			</span>
			<span className={styles.deviceRowText}>
				<span className={styles.deviceRowName}>{name}</span>
				<span className={styles.deviceRowDetail}>{detail}</span>
			</span>
			{expandable ? (
				<ChevronDown
					size={14}
					aria-hidden
					className={`${styles.deviceRowChevron} ${expanded ? styles.deviceRowChevronOpen : ""}`}
				/>
			) : null}
		</>
	);
	return (
		<div className={styles.deviceRow} data-expanded={expanded}>
			{expandable ? (
				<button
					type="button"
					className={styles.deviceRowMain}
					aria-expanded={expanded}
					aria-controls={controlsId}
					onClick={onToggleExpanded}
				>
					{body}
				</button>
			) : (
				<div className={styles.deviceRowMain}>{body}</div>
			)}
			{onToggleEnabled ? (
				<InspectorSwitch
					label={name}
					checked={enabled}
					disabled={disabled}
					onCheckedChange={onToggleEnabled}
				/>
			) : null}
		</div>
	);
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
	recordingQuality = "high",
	onSelectRecordingQuality,
	webcamFormat,
	cameraLoading,
	cameraError,
	labels,
	onSelectMic,
	onSelectCamera,
	onSelectWebcamFormat,
	onClose,
	panelRef,
	systemAudioEnabled = false,
	microphoneEnabled = false,
	controlsLocked = false,
	onToggleSystemAudio,
	onToggleMicrophone,
	onToggleCamera,
	extras = {},
}: {
	micDevices: MicrophoneDevice[];
	cameraDevices: CameraDevice[];
	activeMicId: string | undefined;
	activeCameraId: string | undefined;
	cameraEnabled: boolean;
	cameraStream: MediaStream | null;
	recordingQuality?: RecordingQuality;
	onSelectRecordingQuality?: (quality: RecordingQuality) => void;
	webcamFormat: WebcamFormat;
	cameraLoading: boolean;
	cameraError: string | null;
	labels: HudDeviceSettingsLabels;
	onSelectMic: (device: MicrophoneDevice) => void;
	onSelectCamera: (device: CameraDevice) => void;
	onSelectWebcamFormat: (format: WebcamFormat) => void;
	onClose: () => void;
	panelRef: (el: HTMLDivElement | null) => void;
	systemAudioEnabled?: boolean;
	microphoneEnabled?: boolean;
	controlsLocked?: boolean;
	onToggleSystemAudio?: () => void;
	onToggleMicrophone?: () => void;
	onToggleCamera?: () => void;
	extras?: HudSetupExtras;
}) {
	const [expanded, setExpanded] = useState<DeviceSection | null>(null);
	const toggleSection = (section: DeviceSection) =>
		setExpanded((current) => (current === section ? null : section));
	const onLabel = labels.on ?? "On";
	const offLabel = labels.off ?? "Off";
	// Without a matching choice the recorder uses the system default, which the
	// browser lists first; show that one as the device in use.
	const activeMic = micDevices.find((device) => device.deviceId === activeMicId) ?? micDevices[0];
	const effectiveMicId = activeMic?.deviceId;
	const activeMicLabel = activeMic?.label;
	const activeCameraLabel = cameraDevices.find(
		(device) => device.deviceId === activeCameraId,
	)?.label;
	// Only reach for hardware that is actually there — otherwise opening the panel
	// on a machine with no webcam fires a getUserMedia that can only fail.
	const hasCamera = cameraDevices.length > 0 && !cameraError && !cameraLoading;
	const { level } = useAudioLevelMeter({
		enabled: micDevices.length > 0 && !controlsLocked,
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
		// Never open a second camera client during a take.
		enabled: hasCamera && (cameraStream !== null || (!cameraEnabled && !controlsLocked)),
		deviceId: activeCameraId,
		nativeFormat: recordingQuality === "high",
		format: webcamFormat,
		externalStream: cameraStream,
	});
	const formatOptions = supportedFormats.length > 0 ? supportedFormats : [webcamFormat];

	// Adopt the camera's resolved format only when the saved choice is one this camera
	// cannot deliver. While a supported choice is still being applied, activeFormat lags
	// behind; syncing it back then would silently undo the user's selection.
	useEffect(() => {
		if (
			!controlsLocked &&
			recordingQuality === "standard" &&
			supportedFormats.length > 0 &&
			!supportedFormats.some((format) => sameWebcamFormat(format, webcamFormat)) &&
			!sameWebcamFormat(activeFormat, webcamFormat) &&
			supportedFormats.some((format) => sameWebcamFormat(format, activeFormat))
		) {
			onSelectWebcamFormat(activeFormat);
		}
	}, [
		activeFormat,
		controlsLocked,
		onSelectWebcamFormat,
		supportedFormats,
		webcamFormat,
		recordingQuality,
	]);

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
				<span className={styles.hudModalHeaderActions}>
					{extras.onHide ? (
						<button
							type="button"
							aria-label={labels.hide}
							title={labels.hide}
							disabled={extras.windowControlsDisabled}
							onClick={extras.onHide}
							className={styles.hudModalClose}
						>
							<Minus size={14} />
						</button>
					) : null}
					<button
						type="button"
						aria-label={labels.done}
						title={labels.done}
						onClick={onClose}
						className={styles.hudModalClose}
					>
						<X size={14} />
					</button>
				</span>
			</div>

			<div className={styles.deviceList}>
				{extras.onOpenSource && extras.sourceLabel ? (
					<button
						type="button"
						data-testid="hud-setup-source"
						className={`${styles.deviceRow} ${styles.deviceRowMain} ${styles.deviceRowAction}`}
						disabled={extras.sourceDisabled}
						onClick={extras.onOpenSource}
					>
						<span className={styles.deviceRowIcon} aria-hidden>
							<SourceIcon />
						</span>
						<span className={styles.deviceRowText}>
							<span className={styles.deviceRowName}>{labels.source ?? "Source"}</span>
							<span className={styles.deviceRowDetail}>{extras.sourceLabel}</span>
						</span>
						<ChevronDown size={14} aria-hidden className={styles.deviceRowChevronSide} />
					</button>
				) : null}
				<DeviceRow
					icon={<VolumeIcon muted={!systemAudioEnabled} />}
					name={labels.systemAudioName ?? "System audio"}
					detail={systemAudioEnabled ? onLabel : offLabel}
					enabled={systemAudioEnabled}
					disabled={controlsLocked || !onToggleSystemAudio}
					expandable={false}
					expanded={false}
					onToggleEnabled={() => onToggleSystemAudio?.()}
				/>
				<DeviceRow
					icon={<MicIcon muted={!microphoneEnabled} />}
					name={labels.microphoneName ?? labels.microphone}
					detail={activeMicLabel ?? labels.noMicrophones}
					enabled={microphoneEnabled}
					disabled={controlsLocked || !onToggleMicrophone}
					expandable
					expanded={expanded === "microphone"}
					onToggleExpanded={() => toggleSection("microphone")}
					onToggleEnabled={() => onToggleMicrophone?.()}
					controlsId="hud-device-list-microphone"
				/>
				{expanded === "microphone" ? (
					<div
						id="hud-device-list-microphone"
						className={styles.deviceOptions}
						role="group"
						aria-label={labels.microphone}
					>
						{micDevices.length === 0 ? (
							<div className={styles.hudModalEmpty}>{labels.noMicrophones}</div>
						) : (
							micDevices.map((device) => {
								const isActive = device.deviceId === effectiveMicId;
								return (
									<button
										key={device.deviceId}
										type="button"
										role="menuitemradio"
										aria-checked={isActive}
										disabled={controlsLocked}
										onClick={() => onSelectMic(device)}
										className={`${styles.deviceOption} ${isActive ? styles.deviceOptionActive : ""}`}
									>
										<span className="truncate">{device.label}</span>
										{isActive ? <LevelMeter level={level} /> : null}
										{isActive ? <Check size={12} className={styles.deviceOptionCheck} /> : null}
									</button>
								);
							})
						)}
						<div className={styles.hudModalHint}>{labels.micHint}</div>
					</div>
				) : null}
				<DeviceRow
					icon={<CameraIcon off={!cameraEnabled} />}
					name={labels.cameraName ?? labels.camera}
					detail={
						cameraLoading
							? labels.searching
							: cameraError
								? labels.cameraUnavailable
								: (activeCameraLabel ?? labels.noCameras)
					}
					enabled={cameraEnabled}
					disabled={controlsLocked || !onToggleCamera}
					expandable
					expanded={expanded === "camera"}
					onToggleExpanded={() => toggleSection("camera")}
					onToggleEnabled={() => onToggleCamera?.()}
					controlsId="hud-device-list-camera"
				/>
				{expanded === "camera" ? (
					<div
						id="hud-device-list-camera"
						className={styles.deviceOptions}
						role="group"
						aria-label={labels.camera}
					>
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
										disabled={controlsLocked}
										onClick={() => onSelectCamera(device)}
										className={`${styles.deviceOption} ${isActive ? styles.deviceOptionActive : ""}`}
									>
										<span className="truncate">{device.label}</span>
										{isActive ? <Check size={12} className={styles.deviceOptionCheck} /> : null}
									</button>
								);
							})
						)}
						{hasCamera ? (
							<CameraPreview
								stream={stream}
								error={previewError}
								unavailableLabel={labels.previewUnavailable}
							/>
						) : null}
					</div>
				) : null}
				{extras.onToggleCursor ? (
					<DeviceRow
						icon={<MousePointer2 size={18} />}
						name={labels.editableCursor ?? "Editable cursor"}
						detail={extras.editableCursor ? onLabel : offLabel}
						enabled={Boolean(extras.editableCursor)}
						disabled={controlsLocked}
						expandable={false}
						expanded={false}
						onToggleEnabled={extras.onToggleCursor}
					/>
				) : null}
				{extras.locales && extras.onSelectLocale && extras.getLocaleName ? (
					<>
						<DeviceRow
							icon={<Languages size={18} />}
							name={labels.language ?? "Language"}
							detail={extras.getLocaleName(extras.activeLocale ?? "en")}
							enabled={false}
							disabled={false}
							expandable
							expanded={expanded === "language"}
							onToggleExpanded={() => toggleSection("language")}
							controlsId="hud-device-list-language"
						/>
						{expanded === "language" ? (
							<div
								id="hud-device-list-language"
								data-testid="hud-language-menu"
								className={styles.deviceOptions}
								role="group"
								aria-label={labels.language ?? "Language"}
							>
								{extras.locales.map((loc) => {
									const isActive = loc === extras.activeLocale;
									return (
										<button
											key={loc}
											type="button"
											role="menuitemradio"
											aria-checked={isActive}
											onClick={() => extras.onSelectLocale?.(loc)}
											className={`${styles.deviceOption} ${isActive ? styles.deviceOptionActive : ""}`}
										>
											<span className="truncate">{extras.getLocaleName?.(loc)}</span>
											{isActive ? <Check size={12} className={styles.deviceOptionCheck} /> : null}
										</button>
									);
								})}
							</div>
						) : null}
					</>
				) : null}
			</div>

			<div className={styles.deviceQuality}>
				<div className={styles.hudModalMeterRow}>
					<label className={styles.hudModalMeterLabel} htmlFor="hud-recording-quality">
						{labels.recordingQuality ?? "Recording quality"}
					</label>
					<AppSelect
						id="hud-recording-quality"
						data-testid="hud-recording-quality"
						className={styles.hudModalSelect}
						disabled={controlsLocked}
						value={recordingQuality}
						onChange={(event) =>
							onSelectRecordingQuality?.(event.target.value === "standard" ? "standard" : "high")
						}
					>
						<option value="high">{labels.qualityHigh ?? "High"}</option>
						<option value="standard">{labels.qualityStandard ?? "Standard"}</option>
					</AppSelect>
				</div>
				{hasCamera ? (
					<div className={styles.hudModalMeterRow}>
						<label className={styles.hudModalMeterLabel} htmlFor="hud-webcam-format">
							{labels.cameraQuality}
						</label>
						{recordingQuality === "high" ? (
							<span className={styles.hudNativeCameraFormat} data-testid="hud-native-camera-format">
								{labels.nativeCamera ?? "Native camera"}
							</span>
						) : (
							<AppSelect
								id="hud-webcam-format"
								data-testid="hud-webcam-format"
								className={styles.hudModalSelect}
								value={webcamFormatKey(webcamFormat)}
								disabled={controlsLocked || supportedFormats.length === 0}
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
						)}
					</div>
				) : null}
			</div>
			{extras.footer ? <div className={styles.hudSetupFooter}>{extras.footer}</div> : null}
		</div>
	);
});
