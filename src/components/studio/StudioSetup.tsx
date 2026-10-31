import {
	Camera,
	CameraOff,
	FileText,
	Mic,
	MicOff,
	Monitor,
	SlidersHorizontal,
	Volume2,
	VolumeX,
} from "lucide-react";
import { type CSSProperties, useState } from "react";
import { InspectorSwitch } from "@/components/ui/inspector";
import { useScopedT } from "@/contexts/I18nContext";
import { useAudioLevelMeter } from "@/hooks/useAudioLevelMeter";
import { useCameraDevices } from "@/hooks/useCameraDevices";
import { useMicrophoneDevices } from "@/hooks/useMicrophoneDevices";
import type { StudioCommand, StudioSnapshot } from "../../../electron/studio/types";
import { SourcePicker } from "../launch/SourceSelector";
import { AppSelect } from "../ui/app-select";
import { StudioDialog } from "./StudioDialog";
import styles from "./StudioWindow.module.css";

/** Setup changes are refused while capture runs or the pill is busy. */
export function setupLocked(snapshot: StudioSnapshot, pending: boolean) {
	return pending || snapshot.pill.controlsLocked || snapshot.phase === "recording";
}

/**
 * The inputs and quality, as one list. Shown under the camera before a take, and in the
 * Devices dialog once the camera pane is busy with the replay.
 */
export function StudioDevices({
	snapshot,
	send,
	locked,
}: {
	snapshot: StudioSnapshot;
	send: (command: StudioCommand) => void;
	locked: boolean;
}) {
	const t = useScopedT("launch");
	const { setup } = snapshot;
	const microphones = useMicrophoneDevices(!locked);
	const cameras = useCameraDevices(!locked);
	return (
		<fieldset disabled={locked} className={styles.fields}>
			<div className={styles.fieldRow}>
				<span>{t("permissions.microphone")}</span>
				<AppSelect
					aria-label={t("permissions.microphone")}
					disabled={locked}
					align="end"
					value={setup.micDeviceId ?? ""}
					onChange={(e) =>
						send({
							kind: "select-mic",
							deviceId: e.target.value,
							name:
								microphones.devices.find((d) => d.deviceId === e.target.value)?.label ??
								t("permissions.microphone"),
						})
					}
				>
					{deviceOptions(microphones.devices, setup.micDeviceId, t("permissions.microphone"))}
				</AppSelect>
			</div>
			<div className={styles.fieldRow}>
				<span>{t("permissions.camera")}</span>
				<AppSelect
					aria-label={t("permissions.camera")}
					disabled={locked}
					align="end"
					value={setup.cameraDeviceId ?? ""}
					onChange={(e) =>
						send({
							kind: "select-camera",
							deviceId: e.target.value,
							name:
								cameras.devices.find((d) => d.deviceId === e.target.value)?.label ??
								t("permissions.camera"),
						})
					}
				>
					{deviceOptions(cameras.devices, setup.cameraDeviceId, t("permissions.camera"))}
				</AppSelect>
			</div>
			<div className={styles.fieldRow}>
				<span>{t("deviceSettings.recordingQuality")}</span>
				<AppSelect
					aria-label={t("deviceSettings.recordingQuality")}
					disabled={locked}
					align="end"
					value={setup.recordingQuality}
					onChange={(e) =>
						send({
							kind: "set-quality",
							value: e.target.value === "standard" ? "standard" : "high",
						})
					}
				>
					<option value="high">{t("deviceSettings.qualityHigh")}</option>
					<option value="standard">{t("deviceSettings.qualityStandard")}</option>
				</AppSelect>
			</div>
			<div className={styles.fieldRow}>
				<span>{t("deviceSettings.editableCursor")}</span>
				<InspectorSwitch
					label={t("deviceSettings.editableCursor")}
					disabled={locked}
					checked={setup.cursorCaptureMode === "editable-overlay"}
					onCheckedChange={(checked) =>
						send({ kind: "set-cursor", value: checked ? "editable-overlay" : "system" })
					}
				/>
			</div>
			{microphones.error || cameras.error ? (
				<p role="alert">{microphones.error || cameras.error}</p>
			) : null}
		</fieldset>
	);
}

export function StudioSetup({
	snapshot,
	send,
	pending,
	meters,
	devicesInline,
}: {
	snapshot: StudioSnapshot;
	send: (command: StudioCommand) => void;
	pending: boolean;
	meters: boolean;
	/** The devices list is already on screen under the camera. */
	devicesInline: boolean;
}) {
	const t = useScopedT("launch");
	const [dialog, setDialog] = useState<"devices" | "source" | null>(null);
	const { setup, phase } = snapshot;
	const locked = setupLocked(snapshot, pending);
	const meterOn = snapshot.shown && setup.micEnabled && (phase !== "recording" || meters);
	const microphones = useMicrophoneDevices(meterOn);
	// Like the pill: a stored id this window cannot open (another build's origin) meters
	// the default input instead of failing.
	const meterDevice = microphones.devices.find((d) => d.deviceId === setup.micDeviceId);
	const { level } = useAudioLevelMeter({
		enabled: meterOn && !microphones.isLoading && microphones.devices.length > 0,
		deviceId: meterDevice?.deviceId,
	});
	return (
		<>
			<div className={styles.setup}>
				<button type="button" disabled={locked} onClick={() => setDialog("source")}>
					<Monitor size={16} />
					{setup.source?.name ?? t("deviceSettings.source")}
				</button>
				<span className={styles.micGroup}>
					<button
						type="button"
						disabled={locked}
						aria-pressed={setup.micEnabled}
						onClick={() => send("toggle-mic")}
					>
						{setup.micEnabled ? <Mic size={16} /> : <MicOff size={16} />}
						{t("permissions.microphone")}
					</button>
					{meterOn ? (
						<span
							role="meter"
							aria-label={t("deviceSettings.micLevel")}
							aria-valuemin={0}
							aria-valuemax={100}
							aria-valuenow={Math.round(level)}
							className={styles.level}
							style={{ "--level": Math.min(1, level / 100) } as CSSProperties}
						/>
					) : null}
				</span>
				<button
					type="button"
					disabled={locked}
					aria-pressed={setup.cameraEnabled}
					onClick={() => send("toggle-camera")}
				>
					{setup.cameraEnabled ? <Camera size={16} /> : <CameraOff size={16} />}
					{t("permissions.camera")}
				</button>
				<button
					type="button"
					disabled={locked}
					aria-pressed={setup.systemAudioEnabled}
					onClick={() => send("toggle-system-audio")}
				>
					{setup.systemAudioEnabled ? <Volume2 size={16} /> : <VolumeX size={16} />}
					{t("studio.systemAudio")}
				</button>
				<span className={styles.spacer} />
				{devicesInline ? null : (
					<button type="button" disabled={locked} onClick={() => setDialog("devices")}>
						<SlidersHorizontal size={16} />
						{t("studio.devices")}
					</button>
				)}
				<button type="button" onClick={() => send("open-notes")}>
					<FileText size={16} />
					{t("setup.notes")}
				</button>
			</div>
			{dialog === "source" ? (
				<StudioDialog bare title={t("deviceSettings.source")} onClose={() => setDialog(null)}>
					<SourcePicker
						variant="panel"
						className={styles.sourcePanel}
						onClose={() => setDialog(null)}
						onChosen={() => setDialog(null)}
					/>
				</StudioDialog>
			) : dialog === "devices" && !devicesInline ? (
				<StudioDialog title={t("studio.devices")} onClose={() => setDialog(null)}>
					<StudioDevices snapshot={snapshot} send={send} locked={locked} />
				</StudioDialog>
			) : null}
		</>
	);
}

/** Devices by their own names; a stored id this window cannot see keeps the generic name. */
function deviceOptions(
	devices: readonly { deviceId: string; label: string }[],
	selected: string | null,
	fallback: string,
) {
	const known = devices.some((d) => d.deviceId === selected);
	return (
		<>
			{known ? null : <option value={selected ?? ""}>{fallback}</option>}
			{devices.map((d) => (
				<option key={d.deviceId} value={d.deviceId}>
					{d.label || fallback}
				</option>
			))}
		</>
	);
}
