import { FolderOpen, Loader2 } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import type { AxcutDocument } from "@/lib/ai-edition/schema";
import { nativeBridgeClient } from "@/native/client";
import type { SourceHandoffResult } from "@/native/contracts";
import styles from "./NewEditorShell.module.css";

export function SourceExportPanel({
	document,
	busy,
	onBusy,
}: {
	document: AxcutDocument | null;
	busy: boolean;
	onBusy: (busy: boolean) => void;
}) {
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
			if (currentDocument.current === document)
				setError(error instanceof Error ? error.message : String(error));
		} finally {
			activeRequest.current = false;
			onBusy(false);
		}
	}
	return (
		<section style={{ display: "flex", flexDirection: "column", gap: 16, color: "var(--fg-2)" }}>
			<p style={{ margin: 0 }}>
				Each Pause/Continue clip gets its original screen, camera, microphone, and system audio
				files. A recording without pauses stays one clip. Files keep their complete original bytes.
			</p>
			<p style={{ margin: 0, fontSize: 12, color: "var(--muted)" }}>
				Includes complete source recordings and an importable timeline with cuts and camera sync.
				Screen, camera, microphone, and system audio stay on separate tracks. Visual effects, speed
				changes, and editable cursor overlays are not applied.
			</p>
			{error && (
				<p role="alert" style={{ color: "var(--danger)", overflowWrap: "anywhere" }}>
					{error}
				</p>
			)}
			{result?.manifestPath && (
				<div role="status" style={{ overflowWrap: "anywhere" }}>
					<strong>Sources exported</strong>
					<p>{result.directory}</p>
					{result.timelinePath && (
						<p>Import timeline.otio in your video editor to continue editing.</p>
					)}
					{result.warnings?.map((warning) => (
						<p key={warning}>{warning}</p>
					))}
				</div>
			)}
			<div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
				{result?.manifestPath && (
					<button
						type="button"
						className={styles.btn}
						onClick={() => {
							void window.electronAPI
								.revealInFolder(result.timelinePath ?? result.manifestPath!)
								.catch((error) => setError(String(error)));
						}}
					>
						<FolderOpen size={14} aria-hidden="true" />
						Show in folder
					</button>
				)}
				<button
					type="button"
					className={`${styles.btn} ${styles.btnPrimary}`}
					disabled={busy || !document?.timeline.clips.length}
					onClick={() => void start()}
				>
					{busy && <Loader2 size={14} aria-hidden="true" className="animate-spin" />}
					{busy ? "Preparing sources…" : result ? "Export again…" : "Export sources…"}
				</button>
			</div>
			<div role="status" aria-live="polite">
				{busy ? "Copying original files…" : ""}
			</div>
		</section>
	);
}
