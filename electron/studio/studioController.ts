import type { RecordingSessionClip } from "../../src/lib/recordingSession";
import type { TranscriptSnapshot } from "../transcript/liveTranscript";
import { RecordRequest } from "./recordRequest";
import {
	IDLE_PILL_STATE,
	type StudioCommand,
	type StudioPillState,
	type StudioSetup,
	type StudioSnapshot,
} from "./types";
import { WindowFade } from "./windowFade";

/** The parts of a BrowserWindow the controller drives. */
export interface StudioWindowLike {
	isDestroyed(): boolean;
	isVisible(): boolean;
	getOpacity?(): number;
	setOpacity?(opacity: number): void;
	show(): void;
	showInactive(): void;
	hide(): void;
	focus(): void;
	getBounds(): { x: number; y: number; width: number; height: number };
	once(event: "ready-to-show", listener: () => void): void;
	on(event: "close", listener: (event: { preventDefault(): void }) => void): void;
	webContents: { send(channel: string, payload: unknown): void };
}

export interface StudioTake {
	recordingId: number | null;
	clips: RecordingSessionClip[];
	running: boolean;
	paused: boolean;
}

export interface StudioControllerDeps {
	take: () => StudioTake | null;
	transcript: () => TranscriptSnapshot;
	/** The recording setup as main stores it; the pill applies every change to it. */
	setup: () => StudioSetup;
	getPill: () => StudioWindowLike | null;
	/** Brings back a pill that was closed (the review replaced it), so the take has an owner. */
	ensurePill?: () => void;
	createWindow: (near: { x: number; y: number } | undefined) => StudioWindowLike;
	/** Sends one of the pill's existing commands, so its own predicates decide. */
	sendToPill: (channel: string, payload?: unknown) => void;
	/**
	 * Hands a stopped take to the normal review, where it is saved and exported. `from` is
	 * the Studio's frame, so the review opens in its place instead of jumping elsewhere.
	 */
	openReview: (
		from: { x: number; y: number; width: number; height: number } | undefined,
		ready: () => void,
	) => void;
	motionEnabled?: () => boolean;
	cancelReview?: () => void;
	/** True only when the compositor confirms the Studio is off the recorded output. */
	outsideCapture: (pipeWireNodeId: number | undefined) => Promise<boolean>;
	endCaptureCheck: () => void;
	/**
	 * Moves the Studio off the screen about to be recorded, to another screen. Resolves to
	 * the screen it left, or null when it did not move.
	 */
	moveOffCapture?: (pipeWireNodeId: number | undefined) => Promise<string | null>;
	/** Puts the Studio back on the screen it left for capture. */
	returnTo?: (output: string) => Promise<void>;
	/** How long a hidden window takes to leave the screen before capture resumes. */
	waitForUnmap: () => Promise<void>;
	now?: () => number;
	quitting?: () => boolean;
}

/**
 * Owns the Studio window and the choice between it and the pill. The pill stays the
 * recording's owner: it keeps the camera and runs every command; the Studio only shows
 * the take and asks. While capture runs the Studio stays up only on a screen that is
 * not being recorded.
 */
export class StudioController {
	private window: StudioWindowLike | null = null;
	private ready = false;
	private mode: "pill" | "studio" | "review" = "pill";
	private pillNoticeShown = false;
	private outside = false;
	/** Between asking capture to resume and it running: replay must already be silent. */
	private resuming = false;
	/** The screen the Studio left so it would not be recorded; it goes back on pause. */
	private movedFrom: string | null = null;
	/** Whether a take was running at the last look; its end hands over to the review. */
	private wasRunning = false;
	private liveSinceMs: number | null = null;
	/** A stopped take the Studio keeps for read-back until Finish hands it to the review. */
	private review: { recordingId: number; clips: RecordingSessionClip[] } | null = null;
	private pill: StudioPillState = IDLE_PILL_STATE;
	/** Finish was asked for while the pill was still saving; it runs once the save ends. */
	private finishWhenSaved = false;

	private handoff = 0;
	private finishTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly fade: WindowFade;
	private readonly recordRequest: RecordRequest;
	constructor(private readonly deps: StudioControllerDeps) {
		this.fade = new WindowFade(() => Boolean(deps.motionEnabled?.()));
		this.recordRequest = new RecordRequest({
			owner: () => this.deps.getPill()?.webContents ?? null,
			ensure: () => this.deps.ensurePill?.(),
			send: (token) => {
				this.review = null;
				this.deps.sendToPill("hud-start-recording", token);
			},
			take: this.deps.take,
		});
	}

	requestRecord() {
		return this.recordRequest.start();
	}
	recordReady(sender: object, ready: boolean) {
		this.recordRequest.ready(sender, ready);
	}
	recordProgress(
		sender: object,
		token: number,
		stage: string,
		flags: Record<string, boolean | number | null>,
	) {
		this.recordRequest.progress(sender, token, stage, flags);
	}

	snapshot(): StudioSnapshot {
		const take = this.deps.take();
		const capturing = Boolean(take?.running && !take.paused);
		const review = take?.running ? null : this.review;
		const clips = review?.clips ?? take?.clips ?? [];
		return {
			phase: review ? "review" : !take?.running ? "idle" : take.paused ? "paused" : "recording",
			recordingId: review?.recordingId ?? take?.recordingId ?? null,
			clips,
			committedMs: clips.reduce((sum, clip) => sum + Math.max(0, clip.durationMs), 0),
			liveSinceMs: capturing ? this.liveSinceMs : null,
			hiddenForCapture: capturing && !this.outside,
			holdPlayback: capturing || this.resuming,
			shown: this.visible(),
			transcript: this.deps.transcript(),
			setup: this.deps.setup(),
			pill: this.pill,
		};
	}

	ownsControls(): boolean {
		return this.mode !== "pill";
	}

	/** Pill -> Studio. */
	open() {
		this.handoff++;
		clearTimeout(this.finishTimer);
		this.deps.cancelReview?.();
		this.mode = "studio";
		if (!this.deps.getPill()) {
			if (process.platform === "linux")
				this.pill = { ...IDLE_PILL_STATE, controlsLocked: true, transportBusy: true };
			this.deps.ensurePill?.();
		}
		this.wasRunning = Boolean(this.deps.take()?.running);
		const pill = this.deps.getPill();
		const bounds = pill && !pill.isDestroyed() ? pill.getBounds() : undefined;
		if (!this.window || this.window.isDestroyed()) {
			this.ready = false;
			const window = this.deps.createWindow(bounds ? { x: bounds.x, y: bounds.y } : undefined);
			this.window = window;
			// Closing the Studio returns to the pill; it never stops or discards the take.
			window.on("close", (event) => {
				if (this.deps.quitting?.()) return;
				event.preventDefault();
				this.backToPill();
			});
			window.once("ready-to-show", () => {
				this.ready = true;
				this.apply();
			});
			return;
		}
		this.apply();
	}

	/** Studio -> pill. While recording the pill stays tucked away until the next pause, as before. */
	backToPill() {
		this.mode = "pill";
		this.handoff++;
		clearTimeout(this.finishTimer);
		if (this.capturing()) return this.hideStudio();
		if (this.window) {
			const window = this.window;
			window.webContents.send("studio-motion", { expanded: false });
			this.fade.to(window, 0, 120, () => {
				if (this.mode === "pill") this.hideStudio();
			});
		}
		const pill = this.deps.getPill();
		if (pill && !pill.isDestroyed()) {
			this.fade.cancel(pill);
			this.fade.setOpacity(pill, 1);
			this.pillNoticeShown = false;
			pill.show();
			pill.focus();
		}
	}

	/** The pill opened a panel the user must answer (permissions): show it, keep the take. */
	pillNeedsUser() {
		if (this.mode === "studio") this.backToPill();
	}

	/** A pill warning has to be seen, and the pill is where it shows: keep the Studio, lift the pill. */
	pillNotice(active: boolean) {
		if (this.mode === "pill") return;
		const pill = this.deps.getPill();
		if (!pill || pill.isDestroyed()) return;
		if (active) {
			this.fade.cancel(pill);
			this.fade.setOpacity(pill, 1);
			pill.showInactive();
			this.pillNoticeShown = true;
		} else if (this.pillNoticeShown) {
			this.pillNoticeShown = false;
			pill.hide();
		}
	}

	command(command: StudioCommand) {
		const take = this.deps.take();
		if (typeof command === "object" || isSetupCommand(command)) {
			this.deps.sendToPill("studio-setup-command", command);
			return;
		}
		// Leaving a stopped take, by Finish or by going back to the pill, hands it to the review.
		if (command === "finish" || (command === "pill" && this.reviewing())) return this.finish();
		if (command === "pill") return this.backToPill();
		if (command === "record") {
			void this.requestRecord();
			return;
		}
		if (command === "record-more") return;
		if (!take?.running) return;
		if (command === "pause" && !take.paused) this.deps.sendToPill("hud-toggle-recording-pause");
		if (command === "resume" && take.paused) this.deps.sendToPill("hud-toggle-recording-pause");
		if (command === "stop") this.deps.sendToPill("stop-recording-from-tray");
		if (command === "remove-last") this.deps.sendToPill("hud-remove-previous-clip");
	}

	/** The take was saved. Shown in the Studio, it stays there for read-back. */
	stored(take: { recordingId: number; clips: RecordingSessionClip[] }) {
		// A take saved from the pill replaces any older read-back the Studio still held.
		if (this.mode !== "studio") {
			this.review = null;
			this.finishWhenSaved = false;
			return this.publish();
		}
		this.review = { recordingId: take.recordingId, clips: take.clips.filter((c) => !c.removed) };
		this.publish();
	}

	/** The stored take was rewritten (its camera clips attached): the read-back follows it. */
	sessionUpdated(take: { recordingId: number; clips: RecordingSessionClip[] }) {
		if (!this.review || this.review.recordingId !== take.recordingId) return;
		this.review = { recordingId: take.recordingId, clips: take.clips.filter((c) => !c.removed) };
		this.publish();
	}

	/**
	 * The pill asks for the normal review after Stop. True when the Studio keeps the take
	 * instead; Finish opens the review later.
	 */
	keepsReview(): boolean {
		return this.mode === "studio" && this.review !== null;
	}

	/** The pill reports its own locks and Undo, which the Studio mirrors. */
	setPillState(state: StudioPillState) {
		this.pill = state;
		if (this.finishWhenSaved && !state.saving) {
			this.finishWhenSaved = false;
			return this.finish();
		}
		this.publish();
	}

	/** Capture is about to resume: keep the Studio only off the recorded screen. */
	async beforeCapture(capture: { pipeWireNodeId: number | undefined; windowSource: boolean }) {
		this.outside = capture.windowSource;
		// Replay sound must not reach the microphone, even from a hidden Studio.
		this.resuming = true;
		this.publish();
		if (!this.window || this.window.isDestroyed()) return;
		if (this.mode === "studio" && this.visible()) {
			if (!capture.windowSource) {
				this.outside = await this.deps.outsideCapture(capture.pipeWireNodeId);
				// On the recorded screen: stay expanded on another screen rather than shrink.
				const from = this.outside ? null : await this.deps.moveOffCapture?.(capture.pipeWireNodeId);
				if (from) {
					this.movedFrom = from;
					await this.deps.waitForUnmap();
					this.outside = await this.deps.outsideCapture(capture.pipeWireNodeId);
				}
			}
			if (!this.outside) this.hideStudio();
		}
		// One wait covers both: the window leaving the screen and the replay pausing.
		await this.deps.waitForUnmap();
	}

	/** The compositor saw the Studio move onto the recorded screen. */
	revoke() {
		this.outside = false;
		// Capture may start any moment once resume began, before the take reports it.
		if (this.capturing() || this.resuming) this.hideStudio();
		this.publish();
	}

	/** The take changed: a clip started, finished, was removed, or the take ended. */
	sync() {
		const take = this.deps.take();
		this.resuming = false;
		if (this.capturing()) this.liveSinceMs ??= (this.deps.now ?? Date.now)();
		else {
			this.liveSinceMs = null;
			this.outside = false;
			this.deps.endCaptureCheck();
			if (this.movedFrom) {
				void this.deps.returnTo?.(this.movedFrom);
				this.movedFrom = null;
			}
		}
		// The take is over: the review takes it from here. Opened idle, it waits for one.
		const running = Boolean(take?.running);
		const ended = this.wasRunning && !running;
		this.wasRunning = running;
		if (ended && this.mode === "studio" && !this.review) {
			this.mode = "pill";
			this.hideStudio();
		}
		this.apply();
	}

	publish() {
		if (this.window && !this.window.isDestroyed())
			this.window.webContents.send("studio-updated", this.snapshot());
	}

	private reviewing(): boolean {
		return this.review !== null && !this.deps.take()?.running;
	}

	private finish() {
		if (!this.reviewing()) return;
		// Opening the review while the pill still attaches camera clips would cut that save short.
		if (this.pill.saving) {
			this.finishWhenSaved = true;
			return;
		}
		const handoff = ++this.handoff;
		const from = this.visible() ? this.window?.getBounds() : undefined;
		let completed = false;
		const ready = () => {
			if (completed || handoff !== this.handoff) return;
			completed = true;
			clearTimeout(this.finishTimer);
			this.review = null;
			this.mode = "review";
			if (this.window)
				this.fade.to(this.window, 0, 180, () => {
					if (handoff === this.handoff) this.hideStudio();
				});
		};
		this.finishTimer = setTimeout(ready, 1500);
		this.deps.openReview(from, ready);
	}

	private motionOrigin() {
		const pill = this.deps.getPill();
		if (!pill || pill.isDestroyed() || !this.window) return "center bottom";
		const anchor = pill.getBounds();
		const frame = this.window.getBounds();
		const x = Math.max(
			0,
			Math.min(100, ((anchor.x + anchor.width / 2 - frame.x) / frame.width) * 100),
		);
		const y = Math.max(
			0,
			Math.min(100, ((anchor.y + anchor.height / 2 - frame.y) / frame.height) * 100),
		);
		return `${x}% ${y}%`;
	}

	private capturing(): boolean {
		const take = this.deps.take();
		return Boolean(take?.running && !take.paused);
	}

	private visible(): boolean {
		return Boolean(this.window && !this.window.isDestroyed() && this.window.isVisible());
	}

	private hideStudio() {
		if (!this.window || this.window.isDestroyed() || !this.window.isVisible()) return;
		this.fade.cancel(this.window);
		this.window.hide();
		this.fade.setOpacity(this.window, 1);
		// The page never learns it was hidden (it runs unthrottled), so say it.
		this.publish();
	}

	private apply() {
		this.publish();
		if (this.mode !== "studio" || !this.ready || !this.window || this.window.isDestroyed()) return;
		if (this.capturing() && !this.outside) return this.hideStudio();
		if (!this.window.isVisible()) {
			this.window.webContents.send("studio-motion", {
				expanded: false,
				origin: this.motionOrigin(),
			});
			if (
				process.platform !== "linux" &&
				this.deps.motionEnabled?.() &&
				this.window.getOpacity?.() === 1
			)
				this.fade.setOpacity(this.window, 0);
			this.window.show();
			this.window.focus();
			this.publish();
		}
		this.window.webContents.send("studio-motion", { expanded: true });
		this.fade.to(this.window, 1, 180);
		// The pill leaves while the Studio arrives, not after it, so the two never sit together.
		const pill = this.deps.getPill();
		if (pill && !pill.isDestroyed() && pill.isVisible())
			this.fade.to(pill, 0, 90, () => {
				if (pill.isDestroyed()) return;
				if (this.mode === "studio") pill.hide();
				this.fade.setOpacity(pill, 1);
			});
		this.publish();
	}
}

const SETUP_COMMANDS = new Set<StudioCommand>([
	"undo-remove",
	"toggle-mic",
	"toggle-camera",
	"toggle-system-audio",
	"choose-source",
	"open-notes",
	"cancel-countdown",
]);

function isSetupCommand(command: StudioCommand): boolean {
	return SETUP_COMMANDS.has(command);
}
