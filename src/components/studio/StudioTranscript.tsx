import { Check, Copy } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { formatTimePadded } from "@/utils/timeUtils";
import "../launch/TranscriptWindow.css";
import styles from "./StudioWindow.module.css";
import type { StudioSection, StudioSentence } from "./studioTranscriptModel";
import { studioTranscriptText } from "./studioTranscriptModel";

export interface StudioTranscriptLabels {
	title: string;
	clip: (n: number) => string;
	copy: string;
	copied: string;
	recording: string;
	transcribing: string;
	waiting: string;
	silent: string;
	empty: string;
	latest: string;
	seekTo: (time: string) => string;
}

/** Reading near the bottom means following along; anything above is the creator's own place. */

/**
 * The take's transcript, one section per kept clip. A sentence click seeks the replay.
 * New text follows only when the reader was already at the bottom; otherwise a Latest
 * clip button offers the jump.
 */
export function StudioTranscript({
	sections,
	status,
	playheadSec,
	labels,
	onSeek,
	followRequest = 0,
}: {
	sections: StudioSection[];
	/** One line about the transcriber: downloading, an error, or blocked. Empty when quiet. */
	status: { text: string; tone: "info" | "error"; action?: { label: string; run: () => void } };
	playheadSec: number;
	labels: StudioTranscriptLabels;
	onSeek: (sentence: StudioSentence) => void;
	followRequest?: number;
}) {
	const bodyRef = useRef<HTMLDivElement | null>(null);
	const followRef = useRef(true);
	const focusedSentence = useRef<HTMLButtonElement | null>(null);
	const [offscreenNew, setOffscreenNew] = useState(false);
	const [copied, setCopied] = useState(false);
	const text = studioTranscriptText(sections);
	const contentKey = sections
		.map((s) => `${s.clipIndex}:${s.state}:${s.sentences.length}`)
		.join("|");

	useLayoutEffect(() => {
		const body = bodyRef.current;
		if (!body || !contentKey) return;
		if (focusedSentence.current && !focusedSentence.current.isConnected) {
			body.querySelector<HTMLButtonElement>("[data-time]")?.focus();
			focusedSentence.current = null;
		}
		if (followRef.current) body.scrollTop = body.scrollHeight;
		else setOffscreenNew(true);
	}, [contentKey]);

	useEffect(() => {
		if (!copied) return;
		const timer = setTimeout(() => setCopied(false), 1_600);
		return () => clearTimeout(timer);
	}, [copied]);

	const jumpToLatest = () => {
		const body = bodyRef.current;
		if (body)
			body.scrollTo({
				top: body.scrollHeight,
				behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
					? "instant"
					: "smooth",
			});
		followRef.current = true;
		setOffscreenNew(false);
	};

	// biome-ignore lint/correctness/useExhaustiveDependencies: follow the current sentence as playback advances
	useEffect(() => {
		const body = bodyRef.current;
		if (!body || !followRef.current) return;
		body.querySelector('[aria-current="true"]')?.scrollIntoView?.({ block: "nearest" });
	}, [playheadSec]);
	useEffect(() => {
		if (!followRequest) return;
		followRef.current = true;
		setOffscreenNew(false);
		bodyRef.current?.querySelector('[aria-current="true"]')?.scrollIntoView?.({ block: "center" });
	}, [followRequest]);
	return (
		<aside className={styles.transcript} aria-label={labels.title}>
			<div className={styles.transcriptHeader}>
				<span className={styles.transcriptTitle}>{labels.title}</span>
				<button
					type="button"
					className="transcript-control"
					disabled={!text}
					onClick={() => {
						void window.electronAPI.writeClipboardText(text).then(() => setCopied(true));
					}}
				>
					{copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
					{copied ? labels.copied : labels.copy}
				</button>
			</div>
			{status.text ? (
				<div className="transcript-status" data-tone={status.tone}>
					{status.text}
					{status.action ? (
						<button type="button" className={styles.statusAction} onClick={status.action.run}>
							{status.action.label}
						</button>
					) : null}
				</div>
			) : null}
			<div
				data-studio-document
				tabIndex={0}
				ref={bodyRef}
				className={`transcript-body ${styles.transcriptBody}`}
				data-studio-reader
				onWheel={() => {
					followRef.current = false;
					setOffscreenNew(true);
				}}
				onTouchMove={() => {
					followRef.current = false;
					setOffscreenNew(true);
				}}
			>
				{sections.length === 0 ? <p className={styles.placeholder}>{labels.empty}</p> : null}
				{sections.map((section) => {
					const playing =
						section.state === "text" &&
						section.sentences.some((s) => playheadSec >= s.takeSec && playheadSec < s.endTakeSec);
					return (
						<section key={section.clipIndex} className={styles.section}>
							<div className="transcript-clip-label">
								{labels.clip(section.clipIndex + 1)} ·{" "}
								{formatTimePadded(Math.floor(section.startSec))}
								{section.state === "recording" ? (
									<span className={styles.recordingDot} aria-hidden />
								) : null}
							</div>
							{section.state === "text" ? (
								<p className="transcript-clip-text" data-playing={playing}>
									{section.sentences.map((sentence, i) => {
										const active =
											playheadSec >= sentence.takeSec && playheadSec < sentence.endTakeSec;
										return (
											<span key={`${sentence.takeSec}-${i}`}>
												<button
													type="button"
													className={styles.sentence}
													onFocus={(event) => {
														focusedSentence.current = event.currentTarget;
													}}
													data-active={active}
													aria-current={active ? "true" : undefined}
													data-time={formatTimePadded(Math.floor(sentence.takeSec))}
													title={labels.seekTo(formatTimePadded(Math.floor(sentence.takeSec)))}
													onClick={() => {
														// Selecting text is reading, not seeking.
														if (window.getSelection()?.toString()) return;
														onSeek(sentence);
													}}
												>
													{sentence.text}
												</button>{" "}
											</span>
										);
									})}
								</p>
							) : (
								<p
									className={styles.placeholder}
									data-tone={section.state === "error" ? "error" : "info"}
								>
									{section.state === "error"
										? section.error
										: section.state === "recording"
											? labels.recording
											: section.state === "transcribing"
												? labels.transcribing
												: section.state === "silent"
													? labels.silent
													: labels.waiting}
								</p>
							)}
						</section>
					);
				})}
			</div>
			{
				<button
					type="button"
					hidden={!offscreenNew}
					className={`transcript-control ${styles.latest}`}
					onClick={jumpToLatest}
				>
					{labels.latest}
				</button>
			}
		</aside>
	);
}
