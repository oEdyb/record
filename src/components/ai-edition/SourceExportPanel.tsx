import {
	AlertCircle,
	Check,
	ChevronRight,
	Download,
	FolderOpen,
	ListVideo,
	Loader2,
	Mic,
	Monitor,
	Scissors,
	Video,
	Volume2,
} from "lucide-react";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { useScopedT } from "@/contexts/I18nContext";
import type { AxcutDocument } from "@/lib/ai-edition/schema";
import type { CleanCutExport } from "@/lib/cleanCut/types";
import { ipcErrorMessage } from "@/lib/ipcErrorMessage";
import { nativeBridgeClient } from "@/native/client";
import type { SourceHandoffResult } from "@/native/contracts";
import styles from "./ExportDialog.module.css";
import buttons from "./ReviewSurface.module.css";

export function SourceExportPanel({
	document,
	busy,
	onBusy,
	cleanCut = null,
	cleanCutStatus = null,
}: {
	document: AxcutDocument | null;
	busy: boolean;
	onBusy: (busy: boolean) => void;
	cleanCut?: CleanCutExport | null;
	cleanCutStatus?: "working" | "failed" | null;
}) {
	const t = useScopedT("editor");
	const tc = useScopedT("common");
	const tl = useScopedT("launch");
	const [result, setResult] = useState<SourceHandoffResult | null>(null);
	const [error, setError] = useState<string | null>(null);
	const activeRequest = useRef(false);
	const currentDocument = useRef(document);
	useLayoutEffect(() => {
		currentDocument.current = document;
		setResult(null);
		setError(null);
		return () => {
			if (currentDocument.current === document) currentDocument.current = null;
		};
	}, [document]);
	async function start() {
		if (!document || busy || activeRequest.current) return;
		activeRequest.current = true;
		onBusy(true);
		setError(null);
		setResult(null);
		try {
			const next = await nativeBridgeClient.aiEdition.exportSources(
				structuredClone(document),
				cleanCut ? structuredClone(cleanCut) : undefined,
			);
			if (currentDocument.current === document && !next.canceled) setResult(next);
		} catch (error) {
			if (currentDocument.current === document) setError(ipcErrorMessage(error));
		} finally {
			activeRequest.current = false;
			onBusy(false);
		}
	}
	const assets = document?.assets ?? [];
	const count = (has: (asset: (typeof assets)[number]) => boolean) => assets.filter(has).length;
	const files: Array<{ kind: string; icon: ReactNode; label: string; count: number }> = [
		{
			kind: "screen",
			icon: <Monitor size={18} aria-hidden="true" />,
			label: tc("recordingSource.screen"),
			count: assets.length,
		},
		{
			kind: "camera",
			icon: <Video size={18} aria-hidden="true" />,
			label: tl("webcam.camera"),
			count: count((asset) => Boolean(asset.cameraTrack)),
		},
		{
			kind: "mic",
			icon: <Mic size={18} aria-hidden="true" />,
			label: tl("audio.microphone"),
			count: count((asset) => Boolean(asset.microphoneAudioPath)),
		},
		{
			kind: "system",
			icon: <Volume2 size={18} aria-hidden="true" />,
			label: tl("audio.systemAudio"),
			count: count((asset) => Boolean(asset.systemAudioPath)),
		},
	].filter((file) => file.count > 0);
	const saved = Boolean(result?.manifestPath);
	return (
		<section className={styles.sheet}>
			<p className={styles.lead}>{t("exportDialog.sourcesIntro")}</p>
			<div className={styles.files}>
				{files.map((file) => (
					<div key={file.kind} className={styles.file} data-kind={file.kind}>
						{file.icon}
						{file.count > 1 ? <span className={styles.fileCount}>×{file.count}</span> : null}
						<span className={styles.fileName}>{file.label}</span>
					</div>
				))}
				<div className={styles.file} data-kind="timeline">
					<ListVideo size={18} aria-hidden="true" />
					<span className={styles.fileName}>timeline.otio</span>
				</div>
				{cleanCut ? (
					<div className={styles.file} data-kind="clean">
						<Scissors size={18} aria-hidden="true" />
						<span className={styles.fileName}>{t("cleanCut.toggle")}</span>
					</div>
				) : null}
			</div>
			{cleanCut ? (
				<p className={styles.note}>{t("cleanCut.saveIncludes")}</p>
			) : cleanCutStatus ? (
				<p className={styles.note} data-tone="quiet">
					{t(cleanCutStatus === "failed" ? "cleanCut.saveFailed" : "cleanCut.saveWithout")}
				</p>
			) : null}
			{!saved && !busy && (
				<details className={styles.disclosure}>
					<summary>
						<ChevronRight size={14} aria-hidden="true" />
						{t("exportDialog.sourcesIncludedTitle")}
					</summary>
					<p>{t("exportDialog.sourcesIncluded")}</p>
				</details>
			)}
			{busy && (
				<div className={styles.progress}>
					<div className={styles.track} data-indeterminate>
						<span />
					</div>
				</div>
			)}
			{error && (
				<div role="alert" className={styles.result}>
					<AlertCircle size={18} className={styles.errorIcon} aria-hidden="true" />
					<p className={styles.errorText}>{error}</p>
				</div>
			)}
			{result?.manifestPath && (
				<div role="status" className={styles.result}>
					<span className={styles.check} aria-hidden="true">
						<Check size={15} strokeWidth={2.6} />
					</span>
					<div className={styles.resultBody}>
						<strong className={styles.resultTitle}>{t("exportDialog.sourcesSaved")}</strong>
						<p className={styles.path}>{result.directory}</p>
						{result.timelinePath && (
							<p className={styles.resultHint}>{t("exportDialog.sourcesTimelineHint")}</p>
						)}
						{result.cleanCutPath && <p className={styles.resultHint}>{t("cleanCut.saved")}</p>}
						{!!result.warnings?.length && (
							<span className="sr-only">
								{t("exportDialog.sourcesWarnings", { count: result.warnings.length })}
							</span>
						)}
					</div>
				</div>
			)}
			{!!result?.warnings?.length && (
				<details className={styles.disclosure}>
					<summary>
						<ChevronRight size={14} aria-hidden="true" />
						<span className={styles.warnDot} aria-hidden="true" />
						{t(
							result.warnings.length === 1
								? "exportDialog.sourcesWarning"
								: "exportDialog.sourcesWarnings",
							{ count: result.warnings.length },
						)}
					</summary>
					<ul>
						{result.warnings.map((warning) => (
							<li key={warning}>{warning}</li>
						))}
					</ul>
				</details>
			)}
			<div className={styles.footer}>
				{saved && result?.manifestPath ? (
					<>
						<button
							type="button"
							className={`${buttons.btn} ${buttons.btnSecondary}`}
							disabled={busy || !document?.timeline.clips.length}
							onClick={() => void start()}
						>
							{t("exportDialog.sourcesSaveAgain")}
						</button>
						<button
							type="button"
							className={`${buttons.btn} ${buttons.btnPrimary}`}
							onClick={() => {
								void window.electronAPI
									.revealInFolder(result.timelinePath ?? result.manifestPath!)
									.catch((error) => setError(ipcErrorMessage(error)));
							}}
						>
							<FolderOpen size={15} aria-hidden="true" />
							{t("exportDialog.showInFolder")}
						</button>
					</>
				) : (
					<button
						type="button"
						className={`${buttons.btn} ${buttons.btnPrimary}`}
						disabled={busy || !document?.timeline.clips.length}
						onClick={() => void start()}
					>
						{busy ? (
							<Loader2 size={15} aria-hidden="true" className="animate-spin" />
						) : (
							<Download size={15} aria-hidden="true" />
						)}
						{busy ? t("exportDialog.sourcesPreparing") : t("exportDialog.sourcesSave")}
					</button>
				)}
			</div>
			<div role="status" aria-live="polite" className="sr-only">
				{busy ? t("exportDialog.sourcesCopying") : ""}
			</div>
		</section>
	);
}
