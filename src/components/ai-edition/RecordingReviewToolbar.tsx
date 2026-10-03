import { Circle, Download, FolderOpen, Settings } from "lucide-react";
import { useScopedT } from "@/contexts/I18nContext";
import styles from "./RecordingReviewToolbar.module.css";

interface RecordingReviewToolbarProps {
	title: string | null;
	canSave: boolean;
	readOnly: boolean;
	busy: boolean;
	preparing?: boolean;
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
	return (
		<header
			className={styles.bar}
			aria-label={t("recordingReview.controls")}
			aria-busy={props.preparing}
		>
			<button type="button" disabled={props.preparing} onClick={props.onRecordings}>
				<FolderOpen size={16} aria-hidden="true" /> {t("recordingReview.recordings")}
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
				<button type="button" onClick={props.onSettings} aria-label={t("recordingReview.settings")}>
					<Settings size={16} aria-hidden="true" />
				</button>
				<button
					type="button"
					disabled={!props.canSave || props.busy || props.preparing}
					onClick={props.onOriginals}
				>
					{t("recordingReview.originals")}
				</button>
				<button
					type="button"
					disabled={props.readOnly || props.busy || props.preparing}
					onClick={props.onRecord}
				>
					<Circle size={13} fill="currentColor" aria-hidden="true" /> {t("recordingReview.record")}
				</button>
				<button
					type="button"
					className={styles.primary}
					disabled={!props.canSave || props.readOnly || props.preparing}
					onClick={props.onSave}
				>
					<Download size={16} aria-hidden="true" />
					{props.preparing
						? t("recordingReview.preparing")
						: props.busy
							? t("recordingReview.saving", { percent: Math.round(props.percent ?? 0) })
							: t("recordingReview.save")}
				</button>
			</div>
		</header>
	);
}
