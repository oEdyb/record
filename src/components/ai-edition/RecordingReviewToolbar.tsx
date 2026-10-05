import {
	Clapperboard,
	Download,
	FolderOpen,
	LoaderCircle,
	Maximize2,
	MoreHorizontal,
	Plus,
	Settings,
} from "lucide-react";
import { KlipptMark } from "@/components/brand/KlipptMark";
import { AppMenu, AppMenuContent, AppMenuItem, AppMenuTrigger } from "@/components/ui/app-menu";
import { useScopedT } from "@/contexts/I18nContext";
import type { RecordingInterruption } from "@/lib/recordingSession";
import styles from "./RecordingReviewToolbar.module.css";

interface RecordingReviewToolbarProps {
	title: string | null;
	/** Total length and clip count, e.g. "0:28 total, 3 clips". */
	meta?: string | null;
	canSave: boolean;
	readOnly: boolean;
	busy: boolean;
	preparing?: boolean;
	openingRecorder?: boolean;
	/** True while Add clip opens the recorder. */
	addingClip?: boolean;
	interruptions?: RecordingInterruption[];
	handoffError?: string | null;
	onRetryHandoff?: () => void;
	isMac?: boolean;
	percent: number | null;
	entitlementLabel: string | null;
	onRecordings: () => void;
	onRecord: () => void;
	/** Records another clip into this recording, at the marker on the progress bar. */
	onAddClip?: () => void;
	onSave: () => void;
	onOriginals: () => void;
	onSettings: () => void;
	onEntitlement: () => void;
	/** Present while review is the small player; grows it into the full window. */
	onExpand?: () => void;
}

/** Capture review keeps only navigation, playback, and delivery in the foreground. */
export function RecordingReviewToolbar(props: RecordingReviewToolbarProps) {
	const t = useScopedT("editor");
	const modifier = props.isMac ? "⌘" : "Ctrl+";
	return (
		<div className={styles.header} data-review-chrome="header">
			<header
				className={styles.bar}
				aria-label={t("recordingReview.controls")}
				aria-busy={props.preparing}
			>
				<div className={styles.identity}>
					<KlipptMark className={styles.mark} />
					<div className={styles.titleBlock}>
						<span className={styles.title} title={props.title ?? undefined}>
							{props.title ?? "Klippt"}
						</span>
						{props.meta ? <span className={styles.meta}>{props.meta}</span> : null}
					</div>
				</div>
				<div className={styles.actions}>
					{props.entitlementLabel ? (
						<button type="button" className={styles.account} onClick={props.onEntitlement}>
							{props.entitlementLabel}
						</button>
					) : null}
					{props.onExpand ? (
						<button
							type="button"
							className={styles.icon}
							onClick={props.onExpand}
							aria-label={t("recordingReview.expand")}
							title={t("recordingReview.expand")}
						>
							<Maximize2 size={16} aria-hidden="true" />
						</button>
					) : null}
					{props.onAddClip && props.canSave ? (
						<button
							type="button"
							disabled={props.readOnly || props.busy || props.preparing}
							onClick={props.onAddClip}
							className={styles.ghost}
							aria-label={t("recordingReview.addClip")}
							aria-busy={props.addingClip}
							title={t("recordingReview.addClipTitle")}
							data-testid="review-add-clip"
						>
							{props.addingClip ? (
								<LoaderCircle size={16} className={styles.spinner} aria-hidden="true" />
							) : (
								<Plus size={16} aria-hidden="true" />
							)}
							<span className={styles.label}>{t("recordingReview.addClip")}</span>
						</button>
					) : null}
					<button
						type="button"
						disabled={props.readOnly || props.busy || props.preparing}
						onClick={props.onRecord}
						className={styles.ghost}
						aria-label={t("recordingReview.newRecording")}
						aria-busy={props.openingRecorder}
						title={`${t("recordingReview.newRecording")} (${modifier}N)`}
						aria-keyshortcuts={props.isMac ? "Meta+N" : "Control+N"}
					>
						{props.openingRecorder ? (
							<LoaderCircle size={16} className={styles.spinner} aria-hidden="true" />
						) : (
							<span className={styles.recordDot} aria-hidden="true" />
						)}
						<span className={styles.label}>{t("recordingReview.newRecording")}</span>
					</button>
					<AppMenu>
						<AppMenuTrigger asChild>
							<button
								type="button"
								className={styles.icon}
								aria-label={t("recordingReview.more")}
								title={t("recordingReview.more")}
								data-testid="review-more"
							>
								<MoreHorizontal size={16} aria-hidden="true" />
							</button>
						</AppMenuTrigger>
						<AppMenuContent align="end">
							<AppMenuItem
								disabled={props.preparing || props.busy}
								onSelect={props.onRecordings}
								aria-keyshortcuts={props.isMac ? "Meta+O" : "Control+O"}
							>
								<Clapperboard size={14} aria-hidden="true" />
								<span className={styles.menuLabel}>{t("recordingReview.recordings")}</span>
								<kbd className={styles.shortcut} aria-hidden="true">
									{modifier}O
								</kbd>
							</AppMenuItem>
							<AppMenuItem
								disabled={!props.canSave || props.busy || props.preparing}
								onSelect={props.onOriginals}
							>
								<FolderOpen size={14} aria-hidden="true" />
								<span className={styles.menuLabel}>{t("recordingReview.originals")}</span>
							</AppMenuItem>
							<AppMenuItem onSelect={props.onSettings}>
								<Settings size={14} aria-hidden="true" />
								<span className={styles.menuLabel}>{t("recordingReview.settings")}</span>
							</AppMenuItem>
						</AppMenuContent>
					</AppMenu>
					<button
						type="button"
						className={styles.primary}
						disabled={!props.canSave || props.readOnly || props.preparing}
						onClick={props.onSave}
						title={`${t("recordingReview.save")} (${modifier}S)`}
						aria-keyshortcuts={props.isMac ? "Meta+S" : "Control+S"}
					>
						<Download size={16} aria-hidden="true" />
						{props.handoffError
							? t("recordingReview.recoveryNeeded")
							: props.preparing && !props.openingRecorder && !props.addingClip
								? t("recordingReview.preparing")
								: props.busy
									? props.percent !== null && Number.isFinite(props.percent)
										? t("recordingReview.saving", { percent: Math.round(props.percent) })
										: t("exportDialog.saving")
									: t("recordingReview.save")}
					</button>
				</div>
			</header>
			{props.handoffError ? (
				<aside className={styles.interruption} role="alert">
					<div>
						<strong>{t("recordingReview.recoveryNeeded")}</strong>
						<p>{t("recordingReview.recoveryPending")}</p>
						<details>
							<summary>{t("recordingReview.interruptionDetails")}</summary>
							<p>{props.handoffError}</p>
						</details>
					</div>
					<button type="button" onClick={props.onRetryHandoff} disabled={props.busy}>
						{t("recordingReview.retryOpen")}
					</button>
				</aside>
			) : props.interruptions?.length ? (
				<aside className={styles.interruption} role="status">
					<div>
						<strong>{t("recordingReview.interrupted")}</strong>
						<p>{t("recordingReview.savedFootageRetained")}</p>
						<details>
							<summary>{t("recordingReview.interruptionDetails")}</summary>
							{props.interruptions.map((entry, index) => (
								<p key={`${entry.code}-${index}`}>{entry.message}</p>
							))}
						</details>
					</div>
					<button
						type="button"
						disabled={props.readOnly || props.busy || props.preparing}
						onClick={props.onRecord}
					>
						{t("recordingReview.recordAgain")}
					</button>
				</aside>
			) : null}
		</div>
	);
}
