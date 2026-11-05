import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { InspectorSwitch } from "@/components/ui/inspector";
import { useScopedT } from "@/contexts/I18nContext";
import { applyTheme } from "@/hooks/useTheme";
import {
	loadUserPreferences,
	normalizeStudioLayout,
	type StudioLayout,
	saveUserPreferences,
} from "@/lib/userPreferences";
import type { StudioCommand } from "../../../electron/studio/types";
import { StudioCamera } from "./StudioCamera";
import { StudioDialog } from "./StudioDialog";
import { StudioDock, type StudioSeekRequest } from "./StudioDock";
import { StudioHeader } from "./StudioHeader";
import { StudioKeymap } from "./StudioKeymap";
import { StudioNotes } from "./StudioNotes";
import { StudioRail } from "./StudioRail";
import { StudioSeparator } from "./StudioSeparator";
import { StudioDevices, StudioSetup, setupLocked } from "./StudioSetup";
import { StudioTranscript } from "./StudioTranscript";
import { StudioTransport } from "./StudioTransport";
import styles from "./StudioWindow.module.css";
import { dockFraction } from "./studioLayout";
import { preserveStudioReader } from "./studioReaderAnchor";
import { buildStudioSections } from "./studioTranscriptModel";
import { useStudioKeyboard } from "./useStudioKeyboard";
import { useElapsedSeconds, useStudioSnapshot } from "./useStudioSnapshot";
import { useStudioTranscriptStatus } from "./useStudioTranscriptStatus";

const COMMAND_TIMEOUT_MS = 5_000;
const BODY_PADDING_PX = 12;
const SEPARATOR_PX = 12;
/** The notes or transcript never get narrower than this; the dock gives way first. */
const MIN_DOCUMENT_PX = 300;
export function StudioWindow() {
	const t = useScopedT("launch");
	const snapshot = useStudioSnapshot();
	const elapsed = useElapsedSeconds(snapshot);
	const [layout, setLayout] = useState(() => loadUserPreferences().studioLayout);
	const update = useCallback(
		(patch: Partial<StudioLayout>) =>
			setLayout((current) => {
				preserveStudioReader();
				const next = normalizeStudioLayout({ ...current, ...patch });
				saveUserPreferences({ studioLayout: next });
				return next;
			}),
		[],
	);
	const [pending, setPending] = useState(false);
	const [resumeAsked, setResumeAsked] = useState(false);
	const [playheadSec, setPlayheadSec] = useState(0);
	const [seekRequest, setSeekRequest] = useState<StudioSeekRequest | null>(null);
	const nonce = useRef(0);
	const [playbackRequest, setPlaybackRequest] = useState(0);
	const [followRequest, setFollowRequest] = useState(0);
	const [fontDelta, setFontDelta] = useState(0);
	const [speed, setSpeed] = useState(1);
	const [meters, setMeters] = useState(false);
	const [help, setHelp] = useState(false);
	const [notes, setNotes] = useState(false);
	const [pausedFraction, setPausedFraction] = useState(0.5);
	const [width, setWidth] = useState(window.innerWidth);
	const [platform, setPlatform] = useState("");
	useEffect(() => {
		// The Studio is the big pill, so it is always dark like the HUD.
		applyTheme("dark");
		setPlatform(window.electronAPI.getPlatform());
	}, []);
	useEffect(() => {
		const resize = () => setWidth(window.innerWidth);
		window.addEventListener("resize", resize);
		return () => window.removeEventListener("resize", resize);
	}, []);
	// biome-ignore lint/correctness/useExhaustiveDependencies: a snapshot acknowledges the command
	useEffect(() => {
		setPending(false);
		setResumeAsked(false);
	}, [snapshot]);
	useEffect(() => {
		if (!pending) return;
		const timer = setTimeout(() => setPending(false), COMMAND_TIMEOUT_MS);
		return () => clearTimeout(timer);
	}, [pending]);
	useEffect(
		() =>
			window.electronAPI.onStudioRecordResult?.((result) => {
				if (!result.success) {
					setPending(false);
					setResumeAsked(false);
					toast.error(result.error);
				}
			}),
		[],
	);
	const send = useCallback((command: StudioCommand) => {
		if (command !== "pill" && command !== "open-notes") setPending(true);
		if (command === "resume" || command === "record") {
			setResumeAsked(true);
			setSeekRequest(null);
		}
		void Promise.resolve(window.electronAPI.studioCommand(command))
			.then((result) => {
				if (result && !result.success) {
					setPending(false);
					setResumeAsked(false);
					toast.error(result.error);
				}
			})
			.catch(() => {
				setPending(false);
				setResumeAsked(false);
				toast.error("Recording controls did not respond. Reopen Klippt and try again.");
			});
	}, []);
	const seek = (takeSec: number, play = false) =>
		setSeekRequest({
			takeSec: Math.min((snapshot?.committedMs ?? 0) / 1000, Math.max(0, takeSec)),
			nonce: ++nonce.current,
			play,
		});
	const sections = useMemo(() => (snapshot ? buildStudioSections(snapshot) : []), [snapshot]);
	const phase = snapshot?.phase ?? "idle";
	const paused = phase === "paused";
	const live = phase === "recording";
	useStudioKeyboard({
		snapshot,
		layout,
		update,
		send,
		position: playheadSec,
		sentences: sections.flatMap((s) => s.sentences.map((s) => s.takeSec)),
		clips: sections.map((s) => s.startSec),
		seek,
		play: () => setPlaybackRequest((n) => n + 1),
		follow: () => setFollowRequest((n) => n + 1),
		resizeText: (d) => setFontDelta((n) => Math.max(-5, Math.min(8, n + d))),
		changeSpeed: (d) => setSpeed((n) => Math.max(0.5, Math.min(2, n + d))),
		toggleMeters: () => setMeters((v) => !v),
		help: () => setHelp(true),
		blocked: pending || help,
	});
	const status = useStudioTranscriptStatus(snapshot, sections);

	const fraction = dockFraction(paused ? pausedFraction : layout.dockFrac, width - 12);
	// The body's own content width: the window less its 12px padding each side and the separator.
	const paneWidth = Math.max(0, width - 2 * BODY_PADDING_PX - SEPARATOR_PX);
	const dockPx = Math.max(0, Math.min(fraction * paneWidth, paneWidth - MIN_DOCUMENT_PX));
	const phaseLabel = t(
		live
			? "studio.recording"
			: paused
				? "studio.paused"
				: phase === "review"
					? "studio.review"
					: "studio.newTake",
	);
	const completed = sections.filter((s) => s.state === "text").length;
	const cameraOn = Boolean(snapshot?.setup.cameraEnabled);
	// Without a camera, a new take has nothing for the dock to show: the notes take the room.
	const dockShown = !live && (phase !== "idle" || cameraOn);
	const liveMode = cameraOn ? layout.liveMode : layout.liveMode === "nothing" ? "nothing" : "notes";
	const resizeText = (d: number) => {
		preserveStudioReader();
		setFontDelta((n) => Math.max(-5, Math.min(8, n + d)));
	};
	return (
		<div
			className={styles.root}
			data-testid="studio-window"
			data-phase={phase}
			data-platform={platform}
			style={{ "--studio-font-delta": `${fontDelta}px` } as CSSProperties}
		>
			<StudioHeader
				mac={platform === "darwin"}
				phaseLabel={phaseLabel}
				help={() => setHelp(true)}
				side={() => update({ dock: layout.dock === "left" ? "right" : "left" })}
				pill={() => send("pill")}
			/>
			{snapshot ? (
				<StudioSetup
					snapshot={snapshot}
					send={send}
					pending={pending}
					meters={meters}
					devicesInline={phase === "idle" && dockShown}
				/>
			) : null}
			<main
				className={styles.body}
				data-studio-document
				tabIndex={0}
				data-live={live}
				data-dock={dockShown ? layout.dock : "right"}
				style={{
					gridTemplateColumns: !dockShown
						? "minmax(0,1fr)"
						: layout.dock === "right"
							? `minmax(0,1fr) ${SEPARATOR_PX}px ${dockPx}px`
							: `${dockPx}px ${SEPARATOR_PX}px minmax(0,1fr)`,
				}}
			>
				<div className={styles.document} id="studio-document" hidden={live}>
					<StudioRail
						sections={sections}
						total={(snapshot?.committedMs ?? 0) / 1000}
						position={playheadSec}
						seek={seek}
					/>
					<div className={styles.documentBar}>
						{/* Before the first clip there is no transcript: the notes stand alone. */}
						<nav className={styles.documentTabs} hidden={phase === "idle"}>
							<button
								type="button"
								aria-pressed={!notes && phase !== "idle"}
								onClick={() => setNotes(false)}
							>
								{t("transcript.title")}
							</button>
							<button
								type="button"
								aria-pressed={notes || phase === "idle"}
								onClick={() => setNotes(true)}
							>
								{t("setup.notes")}
							</button>
						</nav>
						<div className={styles.textSize}>
							<button type="button" aria-label={t("studio.smaller")} onClick={() => resizeText(-1)}>
								A−
							</button>
							<button type="button" aria-label={t("studio.larger")} onClick={() => resizeText(1)}>
								A+
							</button>
						</div>
					</div>
					<div className={styles.documentContent} hidden={phase === "idle" || notes}>
						<StudioTranscript
							sections={sections}
							status={status}
							playheadSec={playheadSec}
							followRequest={followRequest}
							onSeek={(sentence) => seek(sentence.takeSec, true)}
							labels={{
								title: t("transcript.title"),
								clip: (n) => t("transcript.clip", { n }),
								copy: t("transcript.copy"),
								copied: t("transcript.copied"),
								recording: t("studio.clipRecording"),
								transcribing: t("studio.transcribing"),
								waiting: t("studio.waiting"),
								silent: t("studio.silent"),
								empty: t("studio.transcriptAfterPause"),
								latest: t("studio.now"),
								seekTo: (time) => t("studio.seekTo", { time }),
							}}
						/>
					</div>
					{phase === "idle" || notes ? <StudioNotes /> : null}
				</div>
				{dockShown ? (
					<>
						<StudioSeparator
							vertical
							controls="studio-document studio-dock"
							reverse={layout.dock === "right"}
							value={fraction}
							onChange={(dockFrac) =>
								paused
									? setPausedFraction(dockFraction(dockFrac, width - 12))
									: update({ dockFrac: dockFraction(dockFrac, width - 12) })
							}
						/>
						{snapshot ? (
							<StudioDock
								snapshot={snapshot}
								layout={layout}
								update={update}
								seekRequest={seekRequest}
								hold={snapshot.holdPlayback || resumeAsked}
								onPosition={setPlayheadSec}
								playbackRequest={playbackRequest}
								speed={speed}
								devices={
									<StudioDevices
										snapshot={snapshot}
										send={send}
										locked={setupLocked(snapshot, pending)}
									/>
								}
							/>
						) : null}
					</>
				) : null}
				{live ? (
					<div className={styles.calm} data-mode={liveMode}>
						{liveMode === "notes" || liveMode === "both" ? <StudioNotes /> : null}
						{liveMode === "mirror" || liveMode === "both" ? (
							<div className={styles.cameraSlot}>
								<StudioCamera active={Boolean(snapshot?.shown && cameraOn)} guides={false} />
							</div>
						) : null}
						{liveMode === "nothing" ? (
							<div className={styles.liveTimer} aria-hidden="true">
								{Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}
							</div>
						) : null}
						<div className={styles.liveModes} role="group" aria-label={t("studio.liveMode")}>
							{(cameraOn
								? (["both", "notes", "mirror", "nothing"] as const)
								: (["notes", "nothing"] as const)
							).map((mode) => (
								<button
									type="button"
									key={mode}
									aria-pressed={liveMode === mode}
									onClick={() => update({ liveMode: mode })}
								>
									{t(`studio.${mode === "both" ? "notesAndCamera" : mode}`)}
								</button>
							))}
						</div>
					</div>
				) : null}
			</main>
			{snapshot ? (
				<StudioTransport snapshot={snapshot} elapsed={elapsed} pending={pending} send={send} />
			) : null}
			<div role="status" aria-live="polite" className={styles.srOnly}>
				{phaseLabel}
				{snapshot?.pill.undoClipIndex !== null && snapshot?.pill.undoClipIndex !== undefined
					? ` · ${t("studio.removed")}`
					: ""}
				{completed ? ` · ${t("studio.transcriptsReady", { count: completed })}` : ""}
			</div>
			{help ? (
				<StudioDialog title={t("studio.shortcuts")} onClose={() => setHelp(false)}>
					<div className={styles.fields}>
						<div className={styles.fieldRow}>
							<span>{t("studio.enableShortcuts")}</span>
							<InspectorSwitch
								label={t("studio.enableShortcuts")}
								checked={layout.shortcuts}
								onCheckedChange={(checked) => update({ shortcuts: checked })}
							/>
						</div>
					</div>
					<StudioKeymap keymap={t("studio.keymap")} />
				</StudioDialog>
			) : null}
		</div>
	);
}
