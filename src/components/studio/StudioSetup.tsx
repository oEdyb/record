import { Camera, FileText, Mic, Monitor, SlidersHorizontal, Volume2 } from "lucide-react";
import { useState } from "react";
import { useScopedT } from "@/contexts/I18nContext";
import { useAudioLevelMeter } from "@/hooks/useAudioLevelMeter";
import { useCameraDevices } from "@/hooks/useCameraDevices";
import { useMicrophoneDevices } from "@/hooks/useMicrophoneDevices";
import type { StudioCommand, StudioSnapshot } from "../../../electron/studio/types";
import { SourcePicker } from "../launch/SourceSelector";
import { AppSelect } from "../ui/app-select";
import { StudioDialog } from "./StudioDialog";
import styles from "./StudioWindow.module.css";

export function StudioSetup({
	snapshot,
	send,
	pending,
	meters,
}: {
	snapshot: StudioSnapshot;
	send: (command: StudioCommand) => void;
	pending: boolean;
	meters: boolean;
}) {
	const t = useScopedT("launch");
	const [dialog, setDialog] = useState<"devices" | "source" | null>(null);
	const { setup, pill, phase } = snapshot;
	const locked = pending || pill.controlsLocked || phase === "recording";
	const meterOn = snapshot.shown && setup.micEnabled && (phase !== "recording" || meters);
	const microphones = useMicrophoneDevices(meterOn || (dialog === "devices" && !locked));
	const cameras = useCameraDevices(dialog === "devices" && !locked);
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
				<button
					type="button"
					disabled={locked}
					onClick={() => (phase === "idle" ? setDialog("source") : send("choose-source"))}
				>
					<Monitor size={16} />
					{setup.source?.name ?? t("deviceSettings.source")}
				</button>
				<button
					type="button"
					disabled={locked}
					aria-pressed={setup.micEnabled}
					onClick={() => send("toggle-mic")}
				>
					<Mic size={16} />
					{t("permissions.microphone")}
				</button>
				<meter
					className={styles.meter}
					min={0}
					max={100}
					value={level}
					aria-label={t("deviceSettings.micLevel")}
					hidden={phase === "recording" && !meters}
				/>
				<button
					type="button"
					disabled={locked}
					aria-pressed={setup.cameraEnabled}
					onClick={() => send("toggle-camera")}
				>
					<Camera size={16} />
					{t("permissions.camera")}
				</button>
				<button
					type="button"
					disabled={locked}
					aria-pressed={setup.systemAudioEnabled}
					onClick={() => send("toggle-system-audio")}
				>
					<Volume2 size={16} />
					{t("studio.systemAudio")}
				</button>
				<span className={styles.spacer} />
				<button type="button" disabled={locked} onClick={() => setDialog("devices")}>
					<SlidersHorizontal size={16} />
					{t("studio.devices")}
				</button>
				<button type="button" onClick={() => send("open-notes")}>
					<FileText size={16} />
					{t("setup.notes")}
				</button>
			</div>
			{dialog ? (
				<StudioDialog
					title={t(dialog === "devices" ? "studio.devices" : "deviceSettings.source")}
					onClose={() => setDialog(null)}
				>
					{dialog === "source" ? (
						<SourcePicker
							variant="panel"
							onClose={() => setDialog(null)}
							onChosen={() => setDialog(null)}
						/>
					) : (
						<fieldset disabled={locked} className={styles.fields}>
							<label>
								{t("permissions.microphone")}
								<AppSelect
									disabled={locked}
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
									<option value={setup.micDeviceId ?? ""}>{t("permissions.microphone")}</option>
									{microphones.devices
										.filter((d) => d.deviceId !== setup.micDeviceId)
										.map((d) => (
											<option key={d.deviceId} value={d.deviceId}>
												{d.label}
											</option>
										))}
								</AppSelect>
							</label>
							<label>
								{t("permissions.camera")}
								<AppSelect
									disabled={locked}
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
									<option value={setup.cameraDeviceId ?? ""}>{t("permissions.camera")}</option>
									{cameras.devices
										.filter((d) => d.deviceId !== setup.cameraDeviceId)
										.map((d) => (
											<option key={d.deviceId} value={d.deviceId}>
												{d.label}
											</option>
										))}
								</AppSelect>
							</label>
							<label>
								{t("deviceSettings.recordingQuality")}
								<AppSelect
									disabled={locked}
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
							</label>
							<label>
								<input
									type="checkbox"
									checked={setup.cursorCaptureMode === "editable-overlay"}
									onChange={(e) =>
										send({
											kind: "set-cursor",
											value: e.target.checked ? "editable-overlay" : "system",
										})
									}
								/>
								{t("deviceSettings.editableCursor")}
							</label>
							{microphones.error || cameras.error ? (
								<p role="alert">{microphones.error || cameras.error}</p>
							) : null}
						</fieldset>
					)}
				</StudioDialog>
			) : null}
		</>
	);
}
