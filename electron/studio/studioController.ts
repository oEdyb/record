import type { RecordingSessionClip } from "../../src/lib/recordingSession";
import type { TranscriptSnapshot } from "../transcript/liveTranscript";
import type { StudioCommand, StudioSnapshot } from "./types";

/** The parts of a BrowserWindow the controller drives. */
export interface StudioWindowLike {
	isDestroyed(): boolean;
	isVisible(): boolean;
	show(): void;
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
	getPill: () => StudioWindowLike | null;
	createWindow: (near: { x: number; y: number } | undefined) => StudioWindowLike;
	/** Sends one of the pill's existing commands, so its own predicates decide. */
	sendToPill: (channel: string) => void;
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
	private mode: "pill" | "studio" = "pill";
	private outside = false;
	/** Between asking capture to resume and it running: replay must already be silent. */
	private resuming = false;
	/** The screen the Studio left so it would not be recorded; it goes back on pause. */
	private movedFrom: string | null = null;
	/** Whether a take was running at the last look; its end hands over to the review. */
	private wasRunning = false;
	private liveSinceMs: number | null = null;

	constructor(private readonly deps: StudioControllerDeps) {}

	snapshot(): StudioSnapshot {
		const take = this.deps.take();
		const capturing = Boolean(take?.running && !take.paused);
		const clips = take?.clips ?? [];
		return {
			phase: !take?.running ? "idle" : take.paused ? "paused" : "recording",
			recordingId: take?.recordingId ?? null,
			clips,
			committedMs: clips.reduce((sum, clip) => sum + Math.max(0, clip.durationMs), 0),
			liveSinceMs: capturing ? this.liveSinceMs : null,
			hiddenForCapture: capturing && !this.outside,
			holdPlayback: capturing || this.resuming,
			shown: this.visible(),
			transcript: this.deps.transcript(),
		};
	}

	/** Pill -> Studio. */
	open() {
		this.mode = "studio";
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
		this.hideStudio();
		if (this.capturing()) return;
		const pill = this.deps.getPill();
		if (pill && !pill.isDestroyed()) {
			pill.show();
			pill.focus();
		}
	}

	command(command: StudioCommand) {
		const take = this.deps.take();
		if (command === "pill") return this.backToPill();
		if (command === "record") {
			if (!take?.running) this.deps.sendToPill("hud-start-recording");
			return;
		}
		if (!take?.running) return;
		if (command === "pause" && !take.paused) this.deps.sendToPill("hud-toggle-recording-pause");
		if (command === "resume" && take.paused) this.deps.sendToPill("hud-toggle-recording-pause");
		if (command === "stop") this.deps.sendToPill("stop-recording-from-tray");
		if (command === "remove-last") this.deps.sendToPill("hud-remove-previous-clip");
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
		if (ended && this.mode === "studio") {
			this.mode = "pill";
			this.hideStudio();
		}
		this.apply();
	}

	publish() {
		if (this.window && !this.window.isDestroyed())
			this.window.webContents.send("studio-updated", this.snapshot());
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
		this.window.hide();
		// The page never learns it was hidden (it runs unthrottled), so say it.
		this.publish();
	}

	private apply() {
		this.publish();
		if (this.mode !== "studio" || !this.ready || !this.window || this.window.isDestroyed()) return;
		if (this.capturing() && !this.outside) return this.hideStudio();
		if (!this.window.isVisible()) {
			this.window.show();
			this.window.focus();
			this.publish();
		}
		const pill = this.deps.getPill();
		if (pill && !pill.isDestroyed() && pill.isVisible()) pill.hide();
	}
}
