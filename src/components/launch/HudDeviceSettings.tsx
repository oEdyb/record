import {
	AppWindow,
	Check,
	ChevronDown,
	Gauge,
	Languages,
	Minus,
	Monitor,
	MousePointer2,
	Power,
	Video,
	X,
} from "lucide-react";
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
import { CameraIcon, MicIcon, VolumeIcon } from "./HudIcons";
import styles from "./LaunchWindow.module.css";

export interface HudDeviceSettingsLabels {
	title: string;
	recordingQuality?: string;
	qualityHigh?: string;
	qualityStandard?: string;
	cameraAutomatic?: string;
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
	lockedHint?: string;
	display?: string;
	window?: string;
}

type DeviceSection = "microphone" | "camera" | "language";

export interface HudSetupExtras {
	sourceLabel?: string;
	sourceKind?: "display" | "window";
	sourceDisabled?: boolean;
	onOpenSource?: () => void;
	onSelectDisplay?: () => void;
	editableCursor?: boolean;
	onToggleCursor?: () => void;
	locales?: readonly string[];
	activeLocale?: string;
	getLocaleName?: (locale: string) => string;
	onSelectLocale?: (locale: string) => void;
	onHide?: () => void;
	onQuit?: () => void;
	windowControlsDisabled?: boolean;
	footerLead?: ReactNode;
	footer?: ReactNode;
}

function SetupTile({
	icon,
	name,
	detail,
	enabled,
	disabled,
	expanded,
	onToggleExpanded,
	onToggleEnabled,
	controlsId,
	level,
}: {
	icon: ReactNode;
	name: string;
	detail: string;
	enabled: boolean;
	disabled: boolean;
	expanded?: boolean;
	onToggleExpanded?: () => void;
	onToggleEnabled?: () => void;
	controlsId?: string;
	level?: number;
}) {
	const expandable = Boolean(onToggleExpanded);
	return (
		<div className={styles.setupTile} data-on={enabled} data-expanded={expanded === true}>
			<button
				type="button"
				className={styles.setupTileMain}
				aria-expanded={expandable ? expanded : undefined}
				aria-controls={expandable ? controlsId : undefined}
				disabled={!expandable && (disabled || !onToggleEnabled)}
				onClick={expandable ? onToggleExpanded : onToggleEnabled}
			>
				<span className={styles.setupTileIcon} aria-hidden>
					{icon}
				</span>
				<span className={styles.setupTileText}>
					<span className={styles.setupTileName}>{name}</span>
					<span className={styles.setupTileDetail} title={detail}>
						{detail}
					</span>
				</span>
				{expandable ? (
					<ChevronDown size={12} aria-hidden className={styles.setupTileChevron} />
				) : null}
			</button>
			{onToggleEnabled ? (
				<InspectorSwitch
					label={name}
					checked={enabled}
					disabled={disabled}
					onCheckedChange={onToggleEnabled}
				/>
			) : null}
			{level !== undefined ? (
				<span
					className={styles.setupTileLevel}
					style={{ transform: `scaleX(${Math.min(1, Math.max(0, level / 100))})` }}
					aria-hidden
				/>
			) : null}
		</div>
	);
}

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
	webcamFormatAuto = true,
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
	closing = false,
	instant = false,
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
	/** High only: record the largest 16:9 native format instead of webcamFormat. */
	webcamFormatAuto?: boolean;
	cameraLoading: boolean;
	cameraError: string | null;
	labels: HudDeviceSettingsLabels;
	onSelectMic: (device: MicrophoneDevice) => void;
	onSelectCamera: (device: CameraDevice) => void;
	onSelectWebcamFormat: (format: WebcamFormat | "auto") => void;
	onClose: () => void;
	panelRef?: (el: HTMLDivElement | null) => void;
	systemAudioEnabled?: boolean;
	microphoneEnabled?: boolean;
	controlsLocked?: boolean;
	onToggleSystemAudio?: () => void;
	onToggleMicrophone?: () => void;
	onToggleCamera?: () => void;
	extras?: HudSetupExtras;
	/** True while the panel plays its exit before unmounting. */
	closing?: boolean;
	/** True when it replaces Source in place, so it appears without motion. */
	instant?: boolean;
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
		enabled: micDevices.length > 0 && microphoneEnabled && !controlsLocked && !closing,
		deviceId: activeMicId,
	});
	const automaticCamera = recordingQuality === "high" && webcamFormatAuto;
	const {
		stream,
		error: previewError,
		supportedFormats,
		activeFormat,
	} = useCameraPreviewStream({
		// When the recorder owns the camera, reuse that feed. If camera capture is
		// off, this panel can own one temporary verification stream.
		// Never open a second camera client during a take.
		enabled:
			!closing && hasCamera && (cameraStream !== null || (!cameraEnabled && !controlsLocked)),
		deviceId: activeCameraId,
		nativeFormat: automaticCamera,
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
			!automaticCamera &&
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
		automaticCamera,
	]);

	const sourceKind = extras.sourceKind ?? "display";
	const hasLanguages = Boolean(extras.locales && extras.onSelectLocale && extras.getLocaleName);
	const languageName = extras.getLocaleName?.(extras.activeLocale ?? "en") ?? "";

	return (
		<div
			ref={panelRef}
			data-hud-interactive="true"
			data-testid="hud-device-settings"
			data-locked={controlsLocked}
			role="dialog"
			aria-label={labels.title}
			data-closing={closing}
			data-instant={instant}
			className={`${styles.hudModal} ${styles.hudScrollbar} ${styles.hudPanel} ${styles.electronNoDrag}`}
		>
			<div className={styles.hudModalHeader}>
				<span className={styles.hudModalTitle}>
					{controlsLocked && labels.lockedHint ? labels.lockedHint : labels.title}
				</span>
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
							<Minus size={14} aria-hidden />
						</button>
					) : null}
					{extras.onQuit ? (
						<button
							type="button"
							data-testid="hud-close-app-button"
							aria-label={labels.close}
							title={labels.close}
							disabled={extras.windowControlsDisabled}
							onClick={extras.onQuit}
							className={styles.hudModalClose}
						>
							<Power size={14} aria-hidden />
						</button>
					) : null}
					<button
						type="button"
						aria-label={labels.done}
						title={labels.done}
						onClick={onClose}
						className={styles.hudModalClose}
					>
						<X size={14} aria-hidden />
					</button>
				</span>
			</div>

			{extras.onOpenSource && extras.sourceLabel ? (
				<div
					className={styles.setupSources}
					role="radiogroup"
					aria-label={labels.source ?? "Source"}
					data-testid="hud-setup-source-group"
					data-source={sourceKind}
				>
					<span className={styles.setupSourceThumb} aria-hidden />
					<button
						type="button"
						role="radio"
						aria-checked={sourceKind === "display"}
						data-testid="hud-setup-source"
						className={styles.setupSource}
						disabled={extras.sourceDisabled}
						onClick={extras.onSelectDisplay ?? extras.onOpenSource}
					>
						<Monitor size={20} strokeWidth={1.6} aria-hidden />
						<span className={styles.setupSourceName}>
							{sourceKind === "display" ? extras.sourceLabel : (labels.display ?? "Display")}
						</span>
					</button>
					<button
						type="button"
						role="radio"
						aria-checked={sourceKind === "window"}
						className={styles.setupSource}
						disabled={extras.sourceDisabled}
						onClick={extras.onOpenSource}
					>
						<AppWindow size={20} strokeWidth={1.6} aria-hidden />
						<span className={styles.setupSourceName}>
							{sourceKind === "window" ? extras.sourceLabel : (labels.window ?? "Window")}
						</span>
					</button>
				</div>
			) : null}

			<div className={styles.setupGrid}>
				<SetupTile
					icon={<VolumeIcon muted={!systemAudioEnabled} />}
					name={labels.systemAudioName ?? "System audio"}
					detail={systemAudioEnabled ? onLabel : offLabel}
					enabled={systemAudioEnabled}
					disabled={controlsLocked || !onToggleSystemAudio}
					onToggleEnabled={onToggleSystemAudio}
				/>
				<SetupTile
					icon={<MicIcon muted={!microphoneEnabled} />}
					name={labels.microphoneName ?? labels.microphone}
					detail={activeMicLabel ?? labels.noMicrophones}
					enabled={microphoneEnabled}
					disabled={controlsLocked || !onToggleMicrophone}
					expanded={expanded === "microphone"}
					onToggleExpanded={() => toggleSection("microphone")}
					onToggleEnabled={onToggleMicrophone}
					controlsId="hud-device-list-microphone"
					level={microphoneEnabled && !controlsLocked ? level : undefined}
				/>
				<SetupTile
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
					expanded={expanded === "camera"}
					onToggleExpanded={() => toggleSection("camera")}
					onToggleEnabled={onToggleCamera}
					controlsId="hud-device-list-camera"
				/>
				{extras.onToggleCursor ? (
					<SetupTile
						icon={<MousePointer2 size={18} />}
						name={labels.editableCursor ?? "Editable cursor"}
						detail={extras.editableCursor ? onLabel : offLabel}
						enabled={Boolean(extras.editableCursor)}
						disabled={controlsLocked}
						onToggleEnabled={extras.onToggleCursor}
					/>
				) : null}
			</div>

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
									{isActive ? <Check size={14} className={styles.deviceOptionCheck} /> : null}
								</button>
							);
						})
					)}
					<div className={styles.hudModalHint}>{labels.micHint}</div>
				</div>
			) : null}
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
									{isActive ? <Check size={14} className={styles.deviceOptionCheck} /> : null}
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
			{expanded === "language" && hasLanguages ? (
				<div
					id="hud-device-list-language"
					data-testid="hud-language-menu"
					className={styles.deviceOptions}
					role="group"
					aria-label={labels.language ?? "Language"}
				>
					{extras.locales?.map((loc) => {
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
								{isActive ? <Check size={14} className={styles.deviceOptionCheck} /> : null}
							</button>
						);
					})}
				</div>
			) : null}

			<div className={styles.deviceQuality}>
				<div className={styles.qualityRow}>
					<span className={styles.setupTileIcon} aria-hidden>
						<Gauge size={18} />
					</span>
					<span className={styles.setupTileName} id="hud-recording-quality-label">
						{labels.recordingQuality ?? "Recording quality"}
					</span>
					<fieldset
						className={styles.qualitySegments}
						data-testid="hud-recording-quality"
						aria-labelledby="hud-recording-quality-label"
						disabled={controlsLocked}
					>
						{(["high", "standard"] as const).map((quality) => (
							<button
								key={quality}
								type="button"
								role="radio"
								aria-checked={recordingQuality === quality}
								className={styles.qualitySegment}
								onClick={() => onSelectRecordingQuality?.(quality)}
							>
								{quality === "high"
									? (labels.qualityHigh ?? "High")
									: (labels.qualityStandard ?? "Standard")}
							</button>
						))}
					</fieldset>
				</div>
				{/* Every option is a format the camera produces itself; High can also
				    leave the choice to the helper, which takes the largest 16:9 one. */}
				{hasCamera ? (
					<div className={styles.qualityRow}>
						<span className={styles.setupTileIcon} aria-hidden>
							<Video size={18} />
						</span>
						<span className={styles.setupTileName} id="hud-webcam-format-label">
							{labels.cameraQuality}
						</span>
						<AppSelect
							id="hud-webcam-format"
							data-testid="hud-webcam-format"
							aria-labelledby="hud-webcam-format-label"
							className={styles.hudModalSelect}
							value={automaticCamera ? "auto" : webcamFormatKey(webcamFormat)}
							disabled={controlsLocked || (supportedFormats.length === 0 && !automaticCamera)}
							onChange={(event) => {
								if (event.target.value === "auto") {
									onSelectWebcamFormat("auto");
									return;
								}
								const selected = formatOptions.find(
									(format) => webcamFormatKey(format) === event.target.value,
								);
								if (selected) onSelectWebcamFormat(selected);
							}}
						>
							{recordingQuality === "high" ? (
								<option value="auto">{labels.cameraAutomatic ?? "Automatic (16:9)"}</option>
							) : null}
							{formatOptions.map((format) => (
								<option key={webcamFormatKey(format)} value={webcamFormatKey(format)}>
									{formatWebcamFormat(format)}
								</option>
							))}
						</AppSelect>
					</div>
				) : null}
			</div>
			<div className={styles.hudSetupFooter}>
				{extras.footerLead}
				{hasLanguages ? (
					<button
						type="button"
						className={styles.hudSetupFooterButton}
						aria-label={`${labels.language ?? "Language"}: ${languageName}`}
						aria-expanded={expanded === "language"}
						aria-controls="hud-device-list-language"
						onClick={() => toggleSection("language")}
					>
						<Languages size={15} aria-hidden />
						<span className="truncate">{languageName}</span>
					</button>
				) : null}
				{extras.footer}
			</div>
		</div>
	);
});
