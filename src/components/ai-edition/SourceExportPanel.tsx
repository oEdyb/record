import { FolderOpen, Loader2 } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { useScopedT } from "@/contexts/I18nContext";
import type { AxcutDocument } from "@/lib/ai-edition/schema";
import { ipcErrorMessage } from "@/lib/ipcErrorMessage";
import { nativeBridgeClient } from "@/native/client";
import type { SourceHandoffResult } from "@/native/contracts";
import styles from "./ReviewSurface.module.css";

export function SourceExportPanel({
	document,
	busy,
	onBusy,
}: {
	document: AxcutDocument | null;
	busy: boolean;
	onBusy: (busy: boolean) => void;
}) {
	const t = useScopedT("editor");
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
			const next = await nativeBridgeClient.aiEdition.exportSources(structuredClone(document));
			if (currentDocument.current === document && !next.canceled) setResult(next);
		} catch (error) {
			if (currentDocument.current === document) setError(ipcErrorMessage(error));
		} finally {
			activeRequest.current = false;
			onBusy(false);
		}
	}
	return (
		<section style={{ display: "flex", flexDirection: "column", gap: 16, color: "var(--fg-2)" }}>
			<p style={{ margin: 0 }}>{t("exportDialog.sourcesIntro")}</p>
			<details style={{ fontSize: 12, color: "var(--muted)" }}>
				<summary style={{ cursor: "pointer", fontWeight: 600 }}>
					{t("exportDialog.sourcesIncludedTitle")}
				</summary>
				<p style={{ margin: "8px 0 0" }}>{t("exportDialog.sourcesIncluded")}</p>
			</details>
			{error && (
				<p role="alert" style={{ color: "var(--danger)", overflowWrap: "anywhere" }}>
					{error}
				</p>
			)}
			{result?.manifestPath && (
				<div role="status" style={{ overflowWrap: "anywhere" }}>
					<strong>{t("exportDialog.sourcesSaved")}</strong>
					<p>{result.directory}</p>
					{result.timelinePath && <p>{t("exportDialog.sourcesTimelineHint")}</p>}
					{!!result.warnings?.length && (
						<span className="sr-only">
							{t("exportDialog.sourcesWarnings", { count: result.warnings.length })}
						</span>
					)}
				</div>
			)}
			{!!result?.warnings?.length && (
				<details style={{ overflowWrap: "anywhere" }}>
					<summary style={{ cursor: "pointer", fontWeight: 600 }}>
						{t(
							result.warnings.length === 1
								? "exportDialog.sourcesWarning"
								: "exportDialog.sourcesWarnings",
							{ count: result.warnings.length },
						)}
					</summary>
					<ul style={{ maxHeight: 192, overflowY: "auto", paddingInlineStart: 24 }}>
						{result.warnings.map((warning) => (
							<li key={warning}>{warning}</li>
						))}
					</ul>
				</details>
			)}
			<div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
				{result?.manifestPath && (
					<button
						type="button"
						className={styles.btn}
						onClick={() => {
							void window.electronAPI
								.revealInFolder(result.timelinePath ?? result.manifestPath!)
								.catch((error) => setError(ipcErrorMessage(error)));
						}}
					>
						<FolderOpen size={14} aria-hidden="true" />
						{t("exportDialog.showInFolder")}
					</button>
				)}
				<button
					type="button"
					className={`${styles.btn} ${styles.btnPrimary}`}
					disabled={busy || !document?.timeline.clips.length}
					onClick={() => void start()}
				>
					{busy && <Loader2 size={14} aria-hidden="true" className="animate-spin" />}
					{busy
						? t("exportDialog.sourcesPreparing")
						: result
							? t("exportDialog.sourcesSaveAgain")
							: t("exportDialog.sourcesSave")}
				</button>
			</div>
			<div role="status" aria-live="polite">
				{busy ? t("exportDialog.sourcesCopying") : ""}
			</div>
		</section>
	);
}
