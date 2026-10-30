import { Minimize2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useScopedT } from "@/contexts/I18nContext";
import {
	HudCompactPauseButton,
	HudCompactRecordButton,
	HudCompactTimer,
	HudRemovePreviousClipButton,
	HudStopButton,
} from "../launch/HudControls";
import { StudioReplay } from "./StudioReplay";
import { StudioTranscript } from "./StudioTranscript";
import styles from "./StudioWindow.module.css";
import { buildStudioSections, type StudioSentence } from "./studioTranscriptModel";

type StudioSnapshot = Awaited<ReturnType<Window["electronAPI"]["getStudioSnapshot"]>>;
type StudioCommand = Parameters<Window["electronAPI"]["studioCommand"]>[0];

const MB = 1024 * 1024;
/** A command that changes nothing within this long gets its buttons back. */
const COMMAND_TIMEOUT_MS = 5_000;

function useStudioSnapshot(): StudioSnapshot | null {
	const [snapshot, setSnapshot] = useState<StudioSnapshot | null>(null);
	useEffect(() => {
		const api = window.electronAPI;
		let cancelled = false;
		const stop = api.onStudioUpdated((next) => {
			if (!cancelled) setSnapshot(next);
		});
		void api.getStudioSnapshot().then((current) => {
			if (!cancelled) setSnapshot((existing) => existing ?? current);
		});
		return () => {
			cancelled = true;
			stop();
		};
	}, []);
	return snapshot;
}

/** Take time, as the pill counts it: committed clips plus the clip running now. */
function useElapsedSeconds(snapshot: StudioSnapshot | null): number {
	const [now, setNow] = useState(() => Date.now());
	const live = snapshot?.liveSinceMs ?? null;
	useEffect(() => {
		if (live === null) return;
		const timer = setInterval(() => setNow(Date.now()), 250);
		return () => clearInterval(timer);
	}, [live]);
	if (!snapshot) return 0;
	return Math.floor((snapshot.committedMs + (live === null ? 0 : Math.max(0, now - live))) / 1000);
}

/**
 * The full-size recording view, used instead of the pill: the take so far, its
 * transcript, and the pill's own recording controls. The pill keeps running the take;
 * every button here asks it.
 */
export function StudioWindow() {
	const t = useScopedT("launch");
	const editorT = useScopedT("editor");
	const snapshot = useStudioSnapshot();
	const elapsed = useElapsedSeconds(snapshot);
	const [playheadSec, setPlayheadSec] = useState(0);
	const [seekRequest, setSeekRequest] = useState<{ takeSec: number; nonce: number } | null>(null);
	const [pending, setPending] = useState(false);
	const phase = snapshot?.phase ?? "idle";
	const paused = phase === "paused";

	// The next snapshot is the answer to a command; until then the buttons wait, not forever.
	// biome-ignore lint/correctness/useExhaustiveDependencies: any new snapshot settles it
	useEffect(() => setPending(false), [snapshot]);
	useEffect(() => {
		if (!pending) return;
		const timer = setTimeout(() => setPending(false), COMMAND_TIMEOUT_MS);
		return () => clearTimeout(timer);
	}, [pending]);

	const [resumeAsked, setResumeAsked] = useState(false);
	// biome-ignore lint/correctness/useExhaustiveDependencies: any new snapshot settles it
	useEffect(() => setResumeAsked(false), [snapshot]);

	const send = useCallback((command: StudioCommand) => {
		if (command !== "pill") setPending(true);
		// Silence the replay now; main holds it too, but this click needs no round trip.
		if (command === "resume") setResumeAsked(true);
		window.electronAPI.studioCommand(command);
	}, []);

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || event.defaultPrevented) return;
			event.preventDefault();
			send("pill");
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [send]);

	const sections = useMemo(() => (snapshot ? buildStudioSections(snapshot) : []), [snapshot]);
	const seekTo = useCallback((sentence: StudioSentence) => {
		setSeekRequest({ takeSec: sentence.takeSec, nonce: Date.now() });
	}, []);

	const status = (() => {
		const transcript = snapshot?.transcript;
		if (!transcript) return { text: "", tone: "info" as const };
		// The transcriber keeps its last take until it runs again; that one's news is old.
		const ours = transcript.recordingId === snapshot?.recordingId;
		if (ours && transcript.error) return { text: transcript.error, tone: "error" as const };
		if (ours && transcript.status === "downloading-model" && transcript.download)
			return {
				text: t("transcript.downloading", {
					done: Math.round(transcript.download.downloadedBytes / MB),
					total: Math.round(transcript.download.totalBytes / MB),
				}),
				tone: "info" as const,
			};
		// Nothing runs on its own without the speech model: offer it, never download unasked.
		if (
			paused &&
			(!ours || transcript.status === "idle") &&
			sections.some((s) => s.state === "waiting")
		)
			return {
				text: t("studio.notTranscribed"),
				tone: "info" as const,
				action: {
					label: t("studio.transcribeNow"),
					run: () => void window.electronAPI.refreshTranscript(),
				},
			};
		return { text: "", tone: "info" as const };
	})();

	const clips = snapshot?.clips ?? [];
	const busy = pending || phase === "idle";
	return (
		<div className={styles.root} data-testid="studio-window">
			<header className={styles.header}>
				<span className={styles.title}>{t("studio.title")}</span>
				<span className={styles.phase} data-phase={phase}>
					{phase === "recording" ? t("studio.recording") : paused ? t("studio.paused") : ""}
				</span>
				<button
					type="button"
					className={`transcript-control ${styles.pillButton}`}
					onClick={() => send("pill")}
					title={t("studio.backToPill")}
				>
					<Minimize2 size={13} aria-hidden />
					{t("studio.backToPill")}
				</button>
			</header>
			<div className={styles.body}>
				<main className={styles.main}>
					{clips.length > 0 ? (
						<StudioReplay
							clips={clips}
							seekRequest={seekRequest}
							shown={snapshot?.shown ?? true}
							hold={Boolean(snapshot?.holdPlayback) || phase === "recording" || resumeAsked}
							onPosition={setPlayheadSec}
							labels={{
								clipOf: (current, total) => t("peek.clipOf", { current, total }),
								play: t("peek.play"),
								pause: t("peek.pause"),
								mute: t("peek.mute"),
								unmute: t("peek.unmute"),
								seek: t("peek.seek"),
								playbackError: t("peek.playbackError"),
							}}
						/>
					) : (
						<div className={styles.emptyStage}>{t("studio.noClips")}</div>
					)}
					<div className={styles.transport} role="toolbar" aria-label={t("studio.title")}>
						{phase === "idle" ? (
							// The pill starts the take and asks for a screen; the Studio stays open.
							<HudCompactRecordButton
								disabled={pending}
								label={editorT("recordingReview.record")}
								onClick={() => send("record")}
							/>
						) : (
							<>
								<HudCompactPauseButton
									testId="studio-pause-button"
									paused={paused}
									busy={pending}
									disabled={busy}
									label={paused ? t("tooltips.resumeRecording") : t("tooltips.pauseRecording")}
									onClick={() => send(paused ? "resume" : "pause")}
								/>
								<HudCompactTimer elapsedSeconds={elapsed} paused={phase !== "recording"} />
								<HudStopButton
									saving={false}
									disabled={busy}
									label={t("tooltips.stopRecording")}
									savingLabel={t("recording.saving")}
									onClick={() => send("stop")}
								/>
								<HudRemovePreviousClipButton
									disabled={busy || !paused || clips.length === 0}
									label={t("recording.removePreviousClip")}
									onClick={() => send("remove-last")}
								/>
							</>
						)}
					</div>
				</main>
				<StudioTranscript
					sections={sections}
					status={status}
					playheadSec={playheadSec}
					onSeek={seekTo}
					labels={{
						title: t("transcript.title"),
						clip: (n) => t("transcript.clip", { n }),
						copy: t("transcript.copy"),
						copied: t("transcript.copied"),
						recording: t("studio.clipRecording"),
						transcribing: t("studio.transcribing"),
						waiting: t("studio.waiting"),
						empty: t("studio.transcriptAfterPause"),
						latest: t("studio.latest"),
						seekTo: (time) => t("studio.seekTo", { time }),
					}}
				/>
			</div>
		</div>
	);
}
