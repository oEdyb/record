import { Check, Copy, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useScopedT } from "@/contexts/I18nContext";
import "./TranscriptWindow.css";

type TranscriptSnapshot = Awaited<ReturnType<Window["electronAPI"]["getTranscriptSnapshot"]>>;

const MB = 1024 * 1024;

/** Plain text for the clipboard: one paragraph per clip, in take order. */
export function transcriptClipboardText(snapshot: TranscriptSnapshot): string {
	return snapshot.clips
		.map((clip) => clip.text?.trim())
		.filter((text): text is string => Boolean(text))
		.join("\n\n");
}

function formatClock(ms: number): string {
	const total = Math.max(0, Math.round(ms / 1000));
	const minutes = Math.floor(total / 60);
	const seconds = total % 60;
	return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * Read-only transcript of the current take. It asks the main process for the
 * committed clips on open, shows text as each clip finishes, and copies the whole
 * thing as plain text so it can be pasted into a chat.
 */
export function TranscriptWindow() {
	const t = useScopedT("launch");
	const [snapshot, setSnapshot] = useState<TranscriptSnapshot | null>(null);
	const [copied, setCopied] = useState(false);
	const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		const api = window.electronAPI;
		let cancelled = false;
		const stop = api.onTranscriptUpdated((next) => {
			if (!cancelled) setSnapshot(next);
		});
		void api
			.getTranscriptSnapshot()
			.then((current) => {
				if (!cancelled) setSnapshot(current);
				return api.refreshTranscript();
			})
			.then((next) => {
				if (!cancelled) setSnapshot(next);
			})
			.catch((error) => console.warn("[transcript] refresh failed:", error));
		return () => {
			cancelled = true;
			stop();
			if (copiedTimer.current) clearTimeout(copiedTimer.current);
		};
	}, []);

	const refresh = useCallback(() => {
		void window.electronAPI
			.refreshTranscript()
			.then(setSnapshot)
			.catch((error) => console.warn("[transcript] refresh failed:", error));
	}, []);

	const copy = useCallback(() => {
		if (!snapshot) return;
		const text = transcriptClipboardText(snapshot);
		if (!text) return;
		void window.electronAPI.writeClipboardText(text).then(() => {
			setCopied(true);
			if (copiedTimer.current) clearTimeout(copiedTimer.current);
			copiedTimer.current = setTimeout(() => setCopied(false), 1_600);
		});
	}, [snapshot]);

	const busy = snapshot?.status === "transcribing" || snapshot?.status === "downloading-model";
	const hasText = Boolean(snapshot && transcriptClipboardText(snapshot));
	const status = (() => {
		if (!snapshot) return { text: t("transcript.loading"), tone: "info" };
		if (snapshot.error) return { text: snapshot.error, tone: "error" };
		if (snapshot.status === "downloading-model" && snapshot.download) {
			return {
				text: t("transcript.downloading", {
					done: Math.round(snapshot.download.downloadedBytes / MB),
					total: Math.round(snapshot.download.totalBytes / MB),
				}),
				tone: "info",
			};
		}
		if (snapshot.status === "transcribing" && snapshot.progress) {
			return {
				text: t("transcript.transcribing", {
					done: Math.min(snapshot.progress.total, snapshot.progress.done + 1),
					total: snapshot.progress.total,
				}),
				tone: "info",
			};
		}
		if (snapshot.status === "blocked") return { text: t("transcript.pauseFirst"), tone: "info" };
		if (snapshot.clips.length === 0) return { text: t("transcript.empty"), tone: "info" };
		return { text: "", tone: "info" };
	})();

	let clock = 0;
	return (
		<div
			className="transcript-card flex h-screen w-screen flex-col gap-2 overflow-hidden px-3 pb-3 pt-1.5"
			data-testid="transcript-card"
		>
			<div className="transcript-drag-handle flex h-8 shrink-0 items-center gap-2">
				<span className="min-w-0 flex-1 truncate text-[13px] font-medium">
					{t("transcript.title")}
				</span>
				<button
					type="button"
					className="transcript-control"
					onClick={refresh}
					disabled={busy}
					data-testid="transcript-refresh"
				>
					<RefreshCw size={13} aria-hidden className={busy ? "animate-spin" : undefined} />
					{t("transcript.refresh")}
				</button>
				<button
					type="button"
					className="transcript-control"
					onClick={copy}
					disabled={!hasText}
					data-testid="transcript-copy"
				>
					{copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
					{copied ? t("transcript.copied") : t("transcript.copy")}
				</button>
				<button
					type="button"
					className="transcript-control transcript-control-icon"
					aria-label={t("transcript.close")}
					title={t("transcript.close")}
					onClick={() => window.electronAPI.closeTranscriptWindow()}
				>
					<X size={13} aria-hidden />
				</button>
			</div>
			{status.text ? (
				<div className="transcript-status shrink-0" data-tone={status.tone} role="status">
					{status.text}
				</div>
			) : null}
			<div className="transcript-body min-h-0 flex-1 space-y-3" data-testid="transcript-body">
				{snapshot?.clips.map((clip) => {
					const start = clock;
					clock += clip.durationMs;
					return (
						<section key={clip.index} data-testid="transcript-clip">
							<div className="transcript-clip-label">
								{t("transcript.clip", { n: clip.index + 1 })} · {formatClock(start)}
							</div>
							<p className="transcript-clip-text">{clip.text ?? (clip.error ? clip.error : "…")}</p>
						</section>
					);
				})}
			</div>
		</div>
	);
}
