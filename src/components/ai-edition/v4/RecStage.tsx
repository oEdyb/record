import {
	Camera,
	CameraOff,
	ChevronDown,
	Loader2,
	MicOff,
	Mic as MicOn,
	MonitorSmartphone,
	MousePointer2,
	Volume2,
	VolumeX,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppSelect } from "@/components/ui/app-select";
import { AudioLevelMeter } from "@/components/ui/audio-level-meter";
import { useDialogFocus } from "@/components/ui/use-dialog-focus";
import { useScopedT } from "@/contexts/I18nContext";
import { useAudioLevelMeter } from "@/hooks/useAudioLevelMeter";
import { useCameraDevices } from "@/hooks/useCameraDevices";
import { useCameraPreviewStream } from "@/hooks/useCameraPreviewStream";
import { useMicrophoneDevices } from "@/hooks/useMicrophoneDevices";
import { usePortalOwnsSource } from "@/hooks/usePortalOwnsSource";
import {
	DEFAULT_WEBCAM_FORMAT,
	formatWebcamFormat,
	sameWebcamFormat,
	type WebcamFormat,
	webcamFormatKey,
} from "@/lib/webcamFormats";
import styles from "./EditorShellV4.module.css";

interface RecordingPrefsState {
	micEnabled: boolean;
	micDeviceId: string | null;
	camEnabled: boolean;
	camDeviceId: string | null;
	camFormat: WebcamFormat;
	systemAudioEnabled: boolean;
	cursorCaptureMode: "editable-overlay" | "system";
}

const DEFAULT_PREFS: RecordingPrefsState = {
	micEnabled: false,
	micDeviceId: null,
	camEnabled: false,
	camDeviceId: null,
	camFormat: DEFAULT_WEBCAM_FORMAT,
	systemAudioEnabled: false,
	cursorCaptureMode: "editable-overlay",
};

const DEVICE_OFF_VALUE = "__off__";

/**
 * Rec-mode stage. The real capture pipeline lives in the standalone recorder
 * HUD window (`electronAPI.startNewRecording`); this stage is a pre-flight
 * config panel — source/mic/camera/cursor — that hands off to the HUD when
 * the user hits record. It shares state with the HUD through the same
 * cross-window bridges the rest of the app uses (main-process recording
 * prefs + selected-source IPC, useMicrophoneDevices/useCameraDevices for
 * enumeration) rather than owning an invented copy — and, unlike the HUD's
 * own floating pill toolbar, it lays that state out as a normal settings
 * panel sized for the editor's real estate, with a live camera/mic preview
 * so device selection is verifiably wired to real hardware instead of just
 * flipping a boolean.
 */
export function RecStage({
	onStartRecording,
	onClose,
}: {
	onStartRecording: () => void;
	onClose?: () => void;
}) {
	const t = useScopedT("editor");
	const [prefs, setPrefsState] = useState<RecordingPrefsState>(DEFAULT_PREFS);
	useEffect(() => {
		let cancelled = false;
		void window.electronAPI
			?.getRecordingPrefs?.()
			.then((p) => {
				if (!cancelled && p) setPrefsState(p as RecordingPrefsState);
			})
			.catch((err) => {
				// Bare ipcRenderer.invoke — rejects if the main handler throws. Keeping
				// DEFAULT_PREFS is a fine outcome; an unhandled rejection is not.
				console.warn("[rec-stage] failed to read the recording prefs:", err);
			});
		return () => {
			cancelled = true;
		};
	}, []);
	const updatePrefs = useCallback((patch: Partial<RecordingPrefsState>) => {
		setPrefsState((prev) => {
			const next = { ...prev, ...patch };
			void window.electronAPI?.setRecordingPrefs?.(patch).catch((err) => {
				console.warn("[rec-stage] failed to persist the recording prefs:", err);
			});
			return next;
		});
	}, []);

	const micDevices = useMicrophoneDevices(true);
	const camDevices = useCameraDevices(true);
	const selectedMicDeviceId = prefs.micDeviceId ?? micDevices.selectedDeviceId;
	const selectedCameraDeviceId = prefs.camDeviceId ?? camDevices.selectedDeviceId;
	const micDeviceAvailable = micDevices.devices.some(
		(device) => device.deviceId === selectedMicDeviceId,
	);
	const cameraDeviceAvailable = camDevices.devices.some(
		(device) => device.deviceId === selectedCameraDeviceId,
	);

	// Seed the device hooks' local "selected" state from the persisted prefs
	// once devices are enumerated, so the dropdown reflects the last real
	// choice instead of the hook's own "first device" default.
	useEffect(() => {
		if (prefs.micDeviceId && micDevices.devices.some((d) => d.deviceId === prefs.micDeviceId)) {
			micDevices.setSelectedDeviceId(prefs.micDeviceId);
		}
	}, [prefs.micDeviceId, micDevices.devices, micDevices.setSelectedDeviceId]);
	useEffect(() => {
		if (prefs.camDeviceId && camDevices.devices.some((d) => d.deviceId === prefs.camDeviceId)) {
			camDevices.setSelectedDeviceId(prefs.camDeviceId);
		}
	}, [prefs.camDeviceId, camDevices.devices, camDevices.setSelectedDeviceId]);
	useEffect(() => {
		if (micDevices.isLoading || !prefs.micEnabled || micDeviceAvailable) return;
		updatePrefs({ micEnabled: false });
	}, [micDeviceAvailable, micDevices.isLoading, prefs.micEnabled, updatePrefs]);
	useEffect(() => {
		if (camDevices.isLoading || !prefs.camEnabled || cameraDeviceAvailable) return;
		updatePrefs({ camEnabled: false });
	}, [cameraDeviceAvailable, camDevices.isLoading, prefs.camEnabled, updatePrefs]);

	// Live proof the selected devices actually work — a level meter for mic,
	// a real <video> feed for camera — instead of just toggling a pref flag.
	const { level: micLevel } = useAudioLevelMeter({
		enabled: prefs.micEnabled,
		deviceId: prefs.micDeviceId ?? undefined,
	});
	const {
		stream: cameraStream,
		error: cameraError,
		supportedFormats: webcamFormats,
		activeFormat: activeWebcamFormat,
	} = useCameraPreviewStream({
		enabled: prefs.camEnabled,
		deviceId: prefs.camDeviceId ?? undefined,
		format: prefs.camFormat,
	});
	const webcamFormatOptions = webcamFormats.length > 0 ? webcamFormats : [prefs.camFormat];
	useEffect(() => {
		if (
			webcamFormats.length === 0 ||
			sameWebcamFormat(activeWebcamFormat, prefs.camFormat) ||
			!webcamFormats.some((format) => sameWebcamFormat(format, activeWebcamFormat))
		) {
			return;
		}
		setPrefsState((previous) => ({
			...previous,
			camFormat: activeWebcamFormat,
		}));
		void window.electronAPI?.setRecordingPrefs?.({ camFormat: activeWebcamFormat }).catch((err) => {
			console.warn("[rec-stage] failed to persist the resolved webcam format:", err);
		});
	}, [activeWebcamFormat, prefs.camFormat, webcamFormats]);
	const cameraVideoRef = useRef<HTMLVideoElement | null>(null);
	useEffect(() => {
		if (cameraVideoRef.current) cameraVideoRef.current.srcObject = cameraStream;
	}, [cameraStream]);

	// ── capture source (screen/window) ──────────────────────────────
	const [source, setSource] = useState<ProcessedDesktopSource | null>(null);
	useEffect(() => {
		void window.electronAPI
			?.getSelectedSource?.()
			.then((selected) => setSource(selected ?? null))
			.catch((err) => {
				console.warn("[rec-stage] failed to read the selected source:", err);
			});
	}, []);
	const [sourceModalOpen, setSourceModalOpen] = useState(false);
	const [sourceTab, setSourceTab] = useState<"screen" | "window">("screen");
	const [sources, setSources] = useState<ProcessedDesktopSource[]>([]);
	const [loadingSources, setLoadingSources] = useState(false);
	const openSourceModal = async () => {
		setSourceModalOpen(true);
		setLoadingSources(true);
		try {
			const list = await window.electronAPI?.getSources?.({
				types: ["screen", "window"],
				thumbnailSize: { width: 320, height: 180 },
				fetchWindowIcons: true,
			});
			setSources(list ?? []);
		} finally {
			setLoadingSources(false);
		}
	};
	const chooseSource = async (candidate: ProcessedDesktopSource) => {
		const result = await window.electronAPI?.selectSource?.(candidate);
		setSource(result ?? candidate);
		setSourceModalOpen(false);
	};
	const screenSources = sources.filter((s) => s.id.startsWith("screen:"));
	const windowSources = sources.filter((s) => s.id.startsWith("window:"));
	const visibleSources = sourceTab === "screen" ? screenSources : windowSources;

	const cursorHighlight = prefs.cursorCaptureMode === "editable-overlay";
	// Same answer as the HUD, from the same place. This stage used to decide for
	// itself and always showed a picker, so the same build hid the choice on the
	// HUD and demanded it here.
	const portalOwnsSource = usePortalOwnsSource();
	const sourceLabel = portalOwnsSource
		? t("rec.systemPicker")
		: (source?.name ?? t("recording.selectSource"));

	return (
		<div className={styles.recStage}>
			<div className={styles.recCols}>
				<div className={styles.recPreviewCol}>
					<div className={styles.recPreviewFrame}>
						{prefs.camEnabled ? (
							cameraStream ? (
								<video
									ref={cameraVideoRef}
									autoPlay
									muted
									playsInline
									className={styles.recCameraVideo}
									data-testid="recording-camera-preview"
								/>
							) : cameraError ? (
								<div className={styles.recPreviewPlaceholder}>
									<CameraOff size={28} />
									<span>{t("rec.cameraAccessError")}</span>
								</div>
							) : (
								<div className={styles.recPreviewPlaceholder}>
									<Loader2 size={28} className="animate-spin" />
									<span>{t("rec.startingCamera")}</span>
								</div>
							)
						) : (
							<div className={styles.recPreviewPlaceholder}>
								<CameraOff size={28} />
								<span>{t("rec.camera")}</span>
								<span className={styles.recPreviewHint}>{t("rec.turnOnCameraHint")}</span>
							</div>
						)}
						<div className={styles.recBadge}>
							<span className={styles.recDot} aria-hidden />
							<span>{t("rec.camera")}</span>
						</div>
					</div>
				</div>

				<div className={styles.recPanel}>
					{/* No source row on Linux: `SelectSources` has no parameter naming
					    a source, so this picker could not steer the capture — it only
					    raised a second portal dialog, via `desktopCapturer.getSources()`,
					    whose grant was discarded. The compositor's own picker decides,
					    and it appears when recording starts. */}
					{portalOwnsSource ? (
						<div className={styles.recRow}>
							<div className={styles.recRowLabel}>
								<MonitorSmartphone size={15} />
								{t("rec.source")}
							</div>
							{/* Muted TEXT, not a styled-down button. Keeping the button's
							    class on a span left it looking pressable — border, pill,
							    hover state — which promises an interaction that cannot
							    exist here. This row states what will happen; it is not a
							    control. */}
							<span className={styles.recRowMuted}>{sourceLabel}</span>
						</div>
					) : (
						<div className={styles.recRow}>
							<div className={styles.recRowLabel}>
								<MonitorSmartphone size={15} />
								{t("rec.source")}
							</div>
							<button
								type="button"
								className={styles.recRowSourceBtn}
								onClick={() => void openSourceModal()}
							>
								{sourceLabel}
								<ChevronDown size={13} style={{ opacity: 0.6 }} />
							</button>
						</div>
					)}

					<div className={styles.recRow}>
						<div className={styles.recRowLabel}>
							{prefs.systemAudioEnabled ? <Volume2 size={15} /> : <VolumeX size={15} />}
							{t("rec.systemAudio")}
						</div>
						<button
							type="button"
							className={`${styles.recToggleBtn}${prefs.systemAudioEnabled ? ` ${styles.on}` : ""}`}
							aria-pressed={prefs.systemAudioEnabled}
							onClick={() => updatePrefs({ systemAudioEnabled: !prefs.systemAudioEnabled })}
						>
							{prefs.systemAudioEnabled ? t("rec.on") : t("rec.off")}
						</button>
					</div>

					<div className={styles.recRow}>
						<div className={styles.recRowLabel}>
							{prefs.micEnabled ? <MicOn size={15} /> : <MicOff size={15} />}
							{t("rec.microphone")}
							{prefs.micEnabled ? (
								<AudioLevelMeter level={micLevel} className={styles.recLevelMeter} />
							) : null}
						</div>
						<div className={styles.recRowControl}>
							<AppSelect
								className={styles.recSelect}
								aria-label={t("rec.microphone")}
								disabled={micDevices.isLoading}
								value={
									prefs.micEnabled && micDeviceAvailable ? selectedMicDeviceId : DEVICE_OFF_VALUE
								}
								onChange={(event) => {
									const deviceId = event.target.value;
									if (deviceId === DEVICE_OFF_VALUE) {
										updatePrefs({ micEnabled: false });
										return;
									}
									micDevices.setSelectedDeviceId(deviceId);
									updatePrefs({ micEnabled: true, micDeviceId: deviceId });
								}}
							>
								<option value={DEVICE_OFF_VALUE}>{t("rec.off")}</option>
								{micDevices.devices.map((device) => (
									<option key={device.deviceId} value={device.deviceId}>
										{device.label}
									</option>
								))}
							</AppSelect>
						</div>
					</div>

					<div className={styles.recRow}>
						<div className={styles.recRowLabel}>
							{prefs.camEnabled ? <Camera size={15} /> : <CameraOff size={15} />}
							{t("rec.camera")}
						</div>
						<div className={styles.recRowControl}>
							<AppSelect
								className={styles.recSelect}
								aria-label={t("rec.camera")}
								disabled={camDevices.isLoading}
								value={
									prefs.camEnabled && cameraDeviceAvailable
										? selectedCameraDeviceId
										: DEVICE_OFF_VALUE
								}
								onChange={(event) => {
									const deviceId = event.target.value;
									if (deviceId === DEVICE_OFF_VALUE) {
										updatePrefs({ camEnabled: false });
										return;
									}
									camDevices.setSelectedDeviceId(deviceId);
									updatePrefs({ camEnabled: true, camDeviceId: deviceId });
								}}
							>
								<option value={DEVICE_OFF_VALUE}>{t("rec.off")}</option>
								{camDevices.devices.map((device) => (
									<option key={device.deviceId} value={device.deviceId}>
										{device.label}
									</option>
								))}
							</AppSelect>
						</div>
					</div>

					{prefs.camEnabled ? (
						<div className={styles.recRow}>
							<div className={styles.recRowLabel}>
								<Camera size={15} />
								{t("exportDialog.quality")}
							</div>
							<AppSelect
								className={styles.recSelect}
								aria-label={`${t("rec.camera")} ${t("exportDialog.quality")}`}
								value={webcamFormatKey(prefs.camFormat)}
								disabled={webcamFormats.length === 0}
								onChange={(event) => {
									const selected = webcamFormatOptions.find(
										(format) => webcamFormatKey(format) === event.target.value,
									);
									if (selected) updatePrefs({ camFormat: selected });
								}}
							>
								{webcamFormatOptions.map((format) => (
									<option key={webcamFormatKey(format)} value={webcamFormatKey(format)}>
										{formatWebcamFormat(format)}
									</option>
								))}
							</AppSelect>
						</div>
					) : null}

					<div className={styles.recRow}>
						<div className={styles.recRowLabel}>
							<MousePointer2 size={15} />
							{t("rec.cursorHighlight")}
						</div>
						<button
							type="button"
							className={`${styles.recToggleBtn}${cursorHighlight ? ` ${styles.on}` : ""}`}
							aria-pressed={cursorHighlight}
							onClick={() =>
								updatePrefs({
									cursorCaptureMode: cursorHighlight ? "system" : "editable-overlay",
								})
							}
						>
							{cursorHighlight ? t("rec.on") : t("rec.off")}
						</button>
					</div>
				</div>
			</div>

			<div className={styles.recActions}>
				{onClose ? (
					<button type="button" className={styles.recCancelBtn} onClick={onClose}>
						{t("rec.cancel")}
					</button>
				) : null}
				<button type="button" className={styles.bigRecBtn} onClick={onStartRecording}>
					<span className={styles.bigRecDot} aria-hidden />
					{t("rec.startRecording")}
				</button>
			</div>
			<p className={styles.recActionsHint}>{t("rec.startRecordingHint")}</p>

			{sourceModalOpen ? (
				<SourceModal
					loading={loadingSources}
					tab={sourceTab}
					onTabChange={setSourceTab}
					screenCount={screenSources.length}
					windowCount={windowSources.length}
					sources={visibleSources}
					selectedId={source?.id ?? null}
					onSelect={(s) => void chooseSource(s)}
					onClose={() => setSourceModalOpen(false)}
				/>
			) : null}
		</div>
	);
}

function SourceModal({
	loading,
	tab,
	onTabChange,
	screenCount,
	windowCount,
	sources,
	selectedId,
	onSelect,
	onClose,
}: {
	loading: boolean;
	tab: "screen" | "window";
	onTabChange: (tab: "screen" | "window") => void;
	screenCount: number;
	windowCount: number;
	sources: ProcessedDesktopSource[];
	selectedId: string | null;
	onSelect: (source: ProcessedDesktopSource) => void;
	onClose: () => void;
}) {
	const t = useScopedT("editor");
	const dialogRef = useDialogFocus<HTMLDivElement>(true, onClose);
	return (
		<div className={styles.sourceModalOverlay} onClick={onClose}>
			<div
				ref={dialogRef}
				className={styles.sourceModalCard}
				role="dialog"
				aria-modal="true"
				aria-label={t("rec.source")}
				tabIndex={-1}
				onClick={(e) => e.stopPropagation()}
			>
				<div className={styles.sourceModalTabs}>
					<button
						type="button"
						data-dialog-initial-focus
						className={`${styles.sourceModalTab}${tab === "screen" ? ` ${styles.active}` : ""}`}
						aria-pressed={tab === "screen"}
						onClick={() => onTabChange("screen")}
					>
						{t("rec.sourceModal.screens", { count: screenCount })}
					</button>
					<button
						type="button"
						className={`${styles.sourceModalTab}${tab === "window" ? ` ${styles.active}` : ""}`}
						aria-pressed={tab === "window"}
						onClick={() => onTabChange("window")}
					>
						{t("rec.sourceModal.windows", { count: windowCount })}
					</button>
				</div>
				<div className={styles.sourceGrid}>
					{loading ? (
						<div className={styles.sourceModalEmpty}>
							<Loader2 size={20} className="animate-spin" />
							{t("rec.sourceModal.loadingSources")}
						</div>
					) : sources.length === 0 ? (
						<div className={styles.sourceModalEmpty}>
							{tab === "screen"
								? t("rec.sourceModal.noScreensFound")
								: t("rec.sourceModal.noWindowsFound")}
						</div>
					) : (
						sources.map((s) => (
							<button
								key={s.id}
								type="button"
								className={`${styles.sourceCard}${s.id === selectedId ? ` ${styles.active}` : ""}`}
								onClick={() => onSelect(s)}
							>
								<div className={styles.sourceCardThumb}>
									{s.thumbnail ? <img src={s.thumbnail} alt="" /> : <MonitorSmartphone size={22} />}
								</div>
								<span className={styles.sourceCardName}>{s.name}</span>
							</button>
						))
					)}
				</div>
				<div className={styles.sourceModalFooter}>
					<button type="button" className={styles.sourceModalCancelBtn} onClick={onClose}>
						{t("rec.sourceModal.cancel")}
					</button>
				</div>
			</div>
		</div>
	);
}
