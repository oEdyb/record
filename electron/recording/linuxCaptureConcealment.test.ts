import { describe, expect, it, vi } from "vitest";
import { LinuxCaptureConcealment } from "./linuxCaptureConcealment";

function fakeWindow(visible = true) {
	const state = { visible, destroyed: false };
	return {
		state,
		isDestroyed: () => state.destroyed,
		isVisible: () => state.visible,
		hide: vi.fn(() => {
			state.visible = false;
		}),
		showInactive: vi.fn(() => {
			state.visible = true;
		}),
	};
}

describe("LinuxCaptureConcealment", () => {
	it("hides visible Notes and Transcript for the take and restores them without focus", () => {
		const concealment = new LinuxCaptureConcealment("linux");
		const notes = fakeWindow();
		const transcript = fakeWindow();
		concealment.track(notes);
		concealment.track(transcript);

		concealment.setConcealed(true);
		expect(notes.hide).toHaveBeenCalledTimes(1);
		expect(transcript.hide).toHaveBeenCalledTimes(1);
		expect(concealment.isConcealed).toBe(true);

		concealment.setConcealed(false);
		expect(notes.showInactive).toHaveBeenCalledTimes(1);
		expect(transcript.showInactive).toHaveBeenCalledTimes(1);
		expect(notes.state.visible).toBe(true);
	});

	it("does not reveal a window the user had already closed or hidden", () => {
		const concealment = new LinuxCaptureConcealment("linux");
		const alreadyHidden = fakeWindow(false);
		concealment.track(alreadyHidden);
		concealment.setConcealed(true);
		concealment.setConcealed(false);
		expect(alreadyHidden.hide).not.toHaveBeenCalled();
		expect(alreadyHidden.showInactive).not.toHaveBeenCalled();
	});

	it("repeats on every Pause/Continue cycle", () => {
		const concealment = new LinuxCaptureConcealment("linux");
		const notes = fakeWindow();
		concealment.track(notes);
		for (let clip = 1; clip <= 3; clip++) {
			concealment.setConcealed(true);
			concealment.setConcealed(false);
			expect(notes.hide).toHaveBeenCalledTimes(clip);
			expect(notes.showInactive).toHaveBeenCalledTimes(clip);
		}
	});

	it("ignores repeated conceal and restore notifications", () => {
		const concealment = new LinuxCaptureConcealment("linux");
		const notes = fakeWindow();
		concealment.track(notes);
		concealment.setConcealed(true);
		concealment.setConcealed(true);
		expect(notes.hide).toHaveBeenCalledTimes(1);
		concealment.setConcealed(false);
		concealment.setConcealed(false);
		expect(notes.showInactive).toHaveBeenCalledTimes(1);
	});

	it("defers a window that becomes ready during the take until restore", () => {
		const concealment = new LinuxCaptureConcealment("linux");
		const late = fakeWindow(false);
		concealment.track(late);
		expect(concealment.mayShow(late)).toBe(true);
		concealment.setConcealed(true);
		expect(concealment.mayShow(late)).toBe(false);
		expect(late.showInactive).not.toHaveBeenCalled();
		concealment.setConcealed(false);
		expect(late.showInactive).toHaveBeenCalledTimes(1);
	});

	it("skips destroyed windows and forgets closed ones", () => {
		const concealment = new LinuxCaptureConcealment("linux");
		const destroyed = fakeWindow();
		const closed = fakeWindow();
		concealment.track(destroyed);
		const forget = concealment.track(closed);
		concealment.setConcealed(true);
		destroyed.state.destroyed = true;
		forget();
		concealment.setConcealed(false);
		expect(destroyed.showInactive).not.toHaveBeenCalled();
		expect(closed.showInactive).not.toHaveBeenCalled();
	});

	it.each([
		"darwin",
		"win32",
	])("does nothing on %s, where content protection applies", (platform) => {
		const concealment = new LinuxCaptureConcealment(platform);
		const notes = fakeWindow();
		concealment.track(notes);
		concealment.setConcealed(true);
		expect(notes.hide).not.toHaveBeenCalled();
		expect(concealment.mayShow(notes)).toBe(true);
		expect(concealment.isConcealed).toBe(false);
		concealment.setConcealed(false);
		expect(notes.showInactive).not.toHaveBeenCalled();
	});
});
