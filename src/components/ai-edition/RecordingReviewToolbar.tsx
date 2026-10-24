import {
	Clapperboard,
	Download,
	FolderOpen,
	Keyboard,
	LoaderCircle,
	Maximize2,
	MoreHorizontal,
	Plus,
	TriangleAlert,
} from "lucide-react";
import { KlipptMark } from "@/components/brand/KlipptMark";
import { AppMenu, AppMenuContent, AppMenuItem, AppMenuTrigger } from "@/components/ui/app-menu";
import { useScopedT } from "@/contexts/I18nContext";
import { formatPlayerTime } from "@/lib/ai-edition/timeline/format";
import type { CleanCutStage, CleanCutState } from "@/lib/cleanCut/types";
import type { RecordingInterruption } from "@/lib/recordingSession";
import { RollingTime } from "./cleanCut/RollingTime";
import styles from "./RecordingReviewToolbar.module.css";

/** The Clean cut toggle beside Save and the status it shows under the title. */
export interface ReviewCleanCutControl {
	enabled: boolean;
	state: CleanCutState;
	progress: number | null;
	stage?: CleanCutStage | null;
	fromSec: number;
	toSec: number | null;
	onToggle: () => void;
}

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
	/** Trial days left out of the full trial, drawn as a ring beside the label. */
	trialDays?: { left: number; total: number } | null;
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
	cleanCut?: ReviewCleanCutControl;
}

function ProgressRing({ progress }: { progress: number | null }) {
	const known = progress !== null && Number.isFinite(progress);
	return (
		<svg
			className={known ? styles.ring : `${styles.ring} ${styles.ringSpin}`}
			viewBox="0 0 16 16"
			aria-hidden="true"
		>
			<circle cx="8" cy="8" r="6" pathLength={100} className={styles.ringTrack} />
			<circle
				cx="8"
				cy="8"
				r="6"
				pathLength={100}
				className={styles.ringValue}
				strokeDasharray={`${known ? Math.max(4, Math.round((progress ?? 0) * 100)) : 28} 100`}
			/>
		</svg>
	);
}

function CleanCutStatus({ cut }: { cut: ReviewCleanCutControl }) {
	const t = useScopedT("editor");
	if (cut.state === "working") {
		const known = cut.progress !== null && Number.isFinite(cut.progress);
		const percent = known ? Math.round((cut.progress ?? 0) * 100) : null;
		return (
			<span className={`${styles.meta} ${styles.metaWorking}`} role="status">
				<span>{cut.stage ? t(`cleanCut.stage.${cut.stage}`) : t("cleanCut.finding")}</span>
				<span className={styles.workBar} aria-hidden="true">
					<span style={{ transform: `scaleX(${known ? Math.max(0.04, cut.progress ?? 0) : 1})` }} />
				</span>
				{percent !== null ? <span>{percent}%</span> : null}
			</span>
		);
	}
	if (cut.state === "failed")
		return <span className={`${styles.meta} ${styles.metaFailed}`}>{t("cleanCut.failed")}</span>;
	if (cut.state !== "ready" || cut.toSec === null) return null;
	const kept = cut.fromSec > 0 ? Math.min(1, cut.toSec / cut.fromSec) : 1;
	return (
		<span className={`${styles.meta} ${styles.metaReady}`}>
			<span className={styles.srOnly}>{t("cleanCut.ready")}</span>
			<span>{formatPlayerTime(cut.fromSec)}</span>
			<span className={styles.keptBar} aria-hidden="true">
				<span style={{ transform: `scaleX(${kept})` }} />
			</span>
			<RollingTime sec={cut.toSec} className={styles.runtime} />
		</span>
	);
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
						{props.cleanCut?.enabled && props.cleanCut.state !== "off" ? (
							<CleanCutStatus cut={props.cleanCut} />
						) : props.meta ? (
							<span className={styles.meta}>{props.meta}</span>
						) : null}
					</div>
				</div>
				<div className={styles.actions}>
					{props.entitlementLabel ? (
						<button type="button" className={styles.account} onClick={props.onEntitlement}>
							{props.trialDays ? (
								<svg viewBox="0 0 16 16" className={styles.trialRing} aria-hidden="true">
									<circle cx="8" cy="8" r="6" pathLength={100} className={styles.trialTrack} />
									<circle
										cx="8"
										cy="8"
										r="6"
										pathLength={100}
										className={styles.trialValue}
										strokeDasharray={`${Math.max(0, Math.min(1, props.trialDays.left / props.trialDays.total)) * 100} 100`}
									/>
								</svg>
							) : null}
							{props.entitlementLabel}
						</button>
					) : null}
					<div className={styles.group}>
						{props.onExpand ? (
							<button
								type="button"
								className={styles.icon}
								onClick={props.onExpand}
								aria-label={t("recordingReview.expand")}
								title={t("recordingReview.expand")}
							>
								<Maximize2 size={14} aria-hidden="true" />
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
									<LoaderCircle size={15} className={styles.spinner} aria-hidden="true" />
								) : (
									<Plus size={15} aria-hidden="true" />
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
								<LoaderCircle size={15} className={styles.spinner} aria-hidden="true" />
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
									<MoreHorizontal size={15} aria-hidden="true" />
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
									<Keyboard size={14} aria-hidden="true" />
									<span className={styles.menuLabel}>{t("recordingReview.settings")}</span>
								</AppMenuItem>
							</AppMenuContent>
						</AppMenu>
					</div>
					{props.cleanCut && props.canSave ? (
						<button
							type="button"
							aria-pressed={props.cleanCut.enabled}
							aria-busy={props.cleanCut.enabled && props.cleanCut.state === "working"}
							disabled={props.readOnly}
							onClick={props.cleanCut.onToggle}
							// Return belongs to the review while Clean cut is on: a toggle left
							// focused by a click must not turn it off.
							onKeyDown={(event) => {
								if (event.key === "Enter" && props.cleanCut?.enabled) event.preventDefault();
							}}
							className={`${styles.ghost} ${styles.cleanCut}`}
							data-state={props.cleanCut.enabled ? props.cleanCut.state : "off"}
							aria-label={t("cleanCut.toggle")}
							title={t("cleanCut.toggleTitle")}
							data-testid="review-clean-cut"
						>
							{props.cleanCut.enabled && props.cleanCut.state === "working" ? (
								<ProgressRing progress={props.cleanCut.progress} />
							) : props.cleanCut.enabled && props.cleanCut.state === "failed" ? (
								<TriangleAlert size={15} aria-hidden="true" className={styles.failedIcon} />
							) : (
								<span className={styles.switch} aria-hidden="true" />
							)}
							<span className={styles.cleanCutLabel}>{t("cleanCut.toggle")}</span>
						</button>
					) : null}
					<button
						type="button"
						className={styles.primary}
						disabled={!props.canSave || props.readOnly || props.preparing}
						onClick={props.onSave}
						title={`${t("recordingReview.save")} (${modifier}S)`}
						aria-keyshortcuts={props.isMac ? "Meta+S" : "Control+S"}
					>
						<Download size={15} aria-hidden="true" />
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
