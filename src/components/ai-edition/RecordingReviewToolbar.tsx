import { Circle, Download, FolderOpen, LoaderCircle, Settings } from "lucide-react";
import { useScopedT } from "@/contexts/I18nContext";
import styles from "./RecordingReviewToolbar.module.css";

interface RecordingReviewToolbarProps {
	title: string | null;
	canSave: boolean;
	readOnly: boolean;
	busy: boolean;
	preparing?: boolean;
	openingRecorder?: boolean;
	isMac?: boolean;
	percent: number | null;
	entitlementLabel: string | null;
	onRecordings: () => void;
	onRecord: () => void;
	onSave: () => void;
	onOriginals: () => void;
	onSettings: () => void;
	onEntitlement: () => void;
}

/** Capture review keeps only navigation, playback, and delivery in the foreground. */
export function RecordingReviewToolbar(props: RecordingReviewToolbarProps) {
	const t = useScopedT("editor");
	const modifier = props.isMac ? "⌘" : "Ctrl+";
	return (
		<header
			className={styles.bar}
			aria-label={t("recordingReview.controls")}
			aria-busy={props.preparing}
		>
			<button
				type="button"
				disabled={props.preparing || props.busy}
				onClick={props.onRecordings}
				title={`${t("recordingReview.recordings")} (${modifier}O)`}
				aria-keyshortcuts={props.isMac ? "Meta+O" : "Control+O"}
			>
				<FolderOpen size={16} aria-hidden="true" /> {t("recordingReview.recordings")}
				<kbd aria-hidden="true">{modifier}O</kbd>
			</button>
			<span className={styles.title} title={props.title ?? undefined}>
				{props.title ?? "Klippt"}
			</span>
			<div className={styles.actions}>
				{props.entitlementLabel ? (
					<button type="button" className={styles.account} onClick={props.onEntitlement}>
						{props.entitlementLabel}
					</button>
				) : null}
				<button
					className={styles.settings}
					type="button"
					onClick={props.onSettings}
					aria-label={t("recordingReview.settings")}
				>
					<Settings size={16} aria-hidden="true" />
				</button>
				<button
					type="button"
					disabled={!props.canSave || props.busy || props.preparing}
					onClick={props.onOriginals}
					className={styles.originals}
				>
					{t("recordingReview.originals")}
				</button>
				<button
					type="button"
					disabled={props.readOnly || props.busy || props.preparing}
					onClick={props.onRecord}
					className={styles.record}
					aria-busy={props.openingRecorder}
					title={`${t("recordingReview.record")} (${modifier}N)`}
					aria-keyshortcuts={props.isMac ? "Meta+N" : "Control+N"}
				>
					{props.openingRecorder ? (
						<LoaderCircle size={16} className={styles.spinner} aria-hidden="true" />
					) : (
						<Circle size={13} fill="currentColor" aria-hidden="true" />
					)}{" "}
					{t("recordingReview.record")}
					<kbd aria-hidden="true">{modifier}N</kbd>
				</button>
				<button
					type="button"
					className={styles.primary}
					disabled={!props.canSave || props.readOnly || props.preparing}
					onClick={props.onSave}
					title={`${t("recordingReview.save")} (${modifier}S)`}
					aria-keyshortcuts={props.isMac ? "Meta+S" : "Control+S"}
				>
					<Download size={16} aria-hidden="true" />
					{props.preparing && !props.openingRecorder
						? t("recordingReview.preparing")
						: props.busy
							? t("recordingReview.saving", { percent: Math.round(props.percent ?? 0) })
							: t("recordingReview.save")}
					<kbd aria-hidden="true">{modifier}S</kbd>
				</button>
			</div>
		</header>
	);
}
