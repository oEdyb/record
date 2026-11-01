import { useScopedT } from "@/contexts/I18nContext";
import type { StudioCommand, StudioSnapshot } from "../../../electron/studio/types";
import {
	HudCompactPauseButton,
	HudCompactRecordButton,
	HudCompactTimer,
	HudRemovePreviousClipButton,
	HudStopButton,
} from "../launch/HudControls";
import styles from "./StudioWindow.module.css";

export function StudioTransport({
	snapshot,
	pending,
	elapsed,
	send,
}: {
	snapshot: StudioSnapshot;
	pending: boolean;
	elapsed: number;
	send: (command: StudioCommand) => void;
}) {
	const t = useScopedT("launch");
	const editorT = useScopedT("editor");
	const { phase, pill } = snapshot;
	const busy = pending || pill.transportBusy;
	return (
		<footer className={styles.capture}>
			<div className={styles.transport} role="toolbar" aria-label={t("studio.title")}>
				{phase === "idle" ? (
					<HudCompactRecordButton
						disabled={pending || (pill.controlsLocked && !pill.countingDown)}
						label={
							pill.countingDown ? t("countdown.cancelHint") : editorT("recordingReview.record")
						}
						onClick={() => send(pill.countingDown ? "cancel-countdown" : "record")}
					/>
				) : null}
				{phase === "recording" || phase === "paused" ? (
					<HudCompactPauseButton
						paused={phase === "paused"}
						busy={busy}
						disabled={busy || !pill.canPause}
						label={t(phase === "paused" ? "tooltips.resumeRecording" : "tooltips.pauseRecording")}
						onClick={() => send(phase === "paused" ? "resume" : "pause")}
					/>
				) : null}
				<HudCompactTimer elapsedSeconds={elapsed} paused={phase !== "recording"} />
				{phase === "recording" || phase === "paused" ? (
					<HudStopButton
						saving={pill.saving}
						disabled={busy}
						label={t("tooltips.stopRecording")}
						savingLabel={t("recording.saving")}
						onClick={() => send("stop")}
					/>
				) : null}
				{phase === "recording" ||
				phase === "paused" ||
				(phase === "review" && pill.canRemovePreviousClip) ? (
					<HudRemovePreviousClipButton
						disabled={
							busy || !pill.canRemovePreviousClip || (phase !== "paused" && phase !== "review")
						}
						label={t("recording.removePreviousClip")}
						onClick={() => send("remove-last")}
					/>
				) : null}
			</div>
			{pill.undoClipIndex !== null ? (
				<div className={styles.undo}>
					{t("studio.removed")} ·{" "}
					<button type="button" disabled={busy} onClick={() => send("undo-remove")}>
						{t("studio.undo")}
					</button>
				</div>
			) : null}
			{phase === "review" ? (
				<button
					type="button"
					className={styles.finish}
					disabled={busy}
					onClick={() => send("finish")}
				>
					{t("studio.finish")}
				</button>
			) : null}
		</footer>
	);
}
